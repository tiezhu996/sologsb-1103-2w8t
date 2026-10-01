import type { Cue } from '@/types/cue'
import type {
  CueReconcileItem,
  FixtureReconcileItem,
  FixtureIdentity,
  LevelFieldState,
  LevelReconcileItem,
  LocalOnlyFixture,
  SerializedReconcileReport
} from '@/types/consoleImport'
import type { ConsolePatchPackage } from '@/types/consoleImport'
import type { CueLevel } from '@/types/level'
import type { Fixture } from '@/types/fixture'
import { FIXTURE_POSITIONS, FIXTURE_TYPES } from '@/types/fixture'
import { normalizeCueNo } from '@/utils/cueOrder'

/** 阻断写入的待决问题 */
export interface ReconcileBlocker {
  kind: 'fixtureUndecided' | 'channelContention' | 'channelInvalid' | 'missingLevel' | 'cueUndecided'
  message: string
}

/** 对账报告（运行态，附带派生信息） */
export interface ReconcileReport {
  fixtures: FixtureReconcileItem[]
  cues: CueReconcileItem[]
  levels: LevelReconcileItem[]
  localOnly: LocalOnlyFixture[]
}

/** 生成灯具行 id */
function fixtureItemId(uid: string): string {
  return `fx::${uid}`
}

/** 生成电平行 id */
function levelItemId(cueNo: string, uid: string): string {
  return `lvl::${cueNo}::${uid}`
}

/**
 * 构建立账报告：
 * 1. 灯具身份优先查既有映射（uid），再按灯具编号、最后按通道号提示命中；
 * 2. Cue 按 cueNo 与本地对账；
 * 3. 逐 Cue × 逐灯具列出亮度 / 色温双方数据，缺失不默认覆盖。
 * 任何争议在用户选定前 decided=false，不允许写入。
 */
export function buildReconcileReport(
  pkg: ConsolePatchPackage,
  local: { fixtures: Fixture[]; cues: Cue[]; levels: CueLevel[]; identities: FixtureIdentity[] }
): ReconcileReport {
  const identityByUid = new Map(local.identities.map((identity) => [identity.uid, identity]))
  const localByFixtureNo = new Map<string, Fixture>()
  const localByChannel = new Map<number, Fixture>()
  local.fixtures.forEach((fixture) => {
    if (fixture.fixtureNo && !localByFixtureNo.has(fixture.fixtureNo)) localByFixtureNo.set(fixture.fixtureNo, fixture)
    if (!localByChannel.has(fixture.channel)) localByChannel.set(fixture.channel, fixture)
  })

  const fixtures: FixtureReconcileItem[] = pkg.fixtures.map((pkgFixture) => {
    const identity = identityByUid.get(pkgFixture.uid)
    const byNo = localByFixtureNo.get(pkgFixture.fixtureNo) ?? null
    const byChannel = localByChannel.get(pkgFixture.channel) ?? null
    const matched: Pick<FixtureReconcileItem, 'localFixtureId' | 'matchedBy'> =
      identity && local.fixtures.some((fixture) => fixture.id === identity.fixtureId)
        ? { localFixtureId: identity.fixtureId, matchedBy: 'identity' }
        : byNo
          ? { localFixtureId: byNo.id, matchedBy: 'fixtureNo' }
          : byChannel
            ? { localFixtureId: byChannel.id, matchedBy: 'channel' }
            : { localFixtureId: null, matchedBy: 'none' }

    const localFixture = matched.localFixtureId
      ? (local.fixtures.find((fixture) => fixture.id === matched.localFixtureId) ?? null)
      : null

    const hasNoConflict = !!localFixture && localFixture.fixtureNo !== pkgFixture.fixtureNo
    const hasChannelChange = !!localFixture && localFixture.channel !== pkgFixture.channel
    // 干净行（身份 / 灯号命中且无任何争议）自动确认；换号、换通道、仅按通道猜中都需要人工确认
    const clean =
      !!localFixture &&
      !hasNoConflict &&
      !hasChannelChange &&
      (matched.matchedBy === 'identity' || matched.matchedBy === 'fixtureNo')

    return {
      itemId: fixtureItemId(pkgFixture.uid),
      uid: pkgFixture.uid,
      pkg: pkgFixture,
      localFixtureId: matched.localFixtureId,
      matchedBy: matched.matchedBy,

      action: localFixture ? 'existing' : 'create',

      pkgFixtureNo: pkgFixture.fixtureNo,
      localFixtureNo: localFixture?.fixtureNo ?? '',
      hasNoConflict,
      fixtureNoChoice: 'package',

      pkgChannel: pkgFixture.channel,
      localChannel: localFixture?.channel ?? null,
      hasChannelChange,
      hasChannelContention: false,
      channelChoice: localFixture ? 'package' : 'package',
      customChannel: null,
      contenderIds: [],

      createPosition: FIXTURE_POSITIONS[0],
      createFixtureType: FIXTURE_TYPES[0],
      decided: clean
    }
  })

  // Cue 对账：按编号匹配本地 Cue
  const localCueByNo = new Map<string, Cue>()
  local.cues.forEach((cue) => localCueByNo.set(normalizeCueNo(cue.cueNo), cue))
  const cues: CueReconcileItem[] = pkg.cues.map((pkgCue) => {
    const cueNo = normalizeCueNo(pkgCue.cueNo)
    const localCue = localCueByNo.get(cueNo) ?? null
    return {
      cueNo: pkgCue.cueNo,
      normalizedCueNo: cueNo,
      localCueId: localCue?.id ?? null,
      pkgLevelCount: pkgCue.levels.length,
      createLocal: false,
      decided: !!localCue
    }
  })

  // 逐 Cue × 逐灯具建立电平行（仅保留包内出现过的组合）
  const levels: LevelReconcileItem[] = []
  const fixtureByItemId = new Map(fixtures.map((item) => [item.itemId, item]))
  pkg.cues.forEach((pkgCue) => {
    const cueNo = normalizeCueNo(pkgCue.cueNo)
    const cueItem = cues.find((item) => item.normalizedCueNo === cueNo)
    pkgCue.levels.forEach((pkgLevel) => {
      const fixtureItem = fixtureByItemId.get(fixtureItemId(pkgLevel.uid))
      if (!fixtureItem) return // 引用了包内不存在的灯具，忽略（解析阶段已校验不会发生）
      const localCueId = cueItem?.localCueId ?? null
      const localLevel =
        localCueId && fixtureItem.localFixtureId
          ? (local.levels.find(
              (level) => level.cueId === localCueId && level.fixtureId === fixtureItem.localFixtureId
            ) ?? null)
          : null

      levels.push({
        itemId: levelItemId(cueNo, pkgLevel.uid),
        uid: pkgLevel.uid,
        localFixtureId: fixtureItem.localFixtureId,
        normalizedCueNo: cueNo,
        localCueId,
        fixtureItemId: fixtureItem.itemId,
        intensity: buildFieldState(pkgLevel.intensity ?? null, localLevel?.intensity ?? null),
        colorTemp: buildFieldState(pkgLevel.colorTempK ?? null, localLevel?.colorTempK ?? null)
      })
    })
  })

  // 本地有、包里没有的灯具（默认保留，仅展示提醒）
  const pkgUidSet = new Set(pkg.fixtures.map((fixture) => fixture.uid))
  const mappedFixtureIds = new Set(
    local.identities.filter((identity) => pkgUidSet.has(identity.uid)).map((identity) => identity.fixtureId)
  )
  const localOnly: LocalOnlyFixture[] = local.fixtures
    .filter((fixture) => !mappedFixtureIds.has(fixture.id))
    .map((fixture) => ({
      fixtureId: fixture.id,
      channel: fixture.channel,
      fixtureNo: fixture.fixtureNo,
      position: fixture.position,
      fixtureType: fixture.fixtureType
    }))

  return { fixtures, cues, levels, localOnly }
}

/** 单字段初始状态：有值差异默认采用控台；控台缺失必须人工确认 */
function buildFieldState(pkgValue: number | null, localValue: number | null): LevelFieldState {
  const missing = pkgValue === null
  const mismatch = !missing && localValue !== null && pkgValue !== localValue
  return {
    pkgValue,
    localValue,
    missing,
    mismatch,
    missingChoice: 'keepLocal',
    // 有值（含双方不一致）默认采纳控台；缺失必须先选定处置
    decided: !missing
  }
}

/** 灯具行当前生效的通道号（依处置而定） */
export function effectiveChannelOf(item: FixtureReconcileItem): number | null {
  if (item.action === 'skip') return null
  if (item.localFixtureId && item.action === 'existing') {
    if (item.channelChoice === 'local') return item.localChannel
    if (item.channelChoice === 'custom') return item.customChannel
    return item.pkgChannel
  }
  // 新建
  if (item.channelChoice === 'custom') return item.customChannel
  return item.pkgChannel
}

/** 电平行所属灯具 / Cue 是否仍参与写入 */
export function isLevelRowActive(report: ReconcileReport, row: LevelReconcileItem): boolean {
  const fixtureItem = report.fixtures.find((item) => item.itemId === row.fixtureItemId)
  if (!fixtureItem || fixtureItem.action === 'skip') return false
  const cueItem = report.cues.find((item) => item.normalizedCueNo === row.normalizedCueNo)
  if (!cueItem) return false
  if (!cueItem.localCueId && !cueItem.createLocal) return false
  return true
}

/** 计算字段最终写入值；null 表示该字段不写入 */
export function resolveFieldValue(field: LevelFieldState): number | null {
  if (field.pkgValue !== null) return field.pkgValue
  // 控台缺失
  if (field.missingChoice === 'writeZero') return 0
  if (field.missingChoice === 'keepLocal') return field.localValue
  return null // skip
}

/**
 * 汇总阻断写入的待决问题（换号 / 通道争用 / 电平缺失先列双方数据，选定后才放行）。
 * 通道争用同时核对本地现有灯具：新灯具占用了既配通道、或现有灯具改到别的灯所在通道，都阻断。
 */
export function evaluateReport(report: ReconcileReport, localFixtures: readonly Fixture[] = []): {
  blockers: ReconcileBlocker[]
  canCommit: boolean
} {
  const blockers: ReconcileBlocker[] = []
  /** 通道号 -> 选定占用者（ownerFixtureId 为 null 表示新建行） */
  const chosenByChannel = new Map<number, Array<{ itemId: string; ownerFixtureId: string | null }>>()

  report.fixtures.forEach((item) => {
    const label = item.pkgFixtureNo ? `灯号 ${item.pkgFixtureNo}` : `灯具 ${item.uid}`
    if (item.action === 'skip') return
    const channel = effectiveChannelOf(item)
    if (channel === null) {
      blockers.push({ kind: 'channelInvalid', message: `${label}：请选择或填写通道号` })
    } else if (!Number.isInteger(channel) || channel < 1 || channel > 512) {
      blockers.push({ kind: 'channelInvalid', message: `${label}：通道号 CH${channel} 超出 1-512` })
    } else {
      const list = chosenByChannel.get(channel) ?? []
      list.push({ itemId: item.itemId, ownerFixtureId: item.localFixtureId })
      chosenByChannel.set(channel, list)
    }
    if (!item.decided) {
      blockers.push({
        kind: 'fixtureUndecided',
        message:
          item.localFixtureId === null
            ? `${label}：新灯具，请确认新建或跳过`
            : item.hasChannelChange
              ? `${label}：通道由 CH${item.localChannel ?? '?'} 改为 CH${item.pkgChannel}，请确认`
              : item.hasNoConflict
                ? `${label}：灯号由「${item.localFixtureNo || '空'}」改为「${item.pkgFixtureNo}」，请确认`
                : `${label}：请确认身份对应关系`
      })
    }
  })

  // 参与对账的行之间争用：同一通道被两个不同身份（含新建）选中
  chosenByChannel.forEach((occupants, channel) => {
    const ownerKeys = occupants.map((entry) => entry.ownerFixtureId ?? `new::${entry.itemId}`)
    if (new Set(ownerKeys).size > 1) {
      blockers.push({ kind: 'channelContention', message: `CH${channel} 被 ${occupants.length} 盏灯具争用，请重新分配` })
    }
  })

  // 与本地既有灯具争用（统一按通道判定）：
  // 选定通道上存在不属于任何选中现有灯具的本地灯具即争用。
  // 覆盖：新建灯占了既配通道；现有灯改到别的灯所在通道（自己留在原通道不算）。
  chosenByChannel.forEach((occupants, channel) => {
    const movedOwnerIds = new Set(
      occupants.filter((entry) => entry.ownerFixtureId !== null).map((entry) => entry.ownerFixtureId as string)
    )
    const foreignLocals = localFixtures.filter(
      (fixture) => fixture.channel === channel && !movedOwnerIds.has(fixture.id)
    )
    if (foreignLocals.length > 0) {
      const names = foreignLocals.map((fixture) => fixture.fixtureNo || `${fixture.position} CH${fixture.channel}`)
      blockers.push({
        kind: 'channelContention',
        message: `CH${channel} 与本地已配接灯具（${names.join('、')}）争用，请重新分配`
      })
    }
  })

  report.cues.forEach((cue) => {
    if (!cue.localCueId && !cue.decided) {
      blockers.push({ kind: 'cueUndecided', message: `${cue.cueNo}：本地没有该 Cue，请选择新建或跳过` })
    }
  })

  const activeRows = report.levels.filter((row) => isLevelRowActive(report, row))
  activeRows.forEach((row) => {
    const fixtureItem = report.fixtures.find((item) => item.itemId === row.fixtureItemId)
    const label = `${row.normalizedCueNo} × ${fixtureItem?.pkgFixtureNo ?? row.uid}`
    if (!row.intensity.decided) {
      blockers.push({ kind: 'missingLevel', message: `${label}：控台亮度缺失，请选择保留本地 / 写 0 / 跳过` })
    }
    if (!row.colorTemp.decided) {
      blockers.push({ kind: 'missingLevel', message: `${label}：控台色温缺失，请选择保留本地 / 写 0 / 跳过` })
    }
  })

  return { blockers, canCommit: blockers.length === 0 }
}

/** 报告统计（供页面展示） */
export function summarizeReport(report: ReconcileReport): {
  matchedFixtures: number
  newFixtures: number
  skippedFixtures: number
  changedChannels: number
  noConflicts: number
  matchedCues: number
  newCues: number
  levelCells: number
  missingFields: number
  mismatchFields: number
} {
  return {
    matchedFixtures: report.fixtures.filter((item) => item.action === 'existing').length,
    newFixtures: report.fixtures.filter((item) => item.action === 'create').length,
    skippedFixtures: report.fixtures.filter((item) => item.action === 'skip').length,
    changedChannels: report.fixtures.filter((item) => item.action !== 'skip' && item.hasChannelChange).length,
    noConflicts: report.fixtures.filter((item) => item.hasNoConflict).length,
    matchedCues: report.cues.filter((item) => !!item.localCueId).length,
    newCues: report.cues.filter((item) => !item.localCueId && item.createLocal).length,
    levelCells: report.levels.length,
    missingFields: report.levels.reduce(
      (sum, row) => sum + (row.intensity.missing ? 1 : 0) + (row.colorTemp.missing ? 1 : 0),
      0
    ),
    mismatchFields: report.levels.reduce(
      (sum, row) => sum + (row.intensity.mismatch ? 1 : 0) + (row.colorTemp.mismatch ? 1 : 0),
      0
    )
  }
}

/** 序列化为可持久化结构（报告本身就是纯数据，规范化 cueNo 后存入） */
export function serializeReport(report: ReconcileReport): SerializedReconcileReport {
  return {
    fixtures: report.fixtures,
    levels: report.levels,
    cues: report.cues,
    localOnly: report.localOnly
  }
}

/** 从持久化结构恢复报告 */
export function deserializeReport(data: SerializedReconcileReport): ReconcileReport {
  return {
    fixtures: data.fixtures,
    levels: data.levels,
    cues: data.cues,
    localOnly: data.localOnly
  }
}
