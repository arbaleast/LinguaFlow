<script setup lang="ts">
const modelValue = defineModel<string>('value', { default: '' })

const {
  placeholder = '',
  rows = 6,
  disabled = false,
} = defineProps<{
  placeholder?: string
  rows?: number
  disabled?: boolean
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const backdropRef = ref<HTMLDivElement | null>(null)

// --- Go Template 分词高亮 ---

/** HTML 特殊字符转义 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Go template 关键字集合 */
const GO_TEMPLATE_KEYWORDS = new Set([
  'if',
  'else',
  'end',
  'range',
  'with',
  'template',
  'define',
  'block',
])

/** Token 类型 */
type TokenType =
  | 'text'
  | 'open-delim'
  | 'close-delim'
  | 'keyword'
  | 'field'
  | 'function'
  | 'string'
  | 'pipe'
  | 'other'

/** 分词结果 */
interface Token {
  type: TokenType
  value: string
}

/** 模板动作的正则：匹配 {{ 或 {{- 开头，}} 或 -}} 结尾 */
const ACTION_RE = /\{\{-?[\s\S]*?-?\}\}/g

/** 模板动作内部的分词正则 */
const INNER_RE = /\s+|"[^"]*"|(\.)[a-zA-Z_]\w*(?:\.\w+)*|[a-zA-Z_]\w*|\||./g

/**
 * 将已转义的文本分词为 Go template token 序列。
 * 第一层：切分普通文本与模板动作；第二层：模板动作内部细分。
 */
function tokenizeTemplate(escapedText: string): Token[] {
  const tokens: Token[] = []
  let lastIndex = 0

  for (const match of escapedText.matchAll(ACTION_RE)) {
    // 匹配前的普通文本
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: escapedText.slice(lastIndex, match.index) })
    }

    const action = match[0]
    // 提取左定界符
    const leftDelim = action.startsWith('{{-') ? '{{-' : '{{'
    // 提取右定界符
    const rightDelim = action.endsWith('-}}') ? '-}}' : '}}'
    // 中间内容
    const content = action.slice(leftDelim.length, -rightDelim.length)

    tokens.push({ type: 'open-delim', value: leftDelim })

    // 第二层：内容细分
    for (const m of content.matchAll(INNER_RE)) {
      const val = m[0]
      if (val[0] === '"') {
        tokens.push({ type: 'string', value: val })
      } else if (m[1] === '.') {
        tokens.push({ type: 'field', value: val })
      } else if (val.length > 0 && /[a-zA-Z_]/.test(val[0]!)) {
        tokens.push({
          type: GO_TEMPLATE_KEYWORDS.has(val) ? 'keyword' : 'function',
          value: val,
        })
      } else if (val === '|') {
        tokens.push({ type: 'pipe', value: val })
      } else {
        tokens.push({ type: 'other', value: val })
      }
    }

    tokens.push({ type: 'close-delim', value: rightDelim })
    lastIndex = match.index + action.length
  }

  // 末尾剩余文本
  if (lastIndex < escapedText.length) {
    tokens.push({ type: 'text', value: escapedText.slice(lastIndex) })
  }

  return tokens
}

/** 将 token 序列渲染为带语义 class 的高亮 HTML */
function renderTokens(tokens: Token[]): string {
  let result = ''
  let inAction = false

  for (const token of tokens) {
    const val = token.value

    if (token.type === 'text') {
      result += val
      continue
    }

    if (token.type === 'open-delim') {
      result += `<mark class="tmpl-action"><mark class="tmpl-delim">${val}</mark>`
      inAction = true
    } else if (token.type === 'close-delim') {
      result += `<mark class="tmpl-delim">${val}</mark></mark>`
      inAction = false
    } else if (inAction) {
      switch (token.type) {
        case 'keyword':
          result += `<mark class="tmpl-keyword">${val}</mark>`
          break
        case 'field':
          result += `<mark class="tmpl-field">${val}</mark>`
          break
        case 'function':
          result += `<mark class="tmpl-func">${val}</mark>`
          break
        case 'string':
          result += `<mark class="tmpl-string">${val}</mark>`
          break
        case 'pipe':
          result += `<mark class="tmpl-pipe">${val}</mark>`
          break
        default:
          result += val
      }
    }
  }

  return result
}

/** Go template 高亮入口：转义文本 → 分词 → 渲染 HTML */
function highlightGoTemplate(text: string): string {
  const escaped = escapeHtml(text)
  const tokens = tokenizeTemplate(escaped)
  return renderTokens(tokens)
}

// --- 高亮 HTML 计算 ---

/** 使用 Go template 分词高亮生成 HTML */
const highlightedHtml = computed(() => {
  const text = modelValue.value || ''
  if (!text) return ''

  // 换行交给 CSS 的 white-space: pre-wrap 处理：两层排版规则一致，
  // 不能再把 \n 换成 <br>，否则末尾换行会少渲染一行，与 textarea 对不齐。
  return highlightGoTemplate(text.replace(/\r\n/g, '\n'))
})

// --- 滚动同步 ---

/**
 * 滚动同步：把 textarea 的滚动偏移直接写给背景层。
 * 背景层 overflow:hidden 仍可被程序化滚动，且与 textarea 共用同一套盒模型，
 * 因此 scrollTop/scrollLeft 就是最精确的映射；用 transform 反而多一层偏移状态。
 */
function syncScroll() {
  const textarea = textareaRef.value
  const backdrop = backdropRef.value
  if (!textarea || !backdrop) return
  if (backdrop.scrollTop !== textarea.scrollTop) backdrop.scrollTop = textarea.scrollTop
  if (backdrop.scrollLeft !== textarea.scrollLeft) backdrop.scrollLeft = textarea.scrollLeft
}

/** 将模板变量插入到光标位置 */
function insertAtCursor(placeholder: string): void {
  if (disabled) return
  const el = textareaRef.value
  if (!el) {
    modelValue.value += placeholder
    return
  }

  const start = el.selectionStart
  const end = el.selectionEnd
  const before = modelValue.value.slice(0, start)
  const after = modelValue.value.slice(end)
  modelValue.value = before + placeholder + after

  nextTick(() => {
    const cursorPos = start + placeholder.length
    el.setSelectionRange(cursorPos, cursorPos)
    el.focus()
  })
}

// 内容变化后补一次同步（textarea 可能因光标移出视口而自行滚动）
watch(modelValue, () => {
  nextTick(() => {
    syncScroll()
  })
})

// 只读态也要能滚动阅读：disabled 的 textarea 在浏览器里既不响应滚轮也无法选中，
// 因此编辑能力用 readonly 关闭，滚动与复制保持可用。
const readOnly = computed(() => disabled)

defineExpose({ insertAtCursor })
</script>

<template>
  <div
    class="prompt-editor relative overflow-hidden rounded-lf-ctl border border-lf-border bg-lf-surface"
  >
    <!-- 背景高亮容器：inset-0 让高亮层与输入层共享同一个盒子，无需 JS 量高 -->
    <div
      ref="backdropRef"
      class="prompt-editor-backdrop pointer-events-none absolute inset-0 bg-lf-surface text-lf-text"
      aria-hidden="true"
    >
      <span v-html="highlightedHtml"></span>
    </div>
    <!-- 输入层：透明文本，负责光标、选择与滚动 -->
    <textarea
      ref="textareaRef"
      :value="modelValue"
      :placeholder="placeholder"
      :rows="rows"
      :readonly="readOnly"
      :aria-disabled="disabled"
      class="prompt-editor-textarea relative z-2 block w-full bg-transparent p-3 text-sm leading-6 text-transparent caret-lf-text outline-none disabled:cursor-not-allowed disabled:opacity-50"
      @input="modelValue = ($event.target as HTMLTextAreaElement).value"
      @scroll="syncScroll"
    />
  </div>
</template>

<!--
  Go template 高亮样式：非 scoped，通过 .prompt-editor 选择器限定作用域。
  v-html 动态插入的 <mark> 元素不带 Vue scoped 标记，scoped 样式无法匹配。
-->
<style scoped>
/*
  Go template 高亮样式：v-html 动态插入的 <mark> 元素不带 Vue scoped 标记，
  需通过 :deep() 从组件根节点向下匹配，避免使用非 scoped 全局样式。
*/
.prompt-editor :deep(mark) {
  background-color: transparent;
  padding: 0;
}

.prompt-editor :deep(.tmpl-action) {
  background-color: var(--lf-tmpl-bg);
  border-radius: 2px;
  padding: 1px 0;
}

.prompt-editor :deep(.tmpl-delim) {
  color: var(--lf-tmpl-delim);
}

.prompt-editor :deep(.tmpl-keyword) {
  color: var(--lf-tmpl-keyword);
  font-weight: 500;
}

.prompt-editor :deep(.tmpl-field) {
  color: var(--lf-tmpl-field);
}

.prompt-editor :deep(.tmpl-func) {
  color: var(--lf-tmpl-func);
}

.prompt-editor :deep(.tmpl-string) {
  color: var(--lf-tmpl-string);
}

.prompt-editor :deep(.tmpl-pipe) {
  color: var(--lf-tmpl-pipe);
  font-weight: 600;
}

.prompt-editor:focus-within {
  border-color: var(--lf-brand-500);
  box-shadow: 0 0 0 2px var(--lf-brand-soft);
}

/*
  两层共用同一套排版度量：字体、字号、行高、内边距、换行与断词规则必须逐项一致，
  任何一项不同都会让高亮文字与光标错位。这里集中定义一次，避免两边漂移。
*/
.prompt-editor-backdrop,
.prompt-editor-textarea {
  box-sizing: border-box;
  padding: 12px; /* p-3 */
  font-family:
    'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, Consolas, 'Liberation Mono',
    'Courier New', 'Source Han Mono SC', 'Noto Sans Mono CJK SC', 'WenQuanYi Micro Hei Mono',
    monospace;
  font-size: 0.875rem; /* text-sm */
  line-height: 1.5rem; /* leading-6 */
  font-variant-ligatures: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  tab-size: 4;
}

/* 背景高亮层：只负责显示，滚动由 textarea 驱动后写回 scrollTop/scrollLeft */
.prompt-editor-backdrop {
  border-radius: inherit;
  overflow: hidden;
  z-index: 1;
}

/* 重置 textarea 的浏览器 UA 默认样式（含 inline-block 带来的基线间隙） */
.prompt-editor-textarea {
  display: block;
  min-height: 6rem;
  margin: 0;
  border: none;
  resize: vertical;
}

/* 只读（查看系统模板）时保留阅读能力：可滚动、可选中、可复制，但不能改 */
.prompt-editor-textarea[readonly] {
  resize: none;
  cursor: default;
}

.prompt-editor-textarea::placeholder {
  color: var(--lf-text-subtle);
}
</style>
