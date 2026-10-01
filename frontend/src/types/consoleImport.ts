/**
 * 控台配接包（Console Patch Package）：转场后由灯光控台导出的「现场事实」。
 *
 * 边界约定（与本地 Cue 表的编排决定严格分开）：
 * - 配接包只提供：灯具编号（uid + fixtureNo）、DMX 通道、各 Cue 的亮度与色温。
 * - 场次归属、Cue 提示语、触发方式与过渡时间永远由本地 Cue 表保留，配接包不覆盖。
 * - 灯具身份以控台稳定标识 uid 为准；重导同一个包沿用同一身份，绝不按通道号硬盖。
 */

/** 配接包里的一盏灯具（现场事实） */
export interface ConsoleFixture {
  /** 控台稳定身份标识，重导不随换号 / 换通道而变 */
  uid: string
  /** 灯具编号（控台灯号），可能与本地记录不一致，需对账 */
  fixtureNo: string
  /** 控台现场配接的 DMX 通道号 */
  channel: number
  /** 灯具型号，仅展示，不写入本地 */
  model?: string
}

/** 配接包里某条 Cue 下某盏灯的电平（现场事实） */
export interface ConsoleCueLevel {
  /** 对应 {@link ConsoleFixture.uid} */
  uid: string
  /** 亮度 0-100（%）；缺省表示控台未记录该电平 */
  intensity?: number | null
  /** 色温（K）；缺省表示控台未记录该电平 */
  colorTempK?: number | null
}

/** 配接包里的一条 Cue（仅含编号与电平事实，不含编排） */
export interface ConsoleCue {
  /** Cue 编号，形如 `Q12` / `Q12.5`，作为与本地 Cue 的对账键 */
  cueNo: string
  levels: ConsoleCueLevel[]
}

/** 控台配接包文件根结构 */
export interface ConsolePatchPackage {
  /** 包格式标识 */
  format: string
  /** 包格式版本 */
  version: number
  /** 包唯一标识（控台导出时生成），用于同一包重试去重 */
  packageId: string
  /** 控台 / 导出现场说明，仅展示 */
  consoleName?: string
  /** 导出时间 ISO 字符串 */
  exportedAt?: string
  fixtures: ConsoleFixture[]
  cues: ConsoleCue[]
}

/** 导入批次的处理状态 */
export type ImportBatchStatus = 'pending' | 'imported' | 'failed' | 'abandoned'

/** 灯具对账行的处置方式 */
export type FixtureMatchAction =
  /** 与现有本地灯具对应（沿用以 uid 建立的身份） */
  | 'existing'
  /** 包内新灯具：在本地新建配接 */
  | 'create'
  /** 暂不导入该灯具（保留现场记录但不写本地） */
  | 'skip'

/** 换号争议时选定的灯具编号来源 */
export type FixtureNoChoice = 'package' | 'local'

/** 通道争用 / 换通道时的通道值来源 */
export type ChannelChoice =
  /** 采用控台通道 */
  | 'package'
  /** 保留本地通道 */
  | 'local'
  /** 使用手填的空闲通道 */
  | 'custom'

/** 电平缺失时选定的处置 */
export type MissingLevelChoice =
  /** 保留本地现有电平，不覆盖 */
  | 'keepLocal'
  /** 以 0 亮度写入（关光） */
  | 'writeZero'
  /** 不写入该电平（与 keepLocal 的区别：本地无记录时保持无记录） */
  | 'skip'

/**
 * 灯具对账行：并列展示配接包与本地双方数据。
 * 换号、通道争用等争议在选定处置前绝不写入。
 */
export interface FixtureReconcileItem {
  /** 行内唯一标识（基于 uid） */
  itemId: string
  /** 控台稳定身份 */
  uid: string
  /** 配接包灯具数据（skip 时可为 null 以外恒存在） */
  pkg: ConsoleFixture
  /** 命中的本地灯具；新建 / 跳过场景为 null */
  localFixtureId: string | null
  /** 初始命中依据：身份映射 / 灯号 / 通道号 / 无命中 */
  matchedBy: 'identity' | 'fixtureNo' | 'channel' | 'none'

  action: FixtureMatchAction

  /** 双方灯具编号 */
  pkgFixtureNo: string
  localFixtureNo: string
  /** 换号争议：双方灯号不一致 */
  hasNoConflict: boolean
  fixtureNoChoice: FixtureNoChoice

  /** 双方通道号 */
  pkgChannel: number
  localChannel: number | null
  /** 换通道（双方通道不一致，且已确认对应） */
  hasChannelChange: boolean
  /** 通道争用：选定通道在本地被别的灯具占用 */
  hasChannelContention: boolean
  channelChoice: ChannelChoice
  /** channelChoice = custom 时手填的通道 */
  customChannel: number | null
  /** 当前争用该通道的其他本地灯具 id（展示双方数据用） */
  contenderIds: string[]

  /** 新建灯具的本地灯位（编排属性，包不提供） */
  createPosition: import('@/types/fixture').FixturePosition
  createFixtureType: import('@/types/fixture').FixtureType
  /** 该行是否已由用户选定（干净行自动为 true；换号 / 换通道 / 争用需显式确认） */
  decided: boolean
}

/** Cue 对账行：包内 Cue 与本地 Cue 按 cueNo 对账 */
export interface CueReconcileItem {
  cueNo: string
  normalizedCueNo: string
  /** 命中的本地 Cue id；未命中为 null */
  localCueId: string | null
  /** 包内该 Cue 的电平条数 */
  pkgLevelCount: number
  /** 未命中时是否在本地新建 Cue（false 表示跳过该 Cue 的电平） */
  createLocal: boolean
  /** 未命中时是否已由用户确认（新建 / 跳过二选一） */
  decided: boolean
}

/** 单格电平的争议类型 */
export type LevelIssueKind =
  /** 控台电平缺失（亮度或色温） */
  | 'missing'
  /** 双方数值不一致（默认采用控台，但列出双方供核对） */
  | 'mismatch'

/** 单字段（亮度 / 色温）的对账状态 */
export interface LevelFieldState {
  /** 控台值，缺省为 null */
  pkgValue: number | null
  /** 本地值，无记录为 null */
  localValue: number | null
  /** 控台是否缺失该字段 */
  missing: boolean
  /** 双方是否都有值且不一致 */
  mismatch: boolean
  /** 缺失时的处置（missing 才有意义） */
  missingChoice: MissingLevelChoice
  /** 该字段是否已由用户确认；缺失字段默认未确认，需先列双方数据再选定 */
  decided: boolean
}

/** 电平对账行：某条 Cue × 某盏灯 的亮度 / 色温双方面对面 */
export interface LevelReconcileItem {
  itemId: string
  uid: string
  localFixtureId: string | null
  normalizedCueNo: string
  localCueId: string | null
  /** 对应灯具行 */
  fixtureItemId: string
  intensity: LevelFieldState
  colorTemp: LevelFieldState
}

/** 本地有、但配接包未出现的灯具（仅列出，默认不动） */
export interface LocalOnlyFixture {
  fixtureId: string
  channel: number
  fixtureNo: string
  position: import('@/types/fixture').FixturePosition
  fixtureType: import('@/types/fixture').FixtureType
}

/** 控台灯具身份映射：uid ↔ 本地灯具，重导沿用同一身份 */
export interface FixtureIdentity {
  /** 主键 `${sessionId}::${uid}` */
  id: string
  sessionId: string
  uid: string
  fixtureId: string
  /** 最近一次见到的控台灯号，便于排查 */
  lastFixtureNo: string
  updatedAt: number
}

/** 导入批次：保留配接包原文与对账进度，失败可重试同一包且不重复生成记录 */
export interface ConsoleImportBatch {
  id: string
  /** 去重键，同一 session + packageId 唯一 */
  dedupeKey: string
  sessionId: string
  packageId: string
  /** 配接包原文（JSON 字符串），失败后仍保留 */
  rawPackage: string
  /** 解析后的规范化快照字段（冗余自包，便于列表展示） */
  consoleName: string
  exportedAt: string
  fixtureCount: number
  cueCount: number
  status: ImportBatchStatus
  /** 最近一次对账报告快照（结构化 JSON），用于断点续对 */
  report: SerializedReconcileReport | null
  /** 失败原因 / 备注 */
  lastError: string
  importedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 需要持久化的对账报告（决策部分），用于断点续对 */
export interface SerializedReconcileReport {
  fixtures: FixtureReconcileItem[]
  levels: LevelReconcileItem[]
  cues: CueReconcileItem[]
  localOnly: LocalOnlyFixture[]
}

/** 解析配接包的结果 */
export interface ParsePackageResult {
  ok: boolean
  message: string
  pkg: ConsolePatchPackage | null
}

/** 支持的配接包 format 标识 */
export const CONSOLE_PACKAGE_FORMAT = 'gbcuesheet/console-patch'
/** 支持的配接包版本 */
export const CONSOLE_PACKAGE_SUPPORTED_VERSIONS = [1] as const
