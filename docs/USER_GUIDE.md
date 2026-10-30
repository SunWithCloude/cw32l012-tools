# CW32L012 Tools 使用者手册

面向使用者的界面说明：仪表盘布局、三步工作流、调试/内存面板、例程选择与串口监视。
Agent / AI 集成（HTTP API、MCP）见 [AGENT_API.md](AGENT_API.md)；版本历史见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

---

## 1. 活动栏与状态栏

- 活动栏 **CW32L012** 图标 → 侧边栏仪表盘（`CW32L012 Console`）。
- 状态栏常驻 `$(chip) CW32L012: MCU 在线`（绿）/ `探针离线`（灰）/ `MCU 无应答`（红），
  点击直达仪表盘。5s 轻量刷新（probe-rs list），不做 reset 级检测。

## 2. 仪表盘布局（自上而下）

| 区块 | 内容 | 交互 |
|---|---|---|
| 顶部状态条 | `PROBE OFFLINE / PROBE ONLINE / MCU ONLINE / MCU UNREACHABLE` 徽标 | 只读（2s 刷新） |
| 六块指标 | Probe / MCU / Firmware / Serial / Agent API / MCP | 全部可点击（深度检测 / 复位 / 选固件 / 串口 / 启停 API / 启停 MCP） |
| 源目录栏 | 构建/烧录/调试实际使用的目录 + `手动`/`自动`徽标 | 「切换」按钮 → 输入路径（须含 Cargo.toml，留空恢复自动探测） |
| 工作流三卡 | ① Build → ② Flash → ③ Monitor | 点卡片执行主操作；卡内小链接：清理 / 换例程 / SWD 调试 / 擦除芯片（红，二次确认）/ 发送一行 |
| 可视化调试面板 | PC / 调用栈 / 变量（1s 轮询 DAP 会话） | 暂停 / 继续 / 步过 / 步入 / 步出 / 复位 / 停止 |
| 外设寄存器面板 | SYSCTRL / GPIOA / GPIOB / UART1 位段解码 | 选外设 → 「读取」（无调试会话时走 probe-rs CLI 兜底） |
| 内存视图 | hex + ASCII 双栏渲染 | 预设下拉（SRAM/向量表/SYSCTRL/GPIOA/UART1/SysTick）或手输地址；读取 / 写入（写需调试会话） |
| System log | 最近 20 条操作日志 | 只读 |
| Agent API 面板 | 常用 curl 示例 + 一键复制 | 只读 |
| 串口监视面板 | 接收数据流（与输出通道 `CW32L012 Serial` 同源） | 只读，发送见③卡 |

## 3. 三步工作流

1. **Build**：已选例程 → 增量构建（秒级，跳过 clean）；未选（自动模式）→ `cargo clean` + 全量 `--examples`。产物自动过校验（ELF 魔数 / 扩展名 / 黑名单目录）。
2. **Flash**：自动选最新有效产物烧录（`.bin` 按 `flashBaseAddress=0x00000000`），可选烧录后 verify；点「SWD 调试」则直接烧录 + 启动 DAP 会话，无需先点②。
3. **Monitor**：选 COM 口 + 波特率打开串口（内置 serialport）；再次运行本命令可关闭 / 发送 / 切换。

> 例程选择 = Keil target 下拉的替代：Build 卡内「换例程」，选定后构建/烧录/调试都锁定该例程；
> 例程尚无产物时拒绝回退烧别的固件（先 Build）。
> 源目录：多仓库场景用「源目录栏 → 切换」手动指定 Cargo 根；设置写入 workspace 级 `cw32.workspaceRoot`。

## 4. 常见问题

| 现象 | 处置 |
|---|---|
| 烧录报 `Unknown file magic` | artifact 错误不是 MCU 问题：重新 Build，或用「选择固件」手选 `.elf` |
| probe 在线但 MCU 无应答 | 查 SWDIO/SWCLK/GND 三线与供电；NRST 可选 |
| 串口打不开 | serialport 模块缺失时插件会提示降级（用外部串口工具），不崩溃 |
| F5 调试无 launch.json | 插件自动补全为「当前 ELF 产物」，前提是已 Build 出有效 ELF |
