package qa

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/MeowSalty/LinguaFlow/backend/internal/glossary"
	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// ---- 导出辅助 ----

// normalizeIssues 把 issues 序列化为落库 JSON（走生产 MarshalJSON），
// nil 切片归一化为空数组（README §3.2）。
func normalizeIssues(t *testing.T, issues []QualityIssue) []any {
	t.Helper()
	out := make([]any, 0, len(issues))
	for _, iss := range issues {
		raw, err := json.Marshal(iss)
		if err != nil {
			t.Fatalf("序列化 issue 失败: %v", err)
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatalf("反序列化 issue 失败: %v", err)
		}
		out = append(out, v)
	}
	return out
}

// goldenSegments 把 CheckInput 投影为 TS 侧可还原的参数形态。
func goldenSegments(segments []CheckInput) []map[string]any {
	out := make([]map[string]any, 0, len(segments))
	for _, s := range segments {
		m := map[string]any{
			"index":  s.Index,
			"source": s.SourceText,
			"target": s.TargetText,
		}
		if s.Protected != nil {
			m["protected"] = s.Protected
		}
		if s.Meta != nil {
			m["meta"] = s.Meta
		}
		out = append(out, m)
	}
	return out
}

// checkerArgs 构造 checker 用例参数：segments + 若干额外键值对。
func checkerArgs(segments []CheckInput, extra ...any) map[string]any {
	m := goldenv.Args("segments", goldenSegments(segments))
	for i := 0; i+1 < len(extra); i += 2 {
		key, ok := extra[i].(string)
		if !ok {
			continue
		}
		m[key] = extra[i+1]
	}
	return m
}

// appendCheckerCase 运行 checker 并把真实输出写入 cases。
func appendCheckerCase(t *testing.T, out *[]goldenv.Case, id, op string, args map[string]any, c Checker, segments []CheckInput) {
	t.Helper()
	issues := c.Check(context.Background(), segments)
	*out = append(*out, goldenv.Case{
		ID:     id,
		Op:     op,
		Args:   args,
		Expect: goldenv.Expect("issues", normalizeIssues(t, issues)),
	})
}

// goldenGlossaryEntry 是术语表条目的参数形态（驼峰，与 TS 侧 GlossaryEntry 对齐）。
type goldenGlossaryEntry struct {
	Source        string `json:"source"`
	Target        string `json:"target"`
	CaseSensitive bool   `json:"caseSensitive"`
	Forbidden     bool   `json:"forbidden"`
	Mandatory     bool   `json:"mandatory"`
	Notes         string `json:"notes"`
}

// newGoldenGlossary 用真实生产实现（glossary.NewMemory + Add）构造术语表。
func newGoldenGlossary(t *testing.T, entries []goldenGlossaryEntry) *glossary.FileGlossary {
	t.Helper()
	g := glossary.NewMemory()
	converted := make([]glossary.Entry, 0, len(entries))
	for _, e := range entries {
		converted = append(converted, glossary.Entry{
			Source:        e.Source,
			Target:        e.Target,
			CaseSensitive: e.CaseSensitive,
			Forbidden:     e.Forbidden,
			Mandatory:     e.Mandatory,
			Notes:         e.Notes,
		})
	}
	if _, err := g.Add(context.Background(), converted...); err != nil {
		t.Fatalf("构建术语表失败: %v", err)
	}
	return g
}

// wireSpan / wireIssue 是落库形态的构造器（字段名与 json tag 逐字一致）。
type wireSpan struct {
	MatchedText string `json:"matched_text"`
	TargetStart *int   `json:"target_start,omitempty"`
	TargetEnd   *int   `json:"target_end,omitempty"`
}

type wireIssue struct {
	SegmentIndex int              `json:"segment_index"`
	Severity     IssueSeverity    `json:"severity"`
	Code         string           `json:"code"`
	Message      string           `json:"message"`
	Span         *wireSpan        `json:"span,omitempty"`
	Disposition  IssueDisposition `json:"disposition"`
	DecidedBy    *int             `json:"decided_by,omitempty"`
	DecidedAt    *string          `json:"decided_at,omitempty"`
	Note         string           `json:"note,omitempty"`
}

// decodeIssues 把 wire 形态解码为生产类型（走生产 UnmarshalJSON 归一化）。
func decodeIssues(t *testing.T, wires []wireIssue) []QualityIssue {
	t.Helper()
	raw, err := json.Marshal(wires)
	if err != nil {
		t.Fatalf("序列化 wire issues 失败: %v", err)
	}
	var out []QualityIssue
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("反序列化 wire issues 失败: %v", err)
	}
	return out
}

// strPtr 返回指向 v 的指针。
func strPtr(v string) *string { return &v }

// localTimePtr 返回指向 v 的指针（保留其 Location）。
func localTimePtr(v time.Time) *time.Time { return &v }

// mustJSON 把 v 序列化后再解析为 any（走生产 MarshalJSON），供 Expect 使用。
func mustJSON(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	return out
}

// TestGoldenVectors 导出 qa 包的黄金测试向量。
//
// 覆盖 qa 包全部 *_test.go 的边界用例（每个 checker 独立 Op），以及
// LocateSpan / Fingerprint / ReconcileIssues / RecheckFinalIssues /
// ReviseFinalIssues / 保护区 / 数字归一化 / 序列化等核心原语。
//
// 仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘；常规 go test 不产生副作用。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	var cases []goldenv.Case

	// ================= untranslated =================
	untranslatedCases := []struct {
		id       string
		srcLang  string
		tgtLang  string
		segments []CheckInput
	}{
		{"ja-zh/pure-han-warning", "ja", "zh", []CheckInput{{Index: 0, SourceText: "北海道大学", TargetText: "北海道大学"}}},
		{"ja-zh/kana-error", "ja", "zh", []CheckInput{{Index: 0, SourceText: "これは日本語です", TargetText: "これは日本語です"}}},
		{"zh-en/han-error", "zh", "en", []CheckInput{{Index: 0, SourceText: "你好世界", TargetText: "你好世界"}}},
		{"en-de/shared-latin-warning", "en", "de", []CheckInput{{Index: 0, SourceText: "Marketing", TargetText: "Marketing"}}},
		{"auto-zh/error", "auto", "zh", []CheckInput{{Index: 0, SourceText: "Marketing", TargetText: "Marketing"}}},
		{"empty-src-lang/error", "", "zh", []CheckInput{{Index: 0, SourceText: "Marketing", TargetText: "Marketing"}}},
		{"empty-tgt-lang/error", "en", "", []CheckInput{{Index: 0, SourceText: "Marketing", TargetText: "Marketing"}}},
		{"zh-ko/han-error", "zh", "ko", []CheckInput{{Index: 0, SourceText: "你好世界", TargetText: "你好世界"}}},
		{"ko-zh/pure-han-warning", "ko", "zh", []CheckInput{{Index: 0, SourceText: "大韓民國", TargetText: "大韓民國"}}},
		{"ko-zh/hangul-error", "ko", "zh", []CheckInput{{Index: 0, SourceText: "안녕하세요", TargetText: "안녕하세요"}}},
		{"translated/pass", "en", "de", []CheckInput{{Index: 0, SourceText: "Hello", TargetText: "Bonjour"}}},
		{"placeholder/only", "en", "de", []CheckInput{{Index: 0, SourceText: "__LF_000001__", TargetText: "__LF_000001__"}}},
		{"placeholder/with-digits", "en", "de", []CheckInput{{Index: 0, SourceText: "__LF_000001__ 123", TargetText: "__LF_000001__ 123"}}},
		{"placeholder/with-text", "en", "de", []CheckInput{{Index: 0, SourceText: "__LF_000001__ Marketing", TargetText: "__LF_000001__ Marketing"}}},
		{"basic/identity-warning", "en", "de", []CheckInput{{Index: 0, SourceText: "Hello World", TargetText: "Hello World"}}},
		{"basic/pure-numbers-exempt", "en", "de", []CheckInput{{Index: 0, SourceText: "123", TargetText: "123"}}},
		{"basic/pure-punctuation-exempt", "en", "de", []CheckInput{{Index: 0, SourceText: "...", TargetText: "..."}}},
		{"basic/trimmed-identity", "en", "de", []CheckInput{{Index: 0, SourceText: " Hello ", TargetText: "Hello"}}},
		{"ruby/stripped-identity-error", "ja", "zh", []CheckInput{{Index: 0,
			SourceText: "<ruby>何<rt>な</rt>故<rt>ぜ</rt></ruby>、隠し通路の情報を炎神皇サイドに流したんだ？",
			TargetText: "何故、隠し通路の情報を炎神皇サイドに流したんだ？"}}},
		{"ruby/translated-plain", "ja", "zh", []CheckInput{{Index: 0,
			SourceText: "<ruby>隠<rt>かく</rt>し通路</ruby>の情報", TargetText: "秘密通道的情报"}}},
		{"ruby/translated-with-ruby", "ja", "zh", []CheckInput{{Index: 0,
			SourceText: "<ruby>隠<rt>かく</rt>し通路</ruby>の情報", TargetText: "<ruby>秘密<rt>mìmì</rt></ruby>通道的情报"}}},
		{"ruby/identical-including-tags", "ja", "zh", []CheckInput{{Index: 0,
			SourceText: "<ruby>何<rt>な</rt>故<rt>ぜ</rt></ruby>、隠し通路の情報を炎神皇サイドに流したんだ？",
			TargetText: "<ruby>何<rt>な</rt>故<rt>ぜ</rt></ruby>、隠し通路の情報を炎神皇サイドに流したんだ？"}}},
		{"ruby/pure-han-warning", "ja", "zh", []CheckInput{{Index: 0,
			SourceText: "<ruby>北海道<rt>ほっかいどう</rt></ruby>", TargetText: "北海道"}}},
		{"markup/protected-symbol-only", "ja", "zh", []CheckInput{{Index: 0,
			SourceText: `<span class="line-break-loose word-break-break-all">☆★☆★☆★</span>`,
			TargetText: `<span class="line-break-loose word-break-break-all">☆★☆★☆★</span>`,
			Protected: map[string]string{
				"__LF_000001__": `<span class="line-break-loose word-break-break-all">`,
				"__LF_000002__": `</span>`,
			}}}},
		{"markup/bare-tag-symbol-only", "ja", "zh", []CheckInput{{Index: 0,
			SourceText: `<span class="line-break-loose word-break-break-all">☆★☆★☆★</span>`,
			TargetText: `<span class="line-break-loose word-break-break-all">☆★☆★☆★</span>`}}},
		{"markup/br-only", "ja", "zh", []CheckInput{{Index: 0, SourceText: "<br/>", TargetText: "<br/>"}}},
		{"markup/real-text-in-tag", "ja", "zh", []CheckInput{{Index: 0, SourceText: "<b>Hello</b>", TargetText: "<b>Hello</b>"}}},
	}
	for _, tc := range untranslatedCases {
		args := checkerArgs(tc.segments, "srcLang", tc.srcLang, "tgtLang", tc.tgtLang)
		appendCheckerCase(t, &cases, "qa/untranslated/"+tc.id, "qa.untranslated", args,
			NewUntranslatedChecker(tc.srcLang, tc.tgtLang), tc.segments)
	}

	// ================= length_ratio =================
	type ratioCase struct {
		id       string
		min      float64
		max      float64
		method   LengthMethod
		segments []CheckInput
	}
	ratioCases := []ratioCase{
		{"normal-ratio-passes", 0.2, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "Hello World", TargetText: "你好世界"}}},
		{"too-short", 0.2, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "This is a long sentence with many words", TargetText: "短"}}},
		{"too-long", 0.2, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "Hello World", TargetText: "这是一个非常非常非常非常非常非常非常非常非常非常非常长的译文"}}},
		{"short-source-skipped", 0.2, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "Hi", TargetText: "你好"}}},
		{"min-ratio-zero-disables", 0, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "This is a long sentence with many words", TargetText: "短"}}},
		{"negative-min-falls-back", -1, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "This is a long sentence with many words", TargetText: "短"}}},
		{"max-ratio-zero-disables", 0.2, 0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "Hello World", TargetText: "这是一个非常非常非常非常非常非常非常非常非常非常非常长的译文"}}},
		{"negative-max-falls-back", 0.2, -1, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "Hello World", TargetText: "这是一个非常非常非常非常非常非常非常非常非常非常非常长的译文"}}},
		{"word-count/zh-en-normal", 0.3, 2.5, LengthMethodWordCount, []CheckInput{{Index: 0, SourceText: "你好世界", TargetText: "Hello World"}}},
		{"word-count/en-zh-normal", 0.3, 2.5, LengthMethodWordCount, []CheckInput{{Index: 0, SourceText: "Hello World", TargetText: "你好世界"}}},
		{"word-count/too-short", 0.3, 2.5, LengthMethodWordCount, []CheckInput{{Index: 0, SourceText: "这是一段很长的句子用于测试", TargetText: "test"}}},
		{"empty-method-defaults", 0.2, 3.0, "", []CheckInput{{Index: 0, SourceText: "Hello World", TargetText: "你好世界"}}},
		{"ruby/target-inflated-would-fail", 0.2, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "呪術廻戦を見る", TargetText: "<ruby>咒术回战<rt>じゅじゅつかいせん</rt></ruby>动画"}}},
		{"ruby/source-also-stripped", 0.2, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "<ruby>呪術廻戦<rt>じゅじゅつかいせん</rt></ruby>を見る", TargetText: "咒术回战动画"}}},
		{"ruby/absent-unaffected", 0.2, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "これはテストです", TargetText: "这是一个测试"}}},
		{"ruby/genuine-too-long", 0.2, 3.0, LengthMethodCharWeight, []CheckInput{{Index: 0, SourceText: "呪術廻戦を見る", TargetText: "<ruby>咒术回战<rt>じゅじゅつかいせん</rt></ruby>这是一个非常非常非常非常非常非常非常非常非常长的译文"}}},
	}
	for _, tc := range ratioCases {
		args := checkerArgs(tc.segments, "minRatio", tc.min, "maxRatio", tc.max, "method", string(tc.method))
		appendCheckerCase(t, &cases, "qa/length-ratio/"+tc.id, "qa.length_ratio", args,
			NewLengthRatioChecker(tc.min, tc.max, tc.method), tc.segments)
	}

	// ================= duplicate =================
	duplicateCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"no-duplicates", []CheckInput{
			{Index: 0, SourceText: "Hello", TargetText: "你好"},
			{Index: 1, SourceText: "World", TargetText: "世界"},
		}},
		{"duplicate-detected", []CheckInput{
			{Index: 0, SourceText: "Hello", TargetText: "你好"},
			{Index: 1, SourceText: "World", TargetText: "你好"},
		}},
		{"same-source-same-target-exempt", []CheckInput{
			{Index: 0, SourceText: "Hello", TargetText: "你好"},
			{Index: 1, SourceText: "Hello", TargetText: "你好"},
		}},
		{"empty-target-skipped", []CheckInput{
			{Index: 0, SourceText: "Hello", TargetText: ""},
			{Index: 1, SourceText: "World", TargetText: ""},
		}},
	}
	for _, tc := range duplicateCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/duplicate/"+tc.id, "qa.duplicate", args,
			NewDuplicateTranslationChecker(), tc.segments)
	}

	// ================= source_residual =================
	residualCases := []struct {
		id       string
		srcLang  string
		tgtLang  string
		segments []CheckInput
	}{
		{"ja-zh/kana-residual", "ja", "zh", []CheckInput{{Index: 0, SourceText: "これはテストです", TargetText: "这是テスト"}}},
		{"ja-zh/han-anchored", "ja", "zh", []CheckInput{{Index: 0, SourceText: "東京大学の研究", TargetText: "東京大学的研究"}}},
		{"zh-en/han-residual", "zh", "en", []CheckInput{{Index: 0, SourceText: "你好世界", TargetText: "Hello 你好 world"}}},
		{"zh-en/no-residual", "zh", "en", []CheckInput{{Index: 0, SourceText: "你好世界", TargetText: "Hello world"}}},
		{"en-zh/non-independent-latin", "en", "zh", []CheckInput{{Index: 0, SourceText: "ok", TargetText: "OK"}}},
		{"en-zh/latin-run", "en", "zh", []CheckInput{{Index: 0, SourceText: "Hello world", TargetText: "你好 Hello 世界"}}},
		{"ru-zh/single-cyrillic-skipped", "ru", "zh", []CheckInput{{Index: 0, SourceText: "Привет мир", TargetText: "你好 Ж 世界"}}},
		{"ru-zh/cyrillic-run", "ru", "zh", []CheckInput{{Index: 0, SourceText: "Привет мир", TargetText: "你好 Же 世界"}}},
		{"ko-zh/single-hangul", "ko", "zh", []CheckInput{{Index: 0, SourceText: "안녕하세요", TargetText: "你好 안 世界"}}},
		{"identity-skipped", "en", "zh", []CheckInput{{Index: 0, SourceText: "Hello", TargetText: "Hello"}}},
		{"auto-src-no-rules", "auto", "zh", []CheckInput{{Index: 0, SourceText: "Hello", TargetText: "你好 Hello 世界"}}},
		{"zh-ja/weak-tier-disabled", "zh", "ja", []CheckInput{{Index: 0, SourceText: "这是一个测试", TargetText: "これは測試です"}}},
		{"protected-residual-hidden", "zh", "en", []CheckInput{{Index: 0,
			SourceText: "你好", TargetText: `<span title="你好">Hello</span>`,
			Protected: map[string]string{"__LF_000001__": `<span title="你好">`}}}},
		{"placeholder-stripped", "ru", "zh", []CheckInput{{Index: 0,
			SourceText: "Привет мир", TargetText: "__LF_000001__ 你好"}}},
		{"dedup-same-hit", "ja", "zh", []CheckInput{{Index: 0, SourceText: "テストです", TargetText: "テスト测试测试"}}},
	}
	for _, tc := range residualCases {
		args := checkerArgs(tc.segments, "srcLang", tc.srcLang, "tgtLang", tc.tgtLang)
		appendCheckerCase(t, &cases, "qa/source-residual/"+tc.id, "qa.source_residual", args,
			NewSourceResidualChecker(tc.srcLang, tc.tgtLang), tc.segments)
	}

	// ================= punctuation_pairing =================
	pairingCases := []struct {
		id         string
		targetLang string
		segments   []CheckInput
	}{
		{"cjk-unclosed", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他说「你好"}}},
		{"latin-ok", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: `He said "hello" (world).`}}},
		{"apostrophe-not-pair", "en", []CheckInput{{Index: 0, TargetText: "Don't change it."}}},
		{"misnested", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "a (b [c) d]"}}},
		{"extra-close", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "hello)"}}},
		{"protected-tag", "zh", []CheckInput{{Index: 0,
			SourceText: "中間試験結果とアンネマリーの考察",
			TargetText: `<a href="p-006.xhtml">期中考试结果与安妮玛丽的考察</a>`,
			Protected:  map[string]string{"__LF_000001__": `<a href="p-006.xhtml">期中考试结果与安妮玛丽的考察</a>`}}}},
		{"cjk-nested-ok", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "「外『内』外」"}}},
		{"cjk-symmetric-quotes-ok", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: `"a" and "b"`}}},
		{"empty-target-skipped", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "   "}}},
	}
	for _, tc := range pairingCases {
		args := checkerArgs(tc.segments, "targetLang", tc.targetLang)
		appendCheckerCase(t, &cases, "qa/punctuation-pairing/"+tc.id, "qa.punctuation_pairing", args,
			NewPunctuationPairingChecker(tc.targetLang), tc.segments)
	}

	// ================= punctuation_missing =================
	frenchSource := "Gambetta découvre un Paris froid et brumeux et s’inscrit rapidement à la faculté de droit. " +
		"Il songe depuis longtemps à ces études juridiques, sachant confusément qu’elles vont lui permettre de sortir d’un milieu certes aimant, mais étriqué. " +
		"Pour les jeunes gens peu fortunés, le droit est la meilleure porte d’accès à des postes en vue. " +
		"Vingt-cinq ans après Gambetta, Aristide Briand, par exemple, fils d’un tenancier de café-concert nantais, suivra la même voie."
	missingCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"quote-absent", []CheckInput{{Index: 0, SourceText: "「それは…ですね？」", TargetText: "是…对吗？"}}},
		{"french-apostrophes", []CheckInput{{Index: 0, SourceText: frenchSource,
			TargetText: "甘必大抵达巴黎后，很快进入法学院就读。他期盼攻读法学已久，隐约知道这能让他脱离那个虽充满关爱却狭隘闭塞的成长环境。" +
				"对于家境清贫的年轻人来说，法学是跻身显赫职位的最佳通道。比如比甘必大晚二十五年的阿里斯蒂德·白里安，也走了相同的道路。"}}},
		{"french-guillemets", []CheckInput{{Index: 0, SourceText: "Il dit « bonjour ». ", TargetText: "他说了这句话。"}}},
		{"ascii-double-quote", []CheckInput{{Index: 0, SourceText: `He said "hello".`, TargetText: "他说了这句话。"}}},
		{"apostrophe-inside-single-quotes", []CheckInput{{Index: 0, SourceText: "Il cite ‘l’homme’. ", TargetText: "他说了这句话。"}}},
		{"paren-absent", []CheckInput{{Index: 0, SourceText: "見て（附录）", TargetText: "看附录"}}},
		{"both-absent", []CheckInput{{Index: 0, SourceText: "「見て（附录）」", TargetText: "见附录"}}},
		{"curly-replacement-ok", []CheckInput{{Index: 0, SourceText: "「a」", TargetText: "“a”"}}},
		{"ascii-replacement-ok", []CheckInput{{Index: 0, SourceText: "「a」", TargetText: `"a"`}}},
		{"single-sided-delegated", []CheckInput{{Index: 0, SourceText: "「a」", TargetText: "「a"}}},
		{"unpaired-source", []CheckInput{{Index: 0, SourceText: "見て「", TargetText: "看"}}},
		{"protected-region", []CheckInput{{Index: 0,
			SourceText: "中間試験結果とアンネマリーの考察",
			TargetText: `<a href="p-006.xhtml">期中考试结果与安妮玛丽的考察</a>`,
			Protected:  map[string]string{"__LF_000001__": `<a href="p-006.xhtml">期中考试结果与安妮玛丽的考察</a>`}}}},
		{"empty-inputs", []CheckInput{
			{Index: 0, SourceText: "", TargetText: ""},
			{Index: 1, SourceText: "「a」", TargetText: "   "},
			{Index: 2, SourceText: "   ", TargetText: "a"},
		}},
		{"latin-paren-absent", []CheckInput{{Index: 0, SourceText: "see (x)", TargetText: "见x"}}},
		{"source-span-attribute-quotes", []CheckInput{{Index: 0,
			SourceText: `<span class="tcy">10</span>件の表示`,
			TargetText: `<span class="tcy">10</span>件的显示`,
			Protected:  map[string]string{"__LF_000001__": `<span class="tcy">10</span>`}}}},
		{"ruby-in-source", []CheckInput{{Index: 0, SourceText: "見て<ruby>呪<rt>じゅ</rt></ruby>術", TargetText: "看<ruby>咒<rt>zhou</rt></ruby>术"}}},
	}
	for _, tc := range missingCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/punctuation-missing/"+tc.id, "qa.punctuation_missing", args,
			NewPunctuationMissingChecker(), tc.segments)
	}

	// ================= punctuation_surplus =================
	surplusCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"quote-added", []CheckInput{{Index: 0,
			SourceText: "いや、初対面の人の首筋に、匂いを嗅ぐのはどうかと思うよ？",
			TargetText: `"不是，第一次见面就闻味道，这有点不妥吧？"`}}},
		{"paren-added", []CheckInput{{Index: 0, SourceText: "テストです", TargetText: "（测试）"}}},
		{"multiple-pairs-single-issue", []CheckInput{{Index: 0, SourceText: "テスト", TargetText: `"前""后"`}}},
		{"category-replacement", []CheckInput{{Index: 0, SourceText: "「それは…ですね？」", TargetText: `"是…对吧？"`}}},
		{"single-sided-delegated", []CheckInput{{Index: 0, SourceText: "テスト", TargetText: `"テスト`}}},
		{"protected-region", []CheckInput{{Index: 0,
			SourceText: "テスト", TargetText: `<a title="quoted">测试</a>`,
			Protected:  map[string]string{"__LF_000001__": `<a title="quoted">测试</a>`}}}},
		{"empty-inputs", []CheckInput{
			{Index: 0, SourceText: "", TargetText: `"测试"`},
			{Index: 1, SourceText: "テスト", TargetText: "   "},
			{Index: 2, SourceText: "   ", TargetText: "测试"},
		}},
		{"source-has-quote-skipped", []CheckInput{{Index: 0, SourceText: "「a」と「b」", TargetText: "「x」と「y」"}}},
	}
	for _, tc := range surplusCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/punctuation-surplus/"+tc.id, "qa.punctuation_surplus", args,
			NewPunctuationSurplusChecker(), tc.segments)
	}

	// ================= punctuation_wrap_loss =================
	wrapLossCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"inner-quotes-added", []CheckInput{{Index: 0,
			SourceText: "「最初は全然取りあってくれなかったのに覆面って言葉を出したら、異常に食いついてきたのよ。あとはマーリン様の覆面……すっごい素敵ですねとか適当におだてりゃ……まあこの通りってなもんよ」",
			TargetText: "一开始她根本不肯搭理我，结果我一说出“面具”这两个字，她就异常兴奋地咬了上来。然后再随便夸几句“梅林大人的面具——超漂亮的呢”之类的话……嗯，就变成现在这样了。"}}},
		{"total-loss", []CheckInput{{Index: 0, SourceText: "「a」", TargetText: "a"}}},
		{"category-replacement-ok", []CheckInput{{Index: 0, SourceText: "「a」", TargetText: "“a”"}}},
		{"ascii-replacement-ok", []CheckInput{{Index: 0, SourceText: "「a」", TargetText: `"a"`}}},
		{"guillemets-ok", []CheckInput{{Index: 0, SourceText: "「a」", TargetText: "«a»"}}},
		{"single-sided-delegated", []CheckInput{
			{Index: 0, SourceText: "「a」", TargetText: "「a"},
			{Index: 1, SourceText: "「a」", TargetText: "a」"},
		}},
		{"multi-span-source-skipped", []CheckInput{{Index: 0, SourceText: "「你好」「再见」", TargetText: "你好 再见"}}},
		{"mid-sentence-source", []CheckInput{{Index: 0, SourceText: "这是“测试”消息", TargetText: "这是测试消息"}}},
		{"empty-content", []CheckInput{{Index: 0, SourceText: "「」", TargetText: "x"}}},
		{"empty-inputs", []CheckInput{
			{Index: 0, SourceText: "", TargetText: ""},
			{Index: 1, SourceText: "「a」", TargetText: "   "},
			{Index: 2, SourceText: "   ", TargetText: "a"},
		}},
		{"protected-region", []CheckInput{{Index: 0,
			SourceText: "「中間試験の考察」",
			TargetText: `<a href="p-006.xhtml">期中考试结果的考察</a>`,
			Protected:  map[string]string{"__LF_000001__": `<a href="p-006.xhtml">期中考试结果的考察</a>`}}}},
		{"inner-source-quotes-single-span", []CheckInput{{Index: 0, SourceText: "「彼は“行く”と言った」", TargetText: "他说要去"}}},
		{"trimmed-target-edges", []CheckInput{{Index: 0, SourceText: "「彼は行くと言った」", TargetText: "  他说要去  "}}},
		{"ruby-in-source", []CheckInput{{Index: 0, SourceText: "「見て<ruby>呪<rt>じゅ</rt></ruby>術」", TargetText: "看咒术"}}},
	}
	for _, tc := range wrapLossCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/punctuation-wrap-loss/"+tc.id, "qa.punctuation_wrap_loss", args,
			NewPunctuationWrapLossChecker(), tc.segments)
	}

	// ================= whitespace_irregular =================
	whitespaceCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"zwsp", []CheckInput{{Index: 0, SourceText: "a", TargetText: "hello\u200bworld"}}},
		{"nbsp", []CheckInput{{Index: 0, SourceText: "a", TargetText: "hello\u00a0world"}}},
		{"trim-only-exempt", []CheckInput{{Index: 0, SourceText: "a", TargetText: "  hello world  "}}},
		{"protected-nbsp", []CheckInput{{Index: 0, SourceText: "a",
			TargetText: "hello\u00a0world", Protected: map[string]string{"__LF_000001__": "hello\u00a0world"}}}},
		{"tab", []CheckInput{{Index: 0, SourceText: "a", TargetText: "hello\tworld"}}},
		{"bom", []CheckInput{{Index: 0, SourceText: "a", TargetText: "\ufeffhello"}}},
		{"ideographic-space", []CheckInput{{Index: 0, SourceText: "a", TargetText: "你\u3000好"}}},
		{"line-separator", []CheckInput{{Index: 0, SourceText: "a", TargetText: "hello\u2028world"}}},
		{"zwnj", []CheckInput{{Index: 0, SourceText: "a", TargetText: "he\u200cllo"}}},
		{"empty-target-skipped", []CheckInput{{Index: 0, SourceText: "a", TargetText: ""}}},
	}
	for _, tc := range whitespaceCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/whitespace-irregular/"+tc.id, "qa.whitespace_irregular", args,
			NewWhitespaceIrregularChecker(), tc.segments)
	}

	// ================= repeated_space =================
	repeatedCases := []struct {
		id         string
		targetLang string
		segments   []CheckInput
	}{
		{"double", "en", []CheckInput{{Index: 0, SourceText: "a", TargetText: "hello  world"}}},
		{"cjk-between", "zh", []CheckInput{{Index: 0, SourceText: "a", TargetText: "你 好"}}},
		{"latin-ok", "en", []CheckInput{{Index: 0, SourceText: "a", TargetText: "hello world"}}},
		{"protected-double", "en", []CheckInput{{Index: 0, SourceText: "a",
			TargetText: "hello  world", Protected: map[string]string{"__LF_000001__": "hello  world"}}}},
		{"across-protected", "en", []CheckInput{{Index: 0, SourceText: "x",
			TargetText: "hello <br/> world", Protected: map[string]string{"__LF_000001__": "<br/>"}}}},
		{"across-protected-cjk", "zh", []CheckInput{{Index: 0, SourceText: "x",
			TargetText: "你 <br/> 我", Protected: map[string]string{"__LF_000001__": "<br/>"}}}},
		{"real-double-outside-protected", "en", []CheckInput{{Index: 0, SourceText: "x",
			TargetText: "hello<br/> world  end", Protected: map[string]string{"__LF_000001__": "<br/>"}}}},
		{"triple-space", "en", []CheckInput{{Index: 0, SourceText: "a", TargetText: "a   b"}}},
		{"tab-not-space-run", "en", []CheckInput{{Index: 0, SourceText: "a", TargetText: "a\tb"}}},
	}
	for _, tc := range repeatedCases {
		args := checkerArgs(tc.segments, "targetLang", tc.targetLang)
		appendCheckerCase(t, &cases, "qa/repeated-space/"+tc.id, "qa.repeated_space", args,
			NewRepeatedSpaceChecker(tc.targetLang), tc.segments)
	}

	// ================= width_mix =================
	widthCases := []struct {
		id         string
		targetLang string
		segments   []CheckInput
	}{
		{"cjk-halfwidth-comma", "zh", []CheckInput{{Index: 0, SourceText: "a", TargetText: "你好,世界"}}},
		{"cjk-fullwidth-ok", "zh", []CheckInput{{Index: 0, SourceText: "a", TargetText: "你好，世界"}}},
		{"latin-fullwidth", "en", []CheckInput{{Index: 0, SourceText: "a", TargetText: "Hello，world"}}},
		{"latin-ok", "en", []CheckInput{{Index: 0, SourceText: "a", TargetText: "Hello, world!"}}},
		{"protected-tag", "zh", []CheckInput{{Index: 0,
			SourceText: "中間試験結果とアンネマリーの考察",
			TargetText: `<a href="p-006.xhtml">期中考试结果与安妮玛丽的考察</a>`,
			Protected:  map[string]string{"__LF_000001__": `<a href="p-006.xhtml">期中考试结果与安妮玛丽的考察</a>`}}}},
		{"protected-tag-halfwidth-outside", "zh", []CheckInput{{Index: 0,
			SourceText: "x", TargetText: `你好,<a href="x">链接</a>`,
			Protected: map[string]string{"__LF_000001__": `<a href="x">链接</a>`}}}},
		{"protected-tag-repeated", "zh", []CheckInput{{Index: 0,
			SourceText: "x", TargetText: "第一行<br/>第二行<br/>",
			Protected: map[string]string{"__LF_000001__": "<br/>", "__LF_000002__": "<br/>"}}}},
		{"span-outside-protected", "zh", []CheckInput{{Index: 0,
			SourceText: "x", TargetText: `<a,x>你好,`,
			Protected: map[string]string{"__LF_000001__": `<a,x>`}}}},
		{"ruby-tag", "zh", []CheckInput{{Index: 0, SourceText: "雷神皇", TargetText: "<ruby>雷神皇<rt>艾福达尔</rt></ruby>"}}},
		{"ruby-with-protected-span", "zh", []CheckInput{{Index: 0,
			SourceText: "x", TargetText: `<a href="x">連</a><ruby>雷<rt>lei</rt></ruby>神`,
			Protected: map[string]string{"__LF_000001__": `<a href="x">連</a>`}}}},
		{"real-halfwidth-outside-ruby", "zh", []CheckInput{{Index: 0, SourceText: "x",
			TargetText: "你好,世界<ruby>雷<rt>lei</rt></ruby>神"}}},
		{"unprotected-tag", "zh", []CheckInput{{Index: 0, SourceText: "雷神皇", TargetText: `<a href="x">連</a>神`}}},
		{"real-halfwidth-outside-unprotected-tag", "zh", []CheckInput{{Index: 0, SourceText: "x",
			TargetText: `你好,世界<a href="x">連</a>`}}},
		{"safe-set/bang", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "好!"}}},
		{"safe-set/question", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他?"}}},
		{"safe-set/comma", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "说,"}}},
		{"safe-set/semicolon", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "也;"}}},
		{"safe-set/colon", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他:你"}}},
		{"safe-set/open-paren", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他(约)"}}},
		{"safe-set/close-paren", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "约)"}}},
		{"safe-set/open-bracket", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他["}}},
		{"safe-set/close-bracket", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他]"}}},
		{"narrowed/dot", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他.说"}}},
		{"narrowed/double-quote", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他\"话\""}}},
		{"narrowed/single-quote", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他'话'"}}},
		{"narrowed/braces", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他{}"}}},
		{"narrowed/at", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他@说"}}},
		{"narrowed/hash", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他#号"}}},
		{"narrowed/dollar", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他$元"}}},
		{"narrowed/percent", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他%比"}}},
		{"narrowed/caret", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他^号"}}},
		{"narrowed/ampersand", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他&和"}}},
		{"narrowed/asterisk", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他*乘"}}},
		{"narrowed/hyphen", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他-连"}}},
		{"narrowed/underscore", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他_线"}}},
		{"narrowed/equals", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他=等"}}},
		{"narrowed/plus", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他+加"}}},
		{"narrowed/backslash", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他\\斜"}}},
		{"narrowed/pipe", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他|竖"}}},
		{"narrowed/slash", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他/斜"}}},
		{"narrowed/lt", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他<小于"}}},
		{"narrowed/gt", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他>大于"}}},
		{"narrowed/tilde", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他~约"}}},
		{"narrowed/backtick", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他`点"}}},
		{"guard/clock", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "12:30"}}},
		{"guard/thousands", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "1,000"}}},
		{"guard/ratio", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "2:1"}}},
		{"guard/exclaim", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "5!"}}},
		{"guard/exclaim-3", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "3!"}}},
		{"guard/exclaim-question-run", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "100!?"}}},
		{"boundary/comma-after-digit", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "3,但是"}}},
		{"boundary/colon-after-text", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "他说:你好"}}},
		{"boundary/bang-run", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "好!?"}}},
		{"boundary/bang-run-long", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "那是什么!?"}}},
		{"boundary/paren-after-digit", "zh", []CheckInput{{Index: 0, SourceText: "x", TargetText: "100(约)"}}},
		{"latin-fullwidth/A", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "Ａpple"}}},
		{"latin-fullwidth/o", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "nｏ.1"}}},
		{"latin-fullwidth/0", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "v０"}}},
		{"latin-fullwidth/1", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "a１2"}}},
		{"latin-vertical/ff5f", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "a｟b"}}},
		{"latin-vertical/ff60", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "x｠y"}}},
	}
	for _, tc := range widthCases {
		id := "qa/width-mix/" + tc.id
		args := checkerArgs(tc.segments, "targetLang", tc.targetLang)
		appendCheckerCase(t, &cases, id, "qa.width_mix", args,
			NewWidthMixChecker(tc.targetLang), tc.segments)
	}

	// ================= script_mismatch =================
	scriptCases := []struct {
		id         string
		targetLang string
		segments   []CheckInput
	}{
		{"zh-hans/pure-hant", "zh-Hans", []CheckInput{{Index: 0, SourceText: "x", TargetText: "這是一個繁體中文的測試段落"}}},
		{"zh-hans/pure-hans", "zh-Hans", []CheckInput{{Index: 0, SourceText: "x", TargetText: "这是一个简体中文的测试段落"}}},
		{"zh-hans/shared-only", "zh-Hans", []CheckInput{{Index: 0, SourceText: "x", TargetText: "你好,人山人海。"}}},
		{"zh-hans/single-hant", "zh-Hans", []CheckInput{{Index: 0, SourceText: "x", TargetText: "这里是简体,裡面混了一个繁体字。"}}},
		{"zh-hant/simplified", "zh-Hant", []CheckInput{{Index: 0, SourceText: "x", TargetText: "这里应该是繁体"}}},
		{"sr-latn/cyrillic", "sr-Latn", []CheckInput{{Index: 0, SourceText: "x", TargetText: "Dobro došli, Жељко!"}}},
		{"inactive/en", "en", []CheckInput{{Index: 0, SourceText: "x", TargetText: "這是一個繁體中文的測試段落"}}},
		{"inactive/ja", "ja", []CheckInput{{Index: 0, SourceText: "x", TargetText: "這是一個繁體中文的測試段落"}}},
		{"inactive/auto", "auto", []CheckInput{{Index: 0, SourceText: "x", TargetText: "這是一個繁體中文的測試段落"}}},
		{"inactive/empty", "", []CheckInput{{Index: 0, SourceText: "x", TargetText: "這是一個繁體中文的測試段落"}}},
		{"inactive/garbage", "not-a-lang!!", []CheckInput{{Index: 0, SourceText: "x", TargetText: "這是一個繁體中文的測試段落"}}},
		{"empty-target", "zh-Hans", []CheckInput{
			{Index: 0, SourceText: "x", TargetText: ""},
			{Index: 1, SourceText: "x", TargetText: "   \n\t "},
		}},
		{"protected-region", "zh-Hans", []CheckInput{{Index: 0,
			SourceText: "中間試験の結果",
			TargetText: `<a href="p-006.xhtml">這裡是繁體內容</a>`,
			Protected:  map[string]string{"__LF_000001__": `<a href="p-006.xhtml">這裡是繁體內容</a>`}}}},
		{"outside-protected", "zh-Hans", []CheckInput{{Index: 0,
			SourceText: "x", TargetText: `<a href="p-006.xhtml">期中考试结果</a>這裡`,
			Protected: map[string]string{"__LF_000001__": `<a href="p-006.xhtml">期中考试结果</a>`}}}},
		{"sample-across-protected", "zh-Hans", []CheckInput{{Index: 0,
			SourceText: "x", TargetText: "這<b></b>裡",
			Protected: map[string]string{"__LF_000001__": "<b></b>"}}}},
		{"amphibious/zh-hant", "zh-Hant", []CheckInput{{Index: 0, SourceText: "x", TargetText: "台灣批准游泳的長征路線"}}},
	}
	for _, tc := range scriptCases {
		args := checkerArgs(tc.segments, "targetLang", tc.targetLang)
		appendCheckerCase(t, &cases, "qa/script-mismatch/"+tc.id, "qa.script_mismatch", args,
			NewScriptMismatchChecker(tc.targetLang), tc.segments)
	}

	// ================= number_mismatch =================
	numberCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"equal-normalized", []CheckInput{{Index: 0, SourceText: "price is 1,234.5", TargetText: "价格为 1234.5"}}},
		{"thousand-dot", []CheckInput{{Index: 0, SourceText: "1.234.567", TargetText: "1234567"}}},
		{"missing", []CheckInput{{Index: 0, SourceText: "version 2.0 and 3", TargetText: "版本 2.0"}}},
		{"no-numbers", []CheckInput{{Index: 0, SourceText: "hello", TargetText: "你好"}}},
		{"fullwidth-digit", []CheckInput{{Index: 0, SourceText: "レベル６の魔法", TargetText: "等级6的魔法"}}},
		{"fullwidth-decimal", []CheckInput{{Index: 0, SourceText: "距離は１２．５キロ", TargetText: "距离 12.5 公里"}}},
		{"duplicate-count-diff", []CheckInput{{Index: 0, SourceText: "5 and 5", TargetText: "5"}}},
	}
	for _, tc := range numberCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/number-mismatch/"+tc.id, "qa.number_mismatch", args,
			NewNumberMismatchChecker(), tc.segments)
	}

	for _, tt := range []struct{ id, in string }{
		{"plain", "1234"},
		{"thousand-comma", "1,234"},
		{"thousand-dot", "1.234.567"},
		{"decimal-comma", "1,234.56"},
		{"decimal-comma-eu", "1.234,56"},
		{"single-sep-two-digits", "12,34"},
		{"trailing-sep", "12."},
	} {
		cases = append(cases, goldenv.Case{
			ID:     "qa/normalize-number-token/" + tt.id,
			Op:     "qa.normalize_number_token",
			Args:   goldenv.Args("raw", tt.in),
			Expect: goldenv.Expect("value", normalizeNumberToken(tt.in)),
		})
	}

	for _, tt := range []struct{ id, in string }{
		{"level", "レベル６"},
		{"decimal", "１２．５"},
		{"comma", "１，２３４"},
		{"plain", "abc"},
	} {
		cases = append(cases, goldenv.Case{
			ID:     "qa/normalize-number-width/" + tt.id,
			Op:     "qa.normalize_number_width",
			Args:   goldenv.Args("text", tt.in),
			Expect: goldenv.Expect("value", normalizeNumberWidth(tt.in)),
		})
	}

	// ================= url_email =================
	urlCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"match", []CheckInput{{Index: 0,
			SourceText: "see https://Example.COM/a and a@b.com",
			TargetText: "见 https://example.com/a 与 a@b.com"}}},
		{"mismatch", []CheckInput{{Index: 0, SourceText: "https://a.com", TargetText: "https://b.com"}}},
		{"no-links", []CheckInput{{Index: 0, SourceText: "hello", TargetText: "你好"}}},
		{"trailing-punctuation", []CheckInput{{Index: 0,
			SourceText: "Go to https://example.com/a. Thanks", TargetText: "访问 https://example.com/a。谢谢"}}},
		{"email-case", []CheckInput{{Index: 0, SourceText: "Mail A@B.COM now", TargetText: "邮件 a@b.com 现在"}}},
		{"duplicate-url", []CheckInput{{Index: 0,
			SourceText: "https://a.com https://a.com", TargetText: "https://a.com"}}},
		{"ftp-url", []CheckInput{{Index: 0, SourceText: "ftp://x.example/y", TargetText: "ftp://x.example/y"}}},
	}
	for _, tc := range urlCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/url-email/"+tc.id, "qa.url_email", args,
			NewURLEmailMismatchChecker(), tc.segments)
	}

	// ================= subtitle_line_count =================
	subtitleCases := []struct {
		id       string
		format   string
		segments []CheckInput
	}{
		{"srt-mismatch", "srt", []CheckInput{{Index: 0, SourceText: "line1\nline2", TargetText: "only one"}}},
		{"vtt-match", "vtt", []CheckInput{{Index: 0, SourceText: "a\nb", TargetText: "x\ny"}}},
		{"txt-disabled", "txt", []CheckInput{{Index: 0, SourceText: "a\nb", TargetText: "x"}}},
		{"ass-enabled", "ass", []CheckInput{{Index: 0, SourceText: "a\nb", TargetText: "x"}}},
		{"crlf-normalized", "srt", []CheckInput{{Index: 0, SourceText: "a\r\nb", TargetText: "x\ny"}}},
		{"trailing-newline", "srt", []CheckInput{{Index: 0, SourceText: "a\n", TargetText: "x"}}},
		{"empty-skipped", "srt", []CheckInput{{Index: 0, SourceText: "  ", TargetText: "x"}}},
	}
	for _, tc := range subtitleCases {
		args := checkerArgs(tc.segments, "format", tc.format)
		appendCheckerCase(t, &cases, "qa/subtitle-line-count/"+tc.id, "qa.subtitle_line_count", args,
			NewSubtitleLineCountChecker(tc.format), tc.segments)
	}

	// ================= forbidden_term =================
	forbiddenCases := []struct {
		id       string
		entries  []goldenGlossaryEntry
		srcLang  string
		tgtLang  string
		segments []CheckInput
	}{
		{"hit", []goldenGlossaryEntry{{Source: "Foo", Target: "禁译", Forbidden: true}},
			"en", "zh", []CheckInput{{Index: 0, SourceText: "use Foo carefully", TargetText: "请使用禁译"}}},
		{"nil-glossary", nil, "en", "zh", []CheckInput{{Index: 0, SourceText: "a", TargetText: "b"}}},
		{"independent-latin-source", []goldenGlossaryEntry{{Source: "AI", Target: "人工智能", Forbidden: true}},
			"en", "zh", []CheckInput{{Index: 0, SourceText: "Please wait", TargetText: "等待人工智能结果"}}},
		{"empty-target-skipped", []goldenGlossaryEntry{{Source: "Foo", Target: "", Forbidden: true}},
			"en", "zh", []CheckInput{{Index: 0, SourceText: "use Foo", TargetText: "使用"}}},
		{"cjk-case-insensitive", []goldenGlossaryEntry{{Source: "测试", Target: "ban", Forbidden: true}},
			"zh", "en", []CheckInput{{Index: 0, SourceText: "这是测试", TargetText: "this is BAN"}}},
		{"case-sensitive-miss", []goldenGlossaryEntry{{Source: "Foo", Target: "禁", Forbidden: true, CaseSensitive: true}},
			"en", "zh", []CheckInput{{Index: 0, SourceText: "use foo", TargetText: "使用禁"}}},
	}
	for _, tc := range forbiddenCases {
		var gls *glossary.FileGlossary
		if tc.entries != nil {
			gls = newGoldenGlossary(t, tc.entries)
		}
		var g glossary.Glossary
		if gls != nil {
			g = gls
		}
		args := checkerArgs(tc.segments, "srcLang", tc.srcLang, "tgtLang", tc.tgtLang, "glossary", tc.entries)
		appendCheckerCase(t, &cases, "qa/forbidden-term/"+tc.id, "qa.forbidden_term", args,
			NewForbiddenTermChecker(g, tc.srcLang, tc.tgtLang), tc.segments)
	}

	// ================= term_inconsistency =================
	termCases := []struct {
		id       string
		entries  []goldenGlossaryEntry
		srcLang  string
		tgtLang  string
		segments []CheckInput
	}{
		{"mandatory-error", []goldenGlossaryEntry{{Source: "API", Target: "接口", Mandatory: true, CaseSensitive: true}},
			"en", "zh", []CheckInput{{Index: 0, SourceText: "call the API now", TargetText: "调用端点"}}},
		{"soft-warning", []goldenGlossaryEntry{{Source: "pipeline", Target: "流水线", Mandatory: false}},
			"en", "zh", []CheckInput{{Index: 0, SourceText: "build pipeline", TargetText: "构建管道"}}},
		{"consistent", []goldenGlossaryEntry{{Source: "API", Target: "接口", Mandatory: true, CaseSensitive: true}},
			"en", "zh", []CheckInput{{Index: 0, SourceText: "call the API", TargetText: "调用接口"}}},
		{"forbidden-skipped", []goldenGlossaryEntry{{Source: "Foo", Target: "禁", Forbidden: true}},
			"en", "zh", []CheckInput{{Index: 0, SourceText: "Foo", TargetText: "其他"}}},
		{"nil-glossary", nil, "en", "zh", []CheckInput{{Index: 0, SourceText: "API", TargetText: "端点"}}},
		{"cjk-source", []goldenGlossaryEntry{{Source: "你好", Target: "hello", Mandatory: true}},
			"zh", "en", []CheckInput{{Index: 0, SourceText: "你好世界", TargetText: "hi world"}}},
	}
	for _, tc := range termCases {
		var gls *glossary.FileGlossary
		if tc.entries != nil {
			gls = newGoldenGlossary(t, tc.entries)
		}
		var g glossary.Glossary
		if gls != nil {
			g = gls
		}
		args := checkerArgs(tc.segments, "srcLang", tc.srcLang, "tgtLang", tc.tgtLang, "glossary", tc.entries)
		appendCheckerCase(t, &cases, "qa/term-inconsistency/"+tc.id, "qa.term_inconsistency", args,
			NewTermInconsistencyChecker(g, tc.srcLang, tc.tgtLang), tc.segments)
	}

	for _, tt := range []struct {
		id            string
		haystack      string
		needle        string
		caseSensitive bool
		lang          string
	}{
		{"substring-ai", "wait and rain", "ai", true, "en"},
		{"independent-ai", "use AI carefully", "AI", true, "en"},
		{"cjk-contains", "你好世界", "你好", true, "zh"},
		{"case-insensitive-latin", "Use the API now", "api", false, "en"},
		{"case-insensitive-miss", "Use the APIs now", "api", false, "en"},
		{"empty-needle", "abc", "", true, "en"},
		{"empty-haystack", "", "a", true, "en"},
		{"latin-boundary-underscore", "foo_api", "api", true, "en"},
	} {
		got := termPresent(tt.haystack, tt.needle, tt.caseSensitive, tt.lang)
		cases = append(cases, goldenv.Case{
			ID:   "qa/term-present/" + tt.id,
			Op:   "qa.term_present",
			Args: goldenv.Args("haystack", tt.haystack, "needle", tt.needle, "caseSensitive", tt.caseSensitive, "lang", tt.lang),
			Expect: goldenv.Expect(
				"present", got,
			),
		})
	}

	// ================= leftover_placeholder =================
	leftoverCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"hit", []CheckInput{{Index: 0, SourceText: "a", TargetText: "see __LF_000001__ here"}}},
		{"clean", []CheckInput{{Index: 0, SourceText: "a", TargetText: "no placeholders"}}},
		{"dedup-same-key", []CheckInput{{Index: 0, SourceText: "a", TargetText: "__LF_PH_0__ and __LF_PH_0__"}}},
		{"multiple-keys", []CheckInput{{Index: 0, SourceText: "a", TargetText: "__LF_000001__ and __LF_000002__"}}},
		{"no-token-prefix", []CheckInput{{Index: 0, SourceText: "a", TargetText: "__LF_ only"}}},
	}
	for _, tc := range leftoverCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/leftover-placeholder/"+tc.id, "qa.leftover_placeholder", args,
			NewLeftoverPlaceholderChecker(), tc.segments)
	}

	// ================= xml_tag_mismatch =================
	xmlCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"mismatch", []CheckInput{{Index: 0, SourceText: `<b>hi</b>`, TargetText: `<i>hi</i>`}}},
		{"match", []CheckInput{{Index: 0, SourceText: `<span class="x">a</span>`, TargetText: `<span class="x">甲</span>`}}},
		{"source-no-tags", []CheckInput{{Index: 0, SourceText: `plain text`, TargetText: `<b>plain</b>`}}},
		{"ruby-filtered", []CheckInput{{Index: 0, SourceText: `<ruby>友里花<rt>ゆりか</rt></ruby>。`, TargetText: `友里花。`}}},
		{"ruby-preserved", []CheckInput{{Index: 0, SourceText: `<ruby>呪<rt>じゅ</rt></ruby>`, TargetText: `<ruby>呪<rt>じゅ</rt></ruby>`}}},
		{"ruby-not-masking", []CheckInput{{Index: 0, SourceText: `<b><ruby>x<rt>y</rt></ruby></b>`, TargetText: `<i>x</i>`}}},
		{"broken-ruby-structure", []CheckInput{{Index: 0,
			SourceText: `「レベル６：<ruby>劣化雷神皇<rt>レツサーエフタル</rt></ruby>っ！」`,
			TargetText: `「等级６：<ruby>劣化雷神皇<rt>雷瑟</rt>！」`}}},
		{"ruby-removal-plain", []CheckInput{{Index: 0,
			SourceText: `<ruby>友里花<rt>ゆりか</rt></ruby>が現れた。`, TargetText: `友里花出现了。`}}},
		{"invalid-source-skipped", []CheckInput{{Index: 0,
			SourceText: `予兆は & <ruby>未知<rt>みち</rt></ruby> のまま`, TargetText: `预兆仍是 & 未知`}}},
		{"pseudo-tags", []CheckInput{{Index: 0, SourceText: `普通台词`, TargetText: `<color=red>红色台词`}}},
		{"structural-precedes-multiset", []CheckInput{{Index: 0,
			SourceText: `<b>加粗</b><ruby>漢字<rt>かんじ</rt></ruby>`, TargetText: `<i>加粗<rt>かんじ`}}},
	}
	for _, tc := range xmlCases {
		args := checkerArgs(tc.segments)
		appendCheckerCase(t, &cases, "qa/xml-tag-mismatch/"+tc.id, "qa.xml_tag_mismatch", args,
			NewXMLTagMismatchChecker(), tc.segments)
	}

	// ================= 文档级：同文异译 =================
	docCases := []struct {
		id       string
		segments []CheckInput
	}{
		{"hit", []CheckInput{
			{Index: 0, SourceText: "  Hello   World  ", TargetText: "你好世界"},
			{Index: 1, SourceText: "Hello World", TargetText: "哈罗世界"},
			{Index: 2, SourceText: "Hello World", TargetText: "你好世界"},
		}},
		{"consistent", []CheckInput{
			{Index: 0, SourceText: "A", TargetText: "甲"},
			{Index: 1, SourceText: "A", TargetText: "甲"},
		}},
		{"unique-sources", []CheckInput{
			{Index: 0, SourceText: "A", TargetText: "甲"},
			{Index: 1, SourceText: "B", TargetText: "乙"},
		}},
		{"empty-skipped", []CheckInput{
			{Index: 0, SourceText: "", TargetText: "甲"},
			{Index: 1, SourceText: "B", TargetText: ""},
		}},
	}
	for _, tc := range docCases {
		issues := CheckDuplicateSourceDivergence(tc.segments)
		cases = append(cases, goldenv.Case{
			ID:     "qa/duplicate-source-divergence/" + tc.id,
			Op:     "qa.duplicate_source_divergence",
			Args:   goldenv.Args("segments", goldenSegments(tc.segments)),
			Expect: goldenv.Expect("issues", normalizeIssues(t, issues)),
		})
	}

	for _, tt := range []struct {
		id     string
		checks []string
	}{
		{"nil-checks", nil},
		{"contains", []string{CheckUntranslated, CodeDuplicateSourceDivergence}},
		{"not-contains", []string{CheckUntranslated}},
		{"empty-list", []string{}},
	} {
		cases = append(cases, goldenv.Case{
			ID:     "qa/duplicate-source-divergence-enabled/" + tt.id,
			Op:     "qa.duplicate_source_divergence_enabled",
			Args:   goldenv.Args("checks", tt.checks),
			Expect: goldenv.Expect("enabled", DuplicateSourceDivergenceEnabled(tt.checks)),
		})
	}

	// ================= 注音守恒 =================
	for _, tt := range []struct {
		id      string
		index   int
		prev    string
		next    string
	}{
		{"multiple-to-none", 7, `<ruby>漢<rt>かん</rt></ruby>字<ruby>語<rt>ご</rt></ruby>`, "汉字"},
		{"prev-none", 0, "纯文本译文", "编辑后的纯文本"},
		{"next-still-has", 3, `<ruby>漢<rt>かん</rt></ruby>`, `<ruby>漢<rt>かん</rt></ruby>改`},
		{"deformed-counts-as-loss", 1, `<ruby>漢<rt>かん</rt></ruby>`, `<RUBY>漢<RT>かん</RT></RUBY>`},
	} {
		issues := RubyTagLossIssues(tt.index, tt.prev, tt.next)
		cases = append(cases, goldenv.Case{
			ID:     "qa/ruby-tag-loss/" + tt.id,
			Op:     "qa.ruby_tag_loss",
			Args:   goldenv.Args("segmentIndex", tt.index, "prev", tt.prev, "next", tt.next),
			Expect: goldenv.Expect("issues", normalizeIssues(t, issues)),
		})
	}

	// ================= Span 定位 =================
	spanCases := []struct {
		id      string
		target  string
		matched string
	}{
		{"basic", "Hello テスト world", "テスト"},
		{"missing", "hello", "テスト"},
		{"empty", "hello", ""},
		{"blank", "hello", "  "},
		{"equalfold-ascii", "ȺX", "x"},
		{"equalfold-fullwidth", "Ⱥ", "ⱥ"},
		{"trimmed", "  abc  ", " abc "},
		{"emoji", "🎉🎉 target 🎉", "target"},
		{"supplementary-han", "\U0002003E\U0002003E x", "x"},
		{"after-emoji", "😀😀hello", "hello"},
		{"cjk", "这是测试,裡面有一个繁体字", "裡"},
		{"at-start", "abc def", "abc"},
		{"at-end", "abc def", "def"},
		{"cjk-mixed", "你好,裡面", "裡"},
		{"not-found-after-emoji", "🎉abc", "zzz"},
	}
	for _, tc := range spanCases {
		span := LocateSpan(tc.target, tc.matched)
		var matchedTextValue any
		var start, end any
		if span != nil {
			matchedTextValue = span.MatchedText
			if span.TargetStart != nil {
				start = *span.TargetStart
			}
			if span.TargetEnd != nil {
				end = *span.TargetEnd
			}
		}
		cases = append(cases, goldenv.Case{
			ID:     "qa/locate-span/" + tc.id,
			Op:     "qa.locate_span",
			Args:   goldenv.Args("target", tc.target, "matched", tc.matched),
			Expect: goldenv.Expect("matched", matchedTextValue, "start", start, "end", end),
		})
	}

	// ================= 保护区 =================
	regionCases := []struct {
		id        string
		target    string
		protected map[string]string
	}{
		{"single", `hello <a href="x">world</a> end`, map[string]string{"tag": `<a href="x">world</a>`}},
		{"multiple", `a <b>c</b> d <e>f</e> g`, map[string]string{"b": `<b>c</b>`, "e": `<e>f</e>`}},
		{"not-found", `hello world`, map[string]string{"x": "zzz"}},
		{"adjacent", `<a>x</a><b>y</b>`, map[string]string{"a": `<a>x</a>`, "b": `<b>y</b>`}},
		{"empty-nil", "abc", nil},
		{"empty-map", "abc", map[string]string{}},
		{"empty-target", "", map[string]string{"a": "x"}},
		{"empty-value", "a <x> b", map[string]string{"a": "", "b": "<x>"}},
		{"overlap", `abcXYZdef`, map[string]string{"long": "bcXYZde", "short": "XYZ"}},
		{"cjk", `你好<a>x</a>世界`, map[string]string{"tag": `<a>x</a>`}},
		{"duplicate-value", `第一行<br/>第二行<br/>`, map[string]string{"__LF_000001__": "<br/>", "__LF_000002__": "<br/>"}},
		{"duplicate-adjacent", `A<br/><br/>B`, map[string]string{"__LF_000001__": "<br/>", "__LF_000002__": "<br/>"}},
		{"repeated-value", `x.y.z.y.`, map[string]string{"p": "."}},
		{"prefix-overlap", `x ab y abcd z`, map[string]string{"short": "ab", "long": "abcd"}},
		{"same-start-prefix", `<br/>`, map[string]string{"a": "<br>", "b": "<br/>"}},
		{"empty-value-skipped", "x y z", map[string]string{"a": "", "b": "x"}},
	}
	for _, tc := range regionCases {
		regions := ProtectedRegions(tc.target, tc.protected)
		var regionsArg any
		if regions != nil {
			regionsArg = regions
		}
		var strippedFromRegions string
		if regions == nil {
			strippedFromRegions = tc.target
		} else {
			strippedFromRegions = StripRegions(tc.target, regions)
		}
		cases = append(cases, goldenv.Case{
			ID:   "qa/protected-regions/" + tc.id,
			Op:   "qa.protected_regions",
			Args: goldenv.Args("target", tc.target, "protected", tc.protected),
			Expect: goldenv.Expect(
				"regions", regionsArg,
				"stripped", strippedFromRegions,
			),
		})
	}

	// strip_regions 独立用例（含 region 为空与首尾边界）
	stripCases := []struct {
		id      string
		target  string
		regions [][2]int
	}{
		{"single", `hello <a href="x">world</a> end`, [][2]int{{6, 27}}},
		{"multiple", `a <b>c</b> d <e>f</e> g`, [][2]int{{2, 10}, {13, 21}}},
		{"nil", `hello world`, nil},
		{"empty", `hello world`, [][2]int{}},
		{"start", `<a>x</a>hello`, [][2]int{{0, 8}}},
		{"end", `hello<a>x</a>`, [][2]int{{5, 13}}},
		{"all", `<a>x</a>`, [][2]int{{0, 8}}},
		{"cjk", `你好<a>x</a>世界`, [][2]int{{2, 10}}},
	}
	for _, tc := range stripCases {
		cases = append(cases, goldenv.Case{
			ID:     "qa/strip-regions/" + tc.id,
			Op:     "qa.strip_regions",
			Args:   goldenv.Args("target", tc.target, "regions", tc.regions),
			Expect: goldenv.Expect("text", StripRegions(tc.target, tc.regions)),
		})
	}

	// inline_markup_regions
	inlineCases := []struct {
		id        string
		target    string
		protected map[string]string
	}{
		{"no-ruby", `hello <a href="x">world</a> end`, map[string]string{"tag": `<a href="x">world</a>`}},
		{"pure-ruby", "<ruby>呪<rt>じゅ</rt></ruby>", nil},
		{"multi-rt-ruby", "<ruby>何<rt>な</rt>故<rt>ぜ</rt></ruby>", nil},
		{"ruby-and-protected", `a<b>x</b>` + "<ruby>呪<rt>じゅ</rt></ruby>", map[string]string{"p": `a<b>x</b>`}},
		{"empty", "", nil},
		{"plain", "abc", nil},
		{"cjk-ruby", "見<ruby>呪<rt>じゅ</rt></ruby>術", nil},
		{"protected-around-ruby", `<a>1</a><ruby>呪<rt>じゅ</rt></ruby><a>1</a>`, map[string]string{"p": `<a>1</a>`}},
		{"generic-tag", `<a href="x">連</a>`, nil},
	}
	for _, tc := range inlineCases {
		regions := InlineMarkupRegions(tc.target, tc.protected)
		var regionsArg any
		if regions != nil {
			regionsArg = regions
		}
		stripped := StripRegions(tc.target, regions)
		cases = append(cases, goldenv.Case{
			ID:   "qa/inline-markup-regions/" + tc.id,
			Op:   "qa.inline_markup_regions",
			Args: goldenv.Args("target", tc.target, "protected", tc.protected),
			Expect: goldenv.Expect(
				"regions", regionsArg,
				"stripped", stripped,
			),
		})
	}

	// locate_span_excluding_regions
	locateExclCases := []struct {
		id      string
		target  string
		matched string
		regions [][2]int
	}{
		{"outside-protected", `<a,x>你好,`, ",", [][2]int{{0, 5}}},
		{"all-inside-fallback", `<a,x>`, ",", [][2]int{{0, 5}}},
		{"no-regions", "hello,world", ",", nil},
		{"empty-matched", "hello", "  ", nil},
	}
	for _, tc := range locateExclCases {
		span := LocateSpanExcludingRegions(tc.target, tc.matched, tc.regions)
		var matchedTextValue, start, end any
		if span != nil {
			matchedTextValue = span.MatchedText
			if span.TargetStart != nil {
				start = *span.TargetStart
			}
			if span.TargetEnd != nil {
				end = *span.TargetEnd
			}
		}
		cases = append(cases, goldenv.Case{
			ID:     "qa/locate-span-excluding-regions/" + tc.id,
			Op:     "qa.locate_span_excluding_regions",
			Args:   goldenv.Args("target", tc.target, "matched", tc.matched, "regions", tc.regions),
			Expect: goldenv.Expect("matched", matchedTextValue, "start", start, "end", end),
		})
	}

	// ================= 指纹 / 去重 / 裁决对账 =================
	fingerprintCases := []struct {
		id      string
		issue   wireIssue
	}{
		{"nil-span", wireIssue{Code: "length_ratio"}},
		{"empty-matched", wireIssue{Code: "calque", Span: &wireSpan{MatchedText: ""}}},
		{"with-span", wireIssue{Code: "source_residual", Span: &wireSpan{MatchedText: "テスト"}}},
	}
	for _, tc := range fingerprintCases {
		iss := decodeIssues(t, []wireIssue{tc.issue})
		var got string
		if len(iss) == 1 {
			got = Fingerprint(iss[0])
		}
		cases = append(cases, goldenv.Case{
			ID:     "qa/fingerprint/" + tc.id,
			Op:     "qa.fingerprint",
			Args:   goldenv.Args("issue", tc.issue),
			Expect: goldenv.Expect("value", got),
		})
	}

	{
		dedupWires := []wireIssue{
			{Code: "calque", Message: "a", Span: &wireSpan{MatchedText: "foo"}},
			{Code: "calque", Message: "b", Span: &wireSpan{MatchedText: "foo"}},
			{Code: "calque", Message: "c", Span: &wireSpan{MatchedText: "bar"}},
			{Code: "naturalness", Message: "d"},
			{Code: "naturalness", Message: "e"},
		}
		cases = append(cases, goldenv.Case{
			ID:     "qa/dedup-issues/basic",
			Op:     "qa.dedup_issues",
			Args:   goldenv.Args("issues", dedupWires),
			Expect: goldenv.Expect("issues", normalizeIssues(t, DedupIssues(decodeIssues(t, dedupWires)))),
		})
	}

	// reconcile
	reconcileCases := []struct {
		id       string
		fresh    []wireIssue
		existing []wireIssue
	}{
		{
			"empty-existing",
			[]wireIssue{{
				SegmentIndex: 0, Severity: SeverityError, Code: "untranslated", Message: "found untranslated text",
				Span: &wireSpan{MatchedText: "Hello", TargetStart: intPtr(10), TargetEnd: intPtr(15)},
				Disposition: DispositionDismissed, DecidedBy: intPtr(7),
				DecidedAt: strPtr("2026-09-29T12:30:05+08:00"), Note: "predefined note",
			}},
			nil,
		},
		{
			"same-fingerprint-inherits",
			[]wireIssue{{SegmentIndex: 2, Severity: SeverityError, Code: "calque", Message: "新的 message",
				Span: &wireSpan{MatchedText: "foo", TargetStart: intPtr(3), TargetEnd: intPtr(6)}}},
			[]wireIssue{{Code: "calque", Span: &wireSpan{MatchedText: "foo"},
				Disposition: DispositionDismissed, DecidedBy: intPtr(42),
				DecidedAt: strPtr("2026-09-29T12:30:05.123456789+08:00"), Note: "人工确认非问题"}},
		},
		{
			"disappeared-cleared",
			[]wireIssue{{Code: "untranslated", Span: &wireSpan{MatchedText: "Hello"}}},
			[]wireIssue{{Code: "length_ratio", Span: &wireSpan{MatchedText: "很长很长"},
				Disposition: DispositionDismissed, DecidedBy: intPtr(7),
				DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "已裁决"}},
		},
		{
			"new-fingerprint-pending",
			[]wireIssue{{Code: "omission", Severity: SeverityWarning, Span: &wireSpan{MatchedText: "y"}}},
			[]wireIssue{{Code: "duplicate", Span: &wireSpan{MatchedText: "x"},
				Disposition: DispositionDismissed, DecidedBy: intPtr(9),
				DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "n"}},
		},
		{
			"multiple-instances-same-code",
			[]wireIssue{
				{Code: "calque", Severity: SeverityWarning, Message: "foo 新消息", Span: &wireSpan{MatchedText: "foo"}},
				{Code: "calque", Severity: SeverityError, Message: "bar 新消息", Span: &wireSpan{MatchedText: "bar"}},
			},
			[]wireIssue{
				{Code: "calque", Span: &wireSpan{MatchedText: "foo"}, Disposition: DispositionDismissed,
					DecidedBy: intPtr(1), DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "foo 备注"},
				{Code: "calque", Span: &wireSpan{MatchedText: "bar"}, Disposition: DispositionDismissed,
					DecidedBy: intPtr(2), DecidedAt: strPtr("2026-09-29T05:30:05Z"), Note: "bar 备注"},
			},
		},
		{
			"pending-not-inherited",
			[]wireIssue{
				{Code: "grammar", Message: "a 新消息", Span: &wireSpan{MatchedText: "a"}},
				{Code: "grammar", Message: "b 新消息", Span: &wireSpan{MatchedText: "b"}},
			},
			[]wireIssue{
				{Code: "grammar", Span: &wireSpan{MatchedText: "a"}, Disposition: DispositionPending},
				{Code: "grammar", Span: &wireSpan{MatchedText: "b"}, Disposition: DispositionDismissed,
					DecidedBy: intPtr(5), DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "b 备注"},
			},
		},
		{
			"nil-span-inherits",
			[]wireIssue{{Code: "addition", Severity: SeverityError, Message: "新增内容"}},
			[]wireIssue{{Code: "addition", Disposition: DispositionDismissed, DecidedBy: intPtr(3),
				DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "无跨度裁决"}},
		},
		{
			"empty-matched-span-inherits",
			[]wireIssue{{Code: "omission", Span: &wireSpan{MatchedText: ""}, Message: "缺漏"}},
			[]wireIssue{{Code: "omission", Span: &wireSpan{MatchedText: ""}, Disposition: DispositionDismissed,
				DecidedBy: intPtr(4), DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "空文本裁决"}},
		},
		{
			"empty-existing-list",
			[]wireIssue{{Code: "untranslated", Span: &wireSpan{MatchedText: "Hi"}}},
			[]wireIssue{},
		},
		{
			"existing-pending-kept-fresh",
			[]wireIssue{{Code: "grammar", Span: &wireSpan{MatchedText: "a"}, Message: "新消息"}},
			[]wireIssue{{Code: "grammar", Span: &wireSpan{MatchedText: "a"}, Disposition: DispositionPending}},
		},
	}
	for _, tc := range reconcileCases {
		got := ReconcileIssues(decodeIssues(t, tc.fresh), decodeIssues(t, tc.existing))
		cases = append(cases, goldenv.Case{
			ID:     "qa/reconcile/" + tc.id,
			Op:     "qa.reconcile",
			Args:   goldenv.Args("fresh", tc.fresh, "existing", tc.existing),
			Expect: goldenv.Expect("issues", normalizeIssues(t, got)),
		})
	}

	// filter_out_pending
	{
		dropCases := []struct {
			id     string
			issues []wireIssue
			drop   []string
		}{
			{"drops-pending-hit", []wireIssue{
				{Code: CheckUntranslated, Span: &wireSpan{MatchedText: "Hi"}},
				{Code: CheckUntranslated},
			}, []string{CheckUntranslated}},
			{"keeps-dismissed-hit", []wireIssue{
				{Code: CheckUntranslated, Span: &wireSpan{MatchedText: "Hi"},
					Disposition: DispositionDismissed, DecidedBy: intPtr(7),
					DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "人工确认非问题"},
			}, []string{CheckUntranslated}},
			{"keeps-untargeted", []wireIssue{
				{Code: CheckWidthMix, Span: &wireSpan{MatchedText: "Ｘ"}},
				{Code: IssueCodeGrammar, Span: &wireSpan{MatchedText: "语法"}},
			}, []string{CheckUntranslated}},
			{"empty-drop-keeps-all", []wireIssue{
				{Code: CheckUntranslated},
				{Code: IssueCodeMistranslation, Disposition: DispositionDismissed},
			}, []string{}},
		}
		for _, tc := range dropCases {
			got := FilterOutPendingByCodes(decodeIssues(t, tc.issues), sliceToSet(tc.drop))
			cases = append(cases, goldenv.Case{
				ID:     "qa/filter-out-pending/" + tc.id,
				Op:     "qa.filter_out_pending",
				Args:   goldenv.Args("issues", tc.issues, "drop", tc.drop),
				Expect: goldenv.Expect("issues", normalizeIssues(t, got)),
			})
		}
	}

	// revise_final_issues
	reviseCases := []struct {
		id       string
		existing []wireIssue
		fresh    []wireIssue
		targeted []string
		qaRan    bool
	}{
		{
			"not-ran-keeps-non-targets",
			[]wireIssue{
				{Code: CheckUntranslated, Span: &wireSpan{MatchedText: "Hi"}},
				{Code: IssueCodeMistranslation, Span: &wireSpan{MatchedText: "错译"}},
				{Code: CheckWidthMix, Span: &wireSpan{MatchedText: "Ｘ"}},
				{Code: IssueCodeGrammar, Span: &wireSpan{MatchedText: "语法"}},
				{Code: CheckUntranslated, Span: &wireSpan{MatchedText: "Yo"}, Disposition: DispositionDismissed},
			},
			[]wireIssue{{Code: CheckDuplicate}},
			[]string{CheckUntranslated, IssueCodeMistranslation},
			false,
		},
		{
			"ran-recomputes-deterministic",
			[]wireIssue{
				{Code: CheckUntranslated, Span: &wireSpan{MatchedText: "Hello"},
					Disposition: DispositionDismissed, DecidedBy: intPtr(42),
					DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "人工确认非问题"},
				{Code: CheckWidthMix, Span: &wireSpan{MatchedText: "Ｘ"}},
				{Code: IssueCodeGrammar, Span: &wireSpan{MatchedText: "语法"}},
				{Code: IssueCodeMistranslation, Span: &wireSpan{MatchedText: "错译"}},
			},
			[]wireIssue{
				{SegmentIndex: 3, Severity: SeverityError, Code: CheckUntranslated,
					Message: "found untranslated text",
					Span:    &wireSpan{MatchedText: "Hello", TargetStart: intPtr(0), TargetEnd: intPtr(5)}},
				{Code: CheckSourceResidual, Span: &wireSpan{MatchedText: "residual"}},
			},
			[]string{IssueCodeMistranslation},
			true,
		},
		{
			"ran-empty-fresh-keeps-semantic",
			[]wireIssue{
				{Code: IssueCodeNaturalness, Span: &wireSpan{MatchedText: "n1"}},
				{Code: IssueCodeCalque, Span: &wireSpan{MatchedText: "c1"}, Disposition: DispositionDismissed},
			},
			nil,
			[]string{IssueCodeMistranslation},
			true,
		},
	}
	for _, tc := range reviseCases {
		got := ReviseFinalIssues(decodeIssues(t, tc.existing), decodeIssues(t, tc.fresh), tc.targeted, tc.qaRan)
		cases = append(cases, goldenv.Case{
			ID:     "qa/revise-final-issues/" + tc.id,
			Op:     "qa.revise_final_issues",
			Args:   goldenv.Args("existing", tc.existing, "fresh", tc.fresh, "targeted", tc.targeted, "qaRan", tc.qaRan),
			Expect: goldenv.Expect("issues", normalizeIssues(t, got)),
		})
	}

	// recheck_final_issues
	recheckCases := []struct {
		id       string
		fresh    []wireIssue
		existing []wireIssue
	}{
		{
			"inherits-dismissal",
			[]wireIssue{{SegmentIndex: 2, Severity: SeverityWarning, Code: CheckWidthMix,
				Message: "全半角混用", Span: &wireSpan{MatchedText: "Ｘ"}}},
			[]wireIssue{{Code: CheckWidthMix, Span: &wireSpan{MatchedText: "Ｘ"},
				Disposition: DispositionDismissed, DecidedBy: intPtr(7),
				DecidedAt: strPtr("2026-09-29T04:30:05Z"), Note: "人工确认非问题"}},
		},
		{
			"keeps-semantic-and-conservation",
			nil,
			[]wireIssue{
				{Code: IssueCodeCalque, Span: &wireSpan{MatchedText: "c1"}},
				{Code: IssueCodeGrammar, Span: &wireSpan{MatchedText: "g1"}, Disposition: DispositionDismissed},
				{Code: CodeRubyTagLoss, Span: &wireSpan{MatchedText: "r1"}},
				{Code: CodeRubyRestoreIncomplete, Span: &wireSpan{MatchedText: "r2"}},
				{Code: CheckSourceResidual, Span: &wireSpan{MatchedText: "s1"}},
			},
		},
		{
			"drops-vanished-deterministic",
			[]wireIssue{{Code: CheckSourceResidual, Span: &wireSpan{MatchedText: "residual"}}},
			[]wireIssue{{Code: CheckUntranslated, Span: &wireSpan{MatchedText: "Hi"}}},
		},
		{"both-empty", nil, nil},
		{
			"new-fingerprint-pending",
			[]wireIssue{{Code: CheckUntranslated, Span: &wireSpan{MatchedText: "Hi"}}},
			[]wireIssue{{Code: CheckWidthMix, Span: &wireSpan{MatchedText: "Ｘ"}}},
		},
	}
	for _, tc := range recheckCases {
		got := RecheckFinalIssues(decodeIssues(t, tc.fresh), decodeIssues(t, tc.existing))
		cases = append(cases, goldenv.Case{
			ID:     "qa/recheck-final-issues/" + tc.id,
			Op:     "qa.recheck_final_issues",
			Args:   goldenv.Args("fresh", tc.fresh, "existing", tc.existing),
			Expect: goldenv.Expect("issues", normalizeIssues(t, got)),
		})
	}

	// has_errors / issues_for
	{
		withError := []wireIssue{
			{Severity: SeverityWarning, Code: "length_ratio"},
			{Severity: SeverityError, Code: "untranslated"},
		}
		warnOnly := []wireIssue{{Severity: SeverityWarning, Code: "length_ratio"}}
		for _, tt := range []struct {
			id     string
			issues []wireIssue
		}{
			{"has-error", withError},
			{"warning-only", warnOnly},
			{"empty", nil},
		} {
			cases = append(cases, goldenv.Case{
				ID:     "qa/has-errors/" + tt.id,
				Op:     "qa.has_errors",
				Args:   goldenv.Args("issues", tt.issues),
				Expect: goldenv.Expect("value", HasErrors(decodeIssues(t, tt.issues))),
			})
		}

		issuesFor := []wireIssue{
			{SegmentIndex: 0, Code: "untranslated"},
			{SegmentIndex: 1, Code: "length_ratio"},
			{SegmentIndex: 0, Code: "duplicate"},
		}
		for _, tt := range []struct {
			id    string
			index int
		}{
			{"index-0", 0},
			{"index-1", 1},
			{"index-2", 2},
		} {
			got := IssuesFor(tt.index, decodeIssues(t, issuesFor))
			cases = append(cases, goldenv.Case{
				ID:     "qa/issues-for/" + tt.id,
				Op:     "qa.issues_for",
				Args:   goldenv.Args("segmentIndex", tt.index, "issues", issuesFor),
				Expect: goldenv.Expect("issues", normalizeIssues(t, got)),
			})
		}
	}

	// weighted_len / count_words
	for _, tt := range []struct{ id, text string }{
		{"hello", "Hello"},
		{"cjk", "你好"},
		{"mixed", "Hello你好"},
		{"empty", ""},
		{"emoji", "🎉a"},
	} {
		cases = append(cases, goldenv.Case{
			ID:     "qa/weighted-len/" + tt.id,
			Op:     "qa.weighted_len",
			Args:   goldenv.Args("text", tt.text),
			Expect: goldenv.Expect("value", weightedLen(tt.text)),
		})
	}
	for _, tt := range []struct{ id, text string }{
		{"hello", "Hello"},
		{"two-words", "Hello World"},
		{"cjk", "你好"},
		{"cjk-four", "你好世界"},
		{"mixed", "Hello你好世界"},
		{"empty", ""},
		{"spaces", "   "},
		{"multi-space", " a  b  c "},
	} {
		cases = append(cases, goldenv.Case{
			ID:     "qa/count-words/" + tt.id,
			Op:     "qa.count_words",
			Args:   goldenv.Args("text", tt.text),
			Expect: goldenv.Expect("value", countWords(tt.text)),
		})
	}

	// ================= code 词表 =================
	codeLists := []struct {
		id   string
		list []string
	}{
		{"all-checker-names", AllCheckerNames()},
		{"zero-config", ZeroConfigDeterministicChecks()},
		{"filterable", FilterableIssueCodes()},
		{"semantic", SemanticQACodes()},
		{"adjudicable", AdjudicableCodes()},
		{"default-adjudicable", DefaultAdjudicateCodes()},
		{"document", DocumentCheckerCodes()},
		{"conservation", ConservationCodes()},
	}
	for _, tt := range codeLists {
		list := tt.list
		if list == nil {
			list = []string{}
		}
		cases = append(cases, goldenv.Case{
			ID:     "qa/codes/" + tt.id,
			Op:     "qa.codes",
			Args:   goldenv.Args("name", tt.id),
			Expect: goldenv.Expect("codes", list),
		})
	}

	for _, code := range []string{
		CheckUntranslated, CheckDuplicate, CheckSourceResidual, CheckPunctuationSurplus,
		CheckLengthRatio, IssueCodeCalque, CodeRubyTagLoss, CodeDuplicateSourceDivergence,
		"nonsense", "",
	} {
		cases = append(cases, goldenv.Case{
			ID:     "qa/code-predicates/" + codeID(code),
			Op:     "qa.code_predicates",
			Args:   goldenv.Args("code", code),
			Expect: goldenv.Expect(
				"semantic", IsSemanticQACode(code),
				"adjudicable", IsAdjudicableCode(code),
				"conservation", IsConservationCode(code),
				"filterable", IsFilterableIssueCode(code),
			),
		})
	}

	for _, tt := range []struct {
		id     string
		checks []string
		code   string
	}{
		{"nil-all-open", nil, CheckUntranslated},
		{"listed", []string{CheckUntranslated, CheckNumberMismatch}, CheckNumberMismatch},
		{"not-listed", []string{CheckUntranslated}, CheckNumberMismatch},
		{"empty-list-none", []string{}, CheckUntranslated},
	} {
		cases = append(cases, goldenv.Case{
			ID:     "qa/checker-enabled/" + tt.id,
			Op:     "qa.checker_enabled",
			Args:   goldenv.Args("checks", tt.checks, "code", tt.code),
			Expect: goldenv.Expect("enabled", CheckerEnabled(tt.checks, tt.code)),
		})
	}

	// ================= 引擎 =================
	engineCases := []struct {
		id       string
		cfg      Config
		segments []CheckInput
	}{
		{
			"disabled",
			Config{Enabled: false, LengthRatioMin: 0.2, LengthRatioMax: 3.0},
			[]CheckInput{{Index: 0, SourceText: "Hello", TargetText: ""}},
		},
		{
			"all-checkers-untranslated",
			Config{Enabled: true, LengthRatioMin: 0.2, LengthRatioMax: 3.0},
			[]CheckInput{
				{Index: 0, SourceText: "Hello World", TargetText: "Hello World"},
				{Index: 1, SourceText: "World", TargetText: "世界"},
			},
		},
		{
			"checks-filter",
			Config{Enabled: true, Checks: []string{CheckUntranslated, CheckNumberMismatch}},
			[]CheckInput{
				{Index: 0, SourceText: "Hello 1", TargetText: "Hello 2"},
				{Index: 1, SourceText: "Same", TargetText: "Same"},
			},
		},
		{
			"empty-checks",
			Config{Enabled: true, Checks: []string{}},
			[]CheckInput{{Index: 0, SourceText: "Hello", TargetText: "Hello"}},
		},
		{
			"word-count",
			Config{Enabled: true, Checks: []string{CheckLengthRatio}, LengthRatioMin: 0.3,
				LengthRatioMax: 2.5, LengthMethod: LengthMethodWordCount},
			[]CheckInput{{Index: 0, SourceText: "这是一段很长的句子用于测试", TargetText: "test"}},
		},
	}
	for _, tc := range engineCases {
		e := NewEngine(tc.cfg, nil)
		issues := e.Run(context.Background(), tc.segments)
		names := make([]string, 0, len(e.checkers))
		for _, c := range e.checkers {
			names = append(names, c.Name())
		}
		cfgArgs := goldenv.Args(
			"enabled", tc.cfg.Enabled,
			"checks", tc.cfg.Checks,
			"sourceLang", tc.cfg.SourceLang,
			"targetLang", tc.cfg.TargetLang,
			"format", tc.cfg.Format,
			"lengthMethod", string(tc.cfg.LengthMethod),
			"lengthRatioMin", tc.cfg.LengthRatioMin,
			"lengthRatioMax", tc.cfg.LengthRatioMax,
		)
		cases = append(cases, goldenv.Case{
			ID:   "qa/engine/" + tc.id,
			Op:   "qa.engine",
			Args: goldenv.Args("config", cfgArgs, "segments", goldenSegments(tc.segments)),
			Expect: goldenv.Expect(
				"issues", normalizeIssues(t, issues),
				"checkerNames", names,
			),
		})
	}

	// ================= QualityIssue JSON 契约 =================
	issueJSONCases := []struct {
		id    string
		issue map[string]any
	}{
		{"pending", map[string]any{"segment_index": 0, "severity": "warning", "code": "x", "message": "m", "disposition": "pending"}},
		{"dismissed", map[string]any{"segment_index": 1, "severity": "error", "code": "x", "message": "m", "disposition": "dismissed"}},
		{"missing-disposition", map[string]any{"segment_index": 0, "severity": "", "code": "x", "message": "m"}},
		{"empty-disposition", map[string]any{"segment_index": 0, "severity": "", "code": "x", "message": "m", "disposition": ""}},
		{"null-disposition", map[string]any{"segment_index": 0, "severity": "", "code": "x", "message": "m", "disposition": nil}},
		{"full", map[string]any{
			"segment_index": 3, "severity": "error", "code": "source_residual", "message": "m",
			"span":        map[string]any{"matched_text": "テスト", "target_start": 6, "target_end": 9},
			"disposition": "dismissed", "decided_by": 42,
			"decided_at": "2026-09-29T12:30:05.123456789+08:00", "note": "2026-09-29T12:30:05+08:00",
		}},
		{"zero-offsets", map[string]any{
			"segment_index": 0, "severity": "warning", "code": "x", "message": "m",
			"span":        map[string]any{"matched_text": "a", "target_start": 0, "target_end": 1},
			"disposition": "pending", "decided_by": 0,
		}},
		{"zero-fraction", map[string]any{
			"decided_at": "2026-09-29T12:30:05.123400000+08:00",
		}},
		{"nanosecond", map[string]any{
			"decided_at": "2026-01-01T00:00:00.000000001Z",
		}},
		{"cross-day-offset", map[string]any{
			"decided_at": "2025-12-31T23:59:59.999999999-05:00",
		}},
		{"null-decided-at", map[string]any{"code": "x", "decided_at": nil}},
	}
	for _, tc := range issueJSONCases {
		raw, err := json.Marshal(tc.issue)
		if err != nil {
			t.Fatalf("%s: 序列化失败: %v", tc.id, err)
		}
		var iss QualityIssue
		if err := json.Unmarshal(raw, &iss); err != nil {
			t.Fatalf("%s: 反序列化失败: %v", tc.id, err)
		}
		marshaled, err := json.Marshal(iss)
		if err != nil {
			t.Fatalf("%s: 重新序列化失败: %v", tc.id, err)
		}
		var roundtrip any
		if err := json.Unmarshal(marshaled, &roundtrip); err != nil {
			t.Fatalf("%s: 解析 roundtrip 失败: %v", tc.id, err)
		}
		var orig any
		if err := json.Unmarshal(raw, &orig); err != nil {
			t.Fatalf("%s: 解析原输入失败: %v", tc.id, err)
		}
		cases = append(cases, goldenv.Case{
			ID:   "qa/issue-json/" + tc.id,
			Op:   "qa.issue_json",
			Args: goldenv.Args("issue", orig),
			Expect: goldenv.Expect(
				"roundtrip", roundtrip,
				"isPending", iss.IsPending(),
				"dismissed", iss.Dismissed(),
				"fingerprint", Fingerprint(iss),
			),
		})
	}

	for _, tt := range []struct {
		id    string
		issue map[string]any
	}{
		{"invalid-disposition", map[string]any{"disposition": "unknown", "code": "x"}},
		{"non-string-disposition", map[string]any{"disposition": 3}},
		{"bad-decided-at", map[string]any{"decided_at": "not-a-time"}},
	} {
		raw, _ := json.Marshal(tt.issue)
		var iss QualityIssue
		err := json.Unmarshal(raw, &iss)
		cases = append(cases, goldenv.Case{
			ID:     "qa/issue-invalid/" + tt.id,
			Op:     "qa.issue_invalid",
			Args:   goldenv.Args("issue", tt.issue),
			Expect: goldenv.Expect("error", err != nil),
		})
	}

	// MarshalJSON 不修改调用方时间戳（归一化只发生在副本上）
	cases = append(cases, goldenv.Case{
		ID:   "qa/issue-marshal/caller-untouched",
		Op:   "qa.issue_marshal",
		Args: goldenv.Args("issue", map[string]any{
			"code": "example", "decided_at": "2026-09-29T12:30:05.123456789+08:00",
			"note": "2026-09-29T12:30:05+08:00",
		}),
		Expect: goldenv.Expect(
			"marshaled", mustJSON(t, QualityIssue{
				Code:      "example",
				Note:      "2026-09-29T12:30:05+08:00",
				DecidedAt: localTimePtr(time.Date(2026, 9, 29, 12, 30, 5, 123456789, time.FixedZone("user", 8*60*60))),
			}),
			"inputDecidedAt", "2026-09-29T12:30:05.123456789+08:00",
			"callerStillLocal", true,
		),
	})

	n, err := goldenv.Write(out, "qa", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("qa 黄金向量已导出: %d 条 → %s/qa.json", n, out)
}

// codeID 把 issue code 规范化为稳定的用例 ID 片段。
func codeID(code string) string {
	if code == "" {
		return "empty"
	}
	return code
}
