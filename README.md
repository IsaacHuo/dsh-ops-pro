<p align="center"><strong>中文</strong> | <a href="README.en.md">English</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ops-pro"><img alt="npm" src="https://img.shields.io/npm/v/dsh-ops-pro?style=flat-square&color=6c5ce7"></a>
  <a href="https://github.com/IsaacHuo/dsh-ops-pro/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/IsaacHuo/dsh-ops-pro/ci.yml?branch=pro%2Fnext&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-4b6fff?style=flat-square"></a>
</p>

# dsh-ops-pro

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的工具增强插件：用输入输出更小、失败反馈更明确的 `ops_*` 工具替代部分官方工具，减少 token 消耗与任务轮数。Windows x64 是主要平台，Linux x64 与 macOS（arm64/x64）同样受支持。

由 [IsaacHuo](https://github.com/IsaacHuo) 维护。本项目源自 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)，以独立的 npm 包 `dsh-ops-pro` 发布，自 1.0 起按自己的架构演进；与上游的关系与版权见[文末](#与上游的关系)。

## 功能

- **Windows Bash**：`ops_bash` 随包附带 Niubash 1.5.0 运行时，可隐藏宿主 PowerShell 工具；也可改用本机 Git Bash 或 WSL。
- **文件与搜索工具**：由 Rust worker 实现，PTC SDK 目录包含 18 个 API：15 个文件/文档工具，加批处理、结果引用和加载器。结果分页并标明是否完整，失败以结构化错误（`status`、`error.code`）返回。
- **预设**：minimal、standard、ptc、ops-ptc 等内置模式，可按预设隐藏被替代的官方工具。
- **OPS-PTC**：在一个 `run_code` 程序里批量调用工具。批处理规则在第一个根结果里教一次；之后依据程序实际发出的调用给出提示，每会话最多 3 条。
- **按需加载**：专项工具按需加载；选择工具前后发现区段字节不变，提示词缓存不失效。

## 1.0 的主要变化

- 宿主接触点集中在 `src/adapter/dsh/`，`npm run check:host` 在 CI 中按基线约束其余位置。
- 批处理提示改为依据实际调用判断，不再用正则分析代码。
- PTC SDK 声明里每个工具的数据结构只渲染一次，加载 glob/grep/read_files 的增量从 25,110 B 降到 13,339 B。
- 前缀稳定性测试保证选择工具、下一步、下一轮之间的非动态段字节不变。
- 合并上游 v0.5.6，并修复上游积压的一批问题（#1026、#1027、#975、#803、#798、#771 等）。

完整列表见[变更日志](docs/CHANGELOG.md)与 [1.0.0 发布说明](docs/release-notes/v1.0.0.md)。

## 安装

需要 DSH **0.2.2-rc.1** 及以上、低于 0.2.3（`engines.dsh`: `>=0.2.2-rc.1 <0.2.3-0`）。

**插件市场**：在 DSH 插件市场输入包名 `dsh-ops-pro` 安装并启用。无法直连 npm 官方源时，可在自定义地址填写镜像，例如 `https://mirrors.huaweicloud.com/repository/npm/`。

**命令行**（必须显式选择 profile）：

```console
npx --yes dsh-ops-pro@latest install --profile desktop   # 或 web、tui
npx --yes dsh-ops-pro@latest status --profile desktop
npx --yes dsh-ops-pro@latest uninstall --profile desktop
```

也可以直接用官方 CLI：`dsh plugin --profile web add dsh-ops-pro`。桌面端须使用桌面应用自带的 CLI（默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`），其它位置用 `--dsh-cli <路径>` 指定；加 `--dry-run` 可只预演。更新：重新运行同一条 `install`，或 `add dsh-ops-pro@latest` 后按提示重载或重启。二进制位置与清理边界见[升级与卸载](docs/升级与卸载.md)。

**从 `dsh-ops` 迁移**：两者发布同一组 `ops_*` 工具，不能同时启用。先 `remove dsh-ops`，再 `add dsh-ops-pro`。插件行改名为 `dsh-ops-pro`，原行的设置不会自动迁移；命令行只有 `dsh-ops-pro`；集成方导入路径改为 `dsh-ops-pro/integration`。状态目录 `<DSH_HOME>/dsh-ops/` 与 `ops_` 工具前缀不变。

## 文档

- [使用指南](docs/使用指南.md) · [常见问题](docs/常见问题.md) · [配置参考](docs/配置参考.md) · [预设与默认模式](docs/预设与默认模式.md) · [升级与卸载](docs/升级与卸载.md)
- [PTC 设计与使用](docs/native-ptc.md) · [第三方预设集成接口](docs/集成接口.md) · [Windows 运行时证据](docs/windows-runtime-evidence.zh.md) · [TUI 侧栏](docs/tui-panel.zh.md)
- [贡献指南](docs/贡献指南.md) · [变更日志](docs/CHANGELOG.md) · [溯源记录](docs/PROVENANCE.md)

## 开发

```console
npm ci --ignore-scripts
npm run build:ptc        # 构建插件并暂存 Rust worker（需要 cargo）
node test/run.mjs        # 全部套件；node test/run.mjs <filter> 只跑匹配的套件
npm run env:probe        # 列出本机缺失的测试前置条件
```

规则与流程见[贡献指南](docs/贡献指南.md)。问题与建议请提交到 [本仓库的 Issues](https://github.com/IsaacHuo/dsh-ops-pro/issues)。

## 与上游的关系

dsh-ops-pro 源自 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)。插件的基础设计（Native 与 PTC 两种投影、Rust worker、Niubash 集成、预设与发现机制）以及 0.5.6 之前的大部分代码来自上游维护团队 [T-Auto](https://github.com/T-Auto)、[ccch1mneyyy](https://github.com/ccch1mneyyy)、[Haoming9527](https://github.com/Haoming9527)、[Thatgfsj](https://github.com/Thatgfsj) 与[全体上游贡献者](https://github.com/T-Auto/dsh-ops/graphs/contributors)，在此致谢。

本分支吸收上游修复时用 `cherry-pick -x` 保留原提交与作者；`npm run sync:upstream` 报告尚未吸收的上游提交与 PR，取舍记录在 [.github/upstream-decisions.json](.github/upstream-decisions.json)。本项目不是上游的官方发行版，问题请报告到本仓库。

## 许可与第三方组件

MIT 许可，见 [LICENSE](LICENSE)：保留上游版权声明（Copyright (c) 2026 T-Auto and the dsh-ops contributors），并增加本分支的版权声明。

Windows 随包的 Niubash v1.5.0 及其 WinuxCmd、Git 等组件分别遵循各自的许可证，原始许可证与来源记录随载荷保留；MIT 许可不替代任何第三方许可，详见 [NOTICE](NOTICE)。

`0.3.2` 之前的上游版本曾内置 [yc-duan](https://github.com/yc-duan) 的 FastCtx（Apache-2.0）；当前发行版不含任何 FastCtx 代码或二进制，其许可文本保留在 `licenses/fastctx/`，并按要求保留以下声明：

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
