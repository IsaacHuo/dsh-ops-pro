<p align="center"><a href="README.md">中文</a> | <strong>English</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ops-pro"><img alt="npm" src="https://img.shields.io/npm/v/dsh-ops-pro?style=flat-square&color=6c5ce7"></a>
  <a href="https://github.com/IsaacHuo/dsh-ops-pro/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/IsaacHuo/dsh-ops-pro/ci.yml?branch=pro%2Fnext&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4b6fff?style=flat-square"></a>
</p>

# dsh-ops-pro

A tool-enhancement plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): it replaces some official tools with `ops_*` tools that take smaller inputs, return smaller outputs and report failures explicitly, so tasks cost fewer tokens and fewer rounds. Windows x64 is the primary platform; Linux x64 and macOS (arm64/x64) are supported too.

Maintained by [IsaacHuo](https://github.com/IsaacHuo). The project derives from [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops), is published as its own npm package `dsh-ops-pro`, and since 1.0 follows its own architecture; see [the end of this file](#relationship-to-upstream) for upstream credit and copyright.

## Features

- **Windows Bash**: `ops_bash` ships a Niubash 1.5.0 runtime and can hide the host PowerShell tool; a local Git Bash or WSL can be used instead.
- **File and search tools**: implemented by a Rust worker. The PTC SDK catalogue has 18 APIs: 15 file/document tools plus batching, result references and the loader. Results are paged and say whether they are complete; failures return structured errors (`status`, `error.code`).
- **Presets**: built-in modes such as minimal, standard, ptc and ops-ptc, each able to hide the official tools it replaces.
- **OPS-PTC**: batch tool calls inside one `run_code` program. The batching rules are taught once in the first root result; later notices are based on the calls a program actually made, at most three per session.
- **On-demand loading**: specialised tools load when needed; the discovery section stays byte-identical across selections, so the prompt cache survives.

## What changed in 1.0

- Host touch points live in `src/adapter/dsh/`; `npm run check:host` ratchets every other location in CI.
- Batching notices judge the calls a program dispatched instead of regex code analysis.
- The PTC SDK declaration renders each tool's data schema once: loading glob/grep/read_files adds 13,339 B instead of 25,110 B.
- A prefix-stability suite keeps non-dynamic sections byte-identical across selection, next step and next turn.
- Upstream v0.5.6 is merged, along with fixes for a backlog of upstream issues (#1026, #1027, #975, #803, #798, #771 and more).

See the [changelog](docs/CHANGELOG.md) and the [1.0.0 release notes](docs/release-notes/v1.0.0.md).

## Install

Requires DSH **0.2.2-rc.1** or later, below 0.2.3 (`engines.dsh`: `>=0.2.2-rc.1 <0.2.3-0`).

**Plugin marketplace**: search for `dsh-ops-pro` in the DSH plugin marketplace, install and enable it. If the official npm registry is unreachable, enter a mirror as a custom address, e.g. `https://mirrors.huaweicloud.com/repository/npm/`.

**Command line** (a profile must be named):

```console
npx --yes dsh-ops-pro@latest install --profile desktop   # or web, tui
npx --yes dsh-ops-pro@latest status --profile desktop
npx --yes dsh-ops-pro@latest uninstall --profile desktop
```

The official CLI works too: `dsh plugin --profile web add dsh-ops-pro`. The desktop profile needs the CLI bundled with the desktop app (default `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`); pass `--dsh-cli <path>` for other locations and `--dry-run` to preview. To update, rerun the same `install`, or `add dsh-ops-pro@latest` and reload or restart when prompted. Binary locations and cleanup boundaries: [Upgrading and uninstalling](docs/upgrading.md).

**Migrating from `dsh-ops`**: both publish the same `ops_*` tools and cannot be enabled together. Remove `dsh-ops` first, then add `dsh-ops-pro`. The plugin row is now `dsh-ops-pro` and old row settings are not migrated; the only command is `dsh-ops-pro`; integrators import `dsh-ops-pro/integration`. The state directory `<DSH_HOME>/dsh-ops/` and the `ops_` tool prefix are unchanged.

## Documentation

- [Usage](docs/usage.md) · [Troubleshooting](docs/troubleshooting.md) · [Configuration reference](docs/configuration-reference.md) · [Presets](docs/presets.md) · [Upgrading](docs/upgrading.md)
- [PTC design](docs/native-ptc.md) · [Windows runtime evidence](docs/windows-runtime-evidence.md) · [TUI panel](docs/tui-panel.md)
- [Contributing](docs/CONTRIBUTING.md) · [Changelog](docs/CHANGELOG.md) · [Provenance](docs/PROVENANCE.md)

## Development

```console
npm ci --ignore-scripts
npm run build:ptc        # build the plugin and stage the Rust worker (needs cargo)
node test/run.mjs        # every suite; node test/run.mjs <filter> runs matching suites
npm run env:probe        # name missing local test prerequisites
```

Rules and workflow: [Contributing](docs/CONTRIBUTING.md). Report issues to [this repository](https://github.com/IsaacHuo/dsh-ops-pro/issues).

## Relationship to upstream

dsh-ops-pro derives from [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops). The plugin's foundations — the Native and PTC projections, the Rust worker, the Niubash integration, presets and discovery — and most code before 0.5.6 come from the upstream maintainers [T-Auto](https://github.com/T-Auto), [ccch1mneyyy](https://github.com/ccch1mneyyy), [Haoming9527](https://github.com/Haoming9527), [Thatgfsj](https://github.com/Thatgfsj) and [all upstream contributors](https://github.com/T-Auto/dsh-ops/graphs/contributors). Thank you.

Upstream fixes are absorbed with `cherry-pick -x`, keeping the original commit and author; `npm run sync:upstream` reports unabsorbed upstream commits and PRs, and decisions are recorded in [.github/upstream-decisions.json](.github/upstream-decisions.json). This is not an official upstream distribution; report problems here.

## License and third-party components

MIT, see [LICENSE](LICENSE): the upstream copyright notice (Copyright (c) 2026 T-Auto and the dsh-ops contributors) is retained and this fork's notice is added.

The Niubash v1.5.0 payload shipped on Windows and its WinuxCmd, Git and other components keep their own licenses; their original licenses and source records ship with the payload. The MIT grant replaces no third-party license; see [NOTICE](NOTICE).

Upstream versions before `0.3.2` vendored FastCtx by [yc-duan](https://github.com/yc-duan) (Apache-2.0). This distribution contains no FastCtx code or binary; its license text stays in `licenses/fastctx/` and the required notice is kept:

> This product includes FastCtx
> (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
> used under the Apache License 2.0.
>
> FastCtx is redistributed and/or modified here by the maintainer of
> this distribution. Any such change is that maintainer's own work
> and their sole responsibility. It is not endorsed by, not
> supported by, and not attributable to the author of FastCtx, who
> accepts no liability of any kind arising from this distribution or
> from anything built on top of it.
