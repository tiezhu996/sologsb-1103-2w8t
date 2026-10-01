<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NInput,
  NModal,
  NPopconfirm,
  NTag,
  useMessage
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import ConsoleReconcile from '@/components/console/ConsoleReconcile.vue'
import { useImportJobStore } from '@/stores/importJobStore'
import { useSessionStore } from '@/stores/sessionStore'
import type { ImportJobStatus } from '@/types/importJob'
import { formatDateTime } from '@/utils/fade'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const sessionStore = useSessionStore()
const importJobStore = useImportJobStore()

const sessionId = computed(() => String(route.params.id ?? ''))
const session = computed(() => sessionStore.sessionById(sessionId.value))

const showUpload = ref(false)
const rawDraft = ref('')
const fileName = ref('')
const ingesting = ref(false)
const activeJobId = ref<string | null>(null)

const jobs = computed(() => (sessionId.value ? importJobStore.jobsOfSession(sessionId.value) : []))
const activeJob = computed(() => (activeJobId.value ? importJobStore.jobById(activeJobId.value) : null))

const STATUS_META: Record<ImportJobStatus, { type: 'success' | 'warning' | 'error' | 'default'; text: string }> = {
  received: { type: 'warning', text: '待解析' },
  pending: { type: 'warning', text: '待对账' },
  applied: { type: 'success', text: '已应用' },
  failed: { type: 'error', text: '失败 / 保留' },
  abandoned: { type: 'default', text: '已放弃' }
}

function openUpload(): void {
  rawDraft.value = ''
  fileName.value = ''
  showUpload.value = true
}

function onFilePick(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  fileName.value = file.name
  const reader = new FileReader()
  reader.onload = () => {
    rawDraft.value = typeof reader.result === 'string' ? reader.result : ''
  }
  reader.onerror = () => message.error(`读取文件失败：${file.name}`)
  reader.readAsText(file)
  input.value = ''
}

async function submitUpload(): Promise<void> {
  if (!rawDraft.value.trim()) {
    message.error('请选择配接包文件，或粘贴配接包 JSON')
    return
  }
  ingesting.value = true
  try {
    const result = await importJobStore.ingest(sessionId.value, rawDraft.value)
    if (result.outcome === 'error') {
      message.error(result.message)
      return
    }
    if (result.outcome === 'duplicate') {
      message.info('同一配接包已收录（按内容哈希识别），已打开既有任务，未重复生成记录。')
      activeJobId.value = result.job.id
    } else {
      message.success(
        result.job.status === 'pending' ? '配接包已解析，请逐栏对账后再写入' : '配接包原文已保留，但解析未通过，可在任务上重试'
      )
      activeJobId.value = result.job.id
    }
    showUpload.value = false
  } finally {
    ingesting.value = false
  }
}

async function retryJob(jobId: string): Promise<void> {
  const result = await importJobStore.retry(jobId)
  message[result.ok ? 'success' : 'error'](result.message)
  if (result.ok) activeJobId.value = jobId
}

async function abandonJob(jobId: string): Promise<void> {
  await importJobStore.abandon(jobId)
  message.success('任务已标记放弃，记录仍保留')
}

async function deleteJob(jobId: string): Promise<void> {
  await importJobStore.removeJob(jobId)
  if (activeJobId.value === jobId) activeJobId.value = null
  message.success('任务记录已删除')
}

function openJob(jobId: string): void {
  activeJobId.value = jobId
}

function backToList(): void {
  activeJobId.value = null
}

function fixtureConflictCount(job: (typeof jobs.value)[number]): number {
  return job.report?.fixtureItems.filter((item) => item.status === 'conflict').length ?? 0
}

function levelConflictCount(job: (typeof jobs.value)[number]): number {
  return job.report?.levelItems.filter((item) => item.status === 'conflict').length ?? 0
}

function goFixtures(): void {
  void router.push(`/sessions/${sessionId.value}/fixtures`)
}

function goCues(): void {
  void router.push(`/sessions/${sessionId.value}/cues`)
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">控台配接包对账</h1>
        <p class="page__subtitle">
          {{ session ? `${session.order}. ${session.title}` : '场次不存在或已删除' }} ·
          转场后导入控台导出的配接包，灯具编号、通道、亮度、色温与本地 Cue 表对账；场次、提示语与过渡时间仍由本地编排。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goFixtures">灯位通道</NButton>
        <NButton @click="goCues">Cue 时间轴</NButton>
        <NButton type="primary" :disabled="!session" @click="openUpload">导入控台配接包</NButton>
      </div>
    </header>

    <NAlert v-if="!session" type="warning" :bordered="false">
      该场次不存在，可能已被删除。请返回场次编排重新选择。
    </NAlert>

    <template v-else-if="activeJob">
      <ConsoleReconcile :session-id="sessionId" :job-id="activeJob.id" @back="backToList" @applied="backToList" />
    </template>

    <template v-else>
      <BlankHint
        v-if="jobs.length === 0"
        title="还没有导入过控台配接包"
        description="配接包是控台导出的现场事实：灯具编号、DMX 通道、各 Cue 下的亮度与色温。系统按控台灯具身份（uid）锚定，重导沿用同一身份，不按通道号硬盖。"
        tip="换号、通道争用或电平缺失时，会先列出控台与本地双方数据，选定后才写入。"
        action-text="导入第一个配接包"
        @action="openUpload"
      />

      <section v-else class="panel">
        <h2 class="panel__title">
          导入任务<span class="panel__title-tag">导入失败保留配接包与进度；重试同一包不重复生成记录</span>
        </h2>
        <div class="job-table">
          <div class="job-table__head">
            <span>来源 / 导出时间</span>
            <span>状态</span>
            <span>待决灯具 / 电平</span>
            <span>收录时间</span>
            <span>操作</span>
          </div>
          <div v-for="job in jobs" :key="job.id" class="job-table__row">
            <div class="job-table__source">
              <p class="job-table__name">{{ job.source }}</p>
              <p class="job-table__sub mono">{{ job.exportedAt ? formatDateTime(job.exportedAt) : '导出时间缺失' }}</p>
              <p v-if="job.lastError" class="job-table__error">{{ job.lastError }}</p>
            </div>
            <NTag size="small" :bordered="false" :type="STATUS_META[job.status].type">{{ STATUS_META[job.status].text }}</NTag>
            <span class="mono">{{ fixtureConflictCount(job) }} / {{ levelConflictCount(job) }}</span>
            <span class="mono muted">{{ formatDateTime(job.createdAt) }}</span>
            <div class="job-table__actions">
              <NButton size="tiny" type="primary" quaternary @click="openJob(job.id)">
                {{ job.status === 'received' ? '查看' : '继续对账' }}
              </NButton>
              <NButton size="tiny" quaternary @click="retryJob(job.id)">重试解析</NButton>
              <NButton v-if="job.status !== 'abandoned'" size="tiny" quaternary @click="abandonJob(job.id)">放弃</NButton>
              <NPopconfirm @positive-click="deleteJob(job.id)">
                <template #trigger>
                  <NButton size="tiny" quaternary type="error">删除</NButton>
                </template>
                删除后该配接包原文与对账进度一并清除，确认？
              </NPopconfirm>
            </div>
          </div>
        </div>
      </section>
    </template>

    <NModal v-model:show="showUpload" preset="card" title="导入控台配接包" class="upload-modal" :mask-closable="false">
      <p class="upload-modal__hint">
        支持控台导出的 <span class="mono">.json</span> 配接包（格式 <span class="mono">gbcuesheet/console-patch 1.0</span>）。
        包只含灯具编号、通道与亮度 / 色温；提示语与过渡时间不会被读取或覆盖。
      </p>
      <div class="upload-modal__file">
        <label class="upload-pick">
          <input type="file" accept=".json,application/json" @change="onFilePick" />
          <NButton size="small" tag="span">选择配接包文件</NButton>
          <span class="upload-pick__name">{{ fileName || '未选择文件' }}</span>
        </label>
      </div>
      <NInput
        v-model:value="rawDraft"
        type="textarea"
        :rows="10"
        placeholder="也可以直接粘贴配接包 JSON 内容"
        class="upload-modal__textarea"
      />
      <template #footer>
        <div class="modal-footer">
          <NButton @click="showUpload = false">取消</NButton>
          <NButton type="primary" :loading="ingesting" @click="submitUpload">收录并对账</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.job-table__head,
.job-table__row {
  display: grid;
  grid-template-columns: 1.6fr 100px 130px 150px 250px;
  align-items: center;
  gap: 12px;
  padding: 12px 6px;
}

.job-table__head {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.job-table__row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.job-table__name {
  margin: 0;
  font-weight: 600;
  font-size: 13px;
}

.job-table__sub {
  margin: 3px 0 0;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
}

.job-table__error {
  margin: 4px 0 0;
  font-size: 11px;
  color: #ff9a9a;
  line-height: 1.5;
}

.job-table__actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.upload-modal {
  width: 640px;
  max-width: 94vw;
}

.upload-modal__hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  line-height: 1.7;
}

.upload-modal__file {
  margin-bottom: 12px;
}

.upload-pick {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.upload-pick input {
  display: none;
}

.upload-pick__name {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.upload-modal__textarea {
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
