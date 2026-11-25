# 文档索引 / Documentation index

本目录按用途分组。标注「中/英」的条目是同一文档的双语对，内容一致：中文文件名或 `.zh.md` 后缀为中文版，另一份为英文版。
This directory groups documents by purpose. Entries marked 中/英 are bilingual pairs of the same document: the Chinese filename or `.zh.md` suffix is the Chinese version, the other file is English.

## 入门 / Getting started

| 文档 / Document | 内容 / What it covers | 语言 / Language |
| --- | --- | --- |
| [使用指南](使用指南.md) · [Usage](usage.md) | 组件与默认值、安装、CLI、更新配置、Native 文件结果 | 中/英 |
| [配置参考](配置参考.md) · [Configuration reference](configuration-reference.md) | 单行开关、各组件配置键、磁盘与预设 | 中/英 |
| [预设与默认模式](预设与默认模式.md) · [Presets](presets.md) | 五个预设的差异与切换方式 | 中/英 |
| [组件参考](组件参考.md) · [Component reference](component-reference.md) | 每个工具的参数、权限与输出契约 | 中/英 |
| [常见问题](常见问题.md) · [Troubleshooting](troubleshooting.md) | 症状 → 原因 → 处理 | 中/英 |
| [升级与卸载](升级与卸载.md) · [Upgrade and uninstall](upgrading.md) | 0.5.x 与无 scope 1.1.0 → 1.1.1 迁移、回滚、状态文件 | 中/英 |

## 电脑操控 / Computer use

| 文档 / Document | 内容 / What it covers | 语言 / Language |
| --- | --- | --- |
| [电脑操控、侧边栏控制台与用量统计](computer-use.zh.md) · [Computer use](computer-use.md) | 系统要求、配置项、26 个工具、元素识别模型、浏览器通道、限制 | 中/英 |
| [Windows 运行时证据](windows-runtime-evidence.zh.md) · [Windows runtime evidence](windows-runtime-evidence.md) | 载荷兼容、Low 完整性、MSYS 启动、杀软与审批排查 | 中/英 |
| [Windows 安全回归](Windows安全回归.md) · [Windows security regressions](windows-security-regressions.md) | 提权、接管与权限边界的回归记录 | 中/英 |

## 架构 / Architecture

| 文档 / Document | 内容 / What it covers | 语言 / Language |
| --- | --- | --- |
| [内部架构](内部架构.md) · [Internal architecture](internal-architecture.md) | 组件行、kernel、projections、生命周期 | 中/英 |
| [原生内核](原生内核.md) · [Native kernel](native-kernel.md) | Rust worker 的请求、选择与溯源校验 | 中/英 |
| [宿主集成](宿主集成.md) · [Host integration](host-integration.md) | Host Adapter 边界与 `ctx.inject`/`ctx.get` 规则 | 中/英 |
| [集成接口](集成接口.md) · [Integration API](integration-api.md) | 第三方预设可用的公开接口 | 中/英 |
| [外部工具提供者](外部工具提供者.md) · [External Native providers](external-provider.md) | 外部 Native 提供者协议 | 中/英 |
| [集成诊断](集成诊断.md) · [Scoped diagnostics](diagnostics.md) | 作用域发现与诊断输出 | 中/英 |
| [工具发现](工具发现.md) · [Discovery](discovery.md) | 渐进式披露的发现流程 | 中/英 |
| [动态工具目录](动态工具目录.md) · [Dynamic tool directory](dynamic-tool-directory.md) | 运行时工具目录与 `allowedTools` | 中/英 |
| [工具执行管线分析](工具执行管线分析.md) | 从模型调用到 worker 的完整管线 | 中 |
| [DSH 工具注入实现拆解](DSH工具注入实现拆解.md) | 宿主工具注入机制拆解 | 中 |
| [DSH 渐进式披露机制查证](DSH渐进式披露机制查证.md) | 披露机制的行为查证 | 中 |

## 工具与协议 / Tools and contracts

| 文档 / Document | 内容 / What it covers | 语言 / Language |
| --- | --- | --- |
| [Native 输出](Native输出.md) · [Native output](native-output.md) | 行号、截断、引用与恢复 | 中/英 |
| [PTC 按需加载](PTC按需加载.md) · [Progressive PTC SDK loading](ptc-sdk-loading.md) | SDK 加载器、类型生成、加载边界 | 中/英 |
| [PTC 结果契约](PTC结果契约.md) · [PTC result contracts](ptc-outcomes.md) | Outcome 形状、分页、释放 | 中/英 |
| [文件读写契约](文件读写契约.md) · [File read and mutation contracts](file-contracts.md) | 读写、原子写、冲突检测 | 中/英 |
| [文件批量操作](文件批量操作.md) · [File batching](file-batching.md) | 批处理、回滚与结果引用 | 中/英 |
| [紧凑文件范围](紧凑文件范围.md) · [Compact Native file ranges](native-ranges.md) | 范围读取与行边界 | 中/英 |
| [结果预算与会话生命周期](结果预算.md) · [Result budgets and session lifetime](result-budgets.md) | 30 秒上限、FIFO 队列、会话回收 | 中/英 |
| [上下文读取去重](上下文读取去重.md) · [Context-aware read deduplication](context-read-dedup.md) | 重复读取的抑制规则 | 中/英 |
| [搜索覆盖范围](搜索覆盖范围.md) · [Search coverage](search-coverage.md) | 搜索工具覆盖的文件类型与边界 | 中/英 |
| [搜索性能诊断](搜索性能诊断.md) · [Search performance](search-performance.md) | 搜索耗时与诊断方法 | 中/英 |
| [成本分账](成本分账.md) | OPS-PTC 的四本成本账 | 中 |
| [隔离测试入口](隔离测试入口.md) | 隔离执行的测试入口 | 中 |
| [文档解析依赖审查](文档解析依赖.md) · [Document parser dependency review](document-dependencies.md) | DOCX/PDF worker 的依赖边界 | 中/英 |

## 跨平台 / Cross-platform

| 文档 / Document | 内容 / What it covers | 语言 / Language |
| --- | --- | --- |
| [macOS](macos.zh.md) · [macOS](macos.md) | macOS 13+ 的构建、权限与验证 | 中/英 |
| [Linux 构建](linux构建.md) · [Linux build](linux-build.md) | musl 静态构建与产物检查 | 中/英 |
| [WSL 只读文件操作](WSL只读文件操作.md) · [Optional WSL file reads](wsl-readonly.md) | `\\wsl.localhost` 前缀决策与边界 | 中/英 |
| [Bash 与 PowerShell 共存](Bash与PowerShell共存.md) · [Bash and PowerShell coexistence](shell-coexistence.md) | 两个 Bash 后端与 PowerShell 的关系 | 中/英 |
| [Windows 索引依赖](windows-index-dependencies.zh.md) · [Windows index dependencies](windows-index-dependencies.md) | Windows 索引的依赖与限制 | 中/英 |
| [Windows 索引提权](windows-index-elevation.zh.md) · [Windows index elevation](windows-index-elevation.md) | 提权索引的行为与风险 | 中/英 |
| [索引依赖](index-dependencies.zh.md) · [Index dependencies](index-dependencies.md) | 三平台索引依赖总览 | 中/英 |
| [集成索引](index-integration.zh.md) · [Index integration](index-integration.md) | 索引与工具调用的接入 | 中/英 |
| [Linux 索引依赖](linux-index-dependencies.zh.md) · [Linux index dependencies](linux-index-dependencies.md) | Linux 索引依赖 | 中/英 |
| [Linux 索引限制](linux-index-limitations.zh.md) · [Linux index limitations](linux-index-limitations.md) | Linux 索引的已知限制 | 中/英 |
| [macOS 索引依赖](mac-index-dependencies.zh.md) · [macOS index dependencies](mac-index-dependencies.md) | macOS 索引依赖 | 中/英 |

## 运行与验证 / Operations and verification

| 文档 / Document | 内容 / What it covers | 语言 / Language |
| --- | --- | --- |
| [本地跑全量门禁](verify-locally.md) | `verify-gate.mjs` 每一步做什么、怎么读输出 | 英 |
| [CI](ci.md) | 四个 workflow 的分工 | 英 |
| [CI 排错](ci-troubleshooting.zh.md) · [CI troubleshooting](ci-troubleshooting.md) | 失败分类与复现命令 | 中/英 |
| [发布流程](release-process.md) | tag → Release → npm 的实际流程与前置条件 | 中 |
| [必需检查的管理配置](required-ci-admin.md) | 分支保护与必需检查 | 英 |
| [手动验收](手动验收.md) · [Manual validation](manual-validation.md) | 必须人工确认的检查项 | 中/英 |
| [审阅快照](审阅快照.md) · [Review snapshot](review-snapshot.md) | 审阅范围与快照方式 | 中/英 |
| [磁盘与缓存](磁盘与缓存.md) · [Disk and cache](disk-and-cache.md) | spill、保留期与清理 | 中/英 |
| [下载守卫](download-guard.zh.md) · [Download guard](download-guard.md) | 下载模板与拦截 | 中/英 |
| [TUI 面板](tui-panel.zh.md) · [TUI panel](tui-panel.md) | 可选 TUI 面板 | 中/英 |
| [只读活动投影](tui-activity.md) | 内部活动投影 | 英 |
| [提示注入防护](prompt-injection.zh.md) · [Prompt injection](prompt-injection.md) | 注入文本的处理规则 | 中/英 |
| [文件契约验收](文件契约验收.md) · [File contract validation](file-contract-validation.md) | 契约的验收用例 | 中/英 |

## 基准 / Benchmarks

| 文档 / Document | 内容 / What it covers | 语言 / Language |
| --- | --- | --- |
| [基准门禁](基准门禁.md) · [Scripted acceptance benchmarks](benchmark-gates.md) | 门禁基准的判据与运行方式 | 中/英 |
| [工具调用基准](工具调用基准.md) · [Real-corpus tool-call timing](benchmark-calls.md) | 真实语料上的调用耗时 | 中/英 |
| [索引 A/B 基准](索引AB基准.md) · [Index-versus-walk A/B evidence](benchmark-index-ab.md) | 索引与遍历的对照证据 | 中/英 |
| [PTC 声明成本](ptc-cost.md) | 声明开销测量（#170） | 英 |
| [Flash 对照 V5](Flash对照-V5.md) · [Flash comparison V5](flash-comparison-v5.md) | 与 Flash 的对照记录 | 中/英 |

## 治理与历史 / Governance and history

| 文档 / Document | 内容 / What it covers | 语言 / Language |
| --- | --- | --- |
| [变更日志](CHANGELOG.md) | 每个版本的变更 | 中 |
| [溯源记录](PROVENANCE.md) | 每个版本的来源、二进制与校验方式 | 中 |
| [贡献指南](贡献指南.md) · [Contributing](CONTRIBUTING.md) | 开发、提交与评审要求 | 中/英 |
| [路线图](路线图.md) · [Roadmap](roadmap.md) | 已发布与后续方向 | 中/英 |
| [设计决策 2026-11-02](设计决策-20261102.md) · [English](design-decisions-20261102.md) | 当日决策记录 | 中/英 |
| [设计决策 2026-11-15](设计决策-20261115.md) | 当日决策记录 | 中 |
| [设计决策 2026-11-19](设计决策-20261119.md) · [English](design-decisions-20261119.md) | 当日决策记录 | 中/英 |
| [插件细节](plugin-detail.zh.md) · [Plugin detail](plugin-detail.en.md) | 插件清单与面向市场的说明 | 中/英 |
| [1.1.1 发布说明](release-notes/v1.1.1.md) | 1.1.1：scoped 包名、旧名弃用、自动迁移 | 中/英 |
| [1.1.0 发布候选](release-1.1.0.md) | 1.1.0 发布记录：内容、继承关系、验证证据、风险与发布清单 | 英 |
| [0.4.0 发布候选](0.4.0发布候选.md) · [0.4.0 release candidate](release-0.4.0.md) | 历史发布记录 | 中/英 |
| [0.3.1 发布](release-0.3.1.md) | 历史发布记录 | 英 |
| [0.2.1 发布](release-0.2.1.md) | 历史发布记录 | 英 |
| [Windows 验证清单](windows-verification.md) | 历史记录，已被安全回归文档取代 | 英 |
| [Schema 测量](schema-measurement.md) | 0.2.x FastCtx 表面的历史测量 | 英 |

## 约定 / Conventions

- 每份文档开头给出另一语言的链接，两份文件的章节顺序一致；改动一份必须同改另一份。
- 历史文档（`release-0.*`、`windows-verification.md`、`schema-measurement.md`）保留原样，用于追溯，不代表当前行为。
- 目录中未列出的文件属于上述文档的附件或数据，不作为入口。
