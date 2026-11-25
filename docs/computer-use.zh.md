# 电脑操控、侧边栏控制台与用量统计

English: [computer-use.md](computer-use.md)

## 电脑操控（`ops_cu_*`，仅 Windows）

插件行的 `computer-use` 配置段把
[dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3（MIT，固定在提交
`acfb689` 内置，见 `vendor/computer-use/UPSTREAM.md` 与 `licenses/computer-use/`）的桌面与浏览器
自动化发布为 `ops_cu_*` 工具。默认关闭。

- **所有模式可用。** 工具在模式之外全局注册，所有内置模式、自定义预设、Native 与 PTC 会话都能看到。
- **单进程。** 内置 MCP 服务以宿主的常驻子进程运行（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`），
  异常退出会重启一次；60 秒内再次崩溃则保持停止，原因显示在“状态”页。
- **审批。** 高风险操作仍先询问，沿用上游规则不变。
- **失败是返回值。** `CU_TIMEOUT`、`CU_CANCELLED`、`CU_UNAVAILABLE`、`CU_TOOL_ERROR`，带 `effectState`。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `computer-use.enabled` | false | 发布 `ops_cu_*` |
| `computer-use.callTimeoutMs` | 90000 | 单次调用时限，1000–600000 |
| `computer-use.settings` | `{}` | 上游设置；控制台文件按键覆盖 |

工具改名：`mcp__wincu__windows_computer_use_<x>` 变为 `ops_cu_<x>`。若同时安装了独立的
`dsh-computer-use-win` 插件，“状态”页会提示；请禁用其中一个——OPS 不会自行禁用其他插件。

未移植上游 DSH 适配层的：自带 Web 路由、活动浮窗控制管道、后台桌面辅助程序的宿主集成。上游已知问题
#99（按键卡住）与 #100（副屏全屏误判）未在此修复。

部分机器的终端安全软件会隔离 `scripts/windows-uia.ps1`。此时“状态”页显示后端缺失，桌面工具返回
错误；请向 IT 申请例外——OPS 不会绕过它。

## 侧边栏控制台

DSH 侧边栏的 **OPS** 入口打开三个标签页：

- **状态**——插件版本、原生 worker、已启用功能、电脑操控状态、工具数、进程启动次数、冲突与后端被隔离提示。
- **电脑操控**——上游设置中的普通值（不含工具列表与命令），用内置的 `validateSetting` 校验。保存写入
  `<DSH_HOME>/dsh-ops/computer-use.json`，只重启电脑操控运行时；进行中的调用会被取消。“清除控制台设置”删除该文件。
- **用量**——见下。

## 用量统计

一个 `tools/execute` 监听统计所有模式下每一次 `ops_*` 调用：调用数、失败（抛出或返回失败值）、来自
`run_code` 的调用、p50/p95 耗时与结果字符数。Token 为**估算**（字符数 / 4）。计数保存在
`<DSH_HOME>/dsh-ops/usage.json`，按本地日期分桶，保留 30 天，最多每 5 秒写一次。文件损坏时重新计数并在
页面提示，绝不导致调用失败。数据不离开本机。
