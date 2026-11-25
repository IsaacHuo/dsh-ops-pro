# Computer use, sidebar console and usage statistics

Chinese: [computer-use.zh.md](computer-use.zh.md)

## Computer use (`ops_cu_*`, Windows only)

### Overview

The plugin row's `computer-use` configuration section publishes the desktop and browser
automation of [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) as
`ops_cu_*` tools. It is off by default. The tools are registered globally, outside any mode, so
every built-in mode, custom preset, Native and PTC session sees them.

Both lanes read structure first and act on element ids: the desktop lane reads the Windows UI
Automation tree (UIA, the Windows accessibility interface), the browser lane drives Chromium over
CDP (Chrome DevTools Protocol) and reads the page accessibility tree. Screenshots, OCR and
coordinates are only a fallback when no semantic node exists.

### Requirements

| Item | Requirement | Note |
| --- | --- | --- |
| System | Windows 10 / 11 x64 | The desktop lane needs UIA; there is no macOS or Linux build |
| PowerShell | Windows PowerShell 5.1 | Runs `scripts/*.ps1` from `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; shipped with Windows |
| UI Automation | Shipped with Windows | The backend loads the .NET `UIAutomationClient` assemblies; nothing to install |
| Browser | Edge or Chrome | The browser lane launches one of them by default; another Chromium can be named explicitly |
| Administrator rights | Not required | Runs as the current user |

Everything executable ships inside the plugin package: the prebuilt native worker
(`runtime/win32-x64`), the bundled bash payload and the built-in computer-use runtime. Nothing has
to be downloaded after install, and no component has to be installed separately from this README.

### Enable and configure

```yaml
dsh-ops:
  computer-use:
    enabled: true
    callTimeoutMs: 90000
    settings:
      desktopTarget: quiet
      browserApp: default
```

| Key | Default | Meaning | Note |
| --- | --- | --- | --- |
| `computer-use.enabled` | false | Publish `ops_cu_*` | Restart the session after changing it |
| `computer-use.callTimeoutMs` | 90000 | Per-call time limit | 1000–600000 |
| `computer-use.settings` | `{}` | Upstream settings | Unknown keys are errors; a key saved from the console wins |

Settings fall into six groups, all marked `draft`, and can be edited on the computer use page of the
sidebar console:

| Group | Keys | Meaning |
| --- | --- | --- |
| Desktop | `desktopTarget`, `hypervVm` | `quiet` runs in the background, `fast` takes the foreground, `hyperv` runs on a Hyper-V virtual desktop |
| Browser | `browserFirst`, `browserVisible`, `browserApp`, `browserSignIn`, `browserAttachUser` | Launch and sign-in policy of the browser lane, see the next section |
| Overlay | `progressOverlayEnabled`, `progressOverlayMode`, `progressOverlayOpacity`, `progressOverlayWidth`, `progressOverlayHeight`, `progressOverlayPosition`, `progressOverlayX`, `progressOverlayY`, `progressOverlayLocked`, `progressLockShortcut`, `progressPreviewToken` | Placement of the progress overlay |
| Toolset | `mode`, `toolPreset`, `enabledTools` | `lite` publishes only observation and input tools, `full` publishes all |
| Indicator | `indicatorEnabled`, `cursorIndicatorEnabled`, `remoteIndicatorVisible`, `indicatorText`, `indicatorPosition`, `indicatorIdleMs`, `stopShortcut` | Edge-of-screen status indicator and stop shortcut |
| Notes | `communityNote` | Community notice on first use; `link` keeps only the link |

### Tools

There are 26, named `ops_cu_<name>` (upstream: `mcp__wincu__windows_computer_use_<name>`).

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `health` | Runtime self-check | none |
| `snapshot` | Element tree of a window or the desktop, optionally with a screenshot | `scope`, `windowTarget`, `browserTab`, `maxDepth`, `maxNodes` |
| `accessibility_tree` | Element tree only, supports deltas | `treeDeltaBase`, `maxDepth`, `maxNodes` |
| `list_windows` | List visible windows and browser tabs | `includeInvisible`, `maxWindows` |
| `find` | Search elements by name or control type, with OCR fallback | `query`, `controlType`, `ocrFallback`, `maxResults` |
| `element_info` | Details of an element or a screen point | `elementId` or `x`/`y` |
| `click`, `double_click` | Click an element center or a coordinate | `elementId`, `button`, `dispatch` |
| `move` | Hover an element or a coordinate | `elementId`, `x`/`y` |
| `drag` | Drag along a path | `path` (at least two points) |
| `scroll` | Scroll an element or a point | `deltaY` (120 is one wheel notch), `deltaX` |
| `type_text` | Type text | `text`, `method` (`clipboard`/`sendinput`/`background`), `focusMode` |
| `keypress` | Press key combinations | `keys`, `thenKeys`, `dispatch` |
| `focus` | Give focus to an element | `elementId` |
| `invoke` | Run an element's default action, expand, collapse or scroll it into view | `action`, `fallbackClick` |
| `set_value` | Set an input or select value | `elementId`, `value`, `fallbackType` |
| `activate_window` | Bring a window or tab forward, restoring minimized ones | `windowTarget` or `browserTab` |
| `wait` | Wait a number of milliseconds | `milliseconds` |
| `ocr` | Read visible text | `query`, `language`, `scope`, `maxBytes` |
| `screenshot` | Capture pixels | `scope`, `maxWidth` |
| `wait_for` | Poll for a window, element or text | `condition`, `query`, `timeoutMs`, `appear` |
| `close_window` | Post a close message | `windowTarget` or `browserTab` |
| `move_window` | Move a window to a coordinate | `x`, `y` |
| `launch_app` | Launch a program or shortcut | `target`, `arguments`, `workingDirectory`, `desktop` |
| `batch` | Run 1–20 steps in sequence on one window | `steps`, `timeoutMs` |
| `tools` | Inspect and adjust the toolset published in this session | none |

### Element identification

**Desktop lane.** `snapshot` and `accessibility_tree` return the UIA element tree; each node
carries an element id (such as `t1a2b:57`), control type, name, value, whether it is interactive,
and its bounds. An element id is valid only for that window within the current run: it stops
resolving when the window closes or the runtime restarts, so observe again.

**Browser lane.** `accessibility_tree` reads the accessibility tree of the current tab, with the
same `t…:n` element ids (page elements may carry a `web:` prefix). Operations on page elements run
inside the page: the desktop pointer does not move and the foreground is not taken.

**Ids first, coordinates as backup.** An element id goes straight into `click`, `double_click`,
`invoke`, `set_value`, `focus`, `scroll`, `element_info` and `move`. Coordinates are used only
when no node exists, when the node is self-drawn, or when a blank area must be clicked.

The browser lane adds three special ids: `<tab>:address` names the address bar (use it with
`set_value` to navigate), `new-tab` opens a background tab, and `connect` attaches to the user's own
browser.

**Fallback order.** `find` (search by name or control type, optionally through OCR) → `ocr` (reads
visible text and returns screen coordinates and text, not element ids) → `screenshot` with a
coordinate click → `wait_for` polling. OCR reports no confidence: small text, low-contrast text and
scaled interfaces can be misread, and the element tree is authoritative when both are available.

**Boundaries.** Self-drawn canvases, game frames and remote-desktop windows expose no readable UIA
tree; some Electron and UWP applications expose few nodes and need to be expanded level by level.
Those cases are limited to coordinates and OCR, and their accuracy depends on display scaling and
theme.

Desktop coordinates are screen pixels. `screenshot` and `snapshot` report the window bounds and an
`imageScale`, so `screen = origin + pixels / imageScale`. Browser-lane `x`/`y` are CSS pixels in
the page viewport.

### Browser lane

| Setting | Default | Values | Meaning |
| --- | --- | --- | --- |
| `browserApp` | `default` | `default`, `edge`, `chrome`, `firefox` | `default` tries Edge, then Chrome |
| `browserSignIn` | false | boolean | false uses a throwaway profile; true keeps sign-ins |
| `browserVisible` | true | boolean | false hides the browser window; operations continue |
| `browserAttachUser` | false | boolean | true attaches to the user's open browser |
| `browserFirst` | true | boolean | prefer the page lane when page elements are available |

In `default` mode Edge comes first: since Edge 156 a new profile signs itself into the Windows
account and writes that account's cookies, so Edge usually works as-is, with Chrome as the fallback.

With `browserSignIn: false` every run gets a clean profile. With true, sign-ins are kept in
`%LOCALAPPDATA%\dsh-computer-use-win\agent-browser`, overridable with `WCU_BROWSER_PROFILE`.

`browserAttachUser: true` attaches to the user's own browser: that browser must already expose a
remote debugging port, the tabs read belong to the user, and the first access requires approval.
Without it, computer use only drives the profile it launched itself.

Chromium browsers that are not on the built-in list (for example third-party shells such as ego)
connect one of two ways: point `WCU_BROWSER_EXE` at the executable, or point `WCU_BROWSER_CDP_URL`
at an already-open debugging endpoint. Both are optional configuration, not install dependencies;
without them the plugin drives only Edge or Chrome.

Environment variables for diagnostics and advanced use: `WCU_BROWSER_APP`,
`WCU_BROWSER_SIGNIN`, `WCU_BROWSER_ATTACH_USER`, `WCU_BROWSER_PROFILE`, `WCU_BROWSER_EXE`,
`WCU_BROWSER_CDP_URL`, `WCU_BROWSER_BIDI_URL`, and `WCU_BROWSER_LANE=off` to disable the whole
browser lane. Environment variables win over the same key in the settings file.

### Limits and known issues

- Browser-lane element ids are numbered per run and never reused across tabs; tab ids carry a salt
  of the run, so an id kept from an earlier run names no tab instead of a different element that
  happens to have the same number.
- Not ported from the upstream DSH adapter: its own web routes, the activity-overlay control pipe,
  and the host integration of the background-desktop helper.
- Upstream issues #99 (stuck keys) and #100 (secondary-monitor fullscreen misdetection) are not
  fixed here.
- The built-in server executes serially in one process. An abnormal exit is restarted once; a second
  crash within 60 seconds keeps it stopped and shows the reason on the Status tab.
- Operations that require approval: connecting the user's browser, accessing the user's existing
  tabs, launching a program with arguments or a `.lnk` shortcut, and uploading or reading local files
  from a page. Under the full-access preset (`policy: never`) the host stops asking.
- Terminal security software on some machines quarantines `scripts/windows-uia.ps1`; the Status tab
  then reports a missing backend and desktop tools return errors. Ask IT for an exception; the
  plugin does not bypass it.
- Installing the standalone `dsh-computer-use-win` plugin alongside this one only reports a
  conflict; disable one of them by hand.
- The Windows key is blocked by design; background keypresses support a single printable character.

### Source and license

The built-in runtime is [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win)
0.6.3 (MIT, pinned at commit `acfb689`), derived from
[cgissing/windows-computer-use](https://github.com/cgissing/windows-computer-use). Per-file SHA-256
digests live in `vendor/computer-use/UPSTREAM.md`; files over 1000 lines are split into line
segments, reassembled and verified at build time. License text is in `licenses/computer-use/`.

This document follows the structure of the Microsoft Hybrid-Computer-Use documentation; the
technical content follows this repository's implementation.

## Sidebar console

The **OPS** entry in the DSH sidebar opens three tabs:

- **Status** — plugin version, native worker, enabled features, computer-use state, tool count,
  process starts, conflicts and the quarantined-backend notice.
- **Computer use** — plain values from the upstream settings (no tool lists, no commands),
  validated with the built-in `validateSetting`. Saving writes
  `<DSH_HOME>/dsh-ops/computer-use.json` and restarts only the computer-use runtime; calls in flight
  are cancelled. "Clear console settings" removes that file.
- **Usage** — see below.

## Usage statistics

One `tools/execute` listener counts every `ops_*` call in every mode: calls, failures (thrown or
returned as a failure value), calls from `run_code`, p50/p95 duration and result characters. Tokens
are an **estimate** (characters / 4). Counts live in `<DSH_HOME>/dsh-ops/usage.json`, bucketed by
local day, kept for 30 days and written at most every 5 seconds. A corrupt file restarts the count
and shows a notice on the page; it never fails a call. Nothing leaves the machine.
