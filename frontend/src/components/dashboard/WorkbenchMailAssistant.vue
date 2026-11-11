<script setup lang="ts">
/**
 * 工作台「外贸邮件与翻译助手」。
 *
 * 面向外贸日常高频沟通的双栏工作面：
 * - 模式切换：[智能互译] 通用双向翻译 / [外贸邮件回复]（左栏拆为「客户来信原文（可选，
 *   可折叠）」+「中文回复要点（必填）」上下双输入框，请求时结构化拼接）；
 * - 智能双向语种判定：源语言 auto 时按主导文字系统自动纠正翻译方向，并展示实际方向提示；
 * - 右侧结果可直接后编辑（Post-Edit），带词数统计、快捷微调（缩短/更委婉/更坚定/要点列表）
 *   与空状态可点击的高频示例胶囊；
 * - 工具栏挂载词库（可选项目上下文：注入强制术语与客户/产品背景，一键原地新建）；
 * - 键盘流：Ctrl/Cmd+Enter 生成、Ctrl/Cmd+Shift+C 复制最终译文、粘贴/清空快捷按钮；
 * - 本地历史：最近 20 条快翻/回信记录（scoped localStorage），支持一键回填与清空；
 * - 系统中暂无执行计划时自动回退到默认可用 AI 后端，不再阻断使用。
 */
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type { SelectMixedOption } from 'naive-ui/es/select/src/interface'

import { isAccessDenied } from '@/api/utils'
import { quickTranslate, fetchGlossaryEntries } from '@/api/client'
import type { ApiSchemas } from '@/api/client'
import { captureSession, getSessionScope, isSessionCurrent } from '@/api/session-context'
import { usePreferencesStore } from '@/stores/preferences'
import { useExecutionPlanTemplatesStore } from '@/stores/executionPlanTemplates'
import { useProjectsStore } from '@/stores/projects'
import { useGlossaryStore } from '@/stores/glossary'
import { useLanguageOptions } from '@/composables/useLanguageOptions'
import { getQualityCodeLabel } from '@/composables/useQualityIssues'
import { formatTokens, batchStatusTimelineType } from '@/composables/useWorkspaceUtils'
import { formatRelativeTime } from '@/utils/datetime'
import { extractErrorMessage } from '@/utils/errors'
import {
  clearWorkbenchDraft,
  isWorkbenchDraftEmpty,
  readWorkbenchDraft,
  shouldDeferToOtherTab,
  WORKBENCH_DRAFT_DEBOUNCE_MS,
  writeWorkbenchDraft,
  type WorkbenchDraft,
} from '@/utils/workbench-draft'
import SegmentTranslationPreviewDiagnostic from '@/components/workspace/SegmentTranslationPreviewDiagnostic.vue'
import {
  MAIL_ASSISTANT_SCENES,
  QUICK_REFINE_ACTIONS,
  QUICK_TARGET_LANGS,
  composeAssistantInstructions,
  composeEmailSourceText,
  composeRefineInstructions,
  countResultWords,
  formatBilingualCopy,
  pushMailAssistantHistory,
  resolveEffectiveTarget,
  resolveFailureNotice,
  isGenerationBusy,
  typewriterProgress,
  type GenerationState,
  type MailAssistantHistoryEntry,
  type MailAssistantMode,
  type MailAssistantSceneKey,
  type MailRefineKey,
} from './mail-assistant'

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const preferences = usePreferencesStore()
const glossaryStore = useGlossaryStore()
const context = captureSession()
let disposed = false
const current = () => !disposed && isSessionCurrent(context)
onScopeDispose(() => {
  disposed = true
  if (typewriterFrame !== null) cancelAnimationFrame(typewriterFrame)
  typewriterFrame = null
  genAbort?.abort()
  genAbort = null
})

const planTemplates = useExecutionPlanTemplatesStore()
const route = useRoute()
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
const incomingMail = ref('')
const replyPoints = ref('')
const incomingCollapsed = ref(false)
const sourceLang = ref('auto')
const targetLang = ref('zh-Hans')
const executionPlanId = ref<number | null>(null)
const projectId = ref<number | null>(null)
const glossary = ref<Array<{ id: number; source: string; target: string; notes: string }>>([])
const glossarySeq = ref(0)
const advancedOpen = ref(false)
const submitting = ref(false)

/** 统一生成状态机（idle/preparing/streaming/completed/stopped/error） */
const genState = ref<GenerationState>('idle')
/** 当前请求的取消控制：preparing 阶段中断等同于取消网络请求 */
let genAbort: AbortController | null = null
/** 请求序号：旧请求即使晚到，也不能覆盖新请求的结果 */
let genSeq = 0
/** 打字机动画帧与起点 */
let typewriterFrame: number | null = null
let typewriterStartedAt = 0
/** 系统是否要求减少动态效果（prefers-reduced-motion: reduce） */
const reducedMotion = ref(false)

/** preparing 或 streaming：同一个生成在途 */
const genBusy = computed(() => isGenerationBusy(genState.value))
/** 重新生成时保留上一版译文：仅在没有任何既有译文时才展示骨架 */
const genKeepPrevious = computed(() => genState.value === 'preparing' && hasResult.value)
/** 请求异常时的行内错误信息（与 result.status=failed 一并进入失败态展示） */
const inlineError = ref<string | null>(null)
const result = ref<ApiSchemas['QuickTranslateResponse'] | null>(null)
/** 后编辑文本：随结果生成初始化，用户可直接修改后再复制 */
const editableResult = ref('')

/* ── 本地历史（scoped localStorage） ─────────────────────────────── */

const HISTORY_STORAGE_KEY = 'linguaflow.mailAssistantHistory'
const history = ref<MailAssistantHistoryEntry[]>([])

const loadHistory = (): void => {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      history.value = parsed.filter(
        (item): item is MailAssistantHistoryEntry =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as MailAssistantHistoryEntry).source === 'string' &&
          typeof (item as MailAssistantHistoryEntry).target === 'string',
      )
    }
  } catch {
    // 历史只是辅助数据，损坏时直接放弃
  }
}

const saveHistory = (): void => {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.value))
  } catch {
    // 配额或隐私模式失败时静默降级为仅内存
  }
}

const clearHistory = (): void => {
  history.value = []
  saveHistory()
  message.success(t('quickTranslate.assistant.history.cleared'))
}

/** 把一条历史回填到当前模式对应的编辑器中。 */
const restoreHistoryEntry = (entry: MailAssistantHistoryEntry): void => {
  mode.value = entry.mode
  scene.value = entry.scene
  if (entry.mode === 'email') {
    // 结构化原文按标签块拆回两个输入框（找不到标签时整段进要点框）
    const incomingLabel = `${t('quickTranslate.assistant.incomingLabel')}\n`
    const pointsLabel = `${t('quickTranslate.assistant.pointsLabel')}\n`
    const incomingIndex = entry.source.indexOf(incomingLabel)
    if (incomingIndex >= 0) {
      const rest = entry.source.slice(incomingIndex + incomingLabel.length)
      const pointsIndex = rest.indexOf(`\n\n${pointsLabel}`)
      incomingMail.value = (pointsIndex >= 0 ? rest.slice(0, pointsIndex) : rest).trim()
      replyPoints.value =
        pointsIndex >= 0 ? rest.slice(pointsIndex + 2 + pointsLabel.length).trim() : ''
    } else {
      replyPoints.value = entry.source
    }
    incomingCollapsed.value = incomingMail.value.trim() === ''
  } else {
    sourceText.value = entry.source
  }
  editableResult.value = entry.target
  message.success(t('quickTranslate.assistant.history.restored'))
}

/* ── 有效源文本与目标语言判定 ───────────────────────────────────── */

/** 当前模式的请求原文：邮件模式为「来信上下文 + 回复要点」结构化拼接。 */
const activeSourceText = computed(() => {
  if (mode.value !== 'email') return sourceText.value
  return composeEmailSourceText({
    incomingMail: incomingMail.value,
    replyPoints: replyPoints.value,
    incomingLabel: t('quickTranslate.assistant.incomingLabel'),
    pointsLabel: t('quickTranslate.assistant.pointsLabel'),
  })
})

const effectiveTarget = computed(() =>
  resolveEffectiveTarget({
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
    text: activeSourceText.value,
  }),
)

const languageLabelOf = (code: string): string => {
  const option = targetLanguageOptions.value.find((item) => item.value === code)
  return option ? String(option.label ?? code).split(' · ')[0] ?? code : code
}

const detectedLabel = computed(() =>
  effectiveTarget.value.detected === 'han'
    ? languageLabelOf('zh-Hans')
    : languageLabelOf('en'),
)

const directionHint = computed(() => {
  // neutral（纯数字/空白）与非 auto 时都没有可靠的「实际方向」可言，不显示提示
  if (
    sourceLang.value !== 'auto' ||
    effectiveTarget.value.detected === null ||
    effectiveTarget.value.detected === 'neutral'
  ) {
    return ''
  }
  return t('quickTranslate.assistant.directionHint', {
    from: detectedLabel.value,
    to: languageLabelOf(effectiveTarget.value.lang),
  })
})

/**
 * 目标语言下拉选项：常用外贸语种置顶分组，其余语种归入「全部语种」。
 * （原平铺的 7 个语种快捷按钮已并入该下拉，智能双向判定逻辑不受影响。）
 */
const assistantTargetLanguageOptions = computed<SelectMixedOption[]>(() => {
  const all = targetLanguageOptions.value
  const quickSet = new Set<string>(QUICK_TARGET_LANGS)
  const quick = all.filter((option) => quickSet.has(String(option.value)))
  const rest = all.filter((option) => !quickSet.has(String(option.value)))
  return [
    {
      type: 'group',
      label: t('quickTranslate.assistant.quickLangLabel'),
      key: 'assistant-target-quick',
      children: quick,
    },
    {
      type: 'group',
      label: t('quickTranslate.assistant.moreLanguages'),
      key: 'assistant-target-more',
      children: rest,
    },
  ]
})

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

/* ── 工具栏「挂载词库」：未挂载=独立模式；列表底部支持原地一键新建 ── */

/** NPopselect 的哨兵值：表示「未挂载（独立模式）」 */
const MOUNT_UNMOUNTED = -1
/** NPopselect 的哨兵值：选中后弹出「一键新建词库」输入框 */
const MOUNT_CREATE = -2

const mountOptions = computed<SelectMixedOption[]>(() => [
  ...projects.items.map((item) => ({
    label: item.name,
    value: item.id,
    disabled: item.glossary_enabled === false,
  })),
  { type: 'divider', key: 'mount-divider' },
  {
    label: t('quickTranslate.assistant.mountCreateOption'),
    value: MOUNT_CREATE,
    class: 'text-brand-500',
  },
])

const quickCreateShow = ref(false)
const quickCreateName = ref('')
const quickCreating = ref(false)

const onMountChange = (value: number): void => {
  if (value === MOUNT_CREATE) {
    quickCreateName.value = ''
    quickCreateShow.value = true
    return
  }
  projectId.value = value === MOUNT_UNMOUNTED ? null : value
}

/** 一键新建词库：仅需名称；存储空间由后端自动兜底绑定。 */
const createAndMount = async (): Promise<void> => {
  const name = quickCreateName.value.trim()
  if (!name) return
  quickCreating.value = true
  const session = captureSession()
  try {
    projects.setOrganization(preferences.selectedOrgId)
    const project = await projects.createProject({
      name,
      glossary_enabled: true,
      source_lang: 'auto',
      target_lang: 'zh-Hans',
    })
    if (!isSessionCurrent(session)) return
    projectId.value = project.id
    quickCreateShow.value = false
    message.success(t('quickTranslate.assistant.mountCreated'))
  } catch (error) {
    if (!isSessionCurrent(session)) return
    message.error(
      extractErrorMessage(error, t('quickTranslate.assistant.mountCreateFailed')),
    )
  } finally {
    if (isSessionCurrent(session)) quickCreating.value = false
  }
}

/* ── 存为术语：把工作台发现的词汇沉淀到当前词库（未挂载时自动创建默认词库） ── */

const saveTermShow = ref(false)
const saveTermSource = ref('')
const saveTermTarget = ref('')
const saveTermNotes = ref('')
const saveTermError = ref<string | null>(null)
const saveTermSubmitting = ref(false)

const openSaveTerm = (): void => {
  saveTermSource.value = ''
  saveTermTarget.value = ''
  saveTermNotes.value = ''
  saveTermError.value = null
  saveTermShow.value = true
}

/** 零前置：未挂载词库时自动创建「默认词库」并挂载，返回可用词库 id */
const ensureMountedForSave = async (): Promise<number> => {
  if (projectId.value != null) return projectId.value
  projects.setOrganization(preferences.selectedOrgId)
  const project = await projects.createProject({
    name: t('quickTranslate.assistant.defaultGlossaryName'),
    glossary_enabled: true,
    source_lang: 'auto',
    target_lang: 'zh-Hans',
  })
  projectId.value = project.id
  return project.id
}

const saveTerm = async (): Promise<void> => {
  const source = saveTermSource.value.trim()
  const target = saveTermTarget.value.trim()
  if (!source || !target) {
    saveTermError.value = t('quickTranslate.assistant.saveTermRequired')
    return
  }
  // 同源冲突预检（客户端先拦一道；服务端 409 仍会被兜底展示）
  if (projectGlossary.value.some((entry) => entry.source === source)) {
    saveTermError.value = t('quickTranslate.assistant.saveTermConflict')
    return
  }
  saveTermSubmitting.value = true
  saveTermError.value = null
  const session = captureSession()
  try {
    const pid = await ensureMountedForSave()
    await glossaryStore.createEntry(pid, {
      source,
      target,
      mandatory: true,
      notes: saveTermNotes.value.trim() || undefined,
    })
    if (!isSessionCurrent(session)) return
    saveTermShow.value = false
    message.success(t('quickTranslate.assistant.saveTermDone'))
  } catch (error) {
    if (!isSessionCurrent(session)) return
    saveTermError.value = extractErrorMessage(error, t('quickTranslate.assistant.saveTermFailed'))
  } finally {
    if (isSessionCurrent(session)) saveTermSubmitting.value = false
  }
}
/* ── 挂载状态持久化：记住最近挂载的词库，404/403 时静默清空回退独立模式 ── */

watch(
  projectId,
  (id) => {
    preferences.quickTranslateProjectId = id
  },
  { immediate: true },
)

/** 初始化：恢复最近挂载；词库不存在/无权限时由术语加载失败分支静默清空。
 * 详情页「在工作台使用」以 ?project=<id> 深链跳转，这里优先采纳。 */
const applyProjectBoot = (): void => {
  const deepLinked = Number.parseInt(String(route.query.project ?? ''), 10)
  if (Number.isInteger(deepLinked) && deepLinked > 0) {
    projectId.value = deepLinked
    return
  }
  const stored = preferences.quickTranslateProjectId
  if (stored != null) projectId.value = stored
}

onMounted(() => {
  applyProjectBoot()
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = media.matches
  const onChange = (event: MediaQueryListEvent): void => {
    reducedMotion.value = event.matches
  }
  media.addEventListener('change', onChange)
  onScopeDispose(() => media.removeEventListener('change', onChange))
})
// 被 KeepAlive 缓存后再次进入（例如从详情页带 ?project= 深链返回）时重新应用。
onActivated(applyProjectBoot)

const projectGlossaryDisabled = computed(
  () => projects.items.find((item) => item.id === projectId.value)?.glossary_enabled === false,
)

/* ── 项目术语表联动：自动加载并在高级选项中预览将生效的强制术语 ── */

const projectGlossary = ref<ApiSchemas['GlossaryEntry'][]>([])
const projectGlossaryLoading = ref(false)
const projectGlossaryError = ref<string | null>(null)

watch(projectId, (id) => {
  projectGlossary.value = []
  projectGlossaryError.value = null
  if (id == null) return
  projectGlossaryLoading.value = true
  fetchGlossaryEntries(id)
    .then((response) => {
      if (!current()) return
      projectGlossary.value = response.items
    })
    .catch((error) => {
      if (!current()) return
      // 恢复的挂载指向已删除/无权限的词库时静默清空，回退独立模式（不打扰用户）。
      if (isAccessDenied(error)) {
        projectId.value = null
        return
      }
      projectGlossaryError.value = extractErrorMessage(
        error,
        t('quickTranslate.assistant.projectGlossaryLoadFailed'),
      )
    })
    .finally(() => {
      if (current()) projectGlossaryLoading.value = false
    })
})

/** 项目术语已由 project_id 链路在后端生效（不重复注入请求术语表），这里仅预览。 */
const mandatoryGlossaryCount = computed(
  () => projectGlossary.value.filter((entry) => entry.mandatory ?? false).length,
)

/* ── 执行计划选择 ─────────────────────────────────────────────── */

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

/* ── 提交条件与状态 ─────────────────────────────────────────────── */

const canSubmit = computed(
  () =>
    activeSourceText.value.trim().length > 0 &&
    (mode.value !== 'email' || replyPoints.value.trim().length > 0) &&
    !genBusy.value,
)

// 禁用按钮的悬停指引：按优先级给出第一个未满足的条件
const submitBlockReason = computed<string | null>(() => {
  if (genBusy.value) return null
  if (mode.value === 'email' && !replyPoints.value.trim())
    return t('quickTranslate.assistant.replyPointsRequired')
  if (!activeSourceText.value.trim()) return t('quickTranslate.validation.sourceRequired')
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

const resultStats = computed(() => countResultWords(editableResult.value))

const hasResult = computed(() => editableResult.value.trim().length > 0)

/**
 * 失败态的行内原因（见 mail-assistant.resolveFailureNotice）。
 */
const failureNotice = computed<string | null>(() =>
  resolveFailureNotice(
    inlineError.value,
    result.value,
    hasResult.value,
    t('quickTranslate.messages.failed'),
  ),
)

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

/** 挂载词库后注入其客户/产品背景（project.config.background）作为上下文。 */
const mountedProject = computed(() => projects.items.find((item) => item.id === projectId.value))
const mountedBackground = computed(() => {
  const raw = mountedProject.value?.config?.background
  return typeof raw === 'string' ? raw.trim() : ''
})
const buildInstructions = (): string => {
  const base = composeAssistantInstructions({
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
  if (!mountedBackground.value) return base
  return base
    ? `${base}\n${t('quickTranslate.assistant.backgroundPrefix')}${mountedBackground.value}`
    : `${t('quickTranslate.assistant.backgroundPrefix')}${mountedBackground.value}`
}

/* ── 草稿保护：路由往返靠 KeepAlive，刷新/重开靠本地自动保存 ───────── */

const draftScope = getSessionScope()
/** 页面实例标识：用于多标签页冲突检测（同标签页的旧草稿不算冲突）。 */
const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const draftConflict = ref<{ updated_at: string; tab_id: string } | null>(null)
/** 轻量保存态：仅在成功/失败时更新，避免每次输入都闪烁。 */
const draftSavedAt = ref<number | null>(null)
const draftSaveFailed = ref(false)
const draftSavedHint = computed(() => {
  if (!draftSavedAt.value) return null
  return t('quickTranslate.assistant.draftSavedAt', {
    time: new Date(draftSavedAt.value).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
  })
})
let draftTimer: ReturnType<typeof setTimeout> | null = null
/** 本页已知的草稿时间戳（毫秒），用于判断是否被其他标签页抢先写入。 */
let draftSeenAt = 0

const buildDraft = (): WorkbenchDraft => ({
  version: 1,
  updated_at: new Date().toISOString(),
  tab_id: tabId,
  mode: mode.value,
  scene: scene.value,
  source_lang: sourceLang.value,
  target_lang: targetLang.value,
  source_text: sourceText.value,
  incoming_mail: incomingMail.value,
  reply_points: replyPoints.value,
  result_text: editableResult.value,
  result: result.value
    ? {
        status: result.value.status,
        warnings: result.value.warnings ?? [],
        quality_issues: result.value.quality_issues ?? [],
        round_summary: result.value.round_summary ?? [],
      }
    : null,
  glossary: glossary.value.map((row) => ({ ...row })),
  incoming_collapsed: incomingCollapsed.value,
  advanced_open: advancedOpen.value,
})

/** 把草稿回填到编辑器（只恢复可序列化的工作成果与必要上下文）。 */
const applyDraft = (draft: WorkbenchDraft): void => {
  mode.value = draft.mode
  scene.value = (draft.scene as MailAssistantSceneKey | null) ?? null
  sourceLang.value = draft.source_lang
  targetLang.value = draft.target_lang
  sourceText.value = draft.source_text
  incomingMail.value = draft.incoming_mail
  replyPoints.value = draft.reply_points
  editableResult.value = draft.result_text
  result.value = draft.result
    ? ({ ...draft.result } as unknown as ApiSchemas['QuickTranslateResponse'])
    : null
  glossary.value = draft.glossary.map((row) => ({ ...row }))
  glossarySeq.value = draft.glossary.reduce((max, row) => Math.max(max, row.id), 0)
  incomingCollapsed.value = draft.incoming_collapsed
  advancedOpen.value = draft.advanced_open
  draftSeenAt = Date.parse(draft.updated_at) || 0
}

const saveDraftNow = (): void => {
  if (!draftScope || draftConflict.value) return
  const draft = buildDraft()
  const stored = readWorkbenchDraft(draftScope)
  // 其他标签页写了更新的草稿：停下来提示用户选择，绝不静默覆盖。
  if (stored && shouldDeferToOtherTab(stored, tabId, draftSeenAt)) {
    draftConflict.value = { updated_at: stored.updated_at, tab_id: stored.tab_id }
    return
  }
  if (isWorkbenchDraftEmpty(draft)) {
    clearWorkbenchDraft(draftScope)
    draftSeenAt = Date.now()
    draftSaveFailed.value = false
    draftSavedAt.value = null
    return
  }
  const ok = writeWorkbenchDraft(draftScope, draft)
  draftSaveFailed.value = !ok
  if (ok) draftSavedAt.value = Date.parse(draft.updated_at) || Date.now()
  draftSeenAt = Date.parse(draft.updated_at) || Date.now()
}

/** 输入类变化做 300ms 防抖，避免连续输入时频繁写 localStorage。 */
const scheduleDraftSave = (): void => {
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    draftTimer = null
    saveDraftNow()
  }, WORKBENCH_DRAFT_DEBOUNCE_MS)
}

const flushDraft = (): void => {
  if (draftTimer) {
    clearTimeout(draftTimer)
    draftTimer = null
  }
  saveDraftNow()
}

/** 恢复草稿：仅在本地确有有效内容时回填，损坏/为空时保持空白工作台。 */
const restoreDraft = (): void => {
  const draft = readWorkbenchDraft(draftScope)
  if (!draft || isWorkbenchDraftEmpty(draft)) return
  applyDraft(draft)
  draftSavedAt.value = Date.parse(draft.updated_at) || null
}

const dismissDraftConflict = (): void => {
  // 关闭提示 = 保留本页版本：把已知草稿时间对齐到对方版本，避免每次保存都再次报警。
  const stored = readWorkbenchDraft(draftScope)
  if (stored) draftSeenAt = Date.parse(stored.updated_at) || draftSeenAt
  draftConflict.value = null
  saveDraftNow()
}
const loadOtherTabDraft = (): void => {
  const other = readWorkbenchDraft(draftScope)
  draftConflict.value = null
  if (!other || isWorkbenchDraftEmpty(other)) return
  applyDraft(other)
  message.success(t('quickTranslate.assistant.draftConflictLoaded'))
}
const overwriteOtherTabDraft = (): void => {
  draftConflict.value = null
  draftSeenAt = 0
  saveDraftNow()
  message.success(t('quickTranslate.assistant.draftConflictOverwritten'))
}

watch(
  [mode, scene, sourceLang, targetLang, sourceText, incomingMail, replyPoints, editableResult, glossary, incomingCollapsed, advancedOpen],
  () => {
      scheduleDraftSave()
  },
  { deep: true },
)

/* ── 内容呈现：首段到达即展示真实文本，再按打字机节奏补齐 ───────── */

const cancelTypewriter = (): void => {
  if (typewriterFrame !== null) cancelAnimationFrame(typewriterFrame)
  typewriterFrame = null
}

/**
 * 把已收到的完整译文按 TYPEWRITER_CPS 的节奏补显。
 * 注意：后端当前为一次性 JSON（无 SSE），因此首段内容即全文；
 * 这里只在“展示节奏”上做平滑，不伪造百分比进度。
 */
const startTypewriter = (fullText: string): void => {
  cancelTypewriter()
  if (!fullText.trim()) {
    editableResult.value = ''
    genState.value = 'completed'
    return
  }
  // 减少动态效果：直接完整展示，不做逐字动画
  if (reducedMotion.value) {
    editableResult.value = fullText
    genState.value = 'completed'
    return
  }
  genState.value = 'streaming'
  typewriterStartedAt = performance.now()
  const step = (now: number): void => {
    if (genState.value !== 'streaming') return
    const showed = typewriterProgress(fullText, now - typewriterStartedAt)
    editableResult.value = showed
    if (showed.length >= fullText.length) {
      editableResult.value = fullText
      genState.value = 'completed'
      typewriterFrame = null
      return
    }
    typewriterFrame = requestAnimationFrame(step)
  }
  typewriterFrame = requestAnimationFrame(step)
}

/**
 * 停止生成：preparing 阶段真正取消网络请求；streaming 阶段停止补显。
 * 两种情况都保留已接收到的文本。
 */
const stopGeneration = (): void => {
  if (!genBusy.value) return
  genSeq += 1 // 使在途响应失效，避免晚到后覆盖停止态
  if (genState.value === 'preparing') {
    genAbort?.abort()
    genAbort = null
  }
  cancelTypewriter()
  submitting.value = false
  genState.value = 'stopped'
  if (hasResult.value) message.info(t('quickTranslate.assistant.stoppedHint'))
}

/* ── 提交（生成 / 快捷微调共用同一链路） ───────────────────────── */

const submitCore = async (refineKey: MailRefineKey | null): Promise<void> => {
  if (!canSubmit.value) return
  const seq = ++genSeq
  genAbort?.abort()
  const controller = new AbortController()
  genAbort = controller
  cancelTypewriter()
  // 重新生成不清空上一版译文：先记录，若本次失败则原样恢复
  const previousResult = result.value
  const previousText = editableResult.value
  submitting.value = true
  genState.value = 'preparing'
  inlineError.value = null
  const rawSource = activeSourceText.value
  // 上下文快照：原文/项目/语言方向任一变更，这次结果就已过期
  const submittedContext = {
    source: rawSource,
    projectId: projectId.value,
    sourceLang: sourceLang.value,
    targetLang: effectiveTarget.value.lang,
  }
  const contextChanged = (): boolean =>
    submittedContext.source !== activeSourceText.value ||
    submittedContext.projectId !== projectId.value ||
    submittedContext.sourceLang !== sourceLang.value ||
    submittedContext.targetLang !== effectiveTarget.value.lang
  try {
    // 专有格式保护交给后端执行：后端 pipeline 自带 Protector（含占位符一致性校验）。
    // 前端不再预保护——把 __LF_xxx__ 占位符发给快翻接口会让模型丢占位符、
    // 触发后端校验拒绝，进而把整段译文标成 failed 并清空。
    const payload: ApiSchemas['QuickTranslateRequest'] = {
      source_text: rawSource,
      source_lang: sourceLang.value,
      target_lang: effectiveTarget.value.lang,
    }
    // 有可用执行计划时按计划执行；否则回退到默认 AI 后端（后端自动选择）。
    if (selectedPlanTranslatable.value && executionPlanId.value != null) {
      payload.execution_plan_id = executionPlanId.value
    }
    let instructions = buildInstructions()
    if (refineKey) {
      instructions = composeRefineInstructions(
        instructions,
        t(`quickTranslate.assistant.refines.${refineKey}.instruction`),
      )
    }
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
    const res = await quickTranslate(payload, undefined, controller.signal)
    if (seq !== genSeq || !current()) return
    // 原文/项目/语言方向在请求期间被改动：结果已不属于当前上下文，丢弃并提示
    if (contextChanged()) {
      result.value = previousResult
      editableResult.value = previousText
      genState.value = 'stopped'
      message.warning(t('quickTranslate.assistant.contextChangedHint'))
      return
    }
    result.value = res
    // 原则：只要拿到了译文就展示，绝不因占位符/保护校验问题清空结果。
    // failed 时 target_text 可能为空 → 走行内失败态；有译文则用打字机逐字呈现（status Tag 仍标注失败/部分）。
    startTypewriter(res.target_text)
    if (res.status === 'success') {
      message.success(
        refineKey
          ? t('quickTranslate.assistant.refineDone', {
              label: t(`quickTranslate.assistant.refines.${refineKey}.label`),
            })
          : t('quickTranslate.messages.success'),
      )
      history.value = pushMailAssistantHistory(history.value, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: mode.value,
        scene: scene.value,
        source: rawSource,
        target: res.target_text,
        created_at: new Date().toISOString(),
      })
      saveHistory()
    } else if (res.status === 'partial') message.warning(t('quickTranslate.messages.partial'))
  } catch (err) {
    if (seq !== genSeq) return
    if (controller.signal.aborted) {
      // 用户主动停止：保留上一版译文，进入停止态而非错误态
      result.value = previousResult
      editableResult.value = previousText
      genState.value = 'stopped'
      message.info(t('quickTranslate.assistant.stoppedHint'))
      return
    }
    if (!current()) return
    // 失败不覆盖用户已有的有效译文：回滚到生成前的内容，错误单独展示
    result.value = previousResult
    editableResult.value = previousText
    genState.value = 'error'
    // 行内展示错误原因（并保留 Toast），用户不必去「处理详情」里找原因。
    inlineError.value = extractErrorMessage(err, t('quickTranslate.messages.failed'))
    // 挂载的词库已删除/无权限：静默解除挂载，避免每次翻译都失败。
    if (projectId.value != null && isAccessDenied(err)) {
      projectId.value = null
      message.warning(t('quickTranslate.assistant.unmountedByPermission'))
    }
    message.error(inlineError.value)
  } finally {
    if (seq === genSeq) {
      submitting.value = false
      genAbort = null
    }
  }
}

const onSubmit = async (): Promise<void> => {
  await submitCore(null)
}

/** 快捷微调：基于当前设置与原文触发二次生成（仅已有结果时可用）。 */
const onRefine = async (key: MailRefineKey): Promise<void> => {
  if (!hasResult.value || genBusy.value) return
  await submitCore(key)
}

/* ── 剪贴板与键盘流 ─────────────────────────────────────────────── */

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

/** 一键复制：复制后编辑过的最终译文。 */
const onCopyResult = async (): Promise<void> => {
  await copyToClipboard(editableResult.value, 'quickTranslate.copySuccess')
}

/** 双语对照复制：原文与最终译文成对输出，便于粘贴到邮件/工单里核对。 */
const onCopyBilingual = async (): Promise<void> => {
  if (!editableResult.value) return
  const text = formatBilingualCopy({
    source: activeSourceText.value,
    target: editableResult.value,
    sourceLabel: t('quickTranslate.assistant.bilingualSourceLabel'),
    targetLabel: t('quickTranslate.assistant.bilingualTargetLabel'),
  })
  await copyToClipboard(text, 'quickTranslate.assistant.copyBilingualSuccess')
}

/** Ctrl/Cmd + Enter 直接触发生成；Ctrl/Cmd + Shift + C 复制最终译文（全局）。 */
const isSubmitShortcut = (event: KeyboardEvent): boolean =>
  (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key === 'Enter'

const onEditorKeydown = (event: KeyboardEvent): void => {
  if (isSubmitShortcut(event)) {
    event.preventDefault()
    void onSubmit()
  }
}

const onGlobalKeydown = (event: KeyboardEvent): void => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    (event.key === 'C' || event.key === 'c') &&
    hasResult.value
  ) {
    event.preventDefault()
    void onCopyResult()
  }
}

/* ── 左栏快捷操作：粘贴 / 清空 ─────────────────────────────────── */

const pasteIntoEditor = async (): Promise<void> => {
  try {
    const text = await navigator.clipboard.readText()
    if (!current()) return
    if (!text.trim()) {
      message.warning(t('quickTranslate.assistant.pasteEmpty'))
      return
    }
    if (mode.value === 'email') {
      replyPoints.value = replyPoints.value ? `${replyPoints.value}\n${text}` : text
    } else {
      sourceText.value = sourceText.value ? `${sourceText.value}\n${text}` : text
    }
  } catch {
    if (!current()) return
    message.error(t('quickTranslate.assistant.pasteFailed'))
  }
}

/**
 * 清空草稿：左栏输入与右侧结果一并清空，并删除本地草稿副本，
 * 确保刷新后不会把已经明确丢弃的内容重新恢复出来。
 */
const clearLeftEditor = (): void => {
  if (mode.value === 'email') {
    incomingMail.value = ''
    replyPoints.value = ''
  } else {
    sourceText.value = ''
  }
  result.value = null
  editableResult.value = ''
  inlineError.value = null
  clearWorkbenchDraft(draftScope)
}

/* ── 空状态示例胶囊 ─────────────────────────────────────────────── */

const EXAMPLE_KEYS = ['one', 'two', 'three'] as const

const applyExample = (key: (typeof EXAMPLE_KEYS)[number]): void => {
  const text = t(`quickTranslate.assistant.examples.${key}.text`)
  if (mode.value === 'email') {
    replyPoints.value = text
  } else {
    sourceText.value = text
  }
  message.success(t('quickTranslate.assistant.exampleFilled'))
}

const toggleIncoming = (): void => {
  incomingCollapsed.value = !incomingCollapsed.value
}

onMounted(() => {
  if (!planTemplates.items.length) {
    void planTemplates.loadTemplates().then(applyExecutionPlanDefault)
  } else {
    applyExecutionPlanDefault()
  }
  if (!projects.items.length) void projects.loadProjects()
  loadHistory()
  // 先恢复草稿，再挂全局快捷键：恢复过程本身不应触发额外的保存/提交。
  restoreDraft()
  window.addEventListener('keydown', onGlobalKeydown)
})

// KeepAlive 缓存期间快捷键监听仍会留在 window 上，离开工作台时必须摘掉，
// 否则 Ctrl+Shift+C 等组合会在其他页面误触发；同时把未落盘的输入补写一次。
onDeactivated(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  flushDraft()
})
onActivated(() => {
  window.addEventListener('keydown', onGlobalKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  flushDraft()
})
</script>

<template>
  <section class="lf-panel flex min-h-0 flex-col overflow-hidden">
    <!-- 头部：标题 + 历史记录 + 模式切换 -->
    <div
      class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-lf-border-soft px-4 py-2.5"
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
      <div class="flex items-center gap-2">
        <NPopover trigger="click" placement="bottom-end" :width="340">
          <template #trigger>
            <NButton quaternary size="tiny" :aria-label="t('quickTranslate.assistant.history.button')">
              <IconCarbonTime class="text-base" />
              {{ t('quickTranslate.assistant.history.button') }}
            </NButton>
          </template>
          <div class="flex flex-col gap-2">
            <p class="text-xs font-medium text-lf-text-muted">
              {{ t('quickTranslate.assistant.history.title', { count: history.length }) }}
            </p>
            <div v-if="history.length" class="max-h-72 overflow-auto">
              <button
                v-for="entry in history"
                :key="entry.id"
                type="button"
                class="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-lf-surface-muted"
                @click="restoreHistoryEntry(entry)"
              >
                <span class="flex items-center gap-2 text-[11px] text-lf-text-subtle">
                  <NTag size="tiny" :bordered="false">
                    {{
                      entry.mode === 'email'
                        ? t('quickTranslate.assistant.modeEmail')
                        : t('quickTranslate.assistant.modeTranslate')
                    }}
                  </NTag>
                  <span>{{ formatRelativeTime(entry.created_at) }}</span>
                </span>
                <span class="truncate text-xs text-lf-text">{{ entry.source }}</span>
                <span class="truncate text-xs text-lf-text-muted">{{ entry.target }}</span>
              </button>
            </div>
            <p v-else class="text-xs text-lf-text-subtle">
              {{ t('quickTranslate.assistant.history.empty') }}
            </p>
            <NButton
              v-if="history.length"
              quaternary
              size="tiny"
              type="error"
              class="self-start"
              @click="clearHistory"
            >
              <IconCarbonDelete class="text-base" />
              {{ t('quickTranslate.assistant.history.clear') }}
            </NButton>
          </div>
        </NPopover>
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
    </div>

    <!--
      工具条（单行紧凑）：左=场景胶囊，右=语言对（下拉框内已含常用外贸语种分组）+ 执行计划。
      lg 及以上强制不折行（flex-nowrap），窄屏保持可折行的响应式行为。
    -->
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-lf-border-soft bg-lf-surface-muted/40 px-4 py-1.5 lg:flex-nowrap"
      :aria-label="t('quickTranslate.assistant.toolbarLabel')"
    >
      <div
        class="flex min-w-0 flex-wrap items-center gap-1.5"
        :class="mode === 'email' ? '' : 'opacity-80'"
      >
        <span
          class="shrink-0 text-xs font-medium whitespace-nowrap"
          :class="mode === 'email' ? 'text-lf-text' : 'text-lf-text-subtle'"
        >
          {{ t('quickTranslate.assistant.sceneLabel') }}
        </span>
        <button
          v-for="key in MAIL_ASSISTANT_SCENES"
          :key="key"
          type="button"
          class="shrink-0 rounded-full border px-2.5 py-1 text-xs leading-4 font-medium whitespace-nowrap transition-colors"
          :class="
            scene === key
              ? 'border-brand-500 bg-brand-500 text-white'
              : mode === 'email'
                ? 'border-lf-border bg-lf-surface text-lf-text-muted hover:border-brand-500 hover:text-lf-text-strong'
                : 'border-transparent bg-lf-surface text-lf-text-subtle hover:bg-lf-surface-muted hover:text-lf-text-strong'
          "
          :aria-pressed="scene === key"
          @click="toggleScene(key)"
        >
          {{ t(`quickTranslate.assistant.scenes.${key}.label`) }}
        </button>
      </div>

      <div class="ml-auto flex min-w-0 items-center gap-2 lg:min-w-0 lg:flex-nowrap">
        <span
          class="shrink-0 text-xs font-medium whitespace-nowrap"
          :class="projectId ? 'text-lf-text' : 'text-lf-text-subtle'"
        >
          {{ t('quickTranslate.assistant.mountLabel') }}
        </span>
        <NPopselect
          :value="projectId ?? MOUNT_UNMOUNTED"
          size="small"
          scrollable
          :options="mountOptions"
          :aria-label="t('quickTranslate.assistant.mountLabel')"
          @update:value="onMountChange"
        >
          <button
            type="button"
            class="flex max-w-44 shrink-0 items-center gap-1.5 rounded-lg border border-lf-border bg-lf-surface px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-brand-400"
            :aria-label="t('quickTranslate.assistant.mountLabel')"
          >
            <IconCarbonDataBlob class="text-sm text-brand-500" aria-hidden="true" />
            <span class="min-w-0 truncate">{{
              mountedProject?.name ?? t('quickTranslate.assistant.unmountedLabel')
            }}</span>
            <NTag
              v-if="projectId && mandatoryGlossaryCount > 0"
              size="tiny"
              type="info"
              :bordered="false"
              class="shrink-0"
            >
              {{ t('quickTranslate.assistant.mountedTerms', { count: mandatoryGlossaryCount }) }}
            </NTag>
          </button>
        </NPopselect>
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
          :options="assistantTargetLanguageOptions"
          :render-label="renderLanguageLabel"
          :aria-label="t('quickTranslate.targetLangLabel')"
        />
        <NSelect
          class="w-[140px]!"
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
      </div>
    </div>

    <!-- 多标签页冲突提示：检测到其他标签页写入了更新的草稿时不静默覆盖 -->
    <NAlert
      v-if="draftConflict"
      type="warning"
      :bordered="false"
      class="shrink-0 rounded-none!"
      closable
      @close="dismissDraftConflict"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs">{{ t('quickTranslate.assistant.draftConflict') }}</span>
        <div class="flex items-center gap-1.5">
          <NButton size="tiny" secondary @click="loadOtherTabDraft">
            {{ t('quickTranslate.assistant.draftConflictLoad') }}
          </NButton>
          <NButton size="tiny" type="primary" secondary @click="overwriteOtherTabDraft">
            {{ t('quickTranslate.assistant.draftConflictOverwrite') }}
          </NButton>
        </div>
      </div>
    </NAlert>

    <!-- 双栏对照：左输入 / 右结果（纵向撑满面板剩余高度） -->
    <div class="grid min-h-[280px] flex-1 gap-px bg-lf-border-soft md:grid-cols-2">
      <!-- 左栏：智能互译为单输入框；外贸邮件回复拆为来信（可选/可折叠）+ 回复要点 -->
      <div class="flex min-h-0 min-w-0 flex-col bg-lf-surface p-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="truncate text-xs font-medium text-lf-text-muted">
            {{
              mode === 'email'
                ? t('quickTranslate.assistant.pointsTitle')
                : t('quickTranslate.assistant.inputTitle')
            }}
          </span>
          <div class="flex shrink-0 items-center gap-2">
            <NTag
              v-if="directionHint"
              size="tiny"
              :type="effectiveTarget.switched ? 'info' : 'default'"
              :bordered="false"
            >
              {{ directionHint }}
            </NTag>
            <NButton
              quaternary
              size="tiny"
              :aria-label="t('quickTranslate.assistant.paste')"
              @click="pasteIntoEditor"
            >
              <IconCarbonPaste class="text-base" />
            </NButton>
            <NButton
              quaternary
              size="tiny"
              :aria-label="t('quickTranslate.assistant.clear')"
              @click="clearLeftEditor"
            >
              <IconCarbonClose class="text-base" />
            </NButton>
            <span class="text-xs text-lf-text-subtle tabular-nums">
              {{ t('quickTranslate.charCount', { count: activeSourceText.length }) }}
            </span>
          </div>
        </div>

        <template v-if="mode === 'email'">
          <!-- 上框：客户来信原文（可选，一键折叠/展开） -->
          <button
            type="button"
            class="mb-1 flex w-fit items-center gap-1 text-xs font-medium text-lf-text-muted transition-colors hover:text-lf-text-strong"
            :aria-expanded="!incomingCollapsed"
            @click="toggleIncoming"
          >
            <IconCarbonChevronUp v-if="!incomingCollapsed" class="text-xs" />
            <IconCarbonChevronRight v-else class="text-xs" />
            {{ t('quickTranslate.assistant.incomingTitle') }}
          </button>
          <NInput
            v-if="!incomingCollapsed"
            v-model:value="incomingMail"
            type="textarea"
            :autosize="false"
            class="min-h-0 shrink-0!"
            :style="{ flex: '0 0 35%' }"
            :placeholder="t('quickTranslate.assistant.incomingPlaceholder')"
            :input-props="{ 'aria-label': t('quickTranslate.assistant.incomingLabel') }"
            @keydown="onEditorKeydown"
          />
          <!-- 下框：中文回复要点（必填，占左栏剩余高度） -->
          <NInput
            v-model:value="replyPoints"
            type="textarea"
            :autosize="false"
            class="mt-2 min-h-0 flex-1!"
            :placeholder="t('quickTranslate.assistant.replyPlaceholder')"
            :input-props="{ 'aria-label': t('quickTranslate.assistant.pointsLabel') }"
            @keydown="onEditorKeydown"
          />
        </template>
        <NInput
          v-else
          v-model:value="sourceText"
          type="textarea"
          :autosize="false"
          class="min-h-0 flex-1!"
          :placeholder="t('quickTranslate.assistant.inputPlaceholder')"
          :input-props="{ 'aria-label': t('quickTranslate.sourceLabel') }"
          @keydown="onEditorKeydown"
        />
      </div>

      <!-- 右栏：可直接后编辑的结果区 -->
      <div class="flex min-h-0 min-w-0 flex-col bg-lf-surface p-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-medium text-lf-text-muted">
            {{
              mode === 'email'
                ? t('quickTranslate.assistant.resultTitleEmail')
                : t('quickTranslate.assistant.resultTitle')
            }}
          </span>
          <div class="flex flex-wrap items-center gap-2">
            <span v-if="hasResult" class="text-xs text-lf-text-subtle tabular-nums">
              {{ t('quickTranslate.assistant.resultStats', resultStats) }}
            </span>
            <NTag
              v-if="result"
              :type="batchStatusTimelineType(result.status, 'info')"
              :bordered="false"
              size="tiny"
            >
              {{ statusLabel(result.status) }}
            </NTag>
            <!-- 生成状态：仅在实际生成中出现，保持紧凑 -->
            <span
              v-if="genState === 'preparing'"
              class="flex items-center gap-1.5 rounded-full bg-brand-500/8 px-2 py-0.5 text-xs font-medium text-brand-600"
            >
              <span
                class="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-brand-500/25 border-t-brand-500"
                aria-hidden="true"
              />
              {{ t('quickTranslate.assistant.preparingHint') }}
            </span>
            <span
              v-else-if="genState === 'streaming'"
              class="flex items-center gap-1.5 rounded-full bg-brand-500/8 px-2 py-0.5 text-xs font-medium text-brand-600"
            >
              {{ t('quickTranslate.assistant.generatingHint') }}
            </span>
            <span
              v-else-if="genState === 'stopped'"
              class="rounded-full bg-lf-surface-muted px-2 py-0.5 text-xs text-lf-text-subtle"
            >
              {{ t('quickTranslate.assistant.stoppedTag') }}
            </span>
            <button
              v-if="genBusy"
              type="button"
              class="flex items-center gap-1 rounded-full border border-lf-danger/50 bg-lf-danger/5 px-2 py-0.5 text-xs font-medium text-lf-danger transition-colors hover:bg-lf-danger/10"
              @click="stopGeneration"
            >
              <IconCarbonStop class="text-xs" aria-hidden="true" />
              {{ t('quickTranslate.assistant.stopGenerating') }}
            </button>
            <button
              v-if="hasResult && !genBusy"
              type="button"
              class="flex items-center gap-1 rounded-full border border-lf-border bg-lf-surface px-2 py-0.5 text-xs font-medium text-lf-text-muted transition-colors hover:border-brand-400 hover:text-brand-500"
              @click="openSaveTerm"
            >
              <IconCarbonAdd class="text-xs" aria-hidden="true" />
              {{ t('quickTranslate.assistant.saveTerm') }}
            </button>
          </div>
        </div>

        <!-- 快捷微调工具栏：仅已有结果时可用 -->
        <div v-if="hasResult" class="mb-2 flex flex-wrap items-center gap-1.5">
          <button
            v-for="key in QUICK_REFINE_ACTIONS"
            :key="key"
            type="button"
            class="rounded-full bg-lf-surface px-2.5 py-1 text-xs leading-4 font-medium text-lf-text-muted transition-colors hover:bg-lf-surface-muted hover:text-lf-text-strong disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="genBusy"
            @click="onRefine(key)"
          >
            {{ t(`quickTranslate.assistant.refines.${key}.label`) }}
          </button>
        </div>

        <!-- 生成失败但保留了上一版译文：错误单独提示，不写入译文正文 -->
        <NAlert
          v-if="genState === 'error' && inlineError && hasResult"
          type="error"
          :bordered="false"
          class="mb-2 shrink-0"
          :title="t('quickTranslate.messages.failed')"
        >
          <div class="space-y-1.5">
            <p class="break-words whitespace-pre-wrap text-xs">{{ inlineError }}</p>
            <NButton size="tiny" type="primary" secondary @click="onSubmit">
              {{ t('quickTranslate.assistant.retry') }}
            </NButton>
          </div>
        </NAlert>

        <!-- preparing 且没有既有译文：流光骨架 + 工作状态提示 -->
        <div
          v-if="genState === 'preparing' && !genKeepPrevious"
          class="flex min-h-[280px] flex-1 flex-col gap-3 rounded-lf-ctl border border-lf-border-soft bg-lf-surface p-3"
        >
          <div class="flex items-center gap-2 text-xs text-lf-text-muted">
            <span
              class="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-brand-500/25 border-t-brand-500"
              aria-hidden="true"
            />
            {{ t('quickTranslate.assistant.streamingHint') }}
          </div>
          <div class="flex flex-1 flex-col justify-center gap-2.5">
            <div class="lf-shimmer h-3 w-full rounded-full" />
            <div class="lf-shimmer h-3 w-[92%] rounded-full" />
            <div class="lf-shimmer h-3 w-[96%] rounded-full" />
            <div class="lf-shimmer h-3 w-[70%] rounded-full" />
          </div>
        </div>
        <!-- 重新生成中：保留并弱化上一版译文，不直接销毁用户已有成果 -->
        <div
          v-else-if="genKeepPrevious"
          class="relative min-h-[280px] flex-1 overflow-auto rounded-lf-ctl border border-lf-border-soft bg-lf-surface p-3"
        >
          <p
            class="break-words whitespace-pre-wrap text-sm leading-6 text-lf-text-subtle opacity-60"
          >
            {{ editableResult }}
          </p>
          <div
            class="pointer-events-none absolute inset-x-3 top-3 flex items-center gap-2 rounded-full bg-lf-surface-muted/95 px-2.5 py-1 text-xs text-lf-text-muted shadow-sm"
          >
            <span
              class="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-brand-500/25 border-t-brand-500"
              aria-hidden="true"
            />
            {{ t('quickTranslate.assistant.regeneratingHint') }}
          </div>
        </div>
        <!-- streaming：真实文本逐段补显 + 闪烁光标（可随时终止） -->
        <div
          v-else-if="genState === 'streaming'"
          class="min-h-[280px] flex-1 overflow-auto rounded-lf-ctl border border-lf-border-soft bg-lf-surface p-3"
        >
          <p class="break-words whitespace-pre-wrap text-sm leading-6 text-lf-text">
            {{ editableResult }}<span class="lf-caret" aria-hidden="true" />
          </p>
        </div>
        <!-- 有结果：直接编辑（Post-Edit） -->
        <NInput
          v-else-if="hasResult"
          v-model:value="editableResult"
          type="textarea"
          :autosize="false"
          class="min-h-0 flex-1!"
          :placeholder="t('quickTranslate.assistant.resultPlaceholder')"
          :input-props="{ 'aria-label': t('quickTranslate.assistant.resultTitle') }"
          @keydown="onEditorKeydown"
        />
        <!-- 失败态：无译文时直接展示错误原因 + 重试（绝不回退到示例卡片） -->
        <div
          v-else-if="failureNotice"
          class="flex min-h-[280px] flex-1 flex-col items-start justify-center gap-2 rounded-lf-ctl border border-lf-danger/40 bg-lf-danger/5 p-4"
        >
          <div class="flex items-center gap-2 text-sm font-medium text-lf-danger">
            <IconCarbonWarningAlt class="text-base" aria-hidden="true" />
            {{ t('quickTranslate.messages.failed') }}
          </div>
          <p class="max-w-full break-words text-xs leading-5 whitespace-pre-wrap text-lf-text-muted">
            {{ failureNotice }}
          </p>
          <p class="text-xs text-lf-text-subtle">
            {{ t('quickTranslate.assistant.failureHint') }}
          </p>
          <NButton
            size="small"
            type="primary"
            secondary
            :loading="submitting"
            @click="onSubmit"
          >
            {{ t('quickTranslate.assistant.retry') }}
          </NButton>
        </div>
        <!-- 空状态：占位提示 + 可点击的高频示例（单列紧凑卡片，完整展示示例文本） -->
        <div
          v-else
          class="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-3 rounded-lf-ctl border border-lf-border-soft bg-lf-surface p-3"
        >
          <p class="text-center text-xs text-lf-text-subtle">
            {{ t('quickTranslate.assistant.resultPlaceholder') }}
          </p>
          <div class="flex w-full max-w-md flex-col gap-1.5">
            <button
              v-for="key in EXAMPLE_KEYS"
              :key="key"
              type="button"
              class="flex items-start gap-2 rounded-lg border border-lf-border-soft bg-lf-surface-muted/60 px-3 py-1.5 text-left text-xs text-lf-text-muted transition-colors hover:border-brand-500 hover:text-lf-text-strong"
              @click="applyExample(key)"
            >
              <IconCarbonChat class="mt-0.5 shrink-0 text-sm text-lf-text-subtle" />
              <span class="whitespace-normal leading-4">
                {{ t(`quickTranslate.assistant.examples.${key}.text`) }}
              </span>
            </button>
          </div>
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
      class="shrink-0 space-y-4 border-t border-lf-border-soft bg-lf-surface-muted/40 px-4 py-3"
    >
      <p class="text-xs text-lf-text-muted">
        {{
          mountedProject
            ? t('quickTranslate.assistant.mountedNotice', { name: mountedProject.name })
            : t('quickTranslate.assistant.unmountedNotice')
        }}
      </p>
      <NAlert v-if="projectGlossaryDisabled" type="info" :bordered="false">
        {{ t('termExtraction.quickProjectDisabled') }}
      </NAlert>
      <NAlert
        v-else-if="projectGlossaryError"
        type="warning"
        :bordered="false"
        :title="t('quickTranslate.assistant.projectGlossaryLoadFailed')"
        >{{ projectGlossaryError }}</NAlert
      >
      <NAlert
        v-else-if="projectGlossary.length"
        type="info"
        :bordered="false"
        :title="t('quickTranslate.assistant.projectGlossaryLoaded', { count: mandatoryGlossaryCount, total: projectGlossary.length })"
      >
        <span class="flex flex-wrap gap-1.5">
          <NTag
            v-for="entry in projectGlossary.slice(0, 8)"
            :key="entry.id"
            size="tiny"
            :bordered="false"
            >{{ entry.source }} → {{ entry.target }}</NTag
          >
        </span>
      </NAlert>

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
      class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-lf-border-soft px-4 py-2.5"
    >
      <div class="flex min-w-0 items-center gap-3">
        <button
          type="button"
          class="flex items-center gap-1.5 text-xs font-medium text-lf-text-muted transition-colors hover:text-lf-text-strong"
          @click="advancedOpen = !advancedOpen"
        >
          <IconCarbonChevronUp v-if="advancedOpen" class="text-base" />
          <IconCarbonChevronDown v-else class="text-base" />
          {{ t('quickTranslate.advancedToggle') }}
        </button>
        <span class="hidden text-[11px] text-lf-text-subtle lg:inline">
          {{ t('quickTranslate.assistant.shortcutHint') }}
        </span>
        <span
          v-if="draftSaveFailed"
          class="flex items-center gap-1 text-[11px] text-lf-warning"
        >
          <IconCarbonWarningAlt class="text-xs" />
          {{ t('quickTranslate.assistant.draftSaveFailed') }}
        </span>
        <span
          v-else-if="draftSavedHint"
          class="flex items-center gap-1 text-[11px] text-lf-text-subtle"
          :title="t('quickTranslate.assistant.draftSavedHint')"
        >
          <IconCarbonCheckmark class="text-xs" />
          {{ draftSavedHint }}
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <NButton size="small" :disabled="!hasResult || genBusy" @click="onCopyResult">
          <IconCarbonCopy />
          {{ t('quickTranslate.assistant.copyResult') }}
        </NButton>
        <NButton size="small" :disabled="!hasResult || genBusy" @click="onCopyBilingual">
          <IconCarbonCopy />
          {{ t('quickTranslate.assistant.copyBilingual') }}
        </NButton>
        <NTooltip :disabled="submitBlockReason == null">
          <template #trigger>
            <span class="inline-flex">
              <!-- 生成在途时主按钮切换为「停止生成」：preparing 阶段会真正取消网络请求 -->
              <NButton
                v-if="genBusy"
                size="small"
                type="error"
                secondary
                @click="stopGeneration"
              >
                <IconCarbonStop />
                {{ t('quickTranslate.assistant.stopGenerating') }}
              </NButton>
              <NButton
                v-else
                type="primary"
                size="small"
                :loading="submitting"
                :disabled="!canSubmit"
                @click="onSubmit"
              >
                <IconCarbonTranslate />
                {{
                  mode === 'email'
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

    <!-- 一键新建词库：仅需名称；存储/语言对等工程项由系统静默兜底 -->
    <NModal
      v-model:show="quickCreateShow"
      preset="dialog"
      :title="t('quickTranslate.assistant.mountCreateTitle')"
      :positive-text="t('quickTranslate.assistant.mountCreateConfirm')"
      :negative-text="t('common.cancel')"
      :loading="quickCreating"
      @positive-click="createAndMount"
      @negative-click="quickCreateShow = false"
    >
      <NInput
        v-model:value="quickCreateName"
        :placeholder="t('quickTranslate.assistant.mountCreatePlaceholder')"
        :disabled="quickCreating"
        @keydown.enter.prevent="createAndMount"
      />
      <p class="mt-2 text-xs text-lf-text-subtle">
        {{ t('quickTranslate.assistant.mountCreateHint') }}
      </p>
    </NModal>

    <!-- 存为术语：默认强制术语；同源冲突预检 + 服务端 409 兜底提示 -->
    <NModal
      v-model:show="saveTermShow"
      preset="dialog"
      :title="t('quickTranslate.assistant.saveTermTitle')"
      :positive-text="t('quickTranslate.assistant.saveTermConfirm')"
      :negative-text="t('common.cancel')"
      :loading="saveTermSubmitting"
      @positive-click="saveTerm"
      @negative-click="saveTermShow = false"
    >
      <div class="space-y-2">
        <NInput
          v-model:value="saveTermSource"
          :placeholder="t('quickTranslate.assistant.saveTermSourcePlaceholder')"
          :disabled="saveTermSubmitting"
        />
        <NInput
          v-model:value="saveTermTarget"
          :placeholder="t('quickTranslate.assistant.saveTermTargetPlaceholder')"
          :disabled="saveTermSubmitting"
        />
        <NInput
          v-model:value="saveTermNotes"
          type="textarea"
          :rows="2"
          :placeholder="t('quickTranslate.assistant.saveTermNotesPlaceholder')"
          :disabled="saveTermSubmitting"
        />
        <p class="text-xs text-lf-text-subtle">
          {{
            projectId
              ? t('quickTranslate.assistant.saveTermDestination', {
                  name: mountedProject?.name ?? '',
                })
              : t('quickTranslate.assistant.saveTermDestinationNone')
          }}
        </p>
        <p v-if="saveTermError" class="text-xs text-lf-danger">{{ saveTermError }}</p>
      </div>
    </NModal>
  </section>
</template>
