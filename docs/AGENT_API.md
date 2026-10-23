# CW32L012 Tools — Agent / AI 集成专篇

本插件内置 **Agent API**：一个只监听 `127.0.0.1` 的 HTTP JSON 服务（默认端口 `3678`）。AI 助手（如 Claude Code）、CI 脚本、自定义工具都可以直接 curl 驱动「构建 → 烧录 → 复位 → 读内存 → 调试暂停/继续」整条硬件链路，与人类操作员看到的是同一份状态。

> 版本：0.6.6。

---

## 0. 快速开始

```bash
# 1. 列端点
curl -s http://127.0.0.1:3678/

# 2. 看状态（deep=1 会做 reset 级 MCU 检测，稍慢）
curl -s "http://127.0.0.1:3678/api/status?deep=1"

# 3. 构建
curl -s -X POST http://127.0.0.1:3678/api/build

# 4. 烧录（自动选产物）
curl -s -X POST http://127.0.0.1:3678/api/flash

# 5. 复位
curl -s -X POST http://127.0.0.1:3678/api/reset

# 6. 读向量表（验证烧录：前 4 字节应为 00 20 00 20 = 0x20002000）
curl -s "http://127.0.0.1:3678/api/memory?address=0x0&length=8"
```

所有 `curl` 均建议加 `-s` 静默，并可用 `-m <秒>` 或 `--max-time` 限时。

---

## 1. 端点总表

| 方法 | 路径 | 说明 | 典型返回（节选） |
|---|---|---|---|
| GET | `/` `/api/help` | 列出全部端点 | `{ ok, routes: [...], example }` |
| GET | `/api/status` | 综合状态（`?deep=1` 触发 reset 级 MCU 检测；deep 与读取一样占租约） | `{ ok, settingsEpoch, lease, workspace, probe, mcu, device, detail, artifact, debug, flashBaseAddress, note }` |
| GET | `/api/probes` | `probe-rs list` 原始输出 | `{ ok, output }` |
| GET | `/api/artifact` | 当前自动选中的固件产物 | `{ ok, artifact: { path, kind } \| null }` |
| GET | `/api/examples` | cargo example 名称列表 + 当前选择 | `{ ok, examples: [...], targetDirectory, selected }` |
| POST | `/api/examples/select` | 选择例程：body `{"name":"blink_pc13"}`，`"__auto__"` 或省 name = 自动（占租约，改例程会 bump settingsEpoch） | `{ ok, selected, selectedLabel }` |
| POST | `/api/build` | 构建（已选例程=增量；自动模式=clean + build --examples）；body 可带 `{"expectedEpoch":N}` 乐观锁 | `{ ok, command, settingsEpoch, artifact: { path, kind } }` |
| POST | `/api/clean` | `cargo clean` | `{ ok, cleaned: true }` |
| POST | `/api/flash` | 烧录；body 可带 `{"path":"..."}` 指定产物、`{"expectedEpoch":N}` 乐观锁 | `{ ok, flashed, kind, mcu, settingsEpoch, output }` |
| POST | `/api/reset` | `probe-rs reset`（同时也是 MCU 在线判据） | `{ ok, mcu: "online（reset 应答）" }` |
| POST | `/api/erase` | 全片擦除（`probe-rs erase --allow-erase-all`） | `{ ok, erased: true }` |
| GET | `/api/memory` | 读内存：`?address=0x20000000&length=64`（length 1–256；占租约） | `{ ok, address, length, hex, ascii }` |
| POST | `/api/memory` | 写内存：body `{"address":"0x20000000","hex":"00112233"}`（4 字节对齐，需调试会话） | `{ ok, address, bytesWritten }` |
| GET | `/api/registers?name=sysctrl` | 外设寄存器读取 + 位段解码（sysctrl/gpioa/gpiob/uart1；占租约） | `{ ok, peripheral, label, base, regs: [{ name, offset, value, fields }] }` |
| GET | `/api/debug/state` | 调试会话状态：PC / 调用栈 / 变量 | `{ ok, debug: { active, sessionName, pc, frames, variables } }` |
| POST | `/api/debug/pause` | 暂停核心 | `{ ok, paused: true }` |
| POST | `/api/debug/continue` | 继续运行 | `{ ok, running: true }` |
| POST | `/api/debug/step-over` / `step-into` / `step-out` | 单步控制（步过/步入/步出） | `{ ok, action }` |
| POST | `/api/debug/restart` | 复位并重新运行程序 | `{ ok, action }` |
| GET | `/api/serial/ports` | 枚举可用串口 | `{ ok, ports: [...] }` |
| POST | `/api/serial/open` | 打开串口：body `{"path":"COM3","baudRate":115200}` | `{ ok, path, baudRate }` |
| POST | `/api/serial/close` | 关闭串口 | `{ ok, closed: true }` |
| POST | `/api/serial/send` | 串口发送：body `{"data":"AT\\r\\n"}` | `{ ok, sent }` |
| GET | `/api/serial/tail?limit=200` | 串口接收缓冲（最近 N 行） | `{ ok, open, path, lines }` |
| GET | `/api/diagnostics` | AI 诊断报告（文本） | `{ ok, report }` |
| GET | `/api/logs` | 最近 60 条日志 | `{ ok, logs: [...] }` |

约定：所有成功响应 `ok: true`；错误响应 `ok: false` + `error` 字符串，并带对应 HTTP 状态码。`GET /api/status?deep=1` 返回的 `note` 字段明确提示：**CW32L012 FLASH ORIGIN=0x00000000；probe 在线 ≠ MCU 在线，mcu 字段以 reset 交互为准**。

---

## 2. 「AI 烧录 blink_pc13」完整流程（curl 序列）

目标：不碰键盘、纯 HTTP，把 HAL 工程的 `blink_pc13` 例程烧进 CW32L012 并验证。假设插件已安装、工程已打开、API 在 `127.0.0.1:3678` 运行。

```bash
# 环境变量（PowerShell 用 $env:API=... / 或直接写死）
API=http://127.0.0.1:3678

# ── 0. 先探一下：服务活着、探针/MCU 什么状态 ─────────────────
curl -s "$API/api/status?deep=1"
# 期望: {"ok":true,"probe":"online","mcu":"online","device":"ST-LINK ...",
#         "artifact":{...},"flashBaseAddress":"0x00000000",...}
# 若 probe:"offline" → 驱动/USB 问题，先别烧；mcu:"unreachable" → SWD 接线问题。

# ── 1. 确认例程在（examples 列表应含 blink_pc13）───────────────
curl -s "$API/api/examples"
# 期望: {"ok":true,"examples":["blink","uart_echo","blink_pc13", ...], "targetDirectory":"..."}

# ── 2. 构建（自动模式 = clean + build --examples，可能要几分钟；已选例程则增量，秒级）─
curl -s -X POST "$API/api/build"
# 期望: {"ok":true,"artifact":{"path":"...\\debug\\examples\\blink_pc13","kind":"elf"}}

# ── 3. 烧录（不带 body = 自动选最新有效产物）─────────────────────
curl -s -X POST "$API/api/flash"
# 期望: {"ok":true,"flashed":"...\\debug\\examples\\blink_pc13","kind":"elf",
#         "mcu":"online","output":"..."}
# output 尾部是 probe-rs download 的日志（前 400 字符）。

# ── 4. 复位，再次确认 MCU 在线 ──────────────────────────────────
curl -s -X POST "$API/api/reset"
# 期望: {"ok":true,"mcu":"online（reset 应答）"}

# ── 5. 读向量表验证烧录结果 ─────────────────────────────────────
curl -s "$API/api/memory?address=0x0&length=8"
# 期望: {"ok":true,"address":"0x0","length":8,
#         "hex":"00200020793c0000", ...}
#     hex 前 4 字节 "00 20 00 20" = 0x20002000 = SRAM 顶端 = MSP 初值 ✔
#     第 2 项 0x00003c79 是复位入口地址（随链接而变）
# 若 hex 全是 "ff ff ff ff"（未擦除空白），说明没烧进去 → 回到步骤 3。

# ── 6. （可选）启动调试会话后远程暂停/继续 ──────────────────────
curl -s "$API/api/debug/state"                      # 看 PC/调用栈/变量
curl -s -X POST "$API/api/debug/pause"              # 暂停
curl -s -X POST "$API/api/debug/continue"           # 继续
```

> PowerShell 5.1 里执行 `curl` 是 `Invoke-WebRequest` 的别名，行为与 bash curl 不同。在 PowerShell 中用 `curl.exe` 或 `Invoke-RestMethod`，或直接运行 [tools/e2e-check.ps1](../tools/e2e-check.ps1)。

---

## 3. 错误码语义

| HTTP 状态码 | 场景 | error 提示示例 | AI 应如何处置 |
|---|---|---|---|
| `200` | 成功 | — | 正常 |
| `401` | 设置了 `cw32l012.apiToken` 但请求没带 / 带错 token | `token 不匹配（设置 cw32l012.apiToken 后需携带 x-cw32-token 头）` | 加上 `-H "x-cw32-token: <token>"` 重试 |
| `404` | 未知端点 | `未知端点 POST /api/foo`（body 带 `routes` 帮助） | 对照端点总表修正路径 |
| `409` | 没有打开工作区 / 未找到有效固件 / 无调试会话时调 pause | `未打开工作区`、`未找到有效固件，请先 build（artifact 错误，不是 MCU 不在线）`、`没有活动调试会话` | 区分场景：先 open workspace；先 `POST /api/build`；先启动调试会话 |
| `422` | **防伪烧录**：`/api/flash` body 传了未通过校验的路径 | `"..." 未通过固件校验（.elf/.bin/.hex + ELF 魔数），这是 artifact 错误，不是 MCU 问题` | **不要重试同一路径**。用 `GET /api/examples` + 已知产物路径，或直接不带 body 自动选产物 |
| `500` | 内部命令失败（build 编译错误 / probe-rs 命令失败等） | 命令输出尾部 | 读 `error` 里的实际命令报错；编译错误需修代码 |
| `503` | 读内存失败：无调试会话且 CLI read 也失败 | `读内存失败：无调试会话且 CLI read 也失败（MCU 可能未连接）` | 先 `POST /api/reset` 确认 MCU 在线再读 |

### 422 防伪烧录（重点）

`POST /api/flash` 的 body 若带 `path`，插件会用与命令面板完全相同的校验逻辑检查该文件：

- 扩展名必须是 `.elf` / `.bin` / `.hex`，**或**无扩展名文件（example 产物如 `blink_pc13`）；
- ELF 必须通过魔数校验（`0x7F ELF`）；HEX 必须 `:` 开头；
- 排除 `.d` / `.rmeta` / `.o` / `.rlib` / `.a` / `.exe` 等中间文件；
- 排除 `deps/`、`incremental/`、`.fingerprint/`、`build/` 等目录。

任何不满足的输入返回 `422`。**这是防 AI/脚本把 Cargo 中间文件当固件烧进 Flash 的设计**——返回 422 时不要把它当 MCU 故障，应修正要烧的路径。

---

## 4. Token 鉴权（可选）

设置配置项 `cw32l012.apiToken`（非空）后，所有 API 请求必须携带 token，两种方式任选其一：

```bash
# 方式一：请求头（推荐）
curl -s -H "x-cw32-token: mysecret" http://127.0.0.1:3678/api/status

# 方式二：query 参数
curl -s "http://127.0.0.1:3678/api/status?token=mysecret"
```

未携带或错误 → `401`。API 仅绑定 `127.0.0.1`（本机），token 用于防本机其他进程误调用。

---

## 5. 与仪表盘 / 命令的对应关系

| API 端点 | 对应命令 / 仪表盘动作 |
|---|---|
| `POST /api/build` | `CW32L012: Build firmware` / 仪表盘「固件构建」 |
| `POST /api/flash` | `CW32L012: Flash via DAPLink` / 「烧录」 |
| `POST /api/flash {"path":...}` | `CW32L012: 选择固件烧录` |
| `POST /api/erase` | （0.6.0 起并入命令面板） |
| `GET /api/memory` | 仪表盘「内存视图」 |
| `GET /api/debug/state` | 仪表盘「可视化调试」面板 |
| `POST /api/debug/pause` / `continue` | 仪表盘 暂停/继续 按钮 |
| `GET /api/status` | `CW32L012: 深度检测 probe / MCU 状态`（deep=1） |

---

## 6. 注意事项

- **长任务**：`/api/build` 可长达 10 分钟、`/api/flash` 3 分钟。客户端 curl 请设足够超时（如 `--max-time 620`），不要过早判死。
- **并发**：API 内部串行执行命令；并发发多个烧录/构建会排队。
- **端口占用**：`apiPort` 被占用时插件会提示 API 启动失败；改 `cw32l012.apiPort` 或停用其他占用进程。
- **apiAutoStart=false** 时需手动执行 `CW32L012: 启动 Agent API` 才能连上。

---

## 内嵌 MCP 服务器（0.6.1+）

除 HTTP API 外，插件内置 **MCP（Model Context Protocol）服务器**：SSE 传输，
默认端口 `3679`（配置 `cw32l012.mcpPort`，仅绑定 127.0.0.1，随插件自动启动）。
Claude Code / 其他 MCP 客户端配置：

```json
{
  "mcpServers": {
    "cw32l012": {
      "type": "sse",
      "url": "http://127.0.0.1:3679/sse"
    }
  }
}
```

**设计边界**：MCP 工具只管硬件工作流（构建/烧录/调试/内存/寄存器/串口/状态），
不提供任何文件/代码编辑工具——编辑是 VS Code 本体与 AI 编辑器的职责。
与外部 embedded-debugger-mcp 相比，本实现复用插件内的 DAP 会话与 CLI 通道，
**与人类操作员共享同一状态，无探针独占冲突**。

### AI × 人类 并发防护（0.6.2+）

- **硬件互斥租约**：同一时刻只允许一个操作者（human/ai/api 三类署名）占用
  硬件链路。覆盖写入类（build/flash/erase/reset/调试控制/写内存/开串口/例程选择）
  **以及读取类**（读内存/读寄存器/deep 状态探测——这些同样独占探针）。
  冲突返回结构化错误（API 409 `{"conflict":true}`，MCP isError），说明谁/干什么/多久。
  API 租约在请求处理完毕（含异常/客户端中断）后才释放，操作不会因 curl 中断而
  提前放锁。
  `GET /api/status` 与 `cw32_status` 都返回当前 `lease` 占用情况。
- **设置版本号 settingsEpoch**：`cw32l012.*` 配置或例程选择被改动即 +1
  （注：固件选择是「选了即烧」的一次性操作，无持久状态，由租约保护而非 epoch）。
  AI 的 `cw32_build` / `cw32_flash` / `cw32_debug_start` 可带 `expectedEpoch`（校验在租约内进行；三个工具成功响应也返回当前 settingsEpoch）（来自上次 `cw32_status`）；不匹配则拒绝执行并提示重新
  status——防止「AI 按旧设置烧录了人类刚改过的配置」这类静默事故。

工具清单（19 个）：`cw32_status` / `cw32_build` / `cw32_flash` / `cw32_reset` /
`cw32_erase` / `cw32_clean` / `cw32_examples` / `cw32_example_select` /
`cw32_memory_read` / `cw32_memory_write` / `cw32_registers_read` /
`cw32_debug_start` / `cw32_debug_state` / `cw32_debug_control`（pause/continue/
step_over/step_into/step_out/restart/stop） / `cw32_serial_open` /
`cw32_serial_send` / `cw32_serial_tail` / `cw32_diagnostics`
