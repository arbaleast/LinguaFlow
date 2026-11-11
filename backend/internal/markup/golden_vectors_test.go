package markup

import (
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// errText 把 error 归一化为字符串：nil → ""。
func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// TestGoldenVectors 导出 markup 包的黄金向量。
//
// 覆盖 fragment_test.go 的全部边界用例（合法/非法片段、错误文案、目标退化三重门、
// 格式白名单），并补充属性/注释/CDATA/PI/DOCTYPE/非法字符等严格解析边界。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	valid := []struct{ id, frag string }{
		{"validate/empty", ""},
		{"validate/plain-cjk", "「レベル６：劣化雷神皇っ！」"},
		{"validate/balanced-ruby", "「等级６：<ruby>劣化雷神皇<rt>雷瑟·艾福达尔</rt></ruby>！」"},
		{"validate/nested-inline", `<span class="a">这是<b>粗体</b>与<i>斜体</i></span>`},
		{"validate/xhtml-void", "第一行<br />第二行"},
		{"validate/escaped-amp", "A &amp; B"},
		{"validate/escaped-angle", "1 &lt; 2 &gt; 0"},
		{"validate/numeric-ref", "省略&#8230;"},
		{"validate/namespaced", "<epub:span>text</epub:span>"},
		{"validate/self-closing-img", `<img src="a.png" alt="图" />`},
		{"validate/comment", "a<!-- 注释 -->b"},
		{"validate/cdata", "<![CDATA[<raw> & stuff]]>"},
		{"validate/processing-instruction", `<?xml-stylesheet href="a.xsl"?>`},
		{"validate/doctype", `<!DOCTYPE html>`},
		{"validate/single-quoted-attrs", "<span title='a &amp; b'>x</span>"},
		{"validate/hex-ref", "&#x4F60;&#22909;"},
		{"validate/attr-newline", "<span\n  class=\"a\">x</span>"},
		{"validate/empty-element-space", "<br/>"},
		{"validate/greater-than-chardata", "a > b"},
		{"validate/unicode-name", "<日本語>x</日本語>"},
		{"validate/whitespace-only", "   \n\t  "},
		{"validate/amp-in-attr", `<a href="x?a=1&amp;b=2">y</a>`},
	}

	invalid := []struct{ id, frag string }{
		{"validate/unclosed-ruby", "「等级６：<ruby>劣化雷神皇<rt>雷瑟·艾福达尔</rt>！」"},
		{"validate/crossed-nesting", "<ruby>a<rt>b</ruby></rt>"},
		{"validate/unclosed-span", "<span>文本"},
		{"validate/stray-close", "文本</p>"},
		{"validate/html-void-shorthand", "第一行<br>第二行"},
		{"validate/bare-amp", "A & B"},
		{"validate/undefined-entity", "A&nbsp;B"},
		{"validate/bare-less-than", "1 < 2"},
		{"validate/unclosed-with-eof-in-tag", "<span"},
		{"validate/attr-unquoted", "<span class=a>x</span>"},
		{"validate/attr-no-value", "<span class>x</span>"},
		{"validate/duplicate-attr", `<span class="a" class="b">x</span>`},
		{"validate/mismatched-close", "<a>x</b>"},
		{"validate/stray-close-after-root-content", "<a>x</a></b>"},
		{"validate/illegal-control-char", "a\x01b"},
		{"validate/entity-without-semicolon", "A &amp B"},
		{"validate/lt-in-attr", `<span title="a<b">x</span>`},
		{"validate/double-hyphen-comment", "a<!-- -- -->b"},
		{"validate/unknown-numeric-char", "&#x0;"},
		{"validate/cdata-unterminated", "<![CDATA[x"},
		{"validate/close-tag-with-attrs", "<a>x</a b>"},
		{"validate/ruby-text-outside", "「等级６：<ruby>劣化雷神皇<rt>雷瑟</rt>！」"},
		{"validate/entity-invalid-name", "A &notanentity; B"},
		{"validate/pi-unterminated", "<?xml"},
		{"validate/comment-unterminated", "a<!--x"},
		{"validate/directive-unterminated", "<!DOCTYPE"},
		{"validate/cdata-close-in-chardata", "a]]>b"},
		{"validate/attr-bad-name", "<span =\"x\">y</span>"},
		{"validate/entity-no-semicolon-eof", "A &"},
		{"validate/numeric-empty", "&#;"},
		{"validate/numeric-too-large", "&#x110000;"},
		{"validate/attr-no-space-between", `<a href="x"title="y">z</a>`},
		{"validate/self-closing-space-before-slash", "<a / >"},
		{"validate/comment-triple-hyphen", "a<!--x--->b"},
		{"validate/end-tag-newline", "<a>x</a\n>"},
	}

	regression := []struct{ id, source, target string }{
		{"regression/valid-source-broken-target", "「レベル６：<ruby>劣化雷神皇<rt>レツサーエフタル</rt></ruby>っ！」", "「等级６：<ruby>劣化雷神皇<rt>雷瑟</rt>！」"},
		{"regression/valid-source-valid-target", "<ruby>劣化雷神皇<rt>レツサーエフタル</rt></ruby>", "<ruby>劣化雷神皇<rt>雷瑟</rt></ruby>"},
		{"regression/ruby-dropped", "<ruby>劣化雷神皇<rt>レツサーエフタル</rt></ruby>", "劣化雷神皇"},
		{"regression/tagless-source", "普通台词", "<color=red>红色台词"},
		{"regression/invalid-source", "A & B <ruby>基<rt>注</rt></ruby>", "A & B 基"},
		{"regression/empty-target", "<ruby>基<rt>注</rt></ruby>", ""},
		{"regression/tagless-both", "普通台词", "普通台词"},
		{"regression/valid-source-bare-amp-target", "<b>a</b>", "A & B"},
		{"regression/source-with-comment", "<!-- c --><b>x</b>", "<b>y</b>"},
	}

	formats := []string{"epub", "EPUB", " epub ", "docx", "html", "markdown", "txt", "srt", "json", ""}

	cases := make([]goldenv.Case, 0, len(valid)+len(invalid)+len(regression)+len(formats))
	for _, c := range valid {
		err := ValidateFragment(c.frag)
		cases = append(cases, goldenv.Case{
			ID:     c.id,
			Op:     "markup.validate",
			Args:   goldenv.Args("s", c.frag),
			Expect: goldenv.Expect("ok", err == nil, "err", errText(err)),
		})
	}
	for _, c := range invalid {
		err := ValidateFragment(c.frag)
		cases = append(cases, goldenv.Case{
			ID:     c.id,
			Op:     "markup.validate",
			Args:   goldenv.Args("s", c.frag),
			Expect: goldenv.Expect("ok", err == nil, "err", errText(err)),
		})
	}
	for _, c := range regression {
		err := TargetRegression(c.source, c.target)
		cases = append(cases, goldenv.Case{
			ID:     c.id,
			Op:     "markup.target_regression",
			Args:   goldenv.Args("source", c.source, "target", c.target),
			Expect: goldenv.Expect("ok", err == nil, "err", errText(err)),
		})
	}
	for _, format := range formats {
		cases = append(cases, goldenv.Case{
			ID:     "formats/" + format,
			Op:     "markup.requires_well_formed_targets",
			Args:   goldenv.Args("format", format),
			Expect: goldenv.Expect("required", RequiresWellFormedTargets(format)),
		})
	}

	if _, err := goldenv.Write(out, "markup", cases); err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("markup 黄金向量已导出: %d 条 → %s/markup.json", len(cases), out)
}
