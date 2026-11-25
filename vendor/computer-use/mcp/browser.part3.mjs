  // After an action, return what changed on the page; a navigation or a
  // mostly-new page returns the whole outline instead.
  changes(tab, outline) {
    const previous = tab.last;
    this.remember(tab, outline);
    if (!previous || previous.url !== tab.url) return { mode: 'full', text: `${this.header(tab)}\n${render(outline.lines)}` };
    const added = [], changed = [], removed = [];
    const seen = new Set();
    const allLines=outline.allLines??outline.lines;
    for (const line of allLines) {
      seen.add(line.key);
      const before = previous.lines.get(line.key);
      if (!before) added.push(line); else if (before.text !== line.text) changed.push(line);
    }
    for (const [key, line] of previous.lines) if (!seen.has(key)) removed.push(line);
    const count = added.length + changed.length + removed.length;
    if (count === 0) return { mode: 'unchanged', text: `tab ${tab.key}: the page outline did not change` };
    if (count > Math.max(40, allLines.length * 0.6)) return { mode: 'full', text: `${this.header(tab)}\n${render(outline.lines)}` };
    const text = [`tab ${tab.key} · "${clip(tab.title || '', 120)}" · ${added.length} added, ${changed.length} changed, ${removed.length} removed`,
      ...added.map(line => `+ ${render([{ ...line, depth: 0 }])}`), ...changed.map(line => `~ ${render([{ ...line, depth: 0 }])}`),
      ...removed.map(line => `- ${line.id ? `[${line.id}] ` : ''}${line.text}`)].join('\n');
    const budget=outline.maxLines??500,lines=text.split('\n');
    return { mode: 'diff', text:lines.slice(0,budget+1).join('\n')+(lines.length>budget+1?'\n[changes truncated; read the page or use find for details]':'') };
  }

  // After an action: wait for a load the action started (since = the load
  // number before it), for requests it set off (up to 3 s), then for the DOM to
  // stay quiet. A load waits for its document (up to 15 s) and then up to 3 s
  // for the load event, so a page whose last resources never arrive still answers.
  async settle(tab, request, since = tab.loadSeq) {
    if (tab.navigatingTo) return;
    await sleep(40);
    const stop = () => request?.cancelled || tab.closed || tab.dialog;
    const until = async (done, ms) => {
      for (const deadline = Date.now() + ms; !done() && Date.now() < deadline && !stop();) {
        let waiter;
        const loaded = new Promise(resolve => { waiter = resolve; tab.loadWaiters.push(resolve); });
        try { await Promise.race([loaded, sleep(250)]); }
        finally {
          const idx = tab.loadWaiters.indexOf(waiter);
          if (idx >= 0) tab.loadWaiters.splice(idx, 1);
        }
      }
    };
    const load = async () => {
      if (tab.loadSeq === since) return;
      await until(() => !tab.loading || tab.domReady, 15000);
      await until(() => !tab.loading, 3000);
    };
    await load();
    for (const deadline = Date.now() + 3000; tab.requests.size && Date.now() < deadline && !stop();) await sleep(50);
    // A request can turn into a navigation (a form post, a script that changes location).
    await load();
    if (stop()) return;
    try { await this.untilDialog(tab, this.send(tab, 'Runtime.evaluate', { expression: QUIET_SCRIPT, awaitPromise: true, returnByValue: true }, 4000)); } catch { }
  }

  async resolveElement(tab, backendNodeId) {
    let objectId;
    try { objectId = (await this.send(tab, 'DOM.resolveNode', { backendNodeId })).object.objectId; } catch { }
    // A removed element can still be resolved; it is stale all the same.
    if (!objectId || await this.call(tab, objectId, 'function () { return this.isConnected; }').catch(() => false) !== true)
      fail('BROWSER_ELEMENT_STALE', `element ${this.idFor(tab, backendNodeId)} is no longer in the page; read the page again for current ids`);
    return objectId;
  }

  // Agent tabs share one invisible headless window in which only the front tab
  // paints: a screenshot of another tab never returns (measured on Bing behind
  // a popup) and animation-frame work stalls. Focus emulation makes every tab
  // report itself visible, so the tab is brought to the front before each
  // action and capture (about 13 ms). A user's tab is never moved.
  async reveal(tab) {
    if (tab.browser.source !== 'agent' || !tab.browser.headless) return;
    await tab.browser.cdp.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => { });
  }

  async call(tab, objectId, functionDeclaration, args = []) {
    const { result, exceptionDetails } = await this.send(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true });
    if (exceptionDetails) fail('BROWSER_SCRIPT_FAILED', exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async describeNode(tab, backendNodeId) {
    let line = 'element', named = false;
    try {
      const { nodes } = await this.send(tab, 'Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
      await this.redactNodes(tab,nodes);
      const node = nodes.find(item => !item.ignored) ?? nodes[0];
      if (node) { const name = squash(node.name?.value); line = nodeLine(node, name); named = Boolean(name); }
    } catch { }
    // An unnamed wrapper (an overlay, a banner) is known by its text.
    if (!named) try {
      const objectId = (await this.send(tab, 'DOM.resolveNode', { backendNodeId })).object.objectId;
      const text = squash(await this.call(tab, objectId, 'function () { return String(this.innerText ?? this.textContent ?? "").slice(0, 200); }'));
      if (text) line += ` "${clip(text, 60)}"`;
    } catch { }
    return line;
  }

  // Scroll the element into view, take the center of its first visible box and
  // make sure the element, or what it is part of, is what receives a click there.
  async pointFor(tab, backendNodeId, resolvedObjectId) {
    const targetObj = resolvedObjectId ?? await this.resolveElement(tab, backendNodeId);
    try { await this.send(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }); } catch { }
    let quads;
    try { ({ quads } = await this.send(tab, 'DOM.getContentQuads', { backendNodeId })); }
    catch { fail('BROWSER_ELEMENT_STALE', `element ${this.idFor(tab, backendNodeId)} has no layout box; read the page again`); }
    const quad = quads.find(item => quadArea(item) > 1);
    if (!quad) fail('BROWSER_ELEMENT_NOT_VISIBLE', `element ${this.idFor(tab, backendNodeId)} is not visible on the page`);
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    let covering = null;
    // The hit test is best effort: a failure here leaves the click to the page.
    // Like a real click it passes through pointer-events:none layers (a page's
    // decoration, DSH's own pointer layer); ignorePointerEventsNone would hit them.
    try {
      const hit = await this.frames.hit(tab, backendNodeId, x, y);
      if (!sameFrameNode(hit.backendNodeId, backendNodeId)) {
        const sameFrame = hit.backendNodeId?.frameId === backendNodeId?.frameId
          && hit.backendNodeId?.document === backendNodeId?.document
          && hit.backendNodeId?.sessionId === backendNodeId?.sessionId;
        if (!sameFrame) {
          covering = hit.backendNodeId;
        } else {
          const other = (await this.send(tab, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId })).object.objectId;
          const { result } = await this.send(tab, 'Runtime.callFunctionOn', { objectId: targetObj, functionDeclaration: ON_TARGET, arguments: [{ objectId: other }], returnByValue: true });
          if (result.value === false) covering = hit.backendNodeId;
        }
      }
    } catch(error) { if(backendNodeId?.frameId)throw new Error('BROWSER_HIT_TEST_FAILED: '+error.message); }
    // The covering element's id is offered for the next call.
    if (covering) fail('BROWSER_ELEMENT_COVERED', `element ${this.idFor(tab, backendNodeId)} is covered by ${await this.describeNode(tab, covering)} [${this.idFor(tab, covering)}]; close or scroll past it first`);
    return this.frames.rootPoint(tab,backendNodeId,{x,y});
  }

  // alert/confirm/prompt and beforeunload hold the call that raised them until
  // the dialog closes; stop waiting as soon as one opens (null).
  async untilDialog(tab, pending) {
    pending.catch(() => { });
    if(tab.dialog)return null;
    let wake;
    const opened = new Promise(resolve => { wake = resolve; tab.dialogWaiters.push(resolve); });
    try { return await Promise.race([pending, opened.then(() => null)]); }
    finally { tab.dialogWaiters = tab.dialogWaiters.filter(resolve => resolve !== wake); }
  }

  // Queue behind the action running in this tab; resolves to the release. A
  // call cancelled while it waits leaves the queue at once and never runs.
  async lock(tab, request) {
    const previous = tab.queue;
    let release;
    tab.queue = new Promise(resolve => { release = resolve; });
    while (!await Promise.race([previous.then(() => true), sleep(100).then(() => false)])) {
      if (request?.cancelled) { previous.then(release); fail('COMPUTER_USE_CANCELLED', `cancelled while waiting for the action before it in tab ${tab.key}`); }
    }
    if (request?.cancelled) { release(); fail('COMPUTER_USE_CANCELLED', `cancelled while waiting for the action before it in tab ${tab.key}`); }
    return release;
  }

  // null when the element is not an option of a drop-down; otherwise it is
  // chosen, and a list the select had opened closes as it does after a choice.
  async chooseOption(tab, node, resolvedObjectId) {
    const objectId = resolvedObjectId ?? await this.resolveElement(tab, node);
    const picked = await this.untilDialog(tab, this.call(tab, objectId, OPTION_PICK));
    // A change handler raised a dialog; the action reports it.
    if (tab.dialog) return {};
    if (!picked) return null;
    if (picked.disabled !== undefined) fail('BROWSER_OPTION_DISABLED', `option '${clip(picked.disabled, 60)}' is disabled; it cannot be chosen`);
    try {
      const select = (await this.send(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { return (this.nodeType === 1 ? this : this.parentElement).closest("select"); }', returnByValue: false })).result;
      const { nodes } = await this.send(tab, 'Accessibility.getPartialAXTree', { objectId: select.objectId, fetchRelatives: false });
      if (property(nodes.find(item => !item.ignored) ?? {}, 'expanded') === true) await this.key(tab, ['escape']);
    } catch { }
    return { chose: picked.chose };
  }

  async refuseDisabled(tab, node, target, resolvedObjectId) {
    const disabled = await this.call(tab, resolvedObjectId ?? await this.resolveElement(tab, node), DISABLED).catch(() => false);
    if (disabled) fail('BROWSER_ELEMENT_DISABLED', `${target} is disabled; it does not respond to clicks`);
  }

  // Input stops at an open dialog: nothing further in that sequence is sent.
  async input(tab, method, params) {
    if (tab.dialog) return false;
    return await this.untilDialog(tab, this.send(tab, method, params).then(() => true)) !== null;
  }

  async mouse(tab, x, y, button = 'left', clickCount = 1) {
    const buttons = { left: 1, right: 2, middle: 4 }[button];
    if (!await this.input(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })) return;
    for (let count = 1; count <= clickCount; count++) {
      if (!await this.input(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: count })) return;
      if (!await this.input(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: count })) return;
    }
  }

  async key(tab, keys) {
    for (const raw of keys) {
      if (/[\x00-\x1f\x7f\uE000-\uF8FF]/.test(String(raw))) fail('INVALID_ARGUMENTS', 'Control and private-use characters are not allowed in key names.');
    }
    const modifiers = [], names = keys.map(key => String(key).toLowerCase());
    let main = null;
    for (const name of names) { if (MODIFIERS[name]) modifiers.push(MODIFIERS[name]); else main = name; }
    const chord = [...new Set(modifiers.map(item => item[1] === 'Control' ? 'ctrl' : item[1].toLowerCase()))].sort((a, b) => ['ctrl', 'alt', 'shift'].indexOf(a) - ['ctrl', 'alt', 'shift'].indexOf(b)).concat(main ?? '').join('+');
    if (tab.dialog) {
      if (main === 'enter' || main === 'escape' || main === 'esc') {
        const dialog = tab.dialog, accept = main === 'enter';
        // Accepting a prompt answers with the text given by type_text, else its default, as Enter would.
        const promptText = dialog.type === 'prompt' && accept ? dialog.text ?? dialog.defaultPrompt : undefined;
        await this.send(tab, 'Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) });
        tab.dialog = null;
        if (dialog.type === 'beforeunload' && !accept) tab.loading = false;
        return { handledDialog: accept ? 'accepted' : 'dismissed', ...(promptText !== undefined ? { promptText } : {}) };
      }
      fail('BROWSER_DIALOG_OPEN', 'a JavaScript dialog is open on this page; press Enter to accept or Escape to dismiss it');
    }
    if (chord === 'alt+left' || chord === 'alt+right') {
      const { currentIndex, entries } = await this.send(tab, 'Page.getNavigationHistory');
      const entry = entries[currentIndex + (chord === 'alt+left' ? -1 : 1)];
      if (!entry) fail('BROWSER_NO_HISTORY', `there is no page to go ${chord === 'alt+left' ? 'back' : 'forward'} to`);
      await this.send(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id });
      return { navigated: chord === 'alt+left' ? 'back' : 'forward' };
    }
    if (chord === 'f5' || chord === 'ctrl+r') { await this.send(tab, 'Page.reload'); return { navigated: 'reload' }; }
    if ((modifiers.some(item=>item[1]==='Control')&&['c','v','x','insert'].includes(main)) || (modifiers.some(item=>item[1]==='Shift')&&['insert','delete'].includes(main))) fail('BROWSER_CLIPBOARD_SHORTCUT', 'Page input must not read or replace the system clipboard; use type_text or set_value.');
    if (BROWSER_SHORTCUTS.has(chord)) fail('BROWSER_UI_SHORTCUT', `${chord} is a browser-window shortcut that page input cannot reach; navigate with set_value ${tab.key}:address, open tabs with set_value new-tab, close with close_window browserTab`);
    const named = KEYS[main];
    const mask = modifiers.reduce((sum, item) => sum | item[0], 0);
    let key, code, vk, text;
    if (named) [key, code, vk, text] = named;
    else if ([...main].length === 1) {
      // Shift gives the US-layout character; an upper-case letter given alone stays upper case.
      const shift = Boolean(mask & 8), given = keys.map(String).find(item => !MODIFIERS[item.toLowerCase()]);
      if (/^[a-z]$/.test(main)) { key = shift || given !== main ? main.toUpperCase() : main; code = `Key${main.toUpperCase()}`; vk = main.toUpperCase().charCodeAt(0); }
      else if (PRINTABLE[main]) { [code, vk] = PRINTABLE[main]; key = shift ? PRINTABLE[main][2] : main; }
      else if (SHIFTED[main]) { [code, vk] = SHIFTED[main]; key = main; }
      else { key = main; code = ''; vk = 0; }
      text = mask & 3 ? undefined : key;
    } else fail('INVALID_ARGUMENTS', `unknown key '${main}'`);
    if (mask & 3) text = undefined;
    const events = [...modifiers.map(item => ({ type: 'rawKeyDown', modifiers: mask, key: item[1], code: item[2], windowsVirtualKeyCode: item[3] })),
      { type: text ? 'keyDown' : 'rawKeyDown', modifiers: mask, key, code, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) },
      { type: 'keyUp', modifiers: mask, key, code, windowsVirtualKeyCode: vk },
      ...[...modifiers].reverse().map(item => ({ type: 'keyUp', modifiers: 0, key: item[1], code: item[2], windowsVirtualKeyCode: item[3] }))];
    for (const event of events) if (!await this.input(tab, 'Input.dispatchKeyEvent', event)) break;
    return {};
  }

  normalizeUrl(value, request) {
    const text = String(value ?? '').trim();
    const policyOpts = { env: this.env, approved: request?.policyApproved === true, grants: request?.approvalGrants };
    if (/^(?:https?|file):\/\//i.test(text) || /^about:blank$/i.test(text) || /^data:/i.test(text)) return assertBrowserUrl(text, policyOpts);
    if (/^[\w-]+(\.[\w-]+)+(?::\d+)?(?:[/?#]\S*)?$/.test(text)) {
      const candidate = `https://${text}`;
      assertBrowserUrl(candidate, policyOpts);
      return candidate;
    }
    fail('INVALID_ARGUMENTS', `set_value on a tab address needs a web address such as https://example.com, not '${clip(text, 80)}'; for a search, use the site's search URL (for example https://www.bing.com/search?q=…)`);
  }

  // A beforeunload prompt holds Page.navigate until it is answered, and a
  // server that has not answered within 15 s leaves the navigation running.
  async navigate(tab, url) {
    tab.loading = true; tab.crashed = false; tab.navigatingTo = null; tab.lastBlockedReason = null;
    const result = await this.untilDialog(tab, Promise.race([this.send(tab, 'Page.navigate', { url }, 120000), sleep(15000).then(() => 'slow')]));
    if (!result) return;
    if (result === 'slow') { tab.navigatingTo = url; return; }
    if (result.errorText) {
      tab.loading = false;
      if (result.errorText === 'net::ERR_BLOCKED_BY_CLIENT' && tab.lastBlockedReason) {
        const reason = tab.lastBlockedReason;
        tab.lastBlockedReason = null;
        throw new Error(reason);
      }
      fail('BROWSER_NAVIGATION_FAILED', `${url}: ${result.errorText}`);
    }
    // A same-document navigation (a #fragment) has no loader and never stops loading.
    if (!result.loaderId) tab.loading = false;
  }

  async openTab(browserKey, value, request, call) {
    const url = this.normalizeUrl(value, request);
    let browser;
    if (browserKey) {
      browser = [...this.browsers.values()].find(item => item.key === browserKey && item.status === 'connected' && !item.cdp.closed);
      if (!browser) fail('BROWSER_TAB_NOT_FOUND', `no connected browser ${browserKey}; call list_windows for current browser ids`);
    } else browser = await this.ensureAgent(request);
    const firstVisibleWindow = browser.source === 'agent' && !browser.headless && ![...this.tabs.values()].some(tab => tab.browser === browser && !tab.closed);
    const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank', background: true, ...(firstVisibleWindow ? { newWindow: true } : {}), ...(browser.contextId ? { browserContextId: browser.contextId } : {}) });
    const tab = this.tabFor(browser, { targetId, title: '', url: 'about:blank' });
    tab.approvedFileUrl = /^file:/i.test(url) ? canonicalFileUrl(url) : undefined;
    tab.opened = true;
    await this.session(tab);
    if (call) await this.working(tab, call);
    const since = tab.loadSeq;
    await this.navigate(tab, url);
    await this.settle(tab, request, since);
    return tab;
  }

  // Entry point for every lane-routed tool call. A call the user stopped takes
  // the badge off at once; otherwise it lingers (rest).
  async run(action, args, request) {
    const connect = USER_CONNECT.exec(args.elementId ?? '');
    if (connect) {
      if (action !== 'set_value' || args.value !== 'connect' || args.browserTab || ['windowTitle','processId','nativeWindowHandle','x','y'].some(key => args[key] !== undefined)) fail('INVALID_ARGUMENTS', 'Connect using set_value elementId "<browser id>:connect" value "connect", without other targets.');
      return this.connectUser(connect[1], request);
    }
    const bidi = await this.bidiBackend();
    const tabKey = ELEMENT_ID.exec(args.elementId ?? '')?.[1] ?? args.browserTab;
    const browserKey = NEW_TAB.exec(args.elementId ?? '')?.[1];
    // Keep explicitly configured CDP tabs reachable when the new-tab engine is Gecko.
    if (bidi && !this.tabs.has(tabKey) && !(browserKey && [...this.browsers.values()].some(browser => browser.key === browserKey))) return bidi.run(action, args, request);
    this.lastUsed = Date.now();
    for (const browser of this.browsers.values()) if (browser.kept && !browser.cdp?.closed) joinProfile(browser);
    const call = { tabs: new Set() };
    try { return await this.frames.scope(()=>this.runPage(action, args, request, call)); }
    finally {
      this.lastUsed = Date.now();
      for (const browser of this.browsers.values()) if (browser.kept && !browser.cdp?.closed) try { joinProfile(browser); } catch(error) { process.stderr.write('Browser profile renewal failed: '+error.message+'\n'); }
      for (const tab of call.tabs) this.rest(tab, Boolean(request?.cancelled));
    }
  }

  async runPage(action, args, request, call = { tabs: new Set() }) {
    if (this.disabled) fail('BROWSER_LANE_UNAVAILABLE', 'the browser lane is turned off (WCU_BROWSER_LANE=off)');
    const conflict = ['windowTitle', 'processId', 'nativeWindowHandle'].filter(key => args[key] !== undefined);
    if (conflict.length) fail('INVALID_ARGUMENTS', `browserTab and page element ids target a page; drop ${conflict.join(', ')}`);
    const coordinates=args.x!==undefined||args.y!==undefined;
    if(coordinates&&(!args.browserTab||args.elementId||!['click','double_click','move','scroll'].includes(action)||!Number.isInteger(args.x)||!Number.isInteger(args.y)))fail('INVALID_ARGUMENTS','Page coordinates require browserTab, both x and y, and no elementId.');
    if (action === 'invoke' && (args.action ?? 'default') !== 'default') fail('INVALID_ARGUMENTS', `invoke action '${args.action}' is for UI Automation elements; in a page, click the element to open or close it, and scroll its list or the page to bring it into view`);
    const match = typeof args.elementId === 'string' ? ELEMENT_ID.exec(args.elementId) : null;
    const opener = typeof args.elementId === 'string' ? NEW_TAB.exec(args.elementId) : null;
    if (opener) {
      if (action !== 'set_value') fail('INVALID_ARGUMENTS', `${args.elementId} opens a tab only through set_value with a web address`);
      const tab = await this.openTab(opener[1], args.value, request, call);
      assertBrowserUrl(tab.url || 'about:blank', { env: this.env, approved: request?.policyApproved === true, approvedFileUrl: tab.approvedFileUrl, grants: request?.approvalGrants });
      if (tab.dialog) return { meta: { ok: true, action, channel: 'browser', opened: this.describeTab(tab), background: true, dialog: tab.dialog, verification: 'sent', verificationNote: DIALOG_NOTE } };
      if (tab.navigatingTo) return { meta: { ok: true, action, channel: 'browser', opened: this.describeTab(tab), background: true, ...this.slowNavigation(tab) } };
      const outline = await this.outline(tab, undefined, request);
      this.remember(tab, outline);
      return this.page({ ok: true, action, opened: this.describeTab(tab), background: true }, `${this.header(tab)}\n${render(outline.lines)}`, outline);
    }
    const tabKey = match?.[1] ?? args.browserTab;
    if (match && args.browserTab && args.browserTab !== match[1]) fail('INVALID_ARGUMENTS', `elementId ${args.elementId} belongs to tab ${match[1]}, not ${args.browserTab}`);
    const tab = await this.findTab(tabKey, request);
    if (tab.browser.source === 'user' && !tab.opened && !tab.userTabApproved && (this.env.WCU_APPROVAL_SECRET || this.env.WCU_USER_TABS_FILE)) {
      if (request?.policyApproved === true || request?.approvalGrants?.userTabs?.has(tab.key)) {
        tab.userTabApproved = true;
        this.syncUserTabs();
        await this.updateIndicator(tab).catch(() => { });
      } else {
        throw new Error('WCU_APPROVAL_REQUIRED: accessing this existing browser tab requires approval.');
      }
    }
    if (!/:address$/.test(args.elementId ?? '')) this.guardPage(tab, request);
    await this.working(tab, call);
    // An open alert/confirm/prompt blocks the page: every other call would hang.
    if (tab.dialog) {
      if (action === 'type_text' && tab.dialog.type === 'prompt') {
        tab.dialog.text = args.text;
        return { meta: { ok: true, action, channel: 'browser', tab: this.describeTab(tab), dialog: tab.dialog, verification: 'sent', verificationNote: 'keypress Enter answers the prompt with this text; Escape cancels it.' } };
      }
      if (action !== 'keypress') fail('BROWSER_DIALOG_OPEN', `a JavaScript ${tab.dialog.type} is open (“${tab.dialog.message}”); keypress Enter with browserTab ${tab.key} accepts it, Escape dismisses it${tab.dialog.type === 'prompt' ? '; type_text first sets the answer' : ''}`);
    }
    let node = match && match[2] !== 'address' ? Number(match[2]) : null;
    const address = match?.[2] === 'address';
    if (address && action !== 'set_value') fail('INVALID_ARGUMENTS', `${args.elementId} is the tab address; use set_value with a web address to navigate`);
    if (tab.crashed && !address && action !== 'close_window') fail('BROWSER_TAB_CRASHED', `the page in tab ${tab.key} crashed; set_value ${tab.key}:address with its address loads it again, close_window closes the tab`);
    if (!match && !coordinates && ['click', 'double_click', 'move', 'focus', 'invoke', 'set_value', 'element_info'].includes(action)) fail('INVALID_ARGUMENTS', `${action} in a browser tab needs a page element id such as ${tab.key}:123 or explicit viewport coordinates where supported`);
    // From here on node is the DOM node behind the element id.
    if (node !== null) {
      node = this.nodeFor(tab, node);
      if (node === undefined) fail('BROWSER_ELEMENT_STALE', `element ${args.elementId} was not read from the page now in tab ${tab.key} (the tab navigated since, or the id is older than this server); read the page again with accessibility_tree or find`);
    }
    const document = tab.document;
    switch (action) {
      case 'snapshot': case 'tree': {
        const outline = await this.outline(tab, args.maxNodes, request);
        this.remember(tab, outline);
        const result = this.page({ ok: true, action, tab: this.describeTab(tab), ...(tab.navigatingTo ? { stillLoading: true, navigatingTo: tab.navigatingTo } : {}) }, `${this.header(tab)}\n${render(outline.lines)}`, outline);
        if (action === 'snapshot' && args.includeScreenshot) {
          try { result.screenshot = await this.screenshot(tab, args.maxWidth); } catch (error) { result.meta.captureError = error.message; }
        }
        return result;
      }
      case 'find': return this.find(tab, args, request);
      case 'wait_for': return this.waitFor(tab, args, request);
      case 'element_info': {
        await this.frames.validate(tab, node);
        return this.elementInfo(tab, node);
      }
      case 'screenshot': {
        await this.frames.refresh(tab, request).catch(error => { if (/^(?:WCU_|BROWSER_FRAME_LIMIT)/.test(error?.message ?? '')) throw error; });
        await this.checkLocation(tab, request);
        return { meta: { ok: true, action, channel: 'browser', tab: this.describeTab(tab) }, screenshot: await this.screenshot(tab, args.maxWidth) };
      }
      case 'activate_window':
        await tab.browser.cdp.send('Target.activateTarget', { targetId: tab.targetId });
        return { meta: { ok: true, action, channel: 'browser', tab: this.describeTab(tab), activated: true, verification: 'sent' } };
      case 'close_window': {
        await this.untilDialog(tab, this.send(tab, 'Page.close'));
        for (let i = 0; i < 20 && !tab.closed && !tab.dialog; i++) await sleep(50);
        if (tab.dialog) return { meta: { ok: true, action, channel: 'browser', tab: this.describeTab(tab), closed: false, dialog: tab.dialog, verification: 'sent', verificationNote: 'The page asks before it closes: keypress Enter closes it, Escape keeps it open.' } };
        return { meta: { ok: true, action, channel: 'browser', tab: this.describeTab(tab), closed: Boolean(tab.closed), verification: tab.closed ? 'observed' : 'sent', ...(tab.closed ? {} : { verificationNote: 'The tab has not closed yet; list_windows shows whether it is gone.' }) } };
      }
    }
    // One action at a time per tab: two set_value calls at once would each focus
    // their field and type into whichever had focus last. Reads do not wait.
    const unlock = await this.lock(tab, request);
    try { return await this.act(tab, action, args, request, node, address, document); }
    finally { unlock(); }
  }

  async act(tab, action, args, request, node, address, document) {
    if(node!==null)await this.frames.validate(tab,node);
    // The action before this one may have left a dialog or a new page.
    if (tab.closed) fail('BROWSER_TAB_NOT_FOUND', `tab ${tab.key} was closed; call list_windows for current tab ids`);
    if (tab.dialog && action !== 'keypress') fail('BROWSER_DIALOG_OPEN', `a JavaScript ${tab.dialog.type} is open (“${tab.dialog.message}”); keypress Enter with browserTab ${tab.key} accepts it, Escape dismisses it`);
    if (node !== null && tab.document !== document) fail('BROWSER_ELEMENT_STALE', `element ${args.elementId} belongs to the page tab ${tab.key} showed before it navigated; read the page again with accessibility_tree or find`);
    if (!address) {
      this.guardPage(tab, request);
      // The baseline for the change report; an open dialog would hold the read.
      if (tab.last === null && !tab.dialog) this.remember(tab, await this.outline(tab, undefined, request));
      if (!tab.dialog) await this.reveal(tab);
    }
    const detail = {};
    let target;
    if (node !== null) target = await this.describeNode(tab, node);
    const coordinatePoint=args.x!==undefined?await this.viewportPoint(tab,args):null;
    if(coordinatePoint)target=`viewport (${coordinatePoint.x}, ${coordinatePoint.y})`;
    const needsResolvedObj = node !== null && !address && !coordinatePoint && ['click', 'double_click', 'invoke', 'move', 'set_value', 'scroll'].includes(action);
    let resolvedObj = needsResolvedObj ? await this.resolveElement(tab, node) : null;
    tab.openedTabs = []; tab.chooser = null; tab.requests.clear(); tab.lastBlockedReason = null;
    tab.acting++;
    const since = tab.loadSeq;
    // A user's tab intercepts the file chooser only while the lane acts on it.
    // Both switches are page commands: a crashed or busy renderer must not hold the action.
    const ready = !tab.dialog && !tab.crashed;
    if (ready && !tab.intercepting && tab.browser.source !== 'agent' && ['click', 'double_click', 'invoke', 'keypress'].includes(action)) {
      tab.intercepting = true; await this.frames.intercept(tab,true);
    }
    // Network events only while acting: requests the action sets off are waited for.
    if (ready && !tab.network && action !== 'focus' && action !== 'move') {
      tab.network = true; await this.send(tab, 'Network.enable', { maxPostDataSize: 0 }, 3000).catch(() => { });
    }
    try {
      switch (action) {
        case 'click': case 'double_click': case 'invoke': {
          if(coordinatePoint){await this.pointAt(tab,coordinatePoint,true);await this.mouse(tab,coordinatePoint.x,coordinatePoint.y,args.button??'left',action==='double_click'?2:1);break;}
          if (args.button === undefined || args.button === 'left') {
            const chosen = await this.chooseOption(tab, node, resolvedObj);
            if (chosen) { Object.assign(detail, chosen); break; }
          }
          await this.refuseDisabled(tab, node, target, resolvedObj);
          const point = await this.pointFor(tab, node, resolvedObj);
          await this.pointAt(tab, point, true);
          await this.mouse(tab, point.x, point.y, action === 'invoke' ? 'left' : args.button, action === 'double_click' ? 2 : 1);
          break;
        }
        case 'move': {
          const point = coordinatePoint??await this.pointFor(tab, node, resolvedObj);
          await this.pointAt(tab, point);
          await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
          break;
        }
        case 'drag': {
          const view = await this.viewportSize(tab);
          const points = args.path.map(point => validateViewportPoint(point, view));
          const button=args.button??'left',buttons={left:1,right:2,middle:4}[button];
          let down=false,lastPoint=points[0];
          try{
            await this.input(tab,'Input.dispatchMouseEvent',{type:'mouseMoved',...points[0],button:'none'});
            if(request?.cancelled)fail('COMPUTER_USE_CANCELLED','Cancelled before drag.');
            down=await this.input(tab,'Input.dispatchMouseEvent',{type:'mousePressed',...points[0],button,buttons,clickCount:1});
            for(const point of points.slice(1)){
              if(request?.cancelled)fail('COMPUTER_USE_CANCELLED','Cancelled during drag.');
              if(!down||!await this.input(tab,'Input.dispatchMouseEvent',{type:'mouseMoved',...point,button,buttons}))break;
              lastPoint=point;
              await sleep(16);
            }
          }finally{if(down)await this.send(tab,'Input.dispatchMouseEvent',{type:'mouseReleased',...lastPoint,button,buttons:0,clickCount:1}).catch(()=>{});}
          target='viewport path';detail.pathPoints=points.length;break;
        }
        case 'focus':
          await this.untilDialog(tab, this.send(tab, 'DOM.focus', { backendNodeId: node }).catch(error => fail('BROWSER_NOT_FOCUSABLE', `${target} cannot take focus (${error.message})`)));
          break;
        case 'set_value': {
          if (address) {
            const url = this.normalizeUrl(args.value, request);
            tab.approvedFileUrl = /^file:/i.test(url) ? canonicalFileUrl(url) : undefined;
            await this.navigate(tab, url);
            break;
          }
          let objectId = resolvedObj;
          // A label's text line names its control; set_value goes to that control.
          const control = (await this.send(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration: LABEL_CONTROL, returnByValue: false })).result;
          if (control?.objectId) {
            objectId = control.objectId; node = (await this.send(tab, 'DOM.describeNode', { objectId })).node.backendNodeId;
            target = await this.describeNode(tab, node); detail.field = this.idFor(tab, node);
          }
          const kind = await this.call(tab, objectId, EDIT_KIND);
          if (kind === 'disabled' || kind === 'readonly') fail('BROWSER_NOT_EDITABLE', `${target} is ${kind === 'disabled' ? 'disabled' : 'read-only'}; it takes no value`);
          if (!await this.call(tab, objectId, ACCEPTS, [args.value.trim()])) {
            const type = await this.call(tab, objectId, 'function () { return this.type; }');
            fail('BROWSER_VALUE_REJECTED', `${target} does not take '${clip(args.value, 40)}' and keeps its value; a ${type} input takes ${FORMATS[type] ?? 'its own format'}`);
          }
          // A write runs the page's input and change handlers, which may raise a
          // dialog; the action then ends at once and reports it.
          const write = pending => this.untilDialog(tab, pending);
          if (kind === 'select') {
            const chosen = await write(this.call(tab, objectId, SELECT_OPTION, [args.value]));
            if (chosen && !chosen.ok) fail(chosen.disabled ? 'BROWSER_OPTION_DISABLED' : 'BROWSER_OPTION_NOT_FOUND', chosen.disabled
              ? `option ${chosen.disabled.map(name => `'${clip(name, 60)}'`).join(', ')} is disabled; options: ${chosen.options.join(' | ')}`
              : `no option '${clip(args.value, 80)}'; options: ${chosen.options.join(' | ')}`);
          } else if (kind === 'value') {
            await write(this.call(tab, objectId, SET_VALUE, [args.value.trim()]));
          } else if (kind === 'text' || kind === 'editable') {
            if (await write(this.send(tab, 'DOM.focus', { backendNodeId: node })) !== null) {
              if (this.showsIndicator(tab)) await this.pointAt(tab, await this.centerOf(tab, node));
              await this.call(tab, objectId, SELECT_ALL);
              if (args.value) await write(this.send(tab, 'Input.insertText', { text: args.value }));
              else await this.key(tab, ['backspace']);
            }
          } else if (kind === 'checkbox' || kind === 'radio') {
            const text = args.value.trim(), want = TRUE_VALUE.test(text) ? true : FALSE_VALUE.test(text) ? false : null;
            if (want === null) fail('INVALID_ARGUMENTS', `set_value on a ${kind} takes true or false, not '${clip(text, 40)}'`);
            if (await this.call(tab, objectId, 'function () { return this.checked; }') !== want) {
              if (kind === 'radio' && !want) fail('BROWSER_NOT_EDITABLE', `${target} is selected; a radio button is cleared by selecting another option of its group`);
              const point = await this.pointFor(tab, node); await this.pointAt(tab, point, true); await this.mouse(tab, point.x, point.y);
            }
          } else if (kind === 'file') {
            const files = args.value.split(/\r?\n|\|/).map(item => item.trim()).filter(Boolean);
            const missing = files.filter(file => { try { return !path.isAbsolute(file) || !statSync(file).isFile(); } catch { return true; } });
            if (!files.length || missing.length) fail('BROWSER_FILE_NOT_FOUND', `a file input takes absolute paths of existing files, one per line; not usable: ${missing.join(', ') || '(no path given)'}`);
            assertUpload(files, { env: this.env, approved: request?.policyApproved === true, grants: request?.approvalGrants });
            await this.send(tab, 'DOM.setFileInputFiles', { files, backendNodeId: node });
          } else fail('BROWSER_NOT_EDITABLE', `${target} does not take a value; click it instead`);
          if (!tab.dialog) detail.verifyValue = clip(String(await this.call(tab, objectId, READ_VALUE).catch(() => '') ?? ''), 200);
          break;
        }
        case 'type_text': {
          if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uE000-\uF8FF]/.test(String(args.text ?? ''))) fail('INVALID_ARGUMENTS', 'Control and private-use characters are not allowed in type_text.');
          const field = (await this.frames.focusedValue(tab,FOCUSED_FIELD)).result.value;
          if (field === 'locked') fail('BROWSER_NOT_EDITABLE', `the focused field in tab ${tab.key} is disabled or read-only`);
          if (field !== 'editable') fail('BROWSER_NO_FOCUSED_FIELD', `nothing editable has focus in tab ${tab.key}; click or focus a field first, or use set_value on its id`);
          if (await this.untilDialog(tab, this.send(tab, 'Input.insertText', { text: args.text })) !== null)
            detail.verifyValue = clip(String((await this.frames.focusedValue(tab,FOCUSED_VALUE)).result.value ?? ''), 200);
          break;
        }
        case 'keypress': Object.assign(detail, await this.key(tab, args.keys)); break;
        case 'scroll': {
          const deltaX = args.deltaX ?? 0, deltaY = args.deltaY ?? 480;
          let objectId = null;
          const position = async () => ({ page: (await this.send(tab, 'Runtime.evaluate', { expression: '[scrollX, scrollY]', returnByValue: true })).result.value,
            element: objectId ? await this.call(tab, objectId, SCROLL_POSITION).catch(() => null) : null });
          const wheel = async point => { await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY }); await sleep(80); };
          let before;
          if(coordinatePoint){before=await position();await wheel(coordinatePoint);}
          else if (node !== null) { const point = await this.pointFor(tab, node, resolvedObj); await this.pointAt(tab, point); objectId = resolvedObj; before = await position(); await wheel(point); }
          else {
            // The page scrolls its document; a wheel at the viewport center, which
            // may land on an iframe or a panel, is only for pages that never move.
            before = await position();
            await this.send(tab, 'Runtime.evaluate', { expression: `scrollBy({ left: ${Number(deltaX)}, top: ${Number(deltaY)}, behavior: 'instant' })` });
            const moved = (await position()).page;
            if (moved[0] === before.page[0] && moved[1] === before.page[1]) {
              const metrics = await this.send(tab, 'Page.getLayoutMetrics'); const view = metrics.cssLayoutViewport ?? metrics.layoutViewport;
              await wheel({ x: view.clientWidth / 2, y: view.clientHeight / 2 });
            }
          }
          const after = await position();
          detail.pageScroll = { before: before.page, after: after.page };
          // A list or panel that scrolls by itself reports its own offset.
          if (before.element || after.element) detail.elementScroll = { before: before.element, after: after.element };
          break;
        }
        default: fail('INVALID_ARGUMENTS', `${action} is not available in a browser tab`);
      }
      await this.settle(tab, request, since);
      // A download the action started is given a moment to finish.
      for (let wait = Date.now() + 3000; tab.downloads.some(item => item.state === 'inProgress') && Date.now() < wait;) await sleep(100);
    } finally {
      tab.acting--;
      await this.release(tab);
      tab.requests.clear();
    }
    // What the action set off beyond this page: new tabs, downloads, a file chooser, a load still running.
    const opened = tab.openedTabs.splice(0).filter(item => !item.closed).map(item => this.describeTab(item));
    const notes = [];
    if (opened.length) { detail.openedTabs = opened; notes.push('The action opened a new tab (openedTabs); pass its id as browserTab to read it.'); }
    const downloads = tab.downloads.splice(0).map(({ guid, ...item }) => item);
    if (downloads.length) { detail.downloads = downloads; notes.push('The action downloaded a file (downloads: its path and state).'); }
    if (tab.chooser) { detail.fileChooser = tab.chooser; tab.chooser = null; notes.push('A file chooser opened; set_value on the file input (fileChooser.input) with absolute file paths uploads them.'); }
    if (tab.navigatingTo) return { meta: { ok: true, action, channel: 'browser', target, ...detail, ...this.slowNavigation(tab) } };
    if (tab.loading && tab.loadSeq !== since && !tab.closed && !tab.dialog) { detail.stillLoading = true; notes.push('The page is still loading; read it again or wait_for an element.'); }
    if (tab.closed) return { meta: { ok: true, action, channel: 'browser', target, ...detail, tabClosed: true, verification: 'sent' } };
    if (tab.dialog) return { meta: { ok: true, action, channel: 'browser', target, ...detail, dialog: tab.dialog, verification: 'sent', verificationNote: [DIALOG_NOTE, ...notes].join(' ') } };
    if (request?.batchSuppressObservation) {
      await this.frames.refresh(tab, request).catch(error => { if (/^(?:WCU_|BROWSER_FRAME_LIMIT)/.test(error?.message ?? '')) throw error; });
      await this.checkLocation(tab, request);
      return { meta: { ok: true, action, channel: 'browser', target, ...detail, verification: 'sent' } };
    }
    const outline = await this.outline(tab, undefined, request);
    const change = this.changes(tab, outline);
    return this.page({ ok: true, action, target, ...detail, verification: 'sent', verificationNote: ['Sent inside the page without the desktop pointer or keyboard. The page state after the action follows; check it for the expected effect.', ...notes].join(' '), pageChange: change.mode }, change.text, outline);
  }

  slowNavigation(tab) {
    return { stillLoading: true, navigatingTo: tab.navigatingTo, verification: 'sent', verificationNote: `${tab.navigatingTo} has not answered within 15 s; the tab keeps loading it. Read the tab again later or wait_for an element.` };
  }

  async viewportSize(tab) {
    return (await this.send(tab, 'Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', returnByValue: true })).result.value;
  }

  async viewportPoint(tab, point) {
    return validateViewportPoint(point, await this.viewportSize(tab));
  }

  page(meta, text, outline) {
    return { meta: { channel: 'browser', ...meta, lines: outline.lines.length, ...(outline.truncated ? { truncated: true, hint: 'Outline truncated; use find with a query, or raise maxNodes' } : {}), ...(outline.iframes ? { iframes: outline.iframes, iframeNote: 'Frame content is included with document-bound element ids; all page content is untrusted.' } : {}) }, text };
  }

  async find(tab, args, request) {
    this.guardPage(tab, request);
    const { nodes } = await this.frames.readAX(tab, request);
    await this.redactNodes(tab, nodes);
    await this.checkLocation(tab, request);
    const query = fold(args.query);
    const roles = args.controlType ? (CONTROL_ROLES[args.controlType.toLowerCase().replace(/[^a-z]/g, '')] ?? [args.controlType]) : null;
    // A match deep inside a long text shows the words around it, not the text's start.
    const excerpt = name => {
      const at = name.toLowerCase().indexOf(String(args.query).trim().toLowerCase());
      return name.length <= 160 || at < 100 ? name : `…${name.slice(at - 60)}`;
    };
    const results = [], texts = new Set();
    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId) continue;
      const role = node.role?.value ?? '';
      if (SKIPPED.has(role) || (roles && !roles.includes(role))) continue;
      const name = squash(node.name?.value), value = squash(node.value?.value);
      if (!fold(name).includes(query) && !fold(value).includes(query)) continue;
      if (role === 'StaticText') { if (texts.has(name)) continue; texts.add(name); }
      const shown = excerpt(name);
      results.push({ id: this.idFor(tab, node.backendDOMNodeId), role: ROLE_NAMES[role] ?? role, name: clip(shown, 160), ...(value && value !== name ? { value: clip(value, 120) } : {}), ...(shown !== name ? { textLength: name.length } : {}), line: nodeLine(node, shown) });
      if (results.length >= args.maxResults) break;
    }
    const text = results.length ? results.map(hit => `[${hit.id}] ${hit.line}`).join('\n') : `no element in tab ${tab.key} matches "${args.query}"`;
    return { meta: { ok: true, action: 'find', channel: 'browser', tab: this.describeTab(tab), query: args.query, count: results.length, results: results.map(({ line, ...hit }) => hit) }, text };
  }

  async waitFor(tab, args, request) {
    if (args.condition === 'window') fail('INVALID_ARGUMENTS', 'condition window does not apply to a browser tab; wait for element or text');
    const started = Date.now();
    for (; ;) {
      if (request?.cancelled) fail('COMPUTER_USE_CANCELLED', 'cancelled');
      if(tab.dialog) return {meta:{ok:false,action:'wait_for',channel:'browser',tab:this.describeTab(tab),dialog:tab.dialog,verification:'blocked',verificationNote:DIALOG_NOTE}};
      if(tab.closed||tab.crashed)fail('BROWSER_TAB_CLOSED','The page closed while waiting.');
      // Text waits read visible text locally rather than downloading the AX
      // tree on every poll. A dialog races the read and returns immediately.
      const pending=args.condition==='text'
        ? this.frames.textContains(tab,fold(args.query))
        : this.find(tab, { ...args, maxResults: 1, controlType: args.controlType }, request);
      const observed=await this.untilDialog(tab,pending);
      if(observed===null)continue;
      const found=args.condition==='text'?observed.result?.value===true:observed.meta.count>0;
      if (found === args.appear) return { meta: { ok: true, action: 'wait_for', channel: 'browser', tab: this.describeTab(tab), verification: 'observed', elapsedMs: Date.now() - started, condition: args.condition, query: args.query, appear: args.appear } };
      if (Date.now() - started > args.timeoutMs) return { meta: { ok: false, action: 'wait_for', channel: 'browser', tab: this.describeTab(tab), verification: 'timeout', elapsedMs: Date.now() - started, condition: args.condition, query: args.query, appear: args.appear } };
      await sleep(args.intervalMs);
    }
  }

  async elementInfo(tab, node) {
    const objectId = await this.resolveElement(tab, node);
    const facts = await this.call(tab, objectId, ELEMENT_FACTS);
    let rootViewportBox;
    if (node?.frameId && tab.frames?.get(node.frameId)?.parentId) {
      try {
        const { quads } = await this.send(tab, 'DOM.getContentQuads', { backendNodeId: node });
        const quad = quads?.find(item => quadArea(item) > 1);
        if (quad) {
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const [tl, br] = await Promise.all([
            this.frames.rootPoint(tab, node, { x: Math.min(...xs), y: Math.min(...ys) }, { check: false }),
            this.frames.rootPoint(tab, node, { x: Math.max(...xs), y: Math.max(...ys) }, { check: false }),
          ]);
          rootViewportBox = { x: Math.round(tl.x), y: Math.round(tl.y), width: Math.round(br.x - tl.x), height: Math.round(br.y - tl.y) };
        }
      } catch { }
    }
    return { meta: { ok: true, action: 'element_info', channel: 'browser', tab: this.describeTab(tab), id: this.idFor(tab, node), line: await this.describeNode(tab, node), ...facts, ...(rootViewportBox ? { rootViewportBox } : {}) } };
  }

  async screenshot(tab, maxWidth = 1600) {
    await this.reveal(tab);
    const indicator = this.showsIndicator(tab);
    const [metrics, dpr] = await Promise.all([
      this.send(tab, 'Page.getLayoutMetrics'),
      this.send(tab, 'Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }),
      indicator ? this.updateIndicator(tab, null, "globalThis.__dshStatus('capture');") : Promise.resolve(),
    ]);
    const view = metrics.cssVisualViewport ?? metrics.visualViewport;
    const ratio = dpr.result.value || 1;
    const cssScale = maxWidth ? Math.min(1, maxWidth / view.clientWidth) : 1;
    const scale = cssScale / ratio;
    // Always clipped to the visual viewport: without a clip the image also holds
    // the scroll bars and no longer matches the page area or the stated size.
    // DSH's pointer is hidden meanwhile: the image shows the page alone.
    try {
      const data = await this.capture(tab, { format: 'png', clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale } });
      const png = Buffer.from(data, 'base64');
      return { base64: data, mimeType: 'image/png', cssScale, width: png.readUInt32BE(16), height: png.readUInt32BE(20), note: 'Viewport of the tab, captured inside the browser; coordinates are page pixels, not screen coordinates.' };
    } finally { if (indicator) await this.updateIndicator(tab, null, "globalThis.__dshStatus('captured');"); }
  }

  // A tab that is not painting (a background tab of a visible window, or any
  // tab of a minimized one) answers a capture only while another capture is
  // pending: one request alone never returned (Chrome 155, Edge 156), asking
  // again every 300-500 ms returned in 0.4-6 s. A painting tab answers the first
  // request in about 50 ms, before any second one is sent. Nothing is activated
  // or restored, so the user's windows stay as they are.
  async capture(tab, params) {
    let answer = null, failure = null, inFlight = 0, wake = () => { };
    const ask = () => {
      inFlight++;
      void this.send(tab, 'Page.captureScreenshot', params, 15000)
        .then(value => { answer ??= value; }, error => { failure ??= error; })
        .finally(() => { inFlight--; wake(); });
    };
    ask();
    for (let asked = 1; !answer && !(failure && !/BROWSER_TIMEOUT/.test(failure.message)); asked++) {
      const settled = new Promise(resolve => { wake = resolve; });
      if (asked > 8 || failure) {
        if (!inFlight) break;
        await settled;
        continue;
      }
      await Promise.race([settled, sleep(500)]);
      if (!answer && !failure) ask();
    }
    if (answer) return answer.data;
    throw failure;
  }

  async health() {
    const bidi = await this.bidiBackend();
    if (bidi) return bidi.health();
    await this.resolveApp();
    const executable = this.agentExecutable();
    const attachCandidate = await this.userCandidate();
    return { enabled: !this.disabled, visible: this.env.WCU_BROWSER_HEADLESS !== '1', app: this.app, ...(this.resolvedApp !== undefined ? { resolvedApp: this.resolvedApp } : {}), keepSignIns: this.keepSignIns, agent: this.agentStartup(),
      agentBrowser: executable?.path ?? null, agentProfile: this.agentDir, ...(this.keepSignIns && executable ? { keptProfile: this.keptDir(executable) } : {}),
      endpoints: [...this.candidates(),...(attachCandidate?[attachCandidate]:[])].map(candidate => ({ name: candidate.name, source: candidate.source })),
      ...(this.attachUser?{attachUser:{enabled:true,available:!!attachCandidate,...(attachCandidate?{connect:attachCandidate.key+':connect',status:this.attachAttempts.get(attachCandidate.key)?.status??'available'}:{})}}:{}),
      connected: [...this.browsers.values()].filter(browser => browser.status === 'connected').map(browser => ({ id: browser.key, name: browser.name, source: browser.source })) };
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--host-kept-profile' && process.argv[3]) {
    await hostKeptProfile(process.argv[3]);
  } else if (process.argv[2] === '--watch-profile') {
    const [, , , profile, url, pid] = process.argv;
    if (profile && /^(?:ws:\/\/127\.0\.0\.1:\d+|ws\+pipe:\/\/127\.0\.0\.1\/devtools\/pipe\/[a-z0-9._-]+)\/devtools\/browser\//i.test(url ?? '') && Number(pid) > 0)
      await watchProfile(profile, url, Number(pid));
  }
}
