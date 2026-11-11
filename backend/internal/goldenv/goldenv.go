// Package goldenv 提供「黄金测试向量」导出的公共设施。
//
// 本包只服务于测试：它被各领域包的 `golden_vectors_test.go` 引用，把 Go 生产代码
// 的真实输出序列化为 JSON，供前端 `frontend/src/domain/` 的 TypeScript 移植层
// 做 100% 逐字节对拍断言。
//
// 关键约定：
//   - 生产代码零改动：本包不被任何非测试代码引用。
//   - 确定性输出：encoding/json 对 map key 按字典序排序，故输出稳定可 diff。
//   - 显式触发：仅当环境变量 LINGUAFLOW_GOLDEN_OUT 非空时才写盘，
//     常规 `go test ./...` 不会产生任何副作用。
package goldenv

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// EnvOutDir 是控制黄金向量输出目录的环境变量名。
const EnvOutDir = "LINGUAFLOW_GOLDEN_OUT"

// Case 是单条黄金向量。
//
// ID 用于定位与报告；Op 标识被测操作（TS 侧按 Op 分派）；
// Args 是输入；Expect 是 Go 侧的期望输出（由真实生产代码计算，非人工誊写）。
type Case struct {
	ID     string         `json:"id"`
	Op     string         `json:"op"`
	Args   map[string]any `json:"args"`
	Expect map[string]any `json:"expect"`
}

// Fixture 是一个领域包的黄金向量集合。
type Fixture struct {
	Package   string `json:"package"`
	Generator string `json:"generator"`
	Schema    int    `json:"schema"`
	Cases     []Case `json:"cases"`
}

// OutDir 返回黄金向量输出目录；未设置环境变量时返回空串。
func OutDir() string {
	return os.Getenv(EnvOutDir)
}

// Enabled 报告当前进程是否处于「导出模式」。
func Enabled() bool {
	return OutDir() != ""
}

// Write 把一组 Case 写入 <outDir>/<pkg>.json，并返回写入的用例数。
//
// 文件使用 2 空格缩进与尾随换行，便于人工审阅与 diff。
func Write(outDir, pkg string, cases []Case) (int, error) {
	if outDir == "" {
		return 0, fmt.Errorf("goldenv: %s 未设置", EnvOutDir)
	}
	sorted := make([]Case, len(cases))
	copy(sorted, cases)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })

	fixture := Fixture{
		Package:   pkg,
		Generator: "backend/internal/<pkg>/golden_vectors_test.go",
		Schema:    1,
		Cases:     sorted,
	}
	if fixture.Cases == nil {
		fixture.Cases = []Case{}
	}
	data, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		return 0, fmt.Errorf("goldenv: 序列化 %s 失败: %w", pkg, err)
	}
	data = append(data, '\n')

	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return 0, fmt.Errorf("goldenv: 创建输出目录失败: %w", err)
	}
	path := filepath.Join(outDir, pkg+".json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return 0, fmt.Errorf("goldenv: 写入 %s 失败: %w", path, err)
	}
	return len(fixture.Cases), nil
}

// Args 构造输入参数的便捷函数。
func Args(kv ...any) map[string]any {
	m := make(map[string]any, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		key, ok := kv[i].(string)
		if !ok {
			continue
		}
		m[key] = kv[i+1]
	}
	return m
}

// Expect 构造期望输出的便捷函数（与 Args 同构）。
func Expect(kv ...any) map[string]any { return Args(kv...) }
