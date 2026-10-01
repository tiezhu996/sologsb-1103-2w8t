import type { ConsoleCue, ConsoleFixture, ConsolePackage } from '@/types/console'
import { CONSOLE_PACKAGE_FORMAT, CONSOLE_PACKAGE_KIND } from '@/types/console'
import { DMX_CHANNEL_MAX, DMX_CHANNEL_MIN } from '@/types/fixture'
import { COLOR_TEMP_MAX, COLOR_TEMP_MIN, INTENSITY_MAX, INTENSITY_MIN } from '@/types/level'
import { isValidCueNo, normalizeCueNo } from '@/utils/cueOrder'

/** 配接包解析结果 */
export interface ParseConsoleResult {
  ok: boolean
  pkg: ConsolePackage | null
  /** 规范化后的原文（重排空白后用于哈希？否——哈希按原文），此处返回解析错误信息 */
  errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 解析并严格校验控台配接包。
 * 包内自身不合法（缺字段、灯号重复、通道越界、电平引用未知灯具等）会逐条列出错误，
 * 校验通过前不生成任何对账记录。
 */
export function parseConsolePackage(rawText: string): ParseConsoleResult {
  const errors: string[] = []
  let data: unknown
  try {
    data = JSON.parse(rawText)
  } catch {
    return { ok: false, pkg: null, errors: ['文件不是合法 JSON，无法解析为控台配接包'] }
  }

  if (!isRecord(data)) {
    return { ok: false, pkg: null, errors: ['配接包根结构必须是 JSON 对象'] }
  }
  if (data.kind !== CONSOLE_PACKAGE_KIND) {
    errors.push(`缺少或不匹配的 kind 标识：期望 ${CONSOLE_PACKAGE_KIND}`)
  }
  if (data.format !== CONSOLE_PACKAGE_FORMAT) {
    errors.push(`不支持的配接包格式版本：期望 ${CONSOLE_PACKAGE_FORMAT}，实际为 ${String(data.format)}`)
  }
  if (typeof data.source !== 'string' || !data.source.trim()) {
    errors.push('缺少控台 / 现场标识 source')
  }
  if (typeof data.exportedAt !== 'string' || !data.exportedAt.trim()) {
    errors.push('缺少导出时间 exportedAt')
  }
  if (!Array.isArray(data.fixtures)) {
    errors.push('fixtures 必须是灯具数组')
  }
  if (!Array.isArray(data.cues)) {
    errors.push('cues 必须是 Cue 数组')
  }
  if (errors.length > 0 || !Array.isArray(data.fixtures) || !Array.isArray(data.cues)) {
    return { ok: false, pkg: null, errors }
  }

  const fixtures = parseFixtures(data.fixtures, errors)
  const knownUids = new Set(fixtures.map((fixture) => fixture.uid))
  const cues = parseCues(data.cues, knownUids, errors)

  if (errors.length > 0) {
    return { ok: false, pkg: null, errors }
  }

  const pkg: ConsolePackage = {
    kind: CONSOLE_PACKAGE_KIND,
    format: CONSOLE_PACKAGE_FORMAT,
    source: String(data.source).trim(),
    exportedAt: String(data.exportedAt).trim(),
    fixtures,
    cues
  }
  return { ok: true, pkg, errors: [] }
}

function parseFixtures(input: unknown[], errors: string[]): ConsoleFixture[] {
  const fixtures: ConsoleFixture[] = []
  const seenUids = new Set<string>()
  input.forEach((raw, index) => {
    const where = `fixtures[${index + 1}]`
    if (!isRecord(raw)) {
      errors.push(`${where} 不是对象`)
      return
    }
    const uid = typeof raw.uid === 'string' ? raw.uid.trim() : ''
    const fixtureNo = typeof raw.fixtureNo === 'string' ? raw.fixtureNo.trim() : ''
    if (!uid) {
      errors.push(`${where} 缺少稳定灯具身份 uid`)
      return
    }
    if (seenUids.has(uid)) {
      errors.push(`${where} 灯具身份 uid「${uid}」在包内重复`)
      return
    }
    seenUids.add(uid)
    if (!fixtureNo) {
      errors.push(`${where}（uid ${uid}）缺少灯具编号 fixtureNo`)
    }
    if (!isFiniteNumber(raw.channel) || !Number.isInteger(raw.channel)) {
      errors.push(`${where}（uid ${uid}）通道号必须为整数`)
    } else if (raw.channel < DMX_CHANNEL_MIN || raw.channel > DMX_CHANNEL_MAX) {
      errors.push(`${where}（uid ${uid}）通道号 ${raw.channel} 超出 ${DMX_CHANNEL_MIN}-${DMX_CHANNEL_MAX}`)
    }
    fixtures.push({
      uid,
      fixtureNo: fixtureNo || uid,
      channel: Number(raw.channel),
      fixtureType: typeof raw.fixtureType === 'string' ? raw.fixtureType.trim() : undefined
    })
  })
  return fixtures
}

function parseCues(input: unknown[], knownUids: Set<string>, errors: string[]): ConsoleCue[] {
  const cues: ConsoleCue[] = []
  const seenCueNos = new Set<string>()
  input.forEach((raw, index) => {
    const where = `cues[${index + 1}]`
    if (!isRecord(raw)) {
      errors.push(`${where} 不是对象`)
      return
    }
    const cueNoRaw = typeof raw.cueNo === 'string' ? raw.cueNo.trim() : ''
    if (!isValidCueNo(cueNoRaw)) {
      errors.push(`${where} 的 cueNo「${cueNoRaw}」不是合法编号（形如 Q12 / Q12.5）`)
      return
    }
    const cueNo = normalizeCueNo(cueNoRaw)
    if (seenCueNos.has(cueNo)) {
      errors.push(`${where} Cue 编号 ${cueNo} 在包内重复`)
      return
    }
    seenCueNos.add(cueNo)
    if (!Array.isArray(raw.levels)) {
      errors.push(`${where}（${cueNo}）的 levels 必须是数组`)
      return
    }
    const levels = raw.levels.map((levelRaw, levelIndex) => {
      const levelWhere = `${where}.levels[${levelIndex + 1}]`
      if (!isRecord(levelRaw)) {
        errors.push(`${levelWhere} 不是对象`)
        return null
      }
      const fixtureUid = typeof levelRaw.fixtureUid === 'string' ? levelRaw.fixtureUid.trim() : ''
      if (!fixtureUid || !knownUids.has(fixtureUid)) {
        errors.push(`${levelWhere} 引用了包内不存在的灯具 uid「${fixtureUid}」`)
        return null
      }
      if (!isFiniteNumber(levelRaw.intensity)) {
        errors.push(`${levelWhere}（${cueNo} / ${fixtureUid}）亮度缺失或不是数字`)
        return null
      }
      if (levelRaw.intensity < INTENSITY_MIN || levelRaw.intensity > INTENSITY_MAX) {
        errors.push(`${levelWhere}（${cueNo} / ${fixtureUid}）亮度 ${levelRaw.intensity} 超出 0-100`)
        return null
      }
      let colorTempK: number | undefined
      if (levelRaw.colorTempK !== undefined && levelRaw.colorTempK !== null) {
        if (!isFiniteNumber(levelRaw.colorTempK) || !Number.isInteger(levelRaw.colorTempK)) {
          errors.push(`${levelWhere}（${cueNo} / ${fixtureUid}）色温必须为整数 K`)
          return null
        }
        if (levelRaw.colorTempK < COLOR_TEMP_MIN || levelRaw.colorTempK > COLOR_TEMP_MAX) {
          errors.push(`${levelWhere}（${cueNo} / ${fixtureUid}）色温 ${levelRaw.colorTempK}K 超出允许范围`)
          return null
        }
        colorTempK = levelRaw.colorTempK
      }
      return { fixtureUid, intensity: levelRaw.intensity, colorTempK }
    })
    cues.push({ cueNo, levels: levels.filter((item): item is NonNullable<typeof item> => item !== null) })
  })
  return cues
}

/**
 * 计算原文的 SHA-256 十六进制摘要作为幂等键。
 * 同一控台包重传（哪怕换了文件名）哈希一致，不会重复生成导入任务。
 */
export async function hashPackageText(rawText: string): Promise<string> {
  const buffer = new TextEncoder().encode(rawText)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
