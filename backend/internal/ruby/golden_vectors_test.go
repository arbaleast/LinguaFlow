package ruby

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// thisItem 把 Item 投影为包含运行态 Aligned 的完整 JSON 形态。
func thisItem(it Item) map[string]any {
	return goldenv.Expect(
		"id", it.ID,
		"source_base", it.SourceBase,
		"source_text", it.SourceText,
		"target_base", it.TargetBase,
		"target_text", it.TargetText,
		"kind", it.Kind,
		"aligned", it.Aligned,
	)
}

// thisItems 批量投影并归一化 nil 切片。
func thisItems(items []Item) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		out = append(out, thisItem(it))
	}
	return out
}

// thisEntry 把 OutputEntry 投影为包含运行态 Invalid 的完整 JSON 形态。
func thisEntry(e OutputEntry) map[string]any {
	return goldenv.Expect(
		"base", e.Base,
		"text", e.Text,
		"kind", e.Kind,
		"id", e.ID,
		"occurrence", e.Occurrence,
		"invalid", e.Invalid,
	)
}

// thisEntries 批量投影并归一化 nil 切片。
func thisEntries(entries []OutputEntry) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, thisEntry(e))
	}
	return out
}

// thisRestore 投影还原统计。
func thisRestore(r RestoreResult) map[string]any {
	return goldenv.Expect("matched", r.Matched, "total", r.Total)
}

// stateJSON 把 AlignmentState 序列化为与 json.Marshal 完全一致的 JSON 值。
func stateJSON(t *testing.T, s *AlignmentState) any {
	t.Helper()
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("序列化 AlignmentState 失败: %v", err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("反序列化 AlignmentState 失败: %v", err)
	}
	return out
}

// applyCase 描述一条 ApplyOutput 用例。
type applyCase struct {
	id        string
	trans     string
	format    string
	items     []Item
	keep      map[string]bool
	protocol  int
	requested []string
	entries   []OutputEntry
	require   bool
}

// TestGoldenVectors 导出 ruby 包的黄金向量。
//
// 覆盖 item.go / restorer.go / alignment.go / alignment_regions.go /
// alignment_protocol.go / alignment_legacy.go 以及对应 *_test.go 的全部边界用例。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}
	cases := []goldenv.Case{}

	// ---- item.go ----
	assignItems := []Item{{SourceBase: "我"}, {ID: "9", SourceBase: "想"}, {SourceBase: "要"}}
	assigned := AssignIDs(assignItems)
	ids := make([]string, 0, len(assigned))
	for _, it := range assigned {
		ids = append(ids, it.ID)
	}
	cases = append(cases, goldenv.Case{
		ID: "item/assign-ids", Op: "ruby.assign_ids",
		Args:   goldenv.Args("items", []map[string]any{thisItem(Item{}), thisItem(Item{ID: "9"}), thisItem(Item{})}),
		Expect: goldenv.Expect("ids", ids),
	})

	byIDItems := []Item{{ID: "1", SourceBase: "我"}, {ID: "2", SourceBase: "想"}, {SourceBase: "要"}}
	byID := ItemsByID(byIDItems)
	byIDMap := map[string]string{}
	for id, it := range byID {
		byIDMap[id] = it.SourceBase
	}
	cases = append(cases, goldenv.Case{
		ID: "item/items-by-id", Op: "ruby.items_by_id",
		Args:   goldenv.Args("items", thisItems(byIDItems)),
		Expect: goldenv.Expect("map", byIDMap),
	})

	mergeCases := []struct {
		id     string
		items  []Item
		output []OutputEntry
	}{
		{"item/merge-id-match", []Item{{ID: "1"}, {ID: "2"}, {ID: "3"}}, []OutputEntry{
			{Base: "I", Text: "aɪ", Kind: "phonetic", ID: "1"},
			{Base: "want", Text: "wɒnt", Kind: "phonetic", ID: "2"},
			{Base: "water", Text: "wɔːtər", Kind: "phonetic", ID: "3"},
		}},
		{"item/merge-restructure", []Item{
			{ID: "1", SourceBase: "我"}, {ID: "2", SourceBase: "想"}, {ID: "3", SourceBase: "要"},
			{ID: "4", SourceBase: "一"}, {ID: "5", SourceBase: "杯"}, {ID: "6", SourceBase: "水"},
		}, []OutputEntry{
			{Base: "I", Text: "aɪ", Kind: "phonetic", ID: "1"},
			{Base: "want", Text: "wɒnt", Kind: "phonetic", ID: "3"},
			{Base: "water", Text: "wɔːtər", Kind: "phonetic", ID: "5"},
		}},
		{"item/merge-positional", []Item{{ID: "1"}, {ID: "2"}, {ID: "3"}}, []OutputEntry{
			{Base: "I", Text: "aɪ", Kind: "phonetic"},
			{Base: "want", Text: "wɒnt", Kind: "phonetic"},
			{Base: "water", Text: "wɔːtər", Kind: "phonetic"},
		}},
		{"item/merge-unknown-dup", []Item{{ID: "1"}, {ID: "2"}, {ID: "3"}}, []OutputEntry{
			{Base: "first", Text: "f", Kind: "phonetic", ID: "1"},
			{Base: "dup", Text: "d", Kind: "phonetic", ID: "1"},
			{Base: "x", Text: "x", Kind: "phonetic", ID: "99"},
			{Base: "w", Text: "w", Kind: "phonetic", ID: "2"},
		}},
		{"item/merge-no-free-item", []Item{{ID: "1"}}, []OutputEntry{
			{Base: "a", Text: "a", ID: "1"},
			{Base: "b", Text: "b", ID: "1"},
		}},
		{"item/merge-id-whitespace", []Item{{ID: "1"}, {ID: "2"}}, []OutputEntry{
			{Base: "I", Text: "aɪ", Kind: "phonetic", ID: " 1 "},
			{Base: "w", Text: "w", Kind: "phonetic", ID: "   "},
		}},
		{"item/merge-empty-base", []Item{{ID: "1"}, {ID: "2"}}, []OutputEntry{
			{Base: "", Text: "x", Kind: "phonetic", ID: "2"},
			{Base: "I", Text: "aɪ", Kind: "phonetic", ID: "1"},
		}},
		{"item/merge-hash-prefix", []Item{
			{ID: "1", SourceBase: "雷神皇", SourceText: "カミナリサマ"},
			{ID: "2", SourceBase: "戳", SourceText: "たた"},
		}, ParseSectionRubyOutput([]string{
			"1: 雷神皇 | 雷神大人 | creative | #1",
			"1: 戳 | たた | phonetic | #2",
		})["1"]},
	}
	for _, tc := range mergeCases {
		items := append([]Item(nil), tc.items...)
		MergeByOutput(items, tc.output)
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.merge_by_output",
			Args: goldenv.Args("items", thisItems(tc.items), "output", thisEntries(tc.output)),
			Expect: goldenv.Expect(
				"items", thisItems(items),
				"unaligned", thisItems(Unaligned(items)),
			),
		})
	}

	unalignedItems := []Item{{ID: "1", Aligned: true}, {ID: "2"}, {ID: "3", Aligned: true}, {ID: "4"}}
	cases = append(cases, goldenv.Case{
		ID: "item/unaligned", Op: "ruby.unaligned",
		Args:   goldenv.Args("items", thisItems(unalignedItems)),
		Expect: goldenv.Expect("items", thisItems(Unaligned(unalignedItems))),
	})

	// ---- restorer.go ----
	restoreCases := []struct {
		id     string
		target string
		items  []Item
	}{
		{"restore/source-fallback", "我喝水。", []Item{
			{ID: "1", SourceBase: "我", SourceText: "wǒ", TargetBase: "I", TargetText: "aɪ", Kind: "phonetic"},
			{ID: "2", SourceBase: "杯", SourceText: "bēi", TargetBase: "cup", TargetText: "kʌp", Kind: "phonetic"},
		}},
		{"restore/target-priority", "I want water", []Item{
			{ID: "1", SourceBase: "我", SourceText: "wǒ", TargetBase: "I", TargetText: "aɪ", Kind: "phonetic"},
		}},
		{"restore/empty-target", "", nil},
		{"restore/empty-target-with-items", "", []Item{{ID: "1", TargetBase: "I"}}},
		{"restore/no-restorable", "abc", []Item{{ID: "1", Kind: "phonetic"}}},
		{"restore/repeated-base", "xAyAz", []Item{
			{ID: "1", TargetBase: "A", TargetText: "one"},
			{ID: "2", TargetBase: "A", TargetText: "two"},
		}},
		{"restore/astral-offsets", "😀I😀", []Item{
			{ID: "1", TargetBase: "I", TargetText: "aɪ"},
		}},
		{"restore/emoji-in-base", "😀x😀", []Item{
			{ID: "1", TargetBase: "😀", TargetText: "emoji"},
		}},
		{"restore/source-equals-target", "abc", []Item{
			{ID: "1", SourceBase: "b", TargetBase: "b", TargetText: "bee"},
		}},
	}
	for _, tc := range restoreCases {
		got, res := RestoreItems(tc.target, tc.items)
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.restore_items",
			Args:   goldenv.Args("target", tc.target, "items", thisItems(tc.items)),
			Expect: goldenv.Expect("target", got, "matched", res.Matched, "total", res.Total, "is_full", res.IsFull()),
		})
	}

	inlineTexts := []struct {
		id   string
		text string
	}{
		{"inline/with-kind", "他⟦ruby:行/xíng/creative⟧了"},
		{"inline/no-kind", "a⟦ruby:我/wǒ⟧b⟦ruby:你/nǐ⟧"},
		{"inline/no-markers", "普通文本"},
		{"inline/malformed", "⟦ruby:abc⟧ ⟦ruby:/x⟧"},
	}
	for _, tc := range inlineTexts {
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.parse_inline_markers",
			Args:   goldenv.Args("text", tc.text),
			Expect: goldenv.Expect("entries", thisEntries(ParseInlineMarkers(tc.text))),
		})
	}

	restoreInlineCases := []struct {
		id      string
		target  string
		entries []OutputEntry
	}{
		{"inline/restore-match", "⟦ruby:行/xíng⟧", []OutputEntry{{Base: "行", Text: "xíng"}}},
		{"inline/restore-filter", "⟦ruby:行/xíng⟧⟦ruby:你/nǐ⟧", []OutputEntry{{Base: "行", Text: "xíng"}}},
		{"inline/restore-empty-output", "a⟦ruby:行/xíng⟧b", nil},
		{"inline/restore-no-markers", "plain", []OutputEntry{{Base: "行", Text: "xíng"}}},
	}
	for _, tc := range restoreInlineCases {
		got, res := RestoreInlineMarkers(tc.target, tc.entries)
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.restore_inline_markers",
			Args:   goldenv.Args("target", tc.target, "entries", thisEntries(tc.entries)),
			Expect: goldenv.Expect("target", got, "matched", res.Matched, "total", res.Total),
		})
	}

	sectionLines := []string{
		"I | aɪ | phonetic | 1",
		"a|b | c | phonetic | 2",
		"I | aɪ | phonetic",
		"a|b | c | phonetic",
		"雷神皇 | 雷神大人 | creative | #1",
		"no pipes",
		"only | two",
		"x | y | custom | 7",
		" | y | phonetic",
	}
	for i, line := range sectionLines {
		base, text, kind, id, ok := ParseSectionLine(line)
		cases = append(cases, goldenv.Case{
			ID: "section/line-" + itoa(i), Op: "ruby.parse_section_line",
			Args: goldenv.Args("content", line),
			Expect: goldenv.Expect(
				"base", base, "text", text, "kind", kind, "id", id, "ok", ok,
			),
		})
	}

	sectionOutputs := []struct {
		id    string
		lines []string
	}{
		{"section/output-four-field", []string{"1: I | aɪ | phonetic | 1", "2: a|b | c | phonetic | 2"}},
		{"section/output-three-field", []string{"1: I | aɪ | phonetic", "2: a|b | c | phonetic"}},
		{"section/output-hash-prefix", []string{"1: 雷神皇 | 雷神大人 | creative | #1", "2: 戳 | たた | phonetic | #2"}},
		{"section/output-quoted-primary", []string{
			`1: "alpha" | "a" | "creative" | "6"`,
			`1: "alpha\q" | "a" | "creative" | "6"`,
			`1: "beta" | "b" | "creative" | "9"`,
		}},
		{"section/output-mixed-invalid", []string{"", "   ", "no colon", "3: ", "4: only | two", "5: I | aɪ | phonetic | #5"}},
	}
	for _, tc := range sectionOutputs {
		m := ParseSectionRubyOutput(tc.lines)
		normalized := map[string][]map[string]any{}
		for id, entries := range m {
			normalized[id] = thisEntries(entries)
		}
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.parse_section_ruby_output",
			Args:   goldenv.Args("lines", tc.lines),
			Expect: goldenv.Expect("map", normalized),
		})
	}

	normalizeInput := []OutputEntry{
		{Base: "  I  ", Text: " aɪ ", Kind: " phonetic ", ID: " 1 "},
		{Base: "   ", Text: "x", Kind: "creative"},
		{Base: "w", Text: " w ", Kind: "bogus"},
	}
	cases = append(cases, goldenv.Case{
		ID: "normalize/output-entries", Op: "ruby.normalize_output_entries",
		Args:   goldenv.Args("entries", thisEntries(normalizeInput)),
		Expect: goldenv.Expect("entries", thisEntries(NormalizeOutputEntries(normalizeInput))),
	})

	bareInputs := []struct {
		id      string
		entries []any
	}{
		{"bare/valid-text", []any{map[string]any{"base": "a", "text": "x"}}},
		{"bare/valid-kind", []any{map[string]any{"base": "a", "kind": "creative"}}},
		{"bare/decoy", []any{map[string]any{"id": "1", "source_base": "a", "source_text": "b"}}},
		{"bare/mixed", []any{map[string]any{"base": "a"}, map[string]any{"base": "b", "text": " y "}}},
		{"bare/empty", []any{}},
		{"bare/not-object", []any{"x", map[string]any{"base": "a", "text": "x"}}},
	}
	for _, tc := range bareInputs {
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.valid_bare_output_entries",
			Args:   goldenv.Args("entries", tc.entries),
			Expect: goldenv.Expect("valid", ValidBareOutputEntries(tc.entries)),
		})
	}

	legacyMarkerText := "他⟦ruby:行/xíng⟧了，⟦ruby:你/nǐ⟧好"
	cases = append(cases, goldenv.Case{
		ID: "legacy/strip-markers", Op: "ruby.strip_legacy_markers",
		Args:   goldenv.Args("text", legacyMarkerText),
		Expect: goldenv.Expect("text", StripLegacyInlineMarkers(legacyMarkerText)),
	})

	// ---- alignment_protocol.go / alignment_legacy.go ----
	roundTripBase := " A|B \"quoted\"\\\n"
	roundTripText := " read | \\ \n "
	roundTripJSONBase, _ := json.Marshal(roundTripBase)
	roundTripJSONText, _ := json.Marshal(roundTripText)
	roundTripLine := string(roundTripJSONBase) + " | " + string(roundTripJSONText) + ` | "creative" | "6" | 2`

	textV2Lines := []struct {
		id   string
		text string
	}{
		{"textv2/roundtrip-exact", roundTripLine},
		{"textv2/roundtrip", `" A|B \"quoted\"\\\n" | " read | \\ \n " | "creative" | "6" | 2`},
		{"textv2/valid", `"alpha" | "a" | "creative" | "6" | 1` + "\n" + `"beta" | "b" | "phonetic" | "9" | 1`},
		{"textv2/bad-escape", `"alpha\q" | "a" | "creative" | "6" | 1`},
		{"textv2/bad-text-escape", `"alpha" | "a\u000Z" | "creative" | "6" | 1`},
		{"textv2/unquoted", `alpha | "a" | "creative" | "6" | 1`},
		{"textv2/missing-occurrence", `"alpha" | "a" | "creative" | "6"`},
		{"textv2/zero-occurrence", `"a" | "b" | "phonetic" | "6" | 0`},
		{"textv2/float-occurrence", `"a" | "b" | "phonetic" | "6" | 1.5`},
		{"textv2/blank-lines", "\n  \n" + `"a" | "b" | "phonetic" | "6" | 1` + "\n\n"},
	}
	for _, tc := range textV2Lines {
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.parse_alignment_text_v2",
			Args:   goldenv.Args("text", tc.text),
			Expect: goldenv.Expect("entries", thisEntries(ParseAlignmentTextV2(tc.text))),
		})
	}

	legacyTexts := []struct {
		id   string
		text string
	}{
		{"textlegacy/four-field", `I | aɪ | phonetic | 1`},
		{"textlegacy/three-field", `I | aɪ | phonetic`},
		{"textlegacy/hash-id", `雷神皇 | 雷神大人 | creative | #1`},
		{"textlegacy/no-pipes", `garbage`},
		{"textlegacy/two-fields", `only | two`},
		{"textlegacy/custom-kind", `x | y | custom | 7`},
		{"textlegacy/multiline", "a | b | phonetic | 1\n\nc | d | creative | #2"},
	}
	for _, tc := range legacyTexts {
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.parse_alignment_text_legacy",
			Args:   goldenv.Args("text", tc.text),
			Expect: goldenv.Expect("entries", thisEntries(ParseAlignmentTextLegacy(tc.text))),
		})
	}

	jsonV2Inputs := []struct {
		id   string
		text string
	}{
		{"jsonv2/valid", `{"ruby_output":[{"id":"1","base":"a","text":"x","kind":"creative","occurrence":1}]}`},
		{"jsonv2/partial-rows", `{"ruby_output":[{"id":"1","base":" a ","text":" x ","kind":"creative","occurrence":1},{"id":"2","base":"b","text":"x","kind":"phonetic","occurrence":"wrong"},{"id":"2","base":"b","text":"x","kind":"phonetic","occurrence":1}]}`},
		{"jsonv2/duplicate-envelope", `{"ruby_output":[{"id":"1","base":"a","text":"x","kind":"creative","occurrence":1}],"ruby_output":[]}`},
		{"jsonv2/not-array", `{"ruby_output":null}`},
		{"jsonv2/missing-field", `{"other":[]}`},
		{"jsonv2/trailing", `{"ruby_output":[]} extra`},
		{"jsonv2/unknown-row-field", `{"ruby_output":[{"id":"1","base":"a","text":"x","kind":"creative","occurrence":1,"extra":true}]}`},
		{"jsonv2/missing-occurrence", `{"ruby_output":[{"id":"1","base":"a","text":"x","kind":"creative"}]}`},
	}
	for _, tc := range jsonV2Inputs {
		entries, err := ParseAlignmentJSONV2(tc.text)
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.parse_alignment_json_v2",
			Args:   goldenv.Args("text", tc.text),
			Expect: goldenv.Expect("ok", err == nil, "entries", thisEntries(entries)),
		})
	}

	outputEntriesInputs := []struct {
		id  string
		raw string
	}{
		{"outputentries/valid", `[{"id":"1","base":"a","text":"x","kind":"creative"}]`},
		{"outputentries/unknown-field", `[{"id":"1","base":"a","text":"x","kind":"creative","extra":1}]`},
		{"outputentries/null-occurrence", `[{"id":"1","base":"a","text":"x","kind":"creative","occurrence":null}]`},
		{"outputentries/not-array", `null`},
	}
	for _, tc := range outputEntriesInputs {
		entries, err := ParseOutputEntries(json.RawMessage(tc.raw))
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.parse_output_entries",
			Args:   goldenv.Args("raw", tc.raw),
			Expect: goldenv.Expect("ok", err == nil, "entries", thisEntries(entries)),
		})
	}

	outputMapInputs := []struct {
		id  string
		raw string
	}{
		{"outputmap/valid", `{"1":[{"id":"1","base":"a","text":"x","kind":"creative"}],"2":[]}`},
		{"outputmap/bad-segment", `{"1":[{"id":"1","base":"a","text":"x","kind":"creative"}],"2":42}`},
		{"outputmap/not-object", `[]`},
	}
	for _, tc := range outputMapInputs {
		m := ParseOutputMap(json.RawMessage(tc.raw))
		normalized := map[string][]map[string]any{}
		for id, entries := range m {
			normalized[id] = thisEntries(entries)
		}
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.parse_output_map",
			Args:   goldenv.Args("raw", tc.raw),
			Expect: goldenv.Expect("map", normalized),
		})
	}

	// ---- alignment_regions.go ----
	regionInputs := []struct {
		id          string
		translation string
		format      string
	}{
		{"regions/plain", "alpha beta gamma", "text"},
		{"regions/plain-newlines", " A\r\nB &amp; ", "text"},
		{"regions/plain-empty", "", "text"},
		{"regions/html-tags", `A<b>B</b>C`, "html"},
		{"regions/html-ruby-excluded", `<p>行&amp;行</p><ruby>旧<rt>old</rt></ruby><b>尾</b>`, "html"},
		{"regions/epub-entities", `<span title="行">行&amp;行</span><ruby class="old">行<rt>old</rt></ruby><b>行</b>`, "epub"},
		{"regions/epub-newline", "<i>A\r\nB</i><b>C</b>", "epub"},
		{"regions/html-references", "<p>&copycat &amp &#65 &notit;</p>", "html"},
		{"regions/html-unsafe-entity", "<p>&NotEqualTilde; ≂</p>", "html"},
		{"regions/comment-and-script", `<p>a<!--c-->b</p><script>var x = "<p>";</script><p>c</p>`, "html"},
		{"regions/docx-tags", "<w:p>text</w:p>", "docx"},
		{"regions/epub-invalid-xml", "<p>unclosed", "epub"},
	}
	for _, tc := range regionInputs {
		regions, err := BuildTranslationRegions(tc.translation, tc.format)
		expectedRegions := []any{}
		for _, r := range regions {
			expectedRegions = append(expectedRegions, map[string]any{
				"text":     r.Text,
				"mappings": r.Mappings,
			})
		}
		errText := ""
		if err != nil {
			errText = err.Error()
			expectedRegions = []any{}
		}
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.build_regions",
			Args:   goldenv.Args("translation", tc.translation, "format", tc.format),
			Expect: goldenv.Expect("regions", expectedRegions, "err", errText),
		})
	}

	// ---- alignment.go ----
	stateItems := []Item{
		{ID: "1", SourceBase: "行", SourceText: "xíng"},
		{ID: "2", SourceBase: "&", SourceText: "amp"},
	}
	newStateCases := []struct {
		id       string
		trans    string
		format   string
		items    []Item
		keep     map[string]bool
		protocol int
	}{
		{"state/new-plain", "alpha beta gamma", "text", []Item{{ID: "1"}, {ID: "2"}, {ID: "3"}}, nil, ProtocolV2},
		{"state/new-epub", `<span title="行">行&amp;行</span><ruby class="old">行<rt>old</rt></ruby><b>行</b>`, "epub", stateItems, nil, ProtocolV2},
		{"state/new-keep", "one two", "text", []Item{{ID: "1", Kind: "creative"}, {ID: "2", Kind: "phonetic"}}, map[string]bool{"creative": true}, ProtocolV2},
		{"state/new-legacy-protocol", "one", "text", []Item{{ID: "1"}}, nil, ProtocolLegacy},
		{"state/new-empty", "", "text", nil, nil, ProtocolV2},
		{"state/new-empty-id", "one", "text", []Item{{SourceBase: "x"}}, nil, ProtocolV2},
		{"state/new-duplicate-id", "one", "text", []Item{{ID: "1"}, {ID: "1"}}, nil, ProtocolV2},
		{"state/new-bad-protocol", "one", "text", nil, nil, 9},
	}
	for _, tc := range newStateCases {
		s, err := NewAlignmentState(tc.trans, tc.format, tc.items, tc.keep, tc.protocol)
		errText := ""
		var state any
		if err != nil {
			errText = err.Error()
		} else {
			state = stateJSON(t, s)
		}
		var keep any
		if tc.keep != nil {
			keep = tc.keep
		}
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.new_alignment_state",
			Args: goldenv.Args(
				"translation", tc.trans, "format", tc.format, "items", thisItems(tc.items),
				"keep", keep, "protocol_version", tc.protocol,
			),
			Expect: goldenv.Expect("ok", err == nil, "err", errText, "state", state),
		})
	}

	classifyItems := []Item{{ID: "1"}, {ID: "2", Kind: "creative"}, {ID: "3"}, {ID: "4"}}
	classifyOutput := []OutputEntry{
		{ID: "1", Base: "a", Text: "x", Kind: "phonetic"},
		{ID: "2", Base: "b", Text: "y", Kind: "semantic"},
		{ID: "3", Base: "c", Text: "z", Kind: "phonetic"},
		{ID: "3", Base: "c", Text: "z", Kind: "creative"},
		{ID: "4", Base: "d", Text: "w", Kind: "bogus"},
	}
	cases = append(cases, goldenv.Case{
		ID: "state/classify-initial-items", Op: "ruby.classify_initial_items",
		Args:   goldenv.Args("items", thisItems(classifyItems), "output", thisEntries(classifyOutput)),
		Expect: goldenv.Expect("items", thisItems(ClassifyInitialItems(classifyItems, classifyOutput))),
	})

	// ApplyOutput 用例（每条都新建 state，避免用例间串扰）。
	applyCases := []applyCase{
		{
			id: "apply/subset-and-duplicate", trans: "alpha beta gamma", format: "text",
			items: []Item{{ID: "1"}, {ID: "2"}, {ID: "3"}}, protocol: ProtocolV2,
			requested: []string{"2", "3"}, require: true,
			entries: []OutputEntry{
				{ID: "1", Base: "alpha", Text: "a", Kind: "phonetic", Occurrence: 1},
				{Base: "beta", Text: "b", Kind: "phonetic", Occurrence: 1},
				{ID: "2", Base: "beta", Text: "b", Kind: "phonetic", Occurrence: 1},
				{ID: "2", Invalid: true},
				{ID: "3", Base: "gamma", Text: "g", Kind: "phonetic", Occurrence: 1},
			},
		},
		{
			id: "apply/entities-ruby-occurrence", trans: `<span title="行">行&amp;行</span><ruby class="old">行<rt>old</rt></ruby><b>行</b>`, format: "epub",
			items: stateItems, protocol: ProtocolV2, requested: []string{"1", "2"}, require: true,
			entries: []OutputEntry{
				{ID: "1", Base: "行", Text: "xíng<&", Kind: "phonetic", Occurrence: 3},
				{ID: "2", Base: "&", Text: "amp", Kind: "semantic", Occurrence: 1},
			},
		},
		{
			id: "apply/conflict", trans: "abc next", format: "text",
			items: []Item{{ID: "a"}, {ID: "b"}, {ID: "c"}}, protocol: ProtocolV2,
			requested: []string{"a", "b"}, require: true,
			entries: []OutputEntry{
				{ID: "a", Base: "abc", Text: "x", Kind: "phonetic", Occurrence: 1},
				{ID: "b", Base: "bc", Text: "y", Kind: "phonetic", Occurrence: 1},
			},
		},
		{
			id: "apply/unique-fallback", trans: "source", format: "text",
			items: []Item{{ID: "1", SourceBase: "source"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "absent", Text: "read", Kind: "phonetic", Occurrence: 7}},
		},
		{
			id: "apply/ambiguous-fallback", trans: "source source", format: "text",
			items: []Item{{ID: "1", SourceBase: "source"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "absent", Text: "read", Kind: "phonetic", Occurrence: 1}},
		},
		{
			id: "apply/invalid-occurrence-no-fallback", trans: "one source", format: "text",
			items: []Item{{ID: "1", SourceBase: "source"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "one", Text: "read", Kind: "phonetic", Occurrence: 2}},
		},
		{
			id: "apply/nonexistent-base", trans: "one", format: "text",
			items: []Item{{ID: "1"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "absent", Text: "read", Kind: "phonetic", Occurrence: 1}},
		},
		{
			id: "apply/unique-main-no-occurrence", trans: "one", format: "text",
			items: []Item{{ID: "1"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: false,
			entries: []OutputEntry{{ID: "1", Base: "one", Text: "read", Kind: "phonetic"}},
		},
		{
			id: "apply/ambiguous-main-no-occurrence", trans: "one one", format: "text",
			items: []Item{{ID: "1"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: false,
			entries: []OutputEntry{{ID: "1", Base: "one", Text: "read", Kind: "phonetic"}},
		},
		{
			id: "apply/strict-missing-occurrence", trans: "one", format: "text",
			items: []Item{{ID: "1"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "one", Text: "read", Kind: "phonetic"}},
		},
		{
			id: "apply/region-whitespace-no-cross-node", trans: "<i>A\r\nB</i><b>C</b>", format: "epub",
			items: []Item{{ID: "1"}, {ID: "2"}}, protocol: ProtocolV2,
			requested: []string{"1", "2"}, require: true,
			entries: []OutputEntry{
				{ID: "1", Base: "A\nB", Text: " x ", Kind: "creative", Occurrence: 1},
				{ID: "2", Base: "BC", Text: "x", Kind: "phonetic", Occurrence: 1},
			},
		},
		{
			id: "apply/unsafe-entity-boundary", trans: "<p>&NotEqualTilde; ≂</p>", format: "html",
			items: []Item{{ID: "1"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "≂", Text: "read", Kind: "phonetic", Occurrence: 1}},
		},
		{
			id: "apply/unsafe-entity-later-occurrence", trans: "<p>&NotEqualTilde; ≂</p>", format: "html",
			items: []Item{{ID: "1"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "≂", Text: "read", Kind: "phonetic", Occurrence: 2}},
		},
		{
			id: "apply/html-entity-occurrences", trans: "<p>&copycat &amp &#65 &notit;</p>", format: "html",
			items: []Item{{ID: "1"}, {ID: "2"}, {ID: "3"}}, protocol: ProtocolV2,
			requested: []string{"1", "2", "3"}, require: true,
			entries: []OutputEntry{
				{ID: "1", Base: "copy", Text: "unsafe", Kind: "creative", Occurrence: 1},
				{ID: "2", Base: "cat", Text: "suffix", Kind: "creative", Occurrence: 1},
				{ID: "3", Base: "A", Text: "letter", Kind: "creative", Occurrence: 1},
			},
		},
		{
			id: "apply/v2-malformed-duplicate-id", trans: "alpha beta", format: "text",
			items: []Item{{ID: "6"}, {ID: "9"}}, protocol: ProtocolV2,
			requested: []string{"6", "9"}, require: true,
			entries: ParseAlignmentTextV2(strings.Join([]string{
				`"alpha" | "a" | "creative" | "6" | 1`,
				`"alpha\\q" | "a" | "creative" | "6" | 1`,
				`"beta" | "b" | "creative" | "9" | 1`,
			}, "\n")),
		},
		{
			id: "apply/section-quoted-duplicate-id", trans: "alpha beta", format: "text",
			items: []Item{{ID: "6"}, {ID: "9"}}, protocol: ProtocolV2,
			requested: []string{"6", "9"}, require: false,
			entries: ParseSectionRubyOutput([]string{
				`1: "alpha" | "a" | "creative" | "6"`,
				`1: "alpha\\q" | "a" | "creative" | "6"`,
				`1: "beta" | "b" | "creative" | "9"`,
			})["1"],
		},
		{
			id: "apply/legacy-malformed-duplicate-id", trans: "alpha beta", format: "text",
			items: []Item{{ID: "6"}, {ID: "9"}}, protocol: ProtocolLegacy,
			requested: []string{"6", "9"}, require: false,
			entries: ParseAlignmentTextLegacy("alpha | a | creative | #6\n | a | creative | #6\nbeta | b | creative | #9\nalpha | a | creative"),
		},
		{
			id: "apply/source-fallback-legal-count", trans: "<p>&NotEqualTilde; ≂</p>", format: "html",
			items: []Item{{ID: "1", SourceBase: "≂"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "missing", Text: "read", Kind: "creative", Occurrence: 8}},
		},
		{
			id: "apply/preserve-cannot-change", trans: "one two", format: "text",
			items: []Item{{ID: "1", Kind: "creative"}, {ID: "2", Kind: "phonetic"}},
			keep:  map[string]bool{"creative": true}, protocol: ProtocolV2,
			requested: []string{"1", "2"}, require: true,
			entries: []OutputEntry{
				{ID: "1", Base: "one", Text: "x", Kind: "phonetic", Occurrence: 1},
				{ID: "2", Base: "two", Text: "y", Kind: "creative", Occurrence: 1},
			},
		},
	}
	for _, tc := range applyCases {
		s, err := NewAlignmentState(tc.trans, tc.format, tc.items, tc.keep, tc.protocol)
		if err != nil {
			t.Fatalf("%s: 构造状态失败: %v", tc.id, err)
		}
		progress := s.ApplyOutput(tc.requested, tc.entries, tc.require)
		verified := make([]map[string]any, 0, len(s.Verified))
		for _, v := range s.Verified {
			verified = append(verified, goldenv.Expect(
				"id", v.ID, "base", v.Base, "text", v.Text, "kind", v.Kind,
				"occurrence", v.Occurrence, "start", v.Start, "end", v.End,
				"source_fallback", v.SourceFallback,
			))
		}
		missingIDs := make([]string, 0, len(s.Missing()))
		for _, it := range s.Missing() {
			missingIDs = append(missingIDs, it.ID)
		}
		var keep any
		if tc.keep != nil {
			keep = tc.keep
		}
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.apply_output",
			Args: goldenv.Args(
				"translation", tc.trans, "format", tc.format, "items", thisItems(tc.items),
				"keep", keep, "protocol_version", tc.protocol,
				"requested", tc.requested, "entries", thisEntries(tc.entries),
				"require_occurrence", tc.require,
			),
			Expect: goldenv.Expect(
				"added", progress.Added,
				"rejected", progress.Rejected,
				"verified", verified,
				"missing_ids", missingIDs,
			),
		})
	}

	// Render 用例：对齐后渲染。
	renderCases := []applyCase{
		{
			id: "render/entities-ruby", trans: `<span title="行">行&amp;行</span><ruby class="old">行<rt>old</rt></ruby><b>行</b>`, format: "epub",
			items: stateItems, protocol: ProtocolV2, requested: []string{"1", "2"}, require: true,
			entries: []OutputEntry{
				{ID: "1", Base: "行", Text: "xíng<&", Kind: "phonetic", Occurrence: 3},
				{ID: "2", Base: "&", Text: "amp", Kind: "semantic", Occurrence: 1},
			},
		},
		{
			id: "render/newline-preserved", trans: "<i>A\r\nB</i><b>C</b>", format: "epub",
			items: []Item{{ID: "1"}, {ID: "2"}}, protocol: ProtocolV2,
			requested: []string{"1", "2"}, require: true,
			entries: []OutputEntry{
				{ID: "1", Base: "A\nB", Text: " x ", Kind: "creative", Occurrence: 1},
				{ID: "2", Base: "BC", Text: "x", Kind: "phonetic", Occurrence: 1},
			},
		},
		{
			id: "render/preserve-total", trans: "one two", format: "text",
			items: []Item{{ID: "1", Kind: "creative"}, {ID: "2", Kind: "phonetic"}},
			keep:  map[string]bool{"creative": true}, protocol: ProtocolV2,
			requested: []string{"1", "2"}, require: true,
			entries: []OutputEntry{
				{ID: "1", Base: "one", Text: "x", Kind: "phonetic", Occurrence: 1},
				{ID: "2", Base: "two", Text: "y", Kind: "creative", Occurrence: 1},
			},
		},
		{
			id: "render/unsafe-entity", trans: "<p>&NotEqualTilde; ≂</p>", format: "html",
			items: []Item{{ID: "1"}}, protocol: ProtocolV2,
			requested: []string{"1"}, require: true,
			entries: []OutputEntry{{ID: "1", Base: "≂", Text: "read", Kind: "phonetic", Occurrence: 2}},
		},
	}
	for _, tc := range renderCases {
		s, err := NewAlignmentState(tc.trans, tc.format, tc.items, tc.keep, tc.protocol)
		if err != nil {
			t.Fatalf("%s: 构造状态失败: %v", tc.id, err)
		}
		s.ApplyOutput(tc.requested, tc.entries, tc.require)
		text, result, err := s.Render()
		errText := ""
		if err != nil {
			errText = err.Error()
		}
		var keep any
		if tc.keep != nil {
			keep = tc.keep
		}
		cases = append(cases, goldenv.Case{
			ID: tc.id, Op: "ruby.render",
			Args: goldenv.Args(
				"translation", tc.trans, "format", tc.format, "items", thisItems(tc.items),
				"keep", keep, "protocol_version", tc.protocol,
				"requested", tc.requested, "entries", thisEntries(tc.entries),
				"require_occurrence", tc.require,
			),
			Expect: goldenv.Expect("text", text, "matched", result.Matched, "total", result.Total, "err", errText),
		})
	}

	// Validate 用例：完好 / 被篡改。
	{
		base := "alpha beta"
		s, err := NewAlignmentState(base, "text", []Item{{ID: "1"}}, nil, ProtocolV2)
		if err != nil {
			t.Fatal(err)
		}
		mutations := []struct {
			id     string
			mutate func(*AlignmentState)
		}{
			{"validate/ok", func(*AlignmentState) {}},
			{"validate/translation-changed", func(st *AlignmentState) { st.Translation += "changed" }},
			{"validate/digest-changed", func(st *AlignmentState) { st.Digest = "deadbeef" }},
			{"validate/version-changed", func(st *AlignmentState) { st.Version = 99 }},
			{"validate/verified-valid", func(st *AlignmentState) {
				st.Verified = append(st.Verified, VerifiedAlignment{
					ID: "1", Base: "alpha", Text: "a", Kind: "phonetic", Occurrence: 1, Start: 0, End: 5,
				})
			}},
			{"validate/verified-bad-text", func(st *AlignmentState) {
				st.Verified = append(st.Verified, VerifiedAlignment{
					ID: "1", Base: "alpha", Text: "", Kind: "phonetic", Occurrence: 1, Start: 0, End: 5,
				})
			}},
			{"validate/verified-overlap", func(st *AlignmentState) {
				st.Verified = append(st.Verified,
					VerifiedAlignment{ID: "1", Base: "alpha", Text: "a", Kind: "phonetic", Occurrence: 1, Start: 0, End: 5},
					VerifiedAlignment{ID: "1", Base: "alpha", Text: "b", Kind: "phonetic", Occurrence: 1, Start: 0, End: 5},
				)
			}},
		}
		for _, tc := range mutations {
			st := *s
			st.Items = append([]AlignmentItem(nil), s.Items...)
			st.Regions = append([]TranslationRegion(nil), s.Regions...)
			st.Verified = append([]VerifiedAlignment(nil), s.Verified...)
			tc.mutate(&st)
			// 校验场景下 state JSON 用 json.Marshal 往返，模拟加载草稿。
			data, err := json.Marshal(&st)
			if err != nil {
				t.Fatal(err)
			}
			var loaded AlignmentState
			if err := json.Unmarshal(data, &loaded); err != nil {
				t.Fatal(err)
			}
			verr := loaded.Validate()
			errText := ""
			if verr != nil {
				errText = verr.Error()
			}
			cases = append(cases, goldenv.Case{
				ID: tc.id, Op: "ruby.validate_state",
				Args:   goldenv.Args("state", stateJSON(t, &st)),
				Expect: goldenv.Expect("ok", verr == nil, "err", errText),
			})
		}
	}

	if _, err := goldenv.Write(out, "ruby", cases); err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("ruby 黄金向量已导出: %d 条 → %s/ruby.json", len(cases), out)
}

// itoa 把非负整数转为十进制字符串。
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
