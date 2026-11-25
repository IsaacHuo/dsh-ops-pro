# 1.1.0 release candidate

> Release record for `dsh-ops-pro` 1.1.0 on branch `release/1.1.0`. The tag, the npm publication and
> the merge to `main` are separate steps that need the maintainer's confirmation; this document
> records what was verified before them.

## Contents of the release

1.1.0 adds one capability module and two operator surfaces to the 1.0.0 architecture release. The tool
kernel, the native and PTC projections, the configuration schema and the runtime receipt mechanism are
unchanged.

- **Computer use (Windows only, off by default).** The `dsh-computer-use-win` 0.6.3 runtime (MIT,
  Yu-tao-Li and cgissing, pinned to commit `acfb689`) is vendored, reassembled byte-identically by
  `npm run build`, and exposed as 26 `ops_cu_*` tools through one persistent host child process.
  Identification is structure first — the Windows UI Automation tree for desktop windows, the page
  accessibility tree over CDP for the browser lane — with screenshot, OCR and coordinate actions as a
  documented fallback for surfaces that publish no tree.
- **Sidebar console.** The Status, Computer use and Usage tabs read the row's own `opsSettings` remote;
  saving computer-use settings writes `<DSH_HOME>/dsh-ops/computer-use.json` and restarts only the
  computer-use runtime.
- **Usage statistics.** A global `tools/execute` listener counts every `ops_*` call per local day in
  `<DSH_HOME>/dsh-ops/usage.json`, 30 days retained, written at most every 5 s and atomically.
- **Fix.** A packaged runtime receipt that only disagrees on the version is now used with a warning
  instead of disabling every native tool; a digest, target or executable mismatch is still refused.

Product identity: the package, the command, the plugin id and the documentation all say
`dsh-ops-pro`. Log prefixes (`dsh-ops:`), the state directory (`<DSH_HOME>/dsh-ops/`) and the
`dsh-ops` compatibility entries required by existing profiles are unchanged.

## Inheritance and modification

| Upstream | What is used | How it is held |
| --- | --- | --- |
| [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops) | The tool kernel, native/PTC projections, configuration schema, test layout | Fork continues the lineage; `NOTICE` and `docs/PROVENANCE.md` record it |
| [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3, commit `acfb689` | The MCP server, browser lane, `windows-uia.ps1`, `windows-takeover.cs` | Vendored byte-identically, SHA-256 pinned in `vendor/computer-use/upstream.json`; files over the size gate are stored as line-range parts and reassembled by the build |
| [cgissing/windows-computer-use](https://github.com/cgissing/windows-computer-use) | Original desktop automation the above derives from | Recorded as derivative lineage in `vendor/computer-use/THIRD_PARTY.md` |

The DSH adapter (row entry, settings client, web routes), the activity overlay and the
background-desktop helper are not vendored; `src/components/computer-use/index.ts` and `src/cu/` are
this repository's own code. Upstream source is never patched in place: an upgrade re-vendors the whole
tree and re-pins the SHA-256 values.

## Verification

Run on Windows 11 x64, Node.js 24.19.0, DSH 0.2.2-rc.x checkout at this commit.

| Gate | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | pass — computer-use 0.6.3 `acfb689`, 34 files; PTC declarations 18 capabilities, 121,119 B |
| Types | `npm run typecheck` | pass |
| File size | `npm run check:size` | pass — 946 files, longest `native/crates/ops-files/src/file.rs` 950 lines |
| Host boundary | `npm run check:host` | pass — 168 touch points outside `src/adapter/dsh/` match the baseline |
| Manifest | `node scripts/validate-manifest.mjs` | pass — 94 checks, no version drift |
| Workflows | `node scripts/check-workflows.mjs` | pass — 123 checks |
| Docs facts | `node test/run.mjs docs-facts` | pass — 7 checks |
| Suites | `node test/run.mjs` | 296 of 306 pass, 7 skipped, 3 red for a missing local prerequisite (below) |
| Model-free bench | `node bench/cli.mjs tools` | 14 of 14 queries MATCH; timings within 0.96x–1.02x on the same binary |
| Package | `npm pack` | `dsh-ops-pro-1.1.0.tgz`, 66.0 MB packed, 127 MB unpacked, 1154 files, sha1 `0a1a15ea4decf0d9d2382ade2085e9e7ee35ebf5` |
| Install | `npm i --ignore-scripts` of the tarball into an empty project | pass — one package added, CLI and runtime/win32-x64 payload present |

Not run on this host, therefore not claimed:

- `npm run verify:release` (`bin/check-release.mjs`) needs all four staged runtimes; this host stages
  `win32-x64` only.
- `cargo test --workspace` and a rebuild of the native worker: no Rust toolchain (`npm run env:probe`
  reports `MISS cargo`); `npm run build:ptc` exits 0 reusing the previously staged worker.
- The 3 red suites need a local prerequisite, not code: `bash-ipc.test.mjs` and
  `bash-ipc-roots.test.mjs` need `DSH_OPS_TEST_BASH` (a pinned `bin/bash.exe`); CI stages it from
  the committed pin. `pwsh-upgrade.test.mjs` was red on the first run because the local payload had
  accumulated execution directories, and passes once they are removed; eight suites that need
  `DSH_OPS_NIUBASH_ARCHIVE` skip instead of passing.
- Cross-platform CI on Linux and macOS, and real-desktop acceptance. `docs/manual-validation.md` lists
  the 1.1.0 desktop steps that a mocked suite cannot cover.

## Known limits and risks

- Computer use is Windows only and ships off by default; enabling it starts one child process that
  stays resident until the row is disabled, the plugin unloads, or the host exits.
- The tree-first model has no tree for self-drawn surfaces (canvas, games, remote desktop); those fall
  back to OCR and coordinates, which are slower and less reliable by construction.
- A locally executed Niubash payload creates empty execution directories inside `runtime/win32-x64/niubash`
  and makes packaging reject the tarball until they are removed; the error names only the first unknown
  directory. CI stages the payload from the frozen archive and is unaffected.
- The published `package.json` still lists repository-only scripts (`build`, `test`, `verify`,
  `bench:*`) although `scripts/`, `test/` and `bench/` are not shipped; calling them in an installed
  copy fails. Install, upgrade and uninstall do not use them.
- Automatic takeover, approval prompts and the emergency stop are the upstream implementation
  unchanged; the console can edit settings but cannot originate an approval.

## Rollback

Reinstall the previous published version (`npm i dsh-ops-pro@1.0.1`) or check out `v1.0.1` and run
`dsh-ops-pro install --profile <profile>`. The state directory, log prefix and settings keys are
unchanged between 1.0.x and 1.1.0, so a rollback keeps existing settings; `computer-use.json` and
`usage.json` remain on disk and are ignored by 1.0.x.

## Checklist

- [x] Version metadata aligned (`package.json`, `package-lock.json`, `dsh-plugin.json`, `native/Cargo.toml`,
      `native/Cargo.lock`, staged runtime receipt) — `validate-manifest` clean
- [x] Vendored upstream recorded with version, commit, license and authors — `docs/PROVENANCE.md`, `NOTICE`
- [x] Documentation aligned with behaviour — README pair, `docs/computer-use` pair, configuration and
      troubleshooting pairs, usage, upgrade, roadmap, manual acceptance, index
- [x] CHANGELOG `## [Unreleased]` entry present
- [x] Local gates green for build, types, size, host boundary, manifest, workflows, docs facts, package
      and clean-room install
- [x] Release branch gated by CI on push (`.github/workflows/ci.yml` covers `release/*`)
- [ ] Linux and macOS CI green on this commit
- [ ] `npm run verify:release` with all four staged runtimes
- [ ] `cargo test --workspace` on a host with a Rust toolchain
- [ ] Real-desktop acceptance per `docs/manual-validation.md` on Windows 11
- [ ] Maintainer confirmation to tag, publish and merge

## Verdict

**GO for a release candidate, conditional on the four unchecked items.** The package builds, validates,
packs and installs in a clean room; identity and provenance are consistent; no gate reports a false
pass. The tag should be cut only after cross-platform CI, `verify:release` on a machine with all
staged runtimes, the Rust workspace tests and one real-desktop acceptance run are recorded green, and
the maintainer confirms publication.
