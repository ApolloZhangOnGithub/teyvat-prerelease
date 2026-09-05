#!/bin/bash
# check-tools.sh — 检查所有 registerPaimonTool 调用是否有 renderCall 和 renderResult
# 用法: bash check-tools.sh <core-dir>

CORE="$1"
[ -z "$CORE" ] && CORE="."
rm -f /tmp/_check_tools_fail

grep -rl "registerPaimonTool({" "$CORE" --include="*.ts" 2>/dev/null | grep -v node_modules | while IFS= read -r f; do
  short=$(echo "$f" | sed "s|$CORE/||")
  grep -n "registerPaimonTool({" "$f" | while IFS=: read -r ln rest; do
    name=$(sed -n "$((ln+1))p" "$f" | grep -o '"[^"]*"' | head -1 | tr -d '"')
    [ -z "$name" ] && name="(unknown)"
    block=$(sed -n "${ln},$((ln+200))p" "$f")
    # 只匹配非注释行的 renderCall/renderResult（排除 // 开头的行）
    rc=$(echo "$block" | grep -v "^\s*//" | grep -c "renderCall")
    rr=$(echo "$block" | grep -v "^\s*//" | grep -c "renderResult")
    [ "$rc" = "0" ] && { echo "  ERROR: $name ($short:$ln) 缺少 renderCall"; echo 1 > /tmp/_check_tools_fail; }
    [ "$rr" = "0" ] && { echo "  ERROR: $name ($short:$ln) 缺少 renderResult"; echo 1 > /tmp/_check_tools_fail; }
  done
done

if [ -f /tmp/_check_tools_fail ]; then
  rm -f /tmp/_check_tools_fail
  exit 1
fi
echo "  tools: OK"
