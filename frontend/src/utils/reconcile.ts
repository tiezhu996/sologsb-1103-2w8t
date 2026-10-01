import type { Cue } from '@/types/cue'
import type { Fixture } from '@/types/fixture'
import type { CueLevel } from '@/types/level'
import type {
  ConsoleFixture,
  ConsolePackage,
  FixtureReconcileItem,
  LevelReconcileItem,
  ReconcileApplyPlan,
  ReconcileDecisions,
  ReconcileReport,
  UnmatchedConsoleCue
} from '@/types/console'
import { normalizeCueNo } from '@/utils/cueOrder'

/** 新建任务时的空白决策集合 */
export function emptyDecisions(): ReconcileDecisions {
  return { fixtures: {}, levels: {} }
}

function fixtureKey(uid: string): string {
  return `fix:${uid}`
}

function levelKey(cueId: string, uid: string): string {
  return `lvl:${cueId}:${uid}`
}

/** 按「先控台通道、再灯具编号」为尚未锚定的控台灯建议一个本地候选；仅作建议，可改 */
function suggestLocalFixture(consoleFixture: ConsoleFixture, locals: readonly Fixture[], claimed: Set<string>): Fixture | null {
  const byChannel = locals.find((local) => !local.consoleUid && !claimed.has(local.id) && local.channel === consoleFixture.channel)
  if (byChannel) return byChannel
  const byNo = locals.find(
    (local) => !local.consoleUid && !claimed.has(local.id) && local.fixtureNo && local.fixtureNo === consoleFixture.fixtureNo
  )
  return byNo ?? null
}

/** 解析控台灯 uid → 本地灯具：优先已锚定身份，其次人工选定，最后首次建议 */
function resolveFixtureId(
  consoleFixture: ConsoleFixture,
  locals: readonly Fixture[],
  decisions: ReconcileDecisions,
  claimed: Set<string>
): string | null {
  const anchored = locals.find((local) => local.consoleUid === consoleFixture.uid)
  if (anchored) return anchored.id
  const decided = decisions.fixtures[fixtureKey(consoleFixture.uid)]?.fixtureId
  if (decided) return decided
  const suggested = suggestLocalFixture(consoleFixture, locals, claimed)
  return suggested?.id ?? null
}

/**
 * 对账：把控台现场事实与本地配接 / Cue / 电平逐项比对，产出差异报告。
 * 纯函数，不写任何数据；人工选定通过 decisions 注入。
 */
export function buildReconcile(
  pkg: ConsolePackage,
  locals: {
    fixtures: readonly Fixture[]
    cues: readonly Cue[]
    levels: readonly CueLevel[]
  },
  decisions: ReconcileDecisions = emptyDecisions()
): ReconcileReport {
  const localCueByNo = new Map<string, Cue>()
  locals.cues.forEach((cue) => localCueByNo.set(normalizeCueNo(cue.cueNo), cue))

  // 通道 → 本地占有人（用于争用检测）；重复通道时全部纳入
  const occupantsByChannel = new Map<number, Fixture[]>()
  locals.fixtures.forEach((fixture) => {
    const list = occupantsByChannel.get(fixture.channel)
    if (list) list.push(fixture)
    else occupantsByChannel.set(fixture.channel, [fixture])
  })

  const claimed = new Set<string>()
  const fixtureItems: FixtureReconcileItem[] = []

  pkg.fixtures.forEach((consoleFixture) => {
    const fixtureId = resolveFixtureId(consoleFixture, locals.fixtures, decisions, claimed)
    if (fixtureId) claimed.add(fixtureId)
    const local = fixtureId ? locals.fixtures.find((item) => item.id === fixtureId) ?? null : null

    const fixtureNoDiff =
      local && local.fixtureNo !== consoleFixture.fixtureNo
        ? { console: consoleFixture.fixtureNo, local: local.fixtureNo }
        : null
    const channelDiff = local && local.channel !== consoleFixture.channel ? { console: consoleFixture.channel, local: local.channel } : null

    // 争用：控台目标通道被另一盏灯占用（含已锚定到别的 uid，或人工映射冲突）
    const occupants = (occupantsByChannel.get(consoleFixture.channel) ?? []).filter((item) => item.id !== fixtureId)
    const contention = occupants.length > 0
    const contentionFixtureId = occupants[0]?.id ?? null

    const hasConflict = !local || fixtureNoDiff !== null || channelDiff !== null || contention
    fixtureItems.push({
      key: fixtureKey(consoleFixture.uid),
      consoleUid: consoleFixture.uid,
      fixtureId,
      consoleFixture,
      fixtureNoDiff,
      channelDiff,
      contention,
      contentionFixtureId,
      status: hasConflict ? 'conflict' : 'ready'
    })
  })

  // uid → 本地灯具 id（含人工选定），电平条目据此对应
  const fixtureIdByUid = new Map<string, string | null>()
  fixtureItems.forEach((item) => fixtureIdByUid.set(item.consoleUid, item.fixtureId))

  const levelByCueFixture = new Map<string, CueLevel>()
  locals.levels.forEach((level) => levelByCueFixture.set(`${level.cueId}:${level.fixtureId}`, level))

  const levelItems: LevelReconcileItem[] = []
  const unmatchedConsoleCues: UnmatchedConsoleCue[] = []

  pkg.cues.forEach((consoleCue) => {
    const localCue = localCueByNo.get(normalizeCueNo(consoleCue.cueNo))
    if (!localCue) {
      unmatchedConsoleCues.push({ cueNo: normalizeCueNo(consoleCue.cueNo), levelCount: consoleCue.levels.length })
      return
    }
    consoleCue.levels.forEach((consoleLevel) => {
      const fixtureId = fixtureIdByUid.get(consoleLevel.fixtureUid) ?? null
      if (!fixtureId) return // 灯具尚未对应，选定灯具身份后再生成电平差异
      const local = levelByCueFixture.get(`${localCue.id}:${fixtureId}`) ?? null
      const fixture = locals.fixtures.find((item) => item.id === fixtureId)
      const consoleIntensity = Math.round(consoleLevel.intensity)
      const consoleColorTempK = consoleLevel.colorTempK === undefined ? null : Math.round(consoleLevel.colorTempK)
      const consoleOff = consoleIntensity === 0
      const localIntensity = local ? local.intensity : null
      const localColorTempK = local ? local.colorTempK : null

      const conflict =
        local === null ||
        consoleColorTempK === null ||
        localIntensity !== consoleIntensity ||
        (consoleColorTempK !== null && localColorTempK !== consoleColorTempK)

      levelItems.push({
        key: levelKey(localCue.id, consoleLevel.fixtureUid),
        cueId: localCue.id,
        cueNo: normalizeCueNo(consoleCue.cueNo),
        fixtureId,
        consoleUid: consoleLevel.fixtureUid,
        channel: fixture?.channel ?? consoleFixtureChannel(pkg, consoleLevel.fixtureUid),
        consoleIntensity,
        localIntensity,
        consoleColorTempK,
        localColorTempK,
        consoleOff,
        status: conflict ? 'conflict' : 'ready'
      })
    })
  })

  return {
    fixtureItems,
    levelItems,
    unmatchedConsoleCues,
    duplicateFixtureUids: [],
    duplicateCueNos: []
  }
}

function consoleFixtureChannel(pkg: ConsolePackage, uid: string): number {
  return pkg.fixtures.find((fixture) => fixture.uid === uid)?.channel ?? 0
}

/** 补齐缺失的默认决策（已有人工选定不动） */
export function ensureDefaultDecisions(report: ReconcileReport, existing: ReconcileDecisions): ReconcileDecisions {
  const fixtures = { ...existing.fixtures }
  report.fixtureItems.forEach((item) => {
    if (!fixtures[item.key]) {
      fixtures[item.key] = { fixtureId: item.fixtureId, channelChoice: 'console' }
    }
  })
  const levels = { ...existing.levels }
  report.levelItems.forEach((item) => {
    if (!levels[item.key]) {
      levels[item.key] = { choice: 'console', dropLocalOff: false }
    }
  })
  return { fixtures, levels }
}

/** 是否还存在阻断写入的未决项：未对应灯具、身份重复选定、通道争用未消解 */
export function findBlockingIssues(report: ReconcileReport, decisions: ReconcileDecisions): string[] {
  const issues: string[] = []

  // 一个本地灯具不能被多个控台灯对应
  const chosenOwners = new Map<string, string[]>()
  report.fixtureItems.forEach((item) => {
    const targetId = decisions.fixtures[item.key]?.fixtureId ?? null
    if (!targetId) return
    const owners = chosenOwners.get(targetId)
    if (owners) owners.push(item.consoleFixture.fixtureNo)
    else chosenOwners.set(targetId, [item.consoleFixture.fixtureNo])
  })
  chosenOwners.forEach((fixtureNos, fixtureId) => {
    if (fixtureNos.length > 1) {
      issues.push(`本地灯具 ${fixtureId} 被多盏控台灯同时对应：${fixtureNos.join('、')}，请改选或跳过`)
    }
  })

  report.fixtureItems.forEach((item) => {
    const decision = decisions.fixtures[item.key]
    if (!decision) {
      issues.push(`控台灯 ${item.consoleFixture.fixtureNo}（uid ${item.consoleUid}）尚未选定对应方式`)
      return
    }
    if (!decision.fixtureId) return // 显式跳过
    if (decision.channelChoice !== 'console') return // 保留本地通道不产生争用
    // 选用控台通道：检查最终落点是否与其他被选灯具撞号
    const targetChannel = item.consoleFixture.channel
    const clash = report.fixtureItems.find((other) => {
      if (other.key === item.key) return false
      const otherDecision = decisions.fixtures[other.key]
      if (!otherDecision?.fixtureId) return false
      const otherChannel = otherDecision.channelChoice === 'console' ? other.consoleFixture.channel : resolveLocalChannel(other)
      return otherChannel === targetChannel && otherDecision.fixtureId !== decision.fixtureId
    })
    if (clash) {
      issues.push(
        `通道争用未消解：控台灯 ${item.consoleFixture.fixtureNo} 与 ${clash.consoleFixture.fixtureNo} 写入后将争抢 CH${targetChannel}`
      )
    }
  })

  return issues
}

function resolveLocalChannel(item: FixtureReconcileItem): number {
  return item.channelDiff?.local ?? item.consoleFixture.channel
}

/** 汇总待写入计划；返回空计划代表没有需要落库的改动 */
export function buildApplyPlan(
  report: ReconcileReport,
  decisions: ReconcileDecisions
): { plan: ReconcileApplyPlan; blocked: string[] } {
  const blocked = findBlockingIssues(report, decisions)
  if (blocked.length > 0) return { plan: { fixtures: [], levels: [] }, blocked }

  const fixtures = report.fixtureItems
    .filter((item) => decisions.fixtures[item.key]?.fixtureId)
    .map((item) => {
      const decision = decisions.fixtures[item.key]
      return {
        fixtureId: decision.fixtureId as string,
        consoleUid: item.consoleUid,
        fixtureNo: item.consoleFixture.fixtureNo,
        channel: decision.channelChoice === 'console' ? item.consoleFixture.channel : (item.channelDiff?.local ?? item.consoleFixture.channel)
      }
    })

  const levels = report.levelItems.flatMap((item) => {
    const decision = decisions.levels[item.key]
    if (!decision || decision.choice !== 'console') return []
    if (item.consoleOff && decision.dropLocalOff) {
      return [{ cueId: item.cueId, fixtureId: item.fixtureId, intensity: 0, colorTempK: item.localColorTempK ?? 3200, remove: true }]
    }
    // 控台色温缺失：沿用本地既有色温，新建记录时落到常规基准 3200K
    const colorTempK = item.consoleColorTempK ?? item.localColorTempK ?? 3200
    return [{ cueId: item.cueId, fixtureId: item.fixtureId, intensity: item.consoleIntensity, colorTempK, remove: false }]
  })

  return { plan: { fixtures, levels }, blocked: [] }
}

/** 按控台 uid 索引灯具对账条目 */
export function fixtureItemByUid(report: ReconcileReport, uid: string): FixtureReconcileItem | null {
  return report.fixtureItems.find((item) => item.consoleUid === uid) ?? null
}
