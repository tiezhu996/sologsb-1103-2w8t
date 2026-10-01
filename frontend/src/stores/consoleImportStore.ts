import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Cue } from '@/types/cue'
import type {
  ChannelChoice,
  ConsoleImportBatch,
  ConsolePatchPackage,
  FixtureMatchAction,
  FixtureNoChoice,
  FixtureIdentity,
  FixtureReconcileItem,
  MissingLevelChoice
} from '@/types/consoleImport'
import type { Fixture, FixturePosition, FixtureType } from '@/types/fixture'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { parseConsolePackage } from '@/utils/consolePackage'
import { normalizeCueNo } from '@/utils/cueOrder'
import {
  buildReconcileReport,
  deserializeReport,
  effectiveChannelOf,
  evaluateReport,
  isLevelRowActive,
  resolveFieldValue,
  serializeReport,
  type ReconcileReport
} from '@/utils/reconcile'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'

/** 新建 Cue 的缺省编排参数（编排决定不由配接包提供，沿用应用默认） */
const DEFAULT_CUE_DRAFT = {
  label: '',
  trigger: '手动' as const,
  fadeInSec: 3,
  fadeOutSec: 3,
  holdSec: 5,
  note: ''
}

function buildDedupeKey(sessionId: string, packageId: string): string {
  return `${sessionId}::${packageId}`
}

/**
 * 深解包为可结构化克隆的纯数据：对账报告来自 Pinia 状态时是响应式 Proxy，
 * IndexedDB（尤其 fake-indexeddb / 部分环境）无法直接克隆 Proxy，落库前统一转成裸对象。
 */
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 控台配接包导入仓库：
 * - 上传时落批次（保留配接包原文），同一 session + packageId 复用同一批次，绝不重复生成记录；
 * - 对账报告随决策持久化，失败 / 刷新后可续对；
 * - 选定完成后单事务写入灯具身份、通道 / 灯号、Cue（仅新建缺失编号）与电平；
 * - 场次归属、提示语、过渡时间等编排决定永远留在本地，配接包不覆盖。
 */
export const useConsoleImportStore = defineStore('consoleImport', () => {
  const batches = ref<ConsoleImportBatch[]>([])
  const identities = ref<FixtureIdentity[]>([])
  const hydrated = ref(false)

  const batchesSorted = computed(() =>
    [...batches.value].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  )

  function batchesOfSession(sessionId: string): ConsoleImportBatch[] {
    return batchesSorted.value.filter((batch) => batch.sessionId === sessionId)
  }

  function batchById(id: string): ConsoleImportBatch | null {
    return batches.value.find((batch) => batch.id === id) ?? null
  }

  function findBatch(sessionId: string, packageId: string): ConsoleImportBatch | null {
    const key = buildDedupeKey(sessionId, packageId)
    return batches.value.find((batch) => batch.dedupeKey === key) ?? null
  }

  function identitiesOfSession(sessionId: string): FixtureIdentity[] {
    return identities.value.filter((identity) => identity.sessionId === sessionId)
  }

  async function hydrate(): Promise<void> {
    batches.value = await db.consoleImports.toArray()
    identities.value = await db.fixtureIdentities.toArray()
    hydrated.value = true
  }

  /**
   * 上传（或重试）配接包：
   * - 同 session + packageId 已存在批次时直接返回该批次（不重复生成记录）；
   * - 否则把原文落库并构建立账报告。
   */
  async function uploadPackage(sessionId: string, raw: string): Promise<{ ok: boolean; message: string; batch: ConsoleImportBatch | null }> {
    const parsed = parseConsolePackage(raw)
    if (!parsed.ok || !parsed.pkg) return { ok: false, message: parsed.message, batch: null }
    const pkg = parsed.pkg

    const existing = findBatch(sessionId, pkg.packageId)
    if (existing) {
      return {
        ok: true,
        message:
          existing.status === 'imported'
            ? '该配接包此前已导入，已打开既有批次（重试同一包不会重复生成记录）。'
            : '该配接包已上传过，已恢复上次对账进度。',
        batch: existing
      }
    }

    const report = buildReconcileReport(pkg, {
      fixtures: useFixtureStore().fixturesOfSession(sessionId),
      cues: useCueStore().cuesOfSession(sessionId),
      levels: useLevelStore().levels,
      identities: identitiesOfSession(sessionId)
    })

    const now = Date.now()
    const batch: ConsoleImportBatch = {
      id: createId('imp'),
      dedupeKey: buildDedupeKey(sessionId, pkg.packageId),
      sessionId,
      packageId: pkg.packageId,
      rawPackage: raw,
      consoleName: pkg.consoleName ?? '',
      exportedAt: pkg.exportedAt ?? '',
      fixtureCount: pkg.fixtures.length,
      cueCount: pkg.cues.length,
      status: 'pending',
      report: serializeReport(report),
      lastError: '',
      importedAt: null,
      createdAt: now,
      updatedAt: now
    }
    await db.consoleImports.put(toPlain(batch))
    batches.value = [...batches.value, batch]
    return { ok: true, message: '配接包已上传，请逐项对账后写入本地 Cue 表。', batch }
  }

  /** 读取批次的对账报告（从持久化快照恢复） */
  function reportOf(batch: ConsoleImportBatch): ReconcileReport | null {
    if (!batch.report) return null
    try {
      return deserializeReport(batch.report)
    } catch {
      return null
    }
  }

  /** 解析批次配接包原文 */
  function packageOf(batch: ConsoleImportBatch): ConsolePatchPackage | null {
    const parsed = parseConsolePackage(batch.rawPackage)
    return parsed.ok ? parsed.pkg : null
  }

  /** 持久化对账决策（进度保留：失败 / 刷新后可续对） */
  async function persistReport(batchId: string, report: ReconcileReport): Promise<void> {
    const target = batchById(batchId)
    if (!target) return
    const next: ConsoleImportBatch = {
      ...target,
      report: toPlain(serializeReport(report)),
      updatedAt: Date.now()
    }
    await db.consoleImports.put(next)
    batches.value = batches.value.map((batch) => (batch.id === batchId ? next : batch))
  }

  /** 以批次原始包 + 当前本地数据重新构建立账报告（本地数据变化后刷新用），保留可兼容的人工决策 */
  async function rebuildReport(batchId: string): Promise<{ ok: boolean; message: string }> {
    const target = batchById(batchId)
    const pkg = target ? packageOf(target) : null
    if (!target || !pkg) return { ok: false, message: '配接包原文缺失或已损坏' }

    const previous = reportOf(target)
    const fresh = buildReconcileReport(pkg, {
      fixtures: useFixtureStore().fixturesOfSession(target.sessionId),
      cues: useCueStore().cuesOfSession(target.sessionId),
      levels: useLevelStore().levels,
      identities: identitiesOfSession(target.sessionId)
    })
    if (previous) carryDecisions(previous, fresh)
    await persistReport(batchId, fresh)
    return { ok: true, message: '已按最新本地数据重新对账' }
  }

  /** 把旧报告里的人工决策迁移到新报告（身份以 uid 为准） */
  function carryDecisions(oldReport: ReconcileReport, fresh: ReconcileReport): void {
    const oldFixtures = new Map(oldReport.fixtures.map((item) => [item.uid, item]))
    const oldLevels = new Map(oldReport.levels.map((item) => [item.itemId, item]))
    const oldCues = new Map(oldReport.cues.map((item) => [item.normalizedCueNo, item]))

    fresh.fixtures.forEach((item) => {
      const old = oldFixtures.get(item.uid)
      if (!old) return
      item.action = old.action
      item.fixtureNoChoice = old.fixtureNoChoice
      item.channelChoice = old.channelChoice
      item.customChannel = old.customChannel
      item.createPosition = old.createPosition
      item.createFixtureType = old.createFixtureType
      // 本地数据已变化导致争议消失时，重新交由引擎判定；其余保留人工确认
      item.decided = old.decided
    })
    fresh.levels.forEach((item) => {
      const old = oldLevels.get(item.itemId)
      if (!old) return
      ;(['intensity', 'colorTemp'] as const).forEach((field) => {
        item[field].missingChoice = old[field].missingChoice
        item[field].decided = old[field].decided
      })
    })
    fresh.cues.forEach((item) => {
      const old = oldCues.get(item.normalizedCueNo)
      if (!old) return
      item.createLocal = old.createLocal
      item.decided = old.decided
    })
  }

  // ---------- 灯具行决策 ----------

  async function setFixtureAction(batchId: string, itemId: string, action: FixtureMatchAction): Promise<void> {
    const update = mutateReport(batchId, (report) => {
      const item = report.fixtures.find((fixture) => fixture.itemId === itemId)
      if (!item) return
      item.action = action
      // 用户显式否认自动匹配（改判新建 / 跳过）：解除本地对应，回到「包内新灯具」立场
      if (action !== 'existing') {
        item.localFixtureId = null
        item.hasNoConflict = false
        item.hasChannelChange = false
        item.contenderIds = []
      }
      item.decided = true
    })
    if (update) await persistReport(batchId, update)
  }

  async function setFixtureNoChoice(batchId: string, itemId: string, choice: FixtureNoChoice): Promise<void> {
    const update = mutateReport(batchId, (report) => {
      const item = report.fixtures.find((fixture) => fixture.itemId === itemId)
      if (!item) return
      item.fixtureNoChoice = choice
      item.decided = true
    })
    if (update) await persistReport(batchId, update)
  }

  async function setChannelChoice(
    batchId: string,
    itemId: string,
    choice: ChannelChoice,
    customChannel?: number | null
  ): Promise<void> {
    const update = mutateReport(batchId, (report) => {
      const item = report.fixtures.find((fixture) => fixture.itemId === itemId)
      if (!item) return
      item.channelChoice = choice
      if (customChannel !== undefined) item.customChannel = customChannel
      item.decided = true
    })
    if (update) await persistReport(batchId, update)
  }

  async function setCreatePosition(batchId: string, itemId: string, position: FixturePosition): Promise<void> {
    const update = mutateReport(batchId, (report) => {
      const item = report.fixtures.find((fixture) => fixture.itemId === itemId)
      if (!item) return
      item.createPosition = position
      item.decided = true
    })
    if (update) await persistReport(batchId, update)
  }

  async function setCreateFixtureType(batchId: string, itemId: string, fixtureType: FixtureType): Promise<void> {
    const update = mutateReport(batchId, (report) => {
      const item = report.fixtures.find((fixture) => fixture.itemId === itemId)
      if (!item) return
      item.createFixtureType = fixtureType
      item.decided = true
    })
    if (update) await persistReport(batchId, update)
  }

  // ---------- Cue / 电平行决策 ----------

  async function setCueDecision(batchId: string, normalizedCueNo: string, createLocal: boolean): Promise<void> {
    const update = mutateReport(batchId, (report) => {
      const item = report.cues.find((cue) => cue.normalizedCueNo === normalizedCueNo)
      if (!item) return
      item.createLocal = createLocal
      item.decided = true
    })
    if (update) await persistReport(batchId, update)
  }

  async function setMissingLevelChoice(
    batchId: string,
    levelItemId: string,
    field: 'intensity' | 'colorTemp',
    choice: MissingLevelChoice
  ): Promise<void> {
    const update = mutateReport(batchId, (report) => {
      const row = report.levels.find((level) => level.itemId === levelItemId)
      if (!row) return
      row[field].missingChoice = choice
      row[field].decided = true
    })
    if (update) await persistReport(batchId, update)
  }

  /** 在内存中修改报告副本，返回新报告（不落库） */
  function mutateReport(batchId: string, mutator: (report: ReconcileReport) => void): ReconcileReport | null {
    const target = batchById(batchId)
    if (!target || !target.report) return null
    const report = deserializeReport(target.report)
    mutator(report)
    // 同步回批次快照由调用方 persistReport 完成；这里先把结果挂在批次对象上
    const draft: ConsoleImportBatch = { ...target, report: toPlain(serializeReport(report)) }
    batches.value = batches.value.map((batch) => (batch.id === batchId ? draft : batch))
    return report
  }

  /** 放行检查（不写库） */
  function evaluate(batchId: string): { canCommit: boolean; blockers: ReturnType<typeof evaluateReport>['blockers'] } {
    const target = batchById(batchId)
    if (!target) return { canCommit: false, blockers: [{ kind: 'channelInvalid', message: '导入批次不存在' }] }
    const report = reportOf(target)
    if (!report) return { canCommit: false, blockers: [{ kind: 'channelInvalid', message: '对账报告不存在' }] }
    return evaluateReport(report, useFixtureStore().fixturesOfSession(target.sessionId))
  }

  /**
   * 提交写入：单事务完成
   * 1) 新建 / 更新灯具（通道、灯具编号），写入 uid ↔ fixtureId 身份映射；
   * 2) 为缺失 cueNo 新建本地 Cue（默认编排参数，可随后在时间轴编辑）；
   * 3) 按 Cue × 灯具 upsert 亮度 / 色温。
   * 任何异常都回滚，批次保留为 failed，配接包与进度不丢，可重试且不产生重复记录。
   */
  async function commit(batchId: string): Promise<{ ok: boolean; message: string }> {
    const target = batchById(batchId)
    if (!target) return { ok: false, message: '导入批次不存在' }
    const fixtureStore = useFixtureStore()
    const cueStore = useCueStore()
    const levelStore = useLevelStore()
    const pkg = packageOf(target)
    const report = reportOf(target)
    if (!pkg || !report) {
      await markFailed(batchId, '配接包原文或对账报告缺失')
      return { ok: false, message: '配接包原文或对账报告缺失，请重新上传' }
    }

    const sessionId = target.sessionId
    const now = Date.now()

    // 先以最新身份映射把已落地的灯具行收敛为 existing（重试同一包 / 批次报告滞后时也不会重复新建）：
    // 以 uid 查映射 → 映射指向的本地灯具仍在，则按「生效值 vs 本地现值」重新判定争议。
    const identityByUid = new Map(identitiesOfSession(sessionId).map((identity) => [identity.uid, identity]))
    const currentFixtures = fixtureStore.fixturesOfSession(sessionId)
    const currentFixtureById = new Map(currentFixtures.map((fixture) => [fixture.id, fixture]))
    report.fixtures.forEach((item) => {
      if (item.action === 'skip') return
      const mapped = identityByUid.get(item.uid)
      const owner = mapped ? currentFixtureById.get(mapped.fixtureId) : null
      if (!owner) return
      // 上一轮已写入生效值，通常无争议（幂等）；若本地后来被人工改动，则重新列出差异。
      item.localFixtureId = owner.id
      item.matchedBy = 'identity'
      item.localChannel = owner.channel
      item.localFixtureNo = owner.fixtureNo
      item.action = 'existing'
      const effectiveChannel =
        item.channelChoice === 'local'
          ? owner.channel
          : item.channelChoice === 'custom'
            ? item.customChannel
            : item.pkgChannel
      const effectiveNo = item.hasNoConflict && item.fixtureNoChoice === 'local' ? owner.fixtureNo : item.pkgFixtureNo
      item.hasNoConflict = owner.fixtureNo !== effectiveNo
      item.hasChannelChange = owner.channel !== effectiveChannel
      item.decided = true
    })

    // 身份 / Cue 收敛后，同步把电平行的本地外键指到既有记录，保证电平按 (cueId, fixtureId) 幂等 upsert。
    const localCueByNo = new Map(
      cueStore.cuesOfSession(sessionId).map((cue) => [normalizeCueNo(cue.cueNo), cue.id])
    )
    report.levels.forEach((row) => {
      const fixtureItem = report.fixtures.find((item) => item.itemId === row.fixtureItemId)
      if (fixtureItem?.localFixtureId) row.localFixtureId = fixtureItem.localFixtureId
      const localCueId = localCueByNo.get(row.normalizedCueNo)
      if (localCueId) row.localCueId = localCueId
    })

    const { blockers, canCommit } = evaluateReport(report, currentFixtures)
    if (!canCommit) {
      // 本地数据变化导致新争用 / 新待决：回写报告让用户重新对账，不进入写事务
      await persistReport(batchId, report)
      return { ok: false, message: `仍有 ${blockers.length} 项待决，请先在对账表中选定：${blockers
        .slice(0, 3)
        .map((blocker) => blocker.message)
        .join('；')}` }
    }

    try {
      // 所有 upsert 都以身份映射 / (cueId, fixtureId) 唯一键收敛，保证「重试同一包不重复生成记录」。
      const uidToFixtureId = new Map<string, string>()

      // 1) 灯具：新建或更新
      const fixturesToPut: Fixture[] = []
      const existingFixtures = new Map(fixtureStore.fixturesOfSession(sessionId).map((fixture) => [fixture.id, fixture]))
      for (const item of report.fixtures) {
        if (item.action === 'skip') continue
        const channel = effectiveChannelOf(item)
        if (channel === null) throw new Error(`灯具 ${item.pkgFixtureNo} 通道未选定`)
        const fixtureNo = effectiveFixtureNoLocal(item)
        if (item.action === 'existing' && item.localFixtureId) {
          const local = existingFixtures.get(item.localFixtureId)
          if (!local) throw new Error(`本地灯具已被删除：${item.localFixtureId}`)
          fixturesToPut.push({ ...local, channel, fixtureNo, updatedAt: now })
          uidToFixtureId.set(item.uid, local.id)
        } else {
          const created: Fixture = {
            id: createId('fix'),
            sessionId,
            channel,
            fixtureNo,
            position: item.createPosition,
            fixtureType: item.createFixtureType,
            gel: '',
            patchNote: `控台导入：${item.uid}`,
            createdAt: now,
            updatedAt: now
          }
          fixturesToPut.push(created)
          uidToFixtureId.set(item.uid, created.id)
        }
      }

      // 2) Cue：为缺失编号新建本地 Cue（编排字段用默认值，提示语 / 过渡仍由本地编排）
      const cueNoToCueId = new Map<string, string>()
      const cuesToPut: Cue[] = []
      for (const item of report.cues) {
        if (item.localCueId) {
          cueNoToCueId.set(item.normalizedCueNo, item.localCueId)
        } else if (item.createLocal) {
          const created: Cue = {
            id: createId('cue'),
            sessionId,
            cueNo: item.normalizedCueNo,
            ...DEFAULT_CUE_DRAFT,
            orderIndex: 0,
            createdAt: now,
            updatedAt: now
          }
          cuesToPut.push(created)
          cueNoToCueId.set(item.normalizedCueNo, created.id)
        }
      }

      // 3) 电平：按 (cueId, fixtureId) upsert
      const levelWrites: Array<{ cueId: string; fixtureId: string; intensity: number; colorTempK: number }> = []
      for (const row of report.levels) {
        if (!isLevelRowActive(report, row)) continue
        const fixtureId = row.localFixtureId ?? uidToFixtureId.get(row.uid)
        const cueId = row.localCueId ?? cueNoToCueId.get(row.normalizedCueNo)
        if (!fixtureId || !cueId) continue
        const intensityValue = resolveFieldValue(row.intensity)
        const colorTempValue = resolveFieldValue(row.colorTemp)
        if (intensityValue === null && colorTempValue === null) continue
        levelWrites.push({
          cueId,
          fixtureId,
          intensity: intensityValue ?? 0,
          colorTempK: colorTempValue ?? 3200
        })
      }

      await db.transaction(
        'rw',
        [db.fixtures, db.cues, db.levels, db.fixtureIdentities, db.consoleImports],
        async () => {
          if (fixturesToPut.length > 0) await db.fixtures.bulkPut(toPlain(fixturesToPut))

          // 身份映射 upsert（重导沿用同一身份）
          const identityRecords: FixtureIdentity[] = report.fixtures
            .filter((item) => item.action !== 'skip')
            .map((item) => ({
              id: `${sessionId}::${item.uid}`,
              sessionId,
              uid: item.uid,
              fixtureId: uidToFixtureId.get(item.uid) as string,
              lastFixtureNo: item.pkgFixtureNo,
              updatedAt: now
            }))
          if (identityRecords.length > 0) await db.fixtureIdentities.bulkPut(toPlain(identityRecords))

          if (cuesToPut.length > 0) {
            // 重新计算整场 orderIndex，避免新 Cue 的 0 值破坏排序
            const createdIds = new Set(cuesToPut.map((cue) => cue.id))
            const merged = [
              ...cueStore.cuesOfSession(sessionId).filter((cue) => !createdIds.has(cue.id)),
              ...cuesToPut
            ]
            merged.sort((a, b) => {
              const pa = Number.parseFloat(a.cueNo.slice(1))
              const pb = Number.parseFloat(b.cueNo.slice(1))
              return pa - pb || a.createdAt - b.createdAt
            })
            merged.forEach((cue, index) => {
              cue.orderIndex = index + 1
            })
            await db.cues.bulkPut(toPlain(merged))
          }

          // 电平 upsert：以复合索引 [cueId+fixtureId] 查既有，存在则更新，不存在则插入（幂等）
          if (levelWrites.length > 0) {
            const keys = levelWrites.map((write) => [write.cueId, write.fixtureId] as [string, string])
            const existingLevels = await db.levels.where('[cueId+fixtureId]').anyOf(keys).toArray()
            const levelKey = new Map(existingLevels.map((level) => [`${level.cueId}::${level.fixtureId}`, level]))
            const toPut = levelWrites.map((write) => {
              const existing = levelKey.get(`${write.cueId}::${write.fixtureId}`)
              if (existing) {
                return { ...existing, intensity: write.intensity, colorTempK: write.colorTempK, updatedAt: now }
              }
              return {
                id: createId('lvl'),
                cueId: write.cueId,
                fixtureId: write.fixtureId,
                intensity: write.intensity,
                colorTempK: write.colorTempK,
                focusNote: '',
                updatedAt: now
              }
            })
            await db.levels.bulkPut(toPlain(toPut))
          }

          const imported: ConsoleImportBatch = {
            ...target,
            status: 'imported',
            report: toPlain(serializeReport(report)),
            lastError: '',
            importedAt: now,
            updatedAt: now
          }
          await db.consoleImports.put(toPlain(imported))
        }
      )

      // 事务成功后刷新相关 store 内存状态（页面只读 store）
      await fixtureStore.hydrate()
      await cueStore.hydrate()
      await levelStore.hydrate()
      identities.value = await db.fixtureIdentities.toArray()
      const refreshed = await db.consoleImports.get(batchId)
      if (refreshed) batches.value = batches.value.map((batch) => (batch.id === batchId ? refreshed : batch))

      return {
        ok: true,
        message: `已写入 ${fixturesToPut.length} 盏灯具、${cuesToPut.length} 条新 Cue、${levelWrites.length} 组电平；场次、提示语与过渡时间维持本地编排。`
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await markFailed(batchId, reason)
      return { ok: false, message: `写入失败已回滚（配接包与进度已保留）：${reason}` }
    }
  }

  /** 生效灯号（换号争议按选择取） */
  function effectiveFixtureNoLocal(item: FixtureReconcileItem): string {
    if (item.localFixtureId && item.hasNoConflict && item.fixtureNoChoice === 'local') return item.localFixtureNo
    return item.pkgFixtureNo
  }

  async function markFailed(batchId: string, reason: string): Promise<void> {
    const target = batchById(batchId)
    if (!target) return
    const next: ConsoleImportBatch = {
      ...target,
      status: 'failed',
      lastError: reason,
      updatedAt: Date.now()
    }
    await db.consoleImports.put(next)
    batches.value = batches.value.map((batch) => (batch.id === batchId ? next : batch))
  }

  /** 放弃批次（保留配接包原文，仅标记） */
  async function abandonBatch(batchId: string): Promise<void> {
    const target = batchById(batchId)
    if (!target) return
    const next: ConsoleImportBatch = { ...target, status: 'abandoned', updatedAt: Date.now() }
    await db.consoleImports.put(next)
    batches.value = batches.value.map((batch) => (batch.id === batchId ? next : batch))
  }

  async function removeBatch(batchId: string): Promise<void> {
    await db.consoleImports.delete(batchId)
    batches.value = batches.value.filter((batch) => batch.id !== batchId)
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const targets = batches.value.filter((batch) => batch.sessionId === sessionId)
    if (targets.length > 0) {
      await db.consoleImports.bulkDelete(targets.map((batch) => batch.id))
      batches.value = batches.value.filter((batch) => batch.sessionId !== sessionId)
    }
    const idTargets = identities.value.filter((identity) => identity.sessionId === sessionId)
    if (idTargets.length > 0) {
      await db.fixtureIdentities.bulkDelete(idTargets.map((identity) => identity.id))
      identities.value = identities.value.filter((identity) => identity.sessionId !== sessionId)
    }
  }

  return {
    batches,
    identities,
    hydrated,
    batchesSorted,
    batchesOfSession,
    batchById,
    findBatch,
    identitiesOfSession,
    hydrate,
    uploadPackage,
    reportOf,
    packageOf,
    persistReport,
    rebuildReport,
    setFixtureAction,
    setFixtureNoChoice,
    setChannelChoice,
    setCreatePosition,
    setCreateFixtureType,
    setCueDecision,
    setMissingLevelChoice,
    evaluate,
    commit,
    abandonBatch,
    removeBatch,
    removeBySession
  }
})
