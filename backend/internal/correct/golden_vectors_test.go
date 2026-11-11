package correct

import (
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
	"github.com/MeowSalty/LinguaFlow/backend/internal/model"
	"github.com/MeowSalty/LinguaFlow/backend/internal/qa"
)

// issueArg 构造一条黄金向量输入的 issue 投影（只保留规则真正读取的字段）。
func issueArg(code, disposition, matchedText string, hasSpan bool) map[string]any {
	m := map[string]any{"code": code}
	if disposition != "" {
		m["disposition"] = disposition
	}
	if hasSpan {
		m["span"] = map[string]any{"matched_text": matchedText}
	}
	return m
}

// pmIssueArg 是 pmIssue 的黄金向量投影（pending punctuation_missing issue）。
func pmIssueArg(code string) []map[string]any {
	return []map[string]any{issueArg(code, "", "", false)}
}

// segArg 构造一条黄金向量输入段落。
func segArg(source, target string, protected map[string]string, issues []map[string]any) map[string]any {
	if protected == nil {
		protected = map[string]string{}
	}
	if issues == nil {
		issues = []map[string]any{}
	}
	return goldenv.Args("source", source, "target", target, "protected", protected, "issues", issues)
}

// resultExpect 把规则输出投影为 expected JSON。
func resultExpect(res CorrectionResult) map[string]any {
	codes := res.ResolvedCodes
	if codes == nil {
		codes = []string{}
	}
	return goldenv.Expect(
		"changed", res.Changed,
		"new_target", res.NewTarget,
		"op", res.Op,
		"resolved_codes", codes,
		"reason", res.Reason,
	)
}

// configArg 把 RuleConfig 投影为小写键的 JSON 形态（Go 结构体无 json tag）。
func configArg(cfg []RuleConfig) []map[string]any {
	out := make([]map[string]any, 0, len(cfg))
	for _, rc := range cfg {
		out = append(out, map[string]any{"name": rc.Name, "enabled": rc.Enabled})
	}
	return out
}

// goldenRule 描述一条「直接Apply单规则」的用例。
type goldenRule struct {
	id      string
	rule    string
	segment map[string]any
}

// goldenEngine 描述一条「按配置构建引擎后 Apply」的用例。
type goldenEngine struct {
	id      string
	config  []RuleConfig
	segment map[string]any
}

// TestGoldenVectors 导出 correct 包的黄金向量。
//
// 覆盖三条规则的 rule_*_test.go 全部边界用例（触发/守卫/幂等/裁决可见性/保护区），
// 以及引擎的白名单、canonical 顺序、首 Changed 即停、codes 并集语义。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	pm := func(source, target string, extra ...map[string]any) map[string]any {
		var issues []map[string]any
		if len(extra) > 0 {
			issues = extra
		} else {
			issues = pmIssueArg(qa.CheckPunctuationMissing)
		}
		return segArg(source, target, nil, issues)
	}
	wl := func(source, target string, extra ...map[string]any) map[string]any {
		var issues []map[string]any
		if len(extra) > 0 {
			issues = extra
		} else {
			issues = pmIssueArg(qa.CheckPunctuationWrapLoss)
		}
		return segArg(source, target, nil, issues)
	}
	wd := func(target, matched string) map[string]any {
		return segArg("", target, nil, []map[string]any{issueArg(qa.CheckWidthMix, "", matched, true)})
	}

	rules := []goldenRule{
		// punctuation_missing_wrap
		{"pm/safe", RulePunctuationMissingWrap, pm("「对话」", "对话")},
		{"pm/idempotent-second-apply", RulePunctuationMissingWrap, pm("「对话」", "「对话」")},
		{"pm/multi-span", RulePunctuationMissingWrap, pm("「你好」「再见」", "你好 再见")},
		{"pm/no-issue", RulePunctuationMissingWrap, segArg("「对话」", "对话", nil, nil)},
		{"pm/dismissed-invisible", RulePunctuationMissingWrap, segArg("「对话」", "对话", nil,
			[]map[string]any{issueArg(qa.CheckPunctuationMissing, string(qa.DispositionDismissed), "", false)})},
		{"pm/mixed-dispositions-triggers", RulePunctuationMissingWrap, segArg("「（对话）」", "对话", nil,
			[]map[string]any{
				issueArg(qa.CheckPunctuationMissing, "", "", false),
				issueArg(qa.CheckPunctuationMissing, string(qa.DispositionDismissed), "（）", true),
			})},
		{"pm/not-paired-open", RulePunctuationMissingWrap, pm("对话！", "对话")},
		{"pm/mismatched-close", RulePunctuationMissingWrap, pm("「对话”", "对话")},
		{"pm/no-content-between", RulePunctuationMissingWrap, pm("「」", "")},
		{"pm/placeholder-stays-inside", RulePunctuationMissingWrap,
			segArg("「你好 __LF_1__」", "你好 __LF_1__", map[string]string{"__LF_1__": "ABC"}, pmIssueArg(qa.CheckPunctuationMissing))},
		{"pm/defensive-target-runes", RulePunctuationMissingWrap, pm("「对话」", "对话「")},
		{"pm/quote-not-at-edges", RulePunctuationMissingWrap, pm("这是一条“测试”消息", "这是一条测试消息")},
		{"pm/source-quotes-inside-markup", RulePunctuationMissingWrap, pm("<b>「你好」</b>", "<b>こんにちは</b>")},
		{"pm/empty-source", RulePunctuationMissingWrap, pm("", "对话")},

		// punctuation_wrap_loss_wrap
		{"wl/safe", RulePunctuationWrapLossWrap, wl("「对话」", "对话")},
		{"wl/idempotent-second-apply", RulePunctuationWrapLossWrap, wl("「对话」", "「对话」")},
		{"wl/inner-quotes-still-wrapped", RulePunctuationWrapLossWrap, wl("「彼は“行く”と言った」", "他说“要去”")},
		{"wl/no-issue", RulePunctuationWrapLossWrap, segArg("「对话」", "对话", nil, nil)},
		{"wl/dismissed-invisible", RulePunctuationWrapLossWrap, segArg("「对话」", "对话", nil,
			[]map[string]any{issueArg(qa.CheckPunctuationWrapLoss, string(qa.DispositionDismissed), "", false)})},
		{"wl/multi-span", RulePunctuationWrapLossWrap, wl("「你好」「再见」", "你好 再见")},
		{"wl/not-paired-open", RulePunctuationWrapLossWrap, wl("对话！", "对话")},
		{"wl/mismatched-close", RulePunctuationWrapLossWrap, wl("「对话”", "对话")},
		{"wl/no-content-between", RulePunctuationWrapLossWrap, wl("「」", "x")},
		{"wl/placeholder-stays-inside", RulePunctuationWrapLossWrap,
			segArg("「你好 __LF_1__」", "你好 __LF_1__", map[string]string{"__LF_1__": "ABC"}, pmIssueArg(qa.CheckPunctuationWrapLoss))},
		{"wl/edge-quote-blocks", RulePunctuationWrapLossWrap, wl("「对话」", "“对话”")},
		{"wl/single-sided-edge-blocks", RulePunctuationWrapLossWrap, wl("「对话」", "「对话")},
		{"wl/unbalanced-interior-same-pair", RulePunctuationWrapLossWrap, wl("「对话」", "他「说")},
		{"wl/unbalanced-interior-other-pair", RulePunctuationWrapLossWrap, wl("「彼はこう言った」", "她说“这样")},
		{"wl/balanced-interior-still-wraps", RulePunctuationWrapLossWrap, wl("「对话」", "他「说」了")},
		{"wl/source-quotes-inside-markup", RulePunctuationWrapLossWrap,
			segArg("__LF_1__「你好」__LF_2__", "__LF_1__你好__LF_2__",
				map[string]string{"__LF_1__": "<b>", "__LF_2__": "</b>"}, pmIssueArg(qa.CheckPunctuationWrapLoss))},
		{"wl/source-quotes-outside-markup-wraps", RulePunctuationWrapLossWrap,
			segArg("「__LF_1__你好__LF_2__」", "__LF_1__你好__LF_2__",
				map[string]string{"__LF_1__": "<b>", "__LF_2__": "</b>"}, pmIssueArg(qa.CheckPunctuationWrapLoss))},
		{"wl/empty-source", RulePunctuationWrapLossWrap, wl("", "对话")},

		// width_mix_normalize
		{"wd/cjk-positive", RuleWidthMixNormalize, wd("那是什么!?", "!")},
		{"wd/cjk-idempotent", RuleWidthMixNormalize, wd("那是什么！？", "!")},
		{"wd/cjk-double-bang", RuleWidthMixNormalize, wd("好!好!", "!")},
		{"wd/cjk-mixed-run", RuleWidthMixNormalize, wd("什么?!", "!")},
		{"wd/cjk-comma-after-digit-before-letter", RuleWidthMixNormalize, wd("3,但是", ",")},
		{"wd/cjk-colon-after-cjk", RuleWidthMixNormalize, wd("他说:你好", ":")},
		{"wd/cjk-parens-no-guard", RuleWidthMixNormalize, wd("100(约)", "(")},
		{"wd/cjk-semicolon-no-guard", RuleWidthMixNormalize, wd("对;错", ";")},
		{"wd/cjk-digit-flanked-colon", RuleWidthMixNormalize, wd("12:30", ":")},
		{"wd/cjk-digit-flanked-comma", RuleWidthMixNormalize, wd("1,000", ",")},
		{"wd/cjk-digit-prefixed-bang", RuleWidthMixNormalize, wd("5!", "!")},
		{"wd/cjk-digit-prefixed-mixed-run", RuleWidthMixNormalize, wd("100!?", "!")},
		{"wd/latin-letters", RuleWidthMixNormalize, wd("ＡＢ！", "Ａ")},
		{"wd/latin-direction-from-punct", RuleWidthMixNormalize, wd("ＡＢ！", "！")},
		{"wd/latin-digits", RuleWidthMixNormalize, wd("０１", "０")},
		{"wd/latin-idempotent", RuleWidthMixNormalize, wd("AB!", "Ａ")},
		{"wd/no-issue", RuleWidthMixNormalize, segArg("", "那是什么!?", nil, nil)},
		{"wd/dismissed-invisible", RuleWidthMixNormalize, segArg("", "那是什么!?", nil,
			[]map[string]any{issueArg(qa.CheckWidthMix, string(qa.DispositionDismissed), "!", true)})},
		{"wd/mixed-dispositions-triggers", RuleWidthMixNormalize, segArg("", "好!", nil,
			[]map[string]any{
				issueArg(qa.CheckWidthMix, string(qa.DispositionDismissed), "@", true),
				issueArg(qa.CheckWidthMix, "", "!", true),
			})},
		{"wd/unreadable-nil-span", RuleWidthMixNormalize, segArg("", "那是什么!?", nil,
			[]map[string]any{issueArg(qa.CheckWidthMix, "", "", false)})},
		{"wd/unreadable-empty-text", RuleWidthMixNormalize, wd("那是什么!?", "")},
		{"wd/unreadable-char", RuleWidthMixNormalize, wd("那是什么!?", "@")},
		{"wd/protected-ruby-region", RuleWidthMixNormalize,
			segArg("漢字（かんじ）!", "<ruby>1<rt>one</rt></ruby>!", nil, pmIssueArg(qa.CheckWidthMix))},
		{"wd/protected-map", RuleWidthMixNormalize,
			segArg("", "(a,b) ok!", map[string]string{"(a,b)": "(a,b)"},
				[]map[string]any{issueArg(qa.CheckWidthMix, "", "!", true)})},
	}

	engines := []goldenEngine{
		{"engine/disabled-empty", nil, pm("「对话」", "对话")},
		{"engine/disabled-unknown-name", []RuleConfig{{Name: "bogus"}}, pm("「对话」", "对话")},
		{"engine/disabled-unknown-enabled", []RuleConfig{{Name: "bogus", Enabled: true}}, pm("「对话」", "对话")},
		{"engine/single-pm", []RuleConfig{{Name: RulePunctuationMissingWrap, Enabled: true}}, pm("「对话」", "对话")},
		{"engine/single-wl", []RuleConfig{{Name: RulePunctuationWrapLossWrap, Enabled: true}}, wl("「对话」", "对话")},
		{"engine/single-wd", []RuleConfig{{Name: RuleWidthMixNormalize, Enabled: true}}, wd("好!", "!")},
		{"engine/all-noop", []RuleConfig{
			{Name: RulePunctuationMissingWrap, Enabled: true},
			{Name: RulePunctuationWrapLossWrap, Enabled: true},
			{Name: RuleWidthMixNormalize, Enabled: true},
		}, segArg("普通", "普通", nil, nil)},
		{"engine/config-order-ignored", []RuleConfig{
			{Name: RuleWidthMixNormalize, Enabled: true},
			{Name: RulePunctuationMissingWrap, Enabled: true},
		}, segArg("「对话」", "对话!", nil,
			[]map[string]any{
				issueArg(qa.CheckPunctuationMissing, "", "", false),
				issueArg(qa.CheckWidthMix, "", "!", true),
			})},
		{"engine/first-changed-stops", []RuleConfig{
			{Name: RulePunctuationMissingWrap, Enabled: true},
			{Name: RulePunctuationWrapLossWrap, Enabled: true},
			{Name: RuleWidthMixNormalize, Enabled: true},
		}, segArg("「对话」", "对话!", nil,
			[]map[string]any{
				issueArg(qa.CheckPunctuationMissing, "", "", false),
				issueArg(qa.CheckWidthMix, "", "!", true),
			})},
		{"engine/disabled-rule-skipped", []RuleConfig{
			{Name: RulePunctuationMissingWrap, Enabled: false},
			{Name: RuleWidthMixNormalize, Enabled: true},
		}, segArg("「对话」", "对话!", nil,
			[]map[string]any{
				issueArg(qa.CheckPunctuationMissing, "", "", false),
				issueArg(qa.CheckWidthMix, "", "!", true),
			})},
		{"engine/last-noop-returned", []RuleConfig{
			{Name: RulePunctuationMissingWrap, Enabled: true},
			{Name: RuleWidthMixNormalize, Enabled: true},
		}, segArg("对话", "对话", nil, nil)},
		{"engine/duplicate-config-last-wins", []RuleConfig{
			{Name: RuleWidthMixNormalize, Enabled: false},
			{Name: RuleWidthMixNormalize, Enabled: true},
		}, wd("好!", "!")},
	}

	cases := make([]goldenv.Case, 0, len(rules)+len(engines)+8)
	for _, tc := range rules {
		var rule Rule
		switch tc.rule {
		case RulePunctuationMissingWrap:
			rule = &PunctuationMissingWrapRule{}
		case RulePunctuationWrapLossWrap:
			rule = &PunctuationWrapLossWrapRule{}
		case RuleWidthMixNormalize:
			rule = &WidthMixNormalizeRule{}
		}
		seg := segmentFromArgs(tc.segment)
		cases = append(cases, goldenv.Case{
			ID:     tc.id,
			Op:     "correct.rule",
			Args:   goldenv.Args("rule", tc.rule, "source", seg.Source, "target", seg.Target, "protected", tc.segment["protected"], "issues", tc.segment["issues"]),
			Expect: resultExpect(rule.Apply(seg)),
		})
	}
	for _, tc := range engines {
		seg := segmentFromArgs(tc.segment)
		engine := New(Config{Rules: tc.config})
		cases = append(cases, goldenv.Case{
			ID:     tc.id,
			Op:     "correct.engine",
			Args:   goldenv.Args("config", configArg(tc.config), "source", seg.Source, "target", seg.Target, "protected", tc.segment["protected"], "issues", tc.segment["issues"]),
			Expect: resultExpect(engine.Apply(seg)),
		})
	}

	// 引擎元信息：白名单、启用判定、consumed codes 并集。
	cases = append(cases, goldenv.Case{
		ID:     "meta/all-rule-names",
		Op:     "correct.all_rule_names",
		Args:   goldenv.Args(),
		Expect: goldenv.Expect("names", AllRuleNames()),
	})
	for i, cfg := range []Config{
		{Rules: nil},
		{Rules: []RuleConfig{{Name: "bogus"}}},
		{Rules: []RuleConfig{{Name: RulePunctuationMissingWrap, Enabled: true}}},
		{Rules: []RuleConfig{
			{Name: RulePunctuationMissingWrap, Enabled: true},
			{Name: RulePunctuationWrapLossWrap, Enabled: true},
			{Name: RuleWidthMixNormalize, Enabled: true},
		}},
		{Rules: []RuleConfig{
			{Name: RuleWidthMixNormalize, Enabled: false},
			{Name: RulePunctuationMissingWrap, Enabled: true},
		}},
	} {
		engine := New(cfg)
		var codes any
		if c := engine.ConsumedIssueCodes(); c != nil {
			codes = c
		}
		cases = append(cases, goldenv.Case{
			ID:     "meta/engine-" + itoa(i),
			Op:     "correct.engine_meta",
			Args:   goldenv.Args("config", configArg(cfg.Rules)),
			Expect: goldenv.Expect("enabled", engine.Enabled(), "codes", codes),
		})
	}

	if _, err := goldenv.Write(out, "correct", cases); err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("correct 黄金向量已导出: %d 条 → %s/correct.json", len(cases), out)
}

// itoa 是 strconv.Itoa 的本地小助手（避免额外 import 干扰测试可读性）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// segmentFromArgs 从黄金向量参数投影重建 model.Segment（供调用生产代码）。
func segmentFromArgs(args map[string]any) *model.Segment {
	seg := &model.Segment{}
	seg.Source, _ = args["source"].(string)
	seg.Target, _ = args["target"].(string)
	seg.Protected = map[string]string{}
	if m, ok := args["protected"].(map[string]string); ok {
		seg.Protected = m
	}
	if list, ok := args["issues"].([]map[string]any); ok {
		for _, item := range list {
			iss := qa.QualityIssue{}
			iss.Code, _ = item["code"].(string)
			if d, ok := item["disposition"].(string); ok {
				iss.Disposition = qa.IssueDisposition(d)
			}
			if span, ok := item["span"].(map[string]any); ok {
				text, _ := span["matched_text"].(string)
				iss.Span = &qa.Span{MatchedText: text}
			}
			seg.Issues = append(seg.Issues, iss)
		}
	}
	return seg
}
