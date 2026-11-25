# Computer use, sidebar console and usage statistics

中文：[computer-use.zh.md](computer-use.zh.md)

## Computer use (`ops_cu_*`, Windows only)

The `computer-use` section of the row publishes the desktop and browser automation of
[dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3 (MIT, vendored
at commit `acfb689`, see `vendor/computer-use/UPSTREAM.md` and `licenses/computer-use/`) as
`ops_cu_*` tools. It is off by default.

- **Every mode.** The tools are registered globally beside the modes, so every built-in mode,
  custom preset, Native and PTC session sees them.
- **One process.** The vendored MCP server runs as one persistent child of the host
  (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`), restarted once if it dies; a second
  crash within 60 s leaves it stopped with the reason on the Status tab.
- **Approval.** Risky operations still ask first, with the vendored rules unchanged.
- **Failures are values.** `CU_TIMEOUT`, `CU_CANCELLED`, `CU_UNAVAILABLE`, `CU_TOOL_ERROR` with
  `effectState`.

| Key | Default | Meaning |
| --- | --- | --- |
| `computer-use.enabled` | false | Publish `ops_cu_*` |
| `computer-use.callTimeoutMs` | 90000 | Per-call budget, 1000–600000 |
| `computer-use.settings` | `{}` | Upstream settings; the console file overrides them key by key |

Renamed tools: `mcp__wincu__windows_computer_use_<x>` becomes `ops_cu_<x>`. If the standalone
`dsh-computer-use-win` plugin is also installed, the Status tab warns; disable one of them —
OPS never disables another plugin itself.

Not ported from the upstream DSH adapter: its own web routes, the activity overlay control
pipe and the background-desktop helper's host integration. Known upstream issues #99 (stuck
keys) and #100 (secondary-monitor full-screen detection) are not fixed here.

Endpoint security on some machines quarantines `scripts/windows-uia.ps1`. The Status tab then
reports the backend as missing and desktop tools fail with a returned error; ask IT for an
exception — OPS does not work around it.

## Sidebar console

The **OPS** entry in the DSH sidebar opens three tabs:

- **Status** — plugin version, native worker, enabled features, computer-use state, tool count,
  process starts, conflict and quarantined-backend warnings.
- **Computer use** — the upstream settings that are plain values (no tool lists or commands),
  validated by the vendored `validateSetting`. Saving writes
  `<DSH_HOME>/dsh-ops/computer-use.json` and restarts only the computer-use runtime; calls in
  flight are cancelled. *Clear console settings* removes the file.
- **Usage** — see below.

## Usage statistics

One `tools/execute` listener counts every `ops_*` call in every mode: calls, failures
(thrown or returned failure values), calls from `run_code`, p50/p95 wall time and result
characters. Tokens are an **estimate** (characters / 4). Counters live in
`<DSH_HOME>/dsh-ops/usage.json`, one bucket per local day, 30 days kept, written at most every
5 s. A broken file starts a fresh count and is reported on the tab; it never fails a call.
Nothing leaves the machine.
