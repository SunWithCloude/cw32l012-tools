# 更新日志

CW32L012 Tools — 所有版本的变更记录。

- 当前版本：`0.6.7`
- 开发中：无（见下方条目）

---

## 0.6.7（2026-10-18，SWD 调试修复）

- **修复「SWD 调试打不开」**：probe-rs 0.32 dap-server 将 `coreConfigs[].program`
  改名为 `programBinary`，旧字段被拒绝（报 `specify program-binary`）导致
  调试会话启动失败。启动配置（命令「SWD 调试」+ F5 自动补全）与 package.json
  调试器 schema/代码片段全部切换到 0.32 schema
- 新增调试定位工具 `tools_um/dap_probe_test.py`：手动 stdio DAP 握手复现
  launch 序列，直接拿 dap-server 真实报错
- 手动 DAP 全流程验证：initialize → launch（含 ELF 烧录）→ OK（1.0s）
- **可移植性修复**：`cw32l012.chipDescriptionPath` 原默认值是写死的本机路径
  `C://Users//Administrator//Downloads//CW32L0_Series.yaml`，且 probe-rs 命令行
  无条件传 `--chip-description-path`——别人装上插件、本机没有该文件时烧录必然失败。
  现改为：默认空（probe-rs 0.32+ 已内置 CW32L0）→ 空值时自动探测工作区
  `tools/CW32L0_Series.yaml`（旧版 probe-rs 兜底）→ 仅非空才拼命令行参数
- **文档英文化**：`README.md` 改为英文（GitHub / 市场页展示），原中文版保留为
  `README.zh-CN.md`；顺手修正安装示例里的旧版本号与已迁移的本机路径
- 补齐开源要件：`LICENSE`（MIT）、`.gitattributes`、GitHub Actions CI
  （npm ci → tsc 类型检查 → 打包 VSIX 并上传产物）

---

## 0.6.6（2026-10-17，挑刺自修第二辑）

- **构建基础设施补齐**：新增 `tsconfig.json`（strict 零错误）、`.vscodeignore`、
  `icon.png`（程序化生成的暗金芯片图标）；npm install 补齐依赖
- 修复 MCP `cw32_debug_start` 假成功（启动失败不再返回 started:true）
- 修复 MCP `cw32_status` deep 模式绕过硬件租约（与 API 侧行为对齐）
- API `POST /api/examples/select` 纳入硬件租约（改例程影响构建，与 MCP 对齐）
- API `/api/build` `/api/flash` 支持 `expectedEpoch` 乐观锁；
  成功响应补 `settingsEpoch` 字段
- `cw32l012.debugStop` 注册为正式命令（命令面板/键位绑定可用）
- 版本号动态化：激活提示 / MCP serverInfo 从 package.json 读取，不再硬编码
- 仪表盘源目录「手动/自动」徽标接入 2s 轮询刷新
- 文档腐化清理：README 版本 0.5.0 → 0.6.6；补 `docs/USER_GUIDE.md` 与
  `tools/e2e-check.ps1`（README 此前引用了不存在的文件）；
  修正 AGENT_API `/api/registers` 表格行返回值错误

---

## 0.6.5（2026-10-17，源目录可视化切换）

- 仪表盘新增「源目录」栏：实时显示构建实际使用的目录 + 手动/自动徽标 + 切换按钮
- 新命令 `cw32l012.setSourceDir`：输入路径校验（存在 + 含 Cargo.toml）后写回
  workspace 级 `workspaceRoot` 设置；留空恢复自动探测
- 目录切换作废 example/产物缓存并 bump settingsEpoch（AI 侧可感知）
- MCP 状态块接入 2s 周期刷新

---

## 0.6.4（2026-10-17，仪表盘工作流重构）

- 15 张操作卡 → 3 张工作流大卡（① 构建 → ② 烧录 → ③ 监视），
  次级操作折叠为卡内小链接
- 状态条六块（Probe/MCU/Firmware/Serial/AgentAPI/MCP）全部可点击，
  承接深度检测 / 复位 / 选固件 / 串口 / 启停
- 删除重复 UI：「重新构建」（build 同义别名）、「AI 报告」（占位）及
  六张被折叠的独立卡；对应命令仍注册在命令面板 / Agent API
- 全片擦除降级为烧录卡内红色危险链接（二次确认保留）
- 纯 Webview 模板层改动，无逻辑变更（24 命令、租约、API/MCP 不动）

---

## 0.6.3（2026-10-17，挑刺自修版）

- 修复 **API 租约提前释放竞态**：客户端中断（curl Ctrl+C）不再提前放锁，
  释放移至请求处理完毕（.finally），杜绝「中断后他人进场双重烧录」
- 修复 **MCP cw32_debug_control 假成功**：无调试会话时此前返回成功结果，现在抛错
- 硬件租约覆盖读取类：cw32_memory_read / cw32_registers_read 与
  GET /api/memory、GET /api/registers、GET /api/status?deep=1（同样独占探针）
- checkEpoch 移入租约内执行；build/flash/debug_start 成功响应携带 settingsEpoch
- setSelectedExample 同值防抖（避免无意义的 epoch+1 造成假冲突）
- MCP 协议健壮性：initialize 回显客户端 protocolVersion；未知 session 的
  POST 返回 404（防响应静默丢失挂死客户端）；SSE 30s 心跳
- 文档更正：固件选择是「选了即烧」，无持久状态（原文错误宣称参与 epoch）；
  README 补 MCP 服务器与并发防护章节
- serialBaud 状态清理；humanLease 标签更诚实（「选择固件并烧录」）

## 0.6.2（2026-10-17）

- **AI × 人类并发防护**（防「互相搞乱」）：
  - 硬件互斥租约：所有改动硬件/状态的操作（构建/烧录/擦除/复位/调试控制/
    写内存/开串口/例程选择）单一占用，冲突方收到「谁在干什么+多久」的
    结构化提示；15 分钟过期租约自动作废，不会永久卡死
  - 设置版本号 settingsEpoch：配置/例程/产物被改即 +1；cw32_build /
    cw32_flash / cw32_debug_start 支持 expectedEpoch 乐观锁，
    设置被人类中途改过则拒绝执行并引导重新 status（自愈，不盲干）
  - 人类入口冲突时弹 toast 而非报错；API 冲突返回 409 + conflict:true
  - cw32_status 与 /api/status 均返回 settingsEpoch 与当前 lease 占用

## 0.6.1（2026-10-17）

- **内嵌 MCP 服务器**（SSE，默认端口 3679，`cw32l012.mcpPort`/`cw32l012.mcpAutoStart`）：
  19 个工具覆盖硬件工作流（状态/构建/烧录/调试控制/内存读写/外设寄存器解码/串口/诊断），
  供 Claude Code 等 MCP 客户端直连；复用插件内 DAP 会话与 CLI 通道，无探针独占冲突；
  **不含代码编辑工具**（编辑留给 VS Code 本体与 AI 编辑器）
- 仪表盘：Agent 卡片区新增 MCP 启停卡片；Agent API 面板头显示 MCP 端口状态
- 命令：`CW32L012: 启停内嵌 MCP 服务器`

## 0.6.0（开发中）

- 状态栏：常驻显示 probe / MCU 分级状态与当前固件产物
- 例程选择器：快速切换要烧录的 example（从命令面板/仪表盘直达）
- 烧录后 verify：flash 完成后自动读回校验（配置项 `cw32l012.verifyAfterFlash`，默认开）
- 串口监视器：**VS Code 输出面板内实现**（`serialport` 动态加载，模块缺失时优雅降级），并新增 Agent API 串口端点（`/api/serial/*`）
- 擦除：`全片擦除` 命令并入命令面板与仪表盘
- clean：独立 `cargo clean` 命令
- **构建提速**：指定例程时跳过 `cargo clean` 走增量构建（`cw32l012.build` 与 `POST /api/build` 行为一致）；自动模式（全量 `--examples`）与 `重新构建` 命令仍保持 clean + build
- **调试补全**：单步控制（步过/步入/步出/复位重跑）进命令面板、仪表盘与 Agent API；暂停/继续改用真实 threadId（修复硬编码 0 的兼容隐患）；内存写入（DAP writeMemory）；外设寄存器面板（SYSCTRL/GPIOA/GPIOB/UART1 偏移+位段解码，数据来自 HAL pac.rs 已核对的地址表）
- 仪表盘增强：刷新/交互改进、日志与状态展示优化

---

## 0.5.0（2026-10-07）

### 新增

- **Agent API**（AI 直连）：localhost HTTP JSON 服务（默认端口 `3678`，仅绑定 `127.0.0.1`）
  - `GET /`、`/api/help`：端点清单
  - `GET /api/status?deep=1`：probe / MCU / artifact / 调试会话综合状态（deep=1 做 reset 级 MCU 检测）
  - `GET /api/probes`：`probe-rs list` 原始输出
  - `GET /api/artifact`：当前选中产物
  - `GET /api/examples`：cargo example 列表
  - `POST /api/build`：cargo clean + build --examples
  - `POST /api/flash`：烧录（body 可带 `{"path":"..."}`）
  - `POST /api/reset`、`POST /api/erase`
  - `GET /api/memory?address=&length=`：读内存（优先调试会话，否则 CLI 兜底）
  - `GET /api/debug/state`、`POST /api/debug/pause`、`POST /api/debug/continue`
  - `GET /api/logs`：最近日志
- **配置项**：`cw32l012.apiPort`（默认 3678）、`cw32l012.apiToken`（可选，设置后需 `x-cw32-token` 头）、`cw32l012.apiAutoStart`（默认 true）
- **命令**：`CW32L012: 启动 Agent API`、`CW32L012: 停止 Agent API`、`CW32L012: 启动/停止 Agent API`
- 仪表盘新增：Agent API 面板（端点示例 + 鉴权说明）、调试提示面板

### 修复 / 改进

- 固件产物解析：基于 `cargo metadata` 的 `target_directory`，只扫描 `<triple>/<profile>/examples`、`<triple>/<profile>`、`<triple>/release`、`firmware/` 一层
- 伪烧录防护：ELF 魔数校验 + 黑名单目录（`deps/`、`incremental/`、`.fingerprint/`、`build/`）与黑名单扩展名（`.d`、`.rmeta`、`.o` 等）
- 状态分级：`probe online ≠ MCU online`，MCU 在线以 `probe-rs reset` 应答为准（`/api/status` 的 `note` 字段明示）
- 深度检测命令 `CW32L012: 深度检测 probe / MCU 状态`

---

## 0.4.0（2026-10-07）

### 新增

- **固件选择**：`CW32L012: 选择固件烧录`（QuickPick 列表，仅显示通过校验的产物）
- **深度状态检测**：`CW32L012: 深度检测 probe / MCU 状态`（reset 级 MCU 在线判定）
- **配置项重构**：`cw32l012.target`、`cw32l012.profile`（debug/release）、`cw32l012.chip`、`cw32l012.chipDescriptionPath`、`cw32l012.probeId`、`cw32l012.protocol`、`cw32l012.flashBaseAddress`（默认 `0x00000000`）、`cw32l012.workspaceRoot`

### 修复 / 改进

- 移除旧式 `toolchainPath` / `flashCommand` / `runner` / `debugger` 配置（v0.1–0.3 时代的过渡配置）
- `.bin` 烧录基地址修正为 `0x00000000`（CW32L012 FLASH ORIGIN，不是 STM32 的 0x08000000）

---

## 0.3.x（2026-10-07）

### 0.3.3

- 调试启动参数兼容修正（probe-rs dap-server 参数 snake_case / camelCase 双写）

### 0.3.0 – 0.3.2

- 构建流程完善：build 前自动 `cargo clean`，产物解析走 `cargo metadata`
- 调试准备阶段修复

---

## 0.2.x（2026-10-06 ~ 07）

### 0.2.5 – 0.2.9

- 配置项引入芯片相关键：`cw32l012.chip`、`cw32l012.chipDescriptionPath`、`cw32l012.probeId`、`cw32l012.protocol`、`cw32l012.workspaceRoot`
- 引入 `cw32l012.runner`（0.2.9 起），为 probe-rs 工作流铺路
- 逐步向 probe-rs（替代早期 pyOCD/DAPLink 假设）迁移

---

## 0.1.x（2026-10-04）

### 0.1.8

- `CW32L012: AI 诊断报告`（AI Summary）：收集 workspace / target / artifact / probe / mcu 状态并复制到剪贴板
- 定位更新：probe-rs + DAPLink 工作流（替代早期 pyOCD 假设）

### 0.1.0 – 0.1.7

- 首个可用版本：仪表盘 Webview、构建、烧录、复位、串口监视提示、调试会话启动骨架
- 配置项：`cw32l012.toolchainPath`、`cw32l012.flashCommand`、`cw32l012.debugger`、`cw32l012.target`
- 活动栏 CW32L012 图标 + Dashboard 侧边视图

---

## 0.0.x（未发布）

- 项目脚手架：VSIX 打包配置、图标、许可证
