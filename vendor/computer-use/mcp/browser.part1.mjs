import {ELEMENT_ID,NEW_TAB,USER_CONNECT,isBrowserElementId,isBrowserCall,isQuietCall,BACKGROUND_FIRST} from './catalog.mjs';
export {isBrowserElementId,isBrowserCall,isQuietCall,BACKGROUND_FIRST} from './catalog.mjs';
import {readSafeValue} from './page-values.mjs';
import {BrowserFrames,sameFrameNode} from './browser-frames.mjs';
import {BrowserPipe} from './browser-pipe.mjs';
import {profileLock} from './browser-profile-lock.mjs';
import { assertBrowserUrl, assertUpload, canonicalizeBrowserUrl, canonicalFileUrl, isBlockedRuntimeRequestUrl, browserChildEnv as browserEnv } from './policy.mjs';
// Browser lane: Chromium pages over the Chrome DevTools Protocol (CDP).
// A page is read as an accessibility outline whose element ids act inside the
// page itself, so a tab can be read and operated in the background: no desktop
// pointer, no keyboard focus, no clipboard and no window activation.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
// The browser the lane runs is the one picked in settings, else the Windows
// default, always on a profile of its own: a throwaway one per launch or, with
// sign-ins kept, one kept profile per browser, in which the sites the user
// signed in to stay signed in. Experimental attachment to the user's existing
// browser is separate and requires approval plus browser consent.
const APPS = {
  chrome: { name: 'Google Chrome', exe: 'Google/Chrome/Application/chrome.exe' },
  edge: { name: 'Microsoft Edge', exe: 'Microsoft/Edge/Application/msedge.exe' }
};
// When the default browser is neither, Chrome comes first: Edge signs every
// new profile in with the Windows Microsoft account and sets that account's
// cookies; no switch, profile preference or profile directory turns this off
// (Edge 156). Throwaway-profile tabs never see them (they run in an isolated
// context); on a kept Edge profile, Microsoft's sites are signed in.
const FALLBACK_APPS = ['chrome', 'edge'];
// How long a server that ends waits for its kept-profile browser to close and
// save its cookies, which the browser otherwise writes out every 30 s.
const CLOSE_MS = 3000;
// The process id of the server that runs the browser of a kept profile.
const OWNER_FILE = 'dsh-server-pid';
const LEASE_PREFIX = 'dsh-client-';
// A process that runs under a Windows compatibility layer passes
// __COMPAT_LAYER on to every process it starts, and Edge relaunches itself
// without the layer: the first process exits 0 about 50 ms after the start,
// and the new one lacks the DevTools pipe, so every start of the DSH browser
// failed (issue #84, Edge 157). The browser starts without the variable, and
// the switch keeps Edge from relaunching for a layer applied any other way
// (Playwright passes the same switch); other browsers ignore it.
const NO_COMPAT_RELAUNCH = '--edge-skip-compat-layer-relaunch';
export { browserEnv };

function otherClients(browser, activeAfter = -Infinity) {
  if (!browser.kept) return [];
  const live = [];
  let files;
  try { files = readdirSync(browser.kept); } catch { return live; }
  for (const file of files) {
    if (!file.startsWith(LEASE_PREFIX)) continue;
    const pid = Number(file.slice(LEASE_PREFIX.length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const lease = path.join(browser.kept, file);
    try {
      if (!processAlive(pid)) rmSync(lease, { force: true });
      else if (readFileSync(lease, 'utf8') === browser.url && statSync(lease).mtimeMs >= activeAfter) live.push(pid);
    } catch { }
  }
  return live;
}

function joinProfile(browser, force = false) {
  const now = Date.now();
  if (!force && now - (browser._lastLeaseAt ?? 0) < 5000) return;
  browser._lastLeaseAt = now;
  const target = path.join(browser.kept, LEASE_PREFIX + process.pid), pending = `${target}-${randomBytes(6).toString('hex')}.pending`;
  writeFileSync(pending, browser.url);
  renameSync(pending, target);
}

// A kept browser must outlive its first client when other clients still use
// it. A detached, input-free watcher closes it gracefully if every MCP client
// dies, so crashes do not leave an unattended signed-in browser running.
async function watchProfile(profile, url, pid) {
  const browser = { kept: profile, url };
  let emptySince = null;
  while (processAlive(pid) && activePort(profile) === url) {
    if (otherClients(browser).length) emptySince = null;
    else emptySince ??= Date.now();
    if (emptySince && Date.now() - emptySince >= CLOSE_MS) {
      let closed = false;
      await profileLock(profile, async () => {
        if (otherClients(browser).length || activePort(profile) !== url) return;
        const cdp = await Cdp.open(url, CLOSE_MS);
        try { await cdp.send('Browser.close', {}, undefined, CLOSE_MS); closed = true; }
        finally { cdp.close(); }
      }).catch(() => { });
      if (closed) return;
    }
    await sleep(1000);
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.pending`;
  writeFileSync(pending, JSON.stringify(value));
  renameSync(pending, file);
}

function sendWsServerFrame(socket, opcode, payload) {
  if (socket.destroyed || !socket.writable) return;
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.from(BigInt(length).toString(16).padStart(16, '0'), 'hex')]);
  try { socket.write(Buffer.concat([header, payload])); } catch { }
}

// Host a signed-in Chromium browser over --remote-debugging-pipe behind a local
// Windows named pipe so multiple DSH servers can share it with 0 TCP listeners.
async function hostKeptProfile(configFile) {
  let config;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); }
  catch { return; }
  finally { try { rmSync(configFile, { force: true }); } catch { } }
  const { executablePath, executableName, args, profile, readyFile } = config;
  const pipeName = `dsh-wcu-cdp-${randomBytes(16).toString('hex')}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const browserGuid = randomUUID();
  const browserRoute = `/devtools/browser/${browserGuid}`;
  const pipeRoute = `/devtools/pipe/${pipeName}${browserRoute}`;
  const pipeUrl = `ws+pipe://127.0.0.1${pipeRoute}`;
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  const writeReady = data => { try { writeJsonAtomic(readyFile, data); } catch { } };

  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: browserEnv(),
    windowsHide: true,
    detached: false,
  });
  const cdpPipe = new BrowserPipe(child);
  let nextUpId = 0;
  let explicitClose = false;
  let settledReady = false;
  let closing = false;
  let exitingCode = null;
  let discoverStarted = false;
  const inflight = new Map();
  const clients = new Set();
  const sessionOwners = new Map();

  const sendUpstream = msg => {
    if (cdpPipe.closed) return false;
    try { cdpPipe.send(JSON.stringify(msg)); return true; } catch { return false; }
  };

  const cleanupClient = client => {
    if (!clients.has(client)) return;
    clients.delete(client);
    for (const sid of client.sessions) {
      sessionOwners.delete(sid);
      sendUpstream({ id: ++nextUpId, method: 'Target.detachFromTarget', params: { sessionId: sid } });
    }
    client.sessions.clear();
    for (const [upId, entry] of inflight) {
      if (entry.client === client) inflight.delete(upId);
    }
  };

  const shutdownHost = () => {
    if (closing) return;
    closing = true;
    for (const client of [...clients]) {
      client.sessions.clear();
      clients.delete(client);
      try { sendWsServerFrame(client.socket, 8, Buffer.alloc(0)); } catch { }
      try { client.socket.destroy(); } catch { }
    }
    sessionOwners.clear();
    for (const entry of inflight.values()) entry.reject?.(new Error('Browser closed during startup'));
    inflight.clear();
    try { pipeServer.close(); } catch { }
  };

  child.once('error', error => {
    if (!settledReady) {
      settledReady = true;
      writeReady({ error: `BROWSER_LANE_UNAVAILABLE: ${executableName} failed to launch (${error.message})` });
    }
    shutdownHost();
  });

  child.once('exit', code => {
    exitingCode = code;
    if (!settledReady) {
      settledReady = true;
      writeReady({ error: `BROWSER_LANE_UNAVAILABLE: ${executableName} exited during startup (${code}); if a window of the kept DSH profile (${profile}) is open without DSH, close it and try again` });
    }
    shutdownHost();
  });

  cdpPipe.onclose = () => {
    setTimeout(() => { if (exitingCode !== null || child.exitCode !== null || child.signalCode !== null) shutdownHost(); }, 200).unref();
  };

  const pipeServer = net.createServer(socket => {
    let head = Buffer.alloc(0);
    let client = null;
    const onHandshakeData = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 8192) socket.destroy();
        return;
      }
      socket.off('data', onHandshakeData);
      const reqText = head.subarray(0, end).toString('latin1');
      const rest = head.subarray(end + 4);
      const [requestLine, ...headerLines] = reqText.split('\r\n');
      const reqMatch = /^GET (\S+) HTTP\/1\.1$/i.exec(requestLine ?? '');
      const headers = new Map();
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const key = headers.get('sec-websocket-key');
      const reqPath = (reqMatch?.[1] ?? '').split('?')[0];
      if (!reqMatch || (reqPath !== browserRoute && reqPath !== pipeRoute)
        || headers.get('upgrade')?.toLowerCase() !== 'websocket'
        || !key || !/^[A-Za-z0-9+/=]{16,64}$/.test(key)) {
        try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { socket.destroy(); }
        return;
      }
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      client = { socket, sessions: new Set(), discovering: false, knownTargets: new Set(), buf: Buffer.alloc(0), parts: [] };
      clients.add(client);
      const onClientText = text => {
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.method === 'Browser.close') explicitClose = true;
        if (msg.method === 'Target.setDiscoverTargets' && msg.params?.discover) {
          client.discovering = true;
          if (discoverStarted) {
            const upId = ++nextUpId;
            inflight.set(upId, { client, clientId: msg.id, method: 'Target.getTargets', replayForSetDiscover: true });
            if (!sendUpstream({ id: upId, method: 'Target.getTargets', params: {} })) {
              inflight.delete(upId);
              sendWsServerFrame(client.socket, 1, Buffer.from(JSON.stringify({ id: msg.id, result: {} })));
            }
            return;
          }
          discoverStarted = true;
        }
        const upId = ++nextUpId;
        inflight.set(upId, { client, clientId: msg.id, method: msg.method, sessionId: msg.sessionId, params: msg.params });
        if (!sendUpstream({ ...msg, id: upId })) {
          inflight.delete(upId);
          sendWsServerFrame(client.socket, 1, Buffer.from(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'Browser pipe closed' } })));
        }
      };
      const handleWs = data => {
        client.buf = Buffer.concat([client.buf, data]);
        while (client.buf.length >= 2) {
          const b0 = client.buf[0], b1 = client.buf[1];
          const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f, off = 2;
          if (len === 126) {
            if (client.buf.length < 4) break;
            len = client.buf.readUInt16BE(2); off = 4;
          } else if (len === 127) {
            if (client.buf.length < 10) break;
            const bigLen = client.buf.readBigUInt64BE(2);
            if (bigLen > 67108864n) { socket.destroy(); return; }
            len = Number(bigLen); off = 10;
          }
          if (masked) { if (client.buf.length < off + 4) break; off += 4; }
          if (client.buf.length < off + len) break;
          const payload = Buffer.from(client.buf.subarray(off, off + len));
          if (masked) {
            const mask = client.buf.subarray(off - 4, off);
            for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
          }
          client.buf = client.buf.subarray(off + len);
          if (opcode === 8) { sendWsServerFrame(socket, 8, Buffer.alloc(0)); socket.end(); return; }
          if (opcode === 9) { sendWsServerFrame(socket, 10, payload); continue; }
          if (opcode === 10) continue;
          client.parts.push(payload);
          if (fin) { const text = Buffer.concat(client.parts).toString('utf8'); client.parts = []; onClientText(text); }
        }
      };
      socket.on('data', handleWs);
      if (rest.length) handleWs(rest);
    };
    socket.on('data', onHandshakeData);
    socket.on('close', () => { if (client) cleanupClient(client); });
    socket.on('error', () => socket.destroy());
  });
  pipeServer.on('error', () => { });

  cdpPipe.onmessage = raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined) {
      const entry = inflight.get(msg.id);
      if (!entry) return;
      inflight.delete(msg.id);
      if (entry.onReply) { entry.onReply(msg); return; }
      if (!clients.has(entry.client)) return;
      if (entry.replayForSetDiscover) {
        if (!msg.error && Array.isArray(msg.result?.targetInfos)) {
          for (const targetInfo of msg.result.targetInfos) {
            if (!entry.client.knownTargets.has(targetInfo.targetId)) {
              entry.client.knownTargets.add(targetInfo.targetId);
              sendWsServerFrame(entry.client.socket, 1, Buffer.from(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } })));
            }
          }
        }
        sendWsServerFrame(entry.client.socket, 1, Buffer.from(JSON.stringify({ id: entry.clientId, ...(msg.error ? { error: msg.error } : { result: {} }) })));
        return;
      }
      if (entry.method === 'Target.attachToTarget' && msg.result?.sessionId) {
        sessionOwners.set(msg.result.sessionId, entry.client);
        entry.client.sessions.add(msg.result.sessionId);
      } else if (entry.method === 'Target.detachFromTarget' && entry.params?.sessionId) {
        sessionOwners.delete(entry.params.sessionId);
        entry.client.sessions.delete(entry.params.sessionId);
      }
      sendWsServerFrame(entry.client.socket, 1, Buffer.from(JSON.stringify({ ...msg, id: entry.clientId })));
      return;
    }
    if (msg.sessionId) {
      const owner = sessionOwners.get(msg.sessionId);
      if (!owner || !clients.has(owner)) return;
      if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
        sessionOwners.set(msg.params.sessionId, owner);
        owner.sessions.add(msg.params.sessionId);
      }
      sendWsServerFrame(owner.socket, 1, Buffer.from(raw, 'utf8'));
      return;
    }
    if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
      const owner = sessionOwners.get(msg.params.sessionId);
      sessionOwners.delete(msg.params.sessionId);
      if (owner) {
        owner.sessions.delete(msg.params.sessionId);
        if (clients.has(owner)) sendWsServerFrame(owner.socket, 1, Buffer.from(raw, 'utf8'));
      }
      return;
    }
    if (msg.method?.startsWith('Target.')) {
      for (const client of clients) {
        if (!client.discovering) continue;
        if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.targetId) {
          client.knownTargets.add(msg.params.targetInfo.targetId);
        } else if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
          client.knownTargets.delete(msg.params.targetId);
        }
        sendWsServerFrame(client.socket, 1, Buffer.from(raw, 'utf8'));
      }
      return;
    }
    for (const client of clients) sendWsServerFrame(client.socket, 1, Buffer.from(raw, 'utf8'));
  };

  await new Promise((resolve, reject) => {
    pipeServer.once('error', reject);
    pipeServer.listen(pipePath, resolve);
  });

  const initId = ++nextUpId;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { inflight.delete(initId); reject(new Error('Timed out waiting for Chrome pipe readiness')); }, 15000);
      inflight.set(initId, {
        onReply: reply => { clearTimeout(timer); if (reply.error) reject(new Error(reply.error.message)); else resolve(reply.result); },
        reject: err => { clearTimeout(timer); reject(err); },
      });
      if (!sendUpstream({ id: initId, method: 'Browser.getVersion', params: {} })) {
        clearTimeout(timer);
        inflight.delete(initId);
        reject(new Error('Failed to write initial CDP command'));
      }
    });
  } catch (error) {
    if (!settledReady) {
      settledReady = true;
      writeReady({ error: `BROWSER_LANE_UNAVAILABLE: ${error.message}` });
    }
    shutdownHost();
    return;
  }

  const pendingPort = `${activePortFile}.${process.pid}.pending`;
  writeFileSync(pendingPort, `0\n${pipeRoute}\n`);
  renameSync(pendingPort, activePortFile);
  if (!settledReady) {
    settledReady = true;
    writeReady({ ok: true, url: pipeUrl, chromePid: child.pid, hostPid: process.pid });
  }
}

// The Windows default browser as an APPS key, or null for any other browser.
export function appForProgId(progId) {
  return /^MSEdge/i.test(progId ?? '') ? 'edge' : /^Chrome/i.test(progId ?? '') ? 'chrome' : /^FirefoxURL-/i.test(progId ?? '') ? 'firefox' : null;
}

// The ProgId of the default https handler. Windows 11 keeps the current choice
// under UserChoiceLatest\ProgId; earlier builds keep it under UserChoice only.
export async function defaultProgId() {
  const registry=process.platform==='win32'?path.win32.join(process.env.SystemRoot||process.env.WINDIR||'C:\\Windows','System32','reg.exe'):'reg.exe';
  const output = await new Promise(resolve => execFile(registry, ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https', '/s'],
    { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? '' : String(stdout))));
  let key = '', latest = null, legacy = null;
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) { key = line.trim(); continue; }
    const value = /^\s+ProgId\s+REG_SZ\s+(.*\S)/i.exec(line)?.[1];
    if (value && /\\UserChoiceLatest\\ProgId$/i.test(key)) latest = value;
    else if (value && /\\UserChoice$/i.test(key)) legacy = value;
  }
  return latest ?? legacy;
}
const INTERNAL_PAGE = /^(?:chrome|edge|brave|devtools|chrome-extension|extension|about|chrome-search):/i;
const BLANK_PAGE = /^(?:about:blank|(?:chrome|edge):\/\/newtab\/?)$/i;
const AGENT_IDLE_MS = 10 * 60 * 1000;
const AGENT_VISIBLE_IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_LISTED_TABS = 40;
const BACKOFF_MS = 60 * 1000;
const INDICATOR_WORLD = 'DSH browser status';
// The visible DSH browser shows what it does without covering the page, as
// Codex's browser agent does: its window is tinted DSH blue, the tab it works in
// shows a pointer badge as its icon, and a small pointer marks the point it acts
// on. The pointer lives in a closed shadow root of an isolated world, lets every
// event through and is hidden from the accessibility tree; all its changes stay
// inside the shadow root, so the page's mutation observers never see them.
const AGENT_THEME = '--install-autogenerated-theme=65,118,230';
const INDICATOR_SCRIPT = '(' + function () {
  if (window.top !== window || globalThis.__dshStatus) return;
  const BADGE = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4176e6"/>' +
    '<path d="M10 6.5v18.2l4.6-4.4 3.2 7 3.2-1.4-3.1-6.8h6.5z" fill="#fff" stroke="#173f94" stroke-width="1.3" stroke-linejoin="round"/></svg>');
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true'); host.setAttribute('data-dsh-browser-status', '');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;user-select:none!important;contain:strict!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = '<style>.layer{position:absolute;inset:0;overflow:hidden}.layer.capture{display:none}' +
    '.pointer{position:absolute;left:0;top:0;opacity:0;transform:translate(var(--x,50vw),var(--y,50vh));transition:transform .2s cubic-bezier(.2,.8,.2,1),opacity .2s;will-change:transform}' +
    '.pointer.on{opacity:1}.pointer svg{display:block;margin:-3px 0 0 -4px;filter:drop-shadow(0 1px 1.5px #0008) drop-shadow(0 0 5px #5686fe) drop-shadow(0 0 12px #5686fe99)}' +
    '.ring{position:absolute;left:-13px;top:-13px;width:26px;height:26px;border-radius:50%;border:2px solid #5686fe;opacity:0}' +
    '.ring.go{animation:ring .45s ease-out}@keyframes ring{from{opacity:.95;transform:scale(.35)}to{opacity:0;transform:scale(1.4)}}' +
    '@media (prefers-reduced-motion:reduce){.pointer{transition:opacity .2s}.ring.go{animation:none}}</style>' +
    '<div class="layer"><div class="pointer"><div class="ring"></div><svg width="20" height="24" viewBox="0 0 20 24"><path d="M4 3v16.4l4.1-3.9 2.9 6.3 2.9-1.3-2.8-6.1h5.9z" fill="#4176e6" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div></div>';
  const layer = shadow.querySelector('.layer'), pointer = shadow.querySelector('.pointer'), ring = shadow.querySelector('.ring');
  // The tab icon: the page's own icon links point at the badge while DSH works
  // and get their addresses back afterwards. A link added for a page without
  // one is turned into a touch icon before it goes, so Chrome drops the badge.
  let saved = null;
  const badge = on => {
    if (on && !saved && document.head) {
      const links = [...document.querySelectorAll('link[rel~="icon"]')];
      saved = links.length ? links.map(link => ({ link, href: link.getAttribute('href') })) : [{ link: document.createElement('link'), created: true }];
      for (const item of saved) { if (item.created) { item.link.rel = 'icon'; document.head.append(item.link); } item.link.href = BADGE; }
    } else if (!on && saved) {
      for (const item of saved) {
        if (item.created) { item.link.rel = 'apple-touch-icon'; setTimeout(() => item.link.remove(), 0); }
        else if (item.link.getAttribute('href') === BADGE) item.href === null ? item.link.removeAttribute('href') : item.link.setAttribute('href', item.href);
      }
      saved = null;
    }
  };
  let state = 'idle';
  // state: 'working' or 'idle'; point: where the next action lands, in CSS
  // pixels of the viewport ({ x, y, click }); 'capture'/'captured' hide and
  // show the pointer around a screenshot.
  globalThis.__dshStatus = (next, point) => {
    if (next === 'capture' || next === 'captured') { layer.classList.toggle('capture', next === 'capture'); return; }
    state = next;
    if (!host.isConnected && document.documentElement) document.documentElement.append(host);
    badge(state === 'working');
    if (point && state === 'working') {
      pointer.style.setProperty('--x', `${Math.round(point.x)}px`); pointer.style.setProperty('--y', `${Math.round(point.y)}px`);
      pointer.classList.add('on');
      if (point.click) { ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go'); }
    }
    if (state !== 'working') pointer.classList.remove('on');
  };
  globalThis.__dshIndicator = () => ({ state, pointer: pointer.classList.contains('on'), x: parseFloat(pointer.style.getPropertyValue('--x')), y: parseFloat(pointer.style.getPropertyValue('--y')),
    badge: Boolean(saved), capture: layer.classList.contains('capture') });
  globalThis.__dshStatus('idle');
  document.addEventListener('DOMContentLoaded', () => globalThis.__dshStatus(state), { once: true });
}.toString() + ')();';
// How long a tab keeps its working badge after DSH's last call there. In DSH
// the badge stays for the whole turn, as long as the host holds the series.
const INDICATOR_LINGER_MS = 2500;

export const NEW_TAB_ID = 'new-tab';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const fail = (code, message) => { throw new Error(`${code}: ${message}`); };
function validateViewportPoint({ x, y }, view) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= view.width || y >= view.height) {
    fail('INVALID_ARGUMENTS', 'Page coordinates must be inside the current screenshot viewport, in CSS pixels. Read a fresh screenshot.');
  }
  return { x, y };
}
const clip = (text, max) => text.length > max ? text.slice(0, max - 1) + '…' : text;
const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const fold = value => squash(value).toLowerCase().replace(/\s+/g, '');

function activePort(dir) {
  try {
    const [port, wsPath] = readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    if (port === '0' && /^\/devtools\/pipe\/[a-z0-9._-]+\/devtools\/browser\/[a-z0-9-]+$/i.test(wsPath ?? '')) {
      return `ws+pipe://127.0.0.1${wsPath}`;
    }
    if (/^\d+$/.test(port) && Number(port) > 0 && wsPath?.startsWith('/devtools/browser/')) return `ws://127.0.0.1:${port}${wsPath}`;
  } catch { }
  return null;
}

// A WebSocket client without permessage-deflate. Node's built-in client
// negotiates compression and drops the connection on any message over 4 MiB
// decompressed, which the accessibility tree of a long page exceeds.
class Socket {
  static open(url, timeoutMs, request) {
    const { protocol, hostname, port, pathname, search, host: hostHeader } = new URL(url);
    if (!['ws:', 'wss:', 'ws+pipe:'].includes(protocol)) return Promise.reject(new Error('DevTools requires a ws:, wss: or ws+pipe: URL'));
    let pipeName = null, requestPath = `${pathname}${search}`;
    if (protocol === 'ws+pipe:') {
      const match = /^\/devtools\/pipe\/([a-z0-9._-]+)(\/devtools\/.*)$/i.exec(pathname);
      if (!match) return Promise.reject(new Error('Invalid ws+pipe DevTools URL'));
      pipeName = match[1];
      requestPath = `${match[2]}${search}`;
    }
    const host = hostname === 'localhost' ? '127.0.0.1' : hostname.replace(/^\[|\]$/g, '');
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const secure = protocol === 'wss:';
      const options = { host, port: Number(port) || (secure ? 443 : 80) };
      const tcp = pipeName
        ? net.connect(`\\\\.\\pipe\\${pipeName}`)
        : secure ? tls.connect({ ...options, ...(net.isIP(host) ? {} : { servername: host }) }) : net.connect(options);
      const cancellation = request ? setInterval(() => { if (request.cancelled) tcp.destroy(new Error('COMPUTER_USE_CANCELLED')); }, 50) : null;
      tcp.once('close', () => clearInterval(cancellation));
      const timer = setTimeout(() => { tcp.destroy(); reject(new Error(`timed out connecting to ${url}`)); }, timeoutMs);
      const onClose = () => { clearTimeout(timer); reject(new Error(`${url} closed before the WebSocket upgrade`)); };
      tcp.once('close', onClose);
      let head = Buffer.alloc(0);
      const onData = chunk => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > 65536) { tcp.destroy(); reject(new Error('DevTools WebSocket upgrade headers are too large')); }
          return;
        }
        tcp.off('data', onData); clearTimeout(timer);
        const response = head.subarray(0, end).toString('latin1');
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        const headers = new Map(response.split('\r\n').slice(1).map(line => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        }));
        if (!/^HTTP\/1\.1 101(?: |$)/.test(response.split('\r\n')[0]) || headers.get('sec-websocket-accept') !== accept
          || headers.get('upgrade')?.toLowerCase() !== 'websocket'
          || !headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade')) {
          tcp.destroy(); return reject(new Error(`${url} refused the WebSocket upgrade`));
        }
        tcp.off('close', onClose); clearInterval(cancellation);
        resolve(new Socket(tcp, head.subarray(end + 4)));
      };
      tcp.on('data', onData);
      tcp.once('error', error => { clearTimeout(timer); reject(new Error(`could not connect to ${url} (${error.code ?? error.message})`)); });
      tcp.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
  }
  constructor(tcp, rest) {
    this.tcp = tcp; this.chunks = []; this.size = 0; this.parts = []; this.onmessage = null; this.onclose = null;
    tcp.on('data', chunk => this.receive(chunk));
    tcp.on('close', () => this.onclose?.());
    tcp.on('error', () => { });
    if (rest.length) this.receive(rest);
  }
  // Frames are joined only once they are complete, so a 10 MB message is copied once.
  receive(chunk) {
    this.chunks.push(chunk); this.size += chunk.length;
    while (this.size >= 2) {
      let head = this.chunks[0];
      if (head.length < 14 && this.chunks.length > 1) { head = this.chunks[0] = Buffer.concat(this.chunks); this.chunks.length = 1; }
      let length = head[1] & 0x7f, offset = 2;
      if (length === 126) { if (head.length < 4) return; length = head.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (head.length < 10) return; length = Number(head.readBigUInt64BE(2)); offset = 10; }
      const masked = head[1] & 0x80;
      if (masked) offset += 4;
      if (this.size < offset + length) return;
      const all = this.chunks.length === 1 ? head : Buffer.concat(this.chunks);
      let payload = all.subarray(offset, offset + length);
      if (masked) payload = Buffer.from(payload.map((byte, i) => byte ^ all[offset - 4 + (i & 3)]));
      const rest = all.subarray(offset + length);
      this.chunks = rest.length ? [rest] : []; this.size = rest.length;
      const fin = head[0] & 0x80, opcode = head[0] & 0x0f;
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.frame(10, payload); continue; }
      if (opcode === 10) continue;
      this.parts.push(payload);
      if (fin) { const text = Buffer.concat(this.parts).toString('utf8'); this.parts = []; this.onmessage?.(text); }
    }
  }
  frame(opcode, payload) {
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), Buffer.from(BigInt(length).toString(16).padStart(16, '0'), 'hex')]);
    const mask = randomBytes(4), body = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) body[i] = payload[i] ^ mask[i & 3];
    this.tcp.write(Buffer.concat([header, mask, body]));
  }
  send(text) { this.frame(1, Buffer.from(text, 'utf8')); }
  close() { if (this.tcp.destroyed) return; try { this.frame(8, Buffer.alloc(0)); } catch { } this.tcp.destroy(); }
}

// One JSON message per WebSocket frame; flattened target sessions share the socket.
class Cdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false;
    socket.onmessage = data => this.receive(data);
    socket.onclose = () => this.fail(new Error('BROWSER_DISCONNECTED: the browser closed its DevTools connection'));
  }
  static async open(url, timeoutMs, request) {
    return new Cdp(await Socket.open(url, timeoutMs, request));
  }
  receive(data) {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.id === undefined) { for (const listener of this.listeners) listener(message); return; }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`BROWSER_TIMEOUT: ${method} did not answer within ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true; this.closedError = error;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'Lane.closed' });
  }
  close() { try { this.socket.close(); } catch { } this.fail(new Error('BROWSER_DISCONNECTED: closed by the server')); }
}

// Roles that only wrap their children; an unnamed one adds no line.
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'group', 'Section', 'paragraph', 'strong', 'emphasis', 'mark',
  'code', 'subscript', 'superscript', 'time', 'Abbr', 'Ruby', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'Pre', 'blockquote',
  'DescriptionListDetail', 'DescriptionListTerm', 'LabelText', 'Legend', 'Div', 'Span', 'Unknown', 'deletion', 'insertion', 'figure']);
// Wrappers inside a line of text; text runs merge across these only, so a line's
// id never stands for text from another paragraph or box.
const INLINE = new Set(['strong', 'emphasis', 'mark', 'code', 'subscript', 'superscript', 'time', 'Abbr', 'Ruby', 'deletion', 'insertion', 'none', 'presentation']);
const SKIPPED = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
const ROLE_NAMES = { StaticText: 'text', RootWebArea: 'page', Iframe: 'iframe', img: 'image', Canvas: 'canvas', MenuListPopup: 'menu', MenuListOption: 'option' };
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton']);
const CONTROL_ROLES = {
  button: ['button', 'menuitem', 'switch'], hyperlink: ['link'], link: ['link'], edit: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  textbox: ['textbox', 'searchbox'], combobox: ['combobox', 'listbox'], checkbox: ['checkbox', 'switch'], radiobutton: ['radio'],
  menuitem: ['menuitem', 'menuitemcheckbox', 'menuitemradio'], tabitem: ['tab'], listitem: ['listitem', 'option'], text: ['StaticText', 'heading'],
  image: ['img', 'image'], document: ['RootWebArea'], heading: ['heading'], list: ['list', 'listbox'], table: ['table', 'grid']
};
const property = (node, name) => node.properties?.find(item => item.name === name)?.value?.value;

function nodeLine(node, name) {
  const role = node.role?.value ?? '';
  let line = ROLE_NAMES[role] ?? role;
  if (name) line += ` "${clip(name, 160)}"`;
  const value = squash(node.value?.value);
  if (value && value !== name && TEXT_ROLES.has(role)) line += ` value="${clip(value, 120)}"`;
  const states = [];
  if (property(node, 'focused') === true) states.push('focused');
  const checked = property(node, 'checked');
  if (checked === 'true' || checked === true) states.push('checked'); else if (checked === 'mixed') states.push('mixed');
  if (property(node, 'selected') === true) states.push('selected');
  const expanded = property(node, 'expanded');
  if (expanded === true) states.push('expanded'); else if (expanded === false) states.push('collapsed');
  if (property(node, 'disabled') === true) states.push('disabled');
  return states.length ? `${line} (${states.join(', ')})` : line;
}

// Flatten the CDP accessibility tree into indented lines. Unnamed wrappers
// disappear, text runs within a line merge, and text that repeats its parent's
// or its control's name is dropped; this is the compaction that keeps pages readable.
function buildOutline(nodes, idOf, maxLines) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const root = nodes.find(node => node.role?.value === 'RootWebArea') ?? nodes[0];
  const lines = []; let truncated = false, total = 0, focused = null, iframes = 0;
  const emit = (node, depth, text, plain) => {
    total++;
    if (lines.length >= maxLines) { truncated = true; return; }
    const id = idOf(node.backendDOMNodeId);
    // A label's text right before its control only repeats the control's name.
    const last = lines.at(-1), name = squash(node.name?.value);
    if (plain === undefined && name && last?.plain !== undefined && last.depth === depth && fold(last.plain) === fold(name)) lines.pop();
    lines.push({ key: id || `~${lines.length}`, id, depth, text, ...(plain !== undefined ? { plain } : {}) });
    if (property(node, 'focused') === true && id) focused = id;
  };
  const visit = (ids, depth, parentName) => {
    let run = null;
    const flush = () => {
      if (!run) return;
      const text = squash(run.parts.join(''));
      if (text && fold(text) !== fold(parentName) && !(parentName && fold(parentName).includes(fold(text)))) emit(run.node, depth, `text "${clip(text, 200)}"`, text);
      run = null;
    };
    const walk = list => {
      for (const id of list ?? []) {
        const node = byId.get(id);
        if (!node) continue;
        const role = node.role?.value ?? '';
        if (SKIPPED.has(role)) continue;
        const name = squash(node.name?.value);
        if (node.ignored || (TRANSPARENT.has(role) && !name)) {
          const block = !node.ignored && !INLINE.has(role);
          if (block) flush();
          walk(node.childIds);
          if (block) flush();
          continue;
        }
        if (role === 'StaticText') { (run ??= { node, parts: [] }).parts.push(node.name?.value ?? ''); continue; }
        flush();
        if (role === 'Iframe') iframes++;
        emit(node, depth, nodeLine(node, name));
        // A text field's value is already on its own line.
        if (!FIELD_ROLES.has(role)) visit(node.childIds, depth + 1, name);
      }
    };
    walk(ids);
    flush();
  };
  visit(root?.childIds, 0, squash(root?.name?.value));
  return { lines, truncated, total, focused, iframes, title: squash(root?.name?.value) };
}

const quadArea = q => Math.abs(q.reduce((sum,value,i)=>i%2===0?sum+value*q[(i+3)%8]-q[(i+2)%8]*q[i+1]:sum,0))/2;
const render = lines => lines.map(line => `${'  '.repeat(line.depth)}${line.id ? `[${line.id}] ` : ''}${line.text}`).join('\n');

const KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], del: ['Delete', 'Delete', 46],
  space: [' ', 'Space', 32, ' '], up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37],
  right: ['ArrowRight', 'ArrowRight', 39], arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39], home: ['Home', 'Home', 36], end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34], pgup: ['PageUp', 'PageUp', 33], pgdn: ['PageDown', 'PageDown', 34],
  insert: ['Insert', 'Insert', 45], ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, [`F${i + 1}`, `F${i + 1}`, 112 + i]]))
};
const MODIFIERS = { alt: [1, 'Alt', 'AltLeft', 18], option: [1, 'Alt', 'AltLeft', 18], ctrl: [2, 'Control', 'ControlLeft', 17], control: [2, 'Control', 'ControlLeft', 17], shift: [8, 'Shift', 'ShiftLeft', 16] };
// Printable keys besides letters on a US layout: code, virtual key and the shifted character.
const PRINTABLE = {
  '`': ['Backquote', 192, '~'], 1: ['Digit1', 49, '!'], 2: ['Digit2', 50, '@'], 3: ['Digit3', 51, '#'], 4: ['Digit4', 52, '$'], 5: ['Digit5', 53, '%'],
  6: ['Digit6', 54, '^'], 7: ['Digit7', 55, '&'], 8: ['Digit8', 56, '*'], 9: ['Digit9', 57, '('], 0: ['Digit0', 48, ')'], '-': ['Minus', 189, '_'],
  '=': ['Equal', 187, '+'], '[': ['BracketLeft', 219, '{'], ']': ['BracketRight', 221, '}'], '\\': ['Backslash', 220, '|'], ';': ['Semicolon', 186, ':'],
  "'": ['Quote', 222, '"'], ',': ['Comma', 188, '<'], '.': ['Period', 190, '>'], '/': ['Slash', 191, '?']
};
const SHIFTED = Object.fromEntries(Object.entries(PRINTABLE).map(([base, [code, vk, shifted]]) => [shifted, [code, vk, base]]));
// Browser shortcuts belong to the browser window, not to the page that CDP
// input reaches; these map to protocol commands or to an explicit refusal.
const BROWSER_SHORTCUTS = new Set(['ctrl+l', 'alt+d', 'f6', 'ctrl+t', 'ctrl+n', 'ctrl+w', 'ctrl+f4', 'ctrl+tab', 'ctrl+shift+tab', 'ctrl+shift+t', 'ctrl+h', 'ctrl+j', 'ctrl+d', 'f11', 'f12']);

const QUIET_SCRIPT = `new Promise(resolve => {
  let timer; const done = () => { observer.disconnect(); clearTimeout(timer); resolve(true); };
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 100); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  timer = setTimeout(done, 100); setTimeout(done, 1000);
})`;
// A disabled or read-only control is refused before anything is written: the
// value setter would change it anyway, and a typed edit would vanish silently.
const EDIT_KIND = `function () {
  if (this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true') return 'disabled';
  const tag = this.tagName;
  if (tag === 'SELECT') return 'select';
  if (tag === 'TEXTAREA') return this.readOnly ? 'readonly' : 'text';
  if (tag === 'INPUT') {
    const type = (this.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'file') return 'file';
    if (['button', 'submit', 'reset', 'image', 'hidden'].includes(type)) return 'other';
    if (this.readOnly) return 'readonly';
    if (['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type)) return 'value';
    return 'text';
  }
  if (this.getAttribute('aria-readonly') === 'true') return 'readonly';
  return this.isContentEditable ? 'editable' : 'other';
}`;
// Clicks on a disabled control, or on text inside one, do nothing on the page.
const DISABLED = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement;
  return Boolean(element?.closest(':disabled, [aria-disabled="true"]'));
}`;
const TRUE_VALUE = /^(?:true|1|on|yes|checked|是|选中|勾选)$/i, FALSE_VALUE = /^(?:false|0|off|no|unchecked|否|不选|取消|取消勾选)$/i;
// A native drop-down draws its list in a browser popup, so its options have no
// box in the page. A click on one chooses it, as the user's click in the list
// would: the select changes and fires input and change. A list drawn in the
// page (multiple, or size above 1) takes real clicks instead.
const OPTION_PICK = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement;
  const option = element?.closest('option'), select = option?.closest('select');
  if (!option || !select || select.multiple || select.size > 1) return null;
  if (option.disabled || option.closest('optgroup')?.disabled || select.matches(':disabled')) return { disabled: option.text.trim() };
  if (select.selectedIndex !== option.index) {
    select.selectedIndex = option.index;
    select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { chose: option.text.trim() };
}`;
// A label, or text inside one, stands for its control.
const LABEL_CONTROL = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement;
  if (!element || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable) return null;
  return element.closest('label')?.control ?? null;
}`;
const SELECT_ALL = `function () {
  if (typeof this.select === 'function') { this.select(); return; }
  const range = document.createRange(); range.selectNodeContents(this);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
}`;
// One option, or for a multiple select several, one per line; an empty value
// clears a multiple select. Disabled options, also those of a disabled group, are refused.
const SELECT_OPTION = `function (wanted) {
  const options = [...this.options];
  const off = option => option.disabled || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled);
  const listed = () => options.slice(0, 40).map(o => o.text.trim() + (off(o) ? ' (disabled)' : ''));
  const names = this.multiple ? wanted.split(/\\r?\\n|\\|/).map(name => name.trim()).filter(Boolean) : [wanted];
  const find = name => options.find(o => o.value === name) || options.find(o => o.text.trim() === name) || options.find(o => o.text.trim().toLowerCase() === name.toLowerCase());
  const picked = names.map(find);
  if ((!this.multiple && !picked.length) || picked.some(option => !option)) return { ok: false, options: listed() };
  if (picked.some(off)) return { ok: false, disabled: picked.filter(off).map(o => o.text.trim()), options: listed() };
  if (this.multiple) for (const option of options) option.selected = picked.includes(option);
  else this.value = picked[0].value;
  this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}`;
// Whether an input of this type keeps the value: the browser empties an
// invalid date or number, so the value is tried on a detached input first and
// the field keeps its own value when the new one would be dropped. A range
// clamps to its steps instead, and a color lower-cases its digits.
const ACCEPTS = `function (value) {
  if (this.tagName !== 'INPUT' || value === '' || !['number', 'date', 'time', 'datetime-local', 'month', 'week', 'color'].includes(this.type)) return true;
  const probe = document.createElement('input'); probe.type = this.type; probe.value = value;
  return probe.value.toLowerCase() === value.toLowerCase();
}`;
// Date, time, color and range inputs take their value whole, through the
// native setter so that frameworks tracking the value see the change.
const SET_VALUE = `function (value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(this, value);
  this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.value;
}`;
const FORMATS = { number: 'a number such as 12 or -0.5', date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-Www', color: '#rrggbb' };
const READ_VALUE = `function () { return (${readSafeValue.toString()})(this); }`;
// A click at the element's center counts if it lands on the element, inside it
// (shadow content included), or on an ancestor: a text node or a
// pointer-events:none icon hands its click to the element around it.
const ON_TARGET = `function (other) {
  const up = node => node.parentNode ?? node.host;
  for (let node = other; node; node = up(node)) if (node === this) return true;
  for (let node = this; node; node = up(node)) if (node === other) return true;
  return false;
}`;
// Outline text lines are text nodes; their facts come from the element around them.
const ELEMENT_FACTS = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement;
  const r = element.getBoundingClientRect();
  const text = String((this.nodeType === 1 ? this.innerText : this.textContent) ?? '').trim();
  return { tag: element.tagName.toLowerCase(), ...(this.nodeType === 3 ? { node: 'text' } : {}), type: element.type || undefined, href: element.href || undefined, placeholder: element.placeholder || undefined,
    value: 'value' in element ? String((${readSafeValue.toString()})(element)).slice(0, 500) : undefined, checked: typeof element.checked === 'boolean' ? element.checked : undefined,
    disabled: element.disabled === true || undefined, text: text.slice(0, 4000) || undefined, ...(text.length > 4000 ? { textLength: text.length } : {}),
    viewportBox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth };
}`;
// The focused element, followed into open shadow roots and same-origin frames.
const DEEP_FOCUS = `(() => {
  for (let element = document.activeElement; ;) {
    let inner = element?.shadowRoot?.activeElement;
    if (!inner && element?.tagName === 'IFRAME') try { inner = element.contentDocument?.activeElement; } catch { }
    if (!inner || inner === element) return element;
    element = inner;
  }
})()`;
const FOCUSED_FIELD = `(() => {
  const element = ${DEEP_FOCUS};
  if (!element || element.tagName === 'BODY' || !(element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName))) return 'none';
  return element.disabled || element.readOnly ? 'locked' : 'editable';
})()`;
const FOCUSED_VALUE = `(() => { const element = ${DEEP_FOCUS}; return (${readSafeValue.toString()})(element); })()`;
const DIALOG_NOTE = 'A JavaScript dialog opened; keypress Enter accepts it, Escape dismisses it (for a prompt, type_text first sets the answer). A visible browser may activate its native dialog window; browser-lane input itself does not move the desktop pointer.';
// The scroll offset of the nearest scrollable box around a node.
const SCROLL_POSITION = `function () {
  for (let node = this.nodeType === 1 ? this : this.parentElement; node && node !== document.documentElement && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/auto|scroll|overlay/.test(style.overflowY + style.overflowX) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) return [node.scrollLeft, node.scrollTop];
  }
  return null;
}`;

