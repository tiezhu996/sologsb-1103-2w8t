import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ReconcileDecisions, ReconcileReport } from '@/types/console'
import type { ConsoleImportJob } from '@/types/importJob'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { hashPackageText, parseConsolePackage } from '@/utils/consolePackage'
import { buildApplyPlan, buildReconcile, emptyDecisions, ensureDefaultDecisions } from '@/utils/reconcile'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSessionStore } from '@/stores/sessionStore'

/** 收录配接包的结果：created 新建；duplicate 命中同一包，直接复用既有任务 */
export interface IngestResult {
  outcome: 'created' | 'duplicate'
  job: ConsoleImportJob
}

/**
 * 控台配接包导入任务仓库。
 *
 * 边界：配接包只提供灯具编号、通道、亮度、色温这些现场事实；
 * 场次、提示语、触发方式与过渡时间始终留在本地 Cue 表，本仓库绝不改写。
 * 身份：灯具按 consoleUid 锚定，重导沿用同一身份，不按通道号硬盖。
 * 失败：任务（含原文与进度）一律保留，可重试；同一场次 + 同一内容哈希只建一条记录。
 */
export const useImportJobStore = defineStore('importJob', () => {
  const jobs = ref<ConsoleImportJob[]>([])
  const hydrated = ref(false)

  const jobsSorted = computed(() => [...jobs.value].sort((a, b) => b.createdAt - a.createdAt))

  function jobsOfSession(sessionId: string): ConsoleImportJob[] {
    return jobsSorted.value.filter((job) => job.sessionId === sessionId)
  }

  function jobById(id: string): ConsoleImportJob | null {
    return jobs.value.find((job) => job.id === id) ?? null
  }

  async function hydrate(): Promise<void> {
    jobs.value = await db.importJobs.toArray()
    hydrated.value = true
  }

  function patchJobInState(next: ConsoleImportJob): void {
    jobs.value = jobs.value.map((job) => (job.id === next.id ? next : job))
  }

  /** 用本地现状重新计算对账报告（人工改选身份 / 重导后均沿用同一份计算） */
  function recomputeReport(job: ConsoleImportJob, decisions: ReconcileDecisions): ReconcileReport | null {
    if (!job.pkg) return null
    const cueStore = useCueStore()
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    return buildReconcile(
      job.pkg,
      {
        fixtures: fixtureStore.fixturesOfSession(job.sessionId),
        cues: cueStore.cuesOfSession(job.sessionId),
        levels: levelStore.levels.filter((level) => cueStore.cueById(level.cueId)?.sessionId === job.sessionId)
      },
      decisions
    )
  }

  /**
   * 收录一份配接包原文。幂等：同一场次 + 同一 SHA-256 直接返回既有任务，不重复生成记录。
   * 解析失败也落一条 received 任务（保留原文），由重试驱动；不抛出。
   */
  async function ingest(sessionId: string, rawText: string): Promise<IngestResult | { outcome: 'error'; message: string }> {
    const sessionStore = useSessionStore()
    if (!sessionStore.sessionById(sessionId)) {
      return { outcome: 'error', message: '所选场次不存在或已删除' }
    }
    const trimmed = rawText.trim()
    if (!trimmed) {
      return { outcome: 'error', message: '配接包内容为空' }
    }

    const contentHash = await hashPackageText(trimmed)
    const existing = jobs.value.find((job) => job.sessionId === sessionId && job.contentHash === contentHash)
    if (existing) {
      return { outcome: 'duplicate', job: existing }
    }

    const parsed = parseConsolePackage(trimmed)
    const now = Date.now()
    const job: ConsoleImportJob = {
      id: createId('imp'),
      sessionId,
      contentHash,
      rawText: trimmed,
      pkg: parsed.ok ? parsed.pkg : null,
      source: parsed.pkg?.source ?? '（未识别来源）',
      exportedAt: parsed.pkg?.exportedAt ?? '',
      status: 'received',
      report: null,
      decisions: emptyDecisions(),
      appliedBatches: 0,
      lastError: parsed.ok ? '' : parsed.errors.join('；'),
      createdAt: now,
      updatedAt: now,
      appliedAt: null
    }

    if (parsed.ok && parsed.pkg) {
      job.report = recomputeReport(job, job.decisions)
      job.decisions = job.report ? ensureDefaultDecisions(job.report, job.decisions) : job.decisions
      job.status = 'pending'
    }

    await db.importJobs.put(job)
    jobs.value = [...jobs.value, job]
    return { outcome: 'created', job }
  }

  /** 增量保存人工选定进度，并按最新本地现状刷新对账报告 */
  async function saveDecisions(jobId: string, decisions: ReconcileDecisions): Promise<ConsoleImportJob | null> {
    const target = jobById(jobId)
    if (!target) return null
    const report = recomputeReport(target, decisions)
    const next: ConsoleImportJob = {
      ...target,
      decisions,
      report,
      status: target.status === 'applied' ? 'applied' : 'pending',
      updatedAt: Date.now()
    }
    await db.importJobs.put(next)
    patchJobInState(next)
    return next
  }

  /**
   * 应用当前对账选定。所有灯具 / 电平写入在单个事务内提交：
   * 任一项失败整体回滚，任务标记 failed 但配接包与进度保留，可原样重试。
   */
  async function apply(jobId: string): Promise<{ ok: boolean; job: ConsoleImportJob | null; message: string }> {
    const target = jobById(jobId)
    if (!target) return { ok: false, job: null, message: '导入任务不存在' }
    if (!target.pkg) {
      return { ok: false, job: target, message: '配接包尚未通过解析，无法对账' }
    }

    const report = recomputeReport(target, target.decisions)
    const refreshed: ConsoleImportJob = { ...target, report, updatedAt: Date.now() }
    if (!report) {
      return { ok: false, job: refreshed, message: '配接包尚未通过解析，无法对账' }
    }
    const { plan, blocked } = buildApplyPlan(report, target.decisions)
    if (blocked.length > 0) {
      const failed: ConsoleImportJob = {
        ...refreshed,
        status: 'failed',
        lastError: blocked.join('；'),
        updatedAt: Date.now()
      }
      await db.importJobs.put(failed)
      patchJobInState(failed)
      return { ok: false, job: failed, message: blocked[0] }
    }

    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()

    try {
      await db.transaction('rw', [db.fixtures, db.levels], async () => {
        await fixtureStore.applyReconcileFixtures(plan.fixtures)
        await levelStore.applyReconcileLevels(plan.levels)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '对账写入失败'
      const failed: ConsoleImportJob = {
        ...refreshed,
        status: 'failed',
        lastError: message,
        updatedAt: Date.now()
      }
      await db.importJobs.put(failed)
      patchJobInState(failed)
      return { ok: false, job: failed, message }
    }

    const applied: ConsoleImportJob = {
      ...refreshed,
      status: 'applied',
      appliedBatches: target.appliedBatches + 1,
      lastError: '',
      appliedAt: Date.now(),
      updatedAt: Date.now()
    }
    await db.importJobs.put(applied)
    patchJobInState(applied)
    return {
      ok: true,
      job: applied,
      message: `已对账 ${plan.fixtures.length} 个灯具身份、${plan.levels.length} 条通道电平`
    }
  }

  /** 重试：用保留的原文重新解析并重建报告；同一条任务记录原地更新，不新建。 */
  async function retry(jobId: string): Promise<{ ok: boolean; job: ConsoleImportJob | null; message: string }> {
    const target = jobById(jobId)
    if (!target) return { ok: false, job: null, message: '导入任务不存在' }

    const parsed = parseConsolePackage(target.rawText)
    if (!parsed.ok || !parsed.pkg) {
      const failed: ConsoleImportJob = {
        ...target,
        pkg: null,
        report: null,
        status: 'received',
        lastError: parsed.errors.join('；'),
        updatedAt: Date.now()
      }
      await db.importJobs.put(failed)
      patchJobInState(failed)
      return { ok: false, job: failed, message: failed.lastError || '配接包解析失败' }
    }

    const reprepared: ConsoleImportJob = { ...target, pkg: parsed.pkg, source: parsed.pkg.source, exportedAt: parsed.pkg.exportedAt }
    const report = recomputeReport(reprepared, reprepared.decisions)
    const next: ConsoleImportJob = {
      ...reprepared,
      report,
      decisions: report ? ensureDefaultDecisions(report, reprepared.decisions) : reprepared.decisions,
      status: 'pending',
      lastError: '',
      updatedAt: Date.now()
    }
    await db.importJobs.put(next)
    patchJobInState(next)
    return { ok: true, job: next, message: '配接包已重新解析，可以继续对账' }
  }

  /** 放弃任务（仅本地标记，保留记录留痕） */
  async function abandon(jobId: string): Promise<void> {
    const target = jobById(jobId)
    if (!target) return
    const next: ConsoleImportJob = { ...target, status: 'abandoned', updatedAt: Date.now() }
    await db.importJobs.put(next)
    patchJobInState(next)
  }

  async function removeJob(jobId: string): Promise<void> {
    const target = jobById(jobId)
    if (!target) return
    await db.importJobs.delete(jobId)
    jobs.value = jobs.value.filter((job) => job.id !== jobId)
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const ids = jobs.value.filter((job) => job.sessionId === sessionId).map((job) => job.id)
    if (ids.length === 0) return
    await db.importJobs.bulkDelete(ids)
    jobs.value = jobs.value.filter((job) => job.sessionId !== sessionId)
  }

  return {
    jobs,
    hydrated,
    jobsSorted,
    jobsOfSession,
    jobById,
    hydrate,
    recomputeReport,
    ingest,
    saveDecisions,
    apply,
    retry,
    abandon,
    removeJob,
    removeBySession
  }
})
