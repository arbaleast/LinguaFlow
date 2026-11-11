#!/usr/bin/env bash
# 重新生成「黄金测试向量」（Golden Vectors）。
#
# 黄金向量由 Go 侧生产代码的真实输出导出，供前端 `frontend/src/domain/` 的
# TypeScript 移植层做 100% 逐字节对拍断言。
#
# 用法：
#   bash scripts/gen-golden-vectors.sh            # 重新生成全部向量
#   bash scripts/gen-golden-vectors.sh protect    # 只生成指定包
#
# 说明：
#   - 只写 `frontend/src/domain/__fixtures__/*.json`，不触碰任何生产代码；
#   - 每个包的导出器是包内的 `golden_vectors_test.go`（仅 `_test.go` 文件）；
#   - 未设置 `LINGUAFLOW_GOLDEN_OUT` 时导出器会 `t.Skip`，故常规 `go test` 无副作用。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.tooling"

# Go 工具链环境（工作区内置，避免依赖宿主 PATH）。
export GOROOT="$TOOLS/go"
export GOPATH="$TOOLS/gopath"
export GOMODCACHE="$TOOLS/gomodcache"
export GOCACHE="$TOOLS/gocache"
export GOTMPDIR="$TOOLS/tmp"
export HOME="$TOOLS/home"
export PATH="$GOROOT/bin:$PATH"
mkdir -p "$GOMODCACHE" "$GOCACHE" "$GOTMPDIR" "$HOME"

OUT_DIR="$ROOT/frontend/src/domain/__fixtures__"
mkdir -p "$OUT_DIR"
export LINGUAFLOW_GOLDEN_OUT="$OUT_DIR"

# 参与黄金向量导出的 Go 包（顺序即导出顺序）。
ALL_PACKAGES=(
  hash
  protect
  pipeline
  repair
  ruby
  markup
  correct
  glossary
  tm
  script
  qa
  prompt
)

if [ "$#" -gt 0 ]; then
  PACKAGES=("$@")
else
  PACKAGES=("${ALL_PACKAGES[@]}")
fi

cd "$ROOT/backend"

for pkg in "${PACKAGES[@]}"; do
  dir="internal/$pkg"
  if [ ! -d "$dir" ]; then
    echo "跳过不存在的包: $dir" >&2
    continue
  fi
  if [ ! -f "$dir/golden_vectors_test.go" ]; then
    echo "跳过（无 golden_vectors_test.go）: $dir" >&2
    continue
  fi
  echo "==> 导出黄金向量: $dir"
  go test "./$dir/" -run TestGoldenVectors -v 2>&1 | grep -E '黄金向量已导出|FAIL|ok ' || true
done

echo
echo "黄金向量输出目录: $OUT_DIR"
ls -la "$OUT_DIR"
