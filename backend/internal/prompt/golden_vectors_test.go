package prompt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// builtinTemplate 读取后端内置的提示词模板文件。
//
// 直接读文件而不是 import internal/templates：templates → execution → repair → prompt
// 构成导入环，测试包不允许（`import cycle not allowed in test`）。
// 语义与 templates.Embedded*Template() 一致：读取后去掉尾部换行。
func builtinTemplate(name string) string {
	path := filepath.Join("..", "templates", "default", "prompts", name)
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	return strings.TrimRight(string(data), "\n")
}

// goldenRuby 是可序列化的注音标注（对齐 Go 的 `RubyAnnotation`）。
type goldenRuby struct {
	ID   string `json:"id"`
	Base string `json:"base"`
	Text string `json:"text"`
}

// goldenGlossary 是可序列化的术语条目。
type goldenGlossary struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Notes  string `json:"notes"`
}

// goldenTMHint 是可序列化的翻译记忆命中。
type goldenTMHint struct {
	Source string  `json:"source"`
	Target string  `json:"target"`
	Score  float32 `json:"score"`
}

// goldenSegment 是可序列化的批量翻译段输入。
type goldenSegment struct {
	ID        string `json:"id"`
	Source    string `json:"source"`
	Translate bool   `json:"translate"`
}

// goldenData 是可序列化的渲染数据模型。
type goldenData struct {
	SourceLang       string                  `json:"source_lang"`
	TargetLang       string                  `json:"target_lang"`
	Source           string                  `json:"source"`
	Segments         []goldenSegment         `json:"segments"`
	Glossary         []goldenGlossary        `json:"glossary"`
	TMHints          []goldenTMHint          `json:"tm_hints"`
	InlineBootstrap  bool                    `json:"inline_bootstrap"`
	MaxBootstrapTerm int                     `json:"max_bootstrap_terms"`
	Protocol         Protocol                `json:"protocol"`
	RubyAnnotations  map[string][]goldenRuby `json:"ruby_annotations"`
	RubyMode         string                  `json:"ruby_mode"`
}

// toData 转换为 Go 的渲染数据模型。
func (g goldenData) toData() Data {
	segs := make([]SegmentInput, 0, len(g.Segments))
	for _, s := range g.Segments {
		segs = append(segs, SegmentInput{ID: s.ID, Source: s.Source, Translate: s.Translate})
	}
	glossaries := make([]GlossaryEntry, 0, len(g.Glossary))
	for _, e := range g.Glossary {
		glossaries = append(glossaries, GlossaryEntry{Source: e.Source, Target: e.Target, Notes: e.Notes})
	}
	hints := make([]TMHint, 0, len(g.TMHints))
	for _, h := range g.TMHints {
		hints = append(hints, TMHint{Source: h.Source, Target: h.Target, Score: h.Score})
	}
	anns := map[string][]RubyAnnotation{}
	for id, list := range g.RubyAnnotations {
		items := make([]RubyAnnotation, 0, len(list))
		for _, a := range list {
			items = append(items, RubyAnnotation{ID: a.ID, Base: a.Base, Text: a.Text})
		}
		anns[id] = items
	}
	return Data{
		SourceLang:        g.SourceLang,
		TargetLang:        g.TargetLang,
		Source:            g.Source,
		Segments:          segs,
		Glossary:          glossaries,
		TMHints:           hints,
		InlineBootstrap:   g.InlineBootstrap,
		MaxBootstrapTerms: g.MaxBootstrapTerm,
		Protocol:          g.Protocol,
		RubyAnnotations:   anns,
		RubyMode:          g.RubyMode,
	}
}

// TestGoldenVectors 导出 prompt 包的黄金测试向量。
//
// 覆盖：Go text/template 渲染（system）、JSON / text 两种 user 协议、
// 注音内联与 section 输出、bootstrap / prune / revise / adjudication /
// semantic_qa 五个渲染器、各协议的响应解析器。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	var cases []goldenv.Case

	// ---- 协议推导 ----
	for _, mode := range []string{"text", "", "json_schema", "json_object", "none", "bogus"} {
		cases = append(cases, goldenv.Case{
			ID:     "prompt/protocol/" + sanitizeID(mode),
			Op:     "prompt.protocol_from_response_mode",
			Args:   goldenv.Args("mode", mode),
			Expect: goldenv.Expect("protocol", string(ProtocolFromResponseMode(mode))),
		})
	}

	// ---- 渲染数据语料 ----
	dataCases := []struct {
		id   string
		data goldenData
	}{
		{"prompt/render/single-text", goldenData{
			SourceLang: "auto", TargetLang: "zh", Source: "Hello", Protocol: ProtocolText,
		}},
		{"prompt/render/single-json", goldenData{
			SourceLang: "en", TargetLang: "zh", Source: "Hello", Protocol: ProtocolJSONLoose,
		}},
		{"prompt/render/single-strict", goldenData{
			SourceLang: "en", TargetLang: "zh", Source: "Hello", Protocol: ProtocolJSONStrict,
		}},
		{"prompt/render/batch-json", goldenData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONStrict,
			Segments: []goldenSegment{
				{ID: "1", Source: "Hello", Translate: true},
				{ID: "2", Source: "Context", Translate: false},
			},
		}},
		{"prompt/render/batch-text", goldenData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText,
			Segments: []goldenSegment{
				{ID: "1", Source: "Hello", Translate: true},
				{ID: "2", Source: "Context", Translate: false},
			},
		}},
		{"prompt/render/glossary-and-tm", goldenData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONLoose,
			Segments: []goldenSegment{{ID: "1", Source: "cat", Translate: true}},
			Glossary: []goldenGlossary{
				{Source: "cat", Target: "猫", Notes: ""},
				{Source: "dog", Target: "狗", Notes: "动物"},
			},
			TMHints: []goldenTMHint{{Source: "hello", Target: "你好", Score: 0.85}},
		}},
		{"prompt/render/ruby-inline", goldenData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText, RubyMode: RubyModeInline,
			Segments: []goldenSegment{{ID: "1", Source: "椎名", Translate: true}},
			RubyAnnotations: map[string][]goldenRuby{
				"1": {{ID: "1", Base: "椎名", Text: "しいな"}},
			},
		}},
		{"prompt/render/ruby-section", goldenData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText, RubyMode: RubyModeSection,
			Segments: []goldenSegment{{ID: "1", Source: "椎名", Translate: true}},
			RubyAnnotations: map[string][]goldenRuby{
				"1": {{ID: "1", Base: "椎名", Text: "しいな"}},
			},
		}},
		{"prompt/render/ruby-json", goldenData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONLoose, RubyMode: RubyModeJSON,
			Segments: []goldenSegment{{ID: "1", Source: "椎名", Translate: true}},
			RubyAnnotations: map[string][]goldenRuby{
				"1": {{ID: "1", Base: "椎名", Text: "しいな"}},
			},
		}},
		{"prompt/render/inline-bootstrap", goldenData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONLoose,
			InlineBootstrap: true, MaxBootstrapTerm: 7,
			Segments: []goldenSegment{{ID: "1", Source: "cat", Translate: true}},
		}},
	}

	// 用**内置翻译模板**渲染，验证 Go text/template 的完整语义。
	systemTmpl := builtinTemplate("default_translation.tmpl")
	for _, tc := range dataCases {
		r, err := NewRenderer(systemTmpl)
		if err != nil {
			t.Fatalf("%s: 创建渲染器失败: %v", tc.id, err)
		}
		sys, user, err := r.Render(tc.data.toData())
		if err != nil {
			t.Fatalf("%s: 渲染失败: %v", tc.id, err)
		}
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "prompt.render",
			Args: goldenv.Args("template", "builtin_translation", "data", normalizeGoldenData(tc.data)),
			Expect: goldenv.Expect(
				"system", sys,
				"user", user,
			),
		})
	}

	// ---- bootstrap 渲染器 ----
	bootstrapCases := []struct {
		id   string
		data BootstrapData
	}{
		{"prompt/bootstrap/json", BootstrapData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONStrict,
			Texts:    []string{"alpha", "beta"},
			Existing: []string{"cat"},
		}},
		{"prompt/bootstrap/text", BootstrapData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText,
			Texts:    []string{"alpha", "beta"},
			Existing: []string{"cat"},
		}},
		{"prompt/bootstrap/text-empty", BootstrapData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText,
			Texts: []string{"alpha"},
		}},
	}
	for _, tc := range bootstrapCases {
		r, err := NewBootstrapRenderer(builtinTemplate("default_bootstrap.tmpl"))
		if err != nil {
			t.Fatalf("%s: 创建渲染器失败: %v", tc.id, err)
		}
		sys, user, err := r.Render(tc.data)
		if err != nil {
			t.Fatalf("%s: 渲染失败: %v", tc.id, err)
		}
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "prompt.bootstrap.render",
			Args: goldenv.Args("data", wireBootstrapData{tc.data.SourceLang, tc.data.TargetLang, tc.data.Texts, tc.data.Existing, tc.data.MaxTerms, tc.data.Protocol}),
			Expect: goldenv.Expect(
				"system", sys,
				"user", user,
			),
		})
	}

	// ---- prune 渲染器 ----
	pruneCases := []struct {
		id   string
		data PruneData
	}{
		{"prompt/prune/json", PruneData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONStrict,
			Entries: []PruneEntry{{Source: "cat", Target: "猫", Notes: ""}, {Source: "dog", Target: "狗", Notes: "n"}},
		}},
		{"prompt/prune/text", PruneData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText,
			Entries: []PruneEntry{{Source: "cat", Target: "猫", Notes: ""}, {Source: "dog", Target: "狗", Notes: "n"}},
		}},
	}
	for _, tc := range pruneCases {
		r, err := NewPruneRenderer(builtinTemplate("default_prune.tmpl"))
		if err != nil {
			t.Fatalf("%s: 创建渲染器失败: %v", tc.id, err)
		}
		sys, user, err := r.Render(tc.data)
		if err != nil {
			t.Fatalf("%s: 渲染失败: %v", tc.id, err)
		}
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "prompt.prune.render",
			Args: goldenv.Args("data", wirePruneData{tc.data.SourceLang, tc.data.TargetLang, tc.data.Entries, tc.data.Protocol}),
			Expect: goldenv.Expect(
				"system", sys,
				"user", user,
			),
		})
	}

	// ---- revise 渲染器 ----
	reviseCases := []struct {
		id   string
		data ReviseData
	}{
		{"prompt/revise/json", ReviseData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONStrict,
			Segments: []ReviseSegment{{
				ID: "1", Source: "src", Target: "tgt",
				Issues: []ReviseIssue{{Code: "mistranslation", Message: "wrong", Snippet: "tgt"}},
			}},
		}},
		{"prompt/revise/text", ReviseData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText,
			Segments: []ReviseSegment{{
				ID: "1", Source: "src", Target: "tgt",
				Issues: []ReviseIssue{{Code: "mistranslation", Message: "wrong", Snippet: "tgt"}},
			}},
		}},
		{"prompt/revise/text-ruby", ReviseData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText, RubyMode: RubyModeSection,
			Segments: []ReviseSegment{{ID: "1", Source: "src", Target: "tgt"}},
			RubyAnnotations: map[string][]RubyAnnotation{
				"1": {{ID: "1", Base: "椎名", Text: "しいな"}},
			},
		}},
	}
	for _, tc := range reviseCases {
		r, err := NewReviseRenderer(builtinTemplate("default_revise.tmpl"))
		if err != nil {
			t.Fatalf("%s: 创建渲染器失败: %v", tc.id, err)
		}
		sys, user, err := r.Render(tc.data)
		if err != nil {
			t.Fatalf("%s: 渲染失败: %v", tc.id, err)
		}
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "prompt.revise.render",
			Args: goldenv.Args("data", wireReviseData{tc.data.SourceLang, tc.data.TargetLang, tc.data.Segments, tc.data.Protocol, tc.data.RubyAnnotations, tc.data.RubyMode}),
			Expect: goldenv.Expect(
				"system", sys,
				"user", user,
			),
		})
	}

	// ---- adjudication 渲染器 ----
	adjudicationCases := []struct {
		id   string
		data AdjudicationData
	}{
		{"prompt/adjudication/json", AdjudicationData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONStrict,
			Segments: []AdjudicationSegment{{
				ID: "1", Source: "src", Target: "tgt",
				Issues: []AdjudicationIssue{{Code: "untranslated", Message: "not translated", MatchedText: "src"}},
			}},
		}},
		{"prompt/adjudication/text", AdjudicationData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText,
			Segments: []AdjudicationSegment{{
				ID: "1", Source: "src", Target: "tgt",
				Issues: []AdjudicationIssue{{Code: "untranslated", Message: "not translated", MatchedText: "src"}},
			}},
		}},
	}
	for _, tc := range adjudicationCases {
		r, err := NewAdjudicationRenderer(builtinTemplate("default_adjudication.tmpl"))
		if err != nil {
			t.Fatalf("%s: 创建渲染器失败: %v", tc.id, err)
		}
		sys, user, err := r.Render(tc.data)
		if err != nil {
			t.Fatalf("%s: 渲染失败: %v", tc.id, err)
		}
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "prompt.adjudication.render",
			Args: goldenv.Args("data", wireAdjudicationData{tc.data.SourceLang, tc.data.TargetLang, tc.data.Segments, tc.data.Protocol}),
			Expect: goldenv.Expect(
				"system", sys,
				"user", user,
			),
		})
	}

	// ---- semantic_qa 渲染器 ----
	semanticCases := []struct {
		id   string
		data SemanticQAData
	}{
		{"prompt/semantic-qa/json", SemanticQAData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolJSONStrict,
			Segments: []SemanticQASegment{{ID: "1", Source: "src", Target: "tgt"}},
		}},
		{"prompt/semantic-qa/text", SemanticQAData{
			SourceLang: "en", TargetLang: "zh", Protocol: ProtocolText,
			Segments: []SemanticQASegment{{ID: "1", Source: "src", Target: "tgt"}},
		}},
	}
	for _, tc := range semanticCases {
		r, err := NewSemanticQARenderer(builtinTemplate("default_semantic_qa.tmpl"))
		if err != nil {
			t.Fatalf("%s: 创建渲染器失败: %v", tc.id, err)
		}
		sys, user, err := r.Render(tc.data)
		if err != nil {
			t.Fatalf("%s: 渲染失败: %v", tc.id, err)
		}
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "prompt.semantic_qa.render",
			Args: goldenv.Args("data", wireSemanticQAData{tc.data.SourceLang, tc.data.TargetLang, tc.data.Segments, tc.data.Protocol}),
			Expect: goldenv.Expect(
				"system", sys,
				"user", user,
			),
		})
	}

	// ---- 响应解析器 ----
	parseCases := []struct {
		id   string
		op   string
		text string
	}{
		{"prompt/parse/bootstrap/json", "prompt.parse_bootstrap", `{"glossary":[{"source":"cat","target":"猫","notes":"n"}]}`},
		{"prompt/parse/bootstrap/fenced", "prompt.parse_bootstrap", "```json\n{\"glossary\":[{\"source\":\"cat\",\"target\":\"猫\",\"notes\":\"\"}]}\n```"},
		{"prompt/parse/bootstrap/dup", "prompt.parse_bootstrap", `{"glossary":[{"source":"cat","target":"猫","notes":""},{"source":"cat","target":"貓","notes":""}]}`},
		{"prompt/parse/bootstrap/empty", "prompt.parse_bootstrap", `{"glossary":[]}`},
		{"prompt/parse/bootstrap/invalid", "prompt.parse_bootstrap", `no json here`},
		{"prompt/parse/revisions/text", "prompt.parse_revisions", "[revisions]\n1 | 新译文\n2 | another | with pipe"},
		{"prompt/parse/revisions/empty", "prompt.parse_revisions", "[revisions]\n"},
		{"prompt/parse/revisions/no-header", "prompt.parse_revisions", "1 | text"},
		{"prompt/parse/verdicts/text", "prompt.parse_verdicts", "[verdicts]\n1 | untranslated | src | real | confirmed"},
		{"prompt/parse/verdicts/legacy", "prompt.parse_verdicts", "[verdicts]\n1 | untranslated | real | confirmed"},
		{"prompt/parse/verdicts/invalid", "prompt.parse_verdicts", "[verdicts]\n1 | untranslated | maybe | x"},
		{"prompt/parse/issues/text", "prompt.parse_issues", "[issues]\n1 | calque | snippet | message here"},
		{"prompt/parse/issues/legacy", "prompt.parse_issues", "[issues]\n1 | calque | message here"},
		{"prompt/parse/issues/unknown-code", "prompt.parse_issues", "[issues]\n1 | unknown_code | snippet | message"},
		{"prompt/parse/strip-fence/plain", "prompt.strip_code_fence", "hello"},
		{"prompt/parse/strip-fence/fenced", "prompt.strip_code_fence", "```json\n{\"a\":1}\n```"},
		{"prompt/parse/strip-fence/with-text", "prompt.strip_code_fence", "before\n```\ninner\n```\nafter"},
	}
	for _, tc := range parseCases {
		switch tc.op {
		case "prompt.parse_bootstrap":
			entries, err := ParseBootstrapResponse(tc.text)
			cases = append(cases, goldenv.Case{
				ID:     tc.id,
				Op:     tc.op,
				Args:   goldenv.Args("text", tc.text),
				Expect: goldenv.Expect("entries", nonNilEntries(entries), "ok", err == nil),
			})
		case "prompt.parse_revisions":
			revisions, recognized := ParseReviseTextRevisions(tc.text)
			cases = append(cases, goldenv.Case{
				ID:     tc.id,
				Op:     tc.op,
				Args:   goldenv.Args("text", tc.text),
				Expect: goldenv.Expect("revisions", nonNilRevisions(revisions), "recognized", recognized),
			})
		case "prompt.parse_verdicts":
			verdicts, recognized := ParseAdjudicationTextVerdicts(tc.text)
			cases = append(cases, goldenv.Case{
				ID:     tc.id,
				Op:     tc.op,
				Args:   goldenv.Args("text", tc.text),
				Expect: goldenv.Expect("verdicts", nonNilVerdicts(verdicts), "recognized", recognized),
			})
		case "prompt.parse_issues":
			issues, recognized := ParseSemanticQATextIssues(tc.text)
			cases = append(cases, goldenv.Case{
				ID:     tc.id,
				Op:     tc.op,
				Args:   goldenv.Args("text", tc.text),
				Expect: goldenv.Expect("issues", nonNilIssues(issues), "recognized", recognized),
			})
		case "prompt.strip_code_fence":
			cases = append(cases, goldenv.Case{
				ID:     tc.id,
				Op:     tc.op,
				Args:   goldenv.Args("text", tc.text),
				Expect: goldenv.Expect("text", StripCodeFence(tc.text)),
			})
		}
	}

	// ---- inlineRubyInSource ----
	inlineCases := []struct {
		id   string
		src  string
		anns []goldenRuby
	}{
		{"prompt/inline-ruby/basic", "椎名です", []goldenRuby{{ID: "1", Base: "椎名", Text: "しいな"}}},
		{"prompt/inline-ruby/two", "椎名と椎名", []goldenRuby{{ID: "1", Base: "椎名", Text: "しいな"}, {ID: "2", Base: "椎名", Text: "しいな"}}},
		{"prompt/inline-ruby/missing", "no match here", []goldenRuby{{ID: "1", Base: "椎名", Text: "しいな"}}},
		{"prompt/inline-ruby/empty", "plain", nil},
	}
	for _, tc := range inlineCases {
		anns := make([]RubyAnnotation, 0, len(tc.anns))
		for _, a := range tc.anns {
			anns = append(anns, RubyAnnotation{ID: a.ID, Base: a.Base, Text: a.Text})
		}
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "prompt.inline_ruby_in_source",
			Args: goldenv.Args("source", tc.src, "annotations", tc.anns),
			Expect: goldenv.Expect(
				"text", inlineRubyInSource(tc.src, anns),
			),
		})
	}

	n, err := goldenv.Write(out, "prompt", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("prompt 黄金向量已导出: %d 条 → %s/prompt.json", n, out)
}

// sanitizeID 把输入转成可读且稳定的用例 ID。
func sanitizeID(s string) string {
	if s == "" {
		return "empty"
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
			out = append(out, c)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}

// ---- 线格式包装（统一用 snake_case 承载黄金向量的输入）----

type wireBootstrapData struct {
	SourceLang string   `json:"source_lang"`
	TargetLang string   `json:"target_lang"`
	Texts      []string `json:"texts"`
	Existing   []string `json:"existing"`
	MaxTerms   int      `json:"max_terms"`
	Protocol   Protocol `json:"protocol"`
}

type wirePruneData struct {
	SourceLang string       `json:"source_lang"`
	TargetLang string       `json:"target_lang"`
	Entries    []PruneEntry `json:"entries"`
	Protocol   Protocol     `json:"protocol"`
}

type wireReviseData struct {
	SourceLang      string                      `json:"source_lang"`
	TargetLang      string                      `json:"target_lang"`
	Segments        []ReviseSegment             `json:"segments"`
	Protocol        Protocol                    `json:"protocol"`
	RubyAnnotations map[string][]RubyAnnotation `json:"ruby_annotations"`
	RubyMode        string                      `json:"ruby_mode"`
}

type wireAdjudicationData struct {
	SourceLang string                `json:"source_lang"`
	TargetLang string                `json:"target_lang"`
	Segments   []AdjudicationSegment `json:"segments"`
	Protocol   Protocol              `json:"protocol"`
}

type wireSemanticQAData struct {
	SourceLang string              `json:"source_lang"`
	TargetLang string              `json:"target_lang"`
	Segments   []SemanticQASegment `json:"segments"`
	Protocol   Protocol            `json:"protocol"`
}

// nonNilEntries 把 nil 切片归一为空切片（Go 的 nil slice 序列化后是 null）。
func nonNilEntries(v []BootstrapEntry) []BootstrapEntry {
	if v == nil {
		return []BootstrapEntry{}
	}
	return v
}

func nonNilVerdicts(v []AdjudicationVerdict) []AdjudicationVerdict {
	if v == nil {
		return []AdjudicationVerdict{}
	}
	return v
}

func nonNilIssues(v []SemanticQAIssue) []SemanticQAIssue {
	if v == nil {
		return []SemanticQAIssue{}
	}
	return v
}

func nonNilRevisions(v []ReviseRevision) []ReviseRevision {
	if v == nil {
		return []ReviseRevision{}
	}
	return v
}

// normalizeGoldenData 把 nil 切片归一为空切片（Go 的 nil slice 序列化后是 null）。
func normalizeGoldenData(g goldenData) goldenData {
	if g.Segments == nil {
		g.Segments = []goldenSegment{}
	}
	if g.Glossary == nil {
		g.Glossary = []goldenGlossary{}
	}
	if g.TMHints == nil {
		g.TMHints = []goldenTMHint{}
	}
	if g.RubyAnnotations == nil {
		g.RubyAnnotations = map[string][]goldenRuby{}
	}
	return g
}
