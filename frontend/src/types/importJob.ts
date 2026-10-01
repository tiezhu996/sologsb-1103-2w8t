import type { ConsolePackage, ReconcileDecisions, ReconcileReport } from '@/types/console'

/** 导入任务生命周期状态 */
export const IMPORT_JOB_STATUSES = ['received', 'pending', 'applied', 'failed', 'abandoned'] as const
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number]

/**
 * 控台配接包导入任务：把配接包原文、解析结果、对账报告与人工选定整体落库。
 *
 * - 导入失败后任务仍保留（含配接包与当前进度），可重试；
 * - 同一配接包（按原文内容哈希）在同一场次只生成一条任务，重试不重复创建记录。
 */
export interface ConsoleImportJob {
  /** 主键 */
  id: string
  /** 对账到的本地场次 */
  sessionId: string
  /** 配接包原文内容的 SHA-256（幂等键的一部分） */
  contentHash: string
  /** 配接包原文（失败也保留，重试时不必重新上传） */
  rawText: string
  /** 解析后的配接包；原文解析失败时为 null（任务停留在 received，保留原文待重试） */
  pkg: ConsolePackage | null
  /** 控台 / 现场标识，冗余便于列表展示 */
  source: string
  exportedAt: string
  status: ImportJobStatus
  /** 已完成解析的对账报告（pending/applied/failed 阶段存在） */
  report: ReconcileReport | null
  /** 人工选定进度，随对账页面操作增量保存 */
  decisions: ReconcileDecisions
  /** 已应用的写入批次次数（重试时校验幂等） */
  appliedBatches: number
  /** 最近一次失败原因 */
  lastError: string
  createdAt: number
  updatedAt: number
  appliedAt: number | null
}

/** 导入任务在列表中的精简统计 */
export interface ImportJobStat {
  fixtureConflictCount: number
  levelConflictCount: number
  unmatchedCueCount: number
}
