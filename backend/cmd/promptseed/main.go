// Command promptseed 把后端内置的提示词模板与执行策略导出为前端可用的静态 Seed 配置。
//
// 用途：浏览器优先架构（Phase 2）需要在 IndexedDB 里初始化「内置提示词模板」与
// 「内置执行策略」两类种子数据。本命令直接从 internal/templates 的嵌入 FS 与
// internal/prompt 的常量导出，**保证前后端种子内容逐字节一致**。
//
// 用法：
//
//	go run ./cmd/promptseed -out ../frontend/src/domain/prompt/seeds.ts
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/MeowSalty/LinguaFlow/backend/internal/execution"
	"github.com/MeowSalty/LinguaFlow/backend/internal/prompt"
	"github.com/MeowSalty/LinguaFlow/backend/internal/templates"
)

// bt 是反引号的占位符：Go 的原始字符串字面量无法直接包含反引号。
const bt = "%BT%"

func main() {
	out := flag.String("out", "../frontend/src/domain/prompt/seeds.ts", "输出文件路径")
	flag.Parse()

	var buf bytes.Buffer
	buf.WriteString(strings.ReplaceAll(header, bt, "`"))

	writeTemplate(&buf, "BUILTIN_TRANSLATION_PROMPT_TEMPLATE", templates.EmbeddedPromptTemplate())
	writeTemplate(&buf, "BUILTIN_BOOTSTRAP_PROMPT_TEMPLATE", templates.EmbeddedBootstrapTemplate())
	writeTemplate(&buf, "BUILTIN_PRUNE_PROMPT_TEMPLATE", templates.EmbeddedPruneTemplate())
	writeTemplate(&buf, "BUILTIN_ADJUDICATION_PROMPT_TEMPLATE", templates.EmbeddedAdjudicationTemplate())
	writeTemplate(&buf, "BUILTIN_SEMANTIC_QA_PROMPT_TEMPLATE", templates.EmbeddedSemanticQATemplate())
	writeTemplate(&buf, "BUILTIN_REVISE_PROMPT_TEMPLATE", templates.EmbeddedReviseTemplate())

	writeTemplate(&buf, "LEGACY_RUBY_ALIGNMENT_JSON_TEMPLATE", prompt.LegacyRubyAlignmentJSONTemplate)
	writeTemplate(&buf, "LEGACY_RUBY_ALIGNMENT_TEXT_TEMPLATE", prompt.LegacyRubyAlignmentTextTemplate)
	writeTemplate(&buf, "RUBY_ALIGNMENT_JSON_TEMPLATE", prompt.RubyAlignmentJSONTemplate)
	writeTemplate(&buf, "RUBY_ALIGNMENT_TEXT_TEMPLATE", prompt.RubyAlignmentTextTemplate)
	writeTemplate(&buf, "RUBY_ALIGNMENT_BATCH_JSON_TEMPLATE", prompt.RubyAlignmentBatchJSONTemplate)
	writeTemplate(&buf, "RUBY_ALIGNMENT_BATCH_TEXT_TEMPLATE", prompt.RubyAlignmentBatchTextTemplate)

	// 内置实体的元数据（名称与描述）。
	meta := map[string]map[string]any{
		"translation_prompt_template": {
			"id":          templates.BuiltinTranslationPromptTemplateID,
			"name":        "通用翻译提示词",
			"description": "默认翻译提示词模板，适用于一般文档翻译",
		},
		"bootstrap_prompt_template": {
			"id":          templates.BuiltinBootstrapPromptTemplateID,
			"name":        "通用术语抽取提示词",
			"description": "默认术语抽取提示词模板",
		},
		"prune_prompt_template": {
			"id":          templates.BuiltinPrunePromptTemplateID,
			"name":        "通用术语精简提示词",
			"description": "默认术语精简提示词模板",
		},
		"translation_profile": {
			"id":          templates.BuiltinExecutionProfileID,
			"name":        "通用策略",
			"description": "默认策略配置，适用于一般文档翻译",
		},
	}
	writeJSONConst(&buf, "BUILTIN_CATALOG", meta)

	// 内置执行策略（与 execution.DefaultProfile() 同源）。
	writeJSONConst(&buf, "BUILTIN_EXECUTION_PROFILE", execution.DefaultProfile())

	buf.WriteString(strings.ReplaceAll(footer, bt, "`"))

	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fatalf("创建输出目录失败: %v", err)
	}
	if err := os.WriteFile(*out, buf.Bytes(), 0o644); err != nil {
		fatalf("写入 %s 失败: %v", *out, err)
	}
	fmt.Printf("prompt 种子配置已导出 → %s (%d 字节)\n", *out, buf.Len())
}

// writeTemplate 写出一个导出的字符串常量。
func writeTemplate(buf *bytes.Buffer, name, content string) {
	fmt.Fprintf(buf, "/** 内置提示词模板（逐字节导出自后端 internal/templates / internal/prompt）。 */\n")
	fmt.Fprintf(buf, "export const %s = %s\n\n", name, tsTemplateLiteral(content))
}

// writeJSONConst 写出一个导出的 JSON 常量。
func writeJSONConst(buf *bytes.Buffer, name string, value any) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		fatalf("序列化 %s 失败: %v", name, err)
	}
	fmt.Fprintf(buf, "/** 内置元数据 / 策略种子（导出自后端）。 */\n")
	fmt.Fprintf(buf, "export const %s = %s as const\n\n", name, string(data))
}

// tsTemplateLiteral 把 Go 字符串渲染成 TS 模板字面量（转义反引号、${ 与反斜杠）。
func tsTemplateLiteral(s string) string {
	var b strings.Builder
	b.WriteByte('`')
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '`':
			b.WriteString("\\`")
		case '\\':
			b.WriteString("\\\\")
		case '$':
			// ${ 会开启 TS 模板字面量的插值，必须转义。
			if i+1 < len(s) && s[i+1] == '{' {
				b.WriteString("\\$")
				continue
			}
			b.WriteByte('$')
		default:
			b.WriteByte(c)
		}
	}
	b.WriteByte('`')
	return b.String()
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

const header = `/**
 * 内置提示词模板与执行策略的**静态种子配置**。
 *
 * 本文件由后端工具生成：%BT%backend/cmd/promptseed%BT%。
 *
 * 生成命令：
 *
 * %BT%%BT%%BT%bash
 * cd backend && go run ./cmd/promptseed -out ../frontend/src/domain/prompt/seeds.ts
 * %BT%%BT%%BT%
 *
 * 用途：浏览器优先架构（Phase 2）需要在 IndexedDB 中初始化
 * 「内置提示词模板」与「内置执行策略」两类种子数据。
 * 内容与后端 %BT%internal/templates%BT% / %BT%internal/prompt%BT% **逐字节一致**，
 * 因此不得手工编辑本文件。
 *
 * 本模块为纯静态数据，零 DOM / 零网络 / 零存储依赖。
 */

`

const footer = `/**
 * 内置实体的虚拟 ID（对应 Go %BT%templates.IsBuiltinID%BT% 的负数 ID 约定）。
 */
export const BUILTIN_ID = -1
`
