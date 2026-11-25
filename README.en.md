<p align="center">
  <a href="https://www.npmjs.com/package/@huoweifang/dsh-ops-pro"><img alt="npm" src="https://img.shields.io/npm/v/@huoweifang%2Fdsh-ops-pro?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/@huoweifang/dsh-ops-pro"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@huoweifang%2Fdsh-ops-pro?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/IsaacHuo/dsh-ops-pro/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/IsaacHuo/dsh-ops-pro?style=flat-square&color=eab308"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@huoweifang%2Fdsh-ops-pro?style=flat-square&color=2ea44f"></a>
</p>

# dsh-ops-pro

A tool runtime for DSH: ops_bash on Windows, Rust file, search and batch tools across platforms, batched OPS-PTC calls, plus opt-in Windows desktop and browser computer use, a sidebar console and usage statistics.

<p align="center">
  <strong>English</strong> | <a href="README.md">中文</a>
</p>

OPS adds bounded file and document tools to DSH. Native mode returns compact, line-numbered text;
PTC code receives typed Outcome values from the same one-shot Rust worker. Host integration is
strict TypeScript, compiled to the existing JavaScript package paths.

The project started from [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops) and has since gone through substantial independent development and architecture evolution; since 1.1.0 it integrates the Windows computer-use runtime of [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win). The goal is one DSH operations plugin with a unified architecture, low intrusion, low token cost and low maintenance burden.

- The single row enables the five built-in preset consumers: Standard and Cordis publish resident
  Native file tools, PTC publishes typed APIs, and Minimal has no resident file baseline. OPS PTC is
  the fifth enhanced preset, registered by the plugin at runtime (no plugin-manager preset row): it
  keeps the PTC surface and delivers the English batch-call guidance from `prompts/batching-guidance.md`:
  one lesson at session start, then short `additionalContexts` notices when a root `run_code` program
  breaks the `bypass`/`plan`/`shape` shape categories (each latched once per turn), without touching the
  system prompt and without blocking or rewriting the program. Native discovery and typed SDK loading are
  independently configured.
  Advanced selections activate in the owning agent's next provider request, never by executing a
  discovery action. The default preset is never forced: the row's detail page carries one button that makes OPS (PTC)
  the default for new sessions, once, and apply, remount and unload leave your own default alone. See
  [presets](docs/presets.md).
- The PTC SDK catalogue has 18 APIs: 15 file/document tools, batch, result references and its loader.
  Only the configured resident or selected APIs are exposed. Native and PTC use separate outputs.
- Discover bounded CSV/TSV, DOCX main-body paragraphs and a restricted PDF text layer. Binary DOC,
  OCR, general PDF rendering, web search and HTML crawling are not implemented. Read the
  [document-format limits](docs/native-kernel.md) before choosing a reader.
- One native-switch configuration page controls built-in and explicitly listed custom consumers.
  Global switches gate per-preset choices without losing saved intent. Residency, dynamic loading,
  Bash, file replacement and Windows host-PowerShell hiding are independently controlled; panel
  capture and TUI start off. Custom presets use the same assembler as built-ins, while unlisted
  presets remain unchanged. Move legacy row overrides into the single row; the Compatibility row
  is removed. See [settings](docs/configuration-reference.md) and [architecture](docs/internal-architecture.md).
- Built-in preset consumers are enabled by default: on Windows the package embeds the pinned
  **official Niubash 1.5.0 portable payload** and downloads no Git Bash optional package; the
  settings page's **Bash executor** card switches between that payload and a Git Bash/MSYS
  executable you scan or type in (saved as `bashPath`). Linux/macOS use the distribution's own
  Bash, overridable with `config.bashPath`. `dsh-ops-pro bash-runtime install` remains the path for
  installing, repairing and selecting a managed copy. PowerShell stays host-managed; its upgrade
  command previews the standard installation and requires `--yes` to execute.

OPS publishes its own scoped tools and optional routing guidance; it does not rewrite the shared
tool registry. Permissions and cancellation are checked per call. Windows restricted Bash retains
its documented partial enforcement and runtime-compatibility limits.

Historical token-saving claims are not evidence that this candidate meets its release gates.
The name “ops” means general operations, not an operations/SRE product.

## Requirements

| Platform | Requirement |
| --- | --- |
| Windows | 10 / 11 x64; Windows PowerShell 5.1 (shipped with Windows); Edge or Chrome when computer use is enabled |
| Linux | x64 |
| macOS | 13+ on Apple Silicon or Intel (`darwin-arm64`, `darwin-x64`); see [macOS](docs/macos.md) |

Every executable part ships inside the npm package: the prebuilt native worker, the ~100 MB bash payload and the built-in computer-use runtime. Nothing has to be downloaded or installed afterwards; the npm and marketplace install paths deliver the same contents.

Nothing beyond these requirements is a dependency. Computer use reads the Windows UI Automation tree (shipped with Windows) and drives Edge or Chrome over CDP; neither needs a separately installed MCP server or browser extension.

## Install, update and uninstall

### Official plugin marketplace

> Migrating from the unscoped `dsh-ops-pro`: since 1.1.1 the npm package is **`@huoweifang/dsh-ops-pro`** and
> the old name is deprecated. The row id, executable and state directory are unchanged; `install --profile`
> removes the old dependency before adding the scoped package. See [upgrade and uninstall](docs/upgrading.md#upgrading-from-the-unscoped-110-to-111).

> Migrating from `dsh-ops`: both packages publish the same `ops_*` tools and cannot be enabled together. Remove `dsh-ops` first, then install this package; see [upgrading](docs/upgrading.md).

In the target DSH application's plugin marketplace, enter the npm package name **`@huoweifang/dsh-ops-pro`**, choose a custom registry and enter `https://mirrors.huaweicloud.com/repository/npm/`, install, then enable it. Installing through npmmirror is currently not recommended — it has bugs.

Of course, if you are sure you can reach the official npm registry, pick the official registry; if you are not sure, follow the steps above.

![Choose a custom registry in the plugin marketplace and enter the Huawei Cloud npm mirror](docs/assets/marketplace-huaweicloud-mirror.png)

### One-command npm installation

#### Installation

```console
npx --yes @huoweifang/dsh-ops-pro@latest install --profile desktop
npx --yes @huoweifang/dsh-ops-pro@latest install --profile web
npx --yes @huoweifang/dsh-ops-pro@latest install --profile tui
```

An explicit target profile is required. `tui` maps to the **dsh-TUI product's `dsh-tui` profile**, not the old `tui` directory. Initialize the target application first. This entry point delegates installation to the official DSH CLI rather than implementing a separate profile lock and rollback logic.

Desktop must use the CLI bundled with the desktop application; the default auto-detected path is `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`. For another installation location, add `--dsh-cli "<installation>\resources\runtime\cli\bin\dsh.cmd"`. Web/TUI require an available DSH CLI, which can also be specified explicitly.

Add `--dry-run` to an install or uninstall command to preview it. The preview resolves the CLI from its path or `PATH` (`PATHEXT` on Windows), checks the file, POSIX execute permission and any Node CLI entry point, and applies the same Windows command-script path checks as execution. A failed check returns a nonzero exit code. The preview prints the plan without starting the CLI or changing the profile. Success covers these static checks; it does not establish the program's identity, version, profile compatibility or eventual installation result.

You can also use the official commands directly:

```console
dsh plugin --profile web add @huoweifang/dsh-ops-pro
dsh plugin --profile dsh-tui add @huoweifang/dsh-ops-pro
"<desktop installation>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @huoweifang/dsh-ops-pro
```

A regular DSH CLI cannot manage the reserved `desktop` profile; do not confuse it with the desktop app's own entry point.

Install the published registry package or a fully built and packed source tarball.
Direct `git+https` installation and unbuilt source checkouts lack the complete runtime; see
[installing from Git is not a supported channel](docs/upgrading.md#installing-from-git-is-not-a-supported-channel).

#### Update

The 0.5 series supports DSH **from 0.2.2-rc.1**, not 0.2.0/0.2.1 or earlier 0.2.2 previews. The DSH adapter remains; integration uses the native 0.2.2 tool-admission and executor APIs. See
[host versions and display metadata](docs/usage.md#host-compatibility-and-display-metadata)
for component icon exports, profile refresh and config/schema checks.

Re-run the same `npx --yes @huoweifang/dsh-ops-pro@latest install --profile ...`, or use the official CLI `add @huoweifang/dsh-ops-pro@latest`. Reload when the app asks; restart the app when replacing code that is already loaded.

#### Uninstall and status

```console
npx --yes @huoweifang/dsh-ops-pro@latest status --profile desktop
npx --yes @huoweifang/dsh-ops-pro@latest uninstall --profile desktop
```

Replace `desktop` with `web` or `tui` as needed. You can also uninstall from the marketplace, or run the official `dsh plugin --profile ... remove @huoweifang/dsh-ops-pro`. Profile uninstall removes plugin dependency references, including the optional Windows Bash payload. Remove separately provisioned Bash with `dsh-ops-pro bash-runtime remove --yes`; this does not delete the system shell, copies in other profiles, or the package manager's shared cache.

Old files explicitly provisioned by earlier versions under `<DSH_HOME>/dsh-ops/` (provisioned shells, and the FastCtx runtime earlier versions could provision) need separate cleanup: `npx --yes @huoweifang/dsh-ops-pro@latest uninstall --yes`. The `~/.fastctx/` state left by the removed background component is not deleted by default; add `--purge-fastctx` when needed.

The former `dsh-ops/background` component (FastCtx background jobs) has been removed. A profile that still has its row keeps loading: the row publishes nothing and logs one warning, and can be deleted.

## Optional read-only OPS sidebar

Enable `tui.enabled` on the `dsh-ops` row in dsh-TUI and restart to add the OPS sidebar without stealing focus or executing tools. Without `tuiPanels`, only that optional row stays pending. See [Sidebar guide](docs/tui-panel.md). While focused, use `f` to filter, `n`/`p` for local pages and `a` to acknowledge all-session alerts; only bounded retained metadata is browsed, never fetched result pages.

## Computer use

The `computer-use` configuration section publishes 26 `ops_cu_*` tools on Windows, covering desktop programs and Chromium browsers. It is off by default.

- Identification is structure-first: the desktop lane reads the Windows UI Automation element tree, the browser lane reads the page accessibility tree. Element ids then go straight into click, set-value, invoke and scroll calls; screenshot coordinates are only a fallback when no semantic node exists.
- Two lanes: desktop windows, and the browser lane (Edge or Chrome). The browser lane can attach to the user's own browser and work with the tabs they are already signed in to.
- Source: the built-in dsh-computer-use-win 0.6.3 (MIT, pinned commit `acfb689`); tool names change from `mcp__wincu__windows_computer_use_*` to `ops_cu_*`.
- Browser choice: Edge and Chrome have the same capability. The difference is launch order and profile mode (throwaway profile, kept sign-ins, or the user's own browser). Other Chromium browsers connect through environment variables; that is optional configuration, not a dependency.

Settings, the tool list, element-id rules and known issues are in [computer use](docs/computer-use.md).

## Documentation

- [Documentation index](docs/README.md): every technical document grouped by purpose, with bilingual pairs marked.

- [Third-party preset integration API](docs/integration-api.md) · [External Native providers](docs/external-provider.md) · [Scoped diagnostics](docs/diagnostics.md)

- [Usage](docs/usage.md) · [Troubleshooting](docs/troubleshooting.md) · [Component reference](docs/component-reference.md) · [Configuration reference](docs/configuration-reference.md) · [Presets](docs/presets.md)
- [Computer use, sidebar console and usage statistics](docs/computer-use.md): requirements, settings, tools and the element identification model.
- [Windows runtime evidence](docs/windows-runtime-evidence.md): payload compatibility, Low integrity, MSYS startup and antivirus/approval diagnostics.
- [Native PTC](docs/native-ptc.md) · [Manual validation](docs/manual-validation.md)
- [Contributing](docs/CONTRIBUTING.md) · [Roadmap](docs/roadmap.md) · [Changelog](docs/CHANGELOG.md) · [Provenance](docs/PROVENANCE.md)
- [CI troubleshooting](docs/ci-troubleshooting.md) · [CI 排错说明](docs/ci-troubleshooting.zh.md)

## Windows Bash diagnostics

Windows Bash diagnostics: `dsh-ops-pro ladder` reports image and ancestor integrity
labels separately from static MSYS hash compatibility. A Low-labelled executable
can start a Low child even in full access, preventing writes to existing
Medium/unlabeled files. Unreadable labels remain unknown. See
[integrity inspection](docs/troubleshooting.md#windows-bash-integrity-labels).

## License

The current dsh-ops-pro source is distributed under the **MIT License**; see [LICENSE](LICENSE). Versions before 0.3.2 bundled Apache-2.0-licensed FastCtx source; that source was removed together with the background component, and no FastCtx code or binary is part of the current distribution. FastCtx's license text and upstream notice are retained in `licenses/fastctx/`, and its historical attribution is preserved in [NOTICE](NOTICE).

The separate Windows Bash payload package (the npm optional dependency `@dsh-ops/bash-win32-x64`) is distributed under its upstream components' licenses: Git for Windows includes GPL-2.0 and other licensed components, whose original licenses, notices and provenance records are kept with the payload. PowerShell stays host-managed and is distributed under Microsoft's MIT and third-party component licenses. The plugin's MIT license does not replace those licenses. See [PROVENANCE.md](docs/PROVENANCE.md).

## Acknowledgements

Origin and versions: the project started from [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops) and since 1.1.0 integrates the runtime of [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win); versions, commits and SHA-256 pins are recorded in [docs/PROVENANCE.md](docs/PROVENANCE.md).

Versions before 0.3.2 bundled and distributed [yc-duan](https://github.com/yc-duan)'s Codex plugin FastCtx and used its source code to provide the Rust tool surface. FastCtx's source was removed with the background component; the current `native/` Rust core is original MIT-licensed dsh-ops code. FastCtx's license text and the notice that must be reproduced remain in `licenses/fastctx/` and [NOTICE](NOTICE) as attribution for those earlier versions:

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

## Maintainers

<table>
  <tbody>
    <tr>
      <td align="center" width="150"><a href="https://github.com/IsaacHuo"><img src="https://github.com/IsaacHuo.png?size=160" width="96" height="96" alt="IsaacHuo"></a><br><a href="https://github.com/IsaacHuo"><b>IsaacHuo</b></a></td>
    </tr>
  </tbody>
</table>

---

## Contributors

[![Contributors](https://contrib.rocks/image?repo=IsaacHuo/dsh-ops-pro)](https://github.com/IsaacHuo/dsh-ops-pro)

## Star trend

[![Star trend chart](https://api.star-history.com/svg?repos=IsaacHuo/dsh-ops-pro&type=Date)](https://star-history.com/#IsaacHuo/dsh-ops-pro&Date)
