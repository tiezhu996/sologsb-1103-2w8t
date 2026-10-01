<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NRadio,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useImportJobStore } from '@/stores/importJobStore'
import type { Fixture } from '@/types/fixture'
import type { FixtureReconcileItem, LevelReconcileItem, ReconcileDecisions } from '@/types/console'
import { buildApplyPlan, ensureDefaultDecisions, findBlockingIssues } from '@/utils/reconcile'
import { sortFixturesByChannel } from '@/utils/patch'
import { formatDateTime } from '@/utils/fade'

const props = defineProps<{ sessionId: string; jobId: string }>()
const emit = defineEmits<{ applied: []; back: [] }>()

const message = useMessage()
const dialog = useDialog()
const importJobStore = useImportJobStore()
const fixtureStore = useFixtureStore()
const cueStore = useCueStore()

const saving = ref(false)
const applying = ref(false)

const job = computed(() => importJobStore.jobById(props.jobId))
const pkg = computed(() => job.value?.pkg ?? null)

const working = ref<ReconcileDecisions>({ fixtures: {}, levels: {} })
watch(
  job,
  (value) => {
    if (value) working.value = { fixtures: { ...value.decisions.fixtures }, levels: { ...value.decisions.levels } }
  },
  { immediate: true }
)

/** 依据本地最新配接 / Cue / 电平实时对账：重导沿用 consoleUid 身份，不按通道号硬盖 */
const report = computed(() => {
  const current = job.value
  if (!current?.pkg) return current?.report ?? null
  return importJobStore.recomputeReport(current, working.value) ?? current.report
})

const mergedDecisions = computed<ReconcileDecisions>(() =>
  report.value ? ensureDefaultDecisions(report.value, working.value) : working.value
)

const blocking = computed(() => (report.value ? findBlockingIssues(report.value, mergedDecisions.value) : []))

const planPreview = computed(() =>
  report.value ? buildApplyPlan(report.value, mergedDecisions.value).plan : { fixtures: [], levels: [] }
)

const fixtureConflictCount = computed(() => report.value?.fixtureItems.filter((item) => item.status === 'conflict').length ?? 0)
const levelConflictCount = computed(() => report.value?.levelItems.filter((item) => item.status === 'conflict').length ?? 0)

const localFixtures = computed(() =>
  props.sessionId ? sortFixturesByChannel(fixtureStore.fixturesOfSession(props.sessionId)) : []
)

const fixtureById = computed(() => {
  const map = new Map<string, Fixture>()
  localFixtures.value.forEach((fixture) => map.set(fixture.id, fixture))
  return map
})

/** 控台 uid → 当前选定的本地灯具 id（用于下拉里禁用已被别的控台灯占用项） */
const claimedByOther = computed(() => {
  const claimed = new Map<string, string>()
  report.value?.fixtureItems.forEach((item) => {
    const id = mergedDecisions.value.fixtures[item.key]?.fixtureId
    if (id) claimed.set(id, item.consoleUid)
  })
  return claimed
})

const localFixtureOptions = computed(() =>
  localFixtures.value.map((fixture) => ({
    label: `CH${fixture.channel} · ${fixture.fixtureNo || '（无编号）'} · ${fixture.position} · ${fixture.fixtureType}`,
    value: fixture.id
  }))
)

function selectOptionsFor(item: FixtureReconcileItem) {
  return localFixtureOptions.value.map((option) => ({
    ...option,
    disabled: claimedByOther.value.get(option.value) !== undefined && claimedByOther.value.get(option.value) !== item.consoleUid
  }))
}

function contentionLabel(item: FixtureReconcileItem): string {
  if (!item.contentionFixtureId) return ''
  const occupant = fixtureById.value.get(item.contentionFixtureId)
  return occupant ? `CH${occupant.channel} 现由 ${occupant.fixtureNo || '（无编号）'} 占用` : '目标通道已被占用'
}

async function persist(): Promise<void> {
  if (!job.value) return
  saving.value = true
  try {
    await importJobStore.saveDecisions(job.value.id, working.value)
  } finally {
    saving.value = false
  }
}

async function changeFixtureMapping(item: FixtureReconcileItem, value: string | null): Promise<void> {
  const nextFixtures = {
    ...working.value.fixtures,
    [item.key]: {
      fixtureId: value,
      channelChoice: working.value.fixtures[item.key]?.channelChoice ?? 'console'
    }
  }
  working.value = { ...working.value, fixtures: nextFixtures }
  // 身份改选会改变电平差异集合，补齐新出现条目的默认选定
  const refreshed = job.value ? importJobStore.recomputeReport(job.value, working.value) : null
  if (refreshed) working.value = ensureDefaultDecisions(refreshed, working.value)
  await persist()
}

async function changeChannelChoice(item: FixtureReconcileItem, choice: 'console' | 'local'): Promise<void> {
  const current = working.value.fixtures[item.key]
  if (!current) return
  working.value = {
    ...working.value,
    fixtures: { ...working.value.fixtures, [item.key]: { ...current, channelChoice: choice } }
  }
  await persist()
}

async function changeLevelChoice(item: LevelReconcileItem, choice: 'console' | 'local'): Promise<void> {
  const current = mergedDecisions.value.levels[item.key] ?? { choice: 'console', dropLocalOff: false }
  working.value = {
    ...working.value,
    levels: { ...working.value.levels, [item.key]: { ...current, choice } }
  }
  await persist()
}

async function changeDropLocal(item: LevelReconcileItem, value: boolean): Promise<void> {
  const current = mergedDecisions.value.levels[item.key] ?? { choice: 'console', dropLocalOff: false }
  working.value = {
    ...working.value,
    levels: { ...working.value.levels, [item.key]: { ...current, dropLocalOff: value } }
  }
  await persist()
}

async function setAllLevelChoices(choice: 'console' | 'local'): Promise<void> {
  const nextLevels = { ...working.value.levels }
  report.value?.levelItems.forEach((item) => {
    nextLevels[item.key] = { ...(nextLevels[item.key] ?? { dropLocalOff: false }), choice }
  })
  working.value = { ...working.value, levels: nextLevels }
  await persist()
  message.success(choice === 'console' ? '已全部选定采用控台值' : '已全部选定保留本地值')
}

const levelItemsByCue = computed(() => {
  const groups = new Map<string, { cueId: string; cueNo: string; items: LevelReconcileItem[] }>()
  report.value?.levelItems.forEach((item) => {
    const group = groups.get(item.cueId)
    if (group) group.items.push(item)
    else groups.set(item.cueId, { cueId: item.cueId, cueNo: item.cueNo, items: [item] })
  })
  return Array.from(groups.values())
})

function cueLabelOf(cueId: string): string {
  return cueStore.cueById(cueId)?.label || '（本地未填提示语）'
}

function confirmApply(): void {
  if (blocking.value.length > 0) {
    message.error(blocking.value[0])
    return
  }
  dialog.warning({
    title: '确认写入对账结果',
    content: `将更新 ${planPreview.value.fixtures.length} 个灯具的身份 / 编号 / 通道，以及 ${planPreview.value.levels.length} 条亮度 / 色温。场次、提示语、触发与过渡时间保持本地编排不变。`,
    positiveText: '确认写入',
    negativeText: '再核对一下',
    onPositiveClick: () => doApply()
  })
}

async function doApply(): Promise<void> {
  if (!job.value) return
  await persist()
  applying.value = true
  try {
    const result = await importJobStore.apply(job.value.id)
    if (!result.ok) {
      message.error(result.message)
      return
    }
    message.success(result.message)
    emit('applied')
  } finally {
    applying.value = false
  }
}

const jobStatusTag = computed<{ type: 'success' | 'warning' | 'error' | 'default'; text: string }>(() => {
  switch (job.value?.status) {
    case 'applied':
      return { type: 'success', text: '已应用' }
    case 'failed':
      return { type: 'error', text: '导入失败（保留进度）' }
    case 'abandoned':
      return { type: 'default', text: '已放弃' }
    case 'received':
      return { type: 'warning', text: '待解析' }
    default:
      return { type: 'warning', text: '待对账' }
  }
})

function fmtValue(value: number | null, suffix: string): string {
  return value === null ? '—' : `${value}${suffix}`
}
</script>

<template>
  <div class="reconcile">
    <NAlert v-if="!job || !pkg" type="error" :bordered="false">
      配接包未能解析或任务已被删除。可返回列表对保留的任务执行「重试解析」，重新上传同一包不会重复生成记录。
    </NAlert>

    <template v-else>
      <section class="panel">
        <div class="meta-row">
          <div>
            <p class="meta-row__title">
              控台配接包对账
              <NTag size="small" :bordered="false" :type="jobStatusTag.type">{{ jobStatusTag.text }}</NTag>
            </p>
            <p class="meta-row__sub mono">
              来源 {{ pkg.source }} · 控台导出 {{ formatDateTime(pkg.exportedAt) }} · 收录于 {{ formatDateTime(job.createdAt) }}
            </p>
          </div>
          <span class="toolbar__spacer" />
          <NButton @click="emit('back')">返回任务列表</NButton>
          <NButton type="primary" :loading="applying" :disabled="blocking.length > 0" @click="confirmApply">
            选定无误，写入本地
          </NButton>
        </div>
        <p class="meta-row__rule">
          控台包只提供灯具编号、通道、亮度、色温等现场事实；场次、提示语、触发方式与过渡时间仍以本地 Cue 表为准。
          灯具按控台身份（uid）锚定，重新导入沿用同一身份，不按通道号硬盖。
        </p>
        <div class="stat-row" style="margin-top: 10px">
          <div class="stat"><span class="stat__value">{{ report?.fixtureItems.length ?? 0 }}</span><span class="stat__label">控台灯</span></div>
          <div class="stat"><span class="stat__value">{{ fixtureConflictCount }}</span><span class="stat__label">灯具待决</span></div>
          <div class="stat"><span class="stat__value">{{ levelConflictCount }}</span><span class="stat__label">电平待决</span></div>
          <div class="stat">
            <span class="stat__value">{{ report?.unmatchedConsoleCues.length ?? 0 }}</span><span class="stat__label">本地缺同号 Cue</span>
          </div>
          <div class="stat">
            <span class="stat__value">{{ planPreview.fixtures.length }} / {{ planPreview.levels.length }}</span>
            <span class="stat__label">将写入灯具 / 电平</span>
          </div>
        </div>
      </section>

      <NAlert v-if="job.status === 'failed'" type="error" :bordered="false">
        上次写入未完成：{{ job.lastError || '存在未决差异' }}。配接包与已选定进度均已保留，处理后可直接重试。
      </NAlert>

      <NAlert v-for="(issue, index) in blocking" :key="index" type="warning" :bordered="false" class="alert-line">
        {{ issue }}
      </NAlert>

      <section v-if="report && report.unmatchedConsoleCues.length > 0" class="panel">
        <h2 class="panel__title">
          本地缺少同号 Cue<span class="panel__title-tag">只列差异，不自动新建 Cue；需在本地时间轴自行补排</span>
        </h2>
        <div class="chip-row">
          <NTag v-for="cue in report.unmatchedConsoleCues" :key="cue.cueNo" type="warning" :bordered="false">
            {{ cue.cueNo }}（控台 {{ cue.levelCount }} 个电平）
          </NTag>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel__title">
          灯具身份与配接对账<span class="panel__title-tag">先对应身份，再决定换号 / 通道取舍</span>
        </h2>
        <NEmpty v-if="report && report.fixtureItems.length === 0" description="配接包内没有灯具" class="empty-block" />
        <div v-else class="fix-table">
          <div class="fix-table__head">
            <span>控台灯（uid）</span>
            <span>对应到本地灯具</span>
            <span>灯具编号</span>
            <span>通道取舍</span>
            <span>状态</span>
          </div>
          <div
            v-for="item in report?.fixtureItems"
            :key="item.key"
            class="fix-table__row"
            :class="{ 'fix-table__row--conflict': item.status === 'conflict' }"
          >
            <div class="fix-table__console">
              <span class="fix-table__no">{{ item.consoleFixture.fixtureNo }}</span>
              <span class="fix-table__uid mono">{{ item.consoleUid }}</span>
            </div>

            <NSelect
              :value="mergedDecisions.fixtures[item.key]?.fixtureId ?? null"
              :options="selectOptionsFor(item)"
              :show-arrow="true"
              filterable
              clearable
              placeholder="选择本地灯具或跳过"
              style="width: 280px"
              @update:value="(value: string | null) => changeFixtureMapping(item, value)"
            />

            <div class="fix-table__diff">
              <template v-if="item.fixtureNoDiff">
                <NTag size="small" type="warning" :bordered="false">换号</NTag>
                <span class="diff">
                  <s class="muted">{{ item.fixtureNoDiff.local || '空' }}</s> →
                  <b>{{ item.fixtureNoDiff.console }}</b>
                </span>
              </template>
              <span v-else class="muted">编号一致</span>
            </div>

            <div class="fix-table__diff">
              <template v-if="item.channelDiff || item.contention">
                <NTag v-if="item.contention" size="small" type="error" :bordered="false">通道争用</NTag>
                <NTag v-else-if="item.channelDiff" size="small" type="warning" :bordered="false">换通道</NTag>
                <NRadioGroup
                  :value="mergedDecisions.fixtures[item.key]?.channelChoice ?? 'console'"
                  :disabled="!mergedDecisions.fixtures[item.key]?.fixtureId"
                  size="small"
                  @update:value="(value: 'console' | 'local') => changeChannelChoice(item, value)"
                >
                  <NRadio value="console">用控台 CH{{ item.consoleFixture.channel }}</NRadio>
                  <NRadio value="local">保留本地 CH{{ item.channelDiff?.local ?? item.consoleFixture.channel }}</NRadio>
                </NRadioGroup>
                <span v-if="item.contention" class="fix-table__warn">{{ contentionLabel(item) }}</span>
              </template>
              <span v-else class="muted">通道一致 CH{{ item.consoleFixture.channel }}</span>
            </div>

            <div class="fix-table__status">
              <NTag v-if="!mergedDecisions.fixtures[item.key]?.fixtureId" size="small" :bordered="false" type="default">
                跳过
              </NTag>
              <NTag v-else-if="item.status === 'conflict'" size="small" :bordered="false" type="warning">待选定</NTag>
              <NTag v-else size="small" :bordered="false" type="success">一致</NTag>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2 class="panel__title">
          亮度 / 色温对账<span class="panel__title-tag">按控台身份取数；电平缺失或本地无记录时需逐条选定</span>
        </h2>
        <div class="toolbar">
          <NButton size="small" @click="setAllLevelChoices('console')">全部采用控台值</NButton>
          <NButton size="small" @click="setAllLevelChoices('local')">全部保留本地值</NButton>
          <span class="toolbar__spacer" />
          <span class="toolbar__label">过渡时间 / 提示语不在此页改动，仍由本地编排</span>
        </div>

        <NEmpty v-if="levelItemsByCue.length === 0" description="没有可对账的电平（先在上方对应灯具身份，并确认本地存在同号 Cue）" class="empty-block" />

        <div v-for="group in levelItemsByCue" :key="group.cueId" class="cue-group">
          <p class="cue-group__head mono">{{ group.cueNo }} · {{ cueLabelOf(group.cueId) }}</p>
          <div class="lvl-table">
            <div class="lvl-table__head">
              <span>通道</span>
              <span>亮度 控台 / 本地</span>
              <span>色温 控台 / 本地</span>
              <span>取舍</span>
              <span>零电平处理</span>
            </div>
            <div
              v-for="item in group.items"
              :key="item.key"
              class="lvl-table__row"
              :class="{ 'lvl-table__row--conflict': item.status === 'conflict' }"
            >
              <span class="mono">CH{{ item.channel }}</span>
              <span class="mono pair">
                <b :class="{ 'pair__missing': item.consoleOff }">{{ fmtValue(item.consoleIntensity, '%') }}</b>
                <span class="muted">/ {{ fmtValue(item.localIntensity, '%') }}</span>
              </span>
              <span class="mono pair">
                <b :class="{ 'pair__missing': item.consoleColorTempK === null }">{{ fmtValue(item.consoleColorTempK, 'K') }}</b>
                <span class="muted">/ {{ fmtValue(item.localColorTempK, 'K') }}</span>
              </span>
              <NRadioGroup
                :value="mergedDecisions.levels[item.key]?.choice ?? 'console'"
                size="small"
                @update:value="(value: 'console' | 'local') => changeLevelChoice(item, value)"
              >
                <NRadio value="console">采用控台</NRadio>
                <NRadio value="local">保留本地</NRadio>
              </NRadioGroup>
              <div class="lvl-table__off">
                <template v-if="item.consoleOff && item.localIntensity !== null">
                  <NSwitch
                    :value="mergedDecisions.levels[item.key]?.dropLocalOff ?? false"
                    size="small"
                    @update:value="(value: boolean) => changeDropLocal(item, value)"
                  />
                  <span class="lvl-table__off-label">控台黑场时删除本地电平</span>
                </template>
                <span v-else-if="item.consoleColorTempK === null" class="lvl-table__warn">控台缺色温，采用时沿用本地 / 基准</span>
                <span v-else-if="item.localIntensity === null" class="lvl-table__warn">本地尚无电平，采用即新建</span>
                <span v-else class="muted">—</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.reconcile {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.alert-line {
  margin: 0;
}

.meta-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.meta-row__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.meta-row__sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.meta-row__rule {
  margin: 10px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  line-height: 1.7;
}

.chip-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.empty-block {
  padding: 24px 0;
}

.fix-table__head,
.fix-table__row {
  display: grid;
  grid-template-columns: 150px 300px 170px 1fr 90px;
  align-items: center;
  gap: 12px;
  padding: 10px 6px;
}

.fix-table__head {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.fix-table__row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.fix-table__row--conflict {
  background: rgba(232, 168, 84, 0.05);
  border-radius: 10px;
}

.fix-table__console {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fix-table__no {
  font-weight: 600;
}

.fix-table__uid {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.38);
}

.fix-table__diff {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.diff {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.fix-table__warn {
  font-size: 11px;
  color: #ff9a9a;
}

.fix-table__status {
  display: flex;
  justify-content: flex-end;
}

.cue-group {
  margin-top: 14px;
}

.cue-group__head {
  margin: 0 0 6px;
  font-size: 12px;
  color: rgba(242, 181, 68, 0.85);
  letter-spacing: 0.3px;
}

.lvl-table__head,
.lvl-table__row {
  display: grid;
  grid-template-columns: 80px 150px 160px 200px 1fr;
  align-items: center;
  gap: 12px;
  padding: 9px 6px;
  font-size: 13px;
}

.lvl-table__head {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.lvl-table__row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.lvl-table__row--conflict {
  background: rgba(232, 168, 84, 0.05);
  border-radius: 10px;
}

.pair {
  display: inline-flex;
  gap: 6px;
}

.pair__missing {
  color: #ff9a9a;
}

.lvl-table__off {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lvl-table__off-label,
.lvl-table__warn {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}

.lvl-table__warn {
  color: #ffd79a;
}
</style>
