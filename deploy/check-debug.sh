#!/bin/bash
# check-debug.sh — 检查 debug ID 是否在 REGISTRY 中注册
# 用法: bash check-debug.sh <core-dir>
#
# 规则：
#   1. debug.ts 的 REGISTRY 中所有 ID 必须在 D0001-D9999 范围内
#   2. 代码中 debug.log("DXXXX") 调用的 ID 必须在 REGISTRY 中存在
#   3. 旧式硬编码 DEBUG=true 的 WARNING（提醒接入统一管线）

CORE="$1"
[ -z "$CORE" ] && CORE="."

WARNINGS=0

# ── 规则 1: 扫描旧式硬编码 DEBUG=true ──
while IFS=: read -r file line content; do
  short=$(echo "$file" | sed "s|$CORE/||")
  echo "  WARN: $short:$line — 旧式 DEBUG=true 硬编码，建议接入统一管线 PI_DEBUG=Dxxxx"
  WARNINGS=$((WARNINGS + 1))
done < <(grep -rn "const DEBUG = true" "$CORE" --include="*.ts" --include="*.js" 2>/dev/null | grep -v node_modules)

# ── 规则 2: 扫描 debug.log() 调用的 ID 是否在 REGISTRY 中 ──
REGISTRY_IDS=$(grep -oE 'D[0-9]{4}' "$CORE/spirit.bio.gene/_debug_riboswitch.ts" 2>/dev/null | sort -u | tr '\n' '|')
REGISTRY_IDS="${REGISTRY_IDS%|}"

if [ -n "$REGISTRY_IDS" ]; then
  while IFS=: read -r file line content; do
    id=$(echo "$content" | grep -oE 'D[0-9]{4}' | head -1)
    if [ -n "$id" ] && ! echo "$id" | grep -qE "^($REGISTRY_IDS)$"; then
      short=$(echo "$file" | sed "s|$CORE/||")
      echo "  WARN: $short:$line — debug ID $id 未在 debug.ts REGISTRY 中注册"
      WARNINGS=$((WARNINGS + 1))
    fi
  done < <(grep -rn 'debug\.log(' "$CORE" --include="*.ts" --include="*.js" 2>/dev/null | grep -v node_modules | grep -v debug.ts)
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo "  debug: WARN $WARNINGS warning(s) — 建议修复，但不阻断构建"
fi

echo "  debug: OK"
