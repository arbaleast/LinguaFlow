<script setup lang="ts">
/**
 * 工作台「外贸邮件与翻译助手」。
 *
 * 面向外贸日常高频沟通，把原来的单输入框即时翻译器升级为双栏工作面：
 * - 模式切换：[智能互译] 通用双向翻译 / [外贸邮件回复] 商务英文邮件改写；
 * - 场景胶囊：标准商务 / 报盘议价 / 礼貌催款 / WhatsApp 简短，
 *   点击后把对应的提示词意图直接传给后端翻译逻辑；
 * - 左右双栏：左侧是客户原邮件或中文回复要点，右侧是译文/商务邮件预览；
 * - 底部常驻 [一键复制] 与 [双语对照复制]；
 * - 系统中暂无执行计划时自动回退到默认可用 AI 后端，不再阻断使用。
 */
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type { SelectMixedOption } from 'naive-ui/es/select/src/interface'

import { quickTranslate } from '@/api/client'
import type { ApiSchemas } from '@/api/client'
import { captureSession, isSessionCurrent } from '@/api/session-context'
import { usePreferencesStore } from '@/stores/preferences'
import { useExecutionPlanTemplatesStore } from '@/stores/executionPlanTemplates'
import { useProjectsStore } from '@/stores/projects'
import { useLanguageOptions } from '@/composables/useLanguageOptions'
import { renderQualityHighlightedText, getQualityCodeLabel } from '@/composables/useQualityIssues'
import { formatTokens, batchStatusTimelineType } from '@/composables/useWorkspaceUtils'
import { extractErrorMessage } from '@/utils/errors'
import SegmentTranslationPreviewDiagnostic from '@/components/workspace/SegmentTranslationPreviewDiagnostic.vue'
import {
  MAIL_ASSISTANT_SCENES,
  composeAssistantInstructions,
  formatBilingualCopy,
  shouldUseDefaultBackend,
  type MailAssistantMode,
  type MailAssistantSceneKey,
} from './mail-assistant'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const preferences = usePreferencesStore()
const context = captureSession()
let disposed = false
const current = () => !disposed && isSessionCurrent(context)
onScopeDispose(() => {
  disposed = true
})

const planTemplates = useExecutionPlanTemplatesStore()
const projects = useProjectsStore()
const { sourceLanguageOptions, targetLanguageOptions } = useLanguageOptions()

/** 选中态只展示语言名（去掉「· zh-Hans」这类代码后缀），下拉里仍保留完整标签。 */
const renderLanguageLabel = (option: SelectMixedOption, selected: boolean): string => {
  const label = String(option.label ?? '')
  if (!selected) return label
  return label.split(' · ')[0] ?? label
}

const mode = ref<MailAssistantMode>('translate')
const scene = ref<MailAssistantSceneKey | null>(null)
const sourceText = ref('')
const sourceLang = ref('auto')
const targetLang = ref('zh-Hans')
const executionPlanId = ref<number | null>(null)
const projectId = ref<number | null>(null)
const glossary = ref<Array<{ id: number; source: string; target: string; notes: string }>>([])
const glossarySeq = ref(0)
const advancedOpen = ref(false)
const submitting = ref(false)
const result = ref<ApiSchemas['QuickTranslateResponse'] | null>(null)

const hasTranslateRound = (plan: ApiSchemas['ExecutionPlanTemplate']): boolean =>
  plan.rounds.some((round) => round.mode === 'translate')

const translatablePlans = computed(() => planTemplates.items.filter(hasTranslateRound))

// 全部计划都不可用时收起列表，交给空状态给出指引；
// 部分可用时，不可用项收进「不含翻译轮次」分组，由组标题说明灰显原因
const executionPlanOptions = computed<SelectMixedOption[]>(() => {
  if (!translatablePlans.value.length) return []
  const usable = translatablePlans.value.map((item) => ({ label: item.name, value: item.id }))
  const unusable = planTemplates.items
    .filter((item) => !hasTranslateRound(item))
    .map((item) => ({ label: item.name, value: item.id, disabled: true }))
  if (!unusable.length) return usable
  return [
    ...usable,
    {
      type: 'group',
      // 组标题自绘样式：naive 默认 0.93em/浅灰与普通选项区分度不足
      label: () =>
        h(
          'span',
          { class: 'text-xs text-lf-text-subtle' },
          t('quickTranslate.planNoTranslateRound'),
        ),
      key: 'plan-group-untranslatable',
      children: unusable,
    },
  ]
})

const projectOptions = computed(() =>
  projects.items.map((item) => ({ label: item.name, value: item.id })),
)
const projectGlossaryDisabled = computed(
  () => projects.items.find((item) => item.id === projectId.value)?.glossary_enabled === false,
)

// 加载中先按正常态渲染，避免空列表闪现警示
const planAvailability = computed<'ok' | 'empty' | 'noneTranslatable'>(() => {
  if (planTemplates.loading) return 'ok'
  if (!planTemplates.items.length) return 'empty'
  if (!translatablePlans.value.length) return 'noneTranslatable'
  return 'ok'
})

// 无可用执行计划时不再用告警态阻断：占位文案直接说明会回退到默认后端。
const planSelectPlaceholder = computed(() => {
  if (planAvailability.value === 'ok') return t('quickTranslate.executionPlanPlaceholder')
  return t('quickTranslate.assistant.fallbackPlaceholder')
})

const selectedPlanTranslatable = computed(
  () =>
    executionPlanId.value != null &&
    planTemplates.items.some(
      (item) => item.id === executionPlanId.value && hasTranslateRound(item),
    ),
)

/**
 * 回退判定：没有可用执行计划时，请求不带 execution_plan_id，
 * 由后端直接使用默认可用 AI 后端完成处理（不再阻断）。
 */
const fallbackActive = computed(() =>
  shouldUseDefaultBackend(
    executionPlanId.value,
    translatablePlans.value.map((item) => item.id),
  ),
)

const canSubmit = computed(() => sourceText.value.trim().length > 0 && !submitting.value)

// 禁用按钮的悬停指引：按优先级给出第一个未满足的条件
const submitBlockReason = computed<string | null>(() => {
  if (submitting.value) return null
  if (!sourceText.value.trim()) return t('quickTranslate.validation.sourceRequired')
  return null
})

const qualityIssues = computed(() => result.value?.quality_issues ?? [])

const hasRoundSummary = computed(() => (result.value?.round_summary?.length ?? 0) > 0)

const statusLabel = (status: string): string => {
  if (status === 'success') return t('quickTranslate.statusSuccess')
  if (status === 'partial') return t('quickTranslate.statusPartial')
  if (status === 'skipped') return t('quickTranslate.statusSkipped')
  return t('quickTranslate.statusFailed')
}

const roundStatusLabel = (round: ApiSchemas['QuickRoundSummary']): string =>
  round.mode === 'extract' && round.status === 'skipped'
    ? t('termExtraction.skippedGlossaryDisabled')
    : statusLabel(round.status)

const addGlossaryRow = (): void => {
  glossarySeq.value += 1
  glossary.value.push({ id: glossarySeq.value, source: '', target: '', notes: '' })
}

const removeGlossaryRow = (id: number): void => {
  glossary.value = glossary.value.filter((row) => row.id !== id)
}

const HighlightedTarget = computed(() => {
  if (!result.value) return null
  return renderQualityHighlightedText(result.value.target_text, result.value.quality_issues)
})

const applyExecutionPlanDefault = (): void => {
  if (!current()) return
  const storedId = preferences.quickTranslatePlanId
  const storedPlan = translatablePlans.value.find((item) => item.id === storedId)
  if (Number.isFinite(storedId) && storedPlan) {
    executionPlanId.value = storedPlan.id
    return
  }
  if (executionPlanId.value == null && translatablePlans.value.length > 0) {
    executionPlanId.value = translatablePlans.value[0]!.id
  }
}

const onExecutionPlanChange = (id: number | null): void => {
  executionPlanId.value = id
  preferences.quickTranslatePlanId = id
}

const goToExecutionPlans = (): void => {
  void router.push({ path: '/execution-config', query: { tab: 'plans' } })
}

const onSwapLanguages = (): void => {
  if (sourceLang.value === 'auto') return
  ;[sourceLang.value, targetLang.value] = [targetLang.value, sourceLang.value]
}

/** 模式切换：邮件模式默认输出英文，其余设置保持不变。 */
const onModeChange = (value: MailAssistantMode): void => {
  mode.value = value
  if (value === 'email' && targetLang.value !== 'en') targetLang.value = 'en'
}

const toggleScene = (key: MailAssistantSceneKey): void => {
  scene.value = scene.value === key ? null : key
}

/** 组合本次请求的提示词意图：模式意图 + 场景意图。 */
const buildInstructions = (): string =>
  composeAssistantInstructions({
    mode: mode.value,
    scene: scene.value,
    emailInstruction: t('quickTranslate.assistant.emailInstruction'),
    sceneInstructions: {
      standard: t('quickTranslate.assistant.scenes.standard.instruction'),
      quote: t('quickTranslate.assistant.scenes.quote.instruction'),
      dunning: t('quickTranslate.assistant.scenes.dunning.instruction'),
      whatsapp: t('quickTranslate.assistant.scenes.whatsapp.instruction'),
    },
  })

const onSubmit = async (): Promise<void> => {
  if (!canSubmit.value) return
  submitting.value = true
  result.value = null
  try {
    const payload: ApiSchemas['QuickTranslateRequest'] = {
      source_text: sourceText.value,
      source_lang: sourceLang.value,
      target_lang: targetLang.value,
    }
    // 有可用执行计划时按计划执行；否则回退到默认 AI 后端（后端自动选择）。
    if (selectedPlanTranslatable.value && executionPlanId.value != null) {
      payload.execution_plan_id = executionPlanId.value
    }
    const instructions = buildInstructions()
    if (instructions) payload.instructions = instructions
    if (projectId.value != null) payload.project_id = projectId.value
    const glossaryEntries = glossary.value
      .filter((row) => row.source.trim() && row.target.trim())
      .map((row) => {
        const entry: ApiSchemas['QuickGlossaryEntry'] = {
          source: row.source,
          target: row.target,
          case_sensitive: false,
          forbidden: false,
          mandatory: true,
        }
        if (row.notes.trim()) entry.notes = row.notes.trim()
        return entry
      })
    if (glossaryEntries.length) payload.glossary = glossaryEntries
    const res = await quickTranslate(payload)
    if (!current()) return
    result.value = res
    if (res.status === 'success') message.success(t('quickTranslate.messages.success'))
    else if (res.status === 'partial') message.warning(t('quickTranslate.messages.partial'))
    else message.error(t('quickTranslate.messages.failed'))
  } catch (err) {
    if (!current()) return
    message.error(extractErrorMessage(err, t('quickTranslate.messages.failed')))
  } finally {
    if (current()) submitting.value = false
  }
}

const copyToClipboard = async (text: string, successKey: string): Promise<void> => {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    if (!current()) return
    message.success(t(successKey))
  } catch {
    if (!current()) return
    message.error(t('quickTranslate.copyFailed'))
  }
}

/** 一键复制：只复制译文/邮件正文。 */
const onCopyResult = async (): Promise<void> => {
  await copyToClipboard(result.value?.target_text ?? '', 'quickTranslate.copySuccess')
}

/** 双语对照复制：原文与译文成对输出，便于粘贴到邮件/工单里核对。 */
const onCopyBilingual = async (): Promise<void> => {
  const target = result.value?.target_text
  if (!target) return
  const text = formatBilingualCopy({
    source: sourceText.value,
    target,
    sourceLabel: t('quickTranslate.assistant.bilingualSourceLabel'),
    targetLabel: t('quickTranslate.assistant.bilingualTargetLabel'),
  })
  await copyToClipboard(text, 'quickTranslate.assistant.copyBilingualSuccess')
}

onMounted(() => {
  if (!planTemplates.items.length) {
    void planTemplates.loadTemplates().then(applyExecutionPlanDefault)
  } else {
    applyExecutionPlanDefault()
  }
  if (!projects.items.length) void projects.loadProjects()
})
</script>

<template>
  <section class="lf-panel overflow-hidden">
    <!-- 头部：标题 + 模式切换 -->
    <div
      class="flex flex-wrap items-center justify-between gap-2 border-b border-lf-border-soft px-4 py-2.5"
    >
      <div class="flex min-w-0 items-center gap-2">
        <IconCarbonMailReply class="shrink-0 text-base text-brand-600" aria-hidden="true" />
        <h2 class="truncate text-sm font-semibold text-lf-text-strong">
          {{ t('quickTranslate.assistant.title') }}
        </h2>
        <span class="hidden truncate text-xs text-lf-text-subtle sm:inline">
          {{ t('quickTranslate.assistant.subtitle') }}
        </span>
      </div>
      <NRadioGroup
        :value="mode"
        size="small"
        :aria-label="t('quickTranslate.assistant.modeLabel')"
        @update:value="(value: string | number) => onModeChange(value as MailAssistantMode)"
      >
        <NRadioButton value="translate">{{
          t('quickTranslate.assistant.modeTranslate')
        }}</NRadioButton>
        <NRadioButton value="email">{{ t('quickTranslate.assistant.modeEmail') }}</NRadioButton>
      </NRadioGroup>
    </div>

    <!-- 工具条：场景胶囊 + 语言对 + 执行计划 -->
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-lf-border-soft bg-lf-surface-muted/40 px-4 py-2"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-1.5">
        <span class="shrink-0 text-xs font-medium text-lf-text-subtle">
          {{ t('quickTranslate.assistant.sceneLabel') }}
        </span>
        <button
          v-for="key in MAIL_ASSISTANT_SCENES"
          :key="key"
          type="button"
          class="rounded-full px-2.5 py-1 text-xs leading-4 font-medium transition-colors"
          :class="
            scene === key
              ? 'bg-brand-500 text-white'
              : 'bg-lf-surface text-lf-text-muted hover:bg-lf-surface-muted hover:text-lf-text-strong'
          "
          :aria-pressed="scene === key"
          @click="toggleScene(key)"
        >
          {{ t(`quickTranslate.assistant.scenes.${key}.label`) }}
        </button>
      </div>

      <div class="ml-auto flex min-w-0 flex-wrap items-center gap-2">
        <NSelect
          v-model:value="sourceLang"
          class="w-32!"
          size="small"
          :options="sourceLanguageOptions"
          :render-label="renderLanguageLabel"
          :aria-label="t('quickTranslate.sourceLangLabel')"
        />
        <NButton
          quaternary
          circle
          size="small"
          :disabled="sourceLang === 'auto'"
          :aria-label="t('quickTranslate.swapLangs')"
          @click="onSwapLanguages"
        >
          <IconCarbonArrowsHorizontal class="text-base" />
        </NButton>
        <NSelect
          v-model:value="targetLang"
          class="w-32!"
          size="small"
          :options="targetLanguageOptions"
          :render-label="renderLanguageLabel"
          :aria-label="t('quickTranslate.targetLangLabel')"
        />
        <NSelect
          class="w-48!"
          size="small"
          :value="executionPlanId"
          filterable
          :options="executionPlanOptions"
          :placeholder="planSelectPlaceholder"
          :loading="planTemplates.loading"
          :aria-label="t('quickTranslate.executionPlanLabel')"
          @update:value="onExecutionPlanChange"
        >
          <template #empty>
            <div class="flex flex-col items-start gap-1.5 px-3 py-2">
              <p class="text-xs text-lf-text-muted">
                {{ t('quickTranslate.assistant.fallbackNotice') }}
              </p>
              <NButton text type="primary" size="tiny" @click="goToExecutionPlans">
                {{ t('quickTranslate.goToExecutionPlans') }}
              </NButton>
            </div>
          </template>
        </NSelect>
        <NTag v-if="fallbackActive" size="tiny" type="info" :bordered="false">
          {{ t('quickTranslate.assistant.fallbackBadge') }}
        </NTag>
      </div>
    </div>

    <!-- 双栏对照：左输入 / 右结果 -->
    <div class="grid gap-px bg-lf-border-soft md:grid-cols-2">
      <!-- 左栏 -->
      <div class="flex min-w-0 flex-col bg-lf-surface p-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-lf-text-muted">
            {{ t('quickTranslate.assistant.inputTitle') }}
          </span>
          <span class="text-xs text-lf-text-subtle tabular-nums">
            {{ t('quickTranslate.charCount', { count: sourceText.length }) }}
          </span>
        </div>
        <NInput
          v-model:value="sourceText"
          type="textarea"
          :autosize="{ minRows: 5, maxRows: 5 }"
          :placeholder="
            mode === 'email'
              ? t('quickTranslate.assistant.inputPlaceholderEmail')
              : t('quickTranslate.assistant.inputPlaceholder')
          "
          :input-props="{ 'aria-label': t('quickTranslate.sourceLabel') }"
        />
      </div>

      <!-- 右栏 -->
      <div class="flex min-w-0 flex-col bg-lf-surface p-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-medium text-lf-text-muted">
            {{
              mode === 'email'
                ? t('quickTranslate.assistant.resultTitleEmail')
                : t('quickTranslate.assistant.resultTitle')
            }}
          </span>
          <NTag
            v-if="result"
            :type="batchStatusTimelineType(result.status, 'info')"
            :bordered="false"
            size="tiny"
          >
            {{ statusLabel(result.status) }}
          </NTag>
        </div>

        <div
          class="min-h-[104px] flex-1 overflow-auto rounded-lf-ctl border border-lf-border-soft bg-lf-surface-muted/40 p-3"
        >
          <template v-if="result">
            <div class="text-sm leading-7 whitespace-pre-wrap text-lf-text-strong">
              <component :is="HighlightedTarget" />
            </div>
          </template>
          <p v-else class="py-6 text-center text-xs text-lf-text-subtle">
            {{ t('quickTranslate.assistant.resultPlaceholder') }}
          </p>
        </div>

        <!-- 结果详情：默认收起，保持面板高度稳定 -->
        <NCollapse v-if="result" class="mt-2">
          <NCollapseItem :title="t('quickTranslate.assistant.detailsTitle')" name="details">
            <div class="space-y-3">
              <div v-if="qualityIssues.length" class="space-y-1.5">
                <p class="text-[11px] font-medium tracking-wide text-lf-text-subtle uppercase">
                  {{ t('quickTranslate.qualityIssuesTitle') }}
                </p>
                <div
                  v-for="(issue, idx) in qualityIssues"
                  :key="idx"
                  class="flex items-start gap-2 text-xs text-lf-text"
                >
                  <NTag
                    size="tiny"
                    :type="issue.severity === 'error' ? 'error' : 'warning'"
                    :bordered="false"
                  >
                    {{ getQualityCodeLabel(issue.code) }}
                  </NTag>
                  <span>{{ issue.message }}</span>
                </div>
              </div>

              <div v-if="hasRoundSummary" class="space-y-1.5">
                <p class="text-[11px] font-medium tracking-wide text-lf-text-subtle uppercase">
                  {{ t('quickTranslate.roundSummaryTitle') }}
                </p>
                <div
                  v-for="round in result.round_summary"
                  :key="round.index"
                  class="flex min-w-0 flex-wrap items-center gap-2 text-xs"
                >
                  <span class="w-6 shrink-0 font-mono text-lf-text-subtle">
                    #{{ round.index + 1 }}
                  </span>
                  <NTag size="tiny" :bordered="false">{{ round.mode }}</NTag>
                  <NTag
                    size="tiny"
                    :type="batchStatusTimelineType(round.status, 'info')"
                    :bordered="false"
                  >
                    {{ roundStatusLabel(round) }}
                  </NTag>
                  <NTag v-if="round.backend" size="tiny" :bordered="false">{{
                    round.backend
                  }}</NTag>
                  <span class="ml-auto font-mono text-xs tabular-nums text-lf-text-muted">
                    {{ round.duration_ms }}ms
                  </span>
                </div>
              </div>

              <div v-if="result.usage" class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <div class="flex items-baseline gap-1.5">
                  <span class="text-xs text-lf-text-muted">{{
                    t('quickTranslate.usageApiCalls')
                  }}</span>
                  <span class="font-mono text-xs font-semibold tabular-nums text-lf-text-strong">
                    {{ result.usage.api_calls }}
                  </span>
                </div>
                <div class="flex items-baseline gap-1.5">
                  <span class="text-xs text-lf-text-muted">
                    {{ t('quickTranslate.usageInputTokens') }}
                  </span>
                  <span class="font-mono text-xs font-semibold tabular-nums text-lf-text-strong">
                    {{ formatTokens(result.usage.input_tokens) }}
                  </span>
                </div>
                <div class="flex items-baseline gap-1.5">
                  <span class="text-xs text-lf-text-muted">
                    {{ t('quickTranslate.usageOutputTokens') }}
                  </span>
                  <span class="font-mono text-xs font-semibold tabular-nums text-lf-text-strong">
                    {{ formatTokens(result.usage.output_tokens) }}
                  </span>
                </div>
              </div>

              <NAlert
                v-for="(warning, idx) in result.warnings ?? []"
                :key="idx"
                type="warning"
                :title="t('quickTranslate.warningsTitle')"
              >
                {{ warning }}
              </NAlert>

              <NCollapse v-if="result.batches?.length">
                <NCollapseItem :title="t('quickTranslate.batchesTitle')" name="batches">
                  <div class="space-y-3">
                    <SegmentTranslationPreviewDiagnostic
                      v-for="(batch, i) in result.batches"
                      :key="i"
                      :batch="batch"
                      :index="i"
                    />
                  </div>
                </NCollapseItem>
              </NCollapse>
            </div>
          </NCollapseItem>
        </NCollapse>
      </div>
    </div>

    <!-- 高级选项 -->
    <div
      v-if="advancedOpen"
      class="space-y-4 border-t border-lf-border-soft bg-lf-surface-muted/40 px-4 py-3"
    >
      <div class="space-y-2">
        <p class="text-xs font-medium text-lf-text-muted">
          {{ t('quickTranslate.projectLabel') }}
        </p>
        <NSelect
          v-model:value="projectId"
          class="max-w-sm!"
          size="small"
          clearable
          :options="projectOptions"
          :placeholder="t('quickTranslate.projectPlaceholder')"
          :loading="projects.loading"
          :aria-label="t('quickTranslate.projectLabel')"
        />
        <NAlert v-if="projectGlossaryDisabled" type="info" :bordered="false">
          {{ t('termExtraction.quickProjectDisabled') }}
        </NAlert>
      </div>

      <div class="space-y-2.5">
        <div class="space-y-0.5">
          <p class="text-xs font-medium text-lf-text-muted">
            {{ t('quickTranslate.glossaryTitle') }}
          </p>
          <p class="text-xs text-lf-text-subtle">{{ t('quickTranslate.glossaryHint') }}</p>
        </div>
        <div
          v-for="row in glossary"
          :key="row.id"
          class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-center"
        >
          <NInput
            v-model:value="row.source"
            size="small"
            :placeholder="t('quickTranslate.glossarySourcePlaceholder')"
          />
          <NInput
            v-model:value="row.target"
            size="small"
            :placeholder="t('quickTranslate.glossaryTargetPlaceholder')"
          />
          <NInput
            v-model:value="row.notes"
            size="small"
            :placeholder="t('quickTranslate.glossaryNotesPlaceholder')"
          />
          <NButton
            quaternary
            circle
            size="small"
            class="justify-self-end"
            :aria-label="t('quickTranslate.glossaryRemove')"
            @click="removeGlossaryRow(row.id)"
          >
            <IconCarbonClose />
          </NButton>
        </div>
        <NButton dashed size="small" @click="addGlossaryRow">
          <IconCarbonAdd />
          {{ t('quickTranslate.glossaryAdd') }}
        </NButton>
      </div>
    </div>

    <!-- 底部操作条：常驻复制按钮 + 主操作 -->
    <div
      class="flex flex-wrap items-center justify-between gap-2 border-t border-lf-border-soft px-4 py-2.5"
    >
      <button
        type="button"
        class="flex items-center gap-1.5 text-xs font-medium text-lf-text-muted transition-colors hover:text-lf-text-strong"
        @click="advancedOpen = !advancedOpen"
      >
        <IconCarbonChevronUp v-if="advancedOpen" class="text-base" />
        <IconCarbonChevronDown v-else class="text-base" />
        {{ t('quickTranslate.advancedToggle') }}
      </button>
      <div class="flex flex-wrap items-center gap-2">
        <NButton size="small" :disabled="!result?.target_text" @click="onCopyResult">
          <IconCarbonCopy />
          {{ t('quickTranslate.assistant.copyResult') }}
        </NButton>
        <NButton size="small" :disabled="!result?.target_text" @click="onCopyBilingual">
          <IconCarbonCopy />
          {{ t('quickTranslate.assistant.copyBilingual') }}
        </NButton>
        <NTooltip :disabled="submitBlockReason == null">
          <template #trigger>
            <span class="inline-flex">
              <NButton
                type="primary"
                size="small"
                :loading="submitting"
                :disabled="!canSubmit"
                @click="onSubmit"
              >
                <IconCarbonTranslate />
                {{
                  submitting
                    ? t('quickTranslate.submitting')
                    : mode === 'email'
                      ? t('quickTranslate.assistant.generateEmail')
                      : t('quickTranslate.assistant.generateTranslate')
                }}
              </NButton>
            </span>
          </template>
          {{ submitBlockReason }}
        </NTooltip>
      </div>
    </div>
  </section>
</template>
