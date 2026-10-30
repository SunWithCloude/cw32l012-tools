# CW32 Tools

**简体中文** | [English](README.md)

VS Code 插件：面向武汉芯源（CMSemicon / Xinyuan）**CW32 全家族**（Cortex-M0+，当前覆盖 CW32L012 与 CW32F030）Rust 项目的**烧录 + 可视化调试 + Agent API** 工具链插件。

> 定位：对标 Keil 的「编译 → 烧录 → 调试」工作流，**不包含代码编辑**。代码编辑、补全、编译诊断交给 VS Code + rust-analyzer；本插件负责你写好代码之后的那一半：构建固件、通过 probe-rs 烧录、用 VS Code 原生断点可视化调试，并把这一切开放成 HTTP API 供 AI / 脚本直接驱动。

- 版本：`0.9.0`
- 硬件链路：ST-LINK `0483:3748` + SWD + probe-rs 0.32.0
- 芯片描述：`CW32L012x8` 等（probe-rs 0.32+ **内置** CW32L0 家族；CW32F030 由插件**自带** `tools/families/CW32F030_Series.yaml`，无需手动配置）
- 调试后端：`probe-rs dap-server`（VS Code 原生断点 / 单步 / 变量监视）

---

## 功能总表

| 能力 | 说明 | 状态 |
|---|---|---|
| 构建固件 | `cargo clean` + `cargo build --target thumbv6m-none-eabi --examples` | 已实现 |
| 固件产物校验 | cargo metadata 定位真实产物目录；仅识别 `.elf`/`.bin`/`.hex` + ELF 魔数校验，自动过滤 `.d`/`.rmeta`/`.o` 等中间文件 | 已实现 |
| 自动/手动烧录 | 自动选最新有效产物，或从候选列表中手选；`.bin` 按 `flashBaseAddress=0x00000000` 烧录 | 已实现 |
| 全片擦除 | `probe-rs erase --allow-erase-all` | 已实现（0.6.0 起并入命令面板/仪表盘） |
| 复位 | `probe-rs reset`，同时作为 MCU 在线判据 | 已实现 |
| 可视化调试 | `cw32-probe-rs` 调试类型，spawn `probe-rs dap-server --single-session`；VS Code 原生断点/单步/监视 + 仪表盘 PC/调用栈/变量/内存 hex 视图 | 已实现 |
| 仪表盘 | 侧边栏 Webview：状态分级、可交互状态条、工作流主卡（①构建→②烧录→③监视）、调试/内存面板、日志环 | 已实现 |
| Agent API | localhost HTTP JSON，AI / 脚本直连（详见下文与 `docs/AGENT_API.md`） | 已实现 |
| 串口监视器 | **VS Code 面板内实现**（不依赖外部工具），支持发送 | 已实现 |
| 状态栏 / 例程选择器 / 烧录后 verify / clean 独立命令 | — | 已实现 |

配套文档：

- 使用者图文手册（仪表盘布局、调试面板、内存视图预设地址、例程选择、串口监视）：[docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Agent / AI 集成专篇（完整 curl 流程、错误码语义、token 鉴权）：[docs/AGENT_API.md](docs/AGENT_API.md)
- 更新日志：[docs/RELEASE_NOTES.md](docs/RELEASE_NOTES.md)
- 端到端冒烟脚本（PowerShell）：[tools/e2e-check.ps1](tools/e2e-check.ps1)

---

## 安装

### 1. 前置依赖

| 依赖 | 版本 | 说明 |
|---|---|---|
| VS Code | ≥ 1.90 | `engines.vscode = ^1.90.0` |
| Rust 工具链 | 任意当前 stable | 需含 `rustup` |
| `thumbv6m-none-eabi` target | 与 HAL 一致 | `rustup target add thumbv6m-none-eabi` |
| probe-rs | ≥ 0.32 | `cargo install probe-rs-tools --locked`（提供 `probe-rs` CLI 与 `dap-server`） |
| ST-LINK 驱动 | 官方驱动 | Windows 下需正确枚举出 `0483:3748` |

确认环境：

```bash
rustup target list --installed        # 应含 thumbv6m-none-eabi
probe-rs --version                    # 0.32.x
probe-rs list                         # 应列出 [0] ST-LINK ... 0483:3748
```

### 2. 安装插件（VSIX）

在插件项目根目录（本仓库的 `vscode-hal/vscode/`）执行：

```bash
# 命令行安装（VSIX 文件随仓库发布）
code --install-extension cw32-tools-0.9.0.vsix

# 或从源码重新打包后安装
npm ci && npm run compile
npx @vscode/vsce package
code --install-extension cw32-tools-0.9.0.vsix
```

也可以在 VS Code 扩展面板右上角 `...` → *Install from VSIX…* 选择文件。安装后从活动栏 **CW32** 图标进入仪表盘。

### 3. 打开工作区

必须打开包含 `Cargo.toml` 的 Rust 固件工程（例如 [cw32l012-hal](https://github.com/SunWithCloude/Rust_Cw32L012)）。插件自动向上查找 Cargo 根目录；也可用 `cw32.workspaceRoot` 手动指定（仪表盘「源目录」栏可视化切换）。

---

## 快速上手（三步：Build → Flash → Debug）

1. **Build** — 在仪表盘点「固件构建」（或命令面板执行 `CW32: Build firmware`）。插件先 `cargo clean` 再 `cargo build --target thumbv6m-none-eabi --examples`，产出位于 `target\thumbv6m-none-eabi\debug\examples\`（例如 `blink_pc13`，无扩展名 ELF）。
2. **Flash** — 点「烧录」（自动选中最新有效产物，ELF 魔数已校验），或点「选择固件」手动挑选。ST-LINK + SWD 接线（SWDIO/SWCLK/GND）后即烧入，随后自动做 probe/MCU 分级检测。
3. **Debug** — 点「SWD 调试」：自动烧录当前 ELF 并启动 probe-rs DAP 会话。直接在源码上打断点，按 F5 启动 `cw32-probe-rs` 类型调试；仪表盘「可视化调试」面板实时显示 PC、调用栈、变量，「内存视图」可读任意地址。

> MCU 状态分级：**probe online ≠ MCU online**。探针枚举成功只代表 USB 链路通了；MCU 是否在线以 `probe-rs reset` 是否应答为准（`/api/status?deep=1` 或「深度检测」命令）。

---

## 命令与配置

### 命令（命令面板；仪表盘只显主流程，次级操作按上下文折叠）

| 命令 ID | 标题 | 作用 |
|---|---|---|
| `cw32.showDashboard` | CW32: Open dashboard | 打开仪表盘面板 |
| `cw32.build` | CW32: Build firmware | 已选例程=增量构建；自动模式=clean + build --examples |
| `cw32.flash` | CW32: Flash via DAPLink | 烧录（自动选产物） |
| `cw32.selectArtifact` | CW32: 选择固件烧录 | 从校验过的产物列表手选 |
| `cw32.debug` | CW32: Start SWD debug session | 自动烧录 + 启动 DAP 调试 |
| `cw32.debugPause` / `debugResume` / `debugStepOver` / `debugStepInto` / `debugStepOut` / `debugRestart` | 调试-暂停/继续/步过/步入/步出/复位重跑 | 对活动 DAP 会话的单步控制（0.6.0+） |
| `cw32.debugStop` | CW32: 调试-停止会话 | 结束当前 DAP 调试会话（0.6.6+） |
| `cw32.rebuild` | CW32: 重新构建 | clean + build（忽略例程选择，全量重建） |
| `cw32.clean` | CW32: 清理构建产物 | 仅 `cargo clean` |
| `cw32.eraseAll` | CW32: 全片擦除 | `probe-rs erase --allow-erase-all`（模态二次确认） |
| `cw32.checkStatus` | CW32: 深度检测 probe / MCU 状态 | reset 级 MCU 检测 |
| `cw32.reset` | CW32: Reset target | probe-rs reset |
| `cw32.monitor` | CW32: Open serial monitor | 打开串口监视器（0.6.0：VS Code 内实现） |
| `cw32.aiSummary` | CW32: AI 诊断报告 | 收集诊断信息并复制到剪贴板 |
| `cw32.apiToggle` | CW32: 启动/停止 Agent API | 开关 API 服务 |
| `cw32.apiStart` | CW32: 启动 Agent API | 启动 API |
| `cw32.apiStop` | CW32: 停止 Agent API | 停止 API |
| `cw32.setSourceDir` | CW32: 指定源码目录 | 输入路径写回 `workspaceRoot` 设置；留空恢复自动探测（仪表盘「源目录」栏同入口） |

### 配置项（`settings.json` 键 `cw32.*`）

| 配置键 | 默认值 | 说明 |
|---|---|---|
| `cw32.target` | `thumbv6m-none-eabi` | Rust target triple |
| `cw32.profile` | `debug`（可选 `release`） | cargo profile，产物解析依据 |
| `cw32.chip` | `CW32L012x8` | probe-rs 芯片名（可被「识别芯片」自动填充） |
| `cw32.family` | `auto`（按 chip 前缀判定） | 家族档案：`cw32l012` / `cw32f030`，决定寄存器表/内存预设/目标 yaml |
| `cw32.detectPath` | `cw32-detect` | cw32-detect 可执行文件路径（出厂数字签名识别，[cw32-probe-rs-compat](https://github.com/SunWithCloude/cw32-probe-rs-compat)） |
| `cw32.chipDescriptionPath` | 空 | 外部 target YAML。**默认留空即可**：probe-rs 0.32+ 内置 CW32L0，CW32F030 用插件自带 `tools/families/CW32F030_Series.yaml` |
| `cw32.probeId` | `0483:3748` | 探针 VID:PID |
| `cw32.protocol` | `swd`（可选 `jtag`） | 调试协议 |
| `cw32.flashBaseAddress` | `0x00000000` | `.bin` 烧录基地址（CW32L012 FLASH ORIGIN = 0x0，不是 STM32 的 0x08000000） |
| `cw32.workspaceRoot` | 空（自动检测） | 手动指定 Cargo 根目录 |
| `cw32.apiPort` | `3678` | Agent API 端口（仅 127.0.0.1） |
| `cw32.apiToken` | 空 | 设置后请求必须带 `x-cw32-token` 头 |
| `cw32.apiAutoStart` | `true` | 插件激活时自动启动 API |
| `cw32.verifyAfterFlash` | `true` | 烧录后自动 `probe-rs verify` 校验（0.6.0+） |
| `cw32.monitorBaudRate` | `115200` | 串口监视器默认波特率（0.6.0+） |
| `cw32.mcpPort` | `3679` | 内嵌 MCP 服务器端口（SSE，仅 127.0.0.1）（0.6.1+） |
| `cw32.mcpAutoStart` | `true` | 插件激活时自动启动 MCP 服务器（0.6.1+） |

---

## Agent API（AI / 脚本直连）

插件内置 localhost HTTP JSON 服务（默认 `http://127.0.0.1:3678`），任何 Agent / 脚本可直接 curl。完整端点文档、错误码语义与「AI 烧录 blink_pc13」完整流程见 **[docs/AGENT_API.md](docs/AGENT_API.md)**。

端点一览：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` `/api/help` | 列出全部端点 |
| GET | `/api/status?deep=1` | probe / MCU / artifact / 调试会话状态 |
| GET | `/api/probes` | `probe-rs list` 原始输出 |
| GET | `/api/artifact` | 当前选中的固件产物 |
| GET | `/api/examples` | cargo example 列表 |
| POST | `/api/build` | build（已选例程=增量秒级；自动模式=clean + 全量，长任务） |
| POST | `/api/flash` | 烧录（body 可带 `{"path":"..."}`） |
| POST | `/api/reset` | 复位目标 |
| POST | `/api/erase` | 全片擦除 |
| GET | `/api/memory?address=&length=` | 读内存（优先调试会话，否则 CLI） |
| GET | `/api/debug/state` | PC / 调用栈 / 变量 |
| POST | `/api/debug/pause` `/api/debug/continue` | 暂停 / 继续 |
| GET | `/api/logs` | 最近日志 |

示例：

```bash
curl -s http://127.0.0.1:3678/api/status?deep=1
curl -s -X POST http://127.0.0.1:3678/api/build
curl -s -X POST http://127.0.0.1:3678/api/flash
curl -s "http://127.0.0.1:3678/api/memory?address=0x20000000&length=64"
```

**422 防伪烧录**：`/api/flash` 若在 body 传入未通过校验的路径（`.d`/`.rmeta`/`.o` 等中间文件，或 ELF 魔数不符的文件），返回 `422 Unprocessable Entity`。这是 **artifact 选择错误，不是 MCU 问题**——用于防止 AI / 脚本把编译中间文件当固件烧进 Flash。

---

## 常见故障排查

| 现象 | 原因 | 处置 |
|---|---|---|
| 烧录报 `Unknown file magic` / `decode the elf` 失败 | 烧录对象不是有效固件（artifact 选择错误） | **不是 MCU 问题**。重新 Build，或用手选命令选正确的 `.elf`；检查是否误选 `.d`/`.o` 中间文件 |
| `probe: online` 但 `mcu: unreachable` | SWD 接线 / 目标供电问题 | 检查 SWDIO、SWCLK、GND 三线；确认目标板供电；NRST 可选 |
| 探针列表为空 / `probe: offline` | 驱动 / USB / probe-rs 未安装 | `probe-rs list` 看枚举；重装 ST-LINK 官方驱动；换 USB 口/线 |
| API 连不上（connection refused） | apiAutoStart=false / 端口被占 / token 未带 | 执行 `CW32: 启动 Agent API`；检查 `apiPort`；设了 `apiToken` 需带 `x-cw32-token` 头 |
| 烧录成功但程序不运行 | `.bin` 基地址错误 | `flashBaseAddress` 必须为 `0x00000000`（CW32L012 FLASH ORIGIN） |
| `409` 未找到有效固件 | 还没 build | 先 `POST /api/build`；这是 artifact 问题不是 MCU 问题 |
| 串口无数据 | 引脚/波特率不匹配 | uart_echo 例程为 PA02=TX/PA03=RX、115200-8-N-1；确认共地 |

---

## 许可

MIT，见 [LICENSE](LICENSE)。


## MCP 服务器（0.6.1+，AI 直连）

插件内置 MCP（Model Context Protocol）服务器：SSE 传输，
`http://127.0.0.1:3679/sse`（配置 `cw32.mcpPort` / `cw32.mcpAutoStart`）。
19 个工具覆盖硬件工作流（状态/构建/烧录/调试控制/内存读写/外设寄存器/串口/诊断），
**不含代码编辑工具**（编辑是 VS Code 本体与 AI 编辑器的职责）。
Claude Code 配置：

```json
{ "mcpServers": { "cw32": { "type": "sse", "url": "http://127.0.0.1:3679/sse" } } }
```

## AI × 人类 并发防护（0.6.2+）

- 硬件互斥租约：写入类与读取类（读内存/寄存器/deep 探测）硬件操作单一占用，
  human/ai/api 三类署名，冲突时结构化报错说明占用方
- 设置版本号 settingsEpoch：配置/例程选择变更即 +1；AI 关键操作可带
  expectedEpoch 乐观锁，被人类中途改设置则拒绝并引导重新 status
- API 租约在请求完成（含中断/异常）后释放；15 分钟过期租约自动作废

详见 `docs/AGENT_API.md`。
