package script

import (
	"testing"
	"unicode/utf8"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// nonNilScripts 把 nil 切片归一为空切片（Go 的 nil slice 序列化后是 null，
// TS 侧统一用空数组表达「无结果」）。
func nonNilScripts(v []Script) []Script {
	if v == nil {
		return []Script{}
	}
	return v
}

// TestGoldenVectors 导出 script 包的黄金测试向量。
//
// 覆盖 script_test.go / scan_test.go / han_test.go 的全部边界用例：
//   - Resolve 的显式 script、region 推断、likely-subtags 兜底、大小写/下划线容错
//     与全部 false 用例；
//   - DisplayName 的全部已知码与未知码；
//   - Scan 的证据计数、首 run 采样、12 rune 截断、并列决胜、两栖字豁免；
//   - runeScript 的全部正负用例（含两栖字与管辖外文字）；
//   - 生成表原样导出（保证 TS 常量表与 Go 逐字节一致）。
//
// 仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘；常规 go test 不产生副作用。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	var cases []goldenv.Case

	// ---- Resolve ----
	resolveLangs := []string{
		// 显式 script 子标签
		"zh-Hans", "zh-Hant", "sr-Latn",
		// region 参与 script 推断
		"zh-TW", "zh-CN",
		// likely-subtags 兜底
		"zh", "sr", "uz", "kk", "az", "mn", "pa", "ms", "ug", "ku", "tg",
		// cmn 为汉语的 ISO 639-3 码，与 zh 同义
		"cmn", "cmn-Hant",
		// 大小写、空白、下划线容错
		"ZH-HANS", "zh_hans", " zh-CN ",
		// 期望 script 不在该语言的注册表集合内 / 显式覆盖
		"pa-Arab",
		// false 用例：单文字系统语言不在注册表
		"en", "fr", "ja", "ko", "ru", "th",
		// false 用例：特殊与垃圾输入
		"auto", "AUTO", "", "  ", "!!!",
		// 额外边界：未知语言、und、显式不相容 script、多级 tag
		"und", "de-DE", "zh-Latn", "zh-Hans-CN", "sr-Cyrl-ME", "uz-Arab", "mn-Mong",
	}
	for _, lang := range resolveLangs {
		profile, ok := Resolve(lang)
		cases = append(cases, goldenv.Case{
			ID:     "script/resolve/" + langID(lang),
			Op:     "script.resolve",
			Args:   goldenv.Args("lang", lang),
			Expect: goldenv.Expect("ok", ok, "language", profile.Language, "expected", string(profile.Expected), "siblings", nonNilScripts(profile.Siblings)),
		})
	}

	// ---- DisplayName ----
	displayCases := []struct {
		id     string
		script Script
	}{
		{"hans", Hans},
		{"hant", Hant},
		{"latn", Latn},
		{"cyrl", Cyrl},
		{"arab", Arab},
		{"mong", Mong},
		{"guru", Guru},
		{"unknown", "Zzzz"},
		{"empty", ""},
	}
	for _, tc := range displayCases {
		cases = append(cases, goldenv.Case{
			ID:     "script/display-name/" + tc.id,
			Op:     "script.display_name",
			Args:   goldenv.Args("script", string(tc.script)),
			Expect: goldenv.Expect("name", tc.script.DisplayName()),
		})
	}

	// ---- Scan ----
	zhHans := Profile{Language: "zh", Expected: Hans, Siblings: []Script{Hant}}
	zhHant := Profile{Language: "zh", Expected: Hant, Siblings: []Script{Hans}}
	srLatn := Profile{Language: "sr", Expected: Latn, Siblings: []Script{Cyrl}}
	srCyrl := Profile{Language: "sr", Expected: Cyrl, Siblings: []Script{Latn}}
	uz := Profile{Language: "uz", Expected: Latn, Siblings: []Script{Cyrl, Arab}}

	scanCases := []struct {
		id      string
		profile Profile
		text    string
	}{
		{"zh-hans/pure-hant", zhHans, "這是簡體字測試的繁體版本"},
		{"zh-hans/pure-hans", zhHans, "这是测试"},
		{"zh-hans/shared-only", zhHans, "人山川的"},
		{"zh-hans/single-hant-mixed", zhHans, "这是测试,裡面有一个繁体字"},
		{"zh-hans/ascii-neutral", zhHans, "Hello World 123 !? <html>"},
		{"zh-hans/sample-first-run", zhHans, "裡一裡"},
		{"zh-hans/amphibious-traditional", zhHans, "台灣批准游泳長征山峰文采"},
		{"zh-hant/amphibious-simplified", zhHant, "台湾批准游泳长征山峰文采"},
		{"zh-hans/amphibious-not-masking", zhHans, "這是台灣"},
		{"zh-hant/simplified-evidence", zhHant, "这里应该是繁体"},
		{"sr-latn/mixed-cyrillic", srLatn, "Dobro došli Жељко"},
		{"sr-latn/long-sample-truncated", srLatn, "ABCDEFGHIJKLMNO"},
		{"sr-cyrl/latin-evidence", srCyrl, "Привет hello"},
		{"uz/tie-break", uz, "وا ЖЖ"},
		{"uz/count-wins", uz, "Привет مرحبا"},
		{"empty-profile", Profile{}, "任何文本 見ЖA"},
		{"empty-text", zhHans, ""},
		{"emoji-and-neutral", zhHans, "🎉🎉🎉"},
		{"cjk-compat", zhHans, "這裡體時"},
	}
	for _, tc := range scanCases {
		ev, ok := tc.profile.Scan(tc.text)
		if !ok {
			ev = Evidence{}
		}
		cases = append(cases, goldenv.Case{
			ID:   "script/scan/" + tc.id,
			Op:   "script.scan",
			Args: goldenv.Args("text", tc.text, "profile", goldenv.Args("language", tc.profile.Language, "expected", string(tc.profile.Expected), "siblings", nonNilScripts(tc.profile.Siblings))),
			Expect: goldenv.Expect(
				"ok", ok,
				"script", string(ev.Script),
				"count", ev.Count,
				"sample", ev.Sample,
			),
		})
	}

	// ---- runeScript ----
	runeCases := []struct {
		id   string
		r    rune
		name string
	}{
		{"hant-jian", '見', "見"},
		{"hant-yu", '語', "語"},
		{"hant-zhe", '這', "這"},
		{"hans-jian", '见', "见"},
		{"hans-yu", '语', "语"},
		{"hans-zhe", '这', "这"},
		{"shared-de", '的', "的"},
		{"shared-ren", '人', "人"},
		{"shared-zhu", '著', "著"},
		{"override-qian", '乾', "乾"},
		{"override-zhun", '准', "准"},
		{"override-tai", '台', "台"},
		{"override-you", '游', "游"},
		{"latin-A", 'A', "A"},
		{"latin-z", 'ž', "ž"},
		{"cyrl-zh", 'Ж', "Ж"},
		{"cyrl-lj", 'љ', "љ"},
		{"arab-alef", 'ا', "ا"},
		{"mong-a", 'ᠠ', "ᠠ"},
		{"guru-ga", 'ਗ', "ਗ"},
		{"digit", '1', "1"},
		{"cjk-punct", '。', "。"},
		{"ascii-punct", '!', "!"},
		{"combining-acute", 0x0301, "\u0301"},
		{"greek-omega", 'Ω', "Ω"},
		{"hiragana-hi", 'ひ', "ひ"},
		{"emoji", '🎉', "🎉"},
		{"supplementary-han", 0x2003E, "\U0002003E"},
	}
	for _, tc := range runeCases {
		sc, ok := runeScript(tc.r)
		cases = append(cases, goldenv.Case{
			ID:     "script/rune/" + tc.id,
			Op:     "script.rune_script",
			Args:   goldenv.Args("rune", tc.name),
			Expect: goldenv.Expect("ok", ok, "script", string(sc)),
		})
	}

	// ---- 生成表原样导出 ----
	for _, tbl := range []struct {
		id    string
		which string
		chars string
	}{
		{"script/tables/hans", "hans", hansSpecificChars},
		{"script/tables/hant", "hant", hantSpecificChars},
	} {
		cases = append(cases, goldenv.Case{
			ID:   tbl.id,
			Op:   "script.tables",
			Args: goldenv.Args("which", tbl.which),
			Expect: goldenv.Expect(
				"chars", tbl.chars,
				"count", utf8.RuneCountInString(tbl.chars),
				"first", string([]rune(tbl.chars)[0]),
				"last", string([]rune(tbl.chars)[len([]rune(tbl.chars))-1]),
			),
		})
	}

	n, err := goldenv.Write(out, "script", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("script 黄金向量已导出: %d 条 → %s/script.json", n, out)
}

// langID 把语言 tag 规范化为稳定的用例 ID 片段（仅保留字母数字与连字符）。
func langID(lang string) string {
	if lang == "" {
		return "empty"
	}
	out := make([]rune, 0, len(lang))
	for _, r := range lang {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			out = append(out, r)
		case r == '-' || r == '_':
			out = append(out, '-')
		default:
			out = append(out, 'x')
		}
	}
	return string(out)
}
