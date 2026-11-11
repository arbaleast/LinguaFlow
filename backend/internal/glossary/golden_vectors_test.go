package glossary

// 黄金向量导出器：把 glossary 包的真实输出序列化为 JSON，供
// frontend/src/domain/glossary 的 TypeScript 移植层做 100% 深相等对拍。
//
// 覆盖范围 = file_test.go + replace_test.go 的全部用例，外加 CSV 解析
// （BOM / CRLF / 引号 / 内嵌逗号与换行 / 转义双引号 / 末尾空行）的边界矩阵。
// 只做导出，不修改任何生产代码。

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// goldenEntry 把 Entry 序列化为 TS 侧可直接消费的结构。
//
// Entry 没有 JSON tag（Go 原生序列化是 PascalCase），它也不是落库/协议实体
// （落库形态是 CSV），因此这里统一用驼峰 key，与 TS 的 GlossaryEntry 对齐。
func goldenEntry(e Entry) map[string]any {
	return map[string]any{
		"source":        e.Source,
		"target":        e.Target,
		"caseSensitive": e.CaseSensitive,
		"forbidden":     e.Forbidden,
		"mandatory":     e.Mandatory,
		"notes":         e.Notes,
	}
}

// goldenEntries 序列化条目切片。nil 切片归一为空数组（README §3.2）。
func goldenEntries(entries []Entry) []any {
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, goldenEntry(e))
	}
	return out
}

// goldenRounds 序列化多轮 Add 的输入。
func goldenRounds(rounds [][]Entry) []any {
	out := make([]any, 0, len(rounds))
	for _, round := range rounds {
		out = append(out, goldenEntries(round))
	}
	return out
}

// goldenSkipped 序列化 AddResult.Skipped。nil 切片归一为空数组。
func goldenSkipped(skipped []SkippedEntry) []any {
	out := make([]any, 0, len(skipped))
	for _, s := range skipped {
		out = append(out, map[string]any{
			"proposed": goldenEntry(s.Proposed),
			"existing": goldenEntry(s.Existing),
			"reason":   string(s.Reason),
		})
	}
	return out
}

// goldenAddResult 序列化一次 Add 的处理详情。
func goldenAddResult(res AddResult) map[string]any {
	return map[string]any{
		"added":   goldenEntries(res.Added),
		"skipped": goldenSkipped(res.Skipped),
	}
}

// writeGoldenCSV 把内容写入临时 CSV 文件并返回路径。
func writeGoldenCSV(t *testing.T, id, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "g.csv")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("%s: 写入临时 CSV 失败: %v", id, err)
	}
	return path
}

// goldenLoadCase 导出一次 LoadFile 的真实结果。
func goldenLoadCase(t *testing.T, id, content string) goldenv.Case {
	t.Helper()
	path := writeGoldenCSV(t, id, content)
	g, err := LoadFile(path)
	if err != nil {
		return goldenv.Case{
			ID:     id,
			Op:     "glossary.load_csv",
			Args:   goldenv.Args("content", content),
			Expect: goldenv.Expect("ok", false, "error", true),
		}
	}
	return goldenv.Case{
		ID:   id,
		Op:   "glossary.load_csv",
		Args: goldenv.Args("content", content),
		Expect: goldenv.Expect(
			"ok", true,
			"entries", goldenEntries(g.entries),
			"sources", g.SnapshotSources(),
			"len", g.Len(),
			"dirty", g.Dirty(),
		),
	}
}

// goldenLoadMissingFileCase 覆盖 Go `LoadFile` 对「文件不存在」的处理：
// 返回空表且不报错。TS 侧没有文件系统，调用方对缺失文件传空串。
func goldenLoadMissingFileCase(t *testing.T) goldenv.Case {
	t.Helper()
	path := filepath.Join(t.TempDir(), "does-not-exist.csv")
	g, err := LoadFile(path)
	if err != nil {
		t.Fatalf("缺失文件应返回空表，实际报错: %v", err)
	}
	return goldenv.Case{
		ID:   "glossary/load/missing-file",
		Op:   "glossary.load_csv",
		Args: goldenv.Args("content", ""),
		Expect: goldenv.Expect(
			"ok", true,
			"entries", goldenEntries(g.entries),
			"sources", g.SnapshotSources(),
			"len", g.Len(),
			"dirty", g.Dirty(),
		),
	}
}

// goldenLookupCase 先按 content / seed 建表，再导出 Lookup 的真实命中序列。
func goldenLookupCase(t *testing.T, id, content string, seed []Entry, text string) goldenv.Case {
	t.Helper()
	args := goldenv.Args(
		"content", content,
		"entries", goldenEntries(seed),
		"text", text,
	)
	g := NewMemory()
	if content != "" {
		path := writeGoldenCSV(t, id, content)
		loaded, err := LoadFile(path)
		if err != nil {
			t.Fatalf("%s: 载入种子 CSV 失败: %v", id, err)
		}
		g = loaded
	}
	if len(seed) > 0 {
		if _, err := g.Add(context.Background(), seed...); err != nil {
			t.Fatalf("%s: 写入种子条目失败: %v", id, err)
		}
	}
	hits, err := g.Lookup(context.Background(), text, "", "")
	if err != nil {
		t.Fatalf("%s: Lookup 失败: %v", id, err)
	}
	return goldenv.Case{
		ID:     id,
		Op:     "glossary.lookup",
		Args:   args,
		Expect: goldenv.Expect("hits", goldenEntries(hits)),
	}
}

// goldenAddCase 导出多轮 Add 的真实结果与最终内部状态。
//
// content 非空时先用 LoadFile 建表（dirty=false），用于覆盖「重复 Add 不应
// 置脏」的语义；否则从空内存表开始。
func goldenAddCase(t *testing.T, id, content string, rounds [][]Entry) goldenv.Case {
	t.Helper()
	g := NewMemory()
	if content != "" {
		path := writeGoldenCSV(t, id, content)
		loaded, err := LoadFile(path)
		if err != nil {
			t.Fatalf("%s: 载入种子 CSV 失败: %v", id, err)
		}
		g = loaded
	}
	dirtyBefore := g.Dirty()
	results := make([]any, 0, len(rounds))
	for _, round := range rounds {
		res, err := g.Add(context.Background(), round...)
		if err != nil {
			t.Fatalf("%s: Add 失败: %v", id, err)
		}
		results = append(results, goldenAddResult(res))
	}
	return goldenv.Case{
		ID:   id,
		Op:   "glossary.add",
		Args: goldenv.Args("content", content, "rounds", goldenRounds(rounds)),
		Expect: goldenv.Expect(
			"results", results,
			"len", g.Len(),
			"sources", g.SnapshotSources(),
			"dirtyBefore", dirtyBefore,
			"dirtyAfter", g.Dirty(),
		),
	}
}

// goldenSaveCase 通过生产代码 Save 落盘到临时目录，再把文件内容作为期望值。
func goldenSaveCase(t *testing.T, id, relPath string, entries []Entry) goldenv.Case {
	t.Helper()
	args := goldenv.Args("path", relPath, "entries", goldenEntries(entries))
	if relPath == "" {
		g := NewMemory()
		if len(entries) > 0 {
			if _, err := g.Add(context.Background(), entries...); err != nil {
				t.Fatalf("%s: 写入条目失败: %v", id, err)
			}
		}
		err := g.Save(context.Background())
		return goldenv.Case{
			ID:     id,
			Op:     "glossary.save",
			Args:   args,
			Expect: goldenv.Expect("ok", err == nil, "error", err != nil),
		}
	}
	fullPath := filepath.Join(t.TempDir(), relPath)
	g := &FileGlossary{path: fullPath, bySource: map[string]int{}}
	if len(entries) > 0 {
		if _, err := g.Add(context.Background(), entries...); err != nil {
			t.Fatalf("%s: 写入条目失败: %v", id, err)
		}
	}
	if err := g.Save(context.Background()); err != nil {
		t.Fatalf("%s: Save 失败: %v", id, err)
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		t.Fatalf("%s: 读取落盘结果失败: %v", id, err)
	}
	return goldenv.Case{
		ID:   id,
		Op:   "glossary.save",
		Args: args,
		Expect: goldenv.Expect(
			"ok", true,
			"content", string(data),
			"sources", g.SnapshotSources(),
			"dirty", g.Dirty(),
		),
	}
}

// goldenSaveRawCase 直接把 entries 塞进内部切片再 Save。
//
// 用于覆盖 Add 会 trim 掉、但 csv.Writer 必须正确转义的字符（行首空格、
// 前导 tab、内嵌 CR、`\.` 等）——这些值无法通过生产的 Add 路径注入。
func goldenSaveRawCase(t *testing.T, id, relPath string, entries []Entry) goldenv.Case {
	t.Helper()
	args := goldenv.Args("path", relPath, "entries", goldenEntries(entries))
	fullPath := filepath.Join(t.TempDir(), relPath)
	g := &FileGlossary{path: fullPath, bySource: map[string]int{}}
	g.entries = append([]Entry{}, entries...)
	g.sortLocked()
	if err := g.Save(context.Background()); err != nil {
		t.Fatalf("%s: Save 失败: %v", id, err)
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		t.Fatalf("%s: 读取落盘结果失败: %v", id, err)
	}
	return goldenv.Case{
		ID:   id,
		Op:   "glossary.save",
		Args: args,
		Expect: goldenv.Expect(
			"ok", true,
			"content", string(data),
			"sources", g.SnapshotSources(),
			"dirty", g.Dirty(),
		),
	}
}

// goldenReplaceCase 导出一次 SafeReplace 的真实输出。
func goldenReplaceCase(id, text, from, to, lang string) goldenv.Case {
	got, replaced, warn := SafeReplace(text, from, to, lang)
	return goldenv.Case{
		ID:   id,
		Op:   "glossary.replace",
		Args: goldenv.Args("text", text, "from", from, "to", to, "lang", lang),
		Expect: goldenv.Expect(
			"text", got,
			"replaced", replaced,
			"warn", warn,
		),
	}
}

// goldenReplaceCICase 导出一次 CaseInsensitiveReplace 的真实输出。
func goldenReplaceCICase(id, text, old, new string) goldenv.Case {
	got, replaced := CaseInsensitiveReplace(text, old, new)
	return goldenv.Case{
		ID:     id,
		Op:     "glossary.replace_ci",
		Args:   goldenv.Args("text", text, "old", old, "new", new),
		Expect: goldenv.Expect("text", got, "replaced", replaced),
	}
}

// requestAwareGolden 是实现了 RequestAdder 的测试替身，用于验证
// AddForRequest 的委派语义（生产代码无此实现）。
type requestAwareGolden struct {
	FileGlossary
	awareCalls int
}

func (g *requestAwareGolden) AddForRequest(ctx context.Context, _ string, entries ...Entry) (AddResult, error) {
	g.awareCalls++
	return g.FileGlossary.Add(ctx, entries...)
}

// TestGoldenVectors 导出 glossary 包的黄金测试向量。
//
// 仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘；常规 go test 不产生副作用。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	cases := make([]goldenv.Case, 0, 128)

	// ---- CSV 解析（file.go LoadFile）------------------------------------
	cases = append(cases,
		// file_test.go: TestFileGlossary_LoadSaveRoundTrip 的 legacy 4 列格式。
		goldenLoadCase(t, "glossary/load/legacy-roundtrip",
			"source,target,case_sensitive,notes\n"+
				"LinguaFlow,灵枢,true,产品名\n"+
				"pipeline,流水线,false,\n"),
		// file_test.go: TestFileGlossary_ExtendedCSVAndForbiddenMultiplicity。
		goldenLoadCase(t, "glossary/load/extended-forbidden-multiplicity",
			"source,target,case_sensitive,forbidden,mandatory,notes\n"+
				"API,接口,false,false,true,recommended\n"+
				"API,应用接口,false,true,true,banned one\n"+
				"API,应用程序接口,false,true,false,banned two\n"),
		// file_test.go: TestFileGlossary_LoadWithoutHeader。
		goldenLoadCase(t, "glossary/load/without-header",
			"Foo,福\nBar,巴,true,note\n"),
		// 空文件：合法，返回空表。
		goldenLoadCase(t, "glossary/load/empty-file", ""),
		// file_test.go: TestFileGlossary_LoadMissingFile。
		// 浏览器侧没有「文件不存在」概念：调用方对缺失文件传空串，结果即空表
		// （与下方 empty-file 期望值相同，但用例语义单独保留）。
		goldenLoadMissingFileCase(t),
		// 纯 BOM：剥掉后即为空内容。
		goldenLoadCase(t, "glossary/load/bom-only", "\ufeff"),
		// UTF-8 BOM + 表头。
		goldenLoadCase(t, "glossary/load/bom-header",
			"\ufeffsource,target,notes\nFoo,福,备注\n"),
		// CRLF 行尾（含 BOM 组合）。
		goldenLoadCase(t, "glossary/load/crlf",
			"source,target,case_sensitive,notes\r\n"+
				"Foo,福,true,x\r\n"+
				"Bar,巴,false,\r\n"),
		// 带引号字段：内嵌逗号 + 转义双引号。
		goldenLoadCase(t, "glossary/load/quoted-fields",
			"source,target,case_sensitive,notes\n"+
				"\"Foo, Inc.\",\"福, 公司\",true,\"含逗号, 与引号 \"\"强调\"\" 的备注\"\n"),
		// 带引号字段：内嵌裸换行（LF）。
		goldenLoadCase(t, "glossary/load/embedded-newline",
			"source,target,notes\n"+
				"\"multi\nline\",\"多行\n译文\",备注\n"),
		// 带引号字段：内嵌 CRLF 会被 Go csv 归一为 LF。
		goldenLoadCase(t, "glossary/load/embedded-crlf",
			"source,target,notes\r\n"+
				"\"multi\r\nline\",多行,备注\r\n"),
		// 末尾多个空行被 csv.Reader 跳过。
		goldenLoadCase(t, "glossary/load/trailing-blank-lines",
			"Foo,福\n\n\n"),
		// 中间空行同样被跳过。
		goldenLoadCase(t, "glossary/load/blank-lines-inside",
			"Foo,福\n\n\nBar,巴\n"),
		// TrimLeadingSpace=true：字段行首空白被裁掉，再由 TrimSpace 收尾。
		goldenLoadCase(t, "glossary/load/leading-space",
			"source,target\n  Foo , 福 \n"),
		// 逗号后先有行首空白、再是引号字段：TrimLeadingSpace 与 quoted 组合。
		goldenLoadCase(t, "glossary/load/quoted-after-space",
			"source,target\nFoo, \"福\"\n"),
		// 行首 tab 同样被 TrimLeadingSpace 裁掉，尾随 tab 由 TrimSpace 收尾。
		goldenLoadCase(t, "glossary/load/tab-leading-space",
			"source,target\n\tFoo\t,福\n"),
		// 表头大小写无关。
		goldenLoadCase(t, "glossary/load/header-case-insensitive",
			"SOURCE,Target,Case_Sensitive,Notes\nFoo,福,TRUE,n\n"),
		// 5 列但第 4 列是 forbidden：未达 6 列 → 不进入扩展格式，
		// 第 4 列被当作 legacy notes（Go 的既有行为，必须原样复刻）。
		goldenLoadCase(t, "glossary/load/header-forbidden-five-columns",
			"source,target,case_sensitive,forbidden,notes\nAPI,接口,false,true,备注\n"),
		// 无表头但正好 6 列 → 走扩展格式分支。
		goldenLoadCase(t, "glossary/load/six-columns-no-header",
			"Foo,福,false,true,false,备注\n"),
		// 表头 6 列但第 4 列不是 forbidden：extendedFormat=false，
		// 而行宽 6 → 仍走扩展分支（第 4/5 列按 bool 解析，第 6 列是 notes）。
		goldenLoadCase(t, "glossary/load/header-six-without-forbidden",
			"source,target,case_sensitive,mandatory,notes,extra\nFoo,福,false,true,备注,x\n"),
		// 超过 6 列：多余列忽略。
		goldenLoadCase(t, "glossary/load/extra-columns",
			"Foo,福,false,false,true,note,extra,more\n"),
		// 只有 1 个字段的行被跳过。
		goldenLoadCase(t, "glossary/load/short-row-skipped",
			"Foo,福\nOnlyOneField\nBar,巴\n"),
		// 空 source / 空 target 的行被跳过。
		goldenLoadCase(t, "glossary/load/empty-cells-skipped",
			",x\nFoo,\nBar,巴\n"),
		// 引号内的空 target：解析成功但语义为空 → 跳过。
		goldenLoadCase(t, "glossary/load/quoted-empty-target",
			"Foo,\"\"\n"),
		// 布尔解析的宽松集合（1/true/yes/y/on，大小写与空白无关）。
		goldenLoadCase(t, "glossary/load/boolean-variants",
			"source,target,case_sensitive,forbidden,mandatory,notes\n"+
				"a,甲,1,0,yes,note1\n"+
				"b,乙,YES,TRUE,on,note2\n"+
				"c,丙, True , False , 1 ,note3\n"+
				"d,丁,0,no,off,note4\n"),
		// 全引号且无表头。
		goldenLoadCase(t, "glossary/load/quoted-only",
			"\"Foo\",\"福\"\n"),
		// 末行无换行符：Go csv 仍会返回该记录（readLine 把 EOF 归一为 nil）。
		goldenLoadCase(t, "glossary/load/no-trailing-newline",
			"Foo,福"),
		// 末行仅以 \r 结尾（无 \n）：Go 在 EOF 分支丢弃尾随 \r。
		goldenLoadCase(t, "glossary/load/trailing-cr-no-newline",
			"Foo,福\r"),
		// 字段中间的孤立 \r 不是行尾，保留在字段内。
		goldenLoadCase(t, "glossary/load/lone-cr-inside-field",
			"Foo,福\rBar,巴\n"),
		// 表头之后才出现 source,target 行：只有首行参与表头判定。
		goldenLoadCase(t, "glossary/load/header-not-first",
			"Foo,福\nsource,target\nBar,巴\n"),
		// 仅表头。
		goldenLoadCase(t, "glossary/load/header-only",
			"source,target,case_sensitive,forbidden,mandatory,notes\n"),
		// 同 source 的重复推荐条目：LoadFile 不去重（只有 Add 去重）。
		goldenLoadCase(t, "glossary/load/duplicate-recommendation",
			"source,target\nFoo,福\nfoo,福2\n"),
		// 完全相同的两行也都会保留。
		goldenLoadCase(t, "glossary/load/duplicate-identical-rows",
			"Foo,福\nFoo,福\n"),
		// legacy 4 列的 notes 首尾空白被 trim。
		goldenLoadCase(t, "glossary/load/notes-trimmed",
			"source,target,case_sensitive,notes\nFoo,福,false,  spaced note  \n"),
		// 按 UTF-8 字节长度降序（"人工智能" 12 字节 > "AI技术" 8 字节 > "AI" 2 字节）。
		goldenLoadCase(t, "glossary/load/cjk-byte-length-order",
			"source,target\nAI,人工智能\n人工智能,AI\nAI技术,AI技术\n"),
		// 解析错误：闭合引号后跟空格再跟逗号（非法的 non-escaped quote）。
		goldenLoadCase(t, "glossary/load/error-quote-after-close",
			"source,target\n \"Foo\" ,\"福\"\n"),
		// 解析错误：非引号字段里出现裸引号。
		goldenLoadCase(t, "glossary/load/error-bare-quote",
			"Foo,ba\"r\n"),
		// 解析错误：引号字段未闭合。
		goldenLoadCase(t, "glossary/load/error-unclosed-quote",
			"\"Foo,福\n"),
	)

	// ---- Lookup（file.go）----------------------------------------------
	cases = append(cases,
		// file_test.go: TestFileGlossary_LookupCaseSensitivity 的两个方向。
		// 期望顺序即内部顺序（字节长度降序：pipeline 8 > API 3）。
		goldenLookupCase(t, "glossary/lookup/case-sensitivity-hit",
			"", []Entry{
				{Source: "API", Target: "接口", CaseSensitive: true},
				{Source: "pipeline", Target: "流水线", CaseSensitive: false},
			}, "build an API for the Pipeline"),
		goldenLookupCase(t, "glossary/lookup/case-sensitivity-miss",
			"", []Entry{
				{Source: "API", Target: "接口", CaseSensitive: true},
				{Source: "pipeline", Target: "流水线", CaseSensitive: false},
			}, "build an api for the Pipeline"),
		// file_test.go: TestFileGlossary_LongTermFirst。
		goldenLookupCase(t, "glossary/lookup/long-term-first",
			"", []Entry{
				{Source: "Gemini", Target: "哈基米"},
				{Source: "Gemini API", Target: "哈基米接口"},
			}, "we call the Gemini API today"),
		// 空文本直接返回空命中。
		goldenLookupCase(t, "glossary/lookup/empty-text",
			"", []Entry{{Source: "AI", Target: "人工智能"}}, ""),
		// 无命中。
		goldenLookupCase(t, "glossary/lookup/no-hit",
			"", []Entry{{Source: "AI", Target: "人工智能"}}, "nothing relevant here"),
		// 表内顺序按 UTF-8 字节长度降序（不是 rune 数，更不是 UTF-16 长度）。
		goldenLookupCase(t, "glossary/lookup/cjk-byte-length-order",
			"", []Entry{
				{Source: "AI", Target: "人工智能"},
				{Source: "人工智能", Target: "AI"},
				{Source: "AI技术", Target: "AI技术"},
			}, "AI技术与人工智能"),
		// 扩展 CSV：同一 source 的 1 条推荐 + 2 条禁译都能命中。
		goldenLookupCase(t, "glossary/lookup/forbidden-multiplicity",
			"source,target,case_sensitive,forbidden,mandatory,notes\n"+
				"API,接口,false,false,true,recommended\n"+
				"API,应用接口,false,true,true,banned one\n"+
				"API,应用程序接口,false,true,false,banned two\n",
			nil, "API"),
		// 大小写不敏感路径走 ToLower（含非 ASCII）。
		goldenLookupCase(t, "glossary/lookup/case-insensitive-unicode",
			"", []Entry{{Source: "Über", Target: "关于"}}, "über alles"),
		// file_test.go: TestFileGlossary_LoadSaveRoundTrip 的「重新载入后仍可命中，
		// 且 legacy 默认值（Mandatory=true / Forbidden=false）被保留」。
		goldenLookupCase(t, "glossary/lookup/legacy-roundtrip-reload",
			"source,target,case_sensitive,notes\n"+
				"LinguaFlow,灵枢,true,产品名\n"+
				"pipeline,流水线,false,\n",
			nil, "LinguaFlow pipeline"),
	)

	// ---- Add（file.go）-------------------------------------------------
	cases = append(cases,
		// file_test.go: TestFileGlossary_AddStrictMerge（三轮 Add，首写胜出）。
		goldenAddCase(t, "glossary/add/strict-merge", "", [][]Entry{
			{{Source: "Foo", Target: "原始译文"}},
			{{Source: "foo", Target: "覆盖尝试"}},
			{{Source: "Foo", Target: "再次覆盖"}},
		}),
		// file_test.go: TestFileGlossary_AddAllowsForbiddenTargetsButOneRecommendation。
		goldenAddCase(t, "glossary/add/forbidden-multiplicity", "", [][]Entry{
			{
				{Source: "API", Target: "接口", Mandatory: true},
				{Source: "API", Target: "应用接口", Forbidden: true},
				{Source: "API", Target: "应用程序接口", Forbidden: true},
			},
			{{Source: "api", Target: "端点"}},
		}),
		// file_test.go: TestFileGlossary_AddReportsConflictWithExisting。
		goldenAddCase(t, "glossary/add/conflict-with-existing", "", [][]Entry{
			{{Source: "thread pool", Target: "线程池"}},
			{{Source: "thread pool", Target: "并发池"}},
		}),
		// file_test.go: TestFileGlossary_AddSameTargetIsNoop。
		goldenAddCase(t, "glossary/add/same-target-noop", "", [][]Entry{
			{{Source: "foo", Target: "甲"}},
			{{Source: "foo", Target: "甲"}},
		}),
		// file_test.go: TestFileGlossary_AddReportsEmptySkipped。
		goldenAddCase(t, "glossary/add/empty-skipped", "", [][]Entry{
			{
				{Source: "", Target: "x"},
				{Source: "y", Target: ""},
				{Source: "z", Target: "z"},
			},
		}),
		// file_test.go: TestFileGlossary_AddDirtyFlag（空表 Add 置脏）。
		goldenAddCase(t, "glossary/add/dirty-set", "", [][]Entry{
			{{Source: "x", Target: "x"}},
		}),
		// 已保存（dirty=false）的表里 Add 一条完全相同条目 → noop 且不置脏。
		goldenAddCase(t, "glossary/add/duplicate-does-not-set-dirty",
			"source,target\nx,x\n", [][]Entry{
				{{Source: "x", Target: "x"}},
			}),
		// 空 rounds：Add() 无条目时既不改表也不置脏。
		goldenAddCase(t, "glossary/add/no-entries", "", [][]Entry{
			{},
		}),
		// Add 会 trim source / target / notes。
		goldenAddCase(t, "glossary/add/trim-fields", "", [][]Entry{
			{{Source: "  Foo  ", Target: " 福 ", Notes: "  备注  "}},
		}),
		// 已存在（大小写不敏感）→ 冲突；Existing 填表中版本。
		goldenAddCase(t, "glossary/add/conflict-after-load",
			"source,target\nFoo,福\n", [][]Entry{
				{{Source: "foo", Target: "覆"}},
			}),
		// 禁译条目同 source 不同 target 允许并存，但同 target 视为重复（noop）。
		goldenAddCase(t, "glossary/add/forbidden-same-target-noop", "", [][]Entry{
			{{Source: "bad", Target: "坏", Forbidden: true}},
			{{Source: "bad", Target: "坏", Forbidden: true}},
			{{Source: "bad", Target: "很坏", Forbidden: true}},
		}),
	)

	// ---- Save（file.go 的 csv.Writer 输出）-----------------------------
	cases = append(cases,
		// file_test.go: TestFileGlossary_LoadSaveRoundTrip 的反向（写）。
		goldenSaveCase(t, "glossary/save/legacy-roundtrip", "out.csv", []Entry{
			{Source: "LinguaFlow", Target: "灵枢", CaseSensitive: true, Mandatory: true, Notes: "产品名"},
			{Source: "pipeline", Target: "流水线", Mandatory: true},
		}),
		// file_test.go: TestFileGlossary_SaveCreatesDirAtomic（多级目录由 Save 创建）。
		goldenSaveCase(t, "glossary/save/creates-dir", "sub/deep/g.csv", []Entry{
			{Source: "x", Target: "ε", Mandatory: true},
		}),
		// 空表只写表头。
		goldenSaveCase(t, "glossary/save/empty-table", "empty.csv", nil),
		// 空 path：Save 必须失败（浏览器侧由 sink 注入路径）。
		goldenSaveCase(t, "glossary/save/empty-path", "", nil),
		// 顺序：按 UTF-8 字节长度降序后写出。
		goldenSaveCase(t, "glossary/save/byte-length-order", "ordered.csv", []Entry{
			{Source: "AI", Target: "人工智能", Mandatory: true},
			{Source: "人工智能", Target: "AI", Mandatory: true},
			{Source: "Gemini API", Target: "双子接口", Mandatory: true},
		}),
		// 需要转义的字段：逗号、双引号、换行、孤立 CR、`\.`、空字段。
		goldenSaveRawCase(t, "glossary/save/quoting", "quoted.csv", []Entry{
			{Source: "comma,source", Target: "含,逗号"},
			{Source: "quote\"inside", Target: "newline\ninside"},
			{Source: "cr\rinside", Target: "tab\tinside"},
			{Source: "dot", Target: `\.`},
			{Source: " leading-space", Target: "前导空格"},
			{Source: "", Target: "空 source"},
		}),
		// 空 target / 空 notes 不触发引号（Go 1.4 起不再给空串加引号）。
		goldenSaveRawCase(t, "glossary/save/empty-fields", "empty-fields.csv", []Entry{
			{Source: "Foo", Target: "", Notes: ""},
			{Source: "Bar", Target: "巴", Notes: ""},
		}),
	)

	// ---- SafeReplace / IsCJKTarget / CaseInsensitiveReplace ------------
	cjkLangs := []struct {
		id   string
		lang string
	}{
		{"zh", "zh"}, {"ja", "ja"}, {"ko", "ko"}, {"th", "th"},
		{"lo", "lo"}, {"my", "my"}, {"km", "km"},
		{"zh-cn", "zh-CN"}, {"zh-tw-underscore", "zh_TW"}, {"ja-jp-upper", "JA-JP"},
		{"padded", " zh "}, {"en", "en"}, {"en-us", "en-US"},
		{"es", "es"}, {"fr", "fr"}, {"de", "de"}, {"ru", "ru"},
		{"empty", ""}, {"zhh", "zhh"},
	}
	for _, tc := range cjkLangs {
		lang := tc.lang
		cases = append(cases, goldenv.Case{
			ID:     "glossary/is-cjk-target/" + tc.id,
			Op:     "glossary.is_cjk_target",
			Args:   goldenv.Args("lang", lang),
			Expect: goldenv.Expect("cjk", IsCJKTarget(lang)),
		})
	}

	cases = append(cases,
		// replace_test.go 的全部 SafeReplace 用例。
		goldenReplaceCase("glossary/replace/cjk-direct-replace-all",
			"使用 A2 时记得释放 A2 资源", "A2", "A1", "zh"),
		goldenReplaceCase("glossary/replace/cjk-no-match",
			"纯中文文本", "A2", "A1", "zh"),
		goldenReplaceCase("glossary/replace/latin-independent",
			"use AI carefully", "AI", "ML", "en"),
		goldenReplaceCase("glossary/replace/latin-substring-only",
			"wait and rain", "ai", "oo", "en"),
		goldenReplaceCase("glossary/replace/latin-mixed",
			"AI and AIfoo", "AI", "ML", "en"),
		goldenReplaceCase("glossary/replace/latin-unicode-boundary",
			"über die KI gestern", "KI", "AI", "de"),
		goldenReplaceCase("glossary/replace/latin-unicode-neighbor-letter",
			"KIüber", "KI", "AI", "de"),
		goldenReplaceCase("glossary/replace/empty-from",
			"anything", "", "X", "en"),
		goldenReplaceCase("glossary/replace/identical-from-to",
			"anything AI here", "AI", "AI", "en"),
		goldenReplaceCase("glossary/replace/latin-edge-punctuation",
			"future is AI.", "AI", "ML", "en"),
		// 追加边界：紧邻数字（词内字符）。
		goldenReplaceCase("glossary/replace/latin-neighbor-digit",
			"AI2 and 3AI", "AI", "ML", "en"),
		// 追加边界：紧邻下划线（词内字符）。
		goldenReplaceCase("glossary/replace/latin-neighbor-underscore",
			"_AI_ and AI_ok", "AI", "ML", "en"),
		// 追加边界：整串即匹配（两侧都是端点）。
		goldenReplaceCase("glossary/replace/latin-whole-string",
			"AI", "AI", "ML", "en"),
		// 追加边界：多个独立匹配全部替换。
		goldenReplaceCase("glossary/replace/latin-multiple-independent",
			"say AI, AI!", "AI", "ML", "en"),
		// 追加边界：emoji 不是词内字符 → 独立匹配。
		goldenReplaceCase("glossary/replace/latin-emoji-neighbor",
			"🎉AI🎉", "AI", "ML", "en"),
		// 追加边界：CJK 目标语下 from 出现在拉丁词内部也直接替换。
		goldenReplaceCase("glossary/replace/cjk-substring-inside-latin",
			"abcabc", "b", "X", "zh"),
		// 追加边界：to 为空串（删除）。
		goldenReplaceCase("glossary/replace/latin-delete",
			"use AI carefully", "AI", "", "en"),
		// 追加边界：空文本。
		goldenReplaceCase("glossary/replace/empty-text",
			"", "AI", "ML", "en"),
		// 追加边界：from 长于文本。
		goldenReplaceCase("glossary/replace/from-longer-than-text",
			"short", "much longer needle", "X", "en"),
	)

	ciCases := []struct {
		id   string
		text string
		old  string
		repl string
	}{
		{"basic", "Hello World", "hello", "Hi"},
		{"no-match", "Hello World", "xyz", "Hi"},
		{"empty-old", "Hello World", "", "Hi"},
		{"multiple-matches", "AI is AI good", "ai", "AI tech"},
		{"mixed-case", "This is a TeSt", "test", "example"},
		{"exact-case", "Hello World", "Hello", "Hi"},
		{"cjk-unaffected", "人工智能正在改变世界", "人工智能", "AI"},
		{"no-substring", "Hello for it", "ai", "AI"},
	}
	for _, tc := range ciCases {
		cases = append(cases, goldenReplaceCICase(
			"glossary/replace-ci/"+tc.id, tc.text, tc.old, tc.repl))
	}

	// ---- Nop -----------------------------------------------------------
	{
		var g Glossary = Nop{}
		hits, errLookup := g.Lookup(context.Background(), "anything", "", "")
		res, errAdd := g.Add(context.Background(), Entry{Source: "x", Target: "y"})
		cases = append(cases, goldenv.Case{
			ID:   "glossary/nop/empty",
			Op:   "glossary.nop",
			Args: goldenv.Args(),
			Expect: goldenv.Expect(
				"ok", errLookup == nil && errAdd == nil,
				"hits", goldenEntries(hits),
				"added", goldenEntries(res.Added),
				"skipped", goldenSkipped(res.Skipped),
			),
		})
	}

	// ---- AddForRequest 委派（request.go）--------------------------------
	{
		// requestID 非空且目标实现 RequestAdder → 走 AddForRequest。
		target := &requestAwareGolden{FileGlossary: FileGlossary{path: "golden.csv", bySource: map[string]int{}}}
		res, err := AddForRequest(context.Background(), target, "req-1",
			Entry{Source: "Foo", Target: "福"})
		if err != nil {
			t.Fatalf("AddForRequest 失败: %v", err)
		}
		cases = append(cases, goldenv.Case{
			ID:   "glossary/add-for-request/request-aware",
			Op:   "glossary.add_for_request",
			Args: goldenv.Args("requestID", "req-1", "entries", goldenEntries([]Entry{{Source: "Foo", Target: "福"}})),
			Expect: goldenv.Expect(
				"result", goldenAddResult(res),
				"requestAware", target.awareCalls > 0,
				"len", target.Len(),
			),
		})
	}
	{
		// requestID 为空 → 直接走 Add，不做类型断言。
		target := &requestAwareGolden{FileGlossary: FileGlossary{path: "golden.csv", bySource: map[string]int{}}}
		res, err := AddForRequest(context.Background(), target, "",
			Entry{Source: "Bar", Target: "巴"})
		if err != nil {
			t.Fatalf("AddForRequest 失败: %v", err)
		}
		cases = append(cases, goldenv.Case{
			ID:   "glossary/add-for-request/no-request-id",
			Op:   "glossary.add_for_request",
			Args: goldenv.Args("requestID", "", "entries", goldenEntries([]Entry{{Source: "Bar", Target: "巴"}})),
			Expect: goldenv.Expect(
				"result", goldenAddResult(res),
				"requestAware", target.awareCalls > 0,
				"len", target.Len(),
			),
		})
	}

	n, err := goldenv.Write(out, "glossary", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("glossary 黄金向量已导出: %d 条 → %s/glossary.json", n, out)
}
