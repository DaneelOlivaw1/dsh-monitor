#!/bin/bash
# 把项目治理模板铺到目标项目（默认不覆盖已存在文件）。
#
# 用法：
#   bash scripts/init-governance.sh /path/to/project [--force]

set -u
TARGET="${1:-}"
FORCE="${2:-}"
[ -z "$TARGET" ] && { echo "用法: bash scripts/init-governance.sh <目标项目目录> [--force]"; exit 1; }
[ -d "$TARGET" ] || { echo "目录不存在: $TARGET"; exit 1; }

SRC="$(cd "$(dirname "$0")/../templates/governance" && pwd)"

copied=0
skipped=0
while IFS= read -r rel; do
  dest="$TARGET/$rel"
  if [ -e "$dest" ] && [ "$FORCE" != "--force" ]; then
    skipped=$((skipped+1))
    echo "跳过（已存在）: $rel"
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$SRC/$rel" "$dest"
  copied=$((copied+1))
  echo "铺上: $rel"
done < <(cd "$SRC" && find . -type f | sed 's|^\./||')

echo
echo "完成：新增 $copied 个，跳过 $skipped 个。"
echo "下一步："
echo "  1. 改 AGENTS.md 的「项目定位」"
echo "  2. 在 .dsh/gates.yml 删掉用不上的闸门（宁少不多）"
echo "  3. 读 docs/dev-flow.md，从这里开始第 1 步"
