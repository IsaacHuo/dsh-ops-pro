<p align="center">
  <a href="https://www.npmjs.com/package/@huoweifang/dsh-ops-pro"><img alt="npm" src="https://img.shields.io/npm/v/@huoweifang%2Fdsh-ops-pro?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/@huoweifang/dsh-ops-pro"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@huoweifang%2Fdsh-ops-pro?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/IsaacHuo/dsh-ops-pro/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/IsaacHuo/dsh-ops-pro?style=flat-square&color=eab308"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@huoweifang%2Fdsh-ops-pro?style=flat-square&color=2ea44f"></a>
</p>

# dsh-ops-pro

DSH 的工具运行时插件：Windows 上的 ops_bash，跨平台的 Rust 文件、搜索与批处理工具，批量 OPS-PTC 调用；另含可选的 Windows 桌面与浏览器电脑操控、侧栏控制台和用量统计。

<p align="center">
  <strong>中文</strong> | <a href="README.en.md">English</a>
</p>

插件在 DSH 的现有工具集之外新增一组 `ops_*` 工具，并可按配置隐藏部分官方工具。默认只新增工具与配置项，不接管宿主逻辑，可与其它插件同时启用。

项目源自 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)，在此基础上进行了大量独立开发与架构演进；1.1.0 起整合 [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 的 Windows 电脑操控运行时。目标是形成一个架构统一、低侵入、低 token 消耗、易于维护的 DSH 综合操作工具插件。

功能范围：

- Windows：发布 `ops_bash`，可选隐藏官方 PowerShell 工具。随包提供约 100 MB 的 Niubash bash 载荷，也可改用本机 Git Bash 或 WSL。
- Windows、Linux、macOS：发布一组常驻高级工具，系统提示词约增加 1000 token，可关闭。实现参考 [Tranquillitatis-Lab/ops-ga](https://github.com/Tranquillitatis-Lab/ops-ga) 等方案持续调整。
- 缓存友好的动态工具加载：按需加载面向具体场景的专项工具，可关闭。
- 带教师模型轨迹的预设：让模型学会一次调用多个工具，减少完成任务所需的轮数。
- PTC SDK 目录包含 18 个 API：15 个文件/文档工具，加批处理、结果引用和加载器。
- 可与 [Tranquillitatis-Lab/dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact) 搭配使用，两者互不依赖。


## 系统要求

| 平台 | 要求 |
| --- | --- |
| Windows | 10 / 11 x64；Windows PowerShell 5.1（系统自带）；使用电脑操控时另需 Edge 或 Chrome |
| Linux | x64 |
| macOS | 13 及以上，arm64 与 x64 |

所有可执行部分随 npm 包发布：预编译的 native worker、约 100 MB 的 bash 载荷、内置的电脑操控运行时。安装后不需要再下载或另装组件；npm 与插件市场两条安装路径的内容相同。

系统要求之外没有额外依赖。电脑操控在 Windows 上读 Windows UI Automation 树（系统自带），网页通道通过 CDP 驱动 Edge 或 Chrome；两者都不需要单独安装 MCP 服务或浏览器扩展。

## 安装、更新、卸载

> 所有 npm、市场和 CLI 更新入口的二进制位置与清理边界见[升级与卸载](docs/升级与卸载.md#二进制位置与更新清理)。

> 从 `dsh-ops` 迁移：两个包发布同一组 `ops_*` 工具，不能同时启用。先移除 `dsh-ops` 再安装本包，迁移步骤见[升级与卸载](docs/升级与卸载.md)。

> 从无 scope 的 `dsh-ops-pro` 迁移：1.1.1 起 npm 包名为 **`@huoweifang/dsh-ops-pro`**，旧名已弃用。
> 行 id、可执行命令与状态目录不变；`install --profile` 会先移除旧依赖再安装新包，详见[升级与卸载](docs/升级与卸载.md#从无-scope-的-110-升级到-111)。

### 官方插件市场

在目标 DSH 应用的插件市场中输入 npm 包名 **`@huoweifang/dsh-ops-pro`**，选择自定义地址，输入 `https://mirrors.huaweicloud.com/repository/npm/`，安装后选择启用。目前不推荐用npmmirror安装，有bug。

当然，如果你确定可以连接 npm 官方源那就选择官方源，如果你不确定那就按教程操作。

![在插件市场中选择自定义地址并填入华为云 npm 镜像](docs/assets/marketplace-huaweicloud-mirror.png)

### npm 一键安装

#### 安装方法

```console
npx --yes @huoweifang/dsh-ops-pro@latest install --profile desktop
npx --yes @huoweifang/dsh-ops-pro@latest install --profile web
npx --yes @huoweifang/dsh-ops-pro@latest install --profile tui
```

必须显式选择目标 profile；`tui` 映射到 **dsh-TUI 产品的 `dsh-tui` profile**，不是旧的 `tui` 目录。请先初始化目标应用。该入口委托官方 DSH CLI 安装，不另写一套 profile 锁与回滚逻辑。

桌面端必须使用桌面应用自带的 CLI；默认探测 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。安装在其它位置时加 `--dsh-cli "<安装目录>\resources\runtime\cli\bin\dsh.cmd"`。Web/TUI 需要可用的 DSH CLI，可同样显式指定。

安装或卸载时可加 `--dry-run` 预演。它按指定路径或 `PATH`（Windows 同时使用 `PATHEXT`）解析 CLI，检查文件、POSIX 执行权限及通过 Node 启动的入口文件，并在预演时同样拒绝不安全的 Windows 命令脚本路径；检查失败返回非零。预演只打印计划，不启动 CLI、不修改 profile。成功表示这些静态检查已通过，不保证所选程序的身份、版本、profile 兼容性或后续安装结果。

也可以直接使用官方命令：

```console
dsh plugin --profile web add @huoweifang/dsh-ops-pro
dsh plugin --profile dsh-tui add @huoweifang/dsh-ops-pro
"<桌面安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @huoweifang/dsh-ops-pro
```

普通 DSH CLI 不能管理保留的 `desktop` profile；不要把它与桌面自带入口混淆。

请安装 registry 发行包，或已完整构建并打包的源码 tarball。直接 `git+https` 安装与未构建的
源码检出缺少完整运行时；见[不支持通过 Git 通道安装](docs/升级与卸载.md#不支持通过-git-通道安装)。

#### 更新方法

宿主支持从 DSH **0.2.2-rc.1** 起；0.5 系列不再支持 0.2.0/0.2.1 或更早的 0.2.2 预览版。保留 DSH adapter 结构，按 0.2.2 原生工具准入和执行器接口接入。
组件图标导出、profile 刷新及配置/schema 检查见
[宿主兼容范围与展示元数据](docs/使用指南.md#宿主兼容范围与展示元数据)。

重新运行相同的 `npx --yes @huoweifang/dsh-ops-pro@latest install --profile ...`，或用官方 CLI `add @huoweifang/dsh-ops-pro@latest`。按应用提示重载；替换已加载代码时重启应用。

#### 卸载与查看状态

```console
npx --yes @huoweifang/dsh-ops-pro@latest status --profile desktop
npx --yes @huoweifang/dsh-ops-pro@latest uninstall --profile desktop
```

把 `desktop` 换成 `web` 或 `tui` 即可。也可在市场卸载，或执行官方 `dsh plugin --profile ... remove @huoweifang/dsh-ops-pro`。随包二进制由 profile 的包管理器管理；显式 provision 的副本不会随 npm 卸载，先查看 `dsh-ops-pro bash-runtime status`，再用 `dsh-ops-pro bash-runtime remove --dry-run` 预览、`remove --yes` 确认。不要误删系统 shell、其它 profile 或共享缓存。详见[二进制位置与更新清理](docs/升级与卸载.md#二进制位置与更新清理)。

旧版显式 provision 的 `<DSH_HOME>/dsh-ops/` 文件（provision 的 shell，以及早期版本可 provision 的 FastCtx 运行时）需单独清理：`npx --yes @huoweifang/dsh-ops-pro@latest uninstall --yes`。已移除的后台组件留下的 `~/.fastctx/` 状态默认不删；需要时显式加 `--purge-fastctx`。

组件 bundle 只插入一个 `dsh-ops-pro` 行：其中按预设配置常驻、动态加载、Bash、文件替换与宿主 PowerShell 隐藏，并可通过 `presets` 显式接入自定义消费者。内置与外部预设共用装配流程。旧 `mode-*`、`discovery`、`compat`、`panel`、`tui` 及更早的 `shell`、`file`、`ptc`、`hide-official` 行覆盖须迁入单行；兼容开关已移除，改用各项隐藏开关。见[配置参考](docs/配置参考.md)。

原 `dsh-ops/background` 组件（FastCtx 后台任务）已移除。仍保留该行的 profile 照常加载：该行不发布任何工具，只记录一条警告，可直接删除。

## 可选 OPS 只读侧栏

在 dsh-TUI 中启用 `dsh-ops/tui` 行并重启，即可添加 OPS 侧栏；不抢焦点，不执行额外工具调用。没有 `tuiPanels` 的宿主仅让该可选行等待，不影响其它组件。见 [侧栏说明](docs/tui-panel.zh.md)。 聚焦后可用 `f` 筛选、`n`/`p` 本地翻页、`a` 确认跨会话提醒；只浏览有界保留元数据，不拉取结果分页。

## 电脑操作（computer use）

`computer-use` 配置段在 Windows 上发布 26 个 `ops_cu_*` 工具，覆盖桌面程序与 Chromium 浏览器，默认关闭。

- 元素识别以结构为主：桌面通道读 Windows UI Automation 元素树，网页通道读页面的可访问性树；拿到元素 id 后直接点击、写入、展开、滚动，不依赖截图坐标。没有语义节点时才回退到截图、OCR 与坐标。
- 两条通道：桌面窗口，以及网页通道（Edge 或 Chrome）。网页通道可连接用户自己的浏览器，读到的是用户已登录的标签页。
- 来源：内置 dsh-computer-use-win 0.6.3（MIT，固定提交 `acfb689`），工具名由 `mcp__wincu__windows_computer_use_*` 改为 `ops_cu_*`。
- 浏览器选择：Edge 与 Chrome 的能力相同，差别在启动顺序与 profile 模式（一次性 profile / 保留登录 / 连接用户浏览器）。其他 Chromium 浏览器可用环境变量接入，属于可选配置，不是依赖。

设置项、工具清单、元素 id 规则与已知问题见[电脑操控](docs/computer-use.zh.md)。

## 文档

- [文档索引](docs/README.md)：按用途分组的全部技术文档，标注中英文对照。

- [第三方预设集成接口](docs/集成接口.md) · [外部 Native 提供者](docs/外部工具提供者.md) · [作用域诊断](docs/集成诊断.md)

- [使用指南](docs/使用指南.md) · [常见问题](docs/常见问题.md) · [组件参考](docs/组件参考.md) · [配置参考](docs/配置参考.md) · [预设与默认模式](docs/预设与默认模式.md)
- [电脑操控、侧边栏控制台与用量统计](docs/computer-use.zh.md)：系统要求、配置项、工具与元素识别模型。
- [Windows 运行时证据](docs/windows-runtime-evidence.zh.md)：载荷兼容、Low 完整性、MSYS 启动及杀软/审批排查。
- [PTC 设计与使用](docs/native-ptc.md) · [手动验证](docs/手动验收.md)
- [贡献指南](docs/贡献指南.md) · [路线图](docs/路线图.md) · [变更日志](docs/CHANGELOG.md) · [溯源记录](docs/PROVENANCE.md)
- [CI 排错说明](docs/ci-troubleshooting.zh.md) · [CI troubleshooting](docs/ci-troubleshooting.md)

## Windows Bash 自检

Windows Bash 自检：`dsh-ops-pro ladder` 分别报告映像/祖先路径完整性标签与静态 MSYS
哈希兼容性。Low 标签的可执行文件在 full-access 下仍可能产生 Low 子进程，无法修改
既有 Medium/无标签文件；不可读标签明确为 unknown。详见
[完整性检查](docs/常见问题.md#windows-bash-完整性标签)。

## 许可证

当前 `dsh-ops-pro` 源码以 **MIT** 许可分发，见 [LICENSE](LICENSE)。`0.3.2` 之前的版本曾内置以 Apache-2.0 许可的 FastCtx 源码；该源码随后台组件一并移除，当前发行版不再包含任何 FastCtx 代码或二进制。FastCtx 的许可文本与上游声明保留在 `licenses/fastctx/`，历史归属见 [NOTICE](NOTICE)。

Windows 随包 Niubash 及其 WinuxCmd、Git 等组件分别遵循上游许可证；原始许可证、NOTICE 与来源记录随完整载荷保留。Git Bash 仅保留为显式 legacy 后端与源码路径，不再默认下载其可选包。插件 MIT 许可不替代任何第三方许可；见 [NOTICE](NOTICE) 和[升级与卸载](docs/升级与卸载.md)。

## 致谢

来源与版本：本项目最早派生自 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)，1.1.0 起整合 [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) 的运行时；对应版本、commit 与 SHA-256 固定值记录在 [docs/PROVENANCE.md](docs/PROVENANCE.md)。

早期版本（`0.3.2` 之前）曾内置并分发 [yc-duan](https://github.com/yc-duan) 的 Codex 插件 FastCtx，并使用其源代码提供 Rust 工具面。FastCtx 源码随后台组件一并移除，当前 `native/` 的 Rust 核心为 dsh-ops 原创的 MIT 代码；FastCtx 的许可文本与需要转载的声明仍保留在 `licenses/fastctx/` 与 [NOTICE](NOTICE) 中，作为对历史版本的归属：

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

## 维护团队

<table>
  <tbody>
    <tr>
      <td align="center" width="150"><a href="https://github.com/IsaacHuo"><img src="https://github.com/IsaacHuo.png?size=160" width="96" height="96" alt="IsaacHuo"></a><br><a href="https://github.com/IsaacHuo"><b>IsaacHuo</b></a></td>
    </tr>
  </tbody>
</table>

---

## 贡献者

[![Contributors](https://contrib.rocks/image?repo=IsaacHuo/dsh-ops-pro)](https://github.com/IsaacHuo/dsh-ops-pro)

## Star 趋势

[![Star 趋势图](https://api.star-history.com/svg?repos=IsaacHuo/dsh-ops-pro&type=Date)](https://star-history.com/#IsaacHuo/dsh-ops-pro&Date)
