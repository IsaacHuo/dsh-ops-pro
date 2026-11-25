# 电脑操控、侧边栏控制台与用量统计

English: [computer-use.md](computer-use.md)

## 电脑操控（`ops_cu_*`，仅 Windows）

### 概述

插件行的 `computer-use` 配置段把
[dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 的桌面与浏览器自动化发布为
`ops_cu_*` 工具，默认关闭。工具在模式之外全局注册，所有内置模式、自定义预设、Native 与 PTC 会话
都能看到。

两个通道都以“先读结构、再按元素 id 操作”为主：桌面通道读 Windows UI Automation 树（UIA，
Windows 的可访问性接口），网页通道经 CDP（Chrome DevTools Protocol）读页面的可访问性树并在页面内
操作。截图、OCR 与坐标只在没有语义节点时作为回退。

### 系统要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 系统 | Windows 10 / 11 x64 | 桌面通道依赖 UIA，不提供 macOS、Linux 版本 |
| PowerShell | Windows PowerShell 5.1 | 运行 `scripts/*.ps1`，路径为 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，系统自带 |
| UI Automation | 系统自带 | 后端加载 .NET 的 `UIAutomationClient` 等程序集，无需安装 |
| 浏览器 | Edge 或 Chrome | 网页通道默认启动其中之一；也可显式指定其他 Chromium |
| 管理员权限 | 不需要 | 以当前用户身份运行 |

插件包内已包含全部可执行部分：预编译的 native worker（`runtime/win32-x64`）、随包的 bash 载荷、
以及内置的电脑操控运行时。安装后不需要额外下载，也不需要在 README 之外另装组件。

### 启用与配置

```yaml
dsh-ops:
  computer-use:
    enabled: true
    callTimeoutMs: 90000
    settings:
      desktopTarget: quiet
      browserApp: default
```

| 键 | 默认 | 含义 | 注意 |
| --- | --- | --- | --- |
| `computer-use.enabled` | false | 是否发布 `ops_cu_*` | 改后需重启会话 |
| `computer-use.callTimeoutMs` | 90000 | 单次调用时限 | 1000–600000 |
| `computer-use.settings` | `{}` | 上游设置 | 键名未知即报错；控制台保存的同名键优先 |

设置分六组，全部带 `draft` 标记，可在侧边栏控制台的“电脑操控”页修改：

| 分组 | 键 | 说明 |
| --- | --- | --- |
| 桌面 | `desktopTarget`、`hypervVm` | `quiet` 后台执行、`fast` 抢占前台、`hyperv` 在 Hyper-V 虚拟机桌面执行 |
| 浏览器 | `browserFirst`、`browserVisible`、`browserApp`、`browserSignIn`、`browserAttachUser` | 网页通道的启动与登录策略，见下一节 |
| 浮窗 | `progressOverlayEnabled`、`progressOverlayMode`、`progressOverlayOpacity`、`progressOverlayWidth`、`progressOverlayHeight`、`progressOverlayPosition`、`progressOverlayX`、`progressOverlayY`、`progressOverlayLocked`、`progressLockShortcut`、`progressPreviewToken` | 操作进度浮窗的显示与位置 |
| 工具集 | `mode`、`toolPreset`、`enabledTools` | `lite` 只发布观察与输入类工具，`full` 发布全部 |
| 指示 | `indicatorEnabled`、`cursorIndicatorEnabled`、`remoteIndicatorVisible`、`indicatorText`、`indicatorPosition`、`indicatorIdleMs`、`stopShortcut` | 屏幕边缘的状态指示与停止快捷键 |
| 说明 | `communityNote` | 首次使用时显示社区提示，`link` 只保留链接 |

### 工具

共 26 个，命名统一为 `ops_cu_<名称>`（上游为 `mcp__wincu__windows_computer_use_<名称>`）。

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `health` | 运行时自检 | 无 |
| `snapshot` | 一次取回窗口或整个桌面的元素树，可附截图 | `scope`、`windowTarget`、`browserTab`、`maxDepth`、`maxNodes` |
| `accessibility_tree` | 只取元素树，支持增量 | `treeDeltaBase`、`maxDepth`、`maxNodes` |
| `list_windows` | 列出可见窗口与浏览器标签页 | `includeInvisible`、`maxWindows` |
| `find` | 按名称或控件类型搜索元素，可回退 OCR | `query`、`controlType`、`ocrFallback`、`maxResults` |
| `element_info` | 元素或屏幕点的详细信息 | `elementId` 或 `x`/`y` |
| `click`、`double_click` | 点击元素中心或坐标 | `elementId`、`button`、`dispatch` |
| `move` | 悬停到元素或坐标 | `elementId`、`x`/`y` |
| `drag` | 沿路径拖动 | `path`（至少两点） |
| `scroll` | 滚动元素或坐标处 | `deltaY`（120 为一格滚轮）、`deltaX` |
| `type_text` | 输入文本 | `text`、`method`（`clipboard`/`sendinput`/`background`）、`focusMode` |
| `keypress` | 按键组合 | `keys`、`thenKeys`、`dispatch` |
| `focus` | 把焦点交给元素 | `elementId` |
| `invoke` | 执行元素的默认动作或展开/折叠/滚入视图 | `action`、`fallbackClick` |
| `set_value` | 写入输入框或下拉框的值 | `elementId`、`value`、`fallbackType` |
| `activate_window` | 前置窗口或标签页，最小化的会还原 | `windowTarget` 或 `browserTab` |
| `wait` | 等待指定毫秒 | `milliseconds` |
| `ocr` | 读可见文本 | `query`、`language`、`scope`、`maxBytes` |
| `screenshot` | 取像素截图 | `scope`、`maxWidth` |
| `wait_for` | 轮询窗口、元素或文本出现 | `condition`、`query`、`timeoutMs`、`appear` |
| `close_window` | 发送关闭消息 | `windowTarget` 或 `browserTab` |
| `move_window` | 移动窗口到坐标 | `x`、`y` |
| `launch_app` | 启动程序或快捷方式 | `target`、`arguments`、`workingDirectory`、`desktop` |
| `batch` | 在同一个窗口内顺序执行 1–20 步 | `steps`、`timeoutMs` |
| `tools` | 查看并调整本次会话发布的工具集 | 无 |

### 元素识别模型

**桌面通道。** `snapshot` 与 `accessibility_tree` 返回 UIA 元素树，每个节点带元素 id（形如
`t1a2b:57`）、控件类型、名称、值、是否可交互与边界。元素 id 只在本次运行的该窗口内有效：窗口关闭或
运行时重启后失效，需重新观察。

**网页通道。** `accessibility_tree` 读当前标签页的可访问性树，元素 id 同为 `t…:n` 形式（页面内
元素可带 `web:` 前缀）。对页面元素的操作在页面内部完成，不移动桌面指针，也不抢占前台。

**id 优先，坐标兜底。** 读到的元素 id 可直接用于 `click`、`double_click`、`invoke`、
`set_value`、`focus`、`scroll`、`element_info` 与 `move`。坐标只在没有对应节点、节点是自绘
区域、或需要点击空白处时使用。

网页通道另有三个特殊 id：`<标签页>:address` 指向地址栏（配合 `set_value` 导航），
`new-tab` 在后台新开标签页，`connect` 连接用户自己的浏览器。

**回退顺序。** `find`（按名称或控件类型搜索，可含 OCR）→ `ocr`（读可见文本，返回屏幕坐标与
文本，不是元素 id）→ `screenshot` 配合坐标点击 → `wait_for` 轮询。OCR 没有置信度，小字、浅色
文字与缩放后的界面可能误读；此时以元素树为准。

**边界。** 自绘画布、游戏画面、远程桌面窗口没有可读的 UIA 树；部分 Electron、UWP 应用只暴露少量
节点，深层内容需要逐层展开。这些场景只能用坐标与 OCR，精度受显示器缩放与主题影响。

桌面坐标是屏幕像素。`screenshot` 与 `snapshot` 会返回窗口边界与 `imageScale`，换算关系是
`屏幕坐标 = origin + 图片像素 / imageScale`。网页通道的 `x`/`y` 是页面视口的 CSS 像素。

### 浏览器通道

| 设置 | 默认 | 取值 | 说明 |
| --- | --- | --- | --- |
| `browserApp` | `default` | `default`、`edge`、`chrome`、`firefox` | `default` 依次尝试 Edge → Chrome |
| `browserSignIn` | false | 布尔 | false 用一次性 profile；true 保留登录状态 |
| `browserVisible` | true | 布尔 | false 时不显示浏览器窗口，操作照常进行 |
| `browserAttachUser` | false | 布尔 | true 时连接用户已打开的浏览器 |
| `browserFirst` | true | 布尔 | 页面元素可用时优先走网页通道，而不是桌面窗口 |

`default` 的顺序是 Edge 在前：从 Edge 156 起，新建 profile 会自动登录到 Windows 账户并写入该账户的
cookie，因此 Edge 通常直接可用；Chrome 作为后备。

`browserSignIn: false` 时每次运行使用干净的 profile；为 true 时登录状态保存在
`%LOCALAPPDATA%\dsh-computer-use-win\agent-browser`，可用 `WCU_BROWSER_PROFILE` 覆盖。

`browserAttachUser: true` 连接用户自己的浏览器：需要该浏览器已开启远程调试端口，读到的标签页属于
用户本人，首次访问会要求审批。不开启时，电脑操控只操作自己启动的 profile。

其他 Chromium 内核的浏览器（例如 ego 这类第三方外壳）不在内置清单里。接入方式有两种，任选其一：
把 `WCU_BROWSER_EXE` 指向它的可执行文件，或把 `WCU_BROWSER_CDP_URL` 指向它已开启的调试端点。
两种都是可选配置，不是安装依赖；不配置时插件只操作 Edge 或 Chrome。

诊断与高级用途的环境变量：`WCU_BROWSER_APP`、`WCU_BROWSER_SIGNIN`、
`WCU_BROWSER_ATTACH_USER`、`WCU_BROWSER_PROFILE`、`WCU_BROWSER_EXE`、
`WCU_BROWSER_CDP_URL`、`WCU_BROWSER_BIDI_URL`，以及 `WCU_BROWSER_LANE=off` 关闭整个网页
通道。环境变量优先于设置文件里的同名项。

### 限制与已知问题

- 网页通道的元素 id 按运行编号、跨标签页不重复；标签页 id 带本次运行的盐值，因此运行时重启后旧 id
  不指向任何标签页，而不是指向恰好同号的其他元素。
- 未移植上游 DSH 适配层的：自带 Web 路由、活动浮窗控制管道、后台桌面辅助程序的宿主集成。
- 上游已知问题 #99（按键卡住）与 #100（副屏全屏误判）未在此修复。
- 内置服务以单进程串行执行；异常退出会重启一次，60 秒内再次崩溃则保持停止，原因显示在“状态”页。
- 需审批的操作：连接用户浏览器、访问用户已有的标签页、带参数启动程序或 `.lnk` 快捷方式、页面上传
  或读取本地文件。全访问模式（`policy: never`）下宿主不再询问。
- 部分机器的终端安全软件会隔离 `scripts/windows-uia.ps1`，“状态”页随之显示后端缺失，桌面工具
  返回错误；请向 IT 申请例外，插件不会绕过它。
- 同时安装独立的 `dsh-computer-use-win` 插件时只提示冲突，需手动禁用一个。
- Windows 键被设计性禁用；后台模式下的按键只支持一个可打印字符。

### 来源与许可

内置运行时为 [dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 0.6.3
（MIT，固定提交 `acfb689`），派生自
[cgissing/windows-computer-use](https://github.com/cgissing/windows-computer-use)。逐文件的
SHA-256 记录在 `vendor/computer-use/UPSTREAM.md`，超过 1000 行的文件按行段拆分，构建时重组并校验；
许可文本见 `licenses/computer-use/`。

本文档的组织参考 Microsoft Hybrid-Computer-Use 的文档结构，技术内容以本仓库实现为准。

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
