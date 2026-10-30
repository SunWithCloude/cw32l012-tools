# CW32 Tools

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/SunWithCloude/cw32-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/SunWithCloude/cw32-tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-007ACC.svg)](https://code.visualstudio.com/)

A VS Code extension that turns the **build → flash → debug** loop for
[CW32L012](https://www.whxy.com) (Cortex-M0+, 64 KB flash / 8 KB SRAM, Rust
`thumbv6m-none-eabi`) into three buttons — plus a localhost HTTP + MCP API so an
AI agent or a script can drive the same hardware workflow.

> **Scope**: this is the Keil-style half of the toolchain — build, flash, debug,
> inspect. It deliberately contains **no code editing**: writing, completion and
> diagnostics belong to VS Code + rust-analyzer.

- Version `0.9.0`
- Hardware path: ST-LINK `0483:3748` over SWD, `probe-rs` 0.32
- Target: `CW32L012x8` (built into probe-rs; no external YAML needed)
- Debug backend: `probe-rs dap-server` → native VS Code breakpoints, stepping and
  variable watch

---

## Features

| Capability | Detail | Status |
|---|---|---|
| Build firmware | `cargo clean` + `cargo build --target thumbv6m-none-eabi --examples` | Done |
| Artifact resolution | Locates the real output dir via `cargo metadata`; accepts only `.elf` / `.bin` / `.hex` **and** verifies the ELF magic, so `.d` / `.rmeta` / `.o` can never be flashed by accident | Done |
| Flash (auto or pick) | Newest valid artifact, or choose from the verified list; `.bin` is flashed at `flashBaseAddress = 0x00000000` | Done |
| Full chip erase | `probe-rs erase --allow-erase-all` (modal confirmation) | Done |
| Reset | `probe-rs reset`; doubles as the "is the MCU alive" probe | Done |
| Visual debugging | Registers a `cw32-probe-rs` debug type that spawns `probe-rs dap-server --single-session`: native breakpoints/stepping/watch **plus** a dashboard panel with PC, call stack, variables and a memory hex view | Done |
| Dashboard | Sidebar webview: graded status, clickable status strip, workflow card (① build → ② flash → ③ monitor), debug/memory panels, log ring buffer | Done |
| Serial monitor | **In-panel implementation** (no external tool), with line send | Done |
| Agent API | localhost HTTP JSON for AI / scripts — see `docs/AGENT_API.md` | Done |
| MCP server | SSE transport, 19 tools over the hardware workflow | Done |
| Multi-family | `cw32.family` profiles (CW32L012 / CW32F030): per-family register decode maps, memory presets and the bundled `tools/families/CW32F030_Series.yaml` target (byte-identical to upstream probe-rs PR #4549) — no manual chip-description config needed | Done |
| Chip auto-detect | `cw32_chip_detect` tool / `GET /api/detect` runs [cw32-detect](https://github.com/SunWithCloude/cw32-probe-rs-compat) (factory digital-signature reader) and can auto-fill the `chip` setting | Done |
| Probe exclusivity | While a debug session is alive, all reads go through DAP (auto pause→read→resume when running); hardware ops (flash/erase/reset/detect) stop the session first — the CLI-vs-dap-server probe contention that silently killed sessions in 0.6.x is gone | Done |
| Status bar, example picker, post-flash verify, standalone clean | — | Done |

Deeper docs (currently Chinese):

- User guide — dashboard layout, debug panel, memory view presets, serial monitor: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Agent / AI integration — full curl walkthrough, error-code semantics, token auth: [docs/AGENT_API.md](docs/AGENT_API.md)
- Release notes: [docs/RELEASE_NOTES.md](docs/RELEASE_NOTES.md)
- End-to-end smoke script (PowerShell): [tools/e2e-check.ps1](tools/e2e-check.ps1)

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| VS Code | ≥ 1.90 | `engines.vscode = ^1.90.0` |
| Rust toolchain | current stable | via `rustup` |
| `thumbv6m-none-eabi` target | matching your project | `rustup target add thumbv6m-none-eabi` |
| probe-rs | ≥ 0.32 | `cargo install probe-rs-tools --locked` (provides `probe-rs` and `dap-server`) |
| ST-LINK driver | vendor driver | must enumerate as `0483:3748` |

Sanity check:

```bash
rustup target list --installed        # should list thumbv6m-none-eabi
probe-rs --version                    # 0.32.x
probe-rs list                         # should list [0] ST-LINK ... 0483:3748
probe-rs chip list | grep CW32L0      # 0.32+ ships the CW32L0 series
```

## Install

```bash
# from a packaged VSIX
code --install-extension cw32-tools-0.9.0.vsix

# or build it yourself
npm ci && npm run compile
npx @vscode/vsce package
code --install-extension cw32-tools-0.9.0.vsix
```

Or use the Extensions view → `...` → *Install from VSIX…*. After installation,
open the **CW32** icon in the activity bar to reach the dashboard.

Then **open a Rust workspace containing `Cargo.toml`** (for example
[`Rust_Cw32L012`](https://github.com/SunWithCloude/Rust_Cw32L012), the companion
HAL). The extension walks upwards to find the cargo root; you can also pin it
with `cw32.workspaceRoot` or the *Source directory* field in the dashboard.

---

## Quick start: Build → Flash → Debug

1. **Build** — click *Build firmware* in the dashboard (or
   `CW32: Build firmware` from the command palette). The extension runs
   `cargo clean` then `cargo build --target thumbv6m-none-eabi --examples`;
   artifacts land in `target/thumbv6m-none-eabi/debug/examples/` (extension-less
   ELF files such as `blink_pc13`).
2. **Flash** — click *Flash*. The newest verified artifact is selected
   automatically, or pick one manually with *Select firmware to flash*. Wire
   SWDIO / SWCLK / GND to the ST-LINK and it flashes, then runs a graded
   probe/MCU health check.
3. **Debug** — click *SWD debug*: it flashes the current ELF and starts a
   `probe-rs` DAP session. Set breakpoints in source, press F5, and watch PC,
   call stack and variables live in the dashboard; the memory view reads any
   address.

> **Probe online ≠ MCU online.** Successful USB enumeration only proves the
> dongle is there. Whether the core answers is decided by `probe-rs reset`
> (`/api/status?deep=1`, or the *Deep check* command).

---

## Commands

All 26 commands; the dashboard only surfaces the main flow and folds the rest
away by context.

| Command | Purpose |
|---|---|
| `CW32: Open dashboard` | Open the dashboard panel |
| `CW32: Build firmware` | Selected example → incremental build; auto mode → clean + build all examples |
| `CW32: Rebuild` | clean + build, ignoring the example selection |
| `CW32: Clean build output` | `cargo clean` only |
| `CW32: Select example` | Pick the cargo example / target (Keil-style target dropdown) |
| `CW32: Flash via DAPLink` | Flash, auto-selecting the artifact |
| `CW32: Select firmware to flash` | Choose from the verified artifact list |
| `CW32: Erase all` | `probe-rs erase --allow-erase-all` (modal confirm) |
| `CW32: Start SWD debug session` | Flash + start the DAP session |
| `CW32: Debug — pause / continue / step over / step into / step out / restart` | Fine-grained control of the active DAP session |
| `CW32: Debug — stop session` | End the DAP session |
| `CW32: Deep check probe / MCU` | reset-level MCU liveness check |
| `CW32: Reset target` | `probe-rs reset` |
| `CW32: Open serial monitor` | In-panel serial monitor |
| `CW32: Serial send` | Send one line to the port |
| `CW32: AI diagnostic report` | Collect diagnostics and copy to clipboard |
| `CW32: Start/stop Agent API` | Toggle the HTTP API (also `start` / `stop`) |
| `CW32: Toggle embedded MCP server` | Start/stop the SSE MCP server |
| `CW32: Set source directory` | Write `workspaceRoot`; empty restores auto-detection |
| `CW32: Generate .mcp.json` | Write the correct MCP client config for the embedded MCP server into the workspace |

## Settings (`cw32.*`)

| Key | Default | Meaning |
|---|---|---|
| `target` | `thumbv6m-none-eabi` | Rust target triple |
| `profile` | `debug` (`release`) | cargo profile; drives artifact resolution |
| `chip` | `CW32L012x8` | probe-rs chip name |
| `chipDescriptionPath` | *(empty)* | External target YAML. **Leave empty** — probe-rs 0.32+ ships CW32L0. When empty the extension auto-detects `tools/CW32L0_Series.yaml` in the workspace as a fallback for older probe-rs |
| `probeId` | `0483:3748` | Probe VID:PID |
| `protocol` | `swd` (`jtag`) | Wire protocol |
| `flashBaseAddress` | `0x00000000` | `.bin` base address — CW32L012 flash origin is `0x0`, **not** STM32's `0x08000000` |
| `workspaceRoot` | *(empty, auto)* | Pin the cargo root |
| `apiPort` | `3678` | Agent API port (loopback only) |
| `apiToken` | *(empty)* | When set, requests must carry `x-cw32-token` |
| `apiAutoStart` | `true` | Start the API on activation |
| `verifyAfterFlash` | `true` | Run `probe-rs verify` after flashing |
| `monitorBaudRate` | `115200` | Serial monitor default baud rate |
| `mcpPort` | `3679` | Embedded MCP server port (SSE, loopback only) |
| `mcpAutoStart` | `true` | Start the MCP server on activation |

---

## Agent API

A localhost HTTP JSON service (default `http://127.0.0.1:3678`) that any agent or
script can curl. Full endpoint docs, error semantics and a complete "let an AI
flash `blink_pc13`" walkthrough live in **[docs/AGENT_API.md](docs/AGENT_API.md)**.

| Method | Path | Purpose |
|---|---|---|
| GET | `/`, `/api/help` | List all endpoints |
| GET | `/api/status?deep=1` | probe / MCU / artifact / debug-session state |
| GET | `/api/probes` | Raw `probe-rs list` output |
| GET | `/api/artifact` | Currently selected artifact |
| GET | `/api/examples` | cargo example list |
| POST | `/api/build` | Build (selected example = incremental; auto = clean + full) |
| POST | `/api/flash` | Flash (optional `{"path": "..."}` body) |
| POST | `/api/reset` | Reset target |
| POST | `/api/erase` | Full chip erase |
| GET | `/api/memory?address=&length=` | Read memory (debug session first, CLI fallback) |
| GET | `/api/debug/state` | PC / call stack / variables |
| POST | `/api/debug/pause`, `/api/debug/continue` | Halt / resume |
| GET | `/api/logs` | Recent log lines |

```bash
curl -s http://127.0.0.1:3678/api/status?deep=1
curl -s -X POST http://127.0.0.1:3678/api/build
curl -s -X POST http://127.0.0.1:3678/api/flash
curl -s "http://127.0.0.1:3678/api/memory?address=0x20000000&length=64"
```

**HTTP 422 = wrong artifact, not a sick MCU.** If `/api/flash` receives a path
that failed validation (a `.d` / `.rmeta` / `.o` intermediate, or a file whose
ELF magic is wrong) it answers `422 Unprocessable Entity`. That guard exists so
an agent cannot brick the flash by flashing a build by-product.

## MCP server

SSE transport at `http://127.0.0.1:3679/sse` (`mcpPort` / `mcpAutoStart`).
19 tools cover the hardware workflow — status, build, flash, debug control,
memory read/write, peripheral registers, serial, diagnostics — and **no code
editing tools**; editing belongs to the editor and the AI extension.

```json
{ "mcpServers": { "cw32": { "type": "sse", "url": "http://127.0.0.1:3679/sse" } } }
```

## Human × AI concurrency guard

- **Hardware lease**: write-type and read-type hardware operations take a single
  exclusive lease, attributed to `human` / `ai` / `api`; conflicts return a
  structured error naming the holder.
- **`settingsEpoch`**: bumped whenever settings or the example selection change.
  Critical AI operations may pass `expectedEpoch` as an optimistic lock; if a
  human changed settings mid-flight the call is refused and the agent is told to
  re-read `status`.
- Leases are released when the request finishes (including aborts/exceptions);
  stale leases expire after 15 minutes.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Unknown file magic` / `decode the elf` failed | The thing being flashed is not valid firmware (artifact selection) | **Not an MCU fault.** Rebuild, or pick a real `.elf`; check nothing picked a `.d` / `.o` |
| `probe: online` but `mcu: unreachable` | SWD wiring or target power | Check SWDIO, SWCLK, GND; power the target; NRST optional |
| Empty probe list / `probe: offline` | Driver, USB, or probe-rs missing | `probe-rs list`; reinstall the ST-LINK driver; try another cable/port |
| API `connection refused` | `apiAutoStart=false`, port busy, or missing token | Run *Start Agent API*; check `apiPort`; add `x-cw32-token` if set |
| Flashes fine but nothing runs | Wrong `.bin` base address | `flashBaseAddress` must be `0x00000000` for CW32L012 |
| `409` no valid firmware | Nothing built yet | `POST /api/build` first — an artifact problem, not an MCU problem |
| No serial data | Pins or baud rate | The `uart_echo` example uses PA02=TX / PA03=RX at 115200-8-N-1; make sure grounds are shared |

## Related

- HAL crate: [`cw32l012-hal`](https://crates.io/crates/cw32l012-hal) · [docs.rs](https://docs.rs/cw32l012-hal) · [repo](https://github.com/SunWithCloude/Rust_Cw32L012)
- probe-rs: <https://probe.rs>

## License

MIT — see [LICENSE](LICENSE).
