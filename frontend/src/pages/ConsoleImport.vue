<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NInputNumber,
  NSelect,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
  NUpload,
  useMessage,
  type UploadFileInfo
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import { useConsoleImportStore } from '@/stores/consoleImportStore'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useSessionStore } from '@/stores/sessionStore'
import { FIXTURE_POSITIONS, FIXTURE_TYPES, type FixturePosition, type FixtureType } from '@/types/fixture'
import type {
  ChannelChoice,
  ConsoleImportBatch,
  FixtureReconcileItem,
  LevelReconcileItem,
  MissingLevelChoice
} from '@/types/consoleImport'
import { formatDateTime } from '@/utils/fade'
import {
  effectiveChannelOf,
  evaluateReport,
  isLevelRowActive,
  summarizeReport,
  type ReconcileReport
} from '@/utils/reconcile'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()
const fixtureStore = useFixtureStore()
const cueStore = useCueStore()
const importStore = useConsoleImportStore()

const sessionId = computed(() => String(route.params.id ?? ''))
const session = computed(() => sessionStore.sessionById(sessionId.value))

const batches = computed(() => importStore.batchesOfSession(sessionId.value))
const activeBatchId = ref<string | null>(null)
const activeBatch = computed<ConsoleImportBatch | null>(() =>
  activeBatchId.value ? importStore.batchById(activeBatchId.value) : null
)

/** 当前批次对账报告（批次更新时重新从快照派生） */
const reportTick = ref(0)
const report = computed<ReconcileReport | null>(() => {
  void reportTick.value
  if (!activeBatch.value?.report) return null
  return importStore.reportOf(activeBatch.value)
})

watch(
  batches,
  (list) => {
    if (activeBatchId.value && list.some((batch) => batch.id === activeBatchId.value)) return
    activeBatchId.value = list.length > 0 ? list[0].id : null
  },
  { immediate: true }
)

watch(activeBatch, () => {
  reportTick.value += 1
})

const localFixtures = computed(() => fixtureStore.fixturesOfSession(sessionId.value))

function fixtureLabel(id: string | null): string {
  if (!id) return '—'
  const fixture = fixtureStore.fixtureById(id)
  if (!fixture) return '本地灯具已删除'
  return `${fixture.fixtureNo ? `灯号 ${fixture.fixtureNo} · ` : ''}CH${fixture.channel} · ${fixture.position} · ${fixture.fixtureType}`
}

function cueLabel(id: string | null): string {
  if (!id) return '—'
  const cue = cueStore.cueById(id)
  return cue ? `${cue.cueNo} ${cue.label || '（无提示语）'}` : '本地 Cue 已删除'
}

// ---------- 上传 ----------

const uploading = ref(false)

async function handleUpload(options: { file: UploadFileInfo }): Promise<void> {
  const file = options.file.file
  if (!file) return
  uploading.value = true
  try {
    const raw = await file.text()
    const result = await importStore.uploadPackage(sessionId.value, raw)
    if (!result.ok) {
      message.error(result.message)
    } else {
      if (result.batch) activeBatchId.value = result.batch.id
      message.success(result.message)
    }
  } catch {
    message.error('读取配接包文件失败')
  } finally {
    uploading.value = false
  }
}

function selectBatch(batchId: string): void {
  activeBatchId.value = batchId
}

async function refreshReport(): Promise<void> {
  if (!activeBatchId.value) return
  const result = await importStore.rebuildReport(activeBatchId.value)
  reportTick.value += 1
  if (result.ok) message.success(result.message)
  else message.error(result.message)
}

// ---------- 派生统计 / 阻断 ----------

const summary = computed(() => (report.value ? summarizeReport(report.value) : null))
const evaluation = computed(() => {
  if (!report.value) return { blockers: [], canCommit: false }
  return evaluateReport(report.value, localFixtures.value)
})

/** 逐灯具行实时计算阻断原因（不依赖文案匹配） */
function fixtureBlockers(item: FixtureReconcileItem): string[] {
  if (item.action === 'skip') return []
  const list: string[] = []
  const label = item.pkgFixtureNo ? `灯号 ${item.pkgFixtureNo}` : `灯具 ${item.uid}`
  const channel = effectiveChannelOf(item)
  if (channel === null) {
    list.push(`${label}：请选择或填写通道号`)
  } else if (!Number.isInteger(channel) || channel < 1 || channel > 512) {
    list.push(`${label}：通道号 CH${channel} 超出 1-512`)
  } else if (isContended(item)) {
    const others = channelOccupantLabels(item)
    list.push(`${label}：CH${channel} 通道争用${others.length ? `（${others.join('、')}）` : ''}，请重新分配`)
  }
  if (!item.decided) list.push(`${label}：请确认对应关系（新建 / 现有 / 跳过）`)
  return list
}

/** 逐 Cue 行的阻断原因 */
function cueBlocker(item: { normalizedCueNo: string; localCueId: string | null; decided: boolean }): string | null {
  if (!item.localCueId && !item.decided) return `${item.normalizedCueNo}：本地没有该 Cue，请选择新建或跳过`
  return null
}

/** 当前通道上除自己以外的占用者描述（参与对账的其他行 + 本地既有灯具） */
function channelOccupantLabels(item: FixtureReconcileItem): string[] {
  const channel = effectiveChannelOf(item)
  if (channel === null) return []
  const selfKey = item.localFixtureId ?? `new::${item.itemId}`
  const occupants = contentionMap.value.get(channel) ?? []
  return occupants
    .filter((entry) => entry.localFixtureId !== selfKey)
    .map((entry) => {
      if (entry.item) return `控台灯号 ${entry.item.pkgFixtureNo}`
      const local = fixtureStore.fixtureById(entry.localFixtureId)
      return local ? `本地 ${local.fixtureNo || local.position} CH${local.channel}` : '本地灯具'
    })
}

const missingBlockerKeys = computed<Set<string>>(() => {
  const keys = new Set<string>()
  if (!report.value) return keys
  const rows = report.value.levels.filter((row) => isLevelRowActive(report.value!, row))
  rows.forEach((row) => {
    if (!row.intensity.decided) keys.add(`${row.itemId}::intensity`)
    if (!row.colorTemp.decided) keys.add(`${row.itemId}::colorTemp`)
  })
  return keys
})

/** 通道争用映射：通道号 -> 占用者（参与对账的灯具行 + 本地既有灯具） */
const contentionMap = computed<Map<number, { item: FixtureReconcileItem | null; localFixtureId: string }[]>>(() => {
  const map = new Map<number, { item: FixtureReconcileItem | null; localFixtureId: string }[]>()
  const add = (channel: number, entry: { item: FixtureReconcileItem | null; localFixtureId: string }) => {
    const list = map.get(channel) ?? []
    list.push(entry)
    map.set(channel, list)
  }
  if (report.value) {
    report.value.fixtures.forEach((item) => {
      if (item.action === 'skip') return
      const channel = effectiveChannelOf(item)
      if (channel !== null) add(channel, { item, localFixtureId: item.localFixtureId ?? `new::${item.itemId}` })
    })
  }
  localFixtures.value.forEach((fixture) => {
    // 本地灯具若已被某行选中同通道且是它自己，则不算额外占用
    add(fixture.channel, { item: null, localFixtureId: fixture.id })
  })
  // 去重：同一本地身份只算一次
  const deduped = new Map<number, { item: FixtureReconcileItem | null; localFixtureId: string }[]>()
  map.forEach((entries, channel) => {
    const seen = new Set<string>()
    const unique = entries.filter((entry) => {
      if (seen.has(entry.localFixtureId)) return false
      seen.add(entry.localFixtureId)
      return true
    })
    deduped.set(channel, unique)
  })
  return deduped
})

function isContended(item: FixtureReconcileItem): boolean {
  const channel = effectiveChannelOf(item)
  if (channel === null) return false
  const occupants = contentionMap.value.get(channel) ?? []
  // 该行的 owner 之外还有别的占用者
  const others = occupants.filter((entry) => entry.localFixtureId !== (item.localFixtureId ?? `new::${item.itemId}`))
  return others.length > 0
}

// ---------- 灯具行操作 ----------

const positionOptions = FIXTURE_POSITIONS.map((position) => ({ label: position, value: position }))
const typeOptions = FIXTURE_TYPES.map((type) => ({ label: type, value: type }))

async function chooseFixtureAction(item: FixtureReconcileItem, action: 'existing' | 'create' | 'skip'): Promise<void> {
  if (!activeBatchId.value) return
  await importStore.setFixtureAction(activeBatchId.value, item.itemId, action)
  reportTick.value += 1
}

async function chooseNo(item: FixtureReconcileItem, choice: 'package' | 'local'): Promise<void> {
  if (!activeBatchId.value) return
  await importStore.setFixtureNoChoice(activeBatchId.value, item.itemId, choice)
  reportTick.value += 1
}

async function chooseChannel(item: FixtureReconcileItem, choice: ChannelChoice): Promise<void> {
  if (!activeBatchId.value) return
  await importStore.setChannelChoice(activeBatchId.value, item.itemId, choice)
  reportTick.value += 1
}

async function chooseCustomChannel(item: FixtureReconcileItem, value: number | null): Promise<void> {
  if (!activeBatchId.value || value === null) return
  await importStore.setChannelChoice(activeBatchId.value, item.itemId, 'custom', value)
  reportTick.value += 1
}

async function choosePosition(item: FixtureReconcileItem, value: FixturePosition): Promise<void> {
  if (!activeBatchId.value) return
  await importStore.setCreatePosition(activeBatchId.value, item.itemId, value)
  reportTick.value += 1
}

async function chooseFixtureType(item: FixtureReconcileItem, value: FixtureType): Promise<void> {
  if (!activeBatchId.value) return
  await importStore.setCreateFixtureType(activeBatchId.value, item.itemId, value)
  reportTick.value += 1
}

// ---------- Cue / 电平操作 ----------

async function chooseCue(item: { normalizedCueNo: string }, createLocal: boolean): Promise<void> {
  if (!activeBatchId.value) return
  await importStore.setCueDecision(activeBatchId.value, item.normalizedCueNo, createLocal)
  reportTick.value += 1
}

async function chooseMissing(row: LevelReconcileItem, field: 'intensity' | 'colorTemp', choice: MissingLevelChoice): Promise<void> {
  if (!activeBatchId.value) return
  await importStore.setMissingLevelChoice(activeBatchId.value, row.itemId, field, choice)
  reportTick.value += 1
}

// ---------- 提交 ----------

const committing = ref(false)

async function commit(): Promise<void> {
  if (!activeBatchId.value) return
  committing.value = true
  try {
    const result = await importStore.commit(activeBatchId.value)
    if (result.ok) message.success(result.message)
    else message.error(result.message)
    reportTick.value += 1
  } finally {
    committing.value = false
  }
}

async function abandon(batch: ConsoleImportBatch): Promise<void> {
  await importStore.abandonBatch(batch.id)
  message.info('已放弃该批次（配接包原文仍保留）')
}

function statusTagType(status: ConsoleImportBatch['status']): 'default' | 'success' | 'error' | 'warning' {
  if (status === 'imported') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'abandoned') return 'default'
  return 'warning'
}

const statusLabel: Record<ConsoleImportBatch['status'], string> = {
  pending: '待对账',
  imported: '已导入',
  failed: '写入失败',
  abandoned: '已放弃'
}

function goFixtures(): void {
  void router.push(`/sessions/${sessionId.value}/fixtures`)
}

const missingChoiceOptions: Array<{ label: string; value: MissingLevelChoice }> = [
  { label: '保留本地', value: 'keepLocal' },
  { label: '写 0（关光）', value: 'writeZero' },
  { label: '跳过不写', value: 'skip' }
]

/** 仅展示有争议 / 缺失的电平行，避免全量平铺过长 */
const showAllLevels = ref(false)
const visibleLevels = computed<LevelReconcileItem[]>(() => {
  if (!report.value) return []
  const active = report.value.levels
  if (showAllLevels.value) return active
  return active.filter(
    (row) =>
      row.intensity.missing ||
      row.colorTemp.missing ||
      row.intensity.mismatch ||
      row.colorTemp.mismatch ||
      !row.localCueId ||
      !row.localFixtureId
  )
})
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">控台配接包对账</h1>
        <p class="page__subtitle">
          {{ session ? `${session.order}. ${session.title}` : '场次不存在或已删除' }} ·
          配接包只提供灯具编号、通道、亮度与色温的现场事实；场次、提示语与过渡时间仍由本地编排。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goFixtures">返回灯位配置台</NButton>
      </div>
    </header>

    <NAlert v-if="!session" type="warning" :bordered="false">
      该场次不存在，可能已被删除。请返回场次编排重新选择。
    </NAlert>

    <template v-else>
      <!-- 上传区 -->
      <section class="panel">
        <h2 class="panel__title">
          导入控台配接包
          <span class="panel__title-tag">JSON 格式 · 同一包重试不会重复生成记录</span>
        </h2>
        <div class="upload-row">
          <NUpload
            :default-upload="false"
            accept=".json,application/json"
            :max="1"
            :on-change="handleUpload"
          >
            <NButton type="primary" :loading="uploading">选择配接包文件</NButton>
          </NUpload>
          <span class="muted">转场后由灯光控台导出；包含灯具 uid / 灯号 / 通道，以及各 Cue 的亮度与色温。</span>
        </div>
      </section>

      <!-- 批次列表 -->
      <section v-if="batches.length > 0" class="panel">
        <h2 class="panel__title">配接包批次<span class="panel__title-tag">失败后保留原文与对账进度，可随时续对</span></h2>
        <div class="batch-list">
          <button
            v-for="batch in batches"
            :key="batch.id"
            type="button"
            class="batch-item"
            :class="{ 'batch-item--active': batch.id === activeBatchId }"
            @click="selectBatch(batch.id)"
          >
            <span class="batch-item__main">
              <span class="batch-item__name">{{ batch.consoleName || '未命名控台' }}</span>
              <span class="batch-item__meta mono">
                {{ batch.fixtureCount }} 灯 · {{ batch.cueCount }} Cue ·
                {{ batch.exportedAt ? formatDateTime(batch.exportedAt) : '无导出时间' }}
              </span>
              <span v-if="batch.lastError" class="batch-item__error">{{ batch.lastError }}</span>
            </span>
            <NTag size="small" :type="statusTagType(batch.status)" :bordered="false">
              {{ statusLabel[batch.status] }}
            </NTag>
          </button>
        </div>
      </section>

      <BlankHint
        v-if="batches.length === 0"
        title="还没有导入过控台配接包"
        description="转场换台后，上传控台导出的配接包，把灯具编号、通道、亮度与色温与本地 Cue 表对账。"
        tip="提示：灯具身份按控台 uid 对应，重导沿用同一身份，不会按通道号硬盖。"
      />

      <!-- 对账工作台 -->
      <template v-if="activeBatch && report">
        <div class="reconcile-head">
          <div class="stat-row">
            <div class="stat"><span class="stat__value">{{ summary?.matchedFixtures ?? 0 }}</span><span class="stat__label">对应现有灯具</span></div>
            <div class="stat"><span class="stat__value">{{ summary?.newFixtures ?? 0 }}</span><span class="stat__label">包内新灯具</span></div>
            <div class="stat"><span class="stat__value">{{ summary?.changedChannels ?? 0 }}</span><span class="stat__label">换通道</span></div>
            <div class="stat"><span class="stat__value">{{ summary?.noConflicts ?? 0 }}</span><span class="stat__label">换号</span></div>
            <div class="stat"><span class="stat__value">{{ summary?.missingFields ?? 0 }}</span><span class="stat__label">电平缺失字段</span></div>
            <div class="stat"><span class="stat__value">{{ evaluation.blockers.length }}</span><span class="stat__label">待决问题</span></div>
          </div>
          <div class="reconcile-head__actions">
            <NButton size="small" @click="refreshReport">按最新本地数据重算</NButton>
            <NButton size="small" quaternary type="warning" @click="abandon(activeBatch)">放弃批次</NButton>
          </div>
        </div>

        <NAlert
          v-if="evaluation.blockers.length > 0"
          type="warning"
          :bordered="false"
          title="以下问题需先选定处置，才会写入本地 Cue 表"
        >
          <ul class="blocker-list">
            <li v-for="(blocker, index) in evaluation.blockers.slice(0, 8)" :key="index">{{ blocker.message }}</li>
            <li v-if="evaluation.blockers.length > 8">…等共 {{ evaluation.blockers.length }} 项</li>
          </ul>
        </NAlert>

        <NTabs type="line" animated class="reconcile-tabs">
          <!-- 灯具对账 -->
          <NTabPane name="fixtures" :tab="`灯具对账（${report.fixtures.length}）`">
            <div class="table-wrap">
              <div class="recon-table recon-table--fixture">
                <div class="recon-table__head">
                  <span>灯具（控台身份）</span>
                  <span>配接包现场</span>
                  <span>本地现有配接</span>
                  <span>处置选定</span>
                </div>
                <div
                  v-for="item in report.fixtures"
                  :key="item.itemId"
                  class="recon-table__row"
                  :class="{ 'recon-table__row--block': fixtureBlockers(item).length > 0 }"
                >
                  <div class="cell-id">
                    <span class="cell-id__no">{{ item.pkgFixtureNo }}</span>
                    <span class="cell-id__uid mono">uid:{{ item.uid }}</span>
                    <span v-if="item.matchedBy === 'identity'" class="match-tag match-tag--id">身份沿用</span>
                    <span v-else-if="item.matchedBy === 'fixtureNo'" class="match-tag">按灯号命中</span>
                    <span v-else-if="item.matchedBy === 'channel'" class="match-tag match-tag--guess">按通道猜测</span>
                    <span v-else class="match-tag match-tag--new">无对应</span>
                  </div>

                  <div class="cell-side">
                    <p class="cell-line"><b>灯号</b> {{ item.pkgFixtureNo }}</p>
                    <p class="cell-line"><b>通道</b> CH{{ item.pkgChannel }}</p>
                    <p v-if="item.pkg.model" class="cell-line muted">{{ item.pkg.model }}</p>
                  </div>

                  <div class="cell-side">
                    <template v-if="item.localFixtureId">
                      <p class="cell-line"><b>灯号</b> {{ item.localFixtureNo || '（空）' }}</p>
                      <p class="cell-line"><b>通道</b> CH{{ item.localChannel }}</p>
                      <p class="cell-line muted">{{ fixtureLabel(item.localFixtureId) }}</p>
                    </template>
                    <p v-else class="cell-line muted">本地无对应灯具</p>
                  </div>

                  <div class="cell-decide">
                    <!-- 新灯具：新建 / 跳过 -->
                    <template v-if="!item.localFixtureId">
                      <div class="decide-row">
                        <NButton
                          size="tiny"
                          :type="item.action === 'create' ? 'primary' : 'default'"
                          @click="chooseFixtureAction(item, 'create')"
                        >新建本地配接</NButton>
                        <NButton
                          size="tiny"
                          :type="item.action === 'skip' ? 'default' : 'default'"
                          :ghost="item.action !== 'skip'"
                          @click="chooseFixtureAction(item, 'skip')"
                        >跳过</NButton>
                      </div>
                      <div v-if="item.action === 'create'" class="decide-row decide-row--fields">
                        <NSelect
                          size="tiny"
                          :value="item.createPosition"
                          :options="positionOptions"
                          style="width: 96px"
                          @update:value="(v: string) => choosePosition(item, v as FixturePosition)"
                        />
                        <NSelect
                          size="tiny"
                          :value="item.createFixtureType"
                          :options="typeOptions"
                          style="width: 104px"
                          @update:value="(v: string) => chooseFixtureType(item, v as FixtureType)"
                        />
                      </div>
                    </template>

                    <!-- 现有灯具：换号 / 换通道争议 -->
                    <template v-else>
                      <NTooltip>
                        <template #trigger>
                          <NButton size="tiny" quaternary type="warning" @click="chooseFixtureAction(item, 'create')">
                            对应有误？改为新建
                          </NButton>
                        </template>
                        若自动匹配错了灯具，可改判为新建本地配接（原灯具保持不动）
                      </NTooltip>

                      <div v-if="item.hasNoConflict" class="decide-box">
                        <p class="decide-label">换号：</p>
                        <NButton size="tiny" :type="item.fixtureNoChoice === 'package' ? 'primary' : 'default'" @click="chooseNo(item, 'package')">
                          用控台「{{ item.pkgFixtureNo }}」
                        </NButton>
                        <NButton size="tiny" :type="item.fixtureNoChoice === 'local' ? 'primary' : 'default'" @click="chooseNo(item, 'local')">
                          留本地「{{ item.localFixtureNo || '空' }}」
                        </NButton>
                      </div>

                      <div v-if="item.hasChannelChange || isContended(item)" class="decide-box">
                        <p class="decide-label">通道：</p>
                        <NButton size="tiny" :type="item.channelChoice === 'package' ? 'primary' : 'default'" @click="chooseChannel(item, 'package')">
                          控台 CH{{ item.pkgChannel }}
                        </NButton>
                        <NButton size="tiny" :type="item.channelChoice === 'local' ? 'primary' : 'default'" @click="chooseChannel(item, 'local')">
                          本地 CH{{ item.localChannel }}
                        </NButton>
                        <NButton size="tiny" :type="item.channelChoice === 'custom' ? 'primary' : 'default'" @click="chooseChannel(item, 'custom')">
                          手填
                        </NButton>
                        <NInputNumber
                          size="tiny"
                          :value="item.customChannel"
                          :min="1"
                          :max="512"
                          :show-button="false"
                          placeholder="空闲通道"
                          style="width: 108px"
                          @update:value="(v: number | null) => chooseCustomChannel(item, v)"
                        />
                      </div>

                      <p v-if="isContended(item)" class="decide-warn">
                        CH{{ effectiveChannelOf(item) }} 通道争用
                        <template v-if="channelOccupantLabels(item).length">
                          ：{{ channelOccupantLabels(item).join('、') }}
                        </template>
                      </p>

                      <p v-if="!item.hasNoConflict && !item.hasChannelChange && !isContended(item) && item.decided" class="decide-ok">
                        编号与通道一致，将沿用身份更新现场电平
                      </p>
                    </template>
                  </div>
                </div>
              </div>
            </div>

            <!-- 本地独有灯具 -->
            <div v-if="report.localOnly.length > 0" class="local-only">
              <h3 class="local-only__title">本地有、配接包未列出（{{ report.localOnly.length }}）· 默认保留不动</h3>
              <div class="local-only__tags">
                <NTag v-for="local in report.localOnly" :key="local.fixtureId" size="small" :bordered="false">
                  {{ local.fixtureNo ? `${local.fixtureNo} · ` : '' }}CH{{ local.channel }} · {{ local.position }}
                </NTag>
              </div>
            </div>
          </NTabPane>

          <!-- Cue 对账 -->
          <NTabPane name="cues" :tab="`Cue 对账（${report.cues.length}）`">
            <NAlert type="info" :bordered="false" class="cue-note">
              Cue 仅按编号对账。包内没有的本地 Cue 原样保留；提示语、触发方式与渐亮 / 保持 / 渐暗时间永远由本地编排，配接包不覆盖。
            </NAlert>
            <div class="table-wrap">
              <div class="recon-table recon-table--cue">
                <div class="recon-table__head">
                  <span>Cue 编号</span>
                  <span>本地 Cue</span>
                  <span>包内电平</span>
                  <span>处置</span>
                </div>
                <div
                  v-for="item in report.cues"
                  :key="item.normalizedCueNo"
                  class="recon-table__row"
                  :class="{ 'recon-table__row--block': !!cueBlocker(item) }"
                >
                  <div class="cell-id"><span class="cell-id__no">{{ item.normalizedCueNo }}</span></div>
                  <div class="cell-side">
                    <template v-if="item.localCueId">
                      <p class="cell-line">{{ cueLabel(item.localCueId) }}</p>
                      <p class="cell-line muted">过渡时间沿用本地，不改</p>
                    </template>
                    <p v-else class="cell-line muted">本地缺少该编号</p>
                  </div>
                  <div class="cell-side"><p class="cell-line mono">{{ item.pkgLevelCount }} 盏灯电平</p></div>
                  <div class="cell-decide">
                    <template v-if="item.localCueId">
                      <span class="decide-ok">编号已对应，写入电平</span>
                    </template>
                    <template v-else>
                      <div class="decide-row">
                        <NButton size="tiny" :type="item.createLocal ? 'primary' : 'default'" @click="chooseCue(item, true)">新建本地 Cue</NButton>
                        <NButton size="tiny" :ghost="item.createLocal" @click="chooseCue(item, false)">跳过电平</NButton>
                      </div>
                      <p v-if="item.createLocal" class="muted tiny">将以默认过渡参数新建，随后可在时间轴编排提示语与时间</p>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </NTabPane>

          <!-- 电平对账 -->
          <NTabPane name="levels" :tab="`亮度 / 色温（${report.levels.length}）`">
            <div class="levels-toolbar">
              <NButton size="tiny" quaternary @click="showAllLevels = !showAllLevels">
                {{ showAllLevels ? '只看有争议 / 缺失项' : `显示全部 ${report.levels.length} 行` }}
              </NButton>
              <span class="muted tiny">双方都有值且不同 → 默认采用控台；控台缺失 → 需选定保留本地 / 写 0 / 跳过后才写入。</span>
            </div>
            <div class="table-wrap">
              <div class="recon-table recon-table--level">
                <div class="recon-table__head">
                  <span>Cue × 灯具</span>
                  <span>亮度（控台 / 本地）</span>
                  <span>色温 K（控台 / 本地）</span>
                  <span>状态</span>
                </div>
                <div
                  v-for="row in visibleLevels"
                  :key="row.itemId"
                  class="recon-table__row"
                  :class="{ 'recon-table__row--inactive': !isLevelRowActive(report, row) }"
                >
                  <div class="cell-id">
                    <span class="cell-id__no">{{ row.normalizedCueNo }}</span>
                    <span class="cell-id__uid">
                      {{ report.fixtures.find((f) => f.itemId === row.fixtureItemId)?.pkgFixtureNo ?? row.uid }}
                    </span>
                    <span v-if="!isLevelRowActive(report, row)" class="match-tag">灯具或 Cue 已跳过</span>
                  </div>

                  <div class="cell-side" :class="{ 'cell-side--issue': row.intensity.missing || row.intensity.mismatch }">
                    <p class="cell-line mono">
                      <b :class="{ 'val-pkg': true }">{{ row.intensity.pkgValue === null ? '缺失' : `${row.intensity.pkgValue}%` }}</b>
                      <span class="val-sep">/</span>
                      {{ row.intensity.localValue === null ? '无记录' : `${row.intensity.localValue}%` }}
                    </p>
                    <NSelect
                      v-if="row.intensity.missing && isLevelRowActive(report, row)"
                      size="tiny"
                      :value="row.intensity.missingChoice"
                      :options="missingChoiceOptions"
                      style="width: 150px; margin-top: 4px"
                      @update:value="(v: MissingLevelChoice) => chooseMissing(row, 'intensity', v)"
                    />
                    <p v-else-if="row.intensity.mismatch" class="tiny muted">不一致 → 采用控台</p>
                  </div>

                  <div class="cell-side" :class="{ 'cell-side--issue': row.colorTemp.missing || row.colorTemp.mismatch }">
                    <p class="cell-line mono">
                      <b>{{ row.colorTemp.pkgValue === null ? '缺失' : `${row.colorTemp.pkgValue}K` }}</b>
                      <span class="val-sep">/</span>
                      {{ row.colorTemp.localValue === null ? '无记录' : `${row.colorTemp.localValue}K` }}
                    </p>
                    <NSelect
                      v-if="row.colorTemp.missing && isLevelRowActive(report, row)"
                      size="tiny"
                      :value="row.colorTemp.missingChoice"
                      :options="missingChoiceOptions"
                      style="width: 150px; margin-top: 4px"
                      @update:value="(v: MissingLevelChoice) => chooseMissing(row, 'colorTemp', v)"
                    />
                    <p v-else-if="row.colorTemp.mismatch" class="tiny muted">不一致 → 采用控台</p>
                  </div>

                  <div class="cell-decide">
                    <NTag v-if="!isLevelRowActive(report, row)" size="small" :bordered="false">不写入</NTag>
                    <NTag v-else-if="missingBlockerKeys.has(`${row.itemId}::intensity`) || missingBlockerKeys.has(`${row.itemId}::colorTemp`)" size="small" type="warning" :bordered="false">
                      待选定
                    </NTag>
                    <NTag v-else size="small" type="success" :bordered="false">就绪</NTag>
                  </div>
                </div>
                <p v-if="visibleLevels.length === 0" class="empty-line">没有需要人工处理的电平项。</p>
              </div>
            </div>
          </NTabPane>
        </NTabs>

        <!-- 提交栏 -->
        <footer class="commit-bar panel">
          <div class="commit-bar__info">
            <p class="commit-bar__title">写入本地 Cue 表</p>
            <p class="commit-bar__hint">
              {{ evaluation.canCommit
                ? '所有争议已选定，将以灯具身份为准写入，重试同一包幂等不重复。'
                : `还有 ${evaluation.blockers.length} 项待决（换号 / 通道争用 / 电平缺失），选定后才能写入。` }}
            </p>
          </div>
          <NTooltip v-if="!evaluation.canCommit" trigger="hover">
            <template #trigger>
              <NButton type="primary" disabled>写入本地 Cue 表</NButton>
            </template>
            请先在上面对账表逐项选定
          </NTooltip>
          <NButton v-else type="primary" :loading="committing" @click="commit">
            {{ activeBatch.status === 'imported' ? '按对账结果重新写入（幂等）' : '写入本地 Cue 表' }}
          </NButton>
        </footer>
      </template>
    </template>
  </div>
</template>

<style scoped>
.upload-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.batch-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.batch-item--active {
  border-color: rgba(242, 181, 68, 0.7);
  background: rgba(242, 181, 68, 0.08);
}

.batch-item__main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.batch-item__name {
  font-size: 13px;
  font-weight: 600;
}

.batch-item__meta {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.batch-item__error {
  font-size: 12px;
  color: #ff9a9a;
}

.reconcile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.reconcile-head__actions {
  display: flex;
  gap: 8px;
}

.blocker-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
}

.reconcile-tabs {
  margin-top: 2px;
}

.table-wrap {
  overflow-x: auto;
}

.recon-table {
  min-width: 880px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  overflow: hidden;
}

.recon-table__head,
.recon-table__row {
  display: grid;
  gap: 12px;
  padding: 12px 14px;
  font-size: 13px;
}

.recon-table--fixture .recon-table__head,
.recon-table--fixture .recon-table__row {
  grid-template-columns: 1.1fr 1fr 1.1fr 1.5fr;
}

.recon-table--cue .recon-table__head,
.recon-table--cue .recon-table__row {
  grid-template-columns: 0.8fr 1.4fr 0.9fr 1.4fr;
}

.recon-table--level .recon-table__head,
.recon-table--level .recon-table__row {
  grid-template-columns: 1fr 1.2fr 1.2fr 0.8fr;
}

.recon-table__head {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.recon-table__row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  align-items: start;
}

.recon-table__row:last-child {
  border-bottom: none;
}

.recon-table__row--block {
  background: rgba(232, 168, 84, 0.06);
}

.recon-table__row--inactive {
  opacity: 0.55;
}

.cell-id {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-id__no {
  font-weight: 600;
}

.cell-id__uid {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.38);
}

.cell-side {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cell-side--issue {
  color: #ffd79a;
}

.cell-line {
  margin: 0;
  line-height: 1.5;
}

.val-sep {
  color: rgba(255, 255, 255, 0.3);
  margin: 0 4px;
}

.match-tag {
  align-self: flex-start;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.65);
}

.match-tag--id {
  background: rgba(63, 191, 159, 0.16);
  color: #7fe3c8;
}

.match-tag--guess {
  background: rgba(232, 168, 84, 0.18);
  color: #ffd79a;
}

.match-tag--new {
  background: rgba(224, 123, 57, 0.18);
  color: #ffb27a;
}

.cell-decide {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.decide-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.decide-row--fields {
  margin-top: 2px;
}

.decide-box {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.decide-label {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.decide-warn {
  margin: 0;
  font-size: 12px;
  color: #ffd79a;
  line-height: 1.5;
}

.decide-ok {
  margin: 0;
  font-size: 12px;
  color: #7fe3c8;
}

.tiny {
  font-size: 11px;
}

.local-only {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px dashed rgba(255, 255, 255, 0.12);
}

.local-only__title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
}

.local-only__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cue-note {
  margin-bottom: 12px;
}

.levels-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.commit-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  position: sticky;
  bottom: 14px;
}

.commit-bar__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.commit-bar__hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}
</style>
