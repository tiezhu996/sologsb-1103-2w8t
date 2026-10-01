/**
 * 控台配接包（Console Patch Package）：转场后由灯光控台导出的「现场事实」。
 *
 * 边界约定：
 * - 包只陈述现场事实——灯具编号、DMX 通道、各 Cue 下的亮度与色温；
 * - 不携带任何编排决定——场次、提示语、触发方式、过渡时间一律以本地 Cue 表为准，导入时不覆盖。
 */

/** 控台配接包支持的格式版本 */
export const CONSOLE_PACKAGE_KIND = 'gbcuesheet/console-patch'
export const CONSOLE_PACKAGE_FORMAT = '1.0'

/** 配接包中的一盏灯具（现场事实） */
export interface ConsoleFixture {
  /** 控台侧灯具稳定身份，重导同一灯具时保持不变；对账按它锚定，而不是通道号 */
  uid: string
  /** 灯具编号，控台现场编制（可能随转场重排） */
  fixtureNo: string
  /** DMX 通道号（1-512） */
  channel: number
  /** 灯具类型，供人工核对，不直接覆盖本地配接 */
  fixtureType?: string
}

/** 配接包中某条 Cue 下一盏灯的电平事实 */
export interface ConsoleCueLevel {
  /** 指向 {@link ConsoleFixture.uid} */
  fixtureUid: string
  /** 亮度 0-100（%） */
  intensity: number
  /** 色温（K）；控台未上报时缺省，属于「电平缺失」，需人工选定后才写入 */
  colorTempK?: number
}

/** 配接包中的一条 Cue：只有编号与现场电平，不含提示语与过渡时间 */
export interface ConsoleCue {
  /** Cue 编号，形如 `Q12` / `Q12.5`，与本地按编号对账 */
  cueNo: string
  levels: ConsoleCueLevel[]
}

/** 控台配接包根结构 */
export interface ConsolePackage {
  kind: typeof CONSOLE_PACKAGE_KIND
  format: string
  /** 控台 / 演出现场标识，例如场馆与主机名 */
  source: string
  /** 导出时间，ISO 字符串 */
  exportedAt: string
  fixtures: ConsoleFixture[]
  cues: ConsoleCue[]
}

/* ------------------------------------------------------------------ */
/* 对账结果（纯函数计算，供页面渲染与人工选定）                          */
/* ------------------------------------------------------------------ */

/** 单字段差异里控台与本地的一对取值 */
export interface DiffPair<T> {
  console: T
  local: T
}

/** 灯具层面的对账条目 */
export interface FixtureReconcileItem {
  /** 任务内稳定键 */
  key: string
  consoleUid: string
  /** 本地灯具；控台有、本地未锚定且未匹配到时为 null（待人工指定或忽略） */
  fixtureId: string | null
  consoleFixture: ConsoleFixture
  /** 灯具编号差异（现场重编号） */
  fixtureNoDiff: DiffPair<string> | null
  /** 通道号差异（现场重新配接） */
  channelDiff: DiffPair<number> | null
  /** 通道争用：控台目标通道已被本地另一盏锚定灯具占用 */
  contention: boolean
  /** 争用对象的本地灯具 id（被占通道的当前占有人） */
  contentionFixtureId: string | null
  status: 'ready' | 'conflict'
}

/** 单条 Cue 电平对账条目 */
export interface LevelReconcileItem {
  key: string
  cueId: string
  cueNo: string
  fixtureId: string
  consoleUid: string
  channel: number
  /** 控台亮度；始终存在 */
  consoleIntensity: number
  /** 本地亮度；无本地电平记录时为 null（参与态缺失） */
  localIntensity: number | null
  /** 控台色温；控台未上报时为 null（电平缺失） */
  consoleColorTempK: number | null
  /** 本地色温；无本地电平记录时为 null */
  localColorTempK: number | null
  /** 控台声明该灯在本 Cue 为零电平（黑场 / 不参与） */
  consoleOff: boolean
  status: 'ready' | 'conflict'
}

/** 控台有但本地没有同编号的 Cue（只列差异，绝不自动新建 Cue） */
export interface UnmatchedConsoleCue {
  cueNo: string
  levelCount: number
}

/** 对账报告 */
export interface ReconcileReport {
  fixtureItems: FixtureReconcileItem[]
  levelItems: LevelReconcileItem[]
  unmatchedConsoleCues: UnmatchedConsoleCue[]
  /** 控台灯号在包内重复（包自身不合法） */
  duplicateFixtureUids: string[]
  /** 控台 Cue 编号在包内重复 */
  duplicateCueNos: string[]
}

/* ------------------------------------------------------------------ */
/* 人工选定（决策），选定后才允许写入                                   */
/* ------------------------------------------------------------------ */

/** 灯具条目的人工裁决 */
export interface FixtureResolution {
  /** 把该控台灯具锚定到哪个本地灯具；null 表示暂不处理（跳过） */
  fixtureId: string | null
  /** 通道争用 / 换通道时选用哪一侧编号 */
  channelChoice: 'console' | 'local'
}

/** 电平条目的人工裁决 */
export interface LevelResolution {
  /** 应用控台值 / 保留本地值（缺失时保留即维持现状，不新建记录） */
  choice: 'console' | 'local'
  /** 控台报零电平时，是否删除本地电平记录（使其不参与本 Cue） */
  dropLocalOff: boolean
}

/** 一次对账的全部人工决策，按 item.key 索引 */
export interface ReconcileDecisions {
  fixtures: Record<string, FixtureResolution>
  levels: Record<string, LevelResolution>
}

/** 应用一条选定后预计产生的写入计划（预览，不落库） */
export interface FixtureWritePlan {
  fixtureId: string
  consoleUid: string
  fixtureNo: string
  channel: number
}

export interface LevelWritePlan {
  cueId: string
  fixtureId: string
  intensity: number
  colorTempK: number
  /** 删除既有电平记录（控台报零且裁决删本地） */
  remove: boolean
}

export interface ReconcileApplyPlan {
  fixtures: FixtureWritePlan[]
  levels: LevelWritePlan[]
}
