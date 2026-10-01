import {
  CONSOLE_PACKAGE_FORMAT,
  CONSOLE_PACKAGE_SUPPORTED_VERSIONS,
  type ConsoleCue,
  type ConsoleCueLevel,
  type ConsoleFixture,
  type ConsolePatchPackage,
  type ParsePackageResult
} from '@/types/consoleImport'
import { COLOR_TEMP_MAX, COLOR_TEMP_MIN } from '@/types/level'
import { DMX_CHANNEL_MAX, DMX_CHANNEL_MIN } from '@/types/fixture'
import { normalizeCueNo, CUE_NO_PATTERN } from '@/utils/cueOrder'

function failure(message: string): ParsePackageResult {
  return { ok: false, message, pkg: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

/** 严格但宽容地解析配接包：结构错误直接拒绝，字段缺失的电平留待对账阶段处理 */
export function parseConsolePackage(raw: string): ParsePackageResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return failure('配接包不是合法的 JSON 文件，请确认导出未被截断。')
  }
  if (!isRecord(json)) return failure('配接包根结构必须是对象。')

  if (json.format !== CONSOLE_PACKAGE_FORMAT) {
    return failure(`配接包格式标识不匹配（期望 ${CONSOLE_PACKAGE_FORMAT}）。`)
  }
  const version = asFiniteNumber(json.version)
  if (version === null || !(CONSOLE_PACKAGE_SUPPORTED_VERSIONS as readonly number[]).includes(version)) {
    return failure(`不支持的配接包版本：${String(json.version)}。`)
  }
  if (typeof json.packageId !== 'string' || !json.packageId.trim()) {
    return failure('配接包缺少 packageId（同一包重试去重依赖该字段）。')
  }
  if (!Array.isArray(json.fixtures)) return failure('配接包缺少 fixtures 列表。')
  if (!Array.isArray(json.cues)) return failure('配接包缺少 cues 列表。')

  const fixtureErrors: string[] = []
  const fixtures: ConsoleFixture[] = []
  const uidSet = new Set<string>()
  json.fixtures.forEach((entry, index) => {
    if (!isRecord(entry)) {
      fixtureErrors.push(`第 ${index + 1} 盏灯具不是对象`)
      return
    }
    const uid = typeof entry.uid === 'string' ? entry.uid.trim() : ''
    const fixtureNo = typeof entry.fixtureNo === 'string' ? entry.fixtureNo.trim() : ''
    const channel = asFiniteNumber(entry.channel)
    if (!uid) return fixtureErrors.push(`第 ${index + 1} 盏灯具缺少 uid`)
    if (uidSet.has(uid)) return fixtureErrors.push(`灯具 uid 重复：${uid}`)
    uidSet.add(uid)
    if (!fixtureNo) return fixtureErrors.push(`灯具 ${uid} 缺少 fixtureNo（灯具编号）`)
    if (channel === null || !Number.isInteger(channel) || channel < DMX_CHANNEL_MIN || channel > DMX_CHANNEL_MAX) {
      return fixtureErrors.push(`灯具 ${fixtureNo}（${uid}）通道号非法，需为 ${DMX_CHANNEL_MIN}-${DMX_CHANNEL_MAX} 的整数`)
    }
    fixtures.push({
      uid,
      fixtureNo,
      channel,
      model: typeof entry.model === 'string' ? entry.model.trim() : undefined
    })
  })
  if (fixtureErrors.length > 0) return failure(`灯具数据有误：${fixtureErrors.slice(0, 5).join('；')}。`)

  const cueErrors: string[] = []
  const cues: ConsoleCue[] = []
  const cueNoSet = new Set<string>()
  json.cues.forEach((entry, index) => {
    if (!isRecord(entry)) {
      cueErrors.push(`第 ${index + 1} 条 Cue 不是对象`)
      return
    }
    const rawCueNo = typeof entry.cueNo === 'string' ? entry.cueNo : ''
    const cueNo = normalizeCueNo(rawCueNo)
    if (!cueNo || !CUE_NO_PATTERN.test(cueNo)) {
      return cueErrors.push(`第 ${index + 1} 条 Cue 编号非法（${rawCueNo || '空'}），需形如 Q12 / Q12.5`)
    }
    if (cueNoSet.has(cueNo)) return cueErrors.push(`Cue 编号重复：${cueNo}`)
    cueNoSet.add(cueNo)

    const rawLevels = Array.isArray(entry.levels) ? entry.levels : []
    const levels: ConsoleCueLevel[] = []
    const levelUidSet = new Set<string>()
    rawLevels.forEach((levelEntry, levelIndex) => {
      if (!isRecord(levelEntry)) {
        cueErrors.push(`${cueNo} 第 ${levelIndex + 1} 条电平不是对象`)
        return
      }
      const uid = typeof levelEntry.uid === 'string' ? levelEntry.uid.trim() : ''
      if (!uid) {
        cueErrors.push(`${cueNo} 第 ${levelIndex + 1} 条电平缺少 uid`)
        return
      }
      if (levelUidSet.has(uid)) {
        cueErrors.push(`${cueNo} 中灯具 ${uid} 的电平重复`)
        return
      }
      levelUidSet.add(uid)
      const intensity = normalizeOptionalLevel(levelEntry.intensity)
      const colorTempK = normalizeOptionalLevel(levelEntry.colorTempK)
      if (intensity.invalid) cueErrors.push(`${cueNo} 灯具 ${uid} 亮度非法（0-100），或留空表示缺失`)
      if (colorTempK.invalid) {
        cueErrors.push(`${cueNo} 灯具 ${uid} 色温非法（${COLOR_TEMP_MIN}-${COLOR_TEMP_MAX}K），或留空表示缺失`)
      }
      levels.push({ uid, intensity: intensity.value, colorTempK: colorTempK.value })
    })
    cues.push({ cueNo, levels })
  })
  if (cueErrors.length > 0) return failure(`Cue 数据有误：${cueErrors.slice(0, 5).join('；')}。`)

  // 电平引用了包内不存在的灯具时给出警告但不拒绝（对账行会标出无对应灯具）
  const pkg: ConsolePatchPackage = {
    format: CONSOLE_PACKAGE_FORMAT,
    version,
    packageId: json.packageId.trim(),
    consoleName: typeof json.consoleName === 'string' ? json.consoleName.trim() : '',
    exportedAt: typeof json.exportedAt === 'string' ? json.exportedAt.trim() : '',
    fixtures,
    cues
  }
  return { ok: true, message: '', pkg }
}

/** 归一化可选电平：缺省 / null → null（缺失），越界 → invalid */
function normalizeOptionalLevel(value: unknown): { value: number | null; invalid: boolean } {
  if (value === undefined || value === null) return { value: null, invalid: false }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { value: null, invalid: true }
  return { value: value, invalid: false }
}
