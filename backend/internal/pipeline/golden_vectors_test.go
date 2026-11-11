package pipeline

import (
	"slices"
	"strconv"
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// goldenSeg 是可序列化的段落描述（黄金向量的输入载体）。
type goldenSeg struct {
	Source         string `json:"source"`
	OriginalSource string `json:"original_source,omitempty"`
	Skip           bool   `json:"skip,omitempty"`
	Translate      bool   `json:"translate,omitempty"`
	StructuralOnly bool   `json:"structural_only,omitempty"`
}

// buildGoldenDoc 由 goldenSeg 列表构造 Document。
func buildGoldenDoc(segs []goldenSeg) *Document {
	out := &Document{Segments: make([]Segment, len(segs))}
	for i, s := range segs {
		out.Segments[i] = Segment{
			Source:         s.Source,
			OriginalSource: s.OriginalSource,
			Skip:           s.Skip,
			Translate:      s.Translate,
			StructuralOnly: s.StructuralOnly,
		}
	}
	return out
}

// TestGoldenVectors 导出 pipeline 包的黄金测试向量（字词计数 + 批次切分 + 上下文扩展）。
//
// 仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘；常规 go test 不产生副作用。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	var cases []goldenv.Case

	// ---- CountWords ----
	wordInputs := []string{
		"",
		" ",
		"hello world",
		"  leading and trailing  ",
		"你好世界",
		"hello 世界",
		"こんにちは世界",
		"カタカナ",
		"한글 텍스트",
		"混合 mixed 文本 123 456",
		"a\tb\nc\rd",
		"vertical\u000btab",
		"nbsp\u00a0space",
		"ideographic\u3000space",
		"line\u2028separator",
		"emoji 🎉 代理对",
		"𠀀𠀁 CJK Ext B",
		"punctuation!!! ???",
		"one",
	}
	for _, in := range wordInputs {
		cases = append(cases, goldenv.Case{
			ID:     "words/count/" + hashID(in),
			Op:     "words.count",
			Args:   goldenv.Args("text", in),
			Expect: goldenv.Expect("count", CountWords(in)),
		})
	}

	// ---- BuildContextAwareBatches ----
	awareCases := []struct {
		id            string
		sources       []string
		pending       []int
		maxSegments   int
		maxWords      int
		ctxWindow     int
		enabled       bool
		useEstimator  bool
	}{
		{"batch/aware/disabled", []string{"seg-0", "seg-1", "seg-2", "seg-3", "seg-4"}, []int{1, 3}, 5, 0, 1, false, false},
		{"batch/aware/window-zero", []string{"seg-0", "seg-1", "seg-2", "seg-3", "seg-4"}, []int{1, 3}, 5, 0, 0, true, false},
		{"batch/aware/no-overlap", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}, []int{1, 7}, 10, 0, 1, true, false},
		{"batch/aware/overlap", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}, []int{1, 3}, 10, 0, 1, true, false},
		{"batch/aware/window2-merge", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}, []int{1, 5}, 10, 0, 2, true, false},
		{"batch/aware/window2-separate", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}, []int{1, 7}, 10, 0, 2, true, false},
		{"batch/aware/batch-size-split", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}, []int{1, 3, 5, 7, 9}, 2, 0, 1, true, false},
		{"batch/aware/empty", []string{"s0"}, nil, 5, 0, 1, true, false},
		{"batch/aware/word-constraint", []string{"a", "bb", "ccc", "dddd", "eeeee"}, []int{0, 1, 2, 3, 4}, 0, 4, 0, false, false},
		{"batch/aware/cjk-word-constraint", []string{"你好世界", "hello", "世界"}, []int{0, 1, 2}, 0, 5, 0, false, false},
		{"batch/aware/dual-segments-first", []string{"a", "b", "c", "d", "e"}, []int{0, 1, 2, 3, 4}, 2, 100, 0, false, false},
		{"batch/aware/dual-words-first", []string{"hello world", "foo bar", "x", "y"}, []int{0, 1, 2, 3}, 100, 3, 0, false, false},
		{"batch/aware/with-estimator", []string{"alpha beta gamma", "a", "delta echo foxtrot", "b", "golf hotel india"}, []int{1, 3}, 0, 7, 1, true, true},
		{"batch/aware/estimator-disabled", []string{"alpha beta gamma", "a", "delta echo foxtrot", "b", "golf hotel india"}, []int{1, 3}, 0, 7, 1, true, false},
	}
	for _, tc := range awareCases {
		doc := buildGoldenDoc(toGoldenSegs(tc.sources))
		constraint := BatchConstraint{MaxSegments: tc.maxSegments, MaxWords: tc.maxWords}
		var estimator contextWordEstimator
		if tc.useEstimator {
			estimator = func(idxs []int) int { return estimateContextWords(doc, idxs, tc.ctxWindow) }
		}
		got := BuildContextAwareBatches(doc, tc.pending, constraint, tc.ctxWindow, tc.enabled, estimator)
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "batch.build_context_aware",
			Args: goldenv.Args(
				"sources", tc.sources,
				"pending", tc.pending,
				"max_segments", tc.maxSegments,
				"max_words", tc.maxWords,
				"ctx_window", tc.ctxWindow,
				"enabled", tc.enabled,
				"use_estimator", tc.useEstimator,
			),
			Expect: goldenv.Expect("batches", nonNilBatches(got)),
		})
	}

	// ---- BuildContinuousPendingBatches ----
	continuousCases := []struct {
		id          string
		sources     []string
		pending     []int
		maxSegments int
		maxWords    int
	}{
		{"batch/continuous/word-constraint", []string{"a", "b", "c", "x", "y"}, []int{0, 1, 2, 3, 4}, 0, 2},
		{"batch/continuous/discontinuous", []string{"a", "b", "c", "x", "y"}, []int{0, 1, 2, 4}, 0, 2},
		{"batch/continuous/segment-limit", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}, []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}, 3, 0},
		{"batch/continuous/empty", []string{"s0"}, nil, 5, 0},
		{"batch/continuous/single", []string{"s0"}, []int{0}, 1, 0},
		{"batch/continuous/unconstrained", []string{"s0", "s1", "s2"}, []int{0, 1, 2}, 0, 0},
	}
	for _, tc := range continuousCases {
		doc := buildGoldenDoc(toGoldenSegs(tc.sources))
		constraint := BatchConstraint{MaxSegments: tc.maxSegments, MaxWords: tc.maxWords}
		got := BuildContinuousPendingBatches(doc, tc.pending, constraint)
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "batch.build_continuous",
			Args: goldenv.Args(
				"sources", tc.sources,
				"pending", tc.pending,
				"max_segments", tc.maxSegments,
				"max_words", tc.maxWords,
			),
			Expect: goldenv.Expect("batches", nonNilBatches(got)),
		})
	}

	// ---- BuildPackedPendingBatches ----
	packedCases := []struct {
		id           string
		sources      []string
		pending      []int
		maxSegments  int
		maxWords     int
		maxIndexSpan int
	}{
		{"batch/packed/discontinuous-fills", []string{"a", "b", "c", "x", "y"}, []int{0, 1, 2, 4}, 0, 2, 0},
		{"batch/packed/segment-limit", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"}, []int{0, 2, 5, 7, 9}, 2, 0, 0},
		{"batch/packed/max-index-span", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13", "s14", "s15", "s16", "s17", "s18", "s19"}, []int{0, 1, 5, 6, 10}, 10, 0, 3},
		{"batch/packed/span-disabled", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13", "s14", "s15", "s16", "s17", "s18", "s19"}, []int{0, 10, 19}, 3, 0, 0},
		{"batch/packed/span-negative", []string{"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "s12", "s13", "s14", "s15", "s16", "s17", "s18", "s19"}, []int{0, 10, 19}, 3, 0, -1},
		{"batch/packed/empty", []string{"s0"}, nil, 5, 0, 0},
	}
	for _, tc := range packedCases {
		doc := buildGoldenDoc(toGoldenSegs(tc.sources))
		constraint := BatchConstraint{MaxSegments: tc.maxSegments, MaxWords: tc.maxWords}
		got := BuildPackedPendingBatches(doc, tc.pending, constraint, tc.maxIndexSpan)
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "batch.build_packed",
			Args: goldenv.Args(
				"sources", tc.sources,
				"pending", tc.pending,
				"max_segments", tc.maxSegments,
				"max_words", tc.maxWords,
				"max_index_span", tc.maxIndexSpan,
			),
			Expect: goldenv.Expect("batches", nonNilBatches(got)),
		})
	}

	// ---- ExpandBatchWithContext ----
	expandCases := []struct {
		id       string
		segs     []goldenSeg
		idxs     []int
		total    int
		ctxWin   int
		maxChars int
	}{
		{
			id:       "batch/expand/max-chars-truncates",
			segs:     []goldenSeg{{Source: "0123456789"}, {Source: "batch"}, {Source: "abcdefghij"}},
			idxs:     []int{1},
			total:    3,
			ctxWin:   1,
			maxChars: 5,
		},
		{
			id:       "batch/expand/max-chars-zero",
			segs:     []goldenSeg{{Source: "0123456789"}, {Source: "batch"}, {Source: "abcdefghij"}},
			idxs:     []int{1},
			total:    3,
			ctxWin:   1,
			maxChars: 0,
		},
		{
			id:       "batch/expand/batch-segment-never-truncated",
			segs:     []goldenSeg{{Source: "contextlong1"}, {Source: "verylongbatchsegment"}, {Source: "contextlong2"}},
			idxs:     []int{1},
			total:    3,
			ctxWin:   1,
			maxChars: 5,
		},
		{
			id: "batch/expand/eligibility",
			segs: []goldenSeg{
				{Source: "ctx0"},
				{Source: "◇ ◇", Skip: true},
				{Source: "ctx2", OriginalSource: "context two words"},
				{Source: "batch"},
				{Source: "ctx4"},
				{Source: "[PH]", StructuralOnly: true},
				{Source: "ctx6"},
			},
			idxs:     []int{3},
			total:    7,
			ctxWin:   3,
			maxChars: 0,
		},
		{
			id: "batch/expand/rune-truncation-unicode",
			segs: []goldenSeg{
				{Source: "你好世界朋友"},
				{Source: "batch"},
				{Source: "🎉🎉🎉🎉🎉"},
			},
			idxs:     []int{1},
			total:    3,
			ctxWin:   1,
			maxChars: 3,
		},
		{
			id:       "batch/expand/zero-window",
			segs:     []goldenSeg{{Source: "a"}, {Source: "b"}},
			idxs:     []int{0},
			total:    2,
			ctxWin:   0,
			maxChars: 0,
		},
	}
	for _, tc := range expandCases {
		doc := buildGoldenDoc(tc.segs)
		got := ExpandBatchWithContext(doc, tc.idxs, tc.total, tc.ctxWin, tc.maxChars)
		truncated := map[string]string{}
		for k, v := range got.TruncatedSrc {
			truncated[strconv.Itoa(k)] = v
		}
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "batch.expand_context",
			Args: goldenv.Args(
				"segments", tc.segs,
				"idxs", tc.idxs,
				"total_segments", tc.total,
				"ctx_window", tc.ctxWin,
				"max_chars", tc.maxChars,
			),
			Expect: goldenv.Expect(
				"idxs", got.Idxs,
				"truncated", truncated,
			),
		})
	}

	// ---- estimateContextWords / estimateContextWordsWithPrefix ----
	estimateSegs := []goldenSeg{
		{Source: "ctx0"},
		{Source: "◇ ◇", Skip: true},
		{Source: "ctx2", OriginalSource: "context two words here"},
		{Source: "batch"},
		{Source: "ctx4"},
		{Source: "[PH]", StructuralOnly: true},
		{Source: "ctx6"},
		{Source: "seven words here now"},
	}
	estimateBatches := []struct {
		id     string
		batch  []int
		window int
	}{
		{"batch/estimate/single-mid-w1", []int{3}, 1},
		{"batch/estimate/single-mid-w3", []int{3}, 3},
		{"batch/estimate/single-edge-w5", []int{0}, 5},
		{"batch/estimate/pair-w1", []int{1, 3}, 1},
		{"batch/estimate/pair-w2", []int{3, 6}, 2},
		{"batch/estimate/triple-w0", []int{0, 3, 7}, 0},
		{"batch/estimate/empty-w1", []int{}, 1},
	}
	for _, tc := range estimateBatches {
		doc := buildGoldenDoc(estimateSegs)
		ref := estimateContextWords(doc, tc.batch, tc.window)
		prefix := buildEligibleWordPrefix(doc)
		got := estimateContextWordsWithPrefix(doc, tc.batch, tc.window, prefix)
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "batch.estimate_context_words",
			Args: goldenv.Args(
				"segments", estimateSegs,
				"batch", tc.batch,
				"ctx_window", tc.window,
			),
			Expect: goldenv.Expect(
				"words", ref,
				"prefixWords", got,
			),
		})
	}

	// ---- BuildContextSet / FilterPendingIdxs ----
	{
		expanded := []int{0, 1, 2, 3}
		batchSet := map[int]struct{}{1: {}, 2: {}}
		ctxSet := BuildContextSet(expanded, batchSet)
		ids := make([]int, 0, len(ctxSet))
		for k := range ctxSet {
			ids = append(ids, k)
		}
		slices.Sort(ids)
		cases = append(cases, goldenv.Case{
			ID:   "batch/context-set/basic",
			Op:   "batch.build_context_set",
			Args: goldenv.Args("expanded", expanded, "batch", []int{1, 2}),
			Expect: goldenv.Expect(
				"context", ids,
				"pending", FilterPendingIdxs(expanded, ctxSet),
			),
		})
	}

	// ---- shrinkConstraint（缩批系数 floor(orig * shrink^pool)）----
	shrinkCases := []struct {
		id          string
		maxSegments int
		maxWords    int
		shrink      float64
		pool        int
	}{
		{"batch/shrink/pool0", 10, 100, 0.5, 0},
		{"batch/shrink/pool1", 10, 100, 0.5, 1},
		{"batch/shrink/pool2", 10, 100, 0.5, 2},
		{"batch/shrink/pool3", 10, 100, 0.5, 3},
		{"batch/shrink/one", 10, 100, 1.0, 3},
		{"batch/shrink/zero", 10, 100, 0.0, 2},
		{"batch/shrink/negative-pool", 10, 100, 0.5, -1},
		{"batch/shrink/segment-only", 7, 0, 0.25, 2},
		{"batch/shrink/words-only", 0, 33, 0.5, 2},
		{"batch/shrink/tiny", 3, 3, 0.1, 2},
	}
	for _, tc := range shrinkCases {
		orig := BatchConstraint{MaxSegments: tc.maxSegments, MaxWords: tc.maxWords}
		got := shrinkConstraint(orig, tc.shrink, tc.pool)
		cases = append(cases, goldenv.Case{
			ID:   tc.id,
			Op:   "batch.shrink_constraint",
			Args: goldenv.Args(
				"max_segments", tc.maxSegments,
				"max_words", tc.maxWords,
				"shrink", tc.shrink,
				"pool", tc.pool,
			),
			Expect: goldenv.Expect(
				"max_segments", got.MaxSegments,
				"max_words", got.MaxWords,
			),
		})
	}

	n, err := goldenv.Write(out, "batch", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("batch 黄金向量已导出: %d 条 → %s/batch.json", n, out)
}

// toGoldenSegs 把纯文本来源转换为可序列化段落。
func toGoldenSegs(sources []string) []goldenSeg {
	out := make([]goldenSeg, len(sources))
	for i, s := range sources {
		out[i] = goldenSeg{Source: s, Translate: true}
	}
	return out
}

// hashID 把输入文本转成可读且稳定的用例 ID。
func hashID(s string) string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
			out = append(out, c)
		default:
			out = append(out, '%', hexDigits[c>>4], hexDigits[c&0x0f])
		}
	}
	if len(out) == 0 {
		return "empty"
	}
	return string(out)
}

// nonNilBatches 把 nil 批次切片归一为空切片（Go 的 nil slice 序列化后是 null，
// TS 侧统一用空数组表达「无批次」）。
func nonNilBatches(v [][]int) [][]int {
	if v == nil {
		return [][]int{}
	}
	out := make([][]int, 0, len(v))
	for _, b := range v {
		if b == nil {
			out = append(out, []int{})
			continue
		}
		out = append(out, b)
	}
	return out
}
