package hash

import (
	"testing"

	"github.com/MeowSalty/LinguaFlow/backend/internal/goldenv"
)

// TestGoldenVectors 导出 hash 包的黄金测试向量（SHA-256 字节级一致性）。
//
// 仅当设置 LINGUAFLOW_GOLDEN_OUT 时写盘；常规 go test 不产生副作用。
func TestGoldenVectors(t *testing.T) {
	out := goldenv.OutDir()
	if out == "" {
		t.Skip("未设置 " + goldenv.EnvOutDir + "，跳过黄金向量导出")
	}

	inputs := []string{
		"",
		"a",
		"abc",
		"hello world",
		"中文段落",
		"混合 mixed 文本 123",
		"🎉 emoji 🚀 surrogate pair",
		"𠀀𠀁 CJK Ext B",
		"line1\nline2\r\nline3",
		"tab\there",
		"  leading and trailing  ",
		"__LF_000001__",
		"重复重复重复重复重复",
		"!@#$%^&*()_+-=[]{}|;':\",./<>?",
		"héllo wörld",
		"مرحبا بالعالم",
		"Привет мир",
	}

	cases := make([]goldenv.Case, 0, len(inputs))
	for _, in := range inputs {
		cases = append(cases, goldenv.Case{
			ID:   "hash/" + sanitize(in),
			Op:   "hash.compute",
			Args: goldenv.Args("text", in),
			Expect: goldenv.Expect(
				"short", Short(in),
				"full", Full(in),
			),
		})
	}

	n, err := goldenv.Write(out, "hash", cases)
	if err != nil {
		t.Fatalf("写入黄金向量失败: %v", err)
	}
	t.Logf("hash 黄金向量已导出: %d 条 → %s/hash.json", n, out)
}

// sanitize 把输入文本转成可读且稳定的用例 ID。
func sanitize(s string) string {
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
