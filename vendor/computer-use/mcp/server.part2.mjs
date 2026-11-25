function spawnBackend(desk = 'current', desktopName) {
  const options = {
    // Outside the plugin, so the market can replace it (update-guard.mjs); apps
    // the backend starts without a folder of their own start here too.
    cwd: WORK_DIR,
    // Under WSL the backend reads the WCU_ variables only when WSLENV names them (#79).
    env: backendEnv({ ...process.env, WCU_CANCEL_EVENT: takeover.helperDisabled ? '' : takeover.eventName, WCU_READY_EVENT: takeover.helperDisabled ? '' : takeover.eventName+'-ready' }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  };
  // The hidden desktop's backend starts through the desktop worker, which
  // creates it on that desktop inside the desktop's job and relays its streams.
  const proc = backends[desk] = desk === 'background'
    ? spawn(powershell, [...backgroundDesktopArgs(desktopName), '-Executable', powershell, '-BackendScript', backendPath], options)
    : spawn(powershell, ["-NoLogo", "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", windowsScript(backendPath), "-Persistent"], options);
  proc.wcuDesk = desk;
  proc.wcuReady=false;
  const readyTimeout=Math.min(30000,Math.max(100,Number(process.env.WCU_BACKEND_READY_TIMEOUT_MS)||30000));
  proc.wcuReadyTimer=setTimeout(()=>killBackend(new Error('WCU_BACKEND_PROTOCOL_ERROR: backend did not become ready within '+readyTimeout+'ms; no action was sent.'),proc),readyTimeout);
  proc.stderr.setEncoding("utf8");
  let stderrTail = "";
  // Forward backend diagnostics (parse errors, P/Invoke failures, backend
  // tracebacks) to our stderr so they surface in the MCP client's log and in CI.
  // The tail also explains an exit to the model (#54).
  proc.stderr.on("data", (chunk) => {
    process.stderr.write(desk === 'background' ? `[wcu-backend:hidden-desktop] ${chunk}` : `[wcu-backend] ${chunk}`);
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  let invalid = false;
  const failProtocol = error => {
    if (invalid) return;
    invalid = true;
    killBackend(error, proc);
  };
  const output = new RpcFramer({
    allowHeaders: false, maxBytes: 64*1024*1024,
    onError: error => failProtocol(new Error('WCU_BACKEND_PROTOCOL_ERROR: ' + error.message)),
    onMessage(resp) {
      if (invalid || backends[desk] !== proc) return;
      if(!resp||typeof resp!=='object'||Array.isArray(resp)){
        failProtocol(new Error('WCU_BACKEND_PROTOCOL_ERROR: invalid response shape'));return;
      }
      if(resp.type==='ready'){
        if(proc.wcuReady||resp.protocol!==BACKEND_PROTOCOL_VERSION||!Number.isSafeInteger(resp.pid)||resp.pid<=0){
          failProtocol(new Error('WCU_BACKEND_PROTOCOL_MISMATCH: invalid ready handshake; no action was sent.'));return;
        }
        proc.wcuReady=true;proc.wcuPid=resp.pid;clearTimeout(proc.wcuReadyTimer);dispatchNextBackend(proc);return;
      }
      if(!proc.wcuReady||!Number.isSafeInteger(resp.id)||typeof resp.ok!=='boolean'){
        failProtocol(new Error('WCU_BACKEND_PROTOCOL_ERROR: response arrived without a valid ready handshake or result shape'));return;
      }
      const w = backendWaiters.get(resp.id);
      if (!w || w.proc !== proc) return;
      backendWaiters.delete(resp.id);
      clearTimeout(w.timer);
      if (resp.ok === false) {
        w.reject(new Error(resp.error || `Backend action '${resp.action}' failed`));
      } else {
        w.resolve(resp);
      }
      if (retiringBackends.has(proc)) killBackend(new Error("COMPUTER_USE_CANCELLED"), proc);
      else dispatchNextBackend(proc);
    }
  });
  proc.stdout.on('data', chunk => { if (!invalid) output.push(chunk); });
  proc.stdin.on("error", () => { /* EPIPE when the backend dies; the exit handler fails waiters */ });
  const onDeath = (err) => {
    clearTimeout(proc.wcuReadyTimer);
    if (backends[desk] === proc) backends[desk] = null;
    if (err) { failBackendWaiters(err, proc); return; }
    // 'exit' can precede the last stderr chunk; wait briefly for the stream.
    const report = () => failBackendWaiters(backendExitError(proc.exitCode, stderrTail), proc);
    if (proc.stderr.readableEnded) { report(); return; }
    const timer = setTimeout(report, 300);
    proc.stderr.once("end", () => { clearTimeout(timer); report(); });
  };
  proc.on("error", onDeath);
  proc.on("exit", () => onDeath());
  return proc;
}

// "Backend process exited" alone hid why every tool failed (#54). Quote the
// backend's startup failure line, or else its last lines of error output.
function backendExitError(code, stderr) {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^stage=\S+ elapsedMs=\d+$/.test(line));
  const startup = lines.findLast(line => line.startsWith("WCU_BACKEND_STARTUP_FAILED"));
  const detail = startup || lines.filter(line => !/^(?:\+|~|At |所在位置)/.test(line)).slice(-3).join(" | ");
  return new Error(`Backend process exited${code == null ? "" : ` (exit code ${code})`}${detail ? `: ${detail.slice(0, 600)}` : ""}`);
}

function ensureBackend() {
  const live = backends.current;
  if (live && retiringBackends.has(live)) throw new Error("COMPUTER_USE_STOPPING");
  return live && live.exitCode === null ? live : spawnBackend('current');
}

function killBackend(error = new Error("Backend process stopped"), proc = backends.current) {
  if (proc) {
    clearTimeout(proc.wcuReadyTimer);
    if (backends[proc.wcuDesk] === proc) backends[proc.wcuDesk] = null;
    failBackendWaiters(error, proc);
    // The hidden desktop's backend is the worker's child: end it by its own id.
    if (proc.wcuDesk === 'background' && proc.wcuPid) { try { process.kill(proc.wcuPid); } catch { /* already gone */ } }
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }
}
function killBackends(error) {
  for (const proc of Object.values(backends)) if (proc) killBackend(error, proc);
}

// DSH's hidden desktop. Inside DSH the adapter owns it (dsh-plugin.mjs), so the
// apps on it outlive an MCP restart: this server asks for it with a request
// file and reads its name from WCU_BACKGROUND_FILE. A server started on its own
// owns one itself, which closes when the server exits. A server that already
// runs on a hidden desktop (WCU_BACKGROUND_DESKTOP) uses no second one.
const hiddenDesktopSupported = process.platform === 'win32' && !IN_WSL && !backgroundDesktop;
let ownedHiddenDesktop, hiddenStarting;
function readHiddenDesktop() {
  try { return JSON.parse(readFileSync(process.env.WCU_BACKGROUND_FILE, 'utf8')); } catch { return null; }
}
function hiddenDesktopKnown() {
  if (!hiddenDesktopSupported) return false;
  if (backends.background || ownedHiddenDesktop) return true;
  return !!(process.env.WCU_BACKGROUND_FILE && readHiddenDesktop()?.name);
}
async function hiddenDesktopName(request) {
  if (!process.env.WCU_BACKGROUND_FILE) {
    ownedHiddenDesktop ??= startBackgroundDesktop(() => { ownedHiddenDesktop = undefined; });
    const owner = ownedHiddenDesktop;
    try { await owner.ready; }
    catch (error) { if (ownedHiddenDesktop === owner) ownedHiddenDesktop = undefined; throw error; }
    return owner.name;
  }
  let state = readHiddenDesktop();
  if (state?.name) return state.name;
  const requested = Date.now();
  await writeFile(backgroundRequestFile(process.env.WCU_BACKGROUND_FILE), JSON.stringify({ at: requested }));
  while (Date.now() - requested < 20000) {
    if (request?.cancelled) throw new Error(request.stoppedByUser ? STOPPED : 'COMPUTER_USE_CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 150));
    state = readHiddenDesktop();
    if (state?.name) return state.name;
    if (state?.error && state.at >= requested) throw new Error(String(state.error));
  }
  throw new Error('WCU_BACKGROUND_DESKTOP_UNAVAILABLE: DSH did not open its hidden desktop within 20 s.');
}
async function ensureHiddenBackend(request) {
  if (!hiddenDesktopSupported) throw new Error('WCU_BACKGROUND_DESKTOP_UNAVAILABLE: the hidden desktop needs a native Windows DSH host.');
  const live = backends.background;
  if (live && retiringBackends.has(live)) throw new Error("COMPUTER_USE_STOPPING");
  if (live && live.exitCode === null) return live;
  hiddenStarting ??= hiddenDesktopName(request).then(name => spawnBackend('background', name)).finally(() => { hiddenStarting = undefined; });
  return hiddenStarting;
}

// The user's work mode, read live from settings: quiet (Low disruption, the
// default) or fast (Foreground). Inside a Hyper-V guest the whole machine is
// DSH's, so it works as Foreground there. A server started without DSH's
// settings keeps the behaviour of earlier versions (direct): the foreground
// as the agent asks, no wait for the user, apps on the user's desktop.
const startupSettings = (() => { try { return JSON.parse(process.env.WCU_SETTINGS_JSON || '{}'); } catch { return {}; } })();
const modeFromSettings = Boolean(process.env.WCU_CONFIG_FILE) || Object.hasOwn(startupSettings, 'desktopTarget');
function workMode() {
  if (['quiet', 'fast', 'direct'].includes(process.env.WCU_WORK_MODE)) return process.env.WCU_WORK_MODE;
  if (!modeFromSettings) return 'direct';
  return ['fast', 'hyperv'].includes(takeover.config.desktopTarget) ? 'fast' : 'quiet';
}
// On the user's desktop, Low disruption never keeps a window in front
// (activate_window excepted) and Foreground keeps the one it works in there.
const FAST_FRONT = new Set(['click', 'double_click', 'move', 'drag', 'scroll', 'type_text', 'keypress', 'focus', 'invoke', 'set_value', 'launch_app']);
function modeArgs(action, args, mode) {
  if (mode === 'quiet' && args.activate && action !== 'activate_window') return { ...args, activate: false };
  if (mode === 'fast' && !args.activate && FAST_FRONT.has(action) && !isBrowserCall(args)) return { ...args, activate: true };
  return args;
}
// Low disruption borrows the pointer and keyboard for a step right away, also
// while the user works: the backend holds the user's own input during the step
// and replays it to their window afterwards (WcuInputHold). It waits only
// while borrowing would break what the user is doing: a key or mouse button
// held down, input-method text not committed yet (pinyin), or a full-screen
// app or presentation in front.
const testLimit = name => process.env.NODE_ENV === 'test' && Number(process.env[name]);
const HELD_LIMIT_MS = testLimit('WCU_TEST_HELD_LIMIT_MS') || 10000;
const FULLSCREEN_LIMIT_MS = testLimit('WCU_TEST_FULLSCREEN_LIMIT_MS') || 20000;
const COMPOSING_LIMIT_MS = 5000;
const BORROW_ACTIONS = new Set(['click', 'double_click', 'move', 'drag', 'scroll', 'type_text', 'keypress', 'focus', 'invoke', 'set_value', 'activate_window', 'launch_app']);
async function waitForSafeMoment(request, args = {}) {
  const started = Date.now();
  for (;;) {
    if (request?.cancelled) throw new Error(request.stoppedByUser ? STOPPED : 'COMPUTER_USE_CANCELLED');
    let state;
    try { state = await dispatchBackend('input_state', {}, 5000, undefined, 'current'); }
    catch { return Date.now() - started; }
    const target = Number(args.nativeWindowHandle);
    const fullscreen = state?.fullscreen === true && !(Number.isFinite(target) && target === state.foreground);
    const held = state?.held === true;
    const composing = !held && !fullscreen && await takeover.composing() === true;
    const waited = Date.now() - started;
    if (!held && !fullscreen && !composing) return waited;
    if (held && waited >= HELD_LIMIT_MS) throw new Error(`WCU_USER_INPUT_HELD: The user has held a key or mouse button for ${HELD_LIMIT_MS / 1000} s, so nothing was sent. Try again in a moment, or use an element action, which needs neither.`);
    if (fullscreen && waited >= FULLSCREEN_LIMIT_MS) throw new Error('WCU_USER_FULLSCREEN: The user is in a full-screen app or presenting, so DSH did not borrow the mouse and keyboard and nothing was sent. Element actions still work; try real input again later.');
    if (composing && waited >= COMPOSING_LIMIT_MS) return waited;
    await new Promise(resolve => setTimeout(resolve, fullscreen ? 500 : 60));
  }
}

// Which backend a call goes to: the hidden desktop's when its window is there,
// by that desktop's own window list (at most a second old). Without a window
// target a call follows the window this series last worked in.
const HIDDEN_FREE = new Set(['health', 'list_windows', 'wait']);
let hiddenList = { at: 0, windows: [] }, lastWindow = null;
async function hiddenWindows() {
  if (Date.now() - hiddenList.at < 1000) return hiddenList.windows;
  const listed = await dispatchBackend('list_windows', { includeInvisible: true, maxWindows: 200, _wcuQuiet: true, _wcuImageData: false }, 10000, undefined, 'background');
  hiddenList = { at: Date.now(), windows: listed.windows ?? [] };
  return hiddenList.windows;
}
const hasWindowTarget = args => args.nativeWindowHandle != null || args.processId != null || !!args.windowTitle?.trim();
function followsHidden() {
  return lastWindow?.desk === 'background' && lastWindow.handle != null && lastWindow.series === takeover.seriesKey;
}
async function deskFor(action, args) {
  if (!hiddenDesktopSupported || HIDDEN_FREE.has(action) || isBrowserCall(args) || args.scope === 'desktop' || !hiddenDesktopKnown()) return 'current';
  if (!hasWindowTarget(args)) return followsHidden() ? 'background' : 'current';
  const windows = await hiddenWindows();
  const title = args.windowTitle?.trim().toLowerCase();
  return windows.some(window => args.nativeWindowHandle != null ? window.nativeWindowHandle === args.nativeWindowHandle
    : args.processId != null ? window.processId === args.processId
    : String(window.name ?? '').toLowerCase().includes(title)) ? 'background' : 'current';
}
function rememberWindow(desk, handle) { lastWindow = { desk, handle: handle ?? null, series: takeover.seriesKey }; }

let takeoverSetup = Promise.resolve();
// Element actions start in the background, with no indicator and no Esc stop.
// One that needs the real pointer or keyboard says so before sending any
// (WCU_NEEDS_INPUT) and runs again with both.
// A window on a hidden desktop takes UI Automation and window messages only:
// Windows delivers real pointer and keyboard input to the desktop on screen.
const HIDDEN_LIMIT = backgroundDesktop
  ? 'WCU_BACKGROUND_DESKTOP_LIMIT: This desktop takes UI Automation and window-message actions only. Real pointer and keyboard input and full-screen capture need the user\'s desktop.'
  : 'WCU_BACKGROUND_DESKTOP_LIMIT: This window is on DSH\'s hidden desktop, which takes UI Automation and window-message actions only (element ids, set_value, invoke, type_text, dispatch:"background", window screenshots). Real pointer and keyboard input and full-screen capture cannot reach it; for those, close the app and launch it again with desktop:"current".';
async function runBackend(action, args = {}, timeoutMs = 30000, request) { return runBackendOn(undefined, action, args, timeoutMs, request); }
// runBackend with the desktop chosen by the caller (else by deskFor).
async function runBackendOn(desk, action, args = {}, timeoutMs = 30000, request) {
  desk ??= await deskFor(action, args);
  if (desk === 'background' && !hasWindowTarget(args) && !HIDDEN_FREE.has(action) && action !== 'launch_app' && followsHidden()) args = { ...args, nativeWindowHandle: lastWindow.handle };
  if (desk === 'current' && !backgroundDesktop) args = modeArgs(action, args, workMode());
  const quiet = isQuietCall(action, args);
  if (backgroundDesktop || desk === 'background') {
    if (args.activate || args.scope === 'desktop' || (!quiet && !['launch_app','close_window','move_window'].includes(action))) throw new Error(HIDDEN_LIMIT);
    if (['tree','find','snapshot','screenshot','ocr','element_info','wait_for','close_window','move_window'].includes(action) && !hasWindowTarget(args)) {
      throw new Error('WCU_BACKGROUND_DESKTOP_TARGET_REQUIRED: list_windows can find a window on this desktop. Pass its nativeWindowHandle.');
    }
    const backgroundArgs = action==='ocr' ? { ...args, resolveControl:false } : args;
    try {
      const result = await runBackendOnce(action, { ...backgroundArgs, _wcuQuiet: true }, timeoutMs, request, true, desk);
      if (!backgroundDesktop && args.nativeWindowHandle != null) rememberWindow('background', args.nativeWindowHandle);
      return result;
    } catch (error) {
      if (!/^WCU_NEEDS_INPUT\b/.test(error.message)) throw error;
      throw new Error(HIDDEN_LIMIT);
    }
  }
  if (hasWindowTarget(args) && !HIDDEN_FREE.has(action)) rememberWindow('current', args.nativeWindowHandle);
  const mayUpgrade = BACKGROUND_FIRST.has(action) || (action === 'click' && (args.dispatch ?? 'auto') === 'auto' && args.elementId != null);
  if (quiet && mayUpgrade) {
    try { return await runBackendOnce(action, { ...args, _wcuQuiet: true }, timeoutMs, request, true); }
    catch (error) { if (!/^WCU_NEEDS_INPUT\b/.test(error.message) || request?.cancelled) throw error; }
    return runBackendOnce(action, args, timeoutMs, request, false);
  }
  return runBackendOnce(action, { ...args, _wcuQuiet: quiet }, timeoutMs, request, quiet);
}

async function runBackendOnce(action, args, timeoutMs, request, quiet, desk = 'current') {
  const changesDesktop = action!=='health';
  const lowDisruption = desk === 'current' && !backgroundDesktop && workMode() === 'quiet';
  if (request) request.requiresInput = !quiet;
  let acquired = false, capturing = false, waitedForUser = 0;
  // Reserve preparation in arrival order. Otherwise awaiting the native
  // indicator can let a later observation reach the backend before its input.
  const prepared = takeoverSetup.then(async () => {
    if (request?.cancelled) throw new Error(request.stoppedByUser ? STOPPED : 'COMPUTER_USE_CANCELLED');
    if (!quiet && lowDisruption && BORROW_ACTIONS.has(action)) waitedForUser = await waitForSafeMoment(request, args);
    if (changesDesktop) { await takeover.begin({ quiet }); acquired = true; }
    if(takeover.child && (['screenshot','ocr'].includes(action) || (action==='snapshot' && args.includeScreenshot!==false) || (action==='wait_for' && args.condition==='text'))) {
      try { await takeover.command('capture_begin');capturing=true; }
      catch (error) { takeover.presentationError(error); }
    }
  });
  takeoverSetup = prepared.catch(() => {});
  try {
    await prepared;
    if (request?.cancelled) throw new Error(request.stoppedByUser ? STOPPED : 'COMPUTER_USE_CANCELLED');
    // The series lets typing without a window target follow the window the
    // series last gave input to, after the user got the foreground back.
    const result = await dispatchBackend(action, { ...args, _wcuImageData: args._wcuImageData ?? (process.env.WCU_IMAGE_MODE !== 'file'), _wcuCornerFailsafe: false, _wcuTakeoverPid: takeover.helperProcessId, _wcuSeries: takeover.seriesKey ?? null, ...(lowDisruption ? { _wcuLowDisruption: true } : {}) }, timeoutMs, request, desk);
    if (waitedForUser >= 500 && result && typeof result === 'object') result.waitedForUserMs = waitedForUser;
    return result;
  } finally {
    if(capturing&&takeover.child)await takeover.command('capture_end').catch(error=>takeover.presentationError(error));
    if (acquired) await takeover.end({ quiet });
    if (request) request.requiresInput = false;
  }
}

async function dispatchBackend(action, args = {}, timeoutMs = 30000, request, desk = 'current') {
  if (Number.isFinite(request?.deadlineMs)) {
    const remaining = request.deadlineMs - Date.now();
    if (remaining <= 0) throw new Error(`Windows Computer Use backend timed out after batch wall-clock budget during ${action}`);
    timeoutMs = Math.max(250, Math.min(timeoutMs, remaining));
  }
  const proc = desk === 'background' ? await ensureHiddenBackend(request) : ensureBackend();
  if (request) request.proc = proc;
  const id = ++backendNextId;
  return new Promise((resolve, reject) => {
    const onTimeout = () => {
      if (!backendWaiters.has(id)) return;
      backendWaiters.delete(id);
      const targetHint = ['snapshot', 'tree', 'find', 'element_info', 'type_text', 'focus', 'invoke', 'set_value', 'activate_window'].includes(action)
        ? '. Target responsiveness is unknown; the target may also be unresponsive. Avoid immediately retrying tree/input calls; check the window with list_windows and prefer screenshot/ocr after it recovers.' : '';
      const error = new Error(`Windows Computer Use backend timed out after ${timeoutMs}ms during ${action}${targetHint}`);
      error.backendTimeout = true;
      reject(error);
      // The wedged call may have stalled the backend loop: kill it and
      // respawn lazily on the next call.
      killBackend(new Error("Backend stopped after another action timed out"), proc);
    };
    backendWaiters.set(id, { resolve, reject, timer: null, onTimeout, timeoutMs, proc, request, action, args, sent: false });
    dispatchNextBackend(proc);
  });
}

function validateActionArguments(actionName, args) {
  const browser = isBrowserCall(args);
  // A browser tab alone names the page, which is what scroll needs.
  if (["click", "double_click", "move", "scroll", "element_info"].includes(actionName) && !args.elementId && (args.x === undefined || args.y === undefined) && !(browser && actionName === "scroll")) throw new Error("INVALID_ARGUMENTS: provide elementId or both x and y");
  if (actionName === "wait_for") {
    if (args.condition === "window" && !browser && !args.windowTitle?.trim() && !args.processId && !args.nativeWindowHandle) throw new Error("INVALID_ARGUMENTS: window wait requires a target");
    if (args.condition !== "window" && !args.query?.trim()) throw new Error("INVALID_ARGUMENTS: text/element wait requires query");
  }
  if (actionName === 'keypress') {
    if(args.thenKeys&&(browser||args.dispatch==='background'))throw Error('INVALID_ARGUMENTS: thenKeys requires desktop foreground dispatch');
    for(const keys of [args.keys,...(args.thenKeys??[])])if(keys.filter(key=>!/^(ctrl|control|alt|option|shift)$/i.test(key)).length!==1)throw Error('INVALID_ARGUMENTS: keypress needs exactly one non-modifier key per chord');
  }
}

const nativeTargetKeys = ['windowTitle', 'processId', 'nativeWindowHandle'];
function validateTargetArgs(args) {
  const browser = isBrowserCall(args);
  const nativeKeys = nativeTargetKeys.filter(key => args[key] !== undefined);
  const opener = NEW_TAB.exec(args.elementId ?? '');
  if (typeof args.elementId === 'string' && args.elementId.endsWith(':new-tab') && !opener)
    throw new Error('INVALID_ARGUMENTS: use set_value with elementId "new-tab" and value "<url>" to start the DSH browser. A prefixed new-tab requires an actual connected browser id from list_windows.');
  if (args.browserTab === 'desktop') {
    if (browser) throw new Error('INVALID_ARGUMENTS: desktop fallback cannot use page element ids. Use a fresh desktop snapshot with the Windows target first.');
    if (!args.windowTitle?.trim() && !args.processId && !args.nativeWindowHandle)
      throw new Error('INVALID_ARGUMENTS: browserTab "desktop" requires a Windows target from list_windows (nativeWindowHandle, processId or windowTitle).');
    const { browserTab, ...target } = args;
    return target;
  }
  if (opener && (nativeKeys.length || args.browserTab !== undefined))
    throw new Error('INVALID_ARGUMENTS: opening a browser tab uses only set_value elementId and value. Use elementId "new-tab" for the DSH browser. Omit browserTab, windowTitle, processId and nativeWindowHandle.');
  if (browser && nativeKeys.length)
    throw new Error(`INVALID_ARGUMENTS: mixed browser and Windows targets (${nativeKeys.join(', ')}). For a page use its browserTab or page element id alone. For desktop fallback keep the Windows target, omit browserTab and use fresh desktop element ids or coordinates.`);
  if (args.browserTab !== undefined && !args.browserTab.trim())
    throw new Error('INVALID_ARGUMENTS: browserTab is empty. Use an actual tab id for a page, or omit browserTab for a Windows window.');
  return args;
}

async function callTool(name, args, request) {
  if (typeof name !== 'string') throw new Error('INVALID_ARGUMENTS: tool name must be a string');
  if (batchOwner && batchOwner !== request) throw new Error('COMPUTER_USE_BUSY: A batch is in progress; wait for its result.');
  if (!allowedTools.has(name) && TOOL_NAMES.includes(name.slice(prefix.length))) throw new Error('TOOL_DISABLED_IN_SETTINGS: This tool is disabled by the user in Settings > Computer Use (设置 > 电脑操控 in the Chinese interface).');
  if (name === discoveryName) return manageTools(args);
  const definition = toolByName.get(name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS: arguments must be an object');
  const suppliedApproval = args._wcuApproval;
  if (suppliedApproval !== undefined) {
    const {_wcuApproval, ...plain} = args;
    args = plain;
    if(process.env.WCU_APPROVAL_SECRET&&!process.env.WCU_APPROVAL_LEDGER)throw Error('WCU_APPROVAL_STATE_UNAVAILABLE: host approval registry is missing; no action was executed.');
    if (!consumeGrant(suppliedApproval, name, args, process.env.WCU_APPROVAL_SECRET, usedApprovalGrants,Date.now(),process.env.WCU_APPROVAL_LEDGER)) throw Error('WCU_POLICY_DENIED: invalid, expired or already used approval grant.');
    if (request) request.approvalGrants = collectApprovalRequirements(name, args, process.env);
  }
  assertOperation(name, args, { env: process.env, grants: request?.approvalGrants });
  if (!batchPrevalidated.has(args)) args = validateArguments(definition.inputSchema, args);
  args = validateTargetArgs(args);
  if (name === 'windows_computer_use_batch') return runBatch(args, request);
  const actionName = name.replace("windows_computer_use_", "");
  const browser = isBrowserCall(args);
  validateActionArguments(actionName, args);
  if (browser) return runBrowser(actionName === "accessibility_tree" ? "tree" : actionName, args, request);
  switch (name) {
    case "windows_computer_use_launch_app": {
      const launchKey = `${String(args.target ?? '').trim().toLowerCase()}\0${String(args.arguments ?? '').trim()}`;
      const launchApproved = request?.approvalGrants?.launches?.has(launchKey) === true || process.env.WCU_ALLOW_LAUNCH_ARGUMENTS === '1' || String(process.env.WCU_ALLOWED_LAUNCH_PROGRAMS??'').split('|').some(target=>target.trim().toLowerCase()===args.target.toLowerCase());
      return launchApp({...args, _wcuLaunchApproved: launchApproved}, request);
    }
    case "windows_computer_use_health": {
      const result = await runBackend("health", args, undefined, request);
      result.workMode = workMode();
      result.browserLane = await browserLane.health();
      if (adapterNotices) result.adapterNotices = adapterNotices;
      return { content: [{ type: "text", text: safeJson(result) }] };
    }
    case "windows_computer_use_snapshot": {
      const result = await shapeTree(await observeBackend("snapshot", backendTreeArgs(args), request), args);
      return imageResult(result, args.includeScreenshot ?? true);
    }
    case "windows_computer_use_accessibility_tree":
      return observationText("tree", args, request);
    case "windows_computer_use_list_windows": {
      const result = await runBackend("list_windows", args, undefined, request);
      // Windows on DSH's hidden desktop follow the user's, marked as such.
      if (hiddenDesktopKnown()) {
        try {
          const hidden = await runBackendOn('background', "list_windows", args, undefined, request);
          const windows = (hidden.windows ?? []).map(window => ({ ...window, desktop: 'background' }));
          result.windows = [...(result.windows ?? []), ...windows];
          if (windows.length) result.hiddenDesktop = 'Windows marked desktop:"background" are on DSH\'s hidden desktop, apart from the user\'s screen. Target them by nativeWindowHandle; they take UI Automation and window-message actions, not real pointer or keyboard input.';
        } catch (error) { result.hiddenDesktopError = error.message; }
      }
      try { await browserLane.annotateWindows(result); } catch (error) { result.browserLane = { error: error.message }; }
      return { content: [{ type: "text", text: safeJson(result) }] };
    }
    case "windows_computer_use_find":
      return observationText("find", args, request);
    case "windows_computer_use_element_info":
      return backendText("element_info", args, undefined, request);
    case "windows_computer_use_click":
      return backendText("click", args, undefined, request);
    case "windows_computer_use_double_click":
      return backendText("double_click", args, undefined, request);
    case "windows_computer_use_move":
      return backendText("move", args, undefined, request);
    case "windows_computer_use_drag":
      return backendText("drag", args, undefined, request);
    case "windows_computer_use_scroll":
      return backendText("scroll", args, undefined, request);
    case "windows_computer_use_type_text":
      return backendText("type_text", args, undefined, request);
    case "windows_computer_use_keypress":
      return backendText("keypress", args, undefined, request);
    case "windows_computer_use_focus":
      return backendText("focus", args, undefined, request);
    case "windows_computer_use_invoke":
      return backendText("invoke", args, undefined, request);
    case "windows_computer_use_set_value":
      return backendText("set_value", args, undefined, request);
    case "windows_computer_use_activate_window":
      return backendText("activate_window", args, undefined, request);
    case "windows_computer_use_wait":
      return backendText("wait", args, Math.max(31000, Number(args?.milliseconds || 500) + 1000), request);
    case "windows_computer_use_ocr": {
      const result = await runBackend("ocr", args, 20000, request);
      if (!args.maxBytes) return imageResult(result);
      const { screenshot, ...rest } = result;
      const shaped = await budgetOcr(rest, args.maxBytes);
      return imageResult(screenshot ? { ...shaped, screenshot } : shaped, true, args.maxBytes);
    }
    case "windows_computer_use_screenshot":
      return imageResult(await runBackend("screenshot", args, 15000, request));
    case "windows_computer_use_wait_for":
      return backendText("wait_for", args, Math.max(31000, Number(args?.timeoutMs || 5000) + 2000), request);
    case "windows_computer_use_close_window":
      return backendText("close_window", args, undefined, request);
    case "windows_computer_use_move_window":
      return backendText("move_window", args, undefined, request);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function imageResult(result, includeImage = true, maxBytes) {
  if (IN_WSL) for (const item of [result, result.ocr]) if (typeof item?.image === 'string') item.image = linuxPath(item.image);
  const image = await screenshotOutput(result.screenshot, includeImage);
  let metadata = result.screenshot ? { ...result, screenshot: image.metadata } : result;
  if (maxBytes && metadata.ok !== false && bytesOf(metadata) > maxBytes) {
    const file = metadata.budget?.fullResultPath ?? await spill(metadata);
    treeDeltas.markTruncated(metadata.treeId);
    metadata = observationFileResult(metadata, maxBytes, file);
  }
  const content = [{ type: "text", text: safeJson(metadata) }, ...image.content];
  return { content, ...(result.ok === false ? { isError: true } : {}) };
}

async function observeBackend(action, args, request) {
  let result;
  try {
    // Allows cold startup and capture overhead while bounding a wedged provider.
    result = await runBackend(action, args, args.treeTimeoutMs + 10000, request);
  } catch (error) {
    if (!error.backendTimeout || request?.cancelled) throw error;
    // Never replay a timed-out input action. Only capture a fresh native image;
    // retain explicit failure so callers cannot mistake it for a successful tree.
    result = { ok: false, action, source: "uia", truncated: true, truncationReason: "backendTimeout", warning: error.message };
    if (action !== "snapshot" || args.includeScreenshot) {
      try {
        const shot = await runBackend("screenshot", { ...args, activate: false }, 15000, request);
        result.screenshot = shot.screenshot;
      } catch (captureError) { result.captureError = captureError.message; }
    }
    return result;
  }
  result.source = "uia";
  // Browser window chrome can itself expose ~10 nodes without any app content.
  // This is a fallback heuristic, not proof that the app is inaccessible.
  const sparse = (result.nodeCount ?? result.scannedNodes) <= 20;
  if (sparse || result.truncated) result.hint = "UIA is sparse or incomplete. Use OCR text/coordinates or screenshot vision; literal 'search' may miss a placeholder. Inspect visible text before choosing a coordinate.";
  // A Chromium page whose accessibility tree has not arrived is not an app
  // without accessibility: say whether observing again can still help.
  const web = result.webContent;
  if (web && web.ready === 0) result.hint = web.state === "unavailable"
    ? "This Chromium window exposes no page content to UI Automation. Use OCR text/coordinates or screenshot vision."
    : "Chromium is still building this page's accessibility tree. Observe the window again shortly before falling back to OCR coordinates.";
  // An attached page tree with no text in it is usually a page that has not put
  // its content into the DOM yet, not a page without content: measured on Edge
  // 157, such a page has 0 characters and the same all-white frame as
  // about:blank, and more time, not a reload, is what fills it in. But a page
  // drawn entirely by canvas or images carries no text either and is perfectly
  // healthy, so this must not send every textless page to a reload: a reload can
  // discard the page's state. Say what to do only as far as the result allows.
  else if (web && web.contentState === "empty") {
    const empty = "This Chromium page's accessibility tree is attached but it carries no text yet. An empty read is not a sign-in problem: do not report signed-out, or a broken page, from this result alone. ";
    const wait = "Wait about 3 seconds and observe again, and again up to about 10 seconds in total. A reload is the last resort, because it restarts the page's render timer and can discard the page's own state.";
    if (result.screenshot) {
      result.hint = empty
        + "Check the screenshot first. If it shows content, the page paints without text (canvas or images): use OCR text/coordinates or screenshot vision, and do not reload. "
        + "If the screenshot is blank too, " + wait;
    } else if (!result.hint) {
      result.hint = empty
        + "Read the window again shortly; a page drawn by canvas or images looks like this and is not broken, so prefer OCR or a screenshot over a reload. "
        + "If it is still empty, " + wait;
    }
  }
  if (action === "find" && args.ocrFallback && result.results?.length === 0 && (sparse || result.truncated) && result.targetResponsive !== false && !request?.cancelled) {
    if (args.controlType) {
      result.ocrSkipped = "controlType";
      result.hint = "OCR fallback was skipped because controlType requires a UI Automation type. Remove controlType to search visible text, or use OCR separately.";
      return result;
    }
    try {
      const ocr = await runBackend("ocr", { ...args, resolveControl: false, maxWidth: 0 }, 20000, request);
      result.ocr = ocr;
      result.results = (ocr.matched || []).map(hit => ({ source: "ocr", name: hit.word.text, boundingBox: hit.boundingBox, x: hit.word.x, y: hit.word.y }));
      result.source = "uia+ocr";
      result.hint = result.results.length
        ? "OCR fallback found visible text. The matches contain screen coordinates; check the target before acting."
        : "OCR fallback found no literal match. Inspect ocr.lines for the visible text or check a screenshot.";
      if (ocr.warning) result.hint += " " + ocr.warning;
    } catch (error) {
      if (request?.cancelled) throw error;
      result.ocrError = error.message;
      result.hint = "OCR fallback failed. Inspect ocrError or check a screenshot.";
    }
  }
  return result;
}

// detailLevel summary is read as compact and reduced here; a delta or a byte
// budget applies to the result as read.
const treeDeltas = new TreeDeltas();
const backendTreeArgs = args => args.detailLevel === 'summary' ? { ...args, detailLevel: 'compact' } : args;
async function shapeTree(result, args) {
  if (!result?.tree) return result;
  if (args.detailLevel === 'summary') result = { ...result, tree: summarizeTree(result.tree), detailLevel: 'summary' };
  const full = result;
  if (args.treeDeltaBase) {
    const key = JSON.stringify([result.scope, result.tree.nativeWindowHandle ?? result.tree.id, result.viewMode, result.includeOffscreen, result.detailLevel, args.maxDepth]);
    result = treeDeltas.apply(args.treeDeltaBase, key, result);
  }
  // An inline screenshot travels as an image block, not as text: the budget
  // and the saved copy leave it out.
  if (args.maxBytes) {
    const { screenshot, ...rest } = result;
    let shaped = rest;
    if (!rest.tree && bytesOf(rest) > args.maxBytes) {
      const { screenshot: _image, ...fullTree } = full;
      shaped = { ...fullTree, treeId:rest.treeId, delta:{ base:rest.delta.base, fallback:'maxBytes' } };
    }
    result = await budgetTree(shaped, args.maxBytes);
    if (result.budget) treeDeltas.markTruncated(result.treeId);
    if (screenshot) result.screenshot = screenshot;
  }
  return result;
}
async function observationText(action, args, request) {
  return imageResult(await shapeTree(await observeBackend(action, backendTreeArgs(args), request), args), true, args.maxBytes);
}

let batchOwner = null;
const batchPrevalidated = new WeakSet();
// Editors mark unsaved changes in the title ("*name - Notepad", "● name - Code"),
// so typing that adds or clears such a mark is not navigation.
const withoutUnsavedMark = title => String(title ?? '').replace(/^\s*[*●•]+\s*|\s*[*●•]+\s*$/g, '').replace(/\s[*●•](?=\s)/g, '');
const textData = result => { try { return JSON.parse(result.content?.find(part => part.type === 'text')?.text); } catch { return null; } };
async function runBatch(args, request) {
  if (batchOwner || pendingToolCalls.size > 1) throw new Error('COMPUTER_USE_BUSY: Wait for the active computer-use call before starting a batch.');
  const target = Object.fromEntries(['browserTab','windowTitle','processId','nativeWindowHandle','activate'].filter(key => args[key] !== undefined).map(key => [key,args[key]]));
  if (!target.browserTab && !target.windowTitle && !target.processId && !target.nativeWindowHandle) throw new Error('INVALID_ARGUMENTS: batch needs one explicit window target or browserTab.');
  if (target.browserTab && ['windowTitle','processId','nativeWindowHandle'].some(key => target[key] !== undefined)) throw new Error('INVALID_ARGUMENTS: do not mix desktop and page targets.');
  // Validate the entire plan before its first read or action. A batch never
  // grants permission to an action disabled in settings.
  const plan = args.steps.map((step,index) => {
    const name = prefix + step.action;
    if (!allowedTools.has(name)) throw new Error(`TOOL_DISABLED_IN_SETTINGS: batch step ${index + 1} (${step.action}).`);
    for (const key of ['browserTab',...nativeTargetKeys]) {
      const stepTarget = key === 'browserTab' && step.arguments[key] === 'desktop' && !target.browserTab ? undefined : step.arguments[key];
      if (stepTarget !== undefined && stepTarget !== target[key]) throw new Error('INVALID_ARGUMENTS: all batch steps must keep the same target.');
    }
    const elementId=step.arguments.elementId ?? '';
    if (NEW_TAB.test(elementId) || USER_CONNECT.test(elementId)) throw new Error('INVALID_ARGUMENTS: open or connect a browser before batching.');
    if (target.browserTab && elementId && ELEMENT_ID.exec(elementId)?.[1] !== target.browserTab) throw new Error('INVALID_ARGUMENTS: batch element belongs to another tab.');
    if (!target.browserTab && isBrowserCall(step.arguments)) throw new Error('INVALID_ARGUMENTS: a desktop batch cannot contain page elements.');
    const definition = toolByName.get(name);
    // wait has no target properties, and never borrows the foreground.
    const inherited = Object.fromEntries(Object.entries(target).filter(([key]) => Object.hasOwn(definition.inputSchema.properties,key)));
    const combined = step.action === 'wait' ? { ...step.arguments } : { ...inherited, ...step.arguments };
    if (args.observationToken !== undefined && combined.observationToken === undefined &&
        Object.hasOwn(definition.inputSchema.properties,'observationToken')) combined.observationToken=args.observationToken;
    if (target.browserTab && !Object.hasOwn(definition.inputSchema.properties,'browserTab')) delete combined.browserTab;
    if (target.browserTab && step.action !== 'wait' && !isBrowserCall(combined)) throw new Error('INVALID_ARGUMENTS: this browser batch action needs a page element ID; page coordinates cannot become desktop input.');
    const validated = validateTargetArgs(validateArguments(definition.inputSchema, combined));
    validateActionArguments(step.action, validated);
    if (target.browserTab || step.action === 'wait') batchPrevalidated.add(validated);
    return { name, action: step.action, args: validated };
  });
  const envBudget = Number(process.env.WCU_BATCH_BUDGET_MS);
  const totalBudgetMs = Math.min(args.timeoutMs + 15000, Number.isFinite(envBudget) && envBudget > 0 ? envBudget : 75000);
  const steps = [], content = [], deadline = Date.now() + args.timeoutMs, batchDeadline = Date.now() + totalBudgetMs;
  if (request) request.deadlineMs = batchDeadline;
  let stopReason = 'completed', afterLastStep, message, before, nativeHandle, nativePid, lease = false;
  const targetDesk = target.browserTab ? 'current' : await deskFor('batch', target);
  batchOwner = request; request.batchSuppressObservation = true;
  const state = async () => {
    if (target.browserTab) return browserLane.batchState(target, request);
    // Shown windows only, as before minimized windows were listed: a minimized
    // twin must not make the target ambiguous or count as a new window.
    const listed = await runBackendOn(targetDesk, 'list_windows', { maxWindows: 200, includeMinimized: false }, 10000, request);
    const windows = listed.windows ?? [];
    let matches = windows.filter(window =>
      (!nativeHandle || String(window.nativeWindowHandle) === nativeHandle) &&
      (!target.nativeWindowHandle || String(window.nativeWindowHandle) === String(target.nativeWindowHandle)) &&
      (!target.processId || window.processId === target.processId));
    if (!nativeHandle && target.windowTitle) {
      const query=target.windowTitle.toLowerCase();
      const title=window=>String(window.name ?? window.title ?? '').toLowerCase();
      const exact=matches.filter(window=>title(window)===query);
      const start=matches.filter(window=>title(window).startsWith(query));
      matches=exact.length ? exact : start.length ? start : matches.filter(window=>title(window).includes(query));
    }
    // Once resolved the target is pinned to its HWND, so no match means it closed.
    if (nativeHandle && matches.length === 0) return { closed: true };
    if (matches.length !== 1) throw new Error('BATCH_TARGET_UNAVAILABLE: target is missing or ambiguous; specify its nativeWindowHandle.');
    const found = matches[0]; nativeHandle ??= String(found.nativeWindowHandle); nativePid ??= found.processId;
    if (found.processId !== nativePid) throw new Error('BATCH_TARGET_CHANGED: target process changed.');
    // The target may itself be a dialog; only another dialog of its process blocks it.
    return { title: withoutUnsavedMark(found.name ?? found.title), windows: windows.map(window => String(window.nativeWindowHandle)).sort(), dialog: windows.some(window => window.className === '#32770' && window.processId === nativePid && String(window.nativeWindowHandle) !== nativeHandle) };
  };
  try {
    await takeover.begin({ quiet: true }); lease = true;
    before = await state();
    if (before.dialog) stopReason = 'dialog';
    for (const [index,step] of plan.entries()) {
      if (stopReason !== 'completed') break;
      if (request.cancelled || userStopped()) { stopReason = 'cancelled'; break; }
      if (Date.now() >= Math.min(deadline, batchDeadline)) { stopReason = 'deadline'; break; }
      // Native actions stay pinned to the originally resolved HWND.
      if (!target.browserTab && step.action !== 'wait') step.args.nativeWindowHandle = Number(nativeHandle);
      let result;
      try { result = await callTool(step.name, step.args, request); }
      catch (error) { steps.push({ index: index + 1, action: step.action, ok: false, error: error.message }); stopReason = request.cancelled ? 'cancelled' : 'error'; break; }
      const data = textData(result);
      const summary = { index: index + 1, action: step.action, ok: result.isError !== true, verification: data?.verification ?? 'sent' };
      for (const key of ['dialog','openedTabs','fileChooser','stillLoading','tabClosed','warning']) if (data?.[key] !== undefined) summary[key] = data[key];
      if (result.isError) { summary.error = result.content?.[0]?.text; stopReason = 'error'; }
      steps.push(summary);
      if (result.isError) break;
      if (request.cancelled || userStopped()) { stopReason = 'cancelled'; break; }
      if (data?.verification === 'unconfirmed' || data?.verified === false) { stopReason = 'unconfirmed'; break; }
      // What the action changed. Before another action this stops the plan; a
      // change caused by the last action (a submit that navigates, a confirm
      // dialog, a closed window) completes the plan and is reported with it.
      let change;
      if (data?.dialog || data?.fileChooser) change = 'dialog';
      else if (data?.openedTabs?.length) change = 'newWindow';
      else if (data?.tabClosed) change = 'targetClosed';
      else {
        const after = await state();
        if (after.closed) change = 'targetClosed';
        else if (after.dialog) change = 'dialog';
        else if (after.windows.some(id => !before.windows.includes(id))) change = 'newWindow';
        else if (after.url !== before.url || after.document !== before.document || after.load !== before.load || after.title !== before.title || data?.stillLoading) change = 'navigation';
        if (!after.closed) before = after;
      }
      if (change) { if (index === plan.length - 1) afterLastStep = change; else stopReason = change; break; }
    }
  } catch (error) { stopReason = request.cancelled ? 'cancelled' : 'error'; message = error.message; }
  finally { request.batchSuppressObservation = false; }
  try {
    const closed = stopReason === 'targetClosed' || afterLastStep === 'targetClosed';
    if (closed) content.push({ type: 'text', text: 'Final observation skipped: the target closed.' });
    else if (batchDeadline - Date.now() < 8000) content.push({ type: 'text', text: 'Final observation skipped: batch wall-clock budget reached.' });
    else if (before && !request.cancelled && !userStopped()) {
      const observer = allowedTools.has(prefix + 'accessibility_tree') ? 'accessibility_tree' : allowedTools.has(prefix + 'screenshot') ? 'screenshot' : null;
      if (observer) {
        const previousDeadline = request.deadlineMs;
        request.deadlineMs = batchDeadline;
        try {
          const final = await callTool(prefix + observer, target.browserTab ? { browserTab: target.browserTab } : { ...target, nativeWindowHandle: Number(nativeHandle), activate: false }, request);
          content.push({ type: 'text', text: 'Final observation:' }, ...final.content);
        } catch (error) { content.push({ type: 'text', text: 'Final observation unavailable: ' + error.message }); }
        finally { request.deadlineMs = previousDeadline; }
      }
    }
    const result = { content: [{ type: 'text', text: safeJson({ ok: stopReason === 'completed', action: 'batch', planned: plan.length, completed: steps.filter(step => step.ok).length, stopReason, ...(afterLastStep ? { afterLastStep } : {}), steps, ...(message ? { message } : {}) }) }, ...content], ...(stopReason !== 'completed' ? { isError: true } : {}) };
    request.batchResult = true;
    return result;
  } finally { try { if (lease) await takeover.end({ quiet: true }); } finally { batchOwner = null; } }
}

const inputActions = INPUT_ACTIONS;
// Under Low disruption an executable opens on DSH's hidden desktop. A shortcut,
// an installed or Store app, or a program that desktop cannot start opens on
// the user's desktop instead, not while the user holds a key or composes text,
// unless the agent chose the desktop.
async function launchApp(args, request) {
  const { desktop, ...plain } = args;
  const mode = workMode();
  if ((desktop ?? (mode === 'quiet' && hiddenDesktopSupported ? 'background' : 'current')) === 'background') {
    try {
      const result = await runBackendOn('background', 'launch_app', { ...plain, activate: false }, 30000, request);
      hiddenList.at = 0;
      const opened = result.observedNewWindows?.[0];
      if (opened) rememberWindow('background', opened.nativeWindowHandle);
      result.desktop = 'background';
      result.note = 'Opened on DSH\'s hidden desktop, apart from the user\'s screen, pointer and keyboard. Target its windows by nativeWindowHandle (list_windows marks them desktop:"background"); they take UI Automation and window-message actions only. An app that reused an instance already open on the user\'s desktop shows its window there instead.';
      return imageResult(result, false);
    } catch (error) {
      if (desktop || !/^WCU_BACKGROUND_DESKTOP_(?:LIMIT|UNAVAILABLE)\b/.test(error.message)) throw error;
    }
  }
  if (mode === 'quiet') await waitForSafeMoment(request, plain);
  return backendText('launch_app', plain, 30000, request, 'current');
}

async function backendText(action, args, timeoutMs, request, desk) {
  const result = desk ? await runBackendOn(desk, action, args, timeoutMs, request) : await runBackend(action, args, timeoutMs, request);
  if (inputActions.has(action)) {
    // Keys and text without a window target, before DSH has worked in any
    // window this turn, reach whatever window is in front (issue #82).
    const guessed = result.deliveredTo?.via === "front window";
    result.verification = guessed || result.moved === false || result.posted === false || result.activated === false ? "unconfirmed" : result.verification ?? "sent";
    result.verificationNote = guessed ? "No window target was given and DSH had not worked in a window this turn, so this went to the window in front (deliveredTo). If another window was meant, pass its nativeWindowHandle and check that window."
      : result.verification === "observed" ? result.note ?? "The focused edit contained the expected text after input."
      : result.verification === "sent" ? "The action was dispatched. Use wait_for or a fresh observation to verify the expected effect."
      : result.note ?? "Windows did not confirm dispatch. Inspect the warning and observe the target before retrying.";
  }
  return imageResult(result, false);
}

async function handleRequest(message) {
  if(!validateRpcEnvelope(message))return rpcError(null,-32600,'Invalid JSON-RPC request');
  const { id, method, params } = message;
  // Notifications are never tool calls and must never get a response.
  if(!Object.hasOwn(message,'id')&&!['notifications/initialized','notifications/cancelled'].includes(method))return null;
  if(Object.hasOwn(message,'id')&&method.startsWith('notifications/'))return rpcError(id,-32601,'Notifications do not take a request id.');
  if(Object.hasOwn(message,'id')&&params!==undefined&&(!params||typeof params!=='object'||Array.isArray(params)))return rpcError(id,-32602,'params must be an object');
  if (method === "notifications/initialized") return null;
  if (method === "notifications/cancelled") {
    const request = pendingToolCalls.get(params?.requestId);
    // Only this MCP process's own request and worker may be affected.
    if (request) cancelBackendRequest(request);
    return null;
  }
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
        capabilities: {
          tools: { listChanged: true },
          resources: {}
        },
        serverInfo: {
          name: "windows-computer-use",
          version: SERVER_VERSION
        },
        ...(serverInstructions === undefined ? {} : { instructions: serverInstructions })
      }
    };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: advertisedTools() } };
  }
  if (method === "tools/call") {
    if (pendingToolCalls.has(id)) return rpcError(id, -32600, 'Duplicate in-flight request id');
    const request = { proc: null };
    pendingToolCalls.set(id, request);
    try {
      const result = await callTool(params?.name, params?.arguments === undefined ? {} : params.arguments, request);
      if (request.cancelled && !request.batchResult) return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: request.takeoverError || "COMPUTER_USE_CANCELLED_AFTER_CURRENT_ACTION" }] } };
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: request.takeoverError || (error instanceof Error ? error.message : String(error)) }]
        }
      };
    } finally {
      if (pendingToolCalls.get(id) === request) pendingToolCalls.delete(id);
    }
  }
  if (method === "resources/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resources: wikiResources.map(({ uri, name, mimeType }) => ({ uri, name, mimeType }))
      }
    };
  }
  if (method === "resources/read") {
    const resource = wikiResources.find((item) => item.uri === params?.uri);
    if (!resource) {
      return rpcError(id, -32602, `Unknown resource: ${params?.uri}`);
    }
    const text = await readFile(resource.file, "utf8");
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }]
      }
    };
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const framer = new RpcFramer({
  onMessage: dispatch,
  onError: error=>send(rpcError(null,-32700,error.message))
});
function send(message) {
  if (!message) return;
  const payload=JSON.stringify(message);
  process.stdout.write(framer.mode==='headers'
    ? `Content-Length: ${Buffer.byteLength(payload,'utf8')}\r\n\r\n${payload}`
    : payload+'\n');
}
function ingest(chunk) { framer.push(chunk); }

function dispatch(message) {
  pendingRequests += 1;
  Promise.resolve(handleRequest(message))
    .then(send)
    .catch((error) => {
      const id = message && Object.hasOwn(message, "id") ? message.id : null;
      send(rpcError(id, -32603, error instanceof Error ? error.message : String(error)));
    })
    .finally(() => {
      pendingRequests -= 1;
      maybeExitAfterStdinEnd();
    });
}

