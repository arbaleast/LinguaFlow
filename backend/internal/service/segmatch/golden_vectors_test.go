package segmatch

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// 本文件只服务于「黄金向量」导出：把 segmatch 生产代码的真实输出序列化为 JSON，
// 供前端 `frontend/src/domain/__tests__/search.golden.test.ts` 逐例对拍。
//
// 与 Go 测试的差异：
//   - Go 的 Match 是 UTF-8 **字节偏移**，对外契约是**码点偏移**，
//     因此导出前用 utf8.RuneCountInString 换算（非法字节按 RuneError 计一个码点，
//     与 JSON 把非法 UTF-8 替换为 U+FFFD 后的码点数一致）；
//   - nil 切片归一为 []（README §3.2），TS 侧统一用空数组表达「无结果」。

// goldenBool 返回布尔指针（Options 的 CaseSensitive/WholeWord 是 *bool）。
func goldenBool(v bool) *bool { return &v }

// goldenOpts 构造显式指定全部字段的 Options。
func goldenOpts(find, mode string, caseSensitive, wholeWord bool) Options {
	return Options{
		Find:          find,
		MatchMode:     mode,
		CaseSensitive: goldenBool(caseSensitive),
		WholeWord:     goldenBool(wholeWord),
	}
}

// goldenFindCase 是一条 `search.find` 向量。
type goldenFindCase struct {
	id   string
	opts Options
	text string
}

// goldenReplaceCase 是一条 `search.replace` 向量。
type goldenReplaceCase struct {
	id          string
	opts        Options
	text        string
	replaceWith string
}

// goldenCandidateCase 是一条 `search.candidate` 向量。
type goldenCandidateCase struct {
	id   string
	opts Options
}

// goldenErrorCase 是一条 `search.error` 向量。
type goldenErrorCase struct {
	id   string
	opts Options
}

// goldenFind 构造 `search.find` 用例。
func goldenFind(id, find, mode string, caseSensitive, wholeWord bool, text string) goldenFindCase {
	return goldenFindCase{id: id, opts: goldenOpts(find, mode, caseSensitive, wholeWord), text: text}
}

// goldenReplace 构造 `search.replace` 用例。
func goldenReplace(
	id, find, mode string,
	caseSensitive, wholeWord bool,
	text, replaceWith string,
) goldenReplaceCase {
	return goldenReplaceCase{
		id:          id,
		opts:        goldenOpts(find, mode, caseSensitive, wholeWord),
		text:        text,
		replaceWith: replaceWith,
	}
}

// goldenCandidate 构造 `search.candidate` 用例。
func goldenCandidate(id, find, mode string, caseSensitive, wholeWord bool) goldenCandidateCase {
	return goldenCandidateCase{id: id, opts: goldenOpts(find, mode, caseSensitive, wholeWord)}
}

// goldenError 构造 `search.error` 用例。
func goldenError(id, find, mode string) goldenErrorCase {
	return goldenErrorCase{id: id, opts: goldenOpts(find, mode, true, false)}
}

// goldenMatchJSON 把字节偏移的 Match 列表换算为码点偏移的 JSON 对象列表。
// nil 切片归一为 []。
func goldenMatchJSON(text string, matches []Match) []map[string]int {
	out := make([]map[string]int, 0, len(matches))
	for _, match := range matches {
		out = append(out, map[string]int{
			"start": utf8.RuneCountInString(text[:match.Start]),
			"end":   utf8.RuneCountInString(text[:match.End]),
		})
	}
	return out
}

// goldenErrorCode 把 Go 哨兵错误映射为 TS 侧的 SearchError.code。
func goldenErrorCode(t *testing.T, id string, err error) string {
	t.Helper()
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrInvalidPattern):
		return "invalid_regex_pattern"
	case errors.Is(err, ErrPatternTooLong):
		return "pattern_too_long"
	case errors.Is(err, ErrUnsupportedMatchMode):
		return "unsupported_match_mode"
	default:
		t.Fatalf("%s: 未预期的错误: %v", id, err)
		return ""
	}
}

// runGoldenFind 执行 `search.find` 用例。
func runGoldenFind(t *testing.T, cases []goldenFindCase) []goldenv.Case {
	t.Helper()
	out := make([]goldenv.Case, 0, len(cases))
	for _, tc := range cases {
		m, err := NewMatcher(tc.opts)
		if err != nil {
			t.Fatalf("%s: NewMatcher: %v", tc.id, err)
		}
		out = append(out, goldenv.Case{
			ID: tc.id,
			Op: "search.find",
			Args: goldenv.Args(
				"find", tc.opts.Find,
				"matchMode", tc.opts.MatchMode,
				"caseSensitive", *tc.opts.CaseSensitive,
				"wholeWord", *tc.opts.WholeWord,
				"text", tc.text,
			),
			Expect: goldenv.Expect(
				"matches", goldenMatchJSON(tc.text, m.Find(tc.text)),
				"hasMatch", m.HasMatch(tc.text),
			),
		})
	}
	return out
}

// runGoldenReplace 执行 `search.replace` 用例。
func runGoldenReplace(t *testing.T, cases []goldenReplaceCase) []goldenv.Case {
	t.Helper()
	out := make([]goldenv.Case, 0, len(cases))
	for _, tc := range cases {
		m, err := NewMatcher(tc.opts)
		if err != nil {
			t.Fatalf("%s: NewMatcher: %v", tc.id, err)
		}
		replaced, count := m.ReplaceAll(tc.text, tc.replaceWith)
		out = append(out, goldenv.Case{
			ID: tc.id,
			Op: "search.replace",
			Args: goldenv.Args(
				"find", tc.opts.Find,
				"matchMode", tc.opts.MatchMode,
				"caseSensitive", *tc.opts.CaseSensitive,
				"wholeWord", *tc.opts.WholeWord,
				"text", tc.text,
				"replaceWith", tc.replaceWith,
			),
			Expect: goldenv.Expect("text", replaced, "count", count),
		})
	}
	return out
}

// runGoldenCandidate 执行 `search.candidate` 用例。
func runGoldenCandidate(t *testing.T, cases []goldenCandidateCase) []goldenv.Case {
	t.Helper()
	out := make([]goldenv.Case, 0, len(cases))
	for _, tc := range cases {
		m, err := NewMatcher(tc.opts)
		if err != nil {
			t.Fatalf("%s: NewMatcher: %v", tc.id, err)
		}
		out = append(out, goldenv.Case{
			ID: tc.id,
			Op: "search.candidate",
			Args: goldenv.Args(
				"find", tc.opts.Find,
				"matchMode", tc.opts.MatchMode,
				"caseSensitive", *tc.opts.CaseSensitive,
				"wholeWord", *tc.opts.WholeWord,
			),
			Expect: goldenv.Expect("literal", m.CandidateLiteral()),
		})
	}
	return out
}

// runGoldenError 执行 `search.error` 用例。
func runGoldenError(t *testing.T, cases []goldenErrorCase) []goldenv.Case {
	t.Helper()
	out := make([]goldenv.Case, 0, len(cases))
	for _, tc := range cases {
		_, err := NewMatcher(tc.opts)
		out = append(out, goldenv.Case{
			ID: tc.id,
			Op: "search.error",
			Args: goldenv.Args(
				"find", tc.opts.Find,
				"matchMode", tc.opts.MatchMode,
			),
			Expect: goldenv.Expect("error", goldenErrorCode(t, tc.id, err)),
		})
	}
	return out
}

// TestGoldenVectors 导出 segmatch 包的黄金测试向量。
//
// 仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘；常规 go test 不产生副作用。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	var cases []goldenv.Case

	// ---- substring：segmatch_test.go 的全部边界用例 ----
	cases = append(cases, runGoldenFind(t, []goldenFindCase{
		goldenFind("search/substring/basic", "cat", "substring", true, false, "a cat"),
		goldenFind("search/substring/non-overlapping", "ana", "substring", true, false, "bananana"),
		goldenFind("search/substring/case-sensitive", "go", "substring", true, false, "Go go GO"),
		goldenFind("search/substring/case-insensitive", "äPFEL", "substring", false, false, "Äpfel äPFEL"),
		goldenFind("search/substring/whole-word-cjk", "cat", "substring", true, true, "猫cat猫 cat，狗"),
		goldenFind("search/substring/whole-word-digits", "cat", "substring", true, true, "cat2 2cat cat_ _cat cat"),
		goldenFind("search/substring/empty-find", "", "substring", true, false, "anything"),
		goldenFind("search/substring/percent-underscore", "%_", "substring", true, false, "a%_b"),

		// 整词拒绝后必须继续扫描（大小写敏感 / 不敏感两条路径）。
		goldenFind("search/substring/whole-word-reject-then-accept", "cat", "substring", true, true, "concatenate cat"),
		goldenFind("search/substring/whole-word-reject-overlap", "a-a", "substring", true, true, "xa-a-a"),
		goldenFind("search/substring/whole-word-reject-overlap-ci", "a-a", "substring", false, true, "xa-a-a"),
		goldenFind("search/substring/whole-word-ci", "cat", "substring", false, true, "CAT cat concatenate Cat"),
		goldenFind("search/substring/kmp-overlap-ci", "ana", "substring", false, false, "bananana"),
		goldenFind("search/substring/kmp/overlap-aa", "aa", "substring", false, false, "aaaa"),
		goldenFind("search/substring/kmp/overlap-abab", "abab", "substring", false, false, "abababab"),
		goldenFind("search/substring/kmp/fail-chain", "aab", "substring", false, false, "aaab"),
		goldenFind("search/substring/kmp/fold-overlap", "aA", "substring", false, false, "AaAa"),
		goldenFind("search/substring/kmp/single-rune", "a", "substring", false, false, "aaa"),
		goldenFind("search/substring/whole-word-overlap-rejected", "aa", "substring", false, true, "aaa"),

		// 空文本 / emoji（代理对）/ CJK 扩展 B（非 BMP）。
		goldenFind("search/substring/empty-text", "cat", "substring", true, false, ""),
		goldenFind("search/substring/emoji", "😀", "substring", true, false, "a😀b😀"),
		goldenFind("search/substring/emoji-ci", "😀", "substring", false, false, "😀😀"),
		goldenFind("search/substring/emoji-whole-word", "😀", "substring", true, true, "a😀 😀b 😀"),
		goldenFind("search/substring/cjk-ext-b", "\U00020000", "substring", true, false, "x\U00020000y\U00020000"),
		goldenFind("search/substring/cjk-ext-b-whole-word", "\U00020000", "substring", true, true, "a\U00020000 \U00020000a \U00020000"),
		goldenFind("search/substring/mixed-scripts", "猫cat", "substring", true, false, "猫cat猫cat"),

		// 大小写不敏感 substring 的 O(1) 长度预筛。
		goldenFind("search/substring/fast-fail/empty", strings.Repeat("ä", 10), "substring", false, false, ""),
		goldenFind("search/substring/fast-fail/one-rune", strings.Repeat("ä", 10), "substring", false, false, "ä"),
		goldenFind("search/substring/fast-fail/nine-runes", strings.Repeat("ä", 10), "substring", false, false, strings.Repeat("a", 9)),
		goldenFind("search/substring/fast-fail/short", strings.Repeat("ä", 10), "substring", false, false, "a"),
		goldenFind("search/substring/fast-fail/exact", strings.Repeat("ä", 10), "substring", false, false, strings.Repeat("ä", 10)),

		// 非法 UTF-8 经 JSON 归一为 U+FFFD 后仍可对拍的方向。
		goldenFind("search/substring/replacement-char-text", "cat", "substring", true, false, "\uFFFDcat"),
		goldenFind("search/substring/replacement-char-ci", "\uFFFD", "substring", false, false, "\uFFFD\uFFFD"),
	})...)

	// ---- SimpleFold 折叠环关键等价关系 ----
	cases = append(cases, runGoldenFind(t, []goldenFindCase{
		goldenFind("search/substring/fold/long-s-matches-s", "ſ", "substring", false, false, "s"),
		goldenFind("search/substring/fold/s-matches-long-s", "s", "substring", false, false, "ſ"),
		goldenFind("search/substring/fold/long-s-matches-S", "ſ", "substring", false, false, "S"),
		goldenFind("search/substring/fold/kelvin-matches-k", "\u212A", "substring", false, false, "k"),
		goldenFind("search/substring/fold/k-matches-kelvin", "k", "substring", false, false, "\u212A"),
		goldenFind("search/substring/fold/kelvin-matches-K", "\u212A", "substring", false, false, "K"),
		goldenFind("search/substring/fold/sharp-s-matches-capital", "ß", "substring", false, false, "ẞ"),
		goldenFind("search/substring/fold/capital-sharp-s-matches", "ẞ", "substring", false, false, "ß"),
		goldenFind("search/substring/fold/sharp-s-not-ss", "ß", "substring", false, false, "SS"),
		goldenFind("search/substring/fold/ss-not-sharp-s", "SS", "substring", false, false, "ß"),
		goldenFind("search/substring/fold/strasse-not-strasse", "strasse", "substring", false, false, "Straße"),
		goldenFind("search/substring/fold/micro-matches-mu", "\u00B5", "substring", false, false, "\u03BC"),
		goldenFind("search/substring/fold/mu-matches-micro", "\u03BC", "substring", false, false, "\u00B5"),
		goldenFind("search/substring/fold/micro-matches-capital-mu", "\u00B5", "substring", false, false, "\u039C"),
		goldenFind("search/substring/fold/omega-matches-ohm", "\u03A9", "substring", false, false, "\u2126"),
		goldenFind("search/substring/fold/ohm-matches-omega", "\u2126", "substring", false, false, "\u03C9"),
		goldenFind("search/substring/fold/omega-matches-small-omega", "\u03A9", "substring", false, false, "\u03C9"),
		// U+0130 / U+0131 没有 simple case fold 伙伴：JS toLowerCase 会误判。
		goldenFind("search/substring/fold/dotted-capital-i-no-match", "\u0130", "substring", false, false, "i"),
		goldenFind("search/substring/fold/dotless-i-no-match", "\u0131", "substring", false, false, "I"),
		goldenFind("search/substring/fold/greek-sigma", "ΣΟΦΟΣ", "substring", false, false, "σοφος ςοφοσ"),
		goldenFind("search/substring/fold/k-multiple", "k", "substring", false, false, "K\u212Ak"),
		goldenFind("search/substring/fold/umlaut", "ä", "substring", false, false, "Ää"),
	})...)

	// ---- regex：segmatch_test.go 的全部边界用例 ----
	cases = append(cases, runGoldenFind(t, []goldenFindCase{
		goldenFind("search/regex/basic", `\d+`, "regex", true, false, "a12 b3"),
		goldenFind("search/regex/case-insensitive", "cat", "regex", false, false, "CAT cat"),
		goldenFind("search/regex/whole-word", "cat", "regex", true, true, "concatenate cat, cat2 cat"),
		goldenFind("search/regex/whole-word-unicode", "cat", "regex", true, true, "猫cat猫 cat，狗"),
		goldenFind("search/regex/whole-word-global", `b+`, "regex", true, true, "abb aab bb"),
		goldenFind("search/regex/whole-word-caret-star", `^a*`, "regex", true, true, "x a"),
		goldenFind("search/regex/whole-word-zero-width-caret", `^`, "regex", true, true, "a  b"),
		goldenFind("search/regex/whole-word-begin-text", `\Aa*`, "regex", true, true, "x a"),
		goldenFind("search/regex/whole-word-word-boundary", `;c+|\bc+`, "regex", true, true, "xc;cc"),
		goldenFind("search/regex/whole-word-capture", `(\d+)px`, "regex", true, true, "12px 5pxl"),
		goldenFind("search/regex/alternation", "cat|dog", "regex", true, false, "concat cat dog"),

		// 整词预筛只是必要条件：`a|ab` 的包裹正则能命中，但全局左最先提交 `a`
		// 后又被整词过滤，Find 必须为空且 HasMatch 一致为假。
		goldenFind("search/regex/whole-word-alternation-prefilter", `a|ab`, "regex", true, true, "ab"),
		goldenFind("search/regex/whole-word-alternation-longest", `ab|a`, "regex", true, true, "ab"),

		// 零宽匹配：Go allMatches 的「紧跟上一匹配的空匹配被拒绝」语义。
		goldenFind("search/regex/zero-width-whole-word", `\d*`, "regex", true, true, " a "),
		goldenFind("search/regex/zero-width-whole-word-rejected", `\d*`, "regex", true, true, "ab"),
		goldenFind("search/regex/zero-width", `x*`, "regex", true, false, "ab"),
		goldenFind("search/regex/zero-width-star", `a*`, "regex", true, false, "bab"),
		goldenFind("search/regex/empty-pattern", "", "regex", true, false, "abc"),
		goldenFind("search/regex/empty-pattern-empty-text", "", "regex", true, false, ""),
		goldenFind("search/regex/word-boundary", `\b`, "regex", true, false, "ab"),
		goldenFind("search/regex/whole-word-empty-text", `^`, "regex", true, true, ""),

		// emoji / 非 BMP 的码点偏移。
		goldenFind("search/regex/dot-emoji", ".", "regex", true, false, "😀"),
		goldenFind("search/regex/star-emoji", `x*`, "regex", true, false, "😀x"),
		goldenFind("search/regex/emoji-literal", "😀", "regex", true, false, "a😀b"),
		goldenFind("search/regex/cjk-ext-b", "\U00020000", "regex", true, false, "x\U00020000y"),
		goldenFind("search/regex/whole-word-cjk-ext-b", "\U00020000", "regex", true, true, "a\U00020000 \U00020000a \U00020000"),

		// inline flag / Unicode 类别 / 命名组 / 锚点。
		goldenFind("search/regex/inline-flag", "(?i)cat", "regex", true, false, "CAT cat"),
		goldenFind("search/regex/unicode-letter", `\p{L}+`, "regex", true, false, "abc 猫 123"),
		goldenFind("search/regex/unicode-letter-astral", `\p{L}+`, "regex", true, false, "\U00020000a 1"),
		goldenFind("search/regex/named-group", `(?P<num>\d+)`, "regex", true, false, "a12"),
		goldenFind("search/regex/anchor-start", `^a`, "regex", true, false, "a\nab"),
		goldenFind("search/regex/multiline", `(?m)^a`, "regex", true, false, "a\nab"),
		goldenFind("search/regex/end-anchor", `a$`, "regex", true, false, "ba"),
		goldenFind("search/regex/end-anchor-zero-width", `$`, "regex", true, false, "ab"),
		goldenFind("search/regex/end-anchor-not-before-final-newline", `a$`, "regex", true, false, "a\n"),
		goldenFind("search/regex/multiline-end-anchor", `(?m)a$`, "regex", true, false, "a\nab"),
		goldenFind("search/regex/end-text", `a\z`, "regex", true, false, "a\n"),
		goldenFind("search/regex/dot-newline", ".", "regex", true, false, "a\nb"),
		goldenFind("search/regex/dotall-newline", "(?s).", "regex", true, false, "a\nb"),
		goldenFind("search/regex/space-class", `\s+`, "regex", true, false, "a\tb\u00A0c d"),
		goldenFind("search/regex/word-class", `\w+`, "regex", true, false, "a_1-猫"),
		goldenFind("search/regex/begin-text", `\Aab`, "regex", true, false, "ab"),
		goldenFind("search/regex/word-boundary-both", `\bcat\b`, "regex", true, false, "cat concatenate"),
		goldenFind("search/regex/non-word-boundary", `\Bcat`, "regex", true, false, "concat cat"),
		goldenFind("search/regex/alternation-group", `foo|(bar)`, "regex", true, false, "foo bar"),

		// 整词边界：`_` / `-` 不是词字符。
		goldenFind("search/regex/whole-word-underscore", "cat", "regex", true, true, "cat_ _cat"),
		goldenFind("search/regex/whole-word-hyphen", "cat", "regex", true, true, "cat- -cat"),

		// 大小写不敏感 regex 同样走 SimpleFold（ß↔ẞ，不展开为 SS）。
		goldenFind("search/regex/case-insensitive-fold", "straße", "regex", false, false, "STRASSE STRAẞE Straße"),
	})...)

	// ---- 整词边界：Nl / No 不是词字符（\p{Nd} 而非 \p{N}） ----
	for _, caseSensitive := range []bool{true, false} {
		mode := "sensitive"
		if !caseSensitive {
			mode = "insensitive"
		}
		cases = append(cases, runGoldenFind(t, []goldenFindCase{
			goldenFind("search/regex/nl-no/"+mode+"/nl-before", "cat", "regex", caseSensitive, true, "Ⅻcat"),
			goldenFind("search/regex/nl-no/"+mode+"/no-before", "cat", "regex", caseSensitive, true, "½cat"),
			goldenFind("search/regex/nl-no/"+mode+"/nl-after", "cat", "regex", caseSensitive, true, "catⅫ"),
			goldenFind("search/regex/nl-no/"+mode+"/no-after", "cat", "regex", caseSensitive, true, "cat½"),
			goldenFind("search/regex/nl-no/"+mode+"/nd-rejects", "cat", "regex", caseSensitive, true, "1cat"),
			goldenFind("search/regex/nl-no/"+mode+"/letter-rejects", "cat", "regex", caseSensitive, true, "acat"),
		})...)
	}

	// ---- HasMatch 与 Find 的布尔一致性矩阵（对齐 TestHasMatchConsistentWithFind） ----
	matrixTexts := []string{
		"", "a", "ab", "aab", "ab ab", "x a", " a ",
		"concatenate cat, cat2 cat", "猫cat猫 cat，狗", "CAT cat",
	}
	matrixSubstring := []string{"cat", "a", ""}
	matrixRegex := []string{`\d*`, `^a`, `a|ab`, `\bcat\b`}
	var matrix []goldenFindCase
	for _, caseSensitive := range []bool{true, false} {
		for _, wholeWord := range []bool{true, false} {
			for pi, find := range matrixSubstring {
				for ti, text := range matrixTexts {
					id := fmt.Sprintf("search/matrix/substring/p%d/t%d/cs%v-ww%v", pi, ti, caseSensitive, wholeWord)
					matrix = append(matrix, goldenFind(id, find, "substring", caseSensitive, wholeWord, text))
				}
			}
			for pi, find := range matrixRegex {
				for ti, text := range matrixTexts {
					id := fmt.Sprintf("search/matrix/regex/p%d/t%d/cs%v-ww%v", pi, ti, caseSensitive, wholeWord)
					matrix = append(matrix, goldenFind(id, find, "regex", caseSensitive, wholeWord, text))
				}
			}
		}
	}
	cases = append(cases, runGoldenFind(t, matrix)...)

	// ---- 空 MatchMode 等价于 "substring"（Go `case "", "substring":`） ----
	cases = append(cases, runGoldenFind(t, []goldenFindCase{
		goldenFind("search/substring/default-mode", "cat", "", true, false, "a cat"),
		goldenFind("search/regex/default-mode", "cat", "", true, false, "a cat"),
		goldenFind("search/substring/default-mode-ci", "cat", "", false, true, "CAT concatenate cat"),
	})...)

	// ---- 替换：substring 字面量替换 ----
	cases = append(cases, runGoldenReplace(t, []goldenReplaceCase{
		goldenReplace("search/replace/substring/basic", "cat", "substring", true, false, "cat and cat", "dog"),
		goldenReplace("search/replace/substring/delete", "-", "substring", true, false, "a-b-c", ""),
		goldenReplace("search/replace/substring/empty-find", "", "substring", true, false, "abc", "x"),
		goldenReplace("search/replace/substring/case-insensitive", "ä", "substring", false, false, "Ää", "a"),
		goldenReplace("search/replace/substring/whole-word", "cat", "substring", true, true, "concatenate cat, cat2 cat", "dog"),
		goldenReplace("search/replace/substring/emoji", "😀", "substring", true, false, "a😀b", "🙂"),
	})...)

	// ---- 替换：regex ExpandString ----
	cases = append(cases, runGoldenReplace(t, []goldenReplaceCase{
		goldenReplace("search/replace/regex/capture", `(\w+)-(\w+)`, "regex", true, false, "first-last second-item", `${2},$1`),
		goldenReplace("search/replace/regex/whole-word", "cat", "regex", true, true, "concatenate cat, cat2 cat", "dog"),
		goldenReplace("search/replace/regex/whole-word-capture", `(\d+)px`, "regex", true, true, "12px 5pxl", "${1}em"),
		goldenReplace("search/replace/regex/named", `(?P<num>\d+)-(?P<unit>\w+)`, "regex", true, false, "12-px 8-em", "${unit}${num}"),
		goldenReplace("search/replace/regex/zero-width", `x*`, "regex", true, false, "ab", "-"),
		goldenReplace("search/replace/regex/zero-width-capture", `(\d)*`, "regex", true, false, "a1b", "<$1>"),
		goldenReplace("search/replace/regex/non-participating", `foo|(bar)`, "regex", true, false, "foo bar", "[$1]"),
		goldenReplace("search/replace/regex/empty-pattern", "", "regex", true, false, "abc", "-"),
		goldenReplace("search/replace/regex/word-boundary", `\b`, "regex", true, false, "ab", "|"),
		goldenReplace("search/replace/regex/whole-word-zero-width", `\d*`, "regex", true, true, " a ", "#"),
		goldenReplace("search/replace/regex/whole-word-unicode", "cat", "regex", true, true, "猫cat猫 cat，狗", "dog"),
		goldenReplace("search/replace/regex/case-insensitive", "cat", "regex", false, false, "CAT cat", "dog"),
	})...)

	// ---- 替换展开：Go Regexp.ExpandString 的逐字符语义 ----
	cases = append(cases, runGoldenReplace(t, []goldenReplaceCase{
		goldenReplace("search/replace/expand/dollar-dollar", `(\w+)-(\w+)`, "regex", true, false, "a-b", "$$"),
		goldenReplace("search/replace/expand/group-zero", `(\w+)-(\w+)`, "regex", true, false, "a-b", "$0"),
		goldenReplace("search/replace/expand/name-suffix", `(\w+)-(\w+)`, "regex", true, false, "a-b", "$1x"),
		goldenReplace("search/replace/expand/leading-zero", `(\w+)-(\w+)`, "regex", true, false, "a-b", "$01"),
		goldenReplace("search/replace/expand/trailing-dollar", `(\w+)-(\w+)`, "regex", true, false, "a-b", "$"),
		goldenReplace("search/replace/expand/dollar-dollar-digit", `(\w+)-(\w+)`, "regex", true, false, "a-b", "$$1"),
		goldenReplace("search/replace/expand/unknown-name", `(?P<x>a)(?P<y>b)?`, "regex", true, false, "a", "$z"),
		goldenReplace("search/replace/expand/named-both", `(?P<x>a)(?P<y>b)?`, "regex", true, false, "a", "[$x][$y][${x}][${y}]"),
		goldenReplace("search/replace/expand/malformed-brace", `(?P<x>a)(?P<y>b)?`, "regex", true, false, "a", "${x"),
		goldenReplace("search/replace/expand/groups-concat", `(\w+)-(\w+)`, "regex", true, false, "a-b", "$2$1"),
		goldenReplace("search/replace/expand/backslash", `(\w+)-(\w+)`, "regex", true, false, "a-b", `\$1\`),
		goldenReplace("search/replace/expand/group-ten", `(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)`, "regex", true, false, "abcdefghij", "$10"),
		goldenReplace("search/replace/expand/group-out-of-range", `(a)`, "regex", true, false, "a", "$2"),
		goldenReplace("search/replace/expand/brace-num", `(\w+)-(\w+)`, "regex", true, false, "a-b", "${2},${1}"),
		goldenReplace("search/replace/expand/dollar-non-name", `(\w+)-(\w+)`, "regex", true, false, "a-b", "$-1"),
		goldenReplace("search/replace/expand/empty-brace", `(\w+)-(\w+)`, "regex", true, false, "a-b", "${}"),
		goldenReplace("search/replace/substring/dollar-literal", "a", "substring", true, false, "a", "$1"),
	})...)

	// ---- candidateLiteral：字面量锚点 ----
	cases = append(cases, runGoldenCandidate(t, []goldenCandidateCase{
		goldenCandidate("search/candidate/substring/case-sensitive", "CaT", "substring", true, false),
		goldenCandidate("search/candidate/substring/case-insensitive", "CaT", "substring", false, false),
		goldenCandidate("search/candidate/substring/empty", "", "substring", true, false),
		goldenCandidate("search/candidate/regex/literal", "CaT", "regex", true, false),
		goldenCandidate("search/candidate/regex/prefix", `cats?`, "regex", true, false),
		goldenCandidate("search/candidate/regex/non-literal-start", `\d+cat`, "regex", true, false),
		goldenCandidate("search/candidate/regex/case-insensitive", "CaT", "regex", false, false),
		goldenCandidate("search/candidate/regex/empty", "", "regex", true, false),
		goldenCandidate("search/candidate/regex/alternation", `cat|dog`, "regex", true, false),
		goldenCandidate("search/candidate/regex/alternation-common-prefix", `abc|abd`, "regex", true, false),
		goldenCandidate("search/candidate/regex/capture-group", `(cat)dog`, "regex", true, false),
		goldenCandidate("search/candidate/regex/non-capturing", `(?:cat)`, "regex", true, false),
		goldenCandidate("search/candidate/regex/capture-inside", `a(b)c`, "regex", true, false),
		goldenCandidate("search/candidate/regex/single-char-class", `[a]`, "regex", true, false),
		goldenCandidate("search/candidate/regex/multi-char-class", `[ab]`, "regex", true, false),
		goldenCandidate("search/candidate/regex/fixed-repeat", `a{3}`, "regex", true, false),
		goldenCandidate("search/candidate/regex/plus", `a+`, "regex", true, false),
		goldenCandidate("search/candidate/regex/inline-fold", `(?i)cat`, "regex", true, false),
		goldenCandidate("search/candidate/regex/fold-midway", `a(?i)bc`, "regex", true, false),
		goldenCandidate("search/candidate/regex/quoted", `\Qa.b\E`, "regex", true, false),
		goldenCandidate("search/candidate/regex/named-group", `(?P<n>cat)x`, "regex", true, false),
		goldenCandidate("search/candidate/regex/escaped-dot", `a\.b`, "regex", true, false),
		goldenCandidate("search/candidate/regex/emoji", "😀x", "regex", true, false),
		goldenCandidate("search/candidate/regex/unicode-class", `\p{L}cat`, "regex", true, false),
		goldenCandidate("search/candidate/regex/hex-escape", `\x41bc`, "regex", true, false),
		goldenCandidate("search/candidate/regex/two-captures", `(a)(b)`, "regex", true, false),
		goldenCandidate("search/candidate/regex/factored-non-capturing", `(?:ab|ac)`, "regex", true, false),
		goldenCandidate("search/candidate/regex/no-common-prefix", `(?:cat|dog)`, "regex", true, false),
		goldenCandidate("search/candidate/regex/dotall", `(?s)a.b`, "regex", true, false),
		goldenCandidate("search/candidate/regex/star", `x*`, "regex", true, false),
		goldenCandidate("search/candidate/regex/word-boundary", `\bcat`, "regex", true, false),
		goldenCandidate("search/candidate/regex/multiline-anchor", `(?m)^cat`, "regex", true, false),
		goldenCandidate("search/candidate/regex/anchored-literal", `^cat`, "regex", true, false),
		goldenCandidate("search/candidate/regex/anchored-non-capturing", `^(?:cat)`, "regex", true, false),
		goldenCandidate("search/candidate/regex/anchored-wrapped", `(?:^a)`, "regex", true, false),
		goldenCandidate("search/candidate/regex/anchored-fixed-repeat", `^a{3}`, "regex", true, false),
		goldenCandidate("search/candidate/regex/anchored-end", `^cat$`, "regex", true, false),
		goldenCandidate("search/candidate/regex/anchored-begin-text", `\Aab`, "regex", true, false),
		goldenCandidate("search/candidate/regex/whole-word", `cats?`, "regex", true, true),
	})...)

	// ---- 错误 ----
	cases = append(cases, runGoldenError(t, []goldenErrorCase{
		goldenError("search/error/invalid-regex", "[", "regex"),
		goldenError("search/error/invalid-regex-group", "(?P<n>a", "regex"),
		goldenError("search/error/too-long-ascii", strings.Repeat("a", MaxPatternRunes+1), "substring"),
		goldenError("search/error/too-long-multibyte", strings.Repeat("猫", MaxPatternRunes+1), "regex"),
		goldenError("search/error/too-long-invalid-regex", strings.Repeat("[", MaxPatternRunes+1), "regex"),
		goldenError("search/error/unsupported-mode", "x", "glob"),
		goldenError("search/error/default-mode-ok", "x", ""),
		goldenError("search/error/at-limit-ascii", strings.Repeat("a", MaxPatternRunes), "regex"),
		goldenError("search/error/at-limit-multibyte", strings.Repeat("猫", MaxPatternRunes), "substring"),
		goldenError("search/error/empty-regex", "", "regex"),
	})...)

	written, err := goldenv.Write(out, "search", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("已写入 %d 条 search 黄金向量到 %s", written, out)
}
