import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CueLevel } from '@/types/level'
import { INTENSITY_MAX, INTENSITY_MIN } from '@/types/level'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'

/** 通道电平补丁 */
export interface CueLevelPatch {
  intensity?: number
  colorTempK?: number
  focusNote?: string
}

function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(INTENSITY_MAX, Math.max(INTENSITY_MIN, Math.round(value)))
}

/**
 * CueLevel 通道电平仓库：按 (cueId, fixtureId) 唯一，跨页共享电平设定。
 */
export const useLevelStore = defineStore('level', () => {
  const levels = ref<CueLevel[]>([])
  const hydrated = ref(false)

  const levelsByCue = computed<Record<string, CueLevel[]>>(() => {
    const grouped: Record<string, CueLevel[]> = {}
    levels.value.forEach((level) => {
      if (!grouped[level.cueId]) grouped[level.cueId] = []
      grouped[level.cueId].push(level)
    })
    return grouped
  })

  function levelsOfCue(cueId: string): CueLevel[] {
    return levelsByCue.value[cueId] ?? []
  }

  function levelOf(cueId: string, fixtureId: string): CueLevel | null {
    return levels.value.find((level) => level.cueId === cueId && level.fixtureId === fixtureId) ?? null
  }

  /** 通道平均亮度，用于灯位配置台展示通道芯片的亮度 */
  function averageIntensityOfFixture(fixtureId: string): number | null {
    const matched = levels.value.filter((level) => level.fixtureId === fixtureId)
    if (matched.length === 0) return null
    const total = matched.reduce((sum, level) => sum + level.intensity, 0)
    return Math.round(total / matched.length)
  }

  function countOfCue(cueId: string): number {
    return levelsOfCue(cueId).length
  }

  async function hydrate(): Promise<void> {
    levels.value = await db.levels.toArray()
    hydrated.value = true
  }

  async function upsertLevel(cueId: string, fixtureId: string, patch: CueLevelPatch): Promise<CueLevel> {
    const existing = levelOf(cueId, fixtureId)
    const now = Date.now()
    if (existing) {
      const next: CueLevel = {
        ...existing,
        intensity: patch.intensity === undefined ? existing.intensity : clampIntensity(patch.intensity),
        colorTempK: patch.colorTempK === undefined ? existing.colorTempK : Math.round(patch.colorTempK),
        focusNote: patch.focusNote === undefined ? existing.focusNote : patch.focusNote,
        updatedAt: now
      }
      await db.levels.put(next)
      levels.value = levels.value.map((level) => (level.id === next.id ? next : level))
      return next
    }
    const created: CueLevel = {
      id: createId('lvl'),
      cueId,
      fixtureId,
      intensity: clampIntensity(patch.intensity ?? 0),
      colorTempK: Math.round(patch.colorTempK ?? 3200),
      focusNote: patch.focusNote ?? '',
      updatedAt: now
    }
    await db.levels.put(created)
    levels.value = [...levels.value, created]
    return created
  }

  async function removeLevel(cueId: string, fixtureId: string): Promise<void> {
    const target = levelOf(cueId, fixtureId)
    if (!target) return
    await db.levels.delete(target.id)
    levels.value = levels.value.filter((level) => level.id !== target.id)
  }

  async function removeByCue(cueId: string): Promise<void> {
    const ids = levelsOfCue(cueId).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => level.cueId !== cueId)
  }

  async function removeByFixture(fixtureId: string): Promise<void> {
    const ids = levels.value.filter((level) => level.fixtureId === fixtureId).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => level.fixtureId !== fixtureId)
  }

  async function removeByCues(cueIds: readonly string[]): Promise<void> {
    const removing = new Set(cueIds)
    const ids = levels.value.filter((level) => removing.has(level.cueId)).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => !removing.has(level.cueId))
  }

  /**
   * 对账写入：按 (cueId, fixtureId) 幂等地批量应用控台亮度 / 色温。
   * remove=true 表示控台报零电平且裁决删除本地记录（使该通道退出本 Cue）。
   */
  async function applyReconcileLevels(
    writes: ReadonlyArray<{ cueId: string; fixtureId: string; intensity: number; colorTempK: number; remove: boolean }>
  ): Promise<number> {
    if (writes.length === 0) return 0
    const now = Date.now()
    const toPut: CueLevel[] = []
    const toDelete: string[] = []

    writes.forEach((write) => {
      const existing = levelOf(write.cueId, write.fixtureId)
      if (write.remove) {
        if (existing) toDelete.push(existing.id)
        return
      }
      const intensity = clampIntensity(write.intensity)
      const colorTempK = Math.round(write.colorTempK)
      if (existing) {
        if (existing.intensity === intensity && existing.colorTempK === colorTempK) return
        toPut.push({ ...existing, intensity, colorTempK, updatedAt: now })
      } else {
        toPut.push({
          id: createId('lvl'),
          cueId: write.cueId,
          fixtureId: write.fixtureId,
          intensity,
          colorTempK,
          focusNote: '',
          updatedAt: now
        })
      }
    })

    if (toPut.length > 0) await db.levels.bulkPut(toPut)
    if (toDelete.length > 0) await db.levels.bulkDelete(toDelete)

    const putMap = new Map(toPut.map((level) => [level.id, level]))
    const deleteSet = new Set(toDelete)
    levels.value = [
      ...levels.value.filter((level) => !deleteSet.has(level.id) && !putMap.has(level.id)),
      ...toPut
    ]
    return toPut.length + toDelete.length
  }

  return {
    levels,
    hydrated,
    levelsByCue,
    levelsOfCue,
    levelOf,
    averageIntensityOfFixture,
    countOfCue,
    hydrate,
    upsertLevel,
    applyReconcileLevels,
    removeLevel,
    removeByCue,
    removeByFixture,
    removeByCues
  }
})
