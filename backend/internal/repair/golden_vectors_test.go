package repair

// 黄金测试向量导出器：把 repair 包生产代码的**真实输出**序列化为 JSON，
// 供前端 `frontend/src/domain/repair/` 的 TypeScript 移植层做 100% 深相等对拍。
//
// 只允许 `_test.go`：生产代码零改动。仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘，
// 常规 `go test ./...` 因未设置环境变量而 t.Skip，无副作用。
//
// 覆盖范围：本包全部 `*_test.go` 的边界用例（json/text/bootstrap/envelope/
// salvage/ruby_raw/ruby_state/prompt_template）。`Expect` 全部由生产函数调用
// 结果投影得到，无人工誊写。

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
	"github.com/MeowSalty/LinguaFlow/backend/internal/prompt"
	"github.com/MeowSalty/LinguaFlow/backend/internal/ruby"
)

// goldenAllOpts 是全开关选项（与 repair_test.go 的 allOpts 同值；此处独立定义，
// 避免黄金导出器依赖其他测试文件的变量）。
var goldenAllOpts = Options{
	JSONStructural:       true,
	SchemaAliases:        true,
	PlaceholderNormalize: true,
	PromptUpgrade:        true,
}

// nonNilStrings 把 nil 切片归一为空切片（README §3.2）。
func nonNilStrings(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// nonNilStringMap 把 nil map 归一为空 map（README §3.2）。
func nonNilStringMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

// optionsArgs 把 Options 投影为 TS 侧可重建的参数。
func optionsArgs(o Options) map[string]any {
	return goldenv.Expect(
		"jsonStructural", o.JSONStructural,
		"schemaAliases", o.SchemaAliases,
		"placeholderNormalize", o.PlaceholderNormalize,
		"promptUpgrade", o.PromptUpgrade,
		"withoutSalvage", o.salvageDeclined,
	)
}

// entryViews 投影术语条目；nil → []。
func entryViews(entries []prompt.BootstrapEntry) []any {
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, goldenv.Expect("source", e.Source, "target", e.Target, "notes", e.Notes))
	}
	return out
}

// outputEntryView 投影单条注音条目（含 Go 的 Invalid 运行态字段）。
func outputEntryView(e ruby.OutputEntry) map[string]any {
	return goldenv.Expect(
		"id", e.ID,
		"base", e.Base,
		"text", e.Text,
		"kind", e.Kind,
		"occurrence", e.Occurrence,
		"invalid", e.Invalid,
	)
}

// outputMapView 投影 segment ID → 条目；nil → {}。
func outputMapView(m map[string][]ruby.OutputEntry) map[string]any {
	out := map[string]any{}
	for id, entries := range m {
		list := make([]any, 0, len(entries))
		for _, e := range entries {
			list = append(list, outputEntryView(e))
		}
		out[id] = list
	}
	return out
}

// issueViews 投影语义质检问题；nil → []。
func issueViews(issues []prompt.SemanticQAIssue) []any {
	out := make([]any, 0, len(issues))
	for _, issue := range issues {
		out = append(out, goldenv.Expect(
			"id", issue.ID,
			"code", issue.Code,
			"message", issue.Message,
			"snippet", issue.Snippet,
		))
	}
	return out
}

// verdictViews 投影裁决结果；nil → []。
func verdictViews(verdicts []prompt.AdjudicationVerdict) []any {
	out := make([]any, 0, len(verdicts))
	for _, v := range verdicts {
		out = append(out, goldenv.Expect(
			"id", v.ID,
			"issue_code", v.IssueCode,
			"matched_text", v.MatchedText,
			"verdict", v.Verdict,
			"reason", v.Reason,
		))
	}
	return out
}

// revisionViews 投影修订结果；nil → []。
func revisionViews(revisions []prompt.ReviseRevision) []any {
	out := make([]any, 0, len(revisions))
	for _, rev := range revisions {
		out = append(out, goldenv.Expect("id", rev.ID, "target", rev.Target))
	}
	return out
}

// tryResultView 投影 TryRepair 的 Result。
func tryResultView(r Result) map[string]any {
	return goldenv.Expect(
		"fatal", r.Fatal,
		"trans", nonNilStringMap(r.Trans),
		"glos", entryViews(r.Glos),
		"rubyOutput", outputMapView(r.RubyOutput),
		"missing", nonNilStrings(r.Missing),
		"repaired", nonNilStrings(r.Repaired),
	)
}

// goldenErrorKind 把 error 投影为稳定分类（错误文案来自 Go 解析器，跨语言不可比）。
func goldenErrorKind(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, ErrBootstrapTextEmpty) {
		return "empty"
	}
	return "other"
}

// ---- 用例构造器 ----

func tryGolden(id, text string, wantIDs []string, opt Options) goldenv.Case {
	return goldenv.Case{
		ID:     id,
		Op:     "repair.try",
		Args:   goldenv.Args("text", text, "wantIds", wantIDs, "options", optionsArgs(opt)),
		Expect: tryResultView(TryRepair(text, wantIDs, opt)),
	}
}

func textGolden(id, text string, wantIDs []string, opt Options) goldenv.Case {
	return goldenv.Case{
		ID:     id,
		Op:     "repair.text",
		Args:   goldenv.Args("text", text, "wantIds", wantIDs, "options", optionsArgs(opt)),
		Expect: tryResultView(TryRepairText(text, wantIDs, opt)),
	}
}

func bootstrapGolden(id, text string, opt Options) goldenv.Case {
	entries, repaired, err := TryRepairBootstrap(text, opt)
	return goldenv.Case{
		ID:   id,
		Op:   "repair.bootstrap",
		Args: goldenv.Args("text", text, "options", optionsArgs(opt)),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"entries", entryViews(entries),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func bootstrapTextGolden(id, text string, opt Options) goldenv.Case {
	entries, repaired, err := TryRepairBootstrapText(text, opt)
	return goldenv.Case{
		ID:   id,
		Op:   "repair.bootstrap.text",
		Args: goldenv.Args("text", text, "options", optionsArgs(opt)),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"entries", entryViews(entries),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func bootstrapModeGolden(id, text string, isTextMode bool, opt Options, requireHeader bool) goldenv.Case {
	entries, repaired, err := ParseBootstrapByMode(text, isTextMode, opt, requireHeader)
	return goldenv.Case{
		ID: id,
		Op: "repair.bootstrap.mode",
		Args: goldenv.Args(
			"text", text,
			"isTextMode", isTextMode,
			"requireHeaderForEmpty", requireHeader,
			"options", optionsArgs(opt),
		),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"entries", entryViews(entries),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func envelopeGolden(id, text, key string, opt Options) goldenv.Case {
	raw, repaired, err := TryRepairEnvelope(text, key, opt)
	expect := goldenv.Expect(
		"ok", err == nil,
		"repaired", nonNilStrings(repaired),
		"valueKind", "",
		"count", 0,
		"error", goldenErrorKind(err),
	)
	if raw != nil {
		if value, ok := raw[key]; ok {
			switch tv := value.(type) {
			case []any:
				expect["valueKind"] = "array"
				expect["count"] = len(tv)
			case map[string]any:
				expect["valueKind"] = "object"
				expect["count"] = len(tv)
			default:
				expect["valueKind"] = "other"
			}
		}
	}
	return goldenv.Case{
		ID:     id,
		Op:     "repair.envelope",
		Args:   goldenv.Args("text", text, "key", key, "options", optionsArgs(opt)),
		Expect: expect,
	}
}

func semanticGolden(id, text string, opt Options) goldenv.Case {
	issues, repaired, err := TryRepairSemanticQA(text, opt)
	return goldenv.Case{
		ID:   id,
		Op:   "repair.semantic.qa",
		Args: goldenv.Args("text", text, "options", optionsArgs(opt)),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"items", issueViews(issues),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func semanticModeGolden(id, text string, isTextMode bool, opt Options) goldenv.Case {
	issues, repaired, err := ParseSemanticQAByMode(text, isTextMode, opt)
	return goldenv.Case{
		ID: id,
		Op: "repair.semantic.qa.mode",
		Args: goldenv.Args(
			"text", text,
			"isTextMode", isTextMode,
			"options", optionsArgs(opt),
		),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"items", issueViews(issues),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func adjudicationGolden(id, text string, opt Options) goldenv.Case {
	verdicts, repaired, err := TryRepairAdjudication(text, opt)
	return goldenv.Case{
		ID:   id,
		Op:   "repair.adjudication",
		Args: goldenv.Args("text", text, "options", optionsArgs(opt)),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"items", verdictViews(verdicts),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func adjudicationModeGolden(id, text string, isTextMode bool, opt Options) goldenv.Case {
	verdicts, repaired, err := ParseAdjudicationByMode(text, isTextMode, opt)
	return goldenv.Case{
		ID: id,
		Op: "repair.adjudication.mode",
		Args: goldenv.Args(
			"text", text,
			"isTextMode", isTextMode,
			"options", optionsArgs(opt),
		),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"items", verdictViews(verdicts),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func reviseModeGolden(id, text string, isTextMode bool, opt Options) goldenv.Case {
	revisions, rubyOutput, repaired, err := ParseReviseByMode(text, isTextMode, opt)
	return goldenv.Case{
		ID: id,
		Op: "repair.revise.mode",
		Args: goldenv.Args(
			"text", text,
			"isTextMode", isTextMode,
			"options", optionsArgs(opt),
		),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"revisions", revisionViews(revisions),
			"rubyOutput", outputMapView(rubyOutput),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func rubyAlignmentGolden(id, text string, opt Options) goldenv.Case {
	entries, repaired, err := TryRepairRubyAlignment(text, opt)
	return goldenv.Case{
		ID:   id,
		Op:   "repair.ruby.alignment",
		Args: goldenv.Args("text", text, "options", optionsArgs(opt)),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"entries", outputListViews(entries),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func rubyStateGolden(id, text string, opt Options) goldenv.Case {
	entries, repaired, err := TryRepairRubyAlignmentForState(text, opt)
	return goldenv.Case{
		ID:   id,
		Op:   "repair.ruby.alignment.state",
		Args: goldenv.Args("text", text, "options", optionsArgs(opt)),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"entries", outputListViews(entries),
			"repaired", nonNilStrings(repaired),
			"error", goldenErrorKind(err),
		),
	}
}

func outputListViews(entries []ruby.OutputEntry) []any {
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, outputEntryView(e))
	}
	return out
}

func placeholderGolden(id, text string, known map[string]string) goldenv.Case {
	got, normalized := NormalizePlaceholders(text, known)
	return goldenv.Case{
		ID:     id,
		Op:     "repair.placeholder",
		Args:   goldenv.Args("text", text, "knownKeys", known),
		Expect: goldenv.Expect("text", got, "normalized", nonNilStrings(normalized)),
	}
}

func retryReminderGolden(id, content string, missingIDs []string, parseErr error, prevHead string) goldenv.Case {
	var reason any
	if parseErr != nil {
		reason = parseErr.Error()
	}
	got, err := RenderRetryReminder(content, missingIDs, parseErr, prevHead)
	return goldenv.Case{
		ID:   id,
		Op:   "repair.retry.reminder",
		Args: goldenv.Args("content", content, "missingIds", missingIDs, "parseErr", reason, "prevHead", prevHead),
		Expect: goldenv.Expect(
			"ok", err == nil,
			"text", got,
		),
	}
}

func buildReminderGolden(id string, missingIDs []string, parseErr error, prevHead string) goldenv.Case {
	var reason any
	if parseErr != nil {
		reason = parseErr.Error()
	}
	return goldenv.Case{
		ID:     id,
		Op:     "repair.build.retry.reminder",
		Args:   goldenv.Args("missingIds", missingIDs, "parseErr", reason, "prevHead", prevHead),
		Expect: goldenv.Expect("text", BuildRetryReminder(missingIDs, parseErr, prevHead)),
	}
}

func textTransformGolden(op, id, text string, fn func(string) string) goldenv.Case {
	return goldenv.Case{
		ID:     id,
		Op:     op,
		Args:   goldenv.Args("text", text),
		Expect: goldenv.Expect("text", fn(text)),
	}
}

// goldenErr 是错误文本载体（实现 error），用于把静态失败原因喂给 reminder。
type goldenErr string

func (e goldenErr) Error() string { return string(e) }

// TestGoldenVectors 导出 repair 包的黄金测试向量。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	var cases []goldenv.Case

	// =====================================================================
	// json_test.go —— 未转义引号算子的全部边界
	// =====================================================================
	for _, tc := range []struct {
		id   string
		text string
	}{
		{"json/escape-quotes/value-inner", `{"verdicts":[{"id":"1","reason":""英国"是中文标准用词。"}]}`},
		{"json/escape-quotes/valid-nop", `{"a":"x\"y","b":"plain","c":["1","2"],"d":{"e":"f"},"g":"h"}`},
		{"json/escape-quotes/key-value-boundary", `{"key":"value","list":["a","b"]}`},
		{"json/escape-quotes/trailing-value-eof", `{"a":"b"`},
		{"json/escape-quotes/whitespace-before-comma", "{\n  \"a\" : \"value\" ,\n  \"b\" : [ \"x\" , \"y\" ]\n}"},
		{"json/escape-quotes/whitespace-inner-quote", `{"a":"say " hi"}`},
		{"json/escape-quotes/already-escaped", `{"a":"x \"quoted\" y"}`},
	} {
		cases = append(cases, textTransformGolden("json.escape_unescaped_quotes", tc.id, tc.text, escapeUnescapedQuotes))
	}

	// =====================================================================
	// salvage_test.go —— truncateToLastCompleteValue 单元
	// =====================================================================
	for _, tc := range []struct {
		id   string
		text string
	}{
		{"json/truncate/value-mid-cut", `{"translations":{"1":"完整甲","2":"完整乙","3":"瑞贝卡学姐一问`},
		{"json/truncate/dangling-key-colon", `{"translations":{"1":"完整甲","2":"完整乙","3":`},
		{"json/truncate/key-mid-cut", `{"translations":{"1":"完整甲","2":"完整乙","3`},
		{"json/truncate/no-complete-value", `{"translations":{"1":"hello`},
		{"json/truncate/cut-at-end-noop", `{"translations":{"1":"甲"}`},
		{"json/truncate/container-closure", `{"translations":{"1":"甲"},"glossary":[{"source":"a","target":"b"},{"source":"c`},
	} {
		cut, ok := truncateToLastCompleteValue(tc.text)
		cases = append(cases, goldenv.Case{
			ID:     tc.id,
			Op:     "json.truncate_to_last_complete_value",
			Args:   goldenv.Args("text", tc.text),
			Expect: goldenv.Expect("cut", cut, "ok", ok),
		})
	}

	// =====================================================================
	// repair_test.go —— TryRepair 主链路
	// =====================================================================
	cases = append(cases,
		tryGolden("repair/try/happy-path", `{"translations":{"1":"hello","2":"world"}}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/code-fence-thinking", "<thinking>scratch {\"reasoning\":\"x\"}</thinking>\n```json\n"+`{"translations":{"1":"a","2":"b"}}`+"\n```\nDone.", []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/strips-bom", "\uFEFF"+`{"translations":{"1":"a"}}`, []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/trailing-comma", `{"translations":{"1":"a","2":"b",}}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/unclosed-quote-fatal", `{"translations":{"1":"hello`, []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/field-alias", `{"translation":{"1":"a"}}`, []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/field-alias-disabled", `{"translation":{"1":"a"}}`, []string{"1"}, Options{JSONStructural: true}),
		tryGolden("repair/try/partial-missing-ids", `{"translations":{"1":"a","2":"b"}}`, []string{"1", "2", "3"}, goldenAllOpts),
		tryGolden("repair/try/extra-ids-ignored", `{"translations":{"1":"a","2":"b","3":"c"}}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/partial-with-glossary", `{"translations":{"1":"你好"},"glossary":[{"source":"Hello","target":"你好","notes":""}]}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/merges-multiple-objects", `{"translations":{"1":"a"}}`+"\n"+`{"translations":{"2":"b"}}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/skips-thinking-object", `{"reasoning":"step by step"}`+"\n"+`{"translations":{"1":"a"}}`, []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/control-char-inside-string", "{\"translations\":{\"1\":\"line1\nline2\"}}", []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/fatal-not-json", "not json at all", []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/close-unbalanced-braces", `{"translations":{"1":"a","2":"b"`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/data-nested-translations", `{"data":{"translations":{"1":"a"}}}`, []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/stuttered-prefix", `{"{"ruby_output":{"1":[]},"translations":{"1":"目录","2":"世界"}}}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/stuttered-key-prefix", "{\n  \"rub{\n  \"ruby_output\": {\n    \"1\": []\n  },\n  \"translations\": {\n    \"1\": \"目录\"\n  }\n}", []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/robust-preserves-unclosed-fatal", `{"translations":{"1":"hello`, []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/nested-ruby-output", `{"translations":{"1":{"translation":"『才没有那回事啦』","ruby_output":[]},"2":{"translation":"包裹着她身体的体温也渐渐离去。","ruby_output":[{"base":"身体","text":"からだ","kind":"phonetic"}]}}}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/robust-rejects-alias-decoy", `{"translations":{"1":BAD}{"output":{"2":"DECOY"}}`, []string{"2"}, goldenAllOpts),
		tryGolden("repair/try/robust-skips-alias-decoy", `{"{`+`{"output":{"2":"DECOY"}}{"translations":{"2":"REAL"}}`, []string{"2"}, goldenAllOpts),
		tryGolden("repair/try/robust-merges-split", `{"{`+`{"translations":{"1":"A"}}{"translations":{"2":"B"}}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/robust-conflicting-fatal", `{"{`+`{"translations":{"1":"FIRST"}}{"translations":{"1":"SECOND"}}`, []string{"1"}, goldenAllOpts),
	)

	// ---- salvage_test.go：TryRepair 截断抢救四条实录形态 + 门控 ----
	cases = append(cases,
		tryGolden("repair/try/salvage/value-mid-cut", `{"translations":{"1":"完整甲","2":"完整乙","3":"瑞贝卡学姐一问`, []string{"1", "2", "3"}, goldenAllOpts),
		tryGolden("repair/try/salvage/dangling-key-colon", `{"translations":{"1":"完整甲","2":"完整乙","3":`, []string{"1", "2", "3"}, goldenAllOpts),
		tryGolden("repair/try/salvage/key-mid-cut", `{"translations":{"1":"完整甲","2":"完整乙","3`, []string{"1", "2", "3"}, goldenAllOpts),
		tryGolden("repair/try/salvage/trailing-comma-close-braces", `{"translations":{"1":"完整甲","2":"完整乙",`, []string{"1", "2", "3"}, goldenAllOpts),
		tryGolden("repair/try/salvage/container-closure", `{"translations":{"1":"甲"},"glossary":[{"source":"a","target":"b"},{"source":"c`, []string{"1"}, goldenAllOpts),
		tryGolden("repair/try/salvage/rejects-garbage-after-quote", `{"translations":{"1":"甲"垃圾"2":"乙`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/try/salvage/declined", `{"translations":{"1":"完整甲","2":"完整乙","3":"瑞贝卡学姐一问`, []string{"1", "2", "3"}, goldenAllOpts.WithoutSalvage()),
		tryGolden("repair/try/salvage/requires-json-structural", `{"translations":{"1":"完整甲","2":"完整乙","3":"瑞贝卡学姐一问`, []string{"1", "2", "3"}, Options{}),
	)

	// ---- 真实事故样本：21 条完整译文 + 键中途截断 ----
	realWorld := `{
  "translations": {
    "10": "只要经过几分钟，暴食就会被赫冰封印给吞没。",
    "100": "那个夜晚，在她离去之际我听说了。",
    "101": "她说自己等了埃文·伯恩斯坦整整十年。",
    "102": "所以她才说希望把伯恩斯坦先生交给她来处理。",
    "103": "那个时候，她应该就已经做好了杀他的觉悟了吧。",
    "104": "“和埃文嘛，没错。我们曾是恋人。但是，我并不懂得什么是爱。因为渴望理解爱，我才和他成为了恋人。然后一直等待着消失的他。期待着如果能再见埃文一次，或许就能明白自己的这份感情了。”",
    "105": "她将手轻轻放在胸口。",
    "106": "“但是，埃文死后我明白了。我果然还是爱着他的啊。”",
    "107": "“是，这样吗……”",
    "108": "“真是讽刺啊。竟然要等到死后才像这样产生自觉。我真是个无可救药的人。”",
    "109": "用着如造物般漂亮的脸庞诉说着的她，看起来不知为何有些落寞。",
    "11": "虽然他似乎还在反抗，但魔术领域已经完全停止了。现在应该只是用最后残存的力量在抵抗吧。",
    "110": "“不过，埃文因为对我异常执着而变得不正常，那是他的软弱所致。”",
    "111": "“因为软弱，所以才追求了力量吗？”",
    "112": "“没错。我和你都是‘拥有’的那一方。即便能想象对方的心情，也永远无法真正理解。”",
    "113": "确实如此。",
    "114": "心情是可以想象的。",
    "115": "但绝对无法完全理解他人的心情。",
    "116": "“我啊。在想。”",
    "117": "这次她用温柔的声线继续说道。",
    "118": "“想什么呢？”",
    "11`
	realIDs := []string{
		"10", "100", "101", "102", "103", "104", "105", "106", "107", "108",
		"109", "11", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119",
	}
	cases = append(cases, tryGolden("repair/try/salvage/real-world-sample", realWorld, realIDs, goldenAllOpts))

	// =====================================================================
	// repair_test.go —— placeholder
	// =====================================================================
	knownOne := map[string]string{"__LF_000001__": "X"}
	cases = append(cases,
		placeholderGolden("repair/placeholder/lowercase-to-known", "hello __lf_000001__ world", knownOne),
		placeholderGolden("repair/placeholder/missing-underscore", "__LF000001__", knownOne),
		placeholderGolden("repair/placeholder/pads-short-digits", "__LF_5__", map[string]string{"__LF_000005__": "X"}),
		placeholderGolden("repair/placeholder/unknown-variant-unchanged", "this mentions __lf_999999__ which we never created", knownOne),
		placeholderGolden("repair/placeholder/already-standard", "__LF_000001__", knownOne),
		placeholderGolden("repair/placeholder/empty-known-keys", "__lf_000001__", nil),
		placeholderGolden("repair/placeholder/zero-trailing-underscores", "text__LF_000001<ruby>椎名__LF_000002", map[string]string{
			"__LF_000001__": "</span>",
			"__LF_000002__": "<ruby>",
		}),
		placeholderGolden("repair/placeholder/single-trailing-underscore", "hello__LF_000003_world", map[string]string{"__LF_000003__": "</rt>"}),
		placeholderGolden("repair/placeholder/zero-trailing-unknown-key", "text__LF_999999", knownOne),
	)

	// =====================================================================
	// repair_test.go —— bootstrap JSON 路径
	// =====================================================================
	cases = append(cases,
		bootstrapGolden("repair/bootstrap/happy-path", `{"glossary":[{"source":"x","target":"y","notes":""}]}`, goldenAllOpts),
		bootstrapGolden("repair/bootstrap/field-alias", `{"terms":[{"source":"x","target":"y","notes":""}]}`, goldenAllOpts),
		bootstrapGolden("repair/bootstrap/code-fence", "Sure:\n```json\n"+`{"glossary":[{"source":"x","target":"y","notes":""}]}`+"\n```", goldenAllOpts),
		bootstrapGolden("repair/bootstrap/filters-and-dedup", `{"glossary":[
		{"source":" hello ","target":" hi ","notes":""},
		{"source":"hello","target":"hi-dup","notes":""},
		{"source":"","target":"y","notes":""}
	]}`, goldenAllOpts),
		// salvage_test.go
		bootstrapGolden("repair/bootstrap/salvage/key-mid-cut", `{"glossary":[{"source":"x","target":"y","notes":""},{"sour`, goldenAllOpts),
		bootstrapGolden("repair/bootstrap/salvage/declined", `{"glossary":[{"source":"x","target":"y","notes":""},{"sour`, goldenAllOpts.WithoutSalvage()),
		bootstrapGolden("repair/bootstrap/salvage/close-braces-form", `{"glossary":[{"source":"x","target":"y"},{"source":"a","target":"b"`, goldenAllOpts),
		bootstrapGolden("repair/bootstrap/salvage/close-braces-form-declined", `{"glossary":[{"source":"x","target":"y"},{"source":"a","target":"b"`, goldenAllOpts.WithoutSalvage()),
		bootstrapGolden("repair/bootstrap/salvage/broken-body", `{"glossary":[{"source":"a","target":"b"},{"source":"x","target":"y\q" garbage`, goldenAllOpts),
	)

	// =====================================================================
	// repair_test.go —— BuildRetryReminder
	// =====================================================================
	cases = append(cases,
		buildReminderGolden("repair/reminder/build/all-fields", []string{"3", "5"}, goldenErr("bad json"), "ABC..."),
		buildReminderGolden("repair/reminder/build/truncates-long-prev-head", nil, nil, strings.Repeat("x", 300)),
	)

	// =====================================================================
	// prompt_template_test.go —— RenderRetryReminder
	// =====================================================================
	cases = append(cases,
		retryReminderGolden("repair/reminder/render/frozen-content", "saved {{.MissingIDs}} {{.Reason}} {{.PreviousHead}}", []string{"1", "3"}, goldenErr("bad JSON"), strings.Repeat("x", 201)),
		retryReminderGolden("repair/reminder/render/empty-template", "", nil, nil, ""),
		retryReminderGolden("repair/reminder/render/unclosed-action", "{{", nil, nil, ""),
		retryReminderGolden("repair/reminder/render/unknown-field", "{{.Unsupported}}", nil, nil, ""),
	)

	// =====================================================================
	// text_test.go
	// =====================================================================
	textOpts := Options{JSONStructural: true, PromptUpgrade: true}
	cases = append(cases,
		textGolden("repair/text/happy-path", "[1] 早上好\n[2] 很高兴认识你\n", []string{"1", "2"}, textOpts),
		textGolden("repair/text/with-context-segments", "[*] Hello, how are you?\n[1] Good morning\n[*] See you later\n[2] Nice to meet you\n", []string{"1", "2"}, textOpts),
		textGolden("repair/text/with-glossary", "[1] 早上好\n[2] 很高兴认识你\n\n[glossary]\nLinguaFlow | 灵流 | 翻译平台名称\nAPI | 接口 | 应用程序编程接口\n", []string{"1", "2"}, textOpts),
		textGolden("repair/text/missing-id", "[1] 早上好\n", []string{"1", "2"}, Options{JSONStructural: true}),
		textGolden("repair/text/missing-id-always-partial", "[1] a\n", []string{"1", "2", "3", "4"}, Options{JSONStructural: true}),
		textGolden("repair/text/code-fence", "```text\n[1] 早上好\n[2] 很高兴认识你\n```\n", []string{"1", "2"}, textOpts),
		textGolden("repair/text/bom", "\uFEFF[1] 早上好\n[2] 很高兴认识你\n", []string{"1", "2"}, textOpts),
		textGolden("repair/text/continuation-lines", "[1] 第一行\n继续第二行\n[2] 独立段落\n", []string{"1", "2"}, textOpts),
		textGolden("repair/text/empty-response", "", []string{"1"}, textOpts),
		textGolden("repair/text/no-translations", "just some random text\n", []string{"1"}, textOpts),
		textGolden("repair/text/repair-tracking", "```text\n[1] 早上好\n```\n", []string{"1"}, textOpts),
		textGolden("repair/text/glossary-with-trailing-translations", "[1] Hello\n[glossary]\nAPI | 接口\n[2] World\n", []string{"1", "2"}, textOpts),
		textGolden("repair/text/with-section-ruby", "[1] 早上好\n[2] 很高兴认识你\n\n[ruby]\n1: 早上 | 早晨 | phonetic\n2: 高兴 | 愉快 | semantic\n", []string{"1", "2"}, textOpts),
		textGolden("repair/text/with-section-ruby-and-glossary", "[1] 你好世界\n[glossary]\nAPI | 接口\n[ruby]\n1: 世界 | 世間 | phonetic\n", []string{"1"}, textOpts),
		textGolden("repair/text/section-ruby-empty", "[1] 你好\n[ruby]\n", []string{"1"}, textOpts),
		textGolden("repair/text/section-ruby-four-field", "[1] I want water\n\n[ruby]\n1: I | aɪ | phonetic | 1\n", []string{"1"}, textOpts),
		textGolden("repair/text/section-ruby-three-field-no-id", "[1] I want water\n\n[ruby]\n1: I | aɪ | phonetic\n", []string{"1"}, textOpts),
	)

	// ---- TestStripCodeFence ----
	for _, tc := range []struct {
		id   string
		text string
	}{
		{"text/strip-code-fence/no-fence", "hello"},
		{"text/strip-code-fence/fenced", "```text\nhello\n```"},
		{"text/strip-code-fence/fenced-no-lang", "```\nhello\n```"},
		{"text/strip-code-fence/nested", "```text\n```\ninner\n```"},
	} {
		cases = append(cases, textTransformGolden("text.strip_code_fence", tc.id, tc.text, stripCodeFence))
	}

	// =====================================================================
	// bootstrap_text_test.go
	// =====================================================================
	cases = append(cases,
		bootstrapTextGolden("repair/bootstrap.text/with-header", "[glossary]\nGemini | 哈基米 | company\nAPI | 接口\n", goldenAllOpts),
		bootstrapTextGolden("repair/bootstrap.text/no-header", "Gemini | 哈基米 | company\nAPI | 接口\n", goldenAllOpts),
		bootstrapTextGolden("repair/bootstrap.text/empty-list", "[glossary]\n", goldenAllOpts),
		bootstrapTextGolden("repair/bootstrap.text/empty-string", "", goldenAllOpts),
		bootstrapTextGolden("repair/bootstrap.text/code-fence", "```\n[glossary]\nA | B | note\n```", goldenAllOpts),
		bootstrapTextGolden("repair/bootstrap.text/dedup", "[glossary]\nA | B | note1\nA | C | note2\n", goldenAllOpts),
		bootstrapTextGolden("repair/bootstrap.text/ignores-other-sections", "[glossary]\nA | B | note\n[other]\nC | D | note\n", goldenAllOpts),
		bootstrapModeGolden("repair/bootstrap.mode/prune-strict-empty", "not a glossary at all", true, goldenAllOpts, true),
		bootstrapModeGolden("repair/bootstrap.mode/extract-loose-empty", "not a glossary at all", true, goldenAllOpts, false),
		bootstrapModeGolden("repair/bootstrap.mode/explicit-empty-ok", "[glossary]\n", true, goldenAllOpts, true),
		bootstrapModeGolden("repair/bootstrap.mode/json-fallback", `{"glossary":[{"source":"x","target":"y","notes":""}]}`, true, goldenAllOpts, true),
	)

	// =====================================================================
	// envelope_adjudication_test.go
	// =====================================================================
	cases = append(cases,
		adjudicationGolden("repair/adjudication/happy-path", `{"verdicts":[{"id":"3","issue_code":"source_residual","matched_text":"test","verdict":"real","reason":"残留"}]}`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/empty-truncated", `{"verdicts":{ "verdicts": []}`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/stuttered-prefix", `{"verdicts{"verdicts":[{"id":"3","issue_code":"source_residual","matched_text":"t","verdict":"false_positive","reason":"误报"}]}`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/truncated-with-content", `{"verdicts":[{"id":"3","issue_code":"source_residual","matched_text":"test","verdict":"real","reason":"残留"`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/trailing-comma", `{"verdicts":[{"id":"1","issue_code":"source_residual","matched_text":"t","verdict":"real","reason":"x",}]}`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/code-fence", "```json\n{\"verdicts\":[{\"id\":\"1\",\"issue_code\":\"source_residual\",\"matched_text\":\"t\",\"verdict\":\"real\",\"reason\":\"x\"}]}\n```", goldenAllOpts),
		adjudicationGolden("repair/adjudication/filters-missing-id", `{"verdicts":[{"id":"","issue_code":"source_residual","matched_text":"t","verdict":"real","reason":"x"},{"id":"2","issue_code":"source_residual","matched_text":"t","verdict":"real","reason":"y"}]}`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/fatal-not-json", "totally not json", goldenAllOpts),
		adjudicationGolden("repair/adjudication/bare-array", `[{"id":"3","issue_code":"source_residual","matched_text":"test","verdict":"real","reason":"残留"}]`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/bare-array-echo-rejected", `[{"id":"3","issue_code":"source_residual","snippet":"test"}]`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/truncation-salvage-declined", `{"verdicts":[{"id":"3","issue_code":"source_residual","matched_text":"t","verdict":"real","reason":"残留"}`+`,{"i`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/boundary-truncation-gating", `{"verdicts":[{"id":"3","issue_code":"source_residual","matched_text":"t","verdict":"real","reason":"残留"}`, goldenAllOpts),
		adjudicationGolden("repair/adjudication/unescaped-quotes-in-reason", `{"verdicts":[{"id":"241","issue_code":"source_residual","matched_text":"英国","verdict":"false_positive","reason":""英国"是中文标准用词，与日语同形，属合理使用。"},{"id":"245","issue_code":"length_ratio","matched_text":"","verdict":"false_positive","reason":"译文因补充修饰语略长，属合理扩展，无漏译或填充。"}]}`, goldenAllOpts),
		adjudicationModeGolden("repair/adjudication.mode/non-text-json-repair", `{"verdicts":{ "verdicts": []}`, false, goldenAllOpts),
		adjudicationModeGolden("repair/adjudication.mode/text-verdicts", "[verdicts]\n3 | source_residual | test | real | 残留\n", true, goldenAllOpts),
		adjudicationModeGolden("repair/adjudication.mode/text-empty-falls-back", `{"verdicts":{ "verdicts": []}`, true, goldenAllOpts),
	)

	// =====================================================================
	// envelope_revise_test.go
	// =====================================================================
	cases = append(cases,
		reviseModeGolden("repair/revise/happy-path", `{"revisions":[{"id":"1","target":"修订后"}]}`, false, goldenAllOpts),
		reviseModeGolden("repair/revise/normalizes-and-deduplicates", `{"revisions":[{"id":" 1 ","target":" first "},{"id":"1","target":"second"},{"id":"2","target":""},{"id":"3","target":" third "}]}`, false, goldenAllOpts),
		reviseModeGolden("repair/revise/truncated-and-trailing-comma", `{"revisions":[{"id":"1","target":"修订后",}]}`, false, goldenAllOpts),
		reviseModeGolden("repair/revise/code-fence", "```json\n{\"revisions\":[{\"id\":\"1\",\"target\":\"修订后\"}]}\n```", false, goldenAllOpts),
		reviseModeGolden("repair/revise/fatal-not-json", "totally not json", false, goldenAllOpts),
		reviseModeGolden("repair/revise/text-revision", "[revisions]\n1 | 修订后 | 含竖线\n", true, goldenAllOpts),
		reviseModeGolden("repair/revise/text-json-falls-back", `{"revisions":[{"id":"1","target":"修订后"}]}`, true, goldenAllOpts),
		reviseModeGolden("repair/revise/json-with-ruby-output", `{"revisions":[{"id":"1","target":"修订后"}],"ruby_output":{"1":[{"base":"呪","text":"じゅ","kind":"phonetic","id":"1"}]}}`, false, goldenAllOpts),
		reviseModeGolden("repair/revise/text-with-ruby-section", "[revisions]\n1 | 修订後\n\n[ruby]\n1: 呪 | じゅ | phonetic | 1\n2: 微笑 | ほほえ | semantic\n", true, goldenAllOpts),
		reviseModeGolden("repair/revise/text-without-ruby-section", "[revisions]\n1 | 修订后\n", true, goldenAllOpts),
		reviseModeGolden("repair/revise/text-fenced-with-ruby-section", "```\n[revisions]\n1 | 修订後\n\n[ruby]\n1: 呪 | じゅ | phonetic | 1\n```", true, goldenAllOpts),
	)

	// =====================================================================
	// envelope_ruby_test.go
	// =====================================================================
	cases = append(cases,
		rubyAlignmentGolden("repair/ruby.happy-path", `{"ruby_output":[{"base":"漢字","text":"かんじ","kind":"phonetic"}]}`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.empty-truncated", `{"ruby_output":{ "ruby_output": []}`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.stuttered-prefix", `{"ruby_output{"ruby_output":[{"base":"漢字","text":"かんじ","kind":"phonetic"}]}`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.truncated-with-content", `{"ruby_output":[{"base":"漢字","text":"かんじ","kind":"phonetic"`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.trailing-comma", `{"ruby_output":[{"base":"漢字","text":"かんじ","kind":"phonetic",}]}`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.filters-empty-base", `{"ruby_output":[{"base":"","text":"かんじ","kind":"phonetic"},{"base":"漢字","text":"かんじ","kind":"phonetic"}]}`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.fatal-not-json", "totally not json", goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.preserves-id", `{"ruby_output":[{"id":"1","base":"I","text":"aɪ","kind":"phonetic"}]}`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.bare-array", "[\n  {\n    \"id\": \"1\",\n    \"base\": \"白银之风\",\n    \"text\": \"アルジェント・ビアブレッザ\",\n    \"kind\": \"phonetic\"\n  }\n]", goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.bare-array-truncated", `[{"id":"1","base":"白银之风","text":"アルジェント・ビアブレッザ","kind":"phonetic"`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.bare-array-requires-opts", `[{"id":"1","base":"白银之风","text":"アルジェント・ビアブレッザ","kind":"phonetic"}]`, Options{}),
		rubyAlignmentGolden("repair/ruby.bare-array-empty-rejected", "示例：[]", goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.bare-array-scalar-rejected", `["噪声", "示例"]`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.bare-array-wrong-shape-rejected", `[{"id":"1","kind":"phonetic"}]`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.bare-array-echo-rejected", `[{"id":"1","source_base":"白银之风","source_text":"アルジェント・ビアブレッザ"}]`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.legal-empty-envelope", `{"ruby_output":[]}`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.salvage-key-mid-cut", `{"ruby_output":[{"base":"漢字","text":"かんじ","kind":"phonetic"}`+`,{"bas`, goldenAllOpts),
		rubyAlignmentGolden("repair/ruby.boundary-truncation-gating", `{"ruby_output":[{"base":"漢字","text":"かんじ","kind":"phonetic"}`, goldenAllOpts),
		envelopeGolden("repair/envelope/boundary-truncation-direct", `{"ruby_output":[{"base":"漢字","text":"かんじ","kind":"phonetic"}`, "ruby_output", goldenAllOpts),
	)

	// =====================================================================
	// envelope_semantic_qa_test.go
	// =====================================================================
	cases = append(cases,
		semanticGolden("repair/semantic/happy-path", `{"issues":[{"id":"3","code":"term_fidelity","message":"音译不准确","snippet":"ル"}]}`, goldenAllOpts),
		semanticGolden("repair/semantic/empty-issues", `{"issues":{ "issues": []}`, goldenAllOpts),
		semanticGolden("repair/semantic/stuttered-prefix", `{"issues{"issues":[{"code":"term_fidelity","id":"3","message":"音译错误","snippet":"ル"}]}`, goldenAllOpts),
		semanticGolden("repair/semantic/truncated-with-content", `{"issues":[{"code":"term_fidelity","id":"3","message":"音译不准确","snippet":"ルトルバーグ"`, goldenAllOpts),
		semanticGolden("repair/semantic/trailing-comma", `{"issues":[{"id":"1","code":"term_fidelity","message":"x","snippet":"y",}]}`, goldenAllOpts),
		semanticGolden("repair/semantic/code-fence", "```json\n{\"issues\":[{\"id\":\"1\",\"code\":\"term_fidelity\",\"message\":\"x\",\"snippet\":\"y\"}]}\n```", goldenAllOpts),
		semanticGolden("repair/semantic/filters-illegal-code", `{"issues":[{"id":"1","code":"term_fidelity","message":"a","snippet":"b"},{"id":"2","code":"length_ratio","message":"c","snippet":"d"}]}`, goldenAllOpts),
		semanticGolden("repair/semantic/fatal-not-json", "totally not json", goldenAllOpts),
		semanticGolden("repair/semantic/zero-opts", `{"issues":[{"id":"1","code":"term_fidelity","message":"x","snippet":"y"}]}`, Options{}),
		semanticGolden("repair/semantic/unescaped-quotes-in-message", `{"issues":[{"id":"10","code":"mistranslation","message":""少女"是中文标准词汇，非残留","snippet":"少女"}]}`, goldenAllOpts),
		semanticGolden("repair/semantic/truncation-salvage-declined", `{"issues":[{"id":"1","code":"term_fidelity","message":"x","snippet":"y"}`+`,{"i`, goldenAllOpts),
		semanticModeGolden("repair/semantic.mode/non-text-json-repair", `{"issues":{ "issues": []}`, false, goldenAllOpts),
		semanticModeGolden("repair/semantic.mode/text-empty-falls-back", `{"issues":{ "issues": []}`, true, goldenAllOpts),
		semanticModeGolden("repair/semantic.mode/text-issues", "[issues]\n1 | term_fidelity | ル | 音译错误\n", true, goldenAllOpts),
	)

	// =====================================================================
	// ruby_raw_test.go —— 重复成员跨 JSON 路径
	// =====================================================================
	const rawRows = `[{"id":"other","id":"6","base":"alpha","text":"a","kind":"creative"},{"id":"9","base":"beta","text":"b","kind":"creative"}]`
	rawMain := `{"translations":{"1":"alpha beta"},"ruby_output":{"1":` + rawRows + `}}`
	rawRevision := `{"revisions":[{"id":"1","target":"alpha beta"}],"ruby_output":{"1":` + rawRows + `}}`
	rawLegacy := `{"ruby_output":` + rawRows + `}`
	for _, tc := range []struct {
		id    string
		input string
	}{
		{"main", rawMain},
		{"main_trailing", strings.TrimSuffix(rawMain, "}") + ",}"},
		{"main_robust", `{"` + rawMain},
		{"main_merge", rawMain + `{"translations":{"2":"gamma"}}`},
		{"main_nested", `{"translations":{"1":{"translation":"alpha beta","ruby_output":` + rawRows + `}}}`},
	} {
		cases = append(cases, tryGolden("repair/ruby_raw/main/"+tc.id, tc.input, []string{"1"}, goldenAllOpts))
	}
	for _, tc := range []struct {
		id    string
		input string
	}{
		{"revision", rawRevision},
		{"revision_robust", `{"` + rawRevision},
		{"revision_trailing", strings.TrimSuffix(rawRevision, "}") + ",}"},
	} {
		cases = append(cases, reviseModeGolden("repair/ruby_raw/revision/"+tc.id, tc.input, false, goldenAllOpts))
	}
	for _, tc := range []struct {
		id    string
		input string
	}{
		{"legacy", rawLegacy},
		{"legacy_robust", `{"` + rawLegacy},
		{"legacy_bare", rawRows},
		{"legacy_truncated", strings.TrimSuffix(rawLegacy, "}")},
	} {
		cases = append(cases, rubyStateGolden("repair/ruby_raw/legacy/"+tc.id, tc.input, goldenAllOpts))
	}

	// TestOptionalRubyDuplicateFieldsKeepMainUnaligned
	cases = append(cases,
		tryGolden("repair/ruby_raw/optional-duplicate/envelope", `{"translations":{"1":"alpha","2":"alpha"},`+`"ruby_output":{"1":`+rawRows+`},"ruby_output":{"1":`+rawRows+`}`+`}`, []string{"1", "2"}, goldenAllOpts),
		tryGolden("repair/ruby_raw/optional-duplicate/segment", `{"translations":{"1":"alpha","2":"alpha"},`+`"ruby_output":{"1":`+rawRows+`,"1":`+rawRows+`,"2":`+rawRows+`}`+`}`, []string{"1", "2"}, goldenAllOpts),
	)

	// =====================================================================
	// ruby_state_test.go
	// =====================================================================
	cases = append(cases,
		rubyStateGolden("repair/ruby_state/rejects-malformed-duplicate-group", `{"ruby_output":[{"id":"6","base":"alpha","text":"a","kind":"creative"},{"id":"6","base":false,"text":"a","kind":"creative"},{"id":"9","base":"beta","text":"b","kind":"creative"}]}`, goldenAllOpts),
	)

	// =====================================================================
	// ruby_partial_rows_test.go
	// =====================================================================
	partialRows := `"ruby_output":{"1":[{"id":"a","base":" a ","text":" x ","kind":"creative"},{"id":"b","base":"b","text":"y","kind":"phonetic","occurrence":"invalid"}]}`
	cases = append(cases,
		tryGolden("repair/ruby_partial_rows/main", `{"translations":{"1":" a b "},`+partialRows+`}`, []string{"1"}, goldenAllOpts),
		reviseModeGolden("repair/ruby_partial_rows/revise", `{"revisions":[{"id":"1","target":"valid"}],`+partialRows+`}`, false, goldenAllOpts),
	)

	// 保证输出顺序稳定（goldenv.Write 会再次按 ID 排序；这里排序只为日志可读）。
	sort.SliceStable(cases, func(i, j int) bool { return cases[i].ID < cases[j].ID })

	n, err := goldenv.Write(out, "repair", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	byOp := map[string]int{}
	for _, c := range cases {
		byOp[c.Op]++
	}
	ops := make([]string, 0, len(byOp))
	for op := range byOp {
		ops = append(ops, op)
	}
	sort.Strings(ops)
	var summary []string
	for _, op := range ops {
		summary = append(summary, fmt.Sprintf("%s=%d", op, byOp[op]))
	}
	t.Logf("repair 黄金向量已导出: %d 条 → %s/repair.json", n, out)
	t.Logf("按 Op 分类: %s", strings.Join(summary, ", "))
}
