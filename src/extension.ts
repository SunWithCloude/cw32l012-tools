import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import { spawn } from 'child_process';
import { FAMILIES, familyFromChip, FamilyKey, FamilyProfile, PeriphDef, RegDef, RegField } from './families';

/* ============================================================
 * CW32L012 Tools v0.7
 *
 *  - 构建/烧录：cargo metadata 定位真实产物目录，allowlist + 魔数校验
 *  - 可视化调试：注册 cw32l012-probe-rs 调试适配器（probe-rs dap-server），
 *    仪表盘轮询 DAP 会话渲染 PC/调用栈/变量/内存
 *  - 探针独占模型：调试会话存活期间一切读数只走 DAP（运行态自动
 *    pause→读→resume），硬件操作自动结束会话释放探针——杜绝 CLI 与
 *    dap-server 抢探针导致的会话静默死亡
 *  - 多家族：family profile 聚合芯片/寄存器表/目标文件，CW32L012 + CW32F030
 *  - AI 接口：内嵌 localhost HTTP JSON API + MCP(SSE) 服务器
 *  - Keil 感增强：常驻状态栏、例程选择器、烧录后自动 verify、串口监视器
 * ============================================================ */

const DASHBOARD_TITLE = 'CW32 Console';
const LOG_NAME = 'CW32L012 Tools';
/** 旧版 probe-rs（< 0.32）才需要的外部目标文件；新版已内置 CW32L0 */
const LEGACY_YAML_REL = path.join('tools', 'CW32L0_Series.yaml');
const DEFAULT_PROBE = '0483:3748';
const DEFAULT_CHIP = 'CW32L012x8';
const DEFAULT_TARGET = 'thumbv6m-none-eabi';
const FLASH_BASE_DEFAULT = '0x00000000'; // CW32 全系列 FLASH ORIGIN（memory.x），不是 0x08000000
const DEBUG_TYPE = 'cw32l012-probe-rs';
const AUTO_EXAMPLE = '__auto__'; // 例程选择器哨兵值：自动选择最新产物
const WORKSPACE_EXAMPLE_KEY = 'cw32l012.selectedExample';
/** cw32-detect（github.com/SunWithCloude/cw32-probe-rs-compat）可执行文件名/路径 */
const DEFAULT_DETECT_PATH = 'cw32-detect';

let logChannel: vscode.OutputChannel | undefined;
let dashboardPanel: vscode.WebviewPanel | undefined;
let dashboardView: vscode.WebviewView | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let extContext: vscode.ExtensionContext | undefined;
let selectedExample = AUTO_EXAMPLE;
/** 插件版本：activate 时从 package.json 读取（不再手写，避免文档/提示过期） */
let extVersion = '0.6.6';

/** 仪表盘/输出通道共享日志环 */
const logLines: string[] = [];
function pushLog(line: string): void {
  const stamp = new Date().toTimeString().slice(0, 8);
  logLines.push(`[${stamp}] ${line}`);
  if (logLines.length > 100) {
    logLines.splice(0, logLines.length - 100);
  }
}
function getLog(): vscode.OutputChannel {
  if (!logChannel) logChannel = vscode.window.createOutputChannel(LOG_NAME);
  return logChannel;
}
function logBoth(line: string): void {
  pushLog(line);
  getLog().appendLine(line);
}

/* ------------------------------------------------------------
 * 命令执行：spawn + 实时日志 + 超时
 * ---------------------------------------------------------- */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommandLogged(command: string, cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
  const channel = getLog();
  channel.appendLine(`> ${command}`);
  pushLog(`$ ${command}`);
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`命令超时（${Math.round(timeoutMs / 1000)}s）: ${command}`));
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      channel.append(d.toString());
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      channel.append(d.toString());
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动命令 "${command}": ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.appendLine(`[exit ${code}]`);
      const result: CommandResult = { code: code ?? -1, stdout, stderr };
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-6).join('\n');
        reject(new Error(`命令失败 (exit ${code}): ${command}\n${tail}`));
      } else {
        resolve(result);
      }
    });
  });
}

/* ------------------------------------------------------------
 * 配置
 * ---------------------------------------------------------- */

interface ExtConfig {
  target: string;
  profile: 'debug' | 'release';
  probeId: string;
  protocol: string;
  chip: string;
  familyKey: FamilyKey;
  family: FamilyProfile;
  chipDescriptionPath: string;
  flashBaseAddress: string;
  workspaceRoot?: string;
  apiPort: number;
  apiToken: string;
  verifyAfterFlash: boolean;
  monitorBaudRate: number;
  mcpPort: number;
  mcpAutoStart: boolean;
  detectPath: string;
}

/**
 * 解析芯片描述文件路径。
 *
 * 优先级：用户设置 → 工作区 `tools/CW32L0_Series.yaml` → 家族回退。
 * probe-rs **0.32 起内置 CW32L0**，空值即可直接 `--chip CW32L012x8`；
 * CW32F030 未内置——回退到插件捆绑的 `tools/families/CW32F030_Series.yaml`。
 * 这里绝不写死本机绝对路径（否则别人装上插件后烧录必然找不到文件）。
 */
function resolveChipDescriptionPath(explicit: string, workspaceRoot: string | undefined, family: FamilyProfile): string {
  if (explicit) {
    return explicit;
  }
  const root = workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const bundled = path.join(root, LEGACY_YAML_REL);
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  if (!family.builtinTarget && family.bundledYaml && extContext) {
    const bundled = path.join(extContext.extensionUri.fsPath, 'tools', 'families', family.bundledYaml);
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  return '';
}

function getConfig(): ExtConfig {
  const cfg = vscode.workspace.getConfiguration('cw32l012');
  const profile = cfg.get<string>('profile') || 'debug';
  const chip = cfg.get<string>('chip') || DEFAULT_CHIP;
  const familySetting = cfg.get<string>('family') || 'auto';
  const familyKey: FamilyKey = familySetting === 'cw32l012' || familySetting === 'cw32f030'
    ? familySetting
    : familyFromChip(chip);
  const family = FAMILIES[familyKey];
  return {
    target: cfg.get<string>('target') || DEFAULT_TARGET,
    profile: profile === 'release' ? 'release' : 'debug',
    probeId: cfg.get<string>('probeId') || DEFAULT_PROBE,
    protocol: cfg.get<string>('protocol') || 'swd',
    chip,
    familyKey,
    family,
    chipDescriptionPath: resolveChipDescriptionPath(
      cfg.get<string>('chipDescriptionPath') || '',
      cfg.get<string>('workspaceRoot') || undefined,
      family
    ),
    flashBaseAddress: cfg.get<string>('flashBaseAddress') || family.flashBase,
    workspaceRoot: cfg.get<string>('workspaceRoot') || undefined,
    apiPort: cfg.get<number>('apiPort') ?? 3678,
    apiToken: cfg.get<string>('apiToken') || '',
    verifyAfterFlash: cfg.get<boolean>('verifyAfterFlash') ?? true,
    monitorBaudRate: cfg.get<number>('monitorBaudRate') ?? 115200,
    mcpPort: cfg.get<number>('mcpPort') ?? 3679,
    mcpAutoStart: cfg.get<boolean>('mcpAutoStart') ?? true,
    detectPath: cfg.get<string>('detectPath') || DEFAULT_DETECT_PATH
  };
}

function findCargoRootUpward(startDir: string): string | undefined {
  const search = (dir: string, depth: number): string | undefined => {
    if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return dir;
    if (depth <= 0) return undefined;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const found = search(path.join(dir, entry.name), depth - 1);
        if (found) return found;
      }
    } catch { /* 忽略不可读目录 */ }
    return undefined;
  };
  let current = path.resolve(startDir);
  for (let i = 0; i < 4 && current !== path.dirname(current); i++) {
    const found = search(current, 2);
    if (found) return found;
    current = path.dirname(current);
  }
  return undefined;
}

function getWorkspaceRoot(): string | undefined {
  const cfg = getConfig();
  if (cfg.workspaceRoot && fs.existsSync(path.join(cfg.workspaceRoot, 'Cargo.toml'))) {
    return cfg.workspaceRoot;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return findCargoRootUpward(folders[0].uri.fsPath);
  }
  return undefined;
}

/* ------------------------------------------------------------
 * 例程选择器（对标 Keil target 下拉）
 * ---------------------------------------------------------- */

function getSelectedExample(): string {
  return selectedExample;
}

function setSelectedExample(name: string): void {
  const changed = name !== selectedExample; // 同值不 bump，避免 AI 被假冲突拒绝
  selectedExample = name;
  if (extContext) {
    const workspaceKey = getWorkspaceRoot() ?? 'default';
    void extContext.workspaceState.update(`${WORKSPACE_EXAMPLE_KEY}:${workspaceKey}`, name);
  }
  logBoth(`[select] 例程: ${name === AUTO_EXAMPLE ? '自动选择最新产物' : name}`);
  if (changed) bumpSettingsEpoch(`例程选择 → ${name === AUTO_EXAMPLE ? '自动' : name}`);
  void pushDashState();
  void refreshStatusBar();
}

async function selectExample(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('请先打开 CW32L012 工作区。');
    return;
  }
  const info = await getCargoInfo(root);
  const examples = info.exampleNames;
  if (examples.length === 0) {
    vscode.window.showInformationMessage('cargo metadata 未发现 example 目标。请检查 Cargo.toml 的 [[example]] 配置。');
    return;
  }
  const current = getSelectedExample();
  const items: vscode.QuickPickItem[] = [
    {
      label: `$(sync) 自动选择最新产物`,
      description: current === AUTO_EXAMPLE ? '当前选择' : '',
      detail: 'Build/Flash/Debug 自动解析最新的有效固件产物'
    }
  ];
  for (const name of examples) {
    items.push({
      label: `$(beaker) ${name}`,
      description: name === current ? '当前选择' : '',
      detail: `cargo build --target ${getConfig().target} --example ${name}`
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要构建/烧录/调试的例程（Keil target 下拉的替代）'
  });
  if (!picked) return;
  const name = picked.label.includes('自动') ? AUTO_EXAMPLE : picked.label.replace(/^\$\(beaker\)\s*/, '');
  setSelectedExample(name);
  vscode.window.showInformationMessage(`CW32L012 例程: ${name === AUTO_EXAMPLE ? '自动选择最新产物' : name}`);
}

async function setSourceDir(): Promise<void> {
  const current = getWorkspaceRoot() ?? '';
  const picked = await vscode.window.showInputBox({
    title: 'CW32L012 源码目录（构建 / 烧录 / 调试从此目录取）',
    value: current,
    prompt: '输入含 Cargo.toml 的固件项目目录；留空恢复自动（从工作区探测）',
    placeHolder: '例：D:\\projects\\cw32l012-firmware',
    ignoreFocusOut: true,
    validateInput(value: string): string | undefined {
      const v = value.trim();
      if (!v) return undefined;
      if (!fs.existsSync(v)) return '目录不存在';
      if (!fs.existsSync(path.join(v, 'Cargo.toml'))) return '该目录没有 Cargo.toml（应为固件项目根）';
      return undefined;
    }
  });
  if (picked === undefined) return; // 取消
  const value = picked.trim();
  const cfg = vscode.workspace.getConfiguration('cw32l012');
  await cfg.update('workspaceRoot', value === '' ? undefined : value, vscode.ConfigurationTarget.Workspace);
  cargoInfoCache = undefined; // 换目录后 example 列表/产物缓存全部作废
  if (value === '') {
    logBoth('[select] 源目录: 清除手动指定，恢复自动探测');
    vscode.window.showInformationMessage('CW32L012 源目录已恢复自动探测。');
  } else {
    logBoth(`[select] 源目录: ${value}（手动指定）`);
    vscode.window.showInformationMessage(`CW32L012 源目录 → ${value}`);
  }
  bumpSettingsEpoch(`源目录 → ${value === '' ? '自动' : value}`);
  void pushDashState();
  void refreshStatusBar();
  await updateDashboardView();
}

/**
 * 生成/刷新工作区 .mcp.json：把本插件内嵌 MCP 服务器的接入信息写给
 * MCP 客户端（Claude Code / ZCode 等）。端口取自 cw32l012.mcpPort。
 */
async function generateMcpJson(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    vscode.window.showWarningMessage('请先打开工作区再生成 .mcp.json。');
    return;
  }
  const port = getConfig().mcpPort;
  const content = JSON.stringify(
    { mcpServers: { cw32l012: { type: 'sse', url: `http://127.0.0.1:${port}/sse` } } },
    null,
    2
  ) + '\n';
  const file = path.join(ws.uri.fsPath, '.mcp.json');
  try {
    fs.writeFileSync(file, content, 'utf8');
    logBoth(`[mcp] 已生成 ${file}（MCP 端口 ${port}）`);
    void vscode.window.showInformationMessage(
      `.mcp.json 已生成：MCP 客户端经 http://127.0.0.1:${port}/sse 接入本插件的 19 个工具。`,
      '打开文件'
    ).then(pick => {
      if (pick === '打开文件') void vscode.window.showTextDocument(vscode.Uri.file(file));
    });
  } catch (err) {
    vscode.window.showErrorMessage(`写入 .mcp.json 失败: ${err instanceof Error ? err.message : err}`);
  }
}

/* ------------------------------------------------------------
 * cargo metadata（30s 缓存）
 * ---------------------------------------------------------- */

interface CargoInfo {
  targetDirectory: string;
  exampleNames: string[];
  ok: boolean;
}

let cargoInfoCache: { root: string; info: CargoInfo; at: number } | undefined;

async function getCargoInfo(root: string): Promise<CargoInfo> {
  if (cargoInfoCache && cargoInfoCache.root === root && Date.now() - cargoInfoCache.at < 30_000) {
    return cargoInfoCache.info;
  }
  try {
    const res = await runCommandLogged('cargo metadata --format-version 1 --no-deps', root, 60_000);
    const parsed = JSON.parse(res.stdout) as {
      target_directory?: string;
      packages?: Array<{ targets?: Array<{ kind?: string[]; name?: string }> }>;
    };
    const exampleNames = (parsed.packages || [])
      .flatMap(pkg => pkg.targets || [])
      .filter(t => Array.isArray(t.kind) && t.kind.includes('example'))
      .map(t => t.name)
      .filter((n): n is string => Boolean(n));
    const info: CargoInfo = {
      targetDirectory: parsed.target_directory || path.join(root, 'target'),
      exampleNames,
      ok: true
    };
    cargoInfoCache = { root, info, at: Date.now() };
    return info;
  } catch (err) {
    logBoth(`[warn] cargo metadata 失败: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    return { targetDirectory: path.join(root, 'target'), exampleNames: [], ok: false };
  }
}

/* ------------------------------------------------------------
 * 固件校验（allowlist + 魔数 + 黑名单路径）
 * ---------------------------------------------------------- */

type FirmwareKind = 'elf' | 'bin' | 'hex';

interface FirmwareCandidate {
  filePath: string;
  kind: FirmwareKind;
  mtimeMs: number;
  exampleRank: number;
}

const FORBIDDEN_DIR_TOKENS = ['/deps/', '/incremental/', '/.fingerprint/', '/build/'];
const FORBIDDEN_EXTS = ['.d', '.rmeta', '.o', '.obj', '.lock', '.json', '.rlib', '.a', '.so', '.dll', '.exe', '.pdb', '.map', '.tmp'];

function sniffFirmwareKind(filePath: string): FirmwareKind | undefined {
  const name = path.basename(filePath).toLowerCase();
  const ext = name.slice(name.lastIndexOf('.'));
  let head: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 4) { fs.closeSync(fd); return undefined; }
    head = Buffer.alloc(Math.min(64, size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
  } catch {
    return undefined;
  }
  const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  if (ext === '.elf') return isElf ? 'elf' : undefined;
  if (ext === '.hex') return looksLikeIntelHex(head) ? 'hex' : undefined;
  if (ext === '.bin') return 'bin'; // 裸二进制无固定魔数，仅按扩展名接受
  if (!name.includes('.') && isElf) return 'elf';
  return undefined;
}

/** Intel HEX 最小结构校验：以 ':' 开头、记录长度/类型字段为合法十六进制、行尾为 LF */
function looksLikeIntelHex(head: Buffer): boolean {
  const text = head.toString('latin1');
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  if (!firstLine.startsWith(':')) return false;
  // 记录头 9 个字符必须全为十六进制（:LLAAAATT）
  const meta = firstLine.slice(1, 9);
  return /^[0-9a-fA-F]{8}$/.test(meta);
}

function validateFirmwareFile(filePath: string): FirmwareKind | undefined {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  if (FORBIDDEN_EXTS.some(e => name.endsWith(e))) return undefined;
  // 目录黑名单只针对 cargo `target/` 子树，避免工作区路径本身含 build/deps/incremental
  // 等常见目录名时把所有固件误杀（此前用整条绝对路径匹配会导致全盘拒绝）
  const targetIdx = normalized.lastIndexOf('/target/');
  if (targetIdx >= 0) {
    const underTarget = normalized.slice(targetIdx + '/target/'.length);
    if (FORBIDDEN_DIR_TOKENS.some(t => underTarget.includes(t))) return undefined;
  }
  const ext = name.slice(name.lastIndexOf('.'));
  const allowed = ['.elf', '.bin', '.hex'].includes(ext) || !name.includes('.');
  if (!allowed) return undefined;
  return sniffFirmwareKind(filePath);
}

async function collectFirmwareCandidates(root: string): Promise<{ candidates: FirmwareCandidate[]; exampleNames: string[]; targetDirectory: string }> {
  const info = await getCargoInfo(root);
  const cfg = getConfig();
  const dirs = [
    path.join(info.targetDirectory, cfg.target, cfg.profile, 'examples'),
    path.join(info.targetDirectory, cfg.target, cfg.profile),
    path.join(root, 'firmware')
  ];
  // 仅当显式配置为 release 时才扫描 release 目录，避免 debug 模式下
  // 混入旧的 release 产物被误选（此前硬编码 release 会与 profile 冲突）
  if (cfg.profile === 'release') {
    dirs.push(path.join(info.targetDirectory, cfg.target, 'release', 'examples'));
    dirs.push(path.join(info.targetDirectory, cfg.target, 'release'));
  }
  const seen = new Set<string>();
  const candidates: FirmwareCandidate[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      if (seen.has(full.toLowerCase())) continue;
      seen.add(full.toLowerCase());
      const kind = validateFirmwareFile(full);
      if (!kind) continue;
      const stem = entry.name.replace(/\.(elf|bin|hex)$/i, '');
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* 保持 0 */ }
      candidates.push({ filePath: full, kind, mtimeMs, exampleRank: info.exampleNames.indexOf(stem) });
    }
  }
  return { candidates, exampleNames: info.exampleNames, targetDirectory: info.targetDirectory };
}

/**
 * 解析当前要用的固件产物。
 * - 用户通过 selectExample 指定了例程时：**只**返回该 example 的产物；
 *   若该例程尚无产物，返回 undefined 并提示先 Build（绝不静默改烧别的固件）。
 * - AUTO 模式：返回排序后的最优产物（最新一批构建 + 首选例程）。
 */
async function resolveArtifact(root: string): Promise<FirmwareCandidate | undefined> {
  const { candidates } = await collectFirmwareCandidates(root);
  const ranked = rankCandidates(candidates);
  const selected = getSelectedExample();
  if (selected !== AUTO_EXAMPLE && selected) {
    const matches = ranked.filter(c => path.basename(c.filePath, path.extname(c.filePath)) === selected);
    if (matches.length > 0) return matches[0];
    logBoth(`[select] 所选例程 "${selected}" 尚无产物——拒绝回退到其它例程（请先 Build）。`);
    return undefined;
  }
  return ranked[0];
}

/** 例程选择器：返回当前选择描述（仪表盘 / API 用） */
function describeSelectedExample(): string {
  const selected = getSelectedExample();
  return selected === AUTO_EXAMPLE ? '自动选择最新产物' : selected;
}

/** 例程选择器构建命令：未选择时返回 undefined（走自动 --examples 全量构建） */
function buildCommandForSelected(root: string): string | undefined {
  const selected = getSelectedExample();
  if (selected === AUTO_EXAMPLE || !selected) return undefined;
  const cfg = getConfig();
  return `cargo build --target ${cfg.target} --example ${q(selected)}`;
}

/** 首选例程（任务文档要求）：同批构建时优先这些，而非任意最新文件 */
const PREFERRED_EXAMPLES = ['blink_pc13', 'blink', 'uart_echo'];

function preferredRank(stem: string): number {
  const idx = PREFERRED_EXAMPLES.indexOf(stem);
  return idx >= 0 ? idx : 99;
}

/**
 * 候选排序（自动模式语义 = 「最新产物」，同批构建时用首选名做决胜）。
 * 1. 先按 mtime 分桶：同一批 cargo build 的产物 mtime 相差极小（<2s），视为同批；
 * 2. 同批内优先 PREFERRED_EXAMPLES（blink_pc13 > blink > uart_echo > 其它）；
 * 3. 再按扩展名 ELF > BIN > HEX；
 * 4. 最后按 mtime 精确降序。
 * 这样「刚重新构建的固件」一定会被选中，而不是永远选例程列表里的第一个。
 */
function rankCandidates(candidates: FirmwareCandidate[]): FirmwareCandidate[] {
  const extRank = (k: FirmwareKind) => (k === 'elf' ? 0 : k === 'bin' ? 1 : 2);
  const maxMtime = candidates.reduce((m, c) => Math.max(m, c.mtimeMs), 0);
  const BATCH_WINDOW_MS = 2000;
  return [...candidates].sort((a, b) => {
    // 1. 是否属于最新一批构建
    const aFresh = maxMtime - a.mtimeMs <= BATCH_WINDOW_MS ? 0 : 1;
    const bFresh = maxMtime - b.mtimeMs <= BATCH_WINDOW_MS ? 0 : 1;
    if (aFresh !== bFresh) return aFresh - bFresh;
    // 2. 同批内首选例程优先
    const aPref = preferredRank(path.basename(a.filePath, path.extname(a.filePath)));
    const bPref = preferredRank(path.basename(b.filePath, path.extname(b.filePath)));
    if (aPref !== bPref) return aPref - bPref;
    // 3. 扩展名
    const ea = extRank(a.kind);
    const eb = extRank(b.kind);
    if (ea !== eb) return ea - eb;
    // 4. 精确 mtime 降序
    return b.mtimeMs - a.mtimeMs;
  });
}

/* ------------------------------------------------------------
 * probe-rs 命令构造
 * ---------------------------------------------------------- */

function q(value: string): string { return `"${value}"`; }

function probeBaseArgs(): string[] {
  const cfg = getConfig();
  const args = ['--probe', cfg.probeId, '--protocol', cfg.protocol];
  // 只有真正需要外部目标文件时才传；probe-rs 0.32+ 内置 CW32L0
  if (cfg.chipDescriptionPath) {
    args.push('--chip-description-path', q(cfg.chipDescriptionPath));
  }
  args.push('--chip', cfg.chip);
  return args;
}

function buildDownloadCommand(artifact: FirmwareCandidate): string {
  const args = ['probe-rs', 'download', ...probeBaseArgs()];
  if (artifact.kind === 'bin') {
    args.push('--base-address', getConfig().flashBaseAddress);
  }
  args.push(q(artifact.filePath));
  return args.join(' ');
}

/** probe-rs verify：烧录后校验 FLASH 内容与固件一致 */
function buildVerifyCommand(artifact: FirmwareCandidate): string {
  const args = ['probe-rs', 'verify', ...probeBaseArgs(), '--non-interactive'];
  if (artifact.kind === 'bin') {
    args.push('--binary-format', 'bin', '--base-address', getConfig().flashBaseAddress);
  }
  args.push(q(artifact.filePath));
  return args.join(' ');
}

/** 全片擦除（需 --allow-erase-all，CW32L012 安全区/读保护场景） */
function buildEraseCommand(): string {
  // probeBaseArgs() 已含 --chip；此处不重复传，避免 clap 重复参数报错
  return `probe-rs erase ${probeBaseArgs().join(' ')} --allow-erase-all`;
}

/* ------------------------------------------------------------
 * 状态判定：probe 在线 ≠ MCU 在线
 * ---------------------------------------------------------- */

export interface ProbeSummary {
  probe: 'offline' | 'online';
  mcu: 'unknown' | 'online' | 'unreachable';
  device: string;
  detail: string;
}

/** 轻量 probe 探测结果缓存（避免仪表盘 2s 轮询 + 状态栏 5s 轮询重复 spawn probe-rs list） */
let probeSummaryCache: { summary: ProbeSummary; at: number } | undefined;

async function getProbeSummary(deepCheck = false): Promise<ProbeSummary> {
  if (!deepCheck && probeSummaryCache && Date.now() - probeSummaryCache.at < 4000) {
    return probeSummaryCache.summary;
  }
  let listOut = '';
  try {
    const res = await runCommandLogged('probe-rs list', process.cwd(), 30_000);
    listOut = res.stdout.trim();
  } catch (err) {
    const offline: ProbeSummary = {
      probe: 'offline', mcu: 'unknown', device: 'None',
      detail: `probe-rs 不可用: ${err instanceof Error ? err.message.split('\n')[0] : err}`
    };
    probeSummaryCache = { summary: offline, at: Date.now() };
    return offline;
  }
  const hasProbe = /\[\d+\]/.test(listOut);
  if (!hasProbe) {
    const none: ProbeSummary = { probe: 'offline', mcu: 'unknown', device: 'None', detail: '未检测到调试探针' };
    probeSummaryCache = { summary: none, at: Date.now() };
    return none;
  }
  const deviceLine = listOut.split(/\r?\n/).find(l => /\[\d+\]/.test(l))?.replace(/\s{2,}/g, ' ').trim() || '探针已连接';
  if (!deepCheck) {
    const light: ProbeSummary = { probe: 'online', mcu: 'unknown', device: deviceLine, detail: '探针在线（未做芯片级检测）' };
    probeSummaryCache = { summary: light, at: Date.now() };
    return light;
  }
  // 调试会话存活时绝不做 reset 级检测：probe-rs reset 会与 dap-server 抢探针
  if (debugSession) {
    const light: ProbeSummary = {
      probe: 'online', mcu: 'unknown', device: deviceLine,
      detail: '调试会话进行中，跳过 reset 级检测（避免抢占探针）'
    };
    return light;
  }
  try {
    await runCommandLogged(`probe-rs reset ${probeBaseArgs().join(' ')}`, process.cwd(), 45_000);
    const online: ProbeSummary = { probe: 'online', mcu: 'online', device: deviceLine, detail: 'MCU 应答（reset 成功）' };
    probeSummaryCache = { summary: online, at: Date.now() };
    return online;
  } catch (err) {
    const bad: ProbeSummary = {
      probe: 'online', mcu: 'unreachable', device: deviceLine,
      detail: `探针在线但 MCU 无应答: ${err instanceof Error ? err.message.split('\n').slice(-2).join(' ') : err}`
    };
    probeSummaryCache = { summary: bad, at: Date.now() };
    return bad;
  }
}

/* ------------------------------------------------------------
 * 状态栏（Keil 感核心）：$(chip) CW32L012: <MCU状态>
 * online=绿勾 / offline=灰 / unreachable=红叉
 * ---------------------------------------------------------- */

export type StatusKind = 'online' | 'offline' | 'unreachable';

function statusKindFromSummary(summary: ProbeSummary): StatusKind {
  if (summary.probe === 'offline') return 'offline';
  if (summary.mcu === 'unreachable') return 'unreachable';
  return 'online';
}

function ensureStatusBar(): vscode.StatusBarItem {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.name = 'CW32L012';
    statusBarItem.command = 'cw32l012.showDashboard'; // 点击打开仪表盘
    statusBarItem.show();
  }
  return statusBarItem;
}

async function refreshStatusBar(): Promise<void> {
  try {
    const item = ensureStatusBar();
    const summary = await getProbeSummary(false); // 轻量：probe-rs list，不做 reset
    const kind = statusKindFromSummary(summary);
    const label = getConfig().family.label;
    if (kind === 'online') {
      item.text = `$(chip) ${label}: MCU 在线 $(check)`;
      item.color = '#5ad46a';
      item.tooltip = summary.device;
    } else if (kind === 'offline') {
      item.text = `$(chip) ${label}: 探针离线`;
      item.color = new vscode.ThemeColor('statusBar.foreground');
      item.tooltip = summary.detail;
    } else {
      item.text = `$(chip) ${label}: MCU 无应答 $(error)`;
      item.color = '#ff4a4a';
      item.tooltip = summary.detail;
    }
  } catch { /* 状态栏刷新失败不影响主流程 */ }
}

/* ------------------------------------------------------------
 * 调试会话（probe-rs dap-server + DAP 轮询）
 * ---------------------------------------------------------- */

let debugSession: vscode.DebugSession | undefined;

async function dapRequest<T>(request: string, args: unknown): Promise<T | undefined> {
  if (!debugSession) return undefined;
  try {
    return await debugSession.customRequest(request, args) as T;
  } catch {
    // 轮询类请求（threads/stackTrace 等）失败是常态（目标运行中/会话将结束），保持静默；
    // 读内存/写内存走 dapRequestStrict，失败必留痕。
    return undefined;
  }
}

/** 严格版 DAP 请求：失败抛 DapError 并写入日志（不静默——0.6.x 会话被杀的根因之一就是错误被吞） */
class DapError extends Error {}

async function dapRequestStrict<T>(request: string, args: unknown): Promise<T> {
  if (!debugSession) {
    throw new DapError('无活动调试会话');
  }
  try {
    return await debugSession.customRequest(request, args) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logBoth(`[dap] ${request} 失败: ${msg}`);
    throw new DapError(msg);
  }
}

/**
 * 硬件操作前释放探针：调试会话持有 dap-server --single-session，任何 CLI
 * probe-rs 命令（download/verify/reset/erase/read）与它并存都会触发探针
 * 争抢，dap-server 死亡 = 会话静默结束。故硬件操作前必须先结束会话。
 * 返回 true 表示确实结束了一个会话（调用方应把这一点带进结果）。
 */
async function releaseProbeForHardware(op: string): Promise<boolean> {
  if (!debugSession) {
    return false;
  }
  logBoth(`[hardware] ${op} 需要独占探针，自动结束调试会话`);
  try {
    await vscode.debug.stopDebugging(debugSession);
  } catch (err) {
    logBoth(`[hardware] 结束会话失败（继续执行 ${op}）: ${err instanceof Error ? err.message : err}`);
  }
  debugSession = undefined;
  // 给 dap-server 进程一点退出时间，避免 probe 句柄尚未释放
  await new Promise(resolve => setTimeout(resolve, 600));
  return true;
}

/**
 * 读内存的统一入口（MCP / HTTP API / 仪表盘共用）。
 *
 * 有调试会话：只走 DAP；运行态导致读取失败时自动 pause→读→resume，
 * 绝不回落 CLI（探针在 dap-server 手里，CLI 必然争抢）。无会话才走 CLI。
 */
async function readMemoryForTools(address: string, count: number): Promise<{ buf?: Buffer; error?: string; paused?: boolean }> {
  const addrHex = address.startsWith('0x') ? address : `0x${address}`;
  const viaDap = async (): Promise<Buffer> => {
    const res = await dapRequestStrict<{ data?: string }>('readMemory', {
      memoryReference: addrHex,
      offset: 0,
      count
    });
    if (!res?.data) {
      throw new DapError('readMemory 返回空数据');
    }
    return Buffer.from(res.data, 'base64');
  };
  if (debugSession) {
    try {
      return { buf: await viaDap() };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const state = await fetchDebugState();
      if (state.halted) {
        return { error: `DAP readMemory 失败（会话已暂停仍失败）: ${reason}` };
      }
      // 运行态读失败 → 自动 pause→读→resume
      logBoth(`[memory] 运行态 DAP 读失败，自动 pause→读→resume: ${reason}`);
      const tid = await getMainThreadId();
      if (tid == null) {
        return { error: `运行态读取失败且取不到线程 id: ${reason}` };
      }
      try {
        await debugSession.customRequest('pause', { threadId: tid });
      } catch (perr) {
        return { error: `自动暂停失败: ${perr instanceof Error ? perr.message : perr}` };
      }
      try {
        return { buf: await viaDap(), paused: true };
      } finally {
        try {
          await debugSession.customRequest('continue', { threadId: tid });
        } catch (cerr) {
          logBoth(`[memory] 恢复运行失败: ${cerr instanceof Error ? cerr.message : cerr}`);
        }
      }
    }
  }
  const buf = await readMemoryViaCli(addrHex, count);
  if (!buf) {
    return { error: '读取失败：无调试会话且 CLI read 失败（MCU 未连接？）' };
  }
  return { buf };
}

interface DebugState {
  active: boolean;
  sessionName?: string;
  halted?: boolean;
  pc?: string;
  frames?: Array<{ name: string; file?: string; line?: number; pc?: string }>;
  variables?: Array<{ name: string; value: string; scope: string }>;
  error?: string;
}

async function fetchDebugState(): Promise<DebugState> {
  if (!debugSession) return { active: false };
  const session = debugSession;
  try {
    const threads = await dapRequest<{ threads?: Array<{ id: number; name: string }> }>('threads', {});
    const threadId = threads?.threads?.[0]?.id;
    if (threadId == null) return { active: true, sessionName: session.name };

    const stack = await dapRequest<{ stackFrames?: Array<{ id: number; name: string; file?: string; line?: number; instructionPointerReference?: string }> }>(
      'stackTrace', { threadId, levels: 5, startFrame: 0 });
    const frames = (stack?.stackFrames || []).map(f => ({
      name: f.name,
      file: f.file,
      line: f.line,
      pc: f.instructionPointerReference
    }));
    const topFrameId = stack?.stackFrames?.[0]?.id;

    const variables: Array<{ name: string; value: string; scope: string }> = [];
    if (topFrameId != null) {
      const scopes = await dapRequest<{ scopes?: Array<{ name: string; variablesReference: number; expensive?: boolean }> }>('scopes', { frameId: topFrameId });
      for (const scope of (scopes?.scopes || []).filter(s => !s.expensive).slice(0, 3)) {
        const vars = await dapRequest<{ variables?: Array<{ name: string; value: string; variablesReference: number }> }>(
          'variables', { variablesReference: scope.variablesReference });
        for (const v of (vars?.variables || []).slice(0, 12)) {
          variables.push({ name: v.name, value: v.value, scope: scope.name });
        }
      }
    }
    return {
      active: true,
      sessionName: session.name,
      halted: frames.length > 0, // 有可解析调用栈 = 核心处于暂停态
      pc: frames[0]?.pc,
      frames,
      variables
    };
  } catch (err) {
    return { active: true, sessionName: session.name, error: err instanceof Error ? err.message : String(err) };
  }
}

async function readMemoryViaDap(address: string, count: number): Promise<string | undefined> {
  const res = await dapRequest<{ data?: string; address?: string }>('readMemory', {
    memoryReference: address.startsWith('0x') ? address : `0x${address}`,
    offset: 0,
    count
  });
  if (res?.data) return res.data; // base64
  return undefined;
}

async function readMemoryViaCli(address: string, count: number): Promise<Buffer | undefined> {
  // 兜底：probe-rs read b32 <addr> <words>（无调试会话时使用）
  const words = Math.ceil(count / 4);
  try {
    const cfg = getConfig();
    const res = await runCommandLogged(
      `probe-rs read b32 ${address} ${words} ${probeBaseArgs().join(' ')}`,
      process.cwd(), 45_000);
    const hexWords = res.stdout.trim().split(/\s+/).filter(w => /^[0-9a-fA-F]{1,8}$/.test(w));
    const buf = Buffer.alloc(hexWords.length * 4);
    hexWords.forEach((w, i) => buf.writeUInt32LE(parseInt(w, 16), i * 4));
    return buf.subarray(0, Math.min(count, buf.length));
  } catch {
    return undefined;
  }
}

/* ---- cw32-detect 集成（出厂数字签名识别，github.com/SunWithCloude/cw32-probe-rs-compat） ---- */

interface DetectReport {
  ok: boolean;
  chip?: string;
  type_string?: string;
  flash?: number | null;
  ram?: number | null;
  pins?: string | null;
  uid?: string | null;
  match?: string;
  builtin?: boolean;
  warnings?: string[];
  raw?: string;
}

/** 最近一次 cw32-detect 识别结果（仪表盘「Chip」卡片显示，成功失败都记） */
let lastDetectReport: DetectReport | undefined;

/** 运行 cw32-detect --json（需独占探针，会自动结束活动调试会话） */
async function runChipDetect(): Promise<DetectReport> {
  const rep = await runChipDetectOnce();
  lastDetectReport = rep;
  if (rep.ok && rep.chip) {
    logBoth(`[detect] ${rep.type_string ?? '?'} → ${rep.chip}（${rep.match ?? '-'}）`);
  } else {
    logBoth(`[detect] 识别失败: ${(rep.raw ?? '').split('\n')[0]}`);
  }
  return rep;
}

async function runChipDetectOnce(): Promise<DetectReport> {
  await releaseProbeForHardware('cw32-detect 识别');
  const exe = getConfig().detectPath || DEFAULT_DETECT_PATH;
  let out = '';
  try {
    const res = await runCommandLogged(`${exe} --json`, process.cwd(), 90_000);
    out = res.stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not recognized') || msg.includes('不是内部或外部命令') || msg.includes('ENOENT') || msg.includes('not found')) {
      return {
        ok: false,
        raw: 'cw32-detect 未找到。安装：github.com/SunWithCloude/cw32-probe-rs-compat（cargo build --release 后把 cw32-detect.exe 放进 PATH，或设置 cw32l012.detectPath 指向它）'
      };
    }
    return { ok: false, raw: `cw32-detect 运行失败: ${msg.split('\n')[0]}` };
  }
  try {
    const parsed = JSON.parse(out) as DetectReport;
    return { ...parsed, ok: true };
  } catch {
    return { ok: false, raw: `cw32-detect 输出不是 JSON: ${out.slice(0, 200)}` };
  }
}

/* ------------------------------------------------------------
 * 调试控制（步进 / 复位 / 写内存 / 外设寄存器解码）
 * ---------------------------------------------------------- */

/** 取真实主线程 id（DAP 各控制请求都需要；不再硬编码 0） */
async function getMainThreadId(): Promise<number | undefined> {
  const threads = await dapRequest<{ threads?: Array<{ id: number; name: string }> }>('threads', {});
  return threads?.threads?.[0]?.id;
}

/** 统一的调试控制动作：pause / continue / next / stepIn / stepOut / restart */
async function debugControl(action: 'pause' | 'continue' | 'next' | 'stepIn' | 'stepOut' | 'restart'): Promise<void> {
  if (!debugSession) {
    vscode.window.showWarningMessage('无活动调试会话。先启动「SWD 调试」。');
    return;
  }
  const tid = await getMainThreadId();
  if (tid == null) {
    vscode.window.showWarningMessage('取不到线程 id（会话可能未就绪）。');
    return;
  }
  try {
    await debugSession.customRequest(action, { threadId: tid });
  } catch (err) {
    logBoth(`[debug] ${action} 失败: ${err instanceof Error ? err.message : err}（目标可能已处于该状态）`);
  }
  await pushDebugState();
}

/** 复位并重新运行（DAP restart = 重启程序并保持在入口语义） */
async function debugRestart(): Promise<void> {
  await debugControl('restart');
}

/** 通过调试会话写内存（DAP writeMemory；返回写入字节数，失败 0） */
async function writeMemoryViaDap(address: string, hexBytes: string): Promise<number> {
  const buf = Buffer.from(hexBytes.trim(), 'hex');
  if (buf.length === 0 || buf.length % 4 !== 0) return 0; // 对齐按字写，避免非对齐写被拒
  const res = await dapRequest<{ bytesWritten?: number; success?: boolean }>('writeMemory', {
    memoryReference: address.startsWith('0x') ? address : `0x${address}`,
    offset: 0,
    count: buf.length,
    data: buf.toString('base64')
  });
  if (res?.bytesWritten != null) return res.bytesWritten;
  return res?.success === true ? buf.length : 0;
}

/* ---- 外设寄存器地图：按家族从 families.ts 取（cw32l012 / cw32f030 各一套） ---- */

function peripheralMap(): PeriphDef[] {
  return getConfig().family.peripherals;
}

/** 读外设并解码（有调试会话只走 DAP 且运行态自动 pause→读→resume；无会话才走 CLI） */
async function readPeripheralRegisters(key: string): Promise<{ peripheral: PeriphDef; rows: Array<{ name: string; offset: string; value: string; fields: Array<{ name: string; value: string }>; note?: string }>; error?: string }> {
  const map = peripheralMap();
  const periph = map.find(p => p.key === key);
  if (!periph) {
    return { peripheral: map[0] ?? { key: '', label: '', base: 0, span: 0, regs: [] }, rows: [], error: `未知外设 ${key}（当前家族可用: ${map.map(p => p.key).join(', ') || '该家族寄存器表为空'}）` };
  }
  if (periph.regs.length === 0) {
    return { peripheral: periph, rows: [], error: `外设 ${key} 在当前家族(${getConfig().family.label})的解码表尚未加载` };
  }
  const addrHex = `0x${periph.base.toString(16)}`;
  const r = debugSession
    ? await readMemoryForTools(addrHex, periph.span)
    : { buf: await readMemoryViaCli(addrHex, periph.span) };
  const buf = r.buf;
  if (!buf) {
    return { peripheral: periph, rows: [], error: r.error ?? '读取失败' };
  }
  const rows = periph.regs.map(reg => {
    const v = buf.length > reg.off + 3 ? buf.readUInt32LE(reg.off) : undefined;
    const fields: Array<{ name: string; value: string }> = [];
    if (v !== undefined && reg.fields) {
      for (const f of reg.fields) {
        const fv = (v >>> f.lsb) & ((1 << (f.msb - f.lsb + 1)) - 1);
        fields.push({ name: f.name, value: f.decode ? f.decode(fv) : `0x${fv.toString(16)}` });
      }
    }
    return {
      name: reg.name,
      offset: `+0x${reg.off.toString(16).padStart(2, '0')}`,
      value: v === undefined ? '----' : `0x${v.toString(16).padStart(8, '0')}`,
      fields,
      note: reg.note
    };
  });
  return { peripheral: periph, rows };
}

/* ------------------------------------------------------------
 * AI × 人类 并发防冲突（恶作剧防护）
 *
 * 规则一：硬件互斥（悲观租约）。同一时刻只允许一个操作者占用硬件链路
 *   （build/flash/erase/reset/调试控制/写内存/开串口/例程选择）。
 *   后来者收到结构化冲突错误：谁在干什么、持续多久、怎么观察。
 * 规则二：设置一致性（乐观版本号 settingsEpoch）。cw32l012.* 配置或
 *   例程/产物选择被改动即 +1。AI 关键操作可带 expectedEpoch：
 *   若中途有人改了设置（例如恶作剧），操作拒绝执行并提示重新 status，
 *   AI 重新拉取状态后自愈——既不盲干也不死锁。
 * ---------------------------------------------------------- */

type OpActor = 'human' | 'ai' | 'api';

interface OperationLease { op: string; actor: OpActor; since: number; }
let activeLease: OperationLease | undefined;
let settingsEpoch = 1;

const ACTOR_LABEL: Record<OpActor, string> = {
  human: '人类（VS Code 界面）',
  ai: 'AI（MCP）',
  api: 'AI（Agent API）'
};

function describeLease(l: OperationLease): string {
  const heldSec = Math.max(1, Math.round((Date.now() - l.since) / 1000));
  return `${ACTOR_LABEL[l.actor]}正在执行 ${l.op}（已 ${heldSec}s）`;
}

function acquireLease(op: string, actor: OpActor): string | undefined {
  if (activeLease && Date.now() - activeLease.since > 15 * 60_000) {
    logBoth(`[lease] 过期租约自动作废: ${describeLease(activeLease)}`);
    activeLease = undefined;
  }
  if (activeLease) {
    return `操作冲突：${describeLease(activeLease)}。请稍后重试；AI 可先调 cw32_status 查看 lease 字段。`;
  }
  activeLease = { op, actor, since: Date.now() };
  return undefined;
}

function releaseLease(): void { activeLease = undefined; }

/** 租约内执行：冲突抛 Error（消息以「操作冲突」开头，便于上游识别） */
async function withLease<T>(op: string, actor: OpActor, fn: () => Promise<T>): Promise<T> {
  const conflict = acquireLease(op, actor);
  if (conflict) throw new Error(conflict);
  try { return await fn(); } finally { releaseLease(); }
}

/** 人类入口专用：冲突时弹提示，不打断其他异常 */
async function humanLease(op: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await withLease(op, 'human', () => fn() as Promise<unknown>);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('操作冲突')) {
      vscode.window.showWarningMessage(err.message);
      return;
    }
    throw err;
  }
}

function bumpSettingsEpoch(reason: string): void {
  settingsEpoch += 1;
  logBoth(`[lease] 设置版本 → ${settingsEpoch}（${reason}；带旧 expectedEpoch 的 AI 操作将被拒绝）`);
}

function checkEpoch(expected: unknown): void {
  if (typeof expected === 'number' && expected !== settingsEpoch) {
    throw new Error(`设置已被修改（版本 ${expected} → ${settingsEpoch}，可能是人类操作员改了配置/例程/产物）。请重新调用 cw32_status 获取最新状态（settingsEpoch 字段）再操作。`);
  }
}

/** MCP 中触碰硬件/改状态的工具（统一加 ai 租约；读内存/读寄存器同样独占探针） */
const HARDWARE_MCP_TOOLS = new Set([
  'cw32_build', 'cw32_flash', 'cw32_reset', 'cw32_erase', 'cw32_clean',
  'cw32_example_select', 'cw32_memory_write', 'cw32_memory_read',
  'cw32_registers_read', 'cw32_debug_start', 'cw32_debug_control', 'cw32_serial_open',
  'cw32_chip_detect'
]);

/* ------------------------------------------------------------
 * AI / Agent HTTP API（localhost）
 * ---------------------------------------------------------- */

let apiServer: http.Server | undefined;
let apiPortActive: number | undefined;

interface ApiRoute {
  method: string;
  path: string;
  desc: string;
}

const API_ROUTES: ApiRoute[] = [
  { method: 'GET', path: '/api/status?deep=1', desc: 'probe/MCU/artifact/调试会话状态（deep=1 时做 reset 级检测）' },
  { method: 'GET', path: '/api/probes', desc: 'probe-rs list 原始输出' },
  { method: 'GET', path: '/api/artifact', desc: '当前选中的固件产物' },
  { method: 'GET', path: '/api/examples', desc: 'cargo example 列表 + 当前选择' },
  { method: 'POST', path: '/api/examples/select {"name":"blink_pc13"}', desc: '选择例程（name="__auto__" 或省略 = 自动）' },
  { method: 'POST', path: '/api/build', desc: 'build（指定例程=增量；自动模式=clean + build --examples）' },
  { method: 'POST', path: '/api/clean', desc: 'cargo clean' },
  { method: 'POST', path: '/api/flash {"path":"..."}', desc: '烧录（body 可省略 = 自动选产物；path 必须通过校验）' },
  { method: 'POST', path: '/api/reset', desc: '复位目标' },
  { method: 'POST', path: '/api/erase', desc: '全片擦除（--allow-erase-all）' },
  { method: 'GET', path: '/api/memory?address=0x20000000&length=64', desc: '读内存（会话存活只走 DAP，运行态自动 pause→读→resume；无会话走 CLI）' },
  { method: 'GET', path: '/api/debug/state', desc: '调试会话状态：PC/调用栈/变量' },
  { method: 'POST', path: '/api/debug/pause', desc: '暂停核心' },
  { method: 'POST', path: '/api/debug/continue', desc: '继续运行' },
  { method: 'POST', path: '/api/debug/step-over', desc: '单步步过（next）' },
  { method: 'POST', path: '/api/debug/step-into', desc: '单步步入（stepIn）' },
  { method: 'POST', path: '/api/debug/step-out', desc: '单步步出（stepOut）' },
  { method: 'POST', path: '/api/debug/restart', desc: '复位并重新运行程序' },
  { method: 'POST', path: '/api/memory {"address":"0x20000000","hex":"00112233"}', desc: '写内存（4 字节对齐，需调试会话）' },
  { method: 'GET', path: '/api/registers?name=sysctrl', desc: '外设寄存器读取+位段解码（外设列表随家族）' },
  { method: 'GET', path: '/api/detect?apply=1', desc: 'cw32-detect 出厂数字签名识别芯片（apply=1 时写入 chip 设置）' },
  { method: 'GET', path: '/api/diagnostics', desc: 'AI 诊断报告（文本）' },
  { method: 'GET', path: '/api/serial/ports', desc: '枚举可用串口' },
  { method: 'POST', path: '/api/serial/open {"path":"COM3","baudRate":115200}', desc: '打开串口监视' },
  { method: 'POST', path: '/api/serial/close', desc: '关闭串口' },
  { method: 'POST', path: '/api/serial/send {"data":"AT\\r\\n"}', desc: '串口发送' },
  { method: 'GET', path: '/api/serial/tail?limit=200', desc: '串口接收缓冲（最近 N 行）' },
  { method: 'GET', path: '/api/logs', desc: '最近日志' }
];

function apiHelpText(): string {
  return [
    'CW32L012 Agent API — 端点列表',
    ...API_ROUTES.map(r => `${r.method} ${r.path}  —  ${r.desc}`),
    '',
    '示例: curl http://127.0.0.1:' + (apiPortActive ?? getConfig().apiPort) + '/api/status'
  ].join('\n');
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, maxBytes = 1 << 16): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseHexNumber(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value.startsWith('0x') || value.startsWith('0X') ? value : `0x${value}`);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 十进制计数参数（length/limit）。不能用 parseHexNumber：length=64 会被当成 0x64=100 */
function parseCount(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = url.pathname;
  const method = (req.method || 'GET').toUpperCase();
  const cfg = getConfig();

  // 可选 token 鉴权（Agent 端: curl -H "x-cw32-token: <token>"）
  if (cfg.apiToken) {
    const provided = req.headers['x-cw32-token'] || url.searchParams.get('token');
    if (provided !== cfg.apiToken) {
      json(res, 401, { ok: false, error: 'token 不匹配（设置 cw32l012.apiToken 后需携带 x-cw32-token 头）' });
      return;
    }
  }

  try {
    const root = getWorkspaceRoot();

    if (route === '/' || route === '/api/help') {
      json(res, 200, { ok: true, routes: API_ROUTES, example: `curl http://127.0.0.1:${apiPortActive ?? cfg.apiPort}/api/status` });
      return;
    }

    if (route === '/api/status') {
      const deep = url.searchParams.get('deep') === '1';
      const summary = await getProbeSummary(deep);
      const artifact = root ? await resolveArtifact(root) : undefined;
      const debugState = await fetchDebugState();
      json(res, 200, {
        ok: true,
        settingsEpoch,
        lease: activeLease ? describeLease(activeLease) : null,
        workspace: root ?? null,
        probe: summary.probe,
        mcu: summary.mcu,
        device: summary.device,
        detail: summary.detail,
        artifact: artifact ? { path: artifact.filePath, kind: artifact.kind } : null,
        debug: debugState,
        flashBaseAddress: cfg.flashBaseAddress,
        note: 'CW32L012 FLASH ORIGIN=0x00000000；probe 在线 ≠ MCU 在线，mcu 字段以 reset 交互为准'
      });
      return;
    }

    if (route === '/api/probes') {
      const out = await runCommandLogged('probe-rs list', process.cwd(), 30_000);
      json(res, 200, { ok: true, output: out.stdout.trim() });
      return;
    }

    if (route === '/api/artifact') {
      if (!root) { json(res, 409, { ok: false, error: '未打开工作区' }); return; }
      const artifact = await resolveArtifact(root);
      json(res, 200, { ok: true, artifact: artifact ? { path: artifact.filePath, kind: artifact.kind } : null });
      return;
    }

    if (route === '/api/examples') {
      if (!root) { json(res, 409, { ok: false, error: '未打开工作区' }); return; }
      const info = await getCargoInfo(root);
      json(res, 200, {
        ok: true,
        examples: info.exampleNames,
        targetDirectory: info.targetDirectory,
        selected: getSelectedExample(),
        selectedLabel: describeSelectedExample()
      });
      return;
    }

    if (route === '/api/examples/select' && method === 'POST') {
      let body: { name?: string } = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 body = 自动 */ }
      const name = body.name && body.name.length > 0 ? body.name : AUTO_EXAMPLE;
      if (name !== AUTO_EXAMPLE && root) {
        const info = await getCargoInfo(root);
        if (!info.exampleNames.includes(name)) {
          json(res, 422, { ok: false, error: `未知例程 "${name}"`, examples: info.exampleNames });
          return;
        }
      }
      setSelectedExample(name);
      json(res, 200, { ok: true, selected: name, selectedLabel: describeSelectedExample() });
      return;
    }

    if (route === '/api/build' && method === 'POST') {
      if (!root) { json(res, 409, { ok: false, error: '未打开工作区' }); return; }
      let body: { expectedEpoch?: number } = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 body */ }
      checkEpoch(body.expectedEpoch); // 乐观锁：设置被人类改动则拒绝（此刻仍在租约内）
      const targetedCmd = buildCommandForSelected(root);
      // 与 runBuild 保持一致：指定例程 → 增量构建；自动模式 → clean + 全量
      if (!targetedCmd) await runCommandLogged('cargo clean', root, 120_000);
      cargoInfoCache = undefined;
      const buildCmd = targetedCmd ?? `cargo build --target ${cfg.target} --examples`;
      await runCommandLogged(buildCmd, root, 600_000);
      const artifact = await resolveArtifact(root);
      await updateDashboardView();
      json(res, 200, { ok: true, command: buildCmd, settingsEpoch, artifact: artifact ? { path: artifact.filePath, kind: artifact.kind } : null });
      return;
    }

    if (route === '/api/clean' && method === 'POST') {
      if (!root) { json(res, 409, { ok: false, error: '未打开工作区' }); return; }
      await runCommandLogged('cargo clean', root, 120_000);
      cargoInfoCache = undefined;
      await updateDashboardView();
      json(res, 200, { ok: true, cleaned: true });
      return;
    }

    if (route === '/api/flash' && method === 'POST') {
      if (!root) { json(res, 409, { ok: false, error: '未打开工作区' }); return; }
      let body: { path?: string; expectedEpoch?: number } = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 body */ }
      checkEpoch(body.expectedEpoch); // 乐观锁：设置被人类改动则拒绝（此刻仍在租约内）
      let artifact: FirmwareCandidate | undefined;
      if (body.path) {
        const kind = validateFirmwareFile(body.path);
        if (!kind) {
          json(res, 422, { ok: false, error: `"${body.path}" 未通过固件校验（.elf/.bin/.hex + ELF 魔数），这是 artifact 错误，不是 MCU 问题` });
          return;
        }
        artifact = { filePath: body.path, kind, mtimeMs: 0, exampleRank: -1 };
      } else {
        artifact = await resolveArtifact(root);
      }
      if (!artifact) {
        json(res, 409, { ok: false, error: '未找到有效固件，请先 build（artifact 错误，不是 MCU 不在线）' });
        return;
      }
      const sessionStopped = await releaseProbeForHardware('烧录');
      const output = await runCommandLogged(buildDownloadCommand(artifact), root, 180_000);
      const summary = await getProbeSummary(true);
      await updateDashboardView();
      json(res, 200, { ok: true, flashed: artifact.filePath, kind: artifact.kind, mcu: summary.mcu, sessionStopped, settingsEpoch, output: output.stdout.slice(-400) });
      return;
    }

    if (route === '/api/reset' && method === 'POST') {
      await releaseProbeForHardware('复位');
      await runCommandLogged(`probe-rs reset ${probeBaseArgs().join(' ')}`, process.cwd(), 60_000);
      await updateDashboardView();
      json(res, 200, { ok: true, mcu: 'online（reset 应答）' });
      return;
    }

    if (route === '/api/erase' && method === 'POST') {
      await releaseProbeForHardware('全片擦除');
      await runCommandLogged(buildEraseCommand(), process.cwd(), 120_000);
      json(res, 200, { ok: true, erased: true });
      return;
    }

    if (route === '/api/memory') {
      const addressNum = parseHexNumber(url.searchParams.get('address'), 0x20000000);
      const length = Math.max(1, Math.min(256, parseCount(url.searchParams.get('length'), 64)));
      const addrHex = `0x${addressNum.toString(16)}`;
      const r = await readMemoryForTools(addrHex, length);
      if (!r.buf) {
        json(res, 503, { ok: false, error: r.error ?? '读内存失败（MCU 可能未连接）' });
        return;
      }
      json(res, 200, { ok: true, address: addrHex, length: r.buf.length, paused: r.paused === true, hex: r.buf.toString('hex'), ascii: r.buf.toString('latin1').replace(/[^\x20-\x7e]/g, '.') });
      return;
    }

    if (route === '/api/debug/state') {
      json(res, 200, { ok: true, debug: await fetchDebugState() });
      return;
    }

    if (route === '/api/debug/pause' && method === 'POST') {
      if (!debugSession) { json(res, 409, { ok: false, error: '没有活动调试会话' }); return; }
      await debugControl('pause');
      json(res, 200, { ok: true, paused: true });
      return;
    }

    if (route === '/api/debug/continue' && method === 'POST') {
      if (!debugSession) { json(res, 409, { ok: false, error: '没有活动调试会话' }); return; }
      await debugControl('continue');
      json(res, 200, { ok: true, running: true });
      return;
    }

    for (const [route2, action] of [
      ['/api/debug/step-over', 'next'],
      ['/api/debug/step-into', 'stepIn'],
      ['/api/debug/step-out', 'stepOut'],
      ['/api/debug/restart', 'restart']
    ] as Array<[string, 'next' | 'stepIn' | 'stepOut' | 'restart']>) {
      if (route === route2 && method === 'POST') {
        if (!debugSession) { json(res, 409, { ok: false, error: '没有活动调试会话' }); return; }
        const tid = await getMainThreadId();
        if (tid == null) { json(res, 409, { ok: false, error: '取不到线程 id（会话未就绪）' }); return; }
        try {
          await debugSession.customRequest(action, { threadId: tid });
          await pushDebugState();
          json(res, 200, { ok: true, action });
        } catch (err) {
          json(res, 500, { ok: false, error: `${action} 失败: ${err instanceof Error ? err.message : err}` });
        }
        return;
      }
    }

    if (route === '/api/memory' && method === 'POST') {
      if (!debugSession) { json(res, 409, { ok: false, error: '写内存需要活动调试会话' }); return; }
      let body: { address?: string; hex?: string } = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 */ }
      const addr = (body.address ?? '').replace(/^0x/i, '').trim();
      if (!/^[0-9a-fA-F]+$/.test(addr) || !body.hex) { json(res, 400, { ok: false, error: '参数: {"address":"0x20000000","hex":"00112233"}' }); return; }
      const written = await writeMemoryViaDap(addr, body.hex);
      if (written === 0) { json(res, 503, { ok: false, error: '写入失败（地址需 4 字节对齐？非调试状态？）' }); return; }
      json(res, 200, { ok: true, address: `0x${addr}`, bytesWritten: written });
      return;
    }

    if (route === '/api/registers') {
      const name = (url.searchParams.get('name') ?? 'sysctrl').toLowerCase();
      const result = await readPeripheralRegisters(name);
      if (result.error) { json(res, 400, { ok: false, error: result.error }); return; }
      json(res, 200, {
        ok: true,
        peripheral: result.peripheral.key,
        label: result.peripheral.label,
        base: `0x${result.peripheral.base.toString(16)}`,
        regs: result.rows
      });
      return;
    }

    if (route === '/api/detect') {
      const rep = await runChipDetect();
      let appliedChip: string | undefined;
      if (url.searchParams.get('apply') === '1' && rep.ok && rep.chip) {
        await vscode.workspace.getConfiguration('cw32l012').update('chip', rep.chip, vscode.ConfigurationTarget.Workspace);
        appliedChip = rep.chip;
      }
      json(res, rep.ok ? 200 : 503, { ...rep, appliedChip });
      return;
    }

    if (route === '/api/serial/ports') {
      const Ctor = loadSerialport();
      if (!Ctor) { json(res, 503, { ok: false, error: 'serialport 模块不可用' }); return; }
      const ports = await Ctor.list();
      json(res, 200, { ok: true, ports });
      return;
    }

    if (route === '/api/serial/open' && method === 'POST') {
      let body: { path?: string; baudRate?: number } = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 */ }
      const Ctor = loadSerialport();
      if (!Ctor) { json(res, 503, { ok: false, error: 'serialport 模块不可用' }); return; }
      if (!body.path) { json(res, 422, { ok: false, error: '缺少 path（COM 端口）' }); return; }
      closeSerial();
      const baud = body.baudRate ?? getConfig().monitorBaudRate;
      const channel = getSerialChannel();
      channel.appendLine(`\n[serial] 打开 ${body.path} @ ${baud} 8N1（Agent API）`);
      const port = new Ctor({ path: body.path, baudRate: baud, autoOpen: false, dataBits: 8, stopBits: 1, parity: 'none' });
      serialPort = port;
      serialPath = body.path;
      serialBaud = baud;
      port.on('data', (buf: Buffer) => { const text = buf.toString('utf8'); channel.append(text); pushSerialRx(text); });
      port.on('error', (err: Error) => channel.appendLine(`\n[serial error] ${err.message}`));
      port.on('close', () => { channel.appendLine('\n[serial] 已关闭'); serialPort = undefined; serialPath = undefined; });
      const opened = await new Promise<{ ok: boolean; error?: string }>(resolve => {
        port.open((err?: Error | null) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
      });
      if (!opened.ok) { serialPort = undefined; serialPath = undefined; json(res, 500, { ok: false, error: opened.error }); return; }
      json(res, 200, { ok: true, path: body.path, baudRate: baud });
      return;
    }

    if (route === '/api/serial/close' && method === 'POST') {
      closeSerial();
      json(res, 200, { ok: true, closed: true });
      return;
    }

    if (route === '/api/serial/send' && method === 'POST') {
      if (!serialPort) { json(res, 409, { ok: false, error: '串口未打开' }); return; }
      let body: { data?: string } = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 */ }
      const data = body.data ?? '';
      serialPort.write(data);
      getSerialChannel().appendLine(`\n[tx] ${data.replace(/\r?\n$/, '')}`);
      json(res, 200, { ok: true, sent: data.length });
      return;
    }

    if (route === '/api/serial/tail') {
      const limit = Math.max(1, Math.min(500, parseCount(url.searchParams.get('limit'), 200)));
      json(res, 200, {
        ok: true,
        open: !!serialPort,
        path: serialPath ?? null,
        baudRate: serialBaud,
        partial: serialRxPartial,
        lines: serialRxBuffer.slice(-limit)
      });
      return;
    }

    if (route === '/api/diagnostics') {
      const report = await collectDiagnostics();
      json(res, 200, { ok: true, report });
      return;
    }

    if (route === '/api/logs') {
      json(res, 200, { ok: true, logs: logLines.slice(-60) });
      return;
    }

    json(res, 404, { ok: false, error: `未知端点 ${method} ${route}`, routes: API_ROUTES });
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function startApiServer(): Promise<string> {
  if (apiServer) {
    return `API 已在 http://127.0.0.1:${apiPortActive} 运行`;
  }
  const cfg = getConfig();
  const port = cfg.apiPort;
  const server = http.createServer((req, res) => {
    // 硬件相关路由统一租约：含读取（读内存/读寄存器/deep 探测都独占探针）
    // 与例程选择（会 bump settingsEpoch，与 MCP 侧 cw32_example_select 行为一致）
    const HARDWARE_API_ROUTES: Array<[string, string]> = [
      ['POST', '/api/build'], ['POST', '/api/flash'], ['POST', '/api/reset'], ['POST', '/api/erase'],
      ['POST', '/api/debug/pause'], ['POST', '/api/debug/continue'], ['POST', '/api/debug/step-over'],
      ['POST', '/api/debug/step-into'], ['POST', '/api/debug/step-out'], ['POST', '/api/debug/restart'],
      ['POST', '/api/memory'], ['POST', '/api/serial/open'], ['POST', '/api/examples/select'],
      ['GET', '/api/memory'], ['GET', '/api/registers'], ['GET', '/api/detect']
    ];
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const m = (req.method || 'GET').toUpperCase();
    const isDeepStatus = u.pathname === '/api/status' && u.searchParams.get('deep') === '1';
    const needsLease = isDeepStatus
      || HARDWARE_API_ROUTES.some(([rm, rr]) => rm === m && rr === u.pathname);
    if (needsLease) {
      const op = isDeepStatus ? 'GET /api/status?deep' : `${m} ${u.pathname}`;
      const conflict = acquireLease(op, 'api');
      if (conflict) { json(res, 409, { ok: false, conflict: true, error: conflict }); return; }
    }
    // 释放时机 = handleApi 整体结束（含异常）。客户端 abort 不提前放锁：
    // 操作还在跑就继续占用，避免「curl 一中断、下一个人进场双重烧录」。
    handleApi(req, res)
      .catch(err => {
        json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { if (needsLease) releaseLease(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  apiServer = server;
  apiPortActive = port;
  logBoth(`[api] Agent API 已启动: http://127.0.0.1:${port}（${cfg.apiToken ? '需要 x-cw32-token' : '无鉴权，仅本机'}）`);
  await updateDashboardView();
  return `Agent API 已启动: http://127.0.0.1:${port}`;
}

async function stopApiServer(): Promise<string> {
  if (!apiServer) return 'API 未在运行';
  await new Promise<void>(resolve => apiServer!.close(() => resolve()));
  apiServer = undefined;
  apiPortActive = undefined;
  logBoth('[api] Agent API 已停止');
  await updateDashboardView();
  return 'Agent API 已停止';
}

/* ------------------------------------------------------------
 * 命令实现
 * ---------------------------------------------------------- */

async function runBuild(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('请先打开包含 CW32L012 项目（Cargo.toml）的工作区。');
    return;
  }
  const cfg = getConfig();
  const selectedCmd = buildCommandForSelected(root);
  const buildCmd = selectedCmd ?? `cargo build --target ${cfg.target} --examples`;
  // 指定例程 → 增量构建（跳过 clean，秒级）；全量 --examples → 保持 clean 保证产物新鲜
  const doClean = !selectedCmd;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: selectedCmd ? `CW32L012 构建中（${getSelectedExample()}，增量）` : 'CW32L012 构建中（clean + build）', cancellable: false },
    async () => {
      try {
        if (doClean) await runCommandLogged('cargo clean', root, 120_000);
        cargoInfoCache = undefined; // 构建可能改动 Cargo.toml，清缓存重取 example 列表
        await runCommandLogged(buildCmd, root, 600_000);
        const artifact = await resolveArtifact(root);
        if (!artifact) {
          vscode.window.showWarningMessage('构建成功，但未找到可识别的固件产物。请查看 CW32L012 Tools 输出通道。');
          return;
        }
        logBoth(`[ok] 构建成功 → ${artifact.filePath} (${artifact.kind.toUpperCase()})`);
        vscode.window.showInformationMessage(`构建成功 → ${path.basename(artifact.filePath)} (${artifact.kind.toUpperCase()})`);
        await updateDashboardView();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logBoth(`[build failed] ${message.split('\n')[0]}`);
        vscode.window.showErrorMessage(`构建失败: ${message.split('\n').slice(0, 8).join('\n')}`);
      }
    }
  );
}

async function runClean(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('请先打开 CW32L012 工作区。');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CW32L012: cargo clean…', cancellable: false },
    async () => {
      try {
        await runCommandLogged('cargo clean', root, 120_000);
        cargoInfoCache = undefined;
        logBoth('[ok] cargo clean 完成');
        vscode.window.showInformationMessage('cargo clean 完成。');
        await updateDashboardView();
      } catch (err) {
        vscode.window.showErrorMessage(`cargo clean 失败: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      }
    }
  );
}

async function runRebuild(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('请先打开 CW32L012 工作区。');
    return;
  }
  const cfg = getConfig();
  const selectedCmd = buildCommandForSelected(root);
  const buildCmd = selectedCmd ?? `cargo build --target ${cfg.target} --examples`;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CW32L012: clean + build…', cancellable: false },
    async () => {
      try {
        await runCommandLogged('cargo clean', root, 120_000);
        cargoInfoCache = undefined;
        await runCommandLogged(buildCmd, root, 600_000);
        const artifact = await resolveArtifact(root);
        if (!artifact) {
          vscode.window.showWarningMessage('构建成功，但未找到可识别的固件产物。');
          return;
        }
        logBoth(`[ok] 重新构建成功 → ${artifact.filePath} (${artifact.kind.toUpperCase()})`);
        vscode.window.showInformationMessage(`重新构建成功 → ${path.basename(artifact.filePath)} (${artifact.kind.toUpperCase()})`);
        await updateDashboardView();
      } catch (err) {
        vscode.window.showErrorMessage(`重新构建失败: ${err instanceof Error ? err.message.split('\n').slice(0, 8).join('\n') : err}`);
      }
    }
  );
}

async function eraseAll(): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    '全片擦除会清除整个 FLASH（含所有页）。若启用了读保护，需先解锁。确定继续？',
    { modal: true }, '全片擦除'
  );
  if (pick !== '全片擦除') return;
  await releaseProbeForHardware('全片擦除');
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CW32: 全片擦除…', cancellable: false },
    async () => {
      try {
        await runCommandLogged(buildEraseCommand(), process.cwd(), 120_000);
        logBoth('[ok] 全片擦除完成');
        vscode.window.showInformationMessage('全片擦除完成。');
        await updateDashboardView();
      } catch (err) {
        vscode.window.showErrorMessage(`全片擦除失败（MCU 未应答或探针问题）: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      }
    }
  );
}

async function flashArtifact(artifact: FirmwareCandidate, root: string): Promise<void> {
  const command = buildDownloadCommand(artifact);
  logBoth(`[flash] 固件: ${artifact.filePath} (${artifact.kind.toUpperCase()})`);
  // probe-rs download/verify/reset 与 dap-server 抢探针，先结束会话
  await releaseProbeForHardware('烧录');
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `烧录 ${path.basename(artifact.filePath)} …`, cancellable: false },
    async () => {
      try {
        await runCommandLogged(command, root, 180_000);
        if (getConfig().verifyAfterFlash) {
          try {
            await runCommandLogged(buildVerifyCommand(artifact), root, 120_000);
            logBoth('[ok] verify 通过（FLASH 内容与固件一致）');
          } catch (verr) {
            vscode.window.showWarningMessage(`烧录完成，但 verify 未通过：${verr instanceof Error ? verr.message.split('\n')[0] : verr}`);
          }
        }
        const ok = `烧录成功: ${path.basename(artifact.filePath)}`;
        logBoth(`[ok] ${ok}`);
        vscode.window.showInformationMessage(ok);
        const summary = await getProbeSummary(true);
        logBoth(`[status] probe=${summary.probe}, mcu=${summary.mcu} — ${summary.detail}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const lower = message.toLowerCase();
        if (lower.includes('unknown file magic') || lower.includes('decode the elf')) {
          vscode.window.showErrorMessage(`烧录对象不是有效固件。这是 artifact 选择错误，不是 MCU 不在线。\n${message}`);
        } else if (lower.includes('no debug probe') || lower.includes('failed to open')) {
          vscode.window.showErrorMessage(`探针连接失败（probe 级别错误）。\n${message}`);
        } else {
          vscode.window.showErrorMessage(`烧录失败。\n${message}`);
        }
        throw err;
      }
    }
  );
}

async function runFlash(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('请先打开 CW32L012 工作区再烧录。');
    return;
  }
  const artifact = await resolveArtifact(root);
  if (!artifact) {
    const sel = getSelectedExample();
    const msg = sel !== AUTO_EXAMPLE
      ? `所选例程 "${sel}" 尚无有效固件产物。请先 Build 该例程（这是 artifact 错误，不是 MCU 不在线）。`
      : '未找到有效固件产物（.elf/.bin/.hex + ELF 魔数校验）。这是 artifact 选择错误，不是 MCU 不在线。请先执行 Build。';
    logBoth(`[flash aborted] ${msg}`);
    vscode.window.showErrorMessage(msg);
    return;
  }
  try {
    await flashArtifact(artifact, root);
    await updateDashboardView();
  } catch { /* flashArtifact 内部已报错 */ }
}

async function selectArtifact(): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('请先打开 CW32L012 工作区。');
    return;
  }
  const { candidates, targetDirectory } = await collectFirmwareCandidates(root);
  const ranked = rankCandidates(candidates);
  if (ranked.length === 0) {
    vscode.window.showInformationMessage(`没有找到有效固件（.elf/.bin/.hex + 魔数校验）。target 目录: ${targetDirectory}`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    ranked.map(c => ({
      label: `${path.basename(c.filePath)}  [${c.kind.toUpperCase()}]${c.exampleRank >= 0 ? '  (example)' : ''}`,
      description: c.filePath,
      candidate: c
    })),
    { placeHolder: '选择要烧录的固件（仅显示通过校验的文件）' }
  );
  if (!picked) return;
  try {
    await flashArtifact(picked.candidate, root);
    await updateDashboardView();
  } catch { /* 已报错 */ }
}

async function resetTarget(): Promise<void> {
  await releaseProbeForHardware('复位');
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'CW32 复位中…', cancellable: false },
    async () => {
      try {
        await runCommandLogged(`probe-rs reset ${probeBaseArgs().join(' ')}`, process.cwd(), 60_000);
        probeSummaryCache = undefined;
        vscode.window.showInformationMessage('复位成功（MCU 应答）。');
      } catch (err) {
        vscode.window.showErrorMessage(`复位失败（MCU 未应答或探针问题）。\n${err instanceof Error ? err.message : err}`);
      }
      await updateDashboardView();
    }
  );
}

async function checkStatus(): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '检测 probe / MCU 状态…', cancellable: false },
    async () => {
      const summary = await getProbeSummary(true);
      const lines = [
        `探针: ${summary.probe === 'online' ? '在线' : '离线'}  (${summary.device})`,
        `MCU : ${summary.mcu === 'online' ? '在线（reset 应答）' : summary.mcu === 'unreachable' ? '无应答' : '未检测'}  — ${summary.detail}`
      ];
      logBoth(`[status check]\n  ${lines.join('\n  ')}`);
      vscode.window.showInformationMessage(`CW32L012 状态\n${lines.join('\n')}`);
      await updateDashboardView();
    }
  );
}

/** 启动 SWD 调试会话；返回 true=已启动（供 MCP 侧判断成败，杜绝假成功） */
async function startDebugSession(): Promise<boolean> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('请先打开 CW32L012 工作区。');
    return false;
  }
  const artifact = await resolveArtifact(root);
  if (!artifact || artifact.kind !== 'elf') {
    vscode.window.showErrorMessage('调试需要有效 ELF 固件。当前未找到通过校验的 ELF，请先 Build（artifact 错误，不是 MCU 问题）。');
    return false;
  }
  // 已有会话时先释放探针，避免新旧两个 dap-server 争抢
  await releaseProbeForHardware('启动调试');
  const cfg = getConfig();
  const launch: vscode.DebugConfiguration = {
    type: DEBUG_TYPE,
    name: `${cfg.family.label} Debug`,
    request: 'launch',
    // probe-rs 0.32 dap-server launch 参数（0.32 起 coreConfigs[].program
    // 改名为 programBinary；camelCase 字段 0.32 全部接受）
    chip: cfg.chip,
    probe: cfg.probeId,
    protocol: cfg.protocol,
    chipDescriptionPath: cfg.chipDescriptionPath,
    allowEraseAll: true,
    flashingConfig: { flashingEnabled: true },
    coreConfigs: [{ coreIndex: 0, programBinary: artifact.filePath }],
    cwd: root
  };
  if (!cfg.chipDescriptionPath) {
    delete launch.chipDescriptionPath;
  }
  logBoth(`[debug] 启动 DAP 会话: ${artifact.filePath}`);
  try {
    const ok = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], launch);
    if (!ok) {
      vscode.window.showErrorMessage('调试会话启动失败（dap-server 未连接）。检查 probe-rs 版本与探针连接。');
      return false;
    }
    return true;
  } catch (err) {
    logBoth(`[debug] startDebugging 异常: ${err instanceof Error ? err.message : err}`);
    vscode.window.showErrorMessage(`调试会话启动失败: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/* ------------------------------------------------------------
 * 串口监视器（serialport 内置；无模块时降级为外部工具提示）
 * ---------------------------------------------------------- */

interface SerialPortLike {
  open(cb: (err?: Error | null) => void): void;
  close(cb?: (err?: Error | null) => void): void;
  write(data: string | Buffer): boolean;
  on(event: 'data', cb: (data: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  isOpen?: boolean;
}

interface SerialPortCtor {
  new (opts: { path: string; baudRate: number; autoOpen?: boolean; dataBits?: number; stopBits?: number; parity?: string }): SerialPortLike;
  list(): Promise<Array<{ path: string; manufacturer?: string; friendlyName?: string; serialNumber?: string }>>;
}

let serialPort: SerialPortLike | undefined;
let serialChannel: vscode.OutputChannel | undefined;
let serialBaud: number | undefined = 115200;
let serialPath: string | undefined;
/** 串口接收文本环（供 /api/serial/tail 与仪表盘读取） */
const serialRxBuffer: string[] = [];
let serialRxPartial = '';

function pushSerialRx(chunk: string): void {
  const combined = serialRxPartial + chunk;
  const parts = combined.split(/\r?\n/);
  serialRxPartial = parts.pop() ?? '';
  for (const line of parts) {
    if (line.length === 0) continue;
    serialRxBuffer.push(line);
    if (serialRxBuffer.length > 500) serialRxBuffer.splice(0, serialRxBuffer.length - 500);
  }
  if (serialRxPartial.length > 4096) serialRxPartial = serialRxPartial.slice(-1024);
}

/** 动态加载 serialport（原生模块缺失时返回 undefined，不使扩展崩溃） */
function loadSerialport(): SerialPortCtor | undefined {
  try {
    const mod = require('serialport') as { SerialPort?: SerialPortCtor };
    return mod.SerialPort ?? (mod as unknown as SerialPortCtor);
  } catch (err) {
    logBoth(`[serial] serialport 模块不可用: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

function getSerialChannel(): vscode.OutputChannel {
  if (!serialChannel) serialChannel = vscode.window.createOutputChannel('CW32L012 Serial');
  return serialChannel;
}

function closeSerial(): void {
  if (serialPort) {
    try { serialPort.close(); } catch { /* 已关闭 */ }
  }
  serialPort = undefined;
  serialPath = undefined;
}

async function serialSendLine(): Promise<void> {
  if (!serialPort) {
    vscode.window.showWarningMessage('串口未打开。请先运行「CW32L012: 打开串口监视器」。');
    return;
  }
  const text = await vscode.window.showInputBox({
    prompt: '发送内容（默认追加 \\r\\n；以 \\n 结尾则按原样发送）',
    placeHolder: 'AT'
  });
  if (text === undefined || text.length === 0) return;
  const payload = text.endsWith('\\n') ? text.slice(0, -2) + '\n' : `${text}\r\n`;
  try {
    serialPort.write(payload);
    getSerialChannel().appendLine(`\n[tx] ${text}`);
  } catch (err) {
    vscode.window.showErrorMessage(`串口发送失败: ${err instanceof Error ? err.message : err}`);
  }
}

async function openSerialMonitor(): Promise<void> {
  // 已打开：提供 关闭 / 发送 / 切换 选项
  if (serialPort) {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(close) 关闭串口', value: 'close' },
        { label: '$(edit) 发送一行数据…', value: 'send' },
        { label: '$(refresh) 切换串口 / 波特率…', value: 'reopen' }
      ],
      { placeHolder: `串口已打开: ${serialPath} @ ${serialBaud} 8N1` }
    );
    if (!action) return;
    if (action.value === 'close') { closeSerial(); logBoth('[serial] 已关闭'); return; }
    if (action.value === 'send') { await serialSendLine(); return; }
    closeSerial();
  }

  const Ctor = loadSerialport();
  if (!Ctor) {
    vscode.window.showWarningMessage('未安装 serialport 模块，无法内置串口监视。请使用外部串口工具（DAPLink UART 桥 / USB-TTL）。');
    return;
  }

  let ports: Array<{ path: string; manufacturer?: string; friendlyName?: string }> = [];
  try {
    ports = await Ctor.list();
  } catch (err) {
    logBoth(`[serial] 枚举串口失败: ${err instanceof Error ? err.message : err}`);
  }
  if (ports.length === 0) {
    vscode.window.showWarningMessage('未发现可用串口。请确认 USB-TTL / DAPLink UART 已连接。');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    ports.map(p => ({
      label: p.path,
      description: [p.friendlyName, p.manufacturer].filter(Boolean).join(' · ')
    })),
    { placeHolder: '选择串口（DAPLink 的 UART 桥 / USB-TTL）' }
  );
  if (!picked) return;

  const baudPick = await vscode.window.showQuickPick(
    ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map(b => ({
      label: b,
      description: Number(b) === getConfig().monitorBaudRate ? '默认' : ''
    })),
    { placeHolder: '选择波特率' }
  );
  if (!baudPick) return;
  serialBaud = parseInt(baudPick.label, 10) || 115200;
  serialPath = picked.label;

  const channel = getSerialChannel();
  channel.clear();
  channel.show(true);
  channel.appendLine(`[serial] 打开 ${serialPath} @ ${serialBaud} 8N1（再次运行本命令可发送/关闭）`);

  const port = new Ctor({ path: serialPath, baudRate: serialBaud, autoOpen: false, dataBits: 8, stopBits: 1, parity: 'none' });
  serialPort = port;
  port.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    channel.append(text);
    pushSerialRx(text);
  });
  port.on('error', (err: Error) => channel.appendLine(`\n[serial error] ${err.message}`));
  port.on('close', () => { channel.appendLine('\n[serial] 已关闭'); serialPort = undefined; serialPath = undefined; });
  port.open((err?: Error | null) => {
    if (err) {
      channel.appendLine(`[serial] 打开失败: ${err.message}`);
      serialPort = undefined;
      serialPath = undefined;
    }
  });

  vscode.window.showInformationMessage(`串口已打开: ${serialPath} @ ${serialBaud}。发送数据用命令面板「CW32L012: 串口发送」或再次运行本命令。`);
}

/* ------------------------------------------------------------
 * 内嵌 MCP 服务器（SSE 传输，与 Agent API 同进程）
 *
 * 设计边界：只暴露硬件工作流（构建/烧录/调试/内存/寄存器/串口/状态），
 * 不提供任何文件/代码编辑工具——编辑是 VS Code 本体与 AI 编辑器的职责。
 * 与外部 embedded-debugger-mcp 的区别：本实现复用插件内的 DAP 会话与
 * CLI 通道，与人类操作员共享同一状态，**无探针独占冲突**。
 * ---------------------------------------------------------- */

let mcpServer: http.Server | undefined;
let mcpPortActive: number | undefined;
const mcpSessions = new Map<string, { res: http.ServerResponse }>();

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function mcpNewSessionId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'cw32_status',
    description: '综合状态：probe 探针 / MCU 在线分级 / 当前固件产物 / 例程选择 / 调试会话 / 串口。做任何硬件操作前先调用这个。',
    inputSchema: { type: 'object', properties: { deep: { type: 'boolean', description: 'true=reset 级深度检测 MCU（慢，约 2-5s）' } } },
    handler: async a => {
      const summary = await getProbeSummary(a.deep === true);
      const root = getWorkspaceRoot();
      const artifact = root ? await resolveArtifact(root) : undefined;
      return {
        probe: summary.probe, mcu: summary.mcu, device: summary.device, detail: summary.detail,
        example: describeSelectedExample(),
        settingsEpoch,
        lease: activeLease ? describeLease(activeLease) : null,
        artifact: artifact ? { path: artifact.filePath, kind: artifact.kind } : null,
        debug: await fetchDebugState(),
        serial: serialPort ? { open: true, path: serialPath, baudRate: serialBaud, recentLines: serialRxBuffer.slice(-20) } : { open: false }
      };
    }
  },
  {
    name: 'cw32_build',
    description: '构建固件。已选例程=增量构建（秒级）；自动模式=clean+全量 --examples（分钟级）。构建后返回产物路径。建议带 expectedEpoch 防止构建期间设置被人类改动。',
    inputSchema: { type: 'object', properties: { expectedEpoch: { type: 'number', description: '上次 cw32_status 返回的 settingsEpoch；不匹配则拒绝执行' } } },
    handler: async () => {
      const root = getWorkspaceRoot();
      if (!root) throw new Error('未打开 CW32L012 工作区');
      const targeted = buildCommandForSelected(root);
      if (!targeted) await runCommandLogged('cargo clean', root, 120_000);
      cargoInfoCache = undefined;
      const buildCmd = targeted ?? `cargo build --target ${getConfig().target} --examples`;
      await runCommandLogged(buildCmd, root, 600_000);
      const artifact = await resolveArtifact(root);
      await updateDashboardView();
      return { built: true, command: buildCmd, settingsEpoch, artifact: artifact ? { path: artifact.filePath, kind: artifact.kind } : null };
    }
  },
  {
    name: 'cw32_flash',
    description: '烧录固件到 MCU（probe-rs download，自动选产物，verifyAfterFlash 默认开）。烧录前 MCU 会自动复位。建议带 expectedEpoch 防止烧错设置。',
    inputSchema: { type: 'object', properties: { expectedEpoch: { type: 'number', description: '上次 cw32_status 返回的 settingsEpoch；不匹配则拒绝执行' } } },
    handler: async () => {
      const root = getWorkspaceRoot();
      if (!root) throw new Error('未打开 CW32L012 工作区');
      const artifact = await resolveArtifact(root);
      if (!artifact) throw new Error('未找到有效固件产物（.elf/.bin/.hex）。请先 cw32_build。这是 artifact 问题，不是 MCU 不在线。');
      await flashArtifact(artifact, root);
      await updateDashboardView();
      return { flashed: artifact.filePath, kind: artifact.kind, settingsEpoch };
    }
  },
  {
    name: 'cw32_reset',
    description: '复位目标 MCU（probe-rs reset）。复位有应答即 MCU 在线。有调试会话时会先自动结束会话释放探针。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const sessionStopped = await releaseProbeForHardware('复位');
      await runCommandLogged(`probe-rs reset ${probeBaseArgs().join(' ')}`, process.cwd(), 60_000);
      await updateDashboardView();
      return { reset: true, mcu: 'online（reset 应答）', sessionStopped };
    }
  },
  {
    name: 'cw32_erase',
    description: '全片擦除 FLASH（危险操作：清空固件）。擦除后需重新烧录。有调试会话时会先自动结束会话释放探针。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      await releaseProbeForHardware('全片擦除');
      await runCommandLogged(buildEraseCommand(), process.cwd(), 120_000);
      await updateDashboardView();
      return { erased: true };
    }
  },
  {
    name: 'cw32_clean',
    description: 'cargo clean（删除构建产物）。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const root = getWorkspaceRoot();
      if (!root) throw new Error('未打开工作区');
      await runCommandLogged('cargo clean', root, 120_000);
      cargoInfoCache = undefined;
      return { cleaned: true };
    }
  },
  {
    name: 'cw32_examples',
    description: '列出全部 example 例程与当前选择。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const root = getWorkspaceRoot();
      if (!root) throw new Error('未打开工作区');
      const info = await getCargoInfo(root);
      return { examples: info.exampleNames, selected: describeSelectedExample() };
    }
  },
  {
    name: 'cw32_example_select',
    description: '选择例程（之后的 build 增量构建它、flash/debug 优先烧录它）。name="__auto__" 或省略=恢复自动选最新。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '例程名，如 blink_pc13；__auto__ = 自动' } } },
    handler: async a => {
      const name = typeof a.name === 'string' && a.name ? a.name : AUTO_EXAMPLE;
      const root = getWorkspaceRoot();
      if (root && name !== AUTO_EXAMPLE) {
        const info = await getCargoInfo(root);
        if (!info.exampleNames.includes(name)) throw new Error(`例程不存在: ${name}。可用: ${info.exampleNames.join(', ')}`);
      }
      setSelectedExample(name);
      return { selected: name, selectedLabel: describeSelectedExample(), settingsEpoch };
    }
  },
  {
    name: 'cw32_memory_read',
    description: '读内存。有调试会话时只走 DAP（运行态自动 pause→读→resume，不与 dap-server 抢探针），无会话走 probe-rs CLI。常用地址：0x0=向量表(MSP)、0x20000000=SRAM、0x40004000=SYSCTRL(L012)。',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: '十六进制地址，如 0x20000000' }, length: { type: 'number', description: '字节数 1-256，默认 64' } }, required: ['address'] },
    handler: async a => {
      const addressNum = parseHexNumber(typeof a.address === 'string' ? a.address : undefined, NaN);
      if (Number.isNaN(addressNum)) throw new Error('address 需为十六进制，如 0x20000000');
      const length = Math.max(1, Math.min(256, parseCount(typeof a.length === 'number' ? String(a.length) : undefined, 64)));
      const addrHex = `0x${addressNum.toString(16)}`;
      const r = await readMemoryForTools(addrHex, length);
      if (!r.buf) throw new Error(r.error ?? '读内存失败');
      return { address: addrHex, length: r.buf.length, paused: r.paused === true, hex: r.buf.toString('hex'), ascii: r.buf.toString('latin1').replace(/[^\x20-\x7e]/g, '.') };
    }
  },
  {
    name: 'cw32_memory_write',
    description: '写内存（危险操作）。需活动调试会话，地址 4 字节对齐。hex 为小端字节串，如写 0x12345678 到 0x20000000 → hex "78563412"。',
    inputSchema: { type: 'object', properties: { address: { type: 'string' }, hex: { type: 'string', description: '偶数位十六进制字节串，如 00112233' } }, required: ['address', 'hex'] },
    handler: async a => {
      if (!debugSession) throw new Error('写内存需要活动调试会话（先 cw32_debug_start）');
      const addr = String(a.address ?? '').replace(/^0x/i, '').trim();
      if (!/^[0-9a-fA-F]+$/.test(addr)) throw new Error('address 需为十六进制');
      const written = await writeMemoryViaDap(addr, String(a.hex ?? ''));
      if (written === 0) throw new Error('写入失败（地址 4 字节对齐？核心未暂停？）');
      return { address: `0x${addr}`, bytesWritten: written };
    }
  },
  {
    name: 'cw32_registers_read',
    description: '读外设寄存器并按位段解码。外设列表由当前家族(cw32l012/cw32f030)的寄存器表决定，缺省 sysctrl。',
    inputSchema: { type: 'object', properties: { peripheral: { type: 'string', enum: ['sysctrl'], description: '外设名，默认 sysctrl（实际枚举由 tools/list 按当前家族动态生成）' } } },
    handler: async a => {
      const result = await readPeripheralRegisters(String(a.peripheral ?? 'sysctrl').toLowerCase());
      if (result.error) throw new Error(result.error);
      return { peripheral: result.peripheral.key, label: result.peripheral.label, base: `0x${result.peripheral.base.toString(16)}`, regs: result.rows };
    }
  },
  {
    name: 'cw32_debug_start',
    description: '启动 SWD 调试会话（probe-rs dap-server：烧录+断点+可视化）。启动后可用 debug_control 单步/暂停，人类在 VS Code 里也能看到同一会话。建议带 expectedEpoch。',
    inputSchema: { type: 'object', properties: { expectedEpoch: { type: 'number', description: '上次 cw32_status 返回的 settingsEpoch；不匹配则拒绝执行' } } },
    handler: async () => {
      const ok = await startDebugSession();
      if (!ok) throw new Error('调试会话启动失败（ELF 缺失 / 探针未连接 / dap-server 启动失败）。');
      return { started: true, settingsEpoch };
    }
  },
  {
    name: 'cw32_debug_state',
    description: '调试会话状态：是否暂停、PC、调用栈、变量值。核心在跑时 frames 为空。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => await fetchDebugState()
  },
  {
    name: 'cw32_debug_control',
    description: '调试控制动作。pause=暂停、continue=继续、step_over=步过、step_into=步入、step_out=步出、restart=复位重跑、stop=结束会话。',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'continue', 'step_over', 'step_into', 'step_out', 'restart', 'stop'] } }, required: ['action'] },
    handler: async a => {
      const action = String(a.action ?? '');
      if (action !== 'stop' && !debugSession) throw new Error('无活动调试会话（先 cw32_debug_start）');
      const daps: Record<string, 'pause' | 'continue' | 'next' | 'stepIn' | 'stepOut' | 'restart'> = {
        pause: 'pause', continue: 'continue', step_over: 'next', step_into: 'stepIn', step_out: 'stepOut', restart: 'restart'
      };
      if (action === 'stop') {
        if (!debugSession) throw new Error('没有活动调试会话');
        await vscode.debug.stopDebugging(debugSession);
        return { stopped: true };
      }
      const dap = daps[action];
      if (!dap) throw new Error(`未知动作: ${action}`);
      await debugControl(dap);
      return { action, debug: await fetchDebugState() };
    }
  },
  {
    name: 'cw32_serial_open',
    description: '打开串口监视（如 COM3 / /dev/ttyUSB0）。打开后 cw32_serial_tail 收数据、cw32_serial_send 发数据。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '串口设备路径，如 COM3' }, baudRate: { type: 'number', description: '默认 115200' } }, required: ['path'] },
    handler: async a => {
      const Ctor = loadSerialport();
      if (!Ctor) throw new Error('serialport 模块不可用（VSIX 安装时无 node_modules；请在工作区 npm install serialport）');
      const p = String(a.path ?? '');
      const baud = typeof a.baudRate === 'number' ? a.baudRate : 115200;
      if (serialPort) closeSerial();
      const port = new Ctor({ path: p, baudRate: baud, autoOpen: false, dataBits: 8, stopBits: 1, parity: 'none' });
      serialPort = port; serialPath = p; serialBaud = baud;
      port.on('data', (buf: Buffer) => { const text = buf.toString('utf8'); getSerialChannel().append(text); pushSerialRx(text); });
      port.on('error', (err: Error) => getSerialChannel().appendLine(`\n[serial error] ${err.message}`));
      port.on('close', () => { serialPort = undefined; serialPath = undefined; serialBaud = undefined; });
      const opened = await new Promise<{ ok: boolean; error?: string }>(resolve => {
        port.open((err?: Error | null) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
      });
      if (!opened.ok) { serialPort = undefined; serialPath = undefined; serialBaud = undefined; throw new Error(`打开失败: ${opened.error}`); }
      return { open: true, path: p, baudRate: baud };
    }
  },
  {
    name: 'cw32_serial_send',
    description: '向已打开的串口发送数据（字符串，\\r\\n 需显式写在 data 里）。',
    inputSchema: { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] },
    handler: async a => {
      if (!serialPort) throw new Error('串口未打开（先 cw32_serial_open）');
      const data = String(a.data ?? '');
      serialPort.write(data);
      getSerialChannel().appendLine(`\n[tx] ${data.replace(/\r?\n$/, '')}`);
      return { sent: data.length };
    }
  },
  {
    name: 'cw32_serial_tail',
    description: '读串口接收缓冲最近 N 行（默认 200，上限 500）。UART 日志通道。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    handler: async a => {
      const limit = Math.max(1, Math.min(500, typeof a.limit === 'number' ? a.limit : 200));
      return { open: !!serialPort, path: serialPath, lines: serialRxBuffer.slice(-limit) };
    }
  },
  {
    name: 'cw32_diagnostics',
    description: '完整诊断报告（workspace/配置/probe/产物/调试/串口一页汇总），排查故障时用。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ report: await collectDiagnostics() })
  },
  {
    name: 'cw32_chip_detect',
    description: '运行 cw32-detect 读出厂数字签名识别芯片（型号串/Flash/RAM/管脚/UID/probe-rs 目标名）。apply=true 时把识别到的芯片名写入 cw32l012.chip 设置。需 cw32-detect 可执行（github.com/SunWithCloude/cw32-probe-rs-compat）。',
    inputSchema: { type: 'object', properties: { apply: { type: 'boolean', description: '把识别结果写入 chip 设置（默认 false）' } } },
    handler: async a => {
      const rep = await runChipDetect();
      let appliedChip: string | undefined;
      if (a.apply === true && rep.ok && rep.chip) {
        await vscode.workspace.getConfiguration('cw32l012').update('chip', rep.chip, vscode.ConfigurationTarget.Workspace);
        appliedChip = rep.chip; // 设置变更钩子会自动 bumpSettingsEpoch
      }
      return { ...rep, appliedChip };
    }
  }
];

/** MCP JSON-RPC 消息分发（SSE 传输） */
async function handleMcpMessage(msg: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } }): Promise<unknown | undefined> {
  const id = msg.id;
  const method = msg.method ?? '';
  if (method === 'initialize') {
    const requested = msg.params?.protocolVersion;
    return { jsonrpc: '2.0', id, result: { protocolVersion: typeof requested === 'string' && requested ? requested : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cw32l012-tools', version: extVersion }, instructions: 'CW32L012 嵌入式工作流：先 cw32_status，再 build→flash→debug。只管硬件链路，不做代码编辑。并发规则：硬件操作互斥（冲突时报错说明占用方）；设置被人类改动时用 expectedEpoch 重新校验。' } };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled' || method.startsWith('notifications/')) return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    const tools = MCP_TOOLS.map(t => {
      const def = { name: t.name, description: t.description, inputSchema: t.inputSchema };
      // 寄存器外设枚举随当前家族动态生成（families.ts 按芯片提供）
      if (t.name === 'cw32_registers_read') {
        def.inputSchema = {
          type: 'object',
          properties: { peripheral: { type: 'string', enum: peripheralMap().map(p => p.key), description: '外设名，默认 sysctrl' } }
        };
      }
      return def;
    });
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'tools/call') {
    const name = msg.params?.name;
    const tool = MCP_TOOLS.find(t => t.name === name);
    if (!tool) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true } };
    try {
      const args = msg.params?.arguments ?? {};
      const guarded = async () => {
        checkEpoch(args.expectedEpoch); // 租约内校验，缩小「校验后设置被改」的窗口
        return tool.handler(args);
      };
      // deep=true 的状态查询会做 reset 级探测（独占探针），与写入类同等对待；
      // 与 Agent API 侧 GET /api/status?deep=1 的租约行为保持一致
      const isDeepStatus = String(name) === 'cw32_status' && args.deep === true;
      const data = HARDWARE_MCP_TOOLS.has(String(name)) || isDeepStatus
        ? await withLease(isDeepStatus ? 'cw32_status(deep)' : String(name), 'ai', guarded)
        : await guarded();
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `错误: ${err instanceof Error ? err.message : err}` }], isError: true } };
    }
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } };
  return undefined;
}

function startMcpServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (mcpServer) { resolve(`MCP 服务器已在运行: http://127.0.0.1:${mcpPortActive}/sse`); return; }
    const port = getConfig().mcpPort;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (u.pathname === '/sse' && req.method === 'GET') {
        const sessionId = mcpNewSessionId();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(`event: endpoint\ndata: /mcp-message?sessionId=${sessionId}\n\n`);
        mcpSessions.set(sessionId, { res });
        const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 已断开 */ } }, 30_000);
        req.on('close', () => { mcpSessions.delete(sessionId); clearInterval(keepAlive); });
        return;
      }
      if (u.pathname === '/mcp-message' && req.method === 'POST') {
        const sessionId = u.searchParams.get('sessionId') ?? '';
        const session = mcpSessions.get(sessionId);
        if (!session) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Unknown MCP session（先 GET /sse 获取 endpoint）'); return; }
        void (async () => {
          const body = await readBody(req);
          let msg: Parameters<typeof handleMcpMessage>[0];
          try { msg = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end(); return; }
          const response = await handleMcpMessage(msg);
          if (response !== undefined && session) {
            try { session.res.write(`data: ${JSON.stringify(response)}\n\n`); } catch { /* SSE 已断开 */ }
          }
          res.writeHead(202);
          res.end('Accepted');
        })();
        return;
      }
      res.writeHead(404); res.end();
    });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => {
      mcpServer = srv; mcpPortActive = port;
      const msg = `MCP 服务器已启动: http://127.0.0.1:${port}/sse（Claude Code：mcpServers.cw32l012 → type sse）`;
      logBoth(`[mcp] ${msg}（${MCP_TOOLS.length} 个工具：硬件工作流专用，不含代码编辑）`);
      resolve(msg);
    });
  });
}

function stopMcpServer(): string {
  for (const s of mcpSessions.values()) { try { s.res.end(); } catch { /* 已断开 */ } }
  mcpSessions.clear();
  if (mcpServer) { mcpServer.close(); mcpServer = undefined; }
  const was = mcpPortActive;
  mcpPortActive = undefined;
  return was ? `MCP 服务器已停止（端口 ${was}）` : 'MCP 服务器未在运行';
}

/* ------------------------------------------------------------
 * AI 诊断报告
 * ---------------------------------------------------------- */

async function collectDiagnostics(): Promise<string> {
  const root = getWorkspaceRoot() ?? 'No workspace';
  const cfg = getConfig();
  const info = root === 'No workspace' ? { targetDirectory: '-', exampleNames: [], ok: false } : await getCargoInfo(root);
  const artifact = root === 'No workspace' ? undefined : await resolveArtifact(root);
  const summary = await getProbeSummary(true);
  const debugState = await fetchDebugState();

  const report = [
    `${cfg.family.label} Debug Report`,
    `family: ${cfg.familyKey}（chip=${cfg.chip}${cfg.chipDescriptionPath ? `, yaml=${cfg.chipDescriptionPath}` : ', probe-rs 内置'}）`,
    `workspace: ${root}`,
    `target: ${cfg.target} (${cfg.profile})`,
    `cargo target_directory: ${info.targetDirectory}`,
    `examples: ${info.exampleNames.join(', ') || '(none)'}`,
    `artifact: ${artifact ? `${artifact.filePath} [${artifact.kind.toUpperCase()}]` : '未找到有效固件'}`,
    `probe: ${summary.probe} (${summary.device})`,
    `mcu: ${summary.mcu} — ${summary.detail}`,
    `debug session: ${debugState.active ? `${debugState.sessionName} pc=${debugState.pc ?? '-'}` : '无'}`,
    `agent api: ${apiServer ? `http://127.0.0.1:${apiPortActive}` : '未启动'}`,
    `flashBaseAddress: ${cfg.flashBaseAddress}（${cfg.family.label} FLASH ORIGIN=0x0）`,
    '',
    '结论指引:',
    '- probe=offline → USB/驱动/probe-rs 安装问题',
    '- probe=online 且 mcu=unreachable → SWD 接线/供电问题',
    '- artifact=未找到 → 先 Build；这是 artifact 错误，不是 MCU 问题'
  ].join('\n');

  await vscode.env.clipboard.writeText(report);
  getLog().appendLine('\n' + report + '\n');
  getLog().show(false);
  vscode.window.showInformationMessage('诊断报告已复制到剪贴板并写入输出通道。');
  return report;
}

/* ------------------------------------------------------------
 * 仪表盘（postMessage 驱动：骨架一次渲染，数据动态推送）
 * ---------------------------------------------------------- */

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface DashState {
  statusText: string;
  statusClass: string;
  probe: string;
  mcu: string;
  chip: string;
  detected: string;
  firmware: string;
  sourceDir: string;
  sourceDirOverride: boolean;
  mcpRunning: boolean;
  mcpPort?: number;
  apiRunning: boolean;
  apiPort?: number;
  sessionActive: boolean;
  serialOpen: boolean;
  serialPath?: string;
  serialBaud: number | undefined;
  serialLines: string[];
  logs: string[];
}

async function gatherDashState(): Promise<DashState> {
  const root = getWorkspaceRoot();
  const summary = await getProbeSummary(false);
  const artifact = root ? await resolveArtifact(root) : undefined;
  const cfg = getConfig();
  return {
    statusText: summary.probe === 'offline' ? 'PROBE OFFLINE' : summary.mcu === 'online' ? 'MCU ONLINE' : summary.mcu === 'unreachable' ? 'MCU UNREACHABLE' : 'PROBE ONLINE',
    statusClass: summary.probe === 'offline' ? 'pill-off' : summary.mcu === 'online' ? 'pill-ok' : 'pill-warn',
    probe: summary.device,
    mcu: summary.probe === 'offline' ? '—' : summary.mcu === 'online' ? '在线' : summary.mcu === 'unreachable' ? '无应答' : '未检测',
    chip: cfg.chip,
    detected: lastDetectReport
      ? (lastDetectReport.ok && lastDetectReport.chip
        ? `${lastDetectReport.type_string ?? '?'} → ${lastDetectReport.chip}`
        : `识别失败: ${(lastDetectReport.raw ?? '').split('\n')[0].slice(0, 60)}`)
      : '',
    firmware: artifact ? `${path.basename(artifact.filePath)} (${artifact.kind.toUpperCase()})` : '无有效固件 — 请先 Build',
    sourceDir: root ?? '未定位 — 打开工作区或点「切换」手动指定',
    sourceDirOverride: !!cfg.workspaceRoot,
    mcpRunning: !!mcpServer,
    mcpPort: mcpPortActive,
    apiRunning: !!apiServer,
    apiPort: apiPortActive,
    sessionActive: !!debugSession,
    serialOpen: !!serialPort,
    serialPath,
    serialBaud,
    serialLines: serialRxBuffer.slice(-40),
    logs: logLines.slice(-20)
  };
}

async function pushDashState(): Promise<void> {
  try {
    const state = await gatherDashState();
    dashboardPanel?.webview.postMessage({ type: 'state', state });
    dashboardView?.webview.postMessage({ type: 'state', state });
  } catch { /* 忽略刷新失败 */ }
}

async function pushDebugState(): Promise<void> {
  if (!debugSession) return;
  try {
    const state = await fetchDebugState();
    dashboardPanel?.webview.postMessage({ type: 'debug', state });
    dashboardView?.webview.postMessage({ type: 'debug', state });
  } catch { /* 忽略 */ }
}

function dashboardScript(): string {
  return `
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-command]').forEach((node) => {
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      const command = node.getAttribute('data-command');
      if (command) vscode.postMessage({ command });
    });
  });
  const memBtn = document.getElementById('mem-read');
  if (memBtn) {
    memBtn.addEventListener('click', () => {
      const addr = (document.getElementById('mem-addr')?.value || '20000000').replace(/^0x/, '');
      const len = parseInt(document.getElementById('mem-len')?.value || '64', 10) || 64;
      vscode.postMessage({ command: 'readMemory', address: addr, length: len });
    });
  }
  const memWriteBtn = document.getElementById('mem-write-btn');
  if (memWriteBtn) {
    memWriteBtn.addEventListener('click', () => {
      const addr = (document.getElementById('mem-addr')?.value || '').replace(/^0x/, '').trim();
      const hex = (document.getElementById('mem-write-hex')?.value || '').replace(/^0x/, '').trim();
      if (!addr || !hex) return;
      vscode.postMessage({ command: 'writeMemory', address: addr, hex });
    });
  }
  const periphBtn = document.getElementById('periph-read');
  if (periphBtn) {
    periphBtn.addEventListener('click', () => {
      const sel = document.getElementById('periph-select');
      vscode.postMessage({ command: 'readRegisters', peripheral: sel ? sel.value : 'sysctrl' });
    });
  }
  const memPreset = document.getElementById('mem-preset');
  if (memPreset) {
    memPreset.addEventListener('change', () => {
      const val = memPreset.value;
      if (val === 'custom') return;
      const addrEl = document.getElementById('mem-addr');
      if (addrEl) addrEl.value = val;
    });
  }
  document.querySelectorAll('[data-copy]').forEach((node) => {
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = node.getAttribute('data-copy');
      if (text) vscode.postMessage({ command: 'copyText', text });
    });
  });
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'state') {
      const s = msg.state;
      const pill = document.getElementById('status-pill');
      if (pill) { pill.textContent = s.statusText; pill.className = 'status-pill ' + s.statusClass; }
      setText('m-probe', s.probe);
      setText('m-mcu', s.mcu);
      setText('m-fw', s.firmware);
      setText('m-api', s.apiRunning ? ('RUNNING :' + (s.apiPort || '')) : 'STOPPED');
      setText('m-serial', s.serialOpen ? (s.serialPath + ' @ ' + s.serialBaud) : 'CLOSED');
      setText('m-mcp', s.mcpRunning ? (':' + (s.mcpPort || '')) : 'OFF');
      setText('srcbar-path', s.sourceDir);
      const badge = document.getElementById('srcbar-badge');
      if (badge) {
        badge.textContent = s.sourceDirOverride ? '手动' : '自动';
        badge.className = 'srcbar-badge' + (s.sourceDirOverride ? '' : ' dim-badge');
      }
      const logEl = document.getElementById('syslog');
      if (logEl && s.logs) logEl.innerHTML = s.logs.map(escapeHtml).join('<br>') || '（暂无日志）';
      const serEl = document.getElementById('serial-body');
      if (serEl && s.serialLines) {
        serEl.innerHTML = s.serialLines.length
          ? s.serialLines.map(escapeHtml).join('<br>')
          : '<div class="dim">已打开，等待数据…（串口无输出）</div>';
      }
    } else if (msg.type === 'debug') {
      renderDebug(msg.state);
    } else if (msg.type === 'memory') {
      renderMemory(msg);
    } else if (msg.type === 'memoryWrite') {
      const body = document.getElementById('mem-body');
      if (body) body.innerHTML = msg.error
        ? '<div class="warn">' + escapeHtml(msg.error) + '</div>'
        : '<div class="kv"><span>已写入</span><span class="mono">' + escapeHtml(msg.address) + '（' + msg.bytesWritten + ' 字节）</span></div>';
    } else if (msg.type === 'registers') {
      renderRegisters(msg);
    }
  });
  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
  function escapeHtml(t) { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function renderDebug(d) {
    const body = document.getElementById('debug-body');
    if (!body) return;
    if (!d || !d.active) {
      body.innerHTML = '<div class="dim">无调试会话 — 点上方「SWD 调试」启动（自动烧录 + 断点）</div>';
      return;
    }
    let html = '<div class="kv"><span>会话</span><span class="mono">' + escapeHtml(d.sessionName || '-') + '</span></div>';
    html += '<div class="kv"><span>PC</span><span class="mono">' + escapeHtml(d.pc || '-') + '</span></div>';
    if (d.frames && d.frames.length) {
      html += '<div class="sec">调用栈</div>';
      d.frames.slice(0, 5).forEach(f => {
        html += '<div class="kv"><span>' + escapeHtml(f.name) + (f.line ? ':' + f.line : '') + '</span><span class="mono">' + escapeHtml(f.pc || '') + '</span></div>';
      });
    }
    if (d.variables && d.variables.length) {
      html += '<div class="sec">变量</div>';
      d.variables.slice(0, 20).forEach(v => {
        html += '<div class="kv"><span>' + escapeHtml(v.name) + '</span><span class="mono">' + escapeHtml(v.value) + '</span></div>';
      });
    }
    if (d.error) html += '<div class="warn">' + escapeHtml(d.error) + '</div>';
    body.innerHTML = html;
  }
  function renderMemory(msg) {
    const body = document.getElementById('mem-body');
    if (!body) return;
    if (msg.error) { body.innerHTML = '<div class="warn">' + escapeHtml(msg.error) + '</div>'; return; }
    const bytes = [];
    const hex = msg.hex || '';
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    const base = parseInt(msg.address, 16) || 0;
    let html = '';
    for (let row = 0; row < bytes.length; row += 16) {
      let hexPart = '', ascii = '';
      for (let i = 0; i < 16; i++) {
        if (row + i < bytes.length) {
          hexPart += bytes[row + i].toString(16).padStart(2, '0') + ' ';
          const ch = bytes[row + i];
          ascii += (ch >= 0x20 && ch <= 0x7e) ? String.fromCharCode(ch) : '.';
        } else { hexPart += '   '; }
      }
      html += '<div class="mono memrow"><span class="addr">' + (base + row).toString(16).padStart(8, '0') + '</span> ' + hexPart + ' <span class="ascii">' + escapeHtml(ascii) + '</span></div>';
    }
    body.innerHTML = html || '<div class="dim">（空）</div>';
  }
  function renderRegisters(msg) {
    const body = document.getElementById('periph-body');
    if (!body) return;
    if (msg.error) { body.innerHTML = '<div class="warn">' + escapeHtml(msg.error) + '</div>'; return; }
    let html = '<div class="kv"><span>' + escapeHtml(msg.label || '') + '</span><span class="mono">' + escapeHtml(msg.base || '') + '</span></div>';
    (msg.rows || []).forEach(r => {
      html += '<div class="kv"><span class="mono">' + escapeHtml(r.name) + ' <span class="dim">' + escapeHtml(r.offset) + '</span></span><span class="mono">' + escapeHtml(r.value) + '</span></div>';
      (r.fields || []).forEach(f => {
        html += '<div class="kv field"><span>└ ' + escapeHtml(f.name) + '</span><span class="mono">' + escapeHtml(f.value) + '</span></div>';
      });
      if (r.note) html += '<div class="kv field"><span class="dim">└ ' + escapeHtml(r.note) + '</span><span></span></div>';
    });
    body.innerHTML = html || '<div class="dim">（空）</div>';
  }
  `;
}

async function buildDashboardHtml(): Promise<string> {
  const cfg = getConfig();
  const state = await gatherDashState();
  const root = getWorkspaceRoot() ?? '未打开工作区';
  const logHtml = state.logs.map(esc).join('<br>') || '（暂无日志）';
  // 家族参数化：外设下拉 / 内存预设随 family profile 生成
  const periphOptions = peripheralMap()
    .map(p => `<option value="${p.key}">${p.label}</option>`)
    .join('');
  const findPeriph = (key: string) => peripheralMap().find(p => p.key === key);
  const hexAddr = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');
  const sysctrl = findPeriph('sysctrl');
  const gpioa = findPeriph('gpioa');
  const uart1 = findPeriph('uart1');
  const memPresets = [
    `<option value="${cfg.family.ramBase.replace('0x', '')}">SRAM ${cfg.family.ramBase}</option>`,
    `<option value="00000000">FLASH/向量表 0x0</option>`,
    sysctrl ? `<option value="${hexAddr(sysctrl.base)}">SYSCTRL 0x${hexAddr(sysctrl.base)}</option>` : '',
    gpioa ? `<option value="${hexAddr(gpioa.base)}">GPIOA 0x${hexAddr(gpioa.base)}</option>` : '',
    uart1 ? `<option value="${hexAddr(uart1.base)}">UART1 0x${hexAddr(uart1.base)}</option>` : '',
    `<option value="E000E000">SysTick 0xE000E000</option>`,
    `<option value="custom">自定义…</option>`
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  :root {
    --bg:#070707; --gold:#d4a549; --gold-soft:#f3d78c; --red:#ff4a4a; --red-soft:#ff7d7d;
    --green:#5ad46a; --text:#f3efe8; --muted:#c7b07f; --line:rgba(212,165,73,0.30);
  }
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; background:linear-gradient(180deg,#070707,#100d0a); color:var(--text); font-family:'Segoe UI',sans-serif; font-size:13px; }
  body { padding:14px; }
  .console { border-radius:14px; overflow:hidden; border:1px solid var(--line); background:linear-gradient(180deg,rgba(15,15,15,0.98),rgba(22,18,14,0.98)); }
  .topbar { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); }
  .brand { display:flex; align-items:center; gap:10px; letter-spacing:0.22em; text-transform:uppercase; font-size:10px; color:var(--gold-soft); font-weight:700; }
  .brand .chip-sub { color:var(--muted); font-weight:400; letter-spacing:0.08em; }
  .brand-dot { width:10px; height:10px; border-radius:50%; background:var(--green); box-shadow:0 0 10px var(--green); }
  .status-pill { padding:6px 10px; border-radius:999px; border:1px solid var(--line); letter-spacing:0.12em; text-transform:uppercase; font-size:9px; }
  .pill-ok { color:var(--green); border-color:rgba(90,212,106,0.5); background:rgba(90,212,106,0.08); }
  .pill-warn { color:var(--gold-soft); border-color:var(--line); background:rgba(212,165,73,0.08); }
  .pill-off { color:var(--red-soft); border-color:rgba(255,74,74,0.45); background:rgba(255,74,74,0.08); }
  .content { padding:16px; }
  .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:14px; }
  .metric { border-radius:10px; padding:10px 12px; border:1px solid var(--line); background:rgba(22,18,13,0.98); }
  .metric-label { color:var(--muted); font-size:9px; letter-spacing:0.14em; text-transform:uppercase; margin-bottom:8px; }
  .metric-value { font-size:12px; color:var(--gold-soft); font-weight:700; word-break:break-all; }
  .flow { display:flex; align-items:stretch; gap:10px; flex-wrap:wrap; }
  .stage { flex:1 1 200px; min-width:190px; border-radius:12px; padding:16px; border:1px solid var(--line); background:rgba(25,20,14,0.98); cursor:pointer; transition:transform .15s ease, border-color .15s ease, box-shadow .15s ease; position:relative; }
  .stage:hover { border-color:rgba(255,74,74,0.45); transform:translateY(-2px); box-shadow:0 6px 18px rgba(0,0,0,0.45); }
  .stage-num { position:absolute; top:10px; right:14px; font-size:24px; font-weight:800; color:rgba(212,165,73,0.28); font-family:Georgia,serif; }
  .stage-tag { color:var(--gold-soft); letter-spacing:0.16em; text-transform:uppercase; font-size:9px; margin-bottom:8px; }
  .stage-title { font-size:18px; font-weight:700; margin-bottom:6px; }
  .stage-line { color:var(--muted); font-size:10px; line-height:1.6; word-break:break-all; margin-bottom:10px; }
  .sub-links { display:flex; gap:6px; flex-wrap:wrap; }
  .sub-link { background:rgba(212,165,73,0.08); color:var(--gold-soft); border:1px solid var(--line); border-radius:4px; padding:3px 9px; cursor:pointer; font-size:10px; letter-spacing:0.08em; }
  .sub-link:hover { box-shadow:0 0 8px rgba(212,165,73,0.35); border-color:var(--gold); }
  .sub-link.danger { color:var(--red-soft); border-color:rgba(255,74,74,0.45); background:rgba(255,74,74,0.07); }
  .sub-link.danger:hover { border-color:var(--red); box-shadow:0 0 8px rgba(255,74,74,0.4); }
  .flow-arrow { align-self:center; color:rgba(212,165,73,0.5); font-size:18px; font-weight:700; }
  .metric { cursor:pointer; transition:border-color .15s ease; }
  .metric:hover { border-color:var(--gold); }
  .metric[data-command]:hover .metric-label { color:var(--gold-soft); }
  .srcbar { display:flex; align-items:center; gap:10px; border:1px solid var(--line); border-radius:10px; padding:8px 12px; background:rgba(22,18,13,0.98); margin-bottom:14px; flex-wrap:wrap; }
  .srcbar-label { color:var(--muted); font-size:9px; letter-spacing:0.14em; text-transform:uppercase; }
  .srcbar-path { flex:1 1 240px; min-width:200px; font-size:11px; color:var(--gold-soft); word-break:break-all; }
  .srcbar-badge { font-size:9px; letter-spacing:0.12em; color:var(--gold); border:1px solid var(--gold); border-radius:3px; padding:1px 6px; }
  .srcbar-badge.dim-badge { color:var(--muted); border-color:var(--line); }
  .mono { font-family:Consolas,monospace; color:var(--gold-soft); }
  .panes { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px; }
  @media (max-width:800px){ .panes { grid-template-columns:1fr; } }
  .pane { border:1px solid var(--line); border-radius:10px; background:rgba(12,12,12,0.9); overflow:hidden; }
  .pane-head { padding:8px 12px; border-bottom:1px solid var(--line); color:var(--gold-soft); letter-spacing:0.12em; text-transform:uppercase; font-size:9px; display:flex; justify-content:space-between; align-items:center; }
  .pane-body { padding:10px 12px; font-size:11px; line-height:1.8; max-height:260px; overflow:auto; }
  .kv { display:flex; justify-content:space-between; gap:8px; border-bottom:1px solid rgba(212,165,73,0.12); padding:3px 0; }
  .kv.field { padding-left:14px; border-bottom:none; opacity:0.82; }
  .kv:last-child { border-bottom:none; }
  .sec { margin-top:8px; color:var(--muted); font-size:9px; letter-spacing:0.14em; text-transform:uppercase; }
  .dim { color:var(--muted); }
  .warn { color:var(--red-soft); margin-top:6px; }
  .memrow { white-space:pre; }
  .memrow .addr { color:var(--muted); }
  .memrow .ascii { color:var(--gold-soft); }
  .mem-controls { display:flex; gap:6px; align-items:center; }
  .mem-controls input { background:rgba(0,0,0,0.6); border:1px solid var(--line); color:var(--gold-soft); font-family:Consolas,monospace; font-size:11px; padding:3px 6px; border-radius:4px; width:110px; }
  .mem-controls select { background:rgba(0,0,0,0.6); border:1px solid var(--line); color:var(--text); font-size:11px; padding:3px; border-radius:4px; }
  .mini-btn { background:rgba(255,74,74,0.1); color:var(--red-soft); border:1px solid var(--line); border-radius:4px; padding:3px 8px; cursor:pointer; font-size:10px; letter-spacing:0.1em; text-transform:uppercase; }
  .mini-btn:hover { box-shadow:0 0 8px rgba(212,165,73,0.3); }
  .console-log { margin-top:14px; border:1px solid var(--line); border-radius:10px; background:rgba(10,10,10,0.88); overflow:hidden; }
  .console-body { font-family:Consolas,monospace; font-size:11px; line-height:1.7; padding:12px; color:#d9d2c5; word-break:break-all; max-height:180px; overflow:auto; }
  .footer { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-top:12px; padding-top:10px; border-top:1px solid var(--line); color:var(--muted); font-size:10px; }
  .api-note { color:var(--muted); font-size:10px; line-height:1.7; }
  .api-note code { color:var(--gold-soft); font-family:Consolas,monospace; background:rgba(212,165,73,0.08); padding:1px 4px; border-radius:3px; }
  .cmd-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:3px; }
  .cmd-row code { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
</style>
</head>
<body>
  <div class="console">
    <div class="topbar">
      <div class="brand"><span class="brand-dot"></span><span>${esc(cfg.family.label)}</span><span class="chip-sub">${esc(cfg.chip)}</span></div>
      <div class="status-pill ${state.statusClass}" id="status-pill">${esc(state.statusText)}</div>
    </div>
    <div class="content">
      <div class="metrics">
        <div class="metric" data-command="cw32l012.checkStatus" title="点击：深度检测 probe / MCU 状态"><div class="metric-label">Probe ↯</div><div class="metric-value" id="m-probe">${esc(state.probe)}</div></div>
        <div class="metric" data-command="cw32l012.reset" title="点击：复位目标（probe-rs reset）"><div class="metric-label">MCU ↯</div><div class="metric-value" id="m-mcu">${esc(state.mcu)}</div></div>
        <div class="metric" data-command="cw32l012.detectChip" title="点击：cw32-detect 读出厂数字签名识别芯片（会先结束调试会话独占探针）"><div class="metric-label">Chip ↯</div><div class="metric-value" id="m-chip">${esc(state.detected || state.chip)}</div></div>
        <div class="metric" data-command="cw32l012.selectArtifact" title="点击：指定烧录产物（默认自动选最新）"><div class="metric-label">Firmware ↯</div><div class="metric-value" id="m-fw">${esc(state.firmware)}</div></div>
        <div class="metric" data-command="cw32l012.monitor" title="点击：打开 / 切换串口"><div class="metric-label">Serial ↯</div><div class="metric-value" id="m-serial">${state.serialOpen ? esc(state.serialPath ?? '') + ' @ ' + state.serialBaud : 'CLOSED'}</div></div>
        <div class="metric" data-command="cw32l012.apiToggle" title="点击：启停 Agent API"><div class="metric-label">Agent API ↯</div><div class="metric-value" id="m-api">${state.apiRunning ? 'RUNNING :' + state.apiPort : 'STOPPED'}</div></div>
        <div class="metric" data-command="cw32l012.mcpToggle" title="点击：启停 MCP 服务"><div class="metric-label">MCP ↯</div><div class="metric-value" id="m-mcp">${mcpPortActive ? ':' + mcpPortActive : 'OFF'}</div></div>
      </div>

      <div class="srcbar">
        <span class="srcbar-label">源目录</span>
        <span class="srcbar-path mono" id="srcbar-path">${esc(state.sourceDir)}</span>
        <span class="srcbar-badge${state.sourceDirOverride ? '' : ' dim-badge'}" id="srcbar-badge">${state.sourceDirOverride ? '手动' : '自动'}</span>
        <span class="sub-link" data-command="cw32l012.setSourceDir" title="输入路径切换源码目录（留空恢复自动探测）">切换</span>
      </div>

      <div class="flow">
        <div class="stage" data-command="cw32l012.build" title="构建固件（先清理后 cargo build）">
          <div class="stage-num">1</div>
          <div class="stage-tag">Build</div>
          <div class="stage-title">构建</div>
          <div class="stage-line mono">cargo build（自动清理）<br>${esc(describeSelectedExample())}</div>
          <div class="sub-links">
            <span class="sub-link" data-command="cw32l012.clean" title="仅清理构建产物">清理</span>
            <span class="sub-link" data-command="cw32l012.selectExample" title="切换例程 / 目标">换例程</span>
          </div>
        </div>
        <div class="flow-arrow">→</div>
        <div class="stage" data-command="cw32l012.flash" title="烧录（自动选有效产物）">
          <div class="stage-num">2</div>
          <div class="stage-tag">Flash</div>
          <div class="stage-title">烧录</div>
          <div class="stage-line mono">probe-rs download<br>自动选有效产物</div>
          <div class="sub-links">
            <span class="sub-link" data-command="cw32l012.debug" title="烧录 + 断点 + 实时视图（含烧录，无需先点烧录）">SWD 调试</span>
            <span class="sub-link danger" data-command="cw32l012.eraseAll" title="擦除整片 Flash（危险，会二次确认）">擦除芯片</span>
          </div>
        </div>
        <div class="flow-arrow">→</div>
        <div class="stage" data-command="cw32l012.monitor" title="打开串口监视器">
          <div class="stage-num">3</div>
          <div class="stage-tag">Monitor</div>
          <div class="stage-title">监视</div>
          <div class="stage-line">串口收发（COM 口 + 波特率）<br>寄存器 / 内存视图见下方面板</div>
          <div class="sub-links">
            <span class="sub-link" data-command="cw32l012.serialSend" title="向已打开串口发送一行">发送一行</span>
          </div>
        </div>
      </div>

      <div class="panes">
        <div class="pane">
          <div class="pane-head">
            <span>可视化调试</span>
            <span>
              <button class="mini-btn" data-command="cw32l012.debugPause">暂停</button>
              <button class="mini-btn" data-command="cw32l012.debugResume">继续</button>
              <button class="mini-btn" data-command="cw32l012.debugStepOver" title="步过 next">步过</button>
              <button class="mini-btn" data-command="cw32l012.debugStepInto" title="步入 stepIn">步入</button>
              <button class="mini-btn" data-command="cw32l012.debugStepOut" title="步出 stepOut">步出</button>
              <button class="mini-btn" data-command="cw32l012.debugRestart" title="复位并重新运行">复位</button>
              <button class="mini-btn" data-command="cw32l012.debugStop">停止</button>
            </span>
          </div>
          <div class="pane-body" id="debug-body"><div class="dim">无调试会话 — 点「② 烧录」卡内 SWD 调试 启动（自动烧录 + 断点）</div></div>
        </div>
        <div class="pane">
          <div class="pane-head">
            <span>外设寄存器（位段解码 · ${esc(cfg.family.label)}）</span>
            <span class="mem-controls">
              <select id="periph-select">
                ${periphOptions}
              </select>
              <button class="mini-btn" id="periph-read">读取</button>
            </span>
          </div>
          <div class="pane-body" id="periph-body"><div class="dim">选择外设后点读取（有调试会话走 DAP，无会话走 probe-rs CLI）。偏移与位段取自 ${esc(cfg.family.label)} 寄存器表</div></div>
        </div>
      </div>

      <div class="panes">
        <div class="pane">
          <div class="pane-head">
            <span>内存视图</span>
            <span class="mem-controls">
              <select id="mem-preset" title="内存区预设">
                ${memPresets}
              </select>
              <input id="mem-addr" placeholder="${cfg.family.ramBase.replace('0x', '')}" value="${cfg.family.ramBase.replace('0x', '')}" />
              <select id="mem-len"><option>32</option><option selected>64</option><option>128</option><option>256</option></select>
              <button class="mini-btn" id="mem-read">读取</button>
              <span style="margin-left:8px"></span>
              <input id="mem-write-hex" placeholder="写入hex如 00112233" style="width:130px" />
              <button class="mini-btn" id="mem-write-btn" title="向 mem-addr 地址写入（4字节对齐，需调试会话）">写入</button>
            </span>
          </div>
          <div class="pane-body" id="mem-body"><div class="dim">选预设或输入地址（十六进制，无 0x 前缀）后点读取。SRAM=20000000, 向量表=00000000</div></div>
        </div>
      </div>

      <div class="console-log">
        <div class="console-head">System log</div>
        <div class="console-body" id="syslog">${logHtml}</div>
      </div>

      <div class="panes">
        <div class="pane">
          <div class="pane-head"><span>Agent API（AI 直连）</span><span class="mono">API ${state.apiRunning ? 'ON :' + state.apiPort : 'OFF'} · MCP ${mcpPortActive ? 'ON :' + mcpPortActive : 'OFF'}</span></div>
          <div class="pane-body api-note">
            本机 HTTP JSON 接口，Agent / 脚本可直接调用：<br>
            <div class="cmd-row"><code>curl http://127.0.0.1:${cfg.apiPort}/api/status?deep=1</code><button class="mini-btn" data-copy="curl http://127.0.0.1:${cfg.apiPort}/api/status?deep=1">复制</button></div>
            <div class="cmd-row"><code>curl -X POST http://127.0.0.1:${cfg.apiPort}/api/build</code><button class="mini-btn" data-copy="curl -X POST http://127.0.0.1:${cfg.apiPort}/api/build">复制</button></div>
            <div class="cmd-row"><code>curl -X POST http://127.0.0.1:${cfg.apiPort}/api/flash</code><button class="mini-btn" data-copy="curl -X POST http://127.0.0.1:${cfg.apiPort}/api/flash">复制</button></div>
            <div class="cmd-row"><code>curl "http://127.0.0.1:${cfg.apiPort}/api/memory?address=20000000&amp;length=64"</code><button class="mini-btn" data-copy="curl &quot;http://127.0.0.1:${cfg.apiPort}/api/memory?address=20000000&amp;length=64&quot;">复制</button></div>
            <div class="cmd-row"><code>curl http://127.0.0.1:${cfg.apiPort}/api/debug/state</code><button class="mini-btn" data-copy="curl http://127.0.0.1:${cfg.apiPort}/api/debug/state">复制</button></div>
            <div class="cmd-row"><code>curl http://127.0.0.1:${cfg.apiPort}/api/serial/tail</code><button class="mini-btn" data-copy="curl http://127.0.0.1:${cfg.apiPort}/api/serial/tail">复制</button></div>
            <div class="cmd-row"><code>curl "http://127.0.0.1:${cfg.apiPort}/api/detect?apply=1"</code><button class="mini-btn" data-copy="curl &quot;http://127.0.0.1:${cfg.apiPort}/api/detect?apply=1&quot;">复制</button></div>
            MCP(SSE) 接入: <code>http://127.0.0.1:${cfg.mcpPort}/sse</code>（19 个工具） <button class="mini-btn" data-command="cw32l012.generateMcpJson">生成 .mcp.json</button><br>
            全部端点: <code>GET /</code> ；鉴权: <code>x-cw32-token</code> 头（设置了 cw32l012.apiToken 时）
          </div>
        </div>
        <div class="pane">
          <div class="pane-head"><span>串口监视</span><span class="mono">${serialPort ? esc(serialPath ?? '') + ' @ ' + serialBaud : 'CLOSED'}</span></div>
          <div class="pane-body" id="serial-body"><div class="dim">未打开串口 — 点状态条 Serial 或「③ 监视」选择 COM 口与波特率（内置 serialport，收发一体）。</div></div>
        </div>
      </div>

      <div class="footer">
        <span>Target: <span class="mono">${esc(cfg.target)}</span></span>
        <span>Chip: <span class="mono">${esc(cfg.chip)}</span></span>
        <span>Path: <span class="mono">${esc(root)}</span></span>
      </div>
    </div>
  </div>
  <script>${dashboardScript()}</script>
</body>
</html>`;
}

async function updateDashboardView(): Promise<void> {
  try {
    const html = await buildDashboardHtml();
    if (dashboardView) dashboardView.webview.html = html;
    if (dashboardPanel) dashboardPanel.webview.html = html;
  } catch { /* 仪表盘刷新失败不影响主流程 */ }
}

async function showDashboard(): Promise<void> {
  const html = await buildDashboardHtml();
  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.One, true);
    dashboardPanel.webview.html = html;
    return;
  }
  dashboardPanel = vscode.window.createWebviewPanel('cw32l012.dashboard', DASHBOARD_TITLE, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });
  dashboardPanel.webview.html = html;
  dashboardPanel.onDidDispose(() => { dashboardPanel = undefined; });
  dashboardPanel.webview.onDidReceiveMessage(handleWebviewMessage);
}

async function handleWebviewMessage(message: { command?: string; address?: string; length?: number; text?: string; url?: string }): Promise<void> {
  const command = message.command;
  if (!command) return;
  switch (command) {
    case 'cw32l012.build': await humanLease('build', runBuild); break;
    case 'cw32l012.rebuild': await humanLease('rebuild', runRebuild); break;
    case 'cw32l012.clean': await humanLease('clean', runClean); break;
    case 'cw32l012.flash': await humanLease('flash', runFlash); break;
    case 'cw32l012.selectArtifact': await humanLease('选择固件并烧录', selectArtifact); break;
    case 'cw32l012.selectExample': await humanLease('选择例程', selectExample); break;
    case 'cw32l012.setSourceDir': await humanLease('切换源目录', setSourceDir); break;
    case 'cw32l012.eraseAll': await humanLease('全片擦除', eraseAll); break;
    case 'cw32l012.reset': await humanLease('reset', resetTarget); break;
    case 'cw32l012.checkStatus': await checkStatus(); break;
    case 'cw32l012.detectChip': await humanLease('芯片识别', runChipDetect); await updateDashboardView(); break;
    case 'cw32l012.generateMcpJson': await generateMcpJson(); break;
    case 'cw32l012.monitor': await humanLease('串口监视', openSerialMonitor); break;
    case 'cw32l012.serialSend': await serialSendLine(); break;
    case 'cw32l012.debug': await humanLease('启动调试', startDebugSession); break;
    case 'copyText': {
      const text = typeof (message as { text?: string }).text === 'string' ? (message as { text?: string }).text! : '';
      if (text) {
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('已复制到剪贴板。');
      }
      break;
    }
    case 'openExternal': {
      const url = typeof (message as { url?: string }).url === 'string' ? (message as { url?: string }).url! : '';
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
      break;
    }
    case 'cw32l012.debugPause': await humanLease('调试-暂停', () => debugControl('pause')); break;
    case 'cw32l012.debugResume': await humanLease('调试-继续', () => debugControl('continue')); break;
    case 'cw32l012.debugStepOver': await humanLease('调试-步过', () => debugControl('next')); break;
    case 'cw32l012.debugStepInto': await humanLease('调试-步入', () => debugControl('stepIn')); break;
    case 'cw32l012.debugStepOut': await humanLease('调试-步出', () => debugControl('stepOut')); break;
    case 'cw32l012.debugRestart': await humanLease('调试-复位重跑', () => debugControl('restart')); break;
    case 'cw32l012.debugStop':
      if (debugSession) { await vscode.debug.stopDebugging(debugSession); }
      break;
    case 'cw32l012.aiSummary': await collectDiagnostics(); break;
    case 'cw32l012.showDashboard': await showDashboard(); break;
    case 'cw32l012.apiToggle':
      await (apiServer ? stopApiServer() : startApiServer());
      break;
    case 'cw32l012.mcpToggle':
      await (mcpServer ? Promise.resolve(stopMcpServer()) : startMcpServer());
      break;
    case 'readMemory': {
      const addrNum = parseHexNumber(message.address, 0x20000000);
      const length = Math.max(1, Math.min(256, message.length ?? 64));
      const addrHex = `0x${addrNum.toString(16)}`;
      const b64 = debugSession ? await readMemoryViaDap(addrHex, length) : undefined;
      let payload: Record<string, unknown>;
      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        payload = { type: 'memory', address: addrHex, hex: buf.toString('hex') };
      } else {
        const buf = await readMemoryViaCli(addrHex, length);
        payload = buf ? { type: 'memory', address: addrHex, hex: buf.toString('hex') } : { type: 'memory', error: '读取失败：无调试会话且 CLI 读取失败（MCU 未连接？）' };
      }
      dashboardPanel?.webview.postMessage(payload);
      dashboardView?.webview.postMessage(payload);
      break;
    }
    case 'writeMemory': {
      const m = message as { address?: string; hex?: string };
      const addrNum = parseHexNumber(m.address, NaN);
      if (Number.isNaN(addrNum) || !m.hex || !/^[0-9a-fA-F]*$/.test(m.hex)) {
        const err = { type: 'memoryWrite', error: '参数不合法（地址十六进制 + 偶数位 hex 字节串，如 00112233）' };
        dashboardPanel?.webview.postMessage(err);
        dashboardView?.webview.postMessage(err);
        break;
      }
      const written = await writeMemoryViaDap(`0x${addrNum.toString(16)}`, m.hex);
      const payload: Record<string, unknown> = written > 0
        ? { type: 'memoryWrite', address: `0x${addrNum.toString(16)}`, bytesWritten: written }
        : { type: 'memoryWrite', error: '写入失败（需活动调试会话；地址 4 字节对齐）' };
      dashboardPanel?.webview.postMessage(payload);
      dashboardView?.webview.postMessage(payload);
      break;
    }
    case 'readRegisters': {
      const m = message as { peripheral?: string };
      const result = await readPeripheralRegisters((m.peripheral ?? 'sysctrl').toLowerCase());
      const payload: Record<string, unknown> = result.error
        ? { type: 'registers', error: result.error }
        : { type: 'registers', peripheral: result.peripheral.key, label: result.peripheral.label, base: `0x${result.peripheral.base.toString(16)}`, rows: result.rows };
      dashboardPanel?.webview.postMessage(payload);
      dashboardView?.webview.postMessage(payload);
      break;
    }
  }
}

/* ------------------------------------------------------------
 * 激活
 * ---------------------------------------------------------- */

class CwAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    // probe-rs dap-server：stdio 模式（省略 --port），single-session 随会话退出
    return new vscode.DebugAdapterExecutable('probe-rs', ['dap-server', '--single-session']);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  extVersion = String((context.extension.packageJSON as { version?: string })?.version ?? extVersion);
  logBoth(`[init] CW32L012 Tools v${extVersion} 已激活`);

  // 恢复上次选择的例程（按工作区持久化）
  const workspaceKey = getWorkspaceRoot() ?? 'default';
  const saved = context.workspaceState.get<string>(`${WORKSPACE_EXAMPLE_KEY}:${workspaceKey}`);
  if (saved) selectedExample = saved;
  else selectedExample = AUTO_EXAMPLE;

  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register('cw32l012.build', () => humanLease('build', runBuild));
  register('cw32l012.rebuild', () => humanLease('rebuild', runRebuild));
  register('cw32l012.clean', () => humanLease('clean', runClean));
  register('cw32l012.flash', () => humanLease('flash', runFlash));
  register('cw32l012.selectArtifact', () => humanLease('选择固件并烧录', selectArtifact));
  register('cw32l012.selectExample', () => humanLease('选择例程', selectExample));
  register('cw32l012.setSourceDir', () => humanLease('切换源目录', setSourceDir));
  register('cw32l012.eraseAll', () => humanLease('全片擦除', eraseAll));
  register('cw32l012.reset', () => humanLease('reset', resetTarget));
  register('cw32l012.checkStatus', () => humanLease('状态检测', checkStatus));
  register('cw32l012.monitor', () => humanLease('串口监视', openSerialMonitor));
  register('cw32l012.serialSend', serialSendLine);
  register('cw32l012.debug', () => humanLease('启动调试', startDebugSession));
  register('cw32l012.debugPause', () => humanLease('调试-暂停', () => debugControl('pause')));
  register('cw32l012.debugResume', () => humanLease('调试-继续', () => debugControl('continue')));
  register('cw32l012.debugStepOver', () => humanLease('调试-步过', () => debugControl('next')));
  register('cw32l012.debugStepInto', () => humanLease('调试-步入', () => debugControl('stepIn')));
  register('cw32l012.debugStepOut', () => humanLease('调试-步出', () => debugControl('stepOut')));
  register('cw32l012.debugRestart', () => humanLease('调试-复位重跑', debugRestart));
  register('cw32l012.debugStop', () => {
    if (debugSession) { void vscode.debug.stopDebugging(debugSession); }
    else { vscode.window.showWarningMessage('无活动调试会话。'); }
  });
  register('cw32l012.aiSummary', () => collectDiagnostics());
  register('cw32l012.showDashboard', showDashboard);
  register('cw32l012.detectChip', () => humanLease('芯片识别', runChipDetect));
  register('cw32l012.generateMcpJson', generateMcpJson);
  register('cw32l012.apiToggle', () => (apiServer ? stopApiServer() : startApiServer()));
  register('cw32l012.mcpToggle', () => (mcpServer ? Promise.resolve(stopMcpServer()) : startMcpServer()));
  register('cw32l012.apiStart', startApiServer);
  register('cw32l012.apiStop', stopApiServer);

  // 调试适配器（probe-rs dap-server）
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
      async resolveDebugConfiguration(_folder, config) {
        // 用户直接 F5（无 launch.json / 空配置）时，自动补全为「当前 ELF 产物」，
        // 对标 Keil 的「点一下就下载并调试」，不需要手写 launch.json。
        if (!config.type && !config.request && !config.name) {
          const root = getWorkspaceRoot();
          if (!root) {
            vscode.window.showWarningMessage('请先打开 CW32L012 工作区。');
            return undefined;
          }
          const artifact = await resolveArtifact(root);
          if (!artifact || artifact.kind !== 'elf') {
            vscode.window.showErrorMessage('调试需要有效 ELF 固件。请先 Build（这是 artifact 错误，不是 MCU 问题）。');
            return undefined;
          }
          const cfg = getConfig();
          const launch: vscode.DebugConfiguration = {
            type: DEBUG_TYPE,
            name: `${cfg.family.label} Debug`,
            request: 'launch',
            chip: cfg.chip,
            probe: cfg.probeId,
            protocol: cfg.protocol,
            chipDescriptionPath: cfg.chipDescriptionPath,
            allowEraseAll: true,
            flashingConfig: { flashingEnabled: true },
            coreConfigs: [{ coreIndex: 0, programBinary: artifact.filePath }],
            cwd: root
          } as vscode.DebugConfiguration;
          if (!cfg.chipDescriptionPath) {
            delete launch.chipDescriptionPath;
          }
          return launch;
        }
        return config;
      }
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new CwAdapterDescriptorFactory())
  );

  // 调试会话跟踪
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      if (session.type === DEBUG_TYPE) {
        debugSession = session;
        logBoth(`[debug] 会话开始: ${session.name}`);
        pushDebugState();
      }
    }),
    vscode.debug.onDidTerminateDebugSession(session => {
      if (session === debugSession) {
        debugSession = undefined;
        logBoth('[debug] 会话结束');
        pushDebugState();
      }
    }),
    vscode.debug.onDidChangeActiveDebugSession(session => {
      if (session?.type === DEBUG_TYPE) debugSession = session;
    })
  );

  const dashboardProvider = {
    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
      dashboardView = webviewView;
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = await buildDashboardHtml();
      webviewView.webview.onDidReceiveMessage(handleWebviewMessage);
    }
  };
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('cw32l012.dashboard', dashboardProvider));

  // 状态轮询：2s 常规状态，1s 调试数据（仅当会话存在）
  context.subscriptions.push(vscode.commands.registerCommand('cw32l012._noop', () => undefined));
  const stateTimer = setInterval(() => { void pushDashState(); }, 2000);
  const debugTimer = setInterval(() => { void pushDebugState(); }, 1000);
  const statusTimer = setInterval(() => { void refreshStatusBar(); }, 5000);
  context.subscriptions.push({ dispose: () => { clearInterval(stateTimer); clearInterval(debugTimer); clearInterval(statusTimer); } });
  context.subscriptions.push(ensureStatusBar());
  void refreshStatusBar();

  updateDashboardView();

  // cw32l012.* 配置变更 → 设置版本 +1（AI 乐观锁感知「人类恶作剧」）
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('cw32l012')) bumpSettingsEpoch('cw32l012.* 配置被修改');
  }));

  // API 自动启动
  if (getConfig().apiPort > 0 && vscode.workspace.getConfiguration('cw32l012').get<boolean>('apiAutoStart') !== false) {
    startApiServer().then(msg => vscode.window.showInformationMessage(msg)).catch(err =>
      logBoth(`[api] 启动失败: ${err instanceof Error ? err.message : err}`));
  }

  // MCP 服务器自动启动（Claude Code / 其他 MCP 客户端直连）
  if (getConfig().mcpAutoStart) {
    startMcpServer().then(msg => vscode.window.showInformationMessage(msg)).catch(err =>
      logBoth(`[mcp] 启动失败: ${err instanceof Error ? err.message : err}`));
  }

  vscode.window.showInformationMessage(`CW32L012 Tools v${extVersion} 就绪：Build → Flash → Debug；Agent API + MCP 见仪表盘。`);
}

export function deactivate(): void {
  closeSerial();
  if (dashboardPanel) dashboardPanel.dispose();
  dashboardView = undefined;
  if (statusBarItem) { statusBarItem.dispose(); statusBarItem = undefined; }
  if (apiServer) {
    apiServer.close();
    apiServer = undefined;
  }
  stopMcpServer();
}
