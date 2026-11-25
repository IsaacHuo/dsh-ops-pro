# Vendored computer-use runtime / 内置 computer-use 运行时

Source: <https://github.com/Yu-tao-Li/dsh-computer-use-win>, pinned commit and version in
[`upstream.json`](upstream.json) (`acfb689`, 0.6.3). MIT, copyright Yu-tao-Li and cgissing;
the license and upstream provenance ship in `licenses/computer-use/`.

- **What is here:** the MCP stdio server (`mcp/`), the PowerShell UI Automation backend and
  its precompiled .NET Framework helpers (`scripts/`), and the upstream suites that need no
  live desktop (`test/`). The upstream DSH adapter (`mcp/dsh-plugin.mjs`), settings client
  (`mcp/client.js`), DSH restart/update routes and documentation are not vendored: dsh-ops-pro
  hosts the server itself (`src/components/computer-use/`).
- **Never edited.** Every file is byte-identical to upstream and pinned by SHA-256.
  `mcp/server.mjs`, `mcp/browser.mjs`, `scripts/windows-uia.ps1` and
  `scripts/windows-takeover.cs` exceed the repository's 1000-line gate, so they are stored as
  `<name>.partN.<ext>` line ranges. `npm run build` concatenates the parts into
  `lib/computer-use/` and refuses any file whose digest differs. The parts are not standalone
  modules.
- **Updating:** re-vendor from a new upstream commit (copy the same file list, re-cut the long
  files at blank lines before a declaration, rewrite `upstream.json`), never patch in place.
  Behaviour changes go upstream first.

---

来源与固定提交见 [`upstream.json`](upstream.json)（`acfb689`，0.6.3），MIT 许可，版权方为 Yu-tao-Li 与
cgissing，许可证与上游来源说明随包放在 `licenses/computer-use/`。

- **内容**：MCP stdio 服务端（`mcp/`）、PowerShell UIA 后端及预编译的 .NET Framework 辅助 DLL
  （`scripts/`）、不需要真实桌面的上游测试（`test/`）。上游的 DSH 适配器、设置页客户端、DSH
  重启/更新路由和文档不搬，由 dsh-ops-pro 自己托管服务端（`src/components/computer-use/`）。
- **从不手改**：每个文件都与上游逐字节一致并用 SHA-256 固定。超过 1000 行的四个文件按行切成
  `<名>.partN.<扩展名>`，`npm run build` 拼回 `lib/computer-use/`，摘要不符即拒绝构建。片段本身不是
  独立模块。
- **升级**：从新的上游提交整体重新搬运并重写 `upstream.json`，不要原地打补丁；行为修改先提到上游。
