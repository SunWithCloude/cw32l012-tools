/* ------------------------------------------------------------
 * CW32 家族档案（family profile）：寄存器解码表 + 默认参数
 *
 * - cw32l012：偏移与位段取自 HAL 逐项核对过的寄存器表（原 extension.ts 内置表）
 * - cw32f030：取自 cw32-pac-gen 由官方 CMSIS 头生成的 PAC，与 UM 交叉核对；
 *   F030 的 SYSCTRL 基址(0x40010000)与 L012(0x40004000) 不同，GPIO 块距也不同
 * ------------------------------------------------------------ */

export interface RegField { name: string; msb: number; lsb: number; decode?: (v: number) => string; }
export interface RegDef { off: number; name: string; fields?: RegField[]; note?: string; }
export interface PeriphDef { key: string; label: string; base: number; span: number; regs: RegDef[]; }

export type FamilyKey = 'cw32l012' | 'cw32f030';

export interface FamilyProfile {
  key: FamilyKey;
  /** UI 显示名（状态栏/看板/诊断） */
  label: string;
  /** probe-rs --chip 默认值 */
  defaultChip: string;
  /** FLASH ORIGIN（memory.x） */
  flashBase: string;
  ramBase: string;
  /** probe-rs ≥0.32 是否内置该家族（内置则无需 chip-description） */
  builtinTarget: boolean;
  /** 非内置家族：插件捆绑的目标 yaml 文件名（tools/families/ 下） */
  bundledYaml?: string;
  peripherals: PeriphDef[];
}

/** 按 chip 名推断家族（cw32l012.family = auto 时的判定逻辑） */
export function familyFromChip(chip: string): FamilyKey {
  return /^CW32F030/i.test(chip.trim()) ? 'cw32f030' : 'cw32l012';
}

const binary16 = (v: number) => v.toString(2).padStart(16, '0');

/* ---------------- CW32L012 ---------------- */

const HSI_DIV_TABLE: Array<[number, string]> = [
  [0, '/32'], [1, '/1'], [2, '/2'], [3, '/3'], [4, '/4'], [5, '/5'], [6, '/6'], [7, '/7'],
  [8, '/8'], [9, '/9'], [10, '/10'], [11, '/12'], [12, '/16'], [13, '/20'], [14, '/24（复位默认）'], [15, '/28']
];

/** L012 GPIO 块内布局（GPIOA/B/C/F 同布局，块距 0x100） */
const GPIO_REGS_L012: RegDef[] = [
  { off: 0x00, name: 'DIR', fields: [{ name: 'pin0..15', msb: 15, lsb: 0, decode: binary16 }] },
  { off: 0x04, name: 'OPENDRAIN', fields: [{ name: 'pin0..15', msb: 15, lsb: 0, decode: binary16 }] },
  { off: 0x10, name: 'PUR', note: '上拉使能（无 PDR 下拉寄存器）' },
  { off: 0x14, name: 'AFRH', note: '复用 pin8..15，每脚 4bit' },
  { off: 0x18, name: 'AFRL', note: '复用 pin0..7，每脚 4bit' },
  { off: 0x1C, name: 'ANALOG' },
  { off: 0x34, name: 'ISR', note: '边沿中断状态' },
  { off: 0x50, name: 'IDR', fields: [{ name: 'pin0..15', msb: 15, lsb: 0, decode: binary16 }] },
  { off: 0x54, name: 'ODR', fields: [{ name: 'pin0..15', msb: 15, lsb: 0, decode: binary16 }] },
  { off: 0x58, name: 'BRR' },
  { off: 0x5C, name: 'BSRR' },
  { off: 0x60, name: 'TOG' }
];

const PERIPHERAL_MAP_L012: PeriphDef[] = [
  {
    key: 'sysctrl', label: 'SYSCTRL 时钟控制', base: 0x40004000, span: 0x48,
    regs: [
      { off: 0x00, name: 'CR0', fields: [
        { name: 'SYSCLKSRC', msb: 2, lsb: 0, decode: v => ['HSI', 'HSE', 'PLL', '?3', 'LSI?', 'LSE?', '?6', '?7'][v] ?? `?${v}` },
        { name: 'PCLKPRS', msb: 4, lsb: 3, decode: v => `/2^${v}` },
        { name: 'HCLKPRS', msb: 7, lsb: 5, decode: v => `/2^${v}` }
      ] },
      { off: 0x04, name: 'CR1' },
      { off: 0x08, name: 'CR2', fields: [{ name: 'FLASHWAIT', msb: 6, lsb: 4 }, { name: 'FETCH', msb: 7, lsb: 7 }, { name: 'CACHE', msb: 8, lsb: 8 }] },
      { off: 0x18, name: 'HSI', fields: [
        { name: 'TRIM', msb: 10, lsb: 0 },
        { name: 'DIV', msb: 14, lsb: 11, decode: v => (HSI_DIV_TABLE[v] ?? [-1, `?${v}`])[1] },
        { name: 'STABLE', msb: 15, lsb: 15, decode: v => v ? '已稳定' : '未稳定' }
      ] },
      { off: 0x24, name: 'LSE' },
      { off: 0x2C, name: 'DEBUG' },
      { off: 0x30, name: 'AHBEN', note: 'GPIO 端口时钟门控（0x5A5A 键保护写入）' },
      { off: 0x34, name: 'APBEN2' },
      { off: 0x38, name: 'APBEN1' },
      { off: 0x4C, name: 'RESETFLAG', note: '复位来源标志' }
    ]
  },
  { key: 'gpioa', label: 'GPIOA', base: 0x48000000, span: 0x64, regs: GPIO_REGS_L012 },
  { key: 'gpiob', label: 'GPIOB', base: 0x48000100, span: 0x64, regs: GPIO_REGS_L012 },
  { key: 'gpioc', label: 'GPIOC', base: 0x48000200, span: 0x64, regs: GPIO_REGS_L012, },
  { key: 'gpiof', label: 'GPIOF', base: 0x48000500, span: 0x64, regs: GPIO_REGS_L012 },
  {
    key: 'uart1', label: 'UART1', base: 0x40000C00, span: 0x40,
    regs: [
      { off: 0x00, name: 'CR1', fields: [
        { name: 'TXEN', msb: 0, lsb: 0, decode: v => v ? '发送开' : '发送关' },
        { name: 'RXEN', msb: 1, lsb: 1, decode: v => v ? '接收开' : '接收关' }
      ] },
      { off: 0x04, name: 'CR2', note: 'SOURCE 时钟源选择等' },
      { off: 0x08, name: 'IER' },
      { off: 0x0C, name: 'BRRI', note: '波特率整数分频' },
      { off: 0x10, name: 'BRRF', note: '波特率小数分频' },
      { off: 0x18, name: 'TIMCNT' },
      { off: 0x1C, name: 'ISR', note: '状态（含 ORE/NE/PE/FE/TXBE/RXNE）' },
      { off: 0x20, name: 'ICR' },
      { off: 0x24, name: 'RDR', note: '接收数据（读后清 RXNE）' },
      { off: 0x28, name: 'TDR' },
      { off: 0x30, name: 'ADDR' }, { off: 0x34, name: 'MASK' }, { off: 0x38, name: 'CR3' }
    ]
  }
];

/* ---------------- CW32F030 ----------------
 * 数据来源：官方 CMSIS 头 cw32f030{,rcc,uart,gpio}.h（经 cw32-pac-gen 生成 PAC，
 * 带编译期布局断言：SYSCTRL=120B、GPIO=100B、UART=56B，全部通过），PAC 与厂商头
 * 交叉核对无冲突；部分字段经实机调试验证（见文末待复核清单）。
 * 与 L012 的关键差异（调试易踩坑）：
 *  - F030 SYSCTRL 基址 0x40010000（L012 是 0x40004000）
 *  - F030 UART1 基址 0x40013800（AHB 区；L012 的 UART1 在 0x40000C00）
 *  - F030 GPIO 块距 0x400（L012 是 0x100），且多出 SPEED/PDR/DRIVER/中断使能组
 *  - F030 GPIO 有 PDR 下拉（L012 没有）
 *  - F030 SYSCTRL 的 CR0/CR1/CR2/IER 写入需 KEY=0x5A5A，但 AHBEN/APBENx 无 KEY
 *    （厂商库直接 |=；与 L012 的"全带 KEY"相反，写错会顶掉使能位） */

/** RCHF（HSI）预分频 decode 表：SYSCTRL_HSI.DIV[14:11] 原始编码 → 分频比。
 *  来源：cw32f030_rcc.h RCC_HSIOSC_DIVn（非线性编码，非 2^n）。
 *  0x0~0x4、0xA 保留。RCHF 输出 = 48MHz 振荡 / DIV。 */
const HSI_DIV_TABLE_F030: [number, string][] = [
  [0x5, '/6'], [0x6, '/1'], [0x7, '/3'], [0x8, '/2'], [0x9, '/4'], [0xB, '/8'],
  [0xC, '/10'], [0xD, '/12'], [0xE, '/14'], [0xF, '/16']
];

const hsiDivDecodeF030 = (v: number): string =>
  (HSI_DIV_TABLE_F030.find(([code]) => code === v) ?? [-1, `保留?${v}`])[1];

/** 0..15 每脚 1bit 的位域（DIR/OPENDRAIN/PDR/PUR/ANALOG/IDR/ODR/TOG/中断使能等） */
const pinBitsF030 = (name: string): RegField => ({ name, msb: 15, lsb: 0 });

const KEY_F030 = '写 KEY[31:16]=0x5A5A(SYSCTRL_BYPASS) 才能修改';

const SYSCTRL_REGS_F030: RegDef[] = [
  { off: 0x00, name: 'CR0', fields: [
    { name: 'SYSCLK', msb: 2, lsb: 0, decode: v => ['HSI(RCHF)', 'HSE', 'PLL', 'LSI', 'LSE', '?5', '?6', '?7'][v] ?? `?${v}` },
    { name: 'PCLKPRS', msb: 4, lsb: 3, decode: v => ['/1', '/2', '/4', '/8'][v] ?? `?${v}` },
    { name: 'HCLKPRS', msb: 7, lsb: 5, decode: v => ['/1', '/2', '/4', '/8', '/16', '/32', '/64', '/128'][v] ?? `?${v}` },
    { name: 'KEY', msb: 31, lsb: 16 }
  ], note: KEY_F030 },
  { off: 0x04, name: 'CR1', fields: [
    { name: 'HSIEN', msb: 0, lsb: 0, decode: v => v ? 'RCHF开' : '关' },
    { name: 'HSEEN', msb: 1, lsb: 1 }, { name: 'PLLEN', msb: 2, lsb: 2 },
    { name: 'LSIEN', msb: 3, lsb: 3 }, { name: 'LSEEN', msb: 4, lsb: 4 },
    { name: 'LSELOCK', msb: 5, lsb: 5 }, { name: 'LSECCS', msb: 6, lsb: 6 },
    { name: 'HSECCS', msb: 7, lsb: 7 }, { name: 'CLKCCS', msb: 8, lsb: 8, decode: v => v ? '切换失败保持原时钟' : '硬件自动切换' },
    { name: 'KEY', msb: 31, lsb: 16 }
  ], note: KEY_F030 },
  { off: 0x08, name: 'CR2', fields: [
    { name: 'SWDIO', msb: 1, lsb: 1 }, { name: 'LOCKUP', msb: 2, lsb: 2 },
    { name: 'WAKEUPCLK', msb: 3, lsb: 3 }, { name: 'KEY', msb: 31, lsb: 16 }
  ], note: KEY_F030 },
  { off: 0x0C, name: 'IER', fields: [
    { name: 'HSIRDY', msb: 0, lsb: 0 }, { name: 'HSERDY', msb: 1, lsb: 1 },
    { name: 'PLLRDY', msb: 2, lsb: 2 }, { name: 'LSIRDY', msb: 3, lsb: 3 },
    { name: 'LSERDY', msb: 4, lsb: 4 }, { name: 'LSEFAIL', msb: 5, lsb: 5 },
    { name: 'HSEFAIL', msb: 6, lsb: 6 }, { name: 'LSEFAULT', msb: 7, lsb: 7 },
    { name: 'HSEFAULT', msb: 8, lsb: 8 }, { name: 'KEY', msb: 31, lsb: 16 }
  ], note: KEY_F030 },
  { off: 0x10, name: 'ISR', fields: [
    { name: 'HSIRDY', msb: 0, lsb: 0 }, { name: 'HSERDY', msb: 1, lsb: 1 },
    { name: 'PLLRDY', msb: 2, lsb: 2 }, { name: 'LSIRDY', msb: 3, lsb: 3 },
    { name: 'LSERDY', msb: 4, lsb: 4 }, { name: 'LSEFAIL', msb: 5, lsb: 5 },
    { name: 'HSEFAIL', msb: 6, lsb: 6 }, { name: 'LSEFAULT', msb: 7, lsb: 7 },
    { name: 'HSEFAULT', msb: 8, lsb: 8 },
    { name: 'HSISTABLE', msb: 11, lsb: 11, decode: v => v ? 'RCHF已稳定' : 'RCHF未稳定' },
    { name: 'HSESTABLE', msb: 12, lsb: 12 }, { name: 'PLLSTABLE', msb: 13, lsb: 13 },
    { name: 'LSISTABLE', msb: 14, lsb: 14 }, { name: 'LSESTABLE', msb: 15, lsb: 15 }
  ], note: 'RO' },
  { off: 0x14, name: 'ICR', note: '写 1 清 IER 对应中断标志' },
  { off: 0x18, name: 'HSI', fields: [
    { name: 'TRIM', msb: 10, lsb: 0 },
    { name: 'DIV', msb: 14, lsb: 11, decode: hsiDivDecodeF030 },
    { name: 'STABLE', msb: 15, lsb: 15, decode: v => v ? '已稳定' : '未稳定' }
  ], note: 'RCHF 调谐/预分频；TRIM 出厂值从 0x12600 加载；此寄存器写入无需 KEY' },
  { off: 0x1C, name: 'HSE', fields: [
    { name: 'DRIVER', msb: 1, lsb: 0 }, { name: 'FREQRANGE', msb: 3, lsb: 2 },
    { name: 'WAITCYCLE', msb: 5, lsb: 4 }, { name: 'MODE', msb: 6, lsb: 6 },
    { name: 'FLT', msb: 7, lsb: 7 }, { name: 'DETCNT', msb: 18, lsb: 8 },
    { name: 'STABLE', msb: 19, lsb: 19 }
  ] },
  { off: 0x20, name: 'LSI', fields: [
    { name: 'TRIM', msb: 9, lsb: 0 }, { name: 'WAITCYCLE', msb: 11, lsb: 10 },
    { name: 'STABLE', msb: 15, lsb: 15 }
  ] },
  { off: 0x24, name: 'LSE', fields: [
    { name: 'DRIVER', msb: 1, lsb: 0 }, { name: 'AMP', msb: 3, lsb: 2 },
    { name: 'WAITCYCLE', msb: 5, lsb: 4 }, { name: 'MODE', msb: 6, lsb: 6 },
    { name: 'STABLE', msb: 15, lsb: 15 }
  ] },
  { off: 0x28, name: 'PLL', fields: [
    { name: 'SOURCE', msb: 1, lsb: 0, decode: v => ['HSE 晶振', 'HSE 输入时钟', '?2', 'HSI'][v] ?? `?${v}` },
    { name: 'FREQIN', msb: 3, lsb: 2, decode: v => ['≤6M', '6~12M', '12~20M', '20~24M'][v] ?? `?${v}` },
    { name: 'MUL', msb: 8, lsb: 4, decode: v => (v >= 2 && v <= 12) ? `×${v}` : `?${v}` },
    { name: 'FREQOUT', msb: 11, lsb: 9, decode: v => ['>12M', '>18M', '>24M', '>36M', '>48M', '?5', '?6', '?7'][v] ?? `?${v}` },
    { name: 'WAITCYCLE', msb: 14, lsb: 12 },
    { name: 'STABLE', msb: 15, lsb: 15, decode: v => v ? 'PLL已锁定' : '未锁定' }
  ], note: 'FREQIN/FREQOUT 为频率档位（厂商库按表自动算），MUL 合法 2..12' },
  { off: 0x2C, name: 'DEBUG', fields: [
    { name: 'ATIM', msb: 0, lsb: 0 }, { name: 'GTIM1', msb: 1, lsb: 1 },
    { name: 'GTIM2', msb: 2, lsb: 2 }, { name: 'GTIM3', msb: 3, lsb: 3 },
    { name: 'GTIM4', msb: 4, lsb: 4 }, { name: 'BTIM123', msb: 5, lsb: 5 },
    { name: 'AWT', msb: 6, lsb: 6 }, { name: 'RTC', msb: 8, lsb: 8 },
    { name: 'IWDT', msb: 9, lsb: 9 }, { name: 'WWDT', msb: 10, lsb: 10 }
  ], note: '调试模式下定时器继续运行' },
  { off: 0x30, name: 'AHBEN', fields: [
    { name: 'DMA', msb: 0, lsb: 0 }, { name: 'FLASH', msb: 1, lsb: 1 },
    { name: 'CRC', msb: 2, lsb: 2 }, { name: 'GPIOA', msb: 4, lsb: 4 },
    { name: 'GPIOB', msb: 5, lsb: 5 }, { name: 'GPIOC', msb: 6, lsb: 6 },
    { name: 'GPIOF', msb: 9, lsb: 9 }
  ], note: 'AHB 时钟门控；无 0x5A5A 键，厂商库直接 |=（与 L012 不同）。GPIO 用前必须置对应位' },
  { off: 0x34, name: 'APBEN2', fields: [
    { name: 'ADC', msb: 2, lsb: 2 }, { name: 'VC', msb: 4, lsb: 4 },
    { name: 'ATIM', msb: 7, lsb: 7 }, { name: 'SPI1', msb: 8, lsb: 8 },
    { name: 'UART1', msb: 9, lsb: 9 }, { name: 'GTIM3', msb: 10, lsb: 10 },
    { name: 'GTIM4', msb: 11, lsb: 11 }, { name: 'BTIM', msb: 12, lsb: 12 },
    { name: 'AWT', msb: 13, lsb: 13 }
  ], note: 'APB 时钟门控2；无 0x5A5A 键。UART1 门控 = bit9' },
  { off: 0x38, name: 'APBEN1', fields: [
    { name: 'GTIM1', msb: 1, lsb: 1 }, { name: 'GTIM2', msb: 2, lsb: 2 },
    { name: 'RTC', msb: 3, lsb: 3 }, { name: 'WWDT', msb: 4, lsb: 4 },
    { name: 'IWDT', msb: 5, lsb: 5 }, { name: 'SPI2', msb: 6, lsb: 6 },
    { name: 'UART2', msb: 7, lsb: 7 }, { name: 'UART3', msb: 8, lsb: 8 },
    { name: 'I2C1', msb: 11, lsb: 11 }, { name: 'I2C2', msb: 12, lsb: 12 }
  ], note: 'APB 时钟门控1；无 0x5A5A 键。UART2/3 门控 = bit7/8' },
  { off: 0x40, name: 'AHBRST', fields: [
    { name: 'DMA', msb: 0, lsb: 0 }, { name: 'FLASH', msb: 1, lsb: 1 },
    { name: 'CRC', msb: 2, lsb: 2 }, { name: 'GPIOA', msb: 4, lsb: 4 },
    { name: 'GPIOB', msb: 5, lsb: 5 }, { name: 'GPIOC', msb: 6, lsb: 6 },
    { name: 'GPIOF', msb: 9, lsb: 9 }
  ], note: '写 1 复位对应 AHB 外设（无 KEY）' },
  { off: 0x44, name: 'APBRST2', fields: [
    { name: 'ADC', msb: 2, lsb: 2 }, { name: 'VC', msb: 4, lsb: 4 },
    { name: 'ATIM', msb: 7, lsb: 7 }, { name: 'SPI1', msb: 8, lsb: 8 },
    { name: 'UART1', msb: 9, lsb: 9 }, { name: 'GTIM3', msb: 10, lsb: 10 },
    { name: 'GTIM4', msb: 11, lsb: 11 }, { name: 'BTIM', msb: 12, lsb: 12 },
    { name: 'AWT', msb: 13, lsb: 13 }
  ], note: '写 1 复位对应 APB 外设（无 KEY）' },
  { off: 0x48, name: 'APBRST1', fields: [
    { name: 'GTIM1', msb: 1, lsb: 1 }, { name: 'GTIM2', msb: 2, lsb: 2 },
    { name: 'RTC', msb: 3, lsb: 3 }, { name: 'WWDT', msb: 4, lsb: 4 },
    { name: 'IWDT', msb: 5, lsb: 5 }, { name: 'SPI2', msb: 6, lsb: 6 },
    { name: 'UART2', msb: 7, lsb: 7 }, { name: 'UART3', msb: 8, lsb: 8 },
    { name: 'I2C1', msb: 11, lsb: 11 }, { name: 'I2C2', msb: 12, lsb: 12 }
  ], note: '写 1 复位对应 APB 外设（无 KEY）' },
  { off: 0x4C, name: 'RESETFLAG', fields: [
    { name: 'POR', msb: 0, lsb: 0, decode: v => v ? '上电复位' : '' },
    { name: 'LVD', msb: 3, lsb: 3, decode: v => v ? '欠压复位' : '' },
    { name: 'IWDT', msb: 4, lsb: 4, decode: v => v ? 'IWDT复位' : '' },
    { name: 'WWDT', msb: 5, lsb: 5, decode: v => v ? 'WWDT复位' : '' },
    { name: 'RSTB', msb: 6, lsb: 6, decode: v => v ? '外部RSTB引脚' : '' },
    { name: 'LOCKUP', msb: 8, lsb: 8, decode: v => v ? '锁核复位' : '' },
    { name: 'SYSRESETREQ', msb: 9, lsb: 9, decode: v => v ? '软件NVIC复位' : '' }
  ], note: '复位来源标志（位=1 表示上次复位由该源产生）；写 1 清零；无 KEY' },
  { off: 0x50, name: 'GTIM1CAP', note: 'GTIM1 输入捕获源选择（CH1[2:0]/CH2[6:4]/CH3[10:8]/CH4[14:12]）' },
  { off: 0x54, name: 'GTIM2CAP', note: '同 GTIM1CAP' },
  { off: 0x58, name: 'GTIM3CAP', note: '同 GTIM1CAP' },
  { off: 0x5C, name: 'GTIM4CAP', note: '同 GTIM1CAP' },
  { off: 0x60, name: 'ATIMETR', fields: [ { name: 'ATIMETR', msb: 2, lsb: 0 } ] },
  { off: 0x64, name: 'GTIMETR', note: 'GTIM1..4 外部触发选择（各 3bit：0/6:4/10:8/14:12）' },
  { off: 0x6C, name: 'TIMITR', note: 'ATIM/GTIM/BTIM 内部触发互连选择' },
  { off: 0x70, name: 'MCO', fields: [
    { name: 'SOURCE', msb: 3, lsb: 0, decode: v => ['无输出', 'HCLK', 'PCLK', 'HSI', 'LSI', 'HSE', 'LSE', 'PLL', 'RC150K', 'RC10K'][v] ?? `?${v}` },
    { name: 'DIV', msb: 6, lsb: 4, decode: v => ['/1', '/2', '/8', '/64', '/128', '/256', '/512', '/1024'][v] ?? `?${v}` }
  ] },
  { off: 0x74, name: 'IRMOD', fields: [ { name: 'MOD', msb: 3, lsb: 0 } ], note: '红外调制极性/使能' }
];

const GPIO_REGS_F030: RegDef[] = [
  { off: 0x00, name: 'DIR', fields: [pinBitsF030('pin0..15')], note: '0=输入 1=输出' },
  { off: 0x04, name: 'OPENDRAIN', fields: [pinBitsF030('pin0..15')], note: '1=开漏' },
  { off: 0x08, name: 'SPEED', fields: [pinBitsF030('pin0..15')], note: '1=高速' },
  { off: 0x0C, name: 'PDR', fields: [pinBitsF030('pin0..15')], note: '下拉使能（F030 有 PDR，L012 没有！）' },
  { off: 0x10, name: 'PUR', fields: [pinBitsF030('pin0..15')], note: '上拉使能' },
  { off: 0x14, name: 'AFRH', fields: [
    { name: 'AFR8', msb: 3, lsb: 0 }, { name: 'AFR9', msb: 7, lsb: 4 },
    { name: 'AFR10', msb: 11, lsb: 8 }, { name: 'AFR11', msb: 15, lsb: 12 },
    { name: 'AFR12', msb: 19, lsb: 16 }, { name: 'AFR13', msb: 23, lsb: 20 },
    { name: 'AFR14', msb: 27, lsb: 24 }, { name: 'AFR15', msb: 31, lsb: 28 }
  ], note: '复用功能选择 pin8..15，每脚 4bit' },
  { off: 0x18, name: 'AFRL', fields: [
    { name: 'AFR0', msb: 3, lsb: 0 }, { name: 'AFR1', msb: 7, lsb: 4 },
    { name: 'AFR2', msb: 11, lsb: 8 }, { name: 'AFR3', msb: 15, lsb: 12 },
    { name: 'AFR4', msb: 19, lsb: 16 }, { name: 'AFR5', msb: 23, lsb: 20 },
    { name: 'AFR6', msb: 27, lsb: 24 }, { name: 'AFR7', msb: 31, lsb: 28 }
  ], note: '复用功能选择 pin0..7' },
  { off: 0x1C, name: 'ANALOG', fields: [pinBitsF030('pin0..15')], note: '1=模拟模式（数字输入缓冲断开）；GPIOA 复位默认 0x9fff（实机验证）' },
  { off: 0x20, name: 'DRIVER', fields: [pinBitsF030('pin0..15')], note: '驱动能力选择' },
  { off: 0x24, name: 'RISEIE', fields: [pinBitsF030('pin0..15')], note: '上升沿中断使能' },
  { off: 0x28, name: 'FALLIE', fields: [pinBitsF030('pin0..15')], note: '下降沿中断使能' },
  { off: 0x2C, name: 'HIGHIE', fields: [pinBitsF030('pin0..15')], note: '高电平中断使能' },
  { off: 0x30, name: 'LOWIE', fields: [pinBitsF030('pin0..15')], note: '低电平中断使能' },
  { off: 0x34, name: 'ISR', fields: [pinBitsF030('pin0..15')], note: 'RO 中断标志' },
  { off: 0x38, name: 'ICR', fields: [pinBitsF030('pin0..15')], note: '写 1 清中断标志' },
  { off: 0x3C, name: 'LOCK', note: '寄存器锁定' },
  { off: 0x40, name: 'FILTER', fields: [pinBitsF030('pin0..15')], note: '输入数字滤波使能' },
  { off: 0x50, name: 'IDR', fields: [{ name: 'pin0..15', msb: 15, lsb: 0, decode: binary16 }], note: '输入数据' },
  { off: 0x54, name: 'ODR', fields: [{ name: 'pin0..15', msb: 15, lsb: 0, decode: binary16 }], note: '输出数据' },
  { off: 0x58, name: 'BRR', fields: [pinBitsF030('pin0..15')], note: '写 1 清对应 ODR 位（置低）' },
  { off: 0x5C, name: 'BSRR', fields: [
    { name: 'BSS0..15', msb: 15, lsb: 0 }, { name: 'BRR0..15', msb: 31, lsb: 16 }
  ], note: '低 16 位写 1 置高，高 16 位写 1 置低（高半优先）' },
  { off: 0x60, name: 'TOG', fields: [pinBitsF030('pin0..15')], note: '写 1 翻转对应引脚' }
];

const UART_REGS_F030: RegDef[] = [
  { off: 0x00, name: 'CR1', fields: [
    { name: 'TXEN', msb: 0, lsb: 0, decode: v => v ? '发送开' : '发送关' },
    { name: 'RXEN', msb: 1, lsb: 1, decode: v => v ? '接收开' : '接收关' },
    { name: 'PARITY', msb: 3, lsb: 2, decode: v => ['无校验', '用户定义', '偶校验', '奇校验'][v] ?? `?${v}` },
    { name: 'STOP', msb: 5, lsb: 4, decode: v => ['1位', '1.5位', '2位', '?3'][v] ?? `?${v}` },
    { name: 'SYNC', msb: 6, lsb: 6 }, { name: 'START', msb: 8, lsb: 8, decode: v => v ? 'RXD低电平起始' : 'RXD下降沿起始' },
    { name: 'OVER', msb: 10, lsb: 9, decode: v => ['×16', '×8', '×4', '特殊'][v] ?? `?${v}` }
  ] },
  { off: 0x04, name: 'CR2', fields: [
    { name: 'ADDREN', msb: 0, lsb: 0 }, { name: 'SIGNAL', msb: 1, lsb: 1 },
    { name: 'CTSEN', msb: 2, lsb: 2 }, { name: 'RTSEN', msb: 3, lsb: 3 },
    { name: 'RXINV', msb: 4, lsb: 4 }, { name: 'TXINV', msb: 5, lsb: 5 },
    { name: 'DMARX', msb: 6, lsb: 6 }, { name: 'DMATX', msb: 7, lsb: 7 },
    { name: 'SOURCE', msb: 9, lsb: 8, decode: v => ['PCLK', 'LSE', '?2', 'LSI'][v] ?? `?${v}` }
  ], note: '硬件流控/极性反转/DMA/时钟源' },
  { off: 0x08, name: 'IER', fields: [
    { name: 'TXE', msb: 0, lsb: 0 }, { name: 'TC', msb: 1, lsb: 1 },
    { name: 'RC', msb: 2, lsb: 2 }, { name: 'FE', msb: 3, lsb: 3 },
    { name: 'PE', msb: 4, lsb: 4 }, { name: 'CTS', msb: 6, lsb: 6 }
  ] },
  { off: 0x0C, name: 'BRRI', fields: [ { name: 'BRRI', msb: 15, lsb: 0 } ], note: '波特率整数分频（16bit）' },
  { off: 0x10, name: 'BRRF', fields: [ { name: 'BRRF', msb: 3, lsb: 0 } ], note: '波特率小数分频（4bit，1/16 步进）' },
  { off: 0x1C, name: 'ISR', fields: [
    { name: 'TXE', msb: 0, lsb: 0, decode: v => v ? '发送空' : '' },
    { name: 'TC', msb: 1, lsb: 1, decode: v => v ? '发送完成' : '' },
    { name: 'RC', msb: 2, lsb: 2, decode: v => v ? '接收完成' : '' },
    { name: 'FE', msb: 3, lsb: 3 }, { name: 'PE', msb: 4, lsb: 4 },
    { name: 'MATCH', msb: 5, lsb: 5 }, { name: 'CTS', msb: 6, lsb: 6 },
    { name: 'CTSLV', msb: 7, lsb: 7 }, { name: 'TXBUSY', msb: 8, lsb: 8 }
  ], note: 'RO 状态' },
  { off: 0x20, name: 'ICR', fields: [
    { name: 'TC', msb: 1, lsb: 1 }, { name: 'RC', msb: 2, lsb: 2 },
    { name: 'FE', msb: 3, lsb: 3 }, { name: 'PE', msb: 4, lsb: 4 },
    { name: 'CTS', msb: 6, lsb: 6 }
  ], note: '写 1 清对应标志' },
  { off: 0x24, name: 'RDR', fields: [ { name: 'RDR', msb: 8, lsb: 0 } ], note: 'RO 接收数据' },
  { off: 0x28, name: 'TDR', fields: [ { name: 'TDR', msb: 8, lsb: 0 } ], note: 'WO 发送数据' },
  { off: 0x30, name: 'ADDR', fields: [ { name: 'ADDR', msb: 7, lsb: 0 } ], note: '多机地址' },
  { off: 0x34, name: 'MASK', fields: [ { name: 'MASK', msb: 7, lsb: 0 } ], note: '多机地址掩码' }
];

const PERIPHERAL_MAP_F030: PeriphDef[] = [
  { key: 'sysctrl', label: 'SYSCTRL 时钟控制', base: 0x40010000, span: 0x78, regs: SYSCTRL_REGS_F030 },
  { key: 'gpioa', label: 'GPIOA', base: 0x48000000, span: 0x64, regs: GPIO_REGS_F030 },
  { key: 'gpiob', label: 'GPIOB', base: 0x48000400, span: 0x64, regs: GPIO_REGS_F030 },
  // GPIOC@0x48000800 经实机回读确认（GPIO 块距 0x400）；GPIOF 地址未实测，暂不列入
  { key: 'gpioc', label: 'GPIOC', base: 0x48000800, span: 0x64, regs: GPIO_REGS_F030 },
  { key: 'uart1', label: 'UART1', base: 0x40013800, span: 0x38, regs: UART_REGS_F030 }
];

/* 待复核清单（提取自 PAC/厂商头交叉核对，全部一致；以下各项未能 100% 确认）：
 * 1. GPIOA ANALOG 复位默认 0x9fff 来自实机调试记录，未在手册重新核对；GPIOB 未验证。
 * 2. GPIO SPEED/DRIVER 档位语义、LOCK 键值序列、FILTER 时基未展开。
 * 3. SYSCTRL IRMOD.MOD 编码未核对（红外调制，极少用）。
 * 4. PLL FREQIN 档位边界由厂商库 freqInTable 反推，非手册原文。
 * 5. UART1 基址 0x40013800 由 PAC+厂商头双重确认，尚未实机回读校验。 */

export const FAMILIES: Record<FamilyKey, FamilyProfile> = {
  cw32l012: {
    key: 'cw32l012',
    label: 'CW32L012',
    defaultChip: 'CW32L012x8',
    flashBase: '0x00000000',
    ramBase: '0x20000000',
    builtinTarget: true,
    peripherals: PERIPHERAL_MAP_L012
  },
  cw32f030: {
    key: 'cw32f030',
    label: 'CW32F030',
    defaultChip: 'CW32F030C8',
    flashBase: '0x00000000',
    ramBase: '0x20000000',
    builtinTarget: false,
    bundledYaml: 'CW32F030_Series.yaml',
    peripherals: PERIPHERAL_MAP_F030
  }
};
