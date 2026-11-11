package tm

// 黄金向量导出器：把 tm 包的匹配/排序语义序列化为 JSON，供
// frontend/src/domain/tm 的 TypeScript 移植层做 100% 深相等对拍。
//
// 重要说明：生产实现 `SQLite` 依赖 ent + 数据库，无法在无 DB 的单测里跑。
// 因此本导出器构造**纯内存的记录列表**，逐行复刻 `sqlite.go` 的查询语义：
//
//	Scope.key()               → project:<id>（ProjectID == 0 报错）
//	baseQuery(src, langs)     → project + hash.Full(TrimSpace(src)) + 语言精确相等
//	Order(usage DESC, id ASC) → 排序
//	Match{Source, Target, 1}  → Score ≡ 1，并回写 usage_count += 1
//	Add                       → 空字段 noop / 唯一键新建 / 命中则更新 / 多行报错
//
// 其中 `source_hash` 使用生产代码 `hash.Full`，与 Go 后端完全同源。
// `Expect` 仍是「Go 侧真实计算值」，只是把 SQL 的 WHERE/ORDER 用切片实现。

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
	"github.com/MeowSalty/LinguaFlow/backend/internal/hash"
)

// seed 是一条待写入内存记录列表的种子数据（对应 ent.TMEntry 的列）。
type seed struct {
	ID         int
	ProjectID  int
	SourceText string
	TargetText string
	SourceLang string
	TargetLang string
	UsageCount int
}

// goldenEntry 是内存记录。
type goldenEntry struct {
	ID         int
	ProjectID  int
	SourceHash string
	SourceText string
	TargetText string
	SourceLang string
	TargetLang string
	UsageCount int
}

// goldenStore 是 `sqlite.go` 语义的纯内存参照实现。
type goldenStore struct {
	entries []goldenEntry
	nextID  int
}

// newGoldenStore 按种子数据建库。source_hash 与生产一致：对 trim 后的原文做 Full 哈希。
func newGoldenStore(seeds ...seed) *goldenStore {
	s := &goldenStore{}
	for _, sd := range seeds {
		src := strings.TrimSpace(sd.SourceText)
		s.entries = append(s.entries, goldenEntry{
			ID:         sd.ID,
			ProjectID:  sd.ProjectID,
			SourceHash: hash.Full(src),
			SourceText: src,
			TargetText: sd.TargetText,
			SourceLang: sd.SourceLang,
			TargetLang: sd.TargetLang,
			UsageCount: sd.UsageCount,
		})
		if sd.ID > s.nextID {
			s.nextID = sd.ID
		}
	}
	return s
}

// scopeKey 等价 `Scope.key()`。
func scopeKey(projectID int) (string, error) {
	if projectID == 0 {
		return "", fmt.Errorf("tm: empty scope")
	}
	return fmt.Sprintf("project:%d", projectID), nil
}

// matches 返回与 baseQuery 条件相等的记录下标（未排序）。
func (s *goldenStore) matches(projectID int, srcHash, srcLang, tgtLang string) []int {
	var idxs []int
	for i, e := range s.entries {
		if e.ProjectID != projectID ||
			e.SourceHash != srcHash ||
			e.SourceLang != srcLang ||
			e.TargetLang != tgtLang {
			continue
		}
		idxs = append(idxs, i)
	}
	return idxs
}

// search 等价 `SQLite.Search`：Order(usage DESC, id ASC) + 命中后 usage+1。
func (s *goldenStore) search(projectID int, src, srcLang, tgtLang string) ([]Match, error) {
	if _, err := scopeKey(projectID); err != nil {
		return nil, err
	}
	src = strings.TrimSpace(src)
	srcLang = strings.TrimSpace(srcLang)
	tgtLang = strings.TrimSpace(tgtLang)
	idxs := s.matches(projectID, hash.Full(src), srcLang, tgtLang)
	if len(idxs) == 0 {
		return nil, nil
	}
	rows := make([]goldenEntry, 0, len(idxs))
	for _, i := range idxs {
		rows = append(rows, s.entries[i])
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].UsageCount != rows[j].UsageCount {
			return rows[i].UsageCount > rows[j].UsageCount
		}
		return rows[i].ID < rows[j].ID
	})
	out := make([]Match, 0, len(rows))
	for _, row := range rows {
		out = append(out, Match{Source: row.SourceText, Target: row.TargetText, Score: 1})
		for i := range s.entries {
			if s.entries[i].ID == row.ID {
				s.entries[i].UsageCount++
				break
			}
		}
	}
	return out, nil
}

// add 等价 `SQLite.Add`。
func (s *goldenStore) add(projectID int, src, tgt, srcLang, tgtLang string) error {
	src = strings.TrimSpace(src)
	tgt = strings.TrimSpace(tgt)
	srcLang = strings.TrimSpace(srcLang)
	tgtLang = strings.TrimSpace(tgtLang)
	if src == "" || tgt == "" || srcLang == "" || tgtLang == "" {
		return nil
	}
	if _, err := scopeKey(projectID); err != nil {
		return err
	}
	srcHash := hash.Full(src)
	idxs := s.matches(projectID, srcHash, srcLang, tgtLang)
	if len(idxs) == 0 {
		s.create(projectID, src, tgt, srcLang, tgtLang, srcHash)
		return nil
	}
	if len(idxs) > 1 {
		// ent 的 Only() 在多行时报 NotSingularError。
		return fmt.Errorf("tm: multiple entries for %q", src)
	}
	e := &s.entries[idxs[0]]
	if e.TargetText == tgt && e.SourceText == src {
		return nil
	}
	e.SourceText = src
	e.TargetText = tgt
	return nil
}

// create 等价 `createEntry`；唯一键冲突（ent.IsConstraintError）被吞掉。
func (s *goldenStore) create(projectID int, src, tgt, srcLang, tgtLang, srcHash string) {
	if len(s.matches(projectID, srcHash, srcLang, tgtLang)) > 0 {
		return
	}
	s.nextID++
	s.entries = append(s.entries, goldenEntry{
		ID:         s.nextID,
		ProjectID:  projectID,
		SourceHash: srcHash,
		SourceText: src,
		TargetText: tgt,
		SourceLang: srcLang,
		TargetLang: tgtLang,
		UsageCount: 0,
	})
}

// sortedEntries 按 ID 升序返回副本，保证输出稳定。
func (s *goldenStore) sortedEntries() []goldenEntry {
	out := make([]goldenEntry, len(s.entries))
	copy(out, s.entries)
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// seedArgs 序列化种子数据（不含 sourceHash：TS 侧需要自己用 fullHash 计算）。
func seedArgs(seeds []seed) []any {
	out := make([]any, 0, len(seeds))
	for _, sd := range seeds {
		out = append(out, map[string]any{
			"id":         sd.ID,
			"projectId":  sd.ProjectID,
			"sourceText": sd.SourceText,
			"targetText": sd.TargetText,
			"sourceLang": sd.SourceLang,
			"targetLang": sd.TargetLang,
			"usageCount": sd.UsageCount,
		})
	}
	return out
}

// entryJSON 序列化一条内存记录（含 source_hash）。
func entryJSON(e goldenEntry) map[string]any {
	return map[string]any{
		"id":         e.ID,
		"projectId":  e.ProjectID,
		"sourceHash": e.SourceHash,
		"sourceText": e.SourceText,
		"targetText": e.TargetText,
		"sourceLang": e.SourceLang,
		"targetLang": e.TargetLang,
		"usageCount": e.UsageCount,
	}
}

// entrySnapshot 序列化全部记录（ID 升序）。
func (s *goldenStore) entrySnapshot() []any {
	entries := s.sortedEntries()
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, entryJSON(e))
	}
	return out
}

// usageSnapshot 只暴露 id → usageCount，用于断言 Search 的回写副作用。
func (s *goldenStore) usageSnapshot() []any {
	entries := s.sortedEntries()
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, map[string]any{"id": e.ID, "usageCount": e.UsageCount})
	}
	return out
}

// matchJSON 序列化一条命中。nil 切片归一为空数组。
func matchJSONList(matches []Match) []any {
	out := make([]any, 0, len(matches))
	for _, m := range matches {
		out = append(out, map[string]any{
			"source": m.Source,
			"target": m.Target,
			"score":  float64(m.Score),
		})
	}
	return out
}

// goldenSearchCase 导出一次（或多次）Search 的真实结果。
func goldenSearchCase(t *testing.T, id string, seeds []seed, projectID int, src, srcLang, tgtLang string, times int) goldenv.Case {
	t.Helper()
	if times < 1 {
		times = 1
	}
	store := newGoldenStore(seeds...)
	args := goldenv.Args(
		"entries", seedArgs(seeds),
		"projectId", projectID,
		"src", src,
		"srcLang", srcLang,
		"tgtLang", tgtLang,
		"times", times,
	)
	var last []Match
	var searchErr error
	for i := 0; i < times; i++ {
		last, searchErr = store.search(projectID, src, srcLang, tgtLang)
	}
	if searchErr != nil {
		return goldenv.Case{
			ID:     id,
			Op:     "tm.search",
			Args:   args,
			Expect: goldenv.Expect("ok", false, "error", true),
		}
	}
	return goldenv.Case{
		ID:   id,
		Op:   "tm.search",
		Args: args,
		Expect: goldenv.Expect(
			"ok", true,
			"matches", matchJSONList(last),
			"usage", store.usageSnapshot(),
		),
	}
}

// goldenAddCase 导出一次 Add 的真实结果与写后状态。
func goldenAddCase(t *testing.T, id string, seeds []seed, projectID int, src, tgt, srcLang, tgtLang string) goldenv.Case {
	t.Helper()
	store := newGoldenStore(seeds...)
	args := goldenv.Args(
		"entries", seedArgs(seeds),
		"projectId", projectID,
		"src", src,
		"tgt", tgt,
		"srcLang", srcLang,
		"tgtLang", tgtLang,
	)
	err := store.add(projectID, src, tgt, srcLang, tgtLang)
	return goldenv.Case{
		ID:   id,
		Op:   "tm.add",
		Args: args,
		Expect: goldenv.Expect(
			"ok", err == nil,
			"error", err != nil,
			"entries", store.entrySnapshot(),
		),
	}
}

// goldenScopeCase 导出 Scope.key 的真实结果。
func goldenScopeCase(id string, projectID int) goldenv.Case {
	args := goldenv.Args("projectId", projectID)
	key, err := scopeKey(projectID)
	if err != nil {
		return goldenv.Case{
			ID:     id,
			Op:     "tm.scope",
			Args:   args,
			Expect: goldenv.Expect("ok", false, "error", true),
		}
	}
	return goldenv.Case{
		ID:     id,
		Op:     "tm.scope",
		Args:   args,
		Expect: goldenv.Expect("ok", true, "key", key),
	}
}

// TestGoldenVectors 导出 tm 包的黄金测试向量。
//
// 仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘；常规 go test 不产生副作用。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	cases := make([]goldenv.Case, 0, 64)

	// ---- source_hash（生产 hash.Full，先 trim 再哈希）------------------
	hashInputs := []struct{ id, src string }{
		{"empty", ""},
		{"ascii", "hello"},
		{"sentence", "hello world"},
		{"padded", "   padded   "},
		{"cjk", "人工智能"},
		{"emoji", "🎉 emoji"},
		{"upper", "Hello"},
		{"lower", "hello"},
		{"internal-spaces", "  a  b  "},
	}
	for _, tc := range hashInputs {
		src := tc.src
		cases = append(cases, goldenv.Case{
			ID:     "tm/source-hash/" + tc.id,
			Op:     "tm.source_hash",
			Args:   goldenv.Args("src", src),
			Expect: goldenv.Expect("hash", hash.Full(strings.TrimSpace(src))),
		})
	}

	// ---- Scope.key -----------------------------------------------------
	cases = append(cases,
		goldenScopeCase("tm/scope/project-7", 7),
		goldenScopeCase("tm/scope/project-1", 1),
		goldenScopeCase("tm/scope/empty", 0),
	)

	// ---- Search：完全相等匹配 + Score≡1 + usage_count 排序 --------------
	cases = append(cases,
		// 单条精确命中。
		goldenSearchCase(t, "tm/search/exact-hit",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "hello", "en", "zh", 1),
		// 查询串首尾空白被 trim，但返回存储的原文。
		goldenSearchCase(t, "tm/search/trimmed-query",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "  hello  ", "en", "zh", 1),
		// 大小写不同 → 哈希不同 → 不命中（完全相等匹配）。
		goldenSearchCase(t, "tm/search/case-sensitive",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "Hello", "en", "zh", 1),
		// 源语言不匹配。
		goldenSearchCase(t, "tm/search/source-lang-mismatch",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "hello", "ja", "zh", 1),
		// 目标语言不匹配。
		goldenSearchCase(t, "tm/search/target-lang-mismatch",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "hello", "en", "ja", 1),
		// 语言串首尾空白被 trim。
		goldenSearchCase(t, "tm/search/trimmed-langs",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "hello", " en ", " zh ", 1),
		// 项目隔离：不同 project 的相同原文不命中。
		goldenSearchCase(t, "tm/search/project-isolation",
			[]seed{{ID: 1, ProjectID: 2, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "hello", "en", "zh", 1),
		// 空查询：哈希为空串，不会命中任何合法条目。
		goldenSearchCase(t, "tm/search/empty-query",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "", "en", "zh", 1),
		// 空库。
		goldenSearchCase(t, "tm/search/empty-store", nil, 1, "hello", "en", "zh", 1),
		// 排序：usage_count DESC，平局按 ID ASC（同一 source 的多行）。
		goldenSearchCase(t, "tm/search/usage-order",
			[]seed{
				{ID: 3, ProjectID: 1, SourceText: "dup", TargetText: "丙", SourceLang: "en", TargetLang: "zh", UsageCount: 5},
				{ID: 1, ProjectID: 1, SourceText: "dup", TargetText: "甲", SourceLang: "en", TargetLang: "zh", UsageCount: 5},
				{ID: 2, ProjectID: 1, SourceText: "dup", TargetText: "乙", SourceLang: "en", TargetLang: "zh", UsageCount: 9},
			},
			1, "dup", "en", "zh", 1),
		// 连续两次搜索：全部命中行的 usage_count 都 +2，排序不变。
		goldenSearchCase(t, "tm/search/usage-increment-twice",
			[]seed{
				{ID: 1, ProjectID: 1, SourceText: "dup", TargetText: "甲", SourceLang: "en", TargetLang: "zh", UsageCount: 2},
				{ID: 2, ProjectID: 1, SourceText: "dup", TargetText: "乙", SourceLang: "en", TargetLang: "zh", UsageCount: 5},
			},
			1, "dup", "en", "zh", 2),
		// 同原文、不同语言对：只有匹配语言对的那条命中。
		goldenSearchCase(t, "tm/search/language-pair-separation",
			[]seed{
				{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"},
				{ID: 2, ProjectID: 1, SourceText: "hello", TargetText: "こんにちは", SourceLang: "en", TargetLang: "ja"},
			},
			1, "hello", "en", "zh", 1),
		// 空 scope：Search 报错。
		goldenSearchCase(t, "tm/search/empty-scope",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			0, "hello", "en", "zh", 1),
	)

	// ---- Add：新建 / 幂等 / 更新 / 非法 / 多行冲突 ----------------------
	cases = append(cases,
		// 新建：id 自增，usage_count=0，source_hash=Full(trim(src))。
		goldenAddCase(t, "tm/add/create", nil, 1, "hello", "你好", "en", "zh"),
		// 新建时 trim 原文/译文/语言。
		goldenAddCase(t, "tm/add/create-trimmed", nil, 1, "  hello  ", " 你好 ", " en ", " zh "),
		// 完全相同的重复 Add → noop（不新建、不改动）。
		goldenAddCase(t, "tm/add/duplicate-noop",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "hello", "你好", "en", "zh"),
		// 同 key 不同译文 → 更新原记录（不新建）。
		goldenAddCase(t, "tm/add/update-target",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "hello", "嗨", "en", "zh"),
		// trim 后同 key → 更新。
		goldenAddCase(t, "tm/add/update-after-trim",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "  hello  ", "嗨", "en", "zh"),
		// 空 src / 空 tgt / 空语言：静默 noop。
		goldenAddCase(t, "tm/add/invalid-empty-src", nil, 1, "", "你好", "en", "zh"),
		goldenAddCase(t, "tm/add/invalid-empty-tgt", nil, 1, "hello", "", "en", "zh"),
		goldenAddCase(t, "tm/add/invalid-empty-src-lang", nil, 1, "hello", "你好", "", "zh"),
		goldenAddCase(t, "tm/add/invalid-empty-tgt-lang", nil, 1, "hello", "你好", "en", ""),
		// 空 scope + 空 src：先命中空字段短路，不报错。
		goldenAddCase(t, "tm/add/empty-scope-invalid-short-circuit", nil, 0, "", "你好", "en", "zh"),
		// 空 scope + 合法字段：报错。
		goldenAddCase(t, "tm/add/empty-scope-error", nil, 0, "hello", "你好", "en", "zh"),
		// 项目隔离：同一原文在不同 project 各自新建一条。
		goldenAddCase(t, "tm/add/project-isolation",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			2, "hello", "你好", "en", "zh"),
		// 大小写不同是不同条目（完全相等匹配）。
		goldenAddCase(t, "tm/add/case-sensitive-distinct",
			[]seed{{ID: 1, ProjectID: 1, SourceText: "hello", TargetText: "你好", SourceLang: "en", TargetLang: "zh"}},
			1, "Hello", "您好", "en", "zh"),
		// 同 key 存在多行（历史脏数据）→ Add 报错（ent Only 的 NotSingular）。
		goldenAddCase(t, "tm/add/multiple-existing-error",
			[]seed{
				{ID: 1, ProjectID: 1, SourceText: "dup", TargetText: "甲", SourceLang: "en", TargetLang: "zh"},
				{ID: 2, ProjectID: 1, SourceText: "dup", TargetText: "乙", SourceLang: "en", TargetLang: "zh"},
			},
			1, "dup", "丙", "en", "zh"),
	)

	// ---- Nop -----------------------------------------------------------
	{
		var memory TranslationMemory = Nop{}
		hits, searchErr := memory.Search(context.Background(), "anything", "en", "zh")
		addErr := memory.Add(context.Background(), "hello", "你好", "en", "zh")
		cases = append(cases, goldenv.Case{
			ID:   "tm/nop/empty",
			Op:   "tm.nop",
			Args: goldenv.Args(),
			Expect: goldenv.Expect(
				"ok", searchErr == nil && addErr == nil,
				"matches", matchJSONList(hits),
			),
		})
	}

	n, err := goldenv.Write(out, "tm", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("tm 黄金向量已导出: %d 条 → %s/tm.json", n, out)
}
