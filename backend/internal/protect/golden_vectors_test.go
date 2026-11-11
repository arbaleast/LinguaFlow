package protect

import (
	"regexp"
	"sort"
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
	"github.com/MeowSalty/LinguaFlow/backend/internal/model"
	"github.com/MeowSalty/LinguaFlow/backend/internal/ruby"
)

// placeholderLiteralRE 匹配源文中的 `__LF_NNNNNN__` 字面量。
var placeholderLiteralRE = regexp.MustCompile(`__LF_\d{6}__`)

// placeholderLiterals 返回源文中出现的全部占位符字面量（去重、升序）。
func placeholderLiterals(src string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, m := range placeholderLiteralRE.FindAllString(src, -1) {
		if _, ok := seen[m]; ok {
			continue
		}
		seen[m] = struct{}{}
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// nonNilStrings 把 nil 切片归一为空切片（Go 的 nil slice 序列化后是 null，
// TS 侧统一用空数组表达「无结果」）。
func nonNilStrings(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// goldenProtectCase 描述一条「保护器保护一段文本」的黄金向量。
type goldenProtectCase struct {
	id     string
	op     string
	source string
	p      Protector
}

// goldenChains 记录各用例使用的保护器组合（供 TS 侧复现同一条链）。
// key = 用例 ID。
var goldenChains = map[string][]string{
	"protect/compose/all":            {"code", "link", "placeholder", "xml"},
	"protect/compose/adjacent":       {"xml"},
	"protect/compose/ruby-xml":       {"ruby", "xml"},
	"protect/compose/unicode":        {"code", "link", "placeholder", "xml"},
	"protect/compose/ruby-then-xml": {"ruby", "xml"},
}

// goldenRules 记录 `protect.from_rules` 用例的规则名列表。
// key = 用例 ID。
var goldenRules = map[string][]string{
	"protect/from-rules/all":     {"code", "link", "unknown", "placeholder", "xml"},
	"protect/from-rules/no-ruby": {"code", "link", "placeholder", "ruby", "xml"},
	"protect/from-rules/empty":   {},
}

// runGoldenProtect 执行保护并收集输出。
func runGoldenProtect(t *testing.T, cases []goldenProtectCase) []goldenv.Case {
	t.Helper()
	out := make([]goldenv.Case, 0, len(cases))
	for _, tc := range cases {
		seg := &model.Segment{Source: tc.source}
		if err := tc.p.Protect(seg); err != nil {
			t.Fatalf("%s: protect 失败: %v", tc.id, err)
		}
		protected := seg.Protected
		if protected == nil {
			protected = map[string]string{}
		}
		var meta any
		if len(seg.Meta) > 0 {
			meta = seg.Meta
		}
		args := goldenv.Args("source", tc.source)
		if chain, ok := goldenChains[tc.id]; ok {
			args["chain"] = chain
		}
		if rules, ok := goldenRules[tc.id]; ok {
			args["rules"] = rules
		}
		out = append(out, goldenv.Case{
			ID:   tc.id,
			Op:   tc.op,
			Args: args,
			Expect: goldenv.Expect(
				"source", seg.Source,
				"protected", protected,
				"meta", meta,
			),
		})
	}
	return out
}

// TestGoldenVectors 导出 protect 包的黄金测试向量。
//
// 仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘；常规 go test 不产生副作用。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	var cases []goldenv.Case

	// ---- 各子保护器 ----
	cases = append(cases, runGoldenProtect(t, []goldenProtectCase{
		{"protect/placeholder/double-brace", "protect.placeholder", "hello {{ .Name }} and {{var}}!", &PlaceholderProtector{}},
		{"protect/placeholder/single-brace", "protect.placeholder", "value is {0} and {1} and {abc.def}", &PlaceholderProtector{}},
		{"protect/placeholder/printf", "protect.placeholder", "format %s and %d and %.2f and %+v and %#x", &PlaceholderProtector{}},
		{"protect/placeholder/shell", "protect.placeholder", "env $HOME and ${PATH} and $_SKIP", &PlaceholderProtector{}},
		{"protect/placeholder/plain", "protect.placeholder", "plain text without placeholders", &PlaceholderProtector{}},
		{"protect/placeholder/unicode", "protect.placeholder", "变量 {{名前}} 与 {索引0} 混排 🎉", &PlaceholderProtector{}},
		{"protect/placeholder/nested-brace", "protect.placeholder", "{{outer {inner}}}", &PlaceholderProtector{}},
		{"protect/placeholder/empty-brace", "protect.placeholder", "{} {{}} {a}", &PlaceholderProtector{}},
	})...)

	cases = append(cases, runGoldenProtect(t, []goldenProtectCase{
		{"protect/code/fenced-backtick", "protect.code", "```go\nfmt.Println(\"hi\")\n```", &CodeProtector{}},
		{"protect/code/fenced-tilde", "protect.code", "~~~python\nprint('hi')\n~~~", &CodeProtector{}},
		{"protect/code/inline", "protect.code", "hello `world` foo", &CodeProtector{}},
		{"protect/code/inline-multi-backtick", "protect.code", "a ``co`de`` b", &CodeProtector{}},
		{"protect/code/mixed", "protect.code", "mix `inline` and:\n```\nblock\n```\nafter", &CodeProtector{}},
		{"protect/code/plain", "protect.code", "plain text without code", &CodeProtector{}},
		{"protect/code/unicode", "protect.code", "行内 `代码` 与 🎉 混排", &CodeProtector{}},
		{"protect/code/unclosed-fence", "protect.code", "```go\nno closing fence", &CodeProtector{}},
	})...)

	cases = append(cases, runGoldenProtect(t, []goldenProtectCase{
		{"protect/link/md", "protect.link", "see [docs](https://example.com) please", &LinkProtector{}},
		{"protect/link/image", "protect.link", "image ![alt](https://e.com/a.png) here", &LinkProtector{}},
		{"protect/link/auto", "protect.link", "auto <https://example.com> link", &LinkProtector{}},
		{"protect/link/ftp", "protect.link", "ftp <ftp://example.com/x> mail <mailto:a@b.c>", &LinkProtector{}},
		{"protect/link/ref", "protect.link", "ref [foo][1] link", &LinkProtector{}},
		{"protect/link/title", "protect.link", `titled [docs](https://example.com "Title")`, &LinkProtector{}},
		{"protect/link/none", "protect.link", "no link here", &LinkProtector{}},
		{"protect/link/unicode-text", "protect.link", "链接 [文档](https://example.com/文档)", &LinkProtector{}},
	})...)

	cases = append(cases, runGoldenProtect(t, []goldenProtectCase{
		{"protect/xml/basic", "protect.xml", `click <a href="x">here</a>`, &XMLProtector{}},
		{"protect/xml/self-closing", "protect.xml", `<br/> ends line`, &XMLProtector{}},
		{"protect/xml/custom", "protect.xml", `<custom-tag attr="v"/>middle</custom-tag>`, &XMLProtector{}},
		{"protect/xml/namespaced", "protect.xml", `<ns:tag ns:attr="v"></ns:tag>`, &XMLProtector{}},
		{"protect/xml/none", "protect.xml", "no tags at all", &XMLProtector{}},
		{"protect/xml/lt-space", "protect.xml", "a < b and c > d", &XMLProtector{}},
		{"protect/xml/attr-with-gt", "protect.xml", `<a title="a>b">x</a>`, &XMLProtector{}},
	})...)

	// ---- ruby 保护器（依赖 ruby 包的 Extract）----
	cases = append(cases, runGoldenProtect(t, []goldenProtectCase{
		{"protect/ruby/single", "protect.ruby", `<ruby>呪<rt>じゅ</rt></ruby>`, NewRubyProtector()},
		{"protect/ruby/word", "protect.ruby", `<ruby>椎名<rt>しいな</rt></ruby>`, NewRubyProtector()},
		{"protect/ruby/adjacent-merge", "protect.ruby", `<ruby>微<rt>ほほ</rt></ruby><ruby>笑<rt>え</rt></ruby>`, NewRubyProtector()},
		{"protect/ruby/multi-rt", "protect.ruby", `<ruby>何<rt>な</rt>故<rt>ぜ</rt></ruby>`, NewRubyProtector()},
		{"protect/ruby/plain", "protect.ruby", `plain text without ruby`, NewRubyProtector()},
		{"protect/ruby/no-rt", "protect.ruby", `<p>no ruby here</p>`, NewRubyProtector()},
		{"protect/ruby/emoji-base", "protect.ruby", `<ruby>🎉<rt>Party</rt></ruby>`, NewRubyProtector()},
	})...)

	// ---- 组合链 ----
	composed := Compose(&CodeProtector{}, &LinkProtector{}, &PlaceholderProtector{}, &XMLProtector{})
	cases = append(cases, runGoldenProtect(t, []goldenProtectCase{
		{"protect/compose/all", "protect.compose", "Use `code` and [link](https://x.com) with {{var}} <br/>", composed},
		{"protect/compose/adjacent", "protect.compose", `────</span><ruby>椎名<rt>しいな</rt></ruby>`, Compose(&XMLProtector{})},
		{"protect/compose/ruby-xml", "protect.compose", `<ruby>呪<rt>じゅ</rt></ruby>`, Compose(NewRubyProtector(), &XMLProtector{})},
		{"protect/compose/unicode", "protect.compose", "🎉 `code` {{变量}} [链接](https://x.com) <b>粗体</b>", composed},
		{"protect/compose/ruby-then-xml", "protect.compose", `<ruby>微<rt>ほほ</rt></ruby><ruby>笑<rt>え</rt></ruby>`, Compose(NewRubyProtector(), &XMLProtector{})},
	})...)

	// ---- FromRules ----
	cases = append(cases, runGoldenProtect(t, []goldenProtectCase{
		{"protect/from-rules/all", "protect.from_rules", "`x` [y](z) {{w}} <a/>", FromRules([]string{"code", "link", "unknown", "placeholder", "xml"})},
		{"protect/from-rules/no-ruby", "protect.from_rules", `<ruby>呪<rt>じゅ</rt></ruby>`, FromRules([]string{"code", "link", "placeholder", "ruby", "xml"})},
		{"protect/from-rules/empty", "protect.from_rules", "nothing to protect", FromRules(nil)},
	})...)

	// ---- nextKey 字面量碰撞 fail-closed ----
	{
		src := "literal __LF_000001__ inside text"
		seg := &model.Segment{Source: src}
		if err := (&PlaceholderProtector{}).Protect(seg); err != nil {
			t.Fatal(err)
		}
		protected := seg.Protected
		if protected == nil {
			protected = map[string]string{}
		}
		cases = append(cases, goldenv.Case{
			ID:   "protect/next-key/literal-collision",
			Op:   "protect.next_key",
			Args: goldenv.Args("source", src),
			Expect: goldenv.Expect(
				"source", seg.Source,
				"protected", protected,
				"collidedKeys", placeholderLiterals(src),
			),
		})
	}
	{
		// 连续碰撞：__LF_000001__ 与 __LF_000002__ 同时出现时必须跳过两者。
		src := "__LF_000001__ and __LF_000002__ end"
		seg := &model.Segment{Source: src}
		if err := (&PlaceholderProtector{}).Protect(seg); err != nil {
			t.Fatal(err)
		}
		protected := seg.Protected
		if protected == nil {
			protected = map[string]string{}
		}
		cases = append(cases, goldenv.Case{
			ID:   "protect/next-key/sequential-collisions",
			Op:   "protect.next_key",
			Args: goldenv.Args("source", src),
			Expect: goldenv.Expect(
				"source", seg.Source,
				"protected", protected,
				"collidedKeys", placeholderLiterals(src),
			),
		})
	}

	// ---- mergeAdjacentPlaceholders ----
	mergeCases := []struct {
		id        string
		source    string
		protected map[string]string
	}{
		{"protect/merge/two-adjacent", "__LF_000001____LF_000002__after", map[string]string{
			"__LF_000001__": "<ruby>", "__LF_000002__": "<rt>",
		}},
		{"protect/merge/two-groups", "__LF_000001____LF_000002__じゅ__LF_000003____LF_000004__", map[string]string{
			"__LF_000001__": "<ruby>", "__LF_000002__": "<rt>", "__LF_000003__": "</rt>", "__LF_000004__": "</ruby>",
		}},
		{"protect/merge/whitespace-between", "__LF_000001__ __LF_000002__", map[string]string{
			"__LF_000001__": "A", "__LF_000002__": "B",
		}},
		{"protect/merge/newline-between", "__LF_000001__\n__LF_000002__", map[string]string{
			"__LF_000001__": "A", "__LF_000002__": "B",
		}},
		{"protect/merge/non-adjacent", "__LF_000001__ text __LF_000002__", map[string]string{
			"__LF_000001__": "A", "__LF_000002__": "B",
		}},
		{"protect/merge/single", "text __LF_000001__ more", map[string]string{
			"__LF_000001__": "A",
		}},
		{"protect/merge/no-placeholder", "plain text", map[string]string{
			"__LF_000001__": "A",
		}},
	}
	for _, mc := range mergeCases {
		seg := &model.Segment{Source: mc.source, Protected: map[string]string{}}
		for k, v := range mc.protected {
			seg.Protected[k] = v
		}
		mergeAdjacentPlaceholders(seg)
		cases = append(cases, goldenv.Case{
			ID:   mc.id,
			Op:   "protect.merge_adjacent",
			Args: goldenv.Args("source", mc.source, "protected", mc.protected),
			Expect: goldenv.Expect(
				"source", seg.Source,
				"protected", seg.Protected,
			),
		})
	}

	// ---- restoreAll 排序（长度倒序、字典序倒序打破平局）----
	{
		seg := &model.Segment{
			Protected: map[string]string{
				"__LF_000001__":  "SHORT",
				"__LF_000001__X": "LONG",
			},
			Target: "a __LF_000001__X b __LF_000001__ c",
		}
		seg.Target = restoreAll(seg.Target, seg.Protected)
		cases = append(cases, goldenv.Case{
			ID:   "protect/restore-all/length-desc",
			Op:   "protect.restore_all",
			Args: goldenv.Args("text", "a __LF_000001__X b __LF_000001__ c", "protected", seg.Protected),
			Expect: goldenv.Expect(
				"text", seg.Target,
			),
		})
	}
	{
		// composed.Unprotect 只回填一次：回填内容里恰好含有另一个占位符字面时不得二次替换。
		seg := &model.Segment{
			Protected: map[string]string{
				"__LF_000001__": "the literal __LF_000002__ should remain",
				"__LF_000002__": "WRONG",
			},
			Target: "head __LF_000001__ tail",
		}
		c := Compose(&CodeProtector{}, &LinkProtector{})
		if err := c.Unprotect(seg); err != nil {
			t.Fatal(err)
		}
		cases = append(cases, goldenv.Case{
			ID:   "protect/restore-all/no-double-restore",
			Op:   "protect.restore_all",
			Args: goldenv.Args("text", "head __LF_000001__ tail", "protected", map[string]string{
				"__LF_000001__": "the literal __LF_000002__ should remain",
				"__LF_000002__": "WRONG",
			}),
			Expect: goldenv.Expect("text", seg.Target),
		})
	}
	{
		// 相邻占位符的 unprotect 还原。
		seg := &model.Segment{
			Protected: map[string]string{
				"__LF_000001__": `<span class="x">`, "__LF_000002__": "</span>",
				"__LF_000003__": "<ruby>", "__LF_000004__": "<rt>",
				"__LF_000005__": "</rt>", "__LF_000006__": "</ruby>",
			},
			Target: "────__LF_000002____LF_000003__椎名__LF_000004__しいな__LF_000005____LF_000006__",
		}
		c := Compose(&XMLProtector{})
		if err := c.Unprotect(seg); err != nil {
			t.Fatal(err)
		}
		cases = append(cases, goldenv.Case{
			ID:   "protect/restore-all/adjacent",
			Op:   "protect.restore_all",
			Args: goldenv.Args("text", "────__LF_000002____LF_000003__椎名__LF_000004__しいな__LF_000005____LF_000006__", "protected", map[string]string{
				"__LF_000001__": `<span class="x">`, "__LF_000002__": "</span>",
				"__LF_000003__": "<ruby>", "__LF_000004__": "<rt>",
				"__LF_000005__": "</rt>", "__LF_000006__": "</ruby>",
			}),
			Expect: goldenv.Expect("text", seg.Target),
		})
	}

	// ---- PlaceholderViolations ----
	violationCases := []struct {
		id       string
		target   string
		protected map[string]string
	}{
		{"protect/violations/missing", "kept __LF_000002__ only", map[string]string{
			"__LF_000001__": "A", "__LF_000002__": "B", "__LF_000003__": "C",
		}},
		{"protect/violations/duplicated", "x __LF_000001__ y __LF_000001__ z", map[string]string{
			"__LF_000001__": "A",
		}},
		{"protect/violations/invented", "model said __LF_999999__ here", map[string]string{
			"__LF_000001__": "A",
		}},
		{"protect/violations/invented-upper", "model said __LF_ABCDEF__ here", map[string]string{
			"__LF_000001__": "A",
		}},
		{"protect/violations/mixed", "a __LF_000001__ b __LF_000001__ c __LF_888888__ d __LF_000002__", map[string]string{
			"__LF_000001__": "A", "__LF_000002__": "B", "__LF_000003__": "C",
		}},
		{"protect/violations/none", "nothing here", map[string]string{
			"__LF_000001__": "A",
		}},
		{"protect/violations/empty-protected", "has __LF_000001__ literal", map[string]string{}},
	}
	for _, vc := range violationCases {
		seg := &model.Segment{Target: vc.target, Protected: vc.protected}
		missing, duplicated, invented := PlaceholderViolations(seg)
		cases = append(cases, goldenv.Case{
			ID:   vc.id,
			Op:   "protect.violations",
			Args: goldenv.Args("target", vc.target, "protected", vc.protected),
			Expect: goldenv.Expect(
				"missing", nonNilStrings(missing),
				"duplicated", nonNilStrings(duplicated),
				"invented", nonNilStrings(invented),
			),
		})
	}

	// ---- AnalyzeStructural ----
	analyzeCases := []struct {
		id     string
		rules  []string
		source string
	}{
		{"protect/analyze/letters", []string{"code", "link", "placeholder", "xml"}, "hello world"},
		{"protect/analyze/pure-punct", []string{"code", "link", "placeholder", "xml"}, "--- ... !!!"},
		{"protect/analyze/code-only", []string{"code"}, "`code only`"},
		{"protect/analyze/code-with-text", []string{"code"}, "`code` plus text"},
		{"protect/analyze/xml-only", []string{"xml"}, "<b>bold</b>"},
		{"protect/analyze/digits", []string{"xml"}, "12345"},
		{"protect/analyze/empty", []string{"xml"}, ""},
		{"protect/analyze/cjk", []string{"xml"}, "汉字"},
		{"protect/analyze/emoji", []string{"xml"}, "🎉"},
		{"protect/analyze/literal-placeholder", []string{"xml"}, "__LF_000001__"},
		{"protect/analyze/nil-rules", nil, "plain"},
	}
	for _, ac := range analyzeCases {
		var p Protector
		if ac.rules != nil {
			p = FromRules(ac.rules)
		}
		a := AnalyzeStructural(p, ac.source)
		var mapping map[string]string
		if a.Mapping != nil {
			mapping = a.Mapping
		}
		var meta any
		if len(a.Meta) > 0 {
			meta = a.Meta
		}
		cases = append(cases, goldenv.Case{
			ID:   ac.id,
			Op:   "protect.analyze_structural",
			Args: goldenv.Args("rules", ac.rules, "source", ac.source),
			Expect: goldenv.Expect(
				"structural", a.Structural,
				"protected", a.Protected,
				"mapping", mapping,
				"meta", meta,
				"ran", a.ran,
				"err", a.Err != nil,
			),
		})
	}

	// ---- ProtectText / RestoreText ----
	{
		text, mapping, err := ProtectText(FromRules([]string{"code", "link", "placeholder", "xml"}), "Use `code` and [link](https://x.com) with {{var}} <br/>")
		if err != nil {
			t.Fatal(err)
		}
		if mapping == nil {
			mapping = map[string]string{}
		}
		cases = append(cases, goldenv.Case{
			ID:   "protect/protect-text/with-rules",
			Op:   "protect.protect_text",
			Args: goldenv.Args("rules", []string{"code", "link", "placeholder", "xml"}, "text", "Use `code` and [link](https://x.com) with {{var}} <br/>"),
			Expect: goldenv.Expect(
				"text", text,
				"mapping", mapping,
			),
		})
	}
	{
		text, mapping, err := ProtectText(nil, "no protector")
		if err != nil {
			t.Fatal(err)
		}
		cases = append(cases, goldenv.Case{
			ID:   "protect/protect-text/nil-protector",
			Op:   "protect.protect_text",
			Args: goldenv.Args("rules", []string(nil), "text", "no protector"),
			Expect: goldenv.Expect(
				"text", text,
				"mapping", mapping,
			),
		})
	}
	{
		cases = append(cases, goldenv.Case{
			ID:   "protect/restore-text/basic",
			Op:   "protect.restore_text",
			Args: goldenv.Args("text", "a __LF_000001__ b", "mapping", map[string]string{"__LF_000001__": "X"}),
			Expect: goldenv.Expect(
				"text", RestoreText("a __LF_000001__ b", map[string]string{"__LF_000001__": "X"}),
			),
		})
	}

	// ---- MissingPlaceholders ----
	{
		seg := &model.Segment{
			Protected: map[string]string{"__LF_000001__": "A", "__LF_000002__": "B", "__LF_000003__": "C"},
			Target:    "kept __LF_000002__ only",
		}
		cases = append(cases, goldenv.Case{
			ID:   "protect/missing-placeholders/basic",
			Op:   "protect.missing_placeholders",
			Args: goldenv.Args("target", seg.Target, "protected", seg.Protected),
			Expect: goldenv.Expect(
				"missing", MissingPlaceholders(seg),
			),
		})
	}

	// ---- ruby_items 元数据（供 domain/ruby 对拍复用）----
	{
		seg := &model.Segment{Source: `<ruby>椎名<rt>しいな</rt></ruby>`}
		if err := NewRubyProtector().Protect(seg); err != nil {
			t.Fatal(err)
		}
		items, _ := seg.Meta["ruby_items"].([]ruby.Item)
		cases = append(cases, goldenv.Case{
			ID:   "protect/ruby/meta-items",
			Op:   "protect.ruby_items",
			Args: goldenv.Args("source", `<ruby>椎名<rt>しいな</rt></ruby>`),
			Expect: goldenv.Expect(
				"source", seg.Source,
				"items", items,
			),
		})
	}

	n, err := goldenv.Write(out, "protect", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("protect 黄金向量已导出: %d 条 → %s/protect.json", n, out)
}
