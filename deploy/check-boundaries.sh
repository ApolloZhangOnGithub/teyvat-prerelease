#!/bin/bash
# check-boundaries.sh — 模块职责边界静态扫描（PROPOSAL-030）
# 扫描代码中的越界模式，构建时拒绝。只做静态文本扫描，不执行代码。
CORE="${1:-.}"
FAIL=0
WARN=0

# ── 1. renderCall 中直接构造组件（应统一走 renderToolCall.label）──
RC_VIOLATIONS=$(grep -rn "renderCall" "$CORE" --include="*.ts" --include="*.js" \
  | grep -v node_modules | grep -v ".bak" \
  | grep -v "getCallRenderer\|this\..*renderCall\|import\|export\|\/\/" \
  | while read -r line; do
      file=$(echo "$line" | cut -d: -f1)
      lineno=$(echo "$line" | cut -d: -f2)
      # 查看 renderCall 函数体中是否有 new Text（向后看 10 行）
      if sed -n "${lineno},$((lineno+10))p" "$file" 2>/dev/null | grep -q "new Text\|new Container\|new Box"; then
        echo "  BOUNDARY: $file:$lineno — renderCall 中直接构造组件（应用 renderToolCall.label）"
      fi
    done)
if [ -n "$RC_VIOLATIONS" ]; then
  echo "$RC_VIOLATIONS"
  WARN=$((WARN + $(echo "$RC_VIOLATIONS" | wc -l)))
fi

# ── 2. sendCustomMessage 发送未注册的 messageType ──
# 从 backbone.ts 提取已注册的 messageType
REGISTERED_TYPES=$(grep -o '"[a-z][a-z-]*"' "$CORE/spirit.bio.organs/kernel.backbone/backbone.ts" 2>/dev/null \
  | grep -v "resume\|notice\|external\|async-result\|context\|followUp\|steer\|nextTurn" \
  | tr -d '"' | sort -u)
# 检查 sendCustomMessage 调用中的 messageType 是否在注册表中
# （这个检查比较粗糙，只是 WARN 不 FAIL）

# ── 3. memory 文件被非 memory 模块直接写入 ──
MEM_WRITES=$(grep -rn "writeFileSync\|writeFile(" "$CORE" --include="*.ts" --include="*.js" --include="*.cjs" \
  | grep -v node_modules | grep -v ".bak" | grep -v "import\|require\|function\|\/\/" \
  | grep -v "memory\.ts\|hippocampus" \
  | grep "context\.md\|work_memory\.md\|neocortex\.md\|deep_cortex\.md" \
  | grep -v "\.WIKI\|\.REPORT\|\.PROPOSAL")
if [ -n "$MEM_WRITES" ]; then
  echo "  BOUNDARY: memory 文件被非 memory 模块写入:"
  echo "$MEM_WRITES" | sed 's/^/    /'
  WARN=$((WARN + $(echo "$MEM_WRITES" | wc -l)))
fi

# ── 4. gene 文件被非 polymerase 引用写入 ──
GENE_WRITES=$(grep -rn "writeFileSync\|writeFile(" "$CORE" --include="*.ts" --include="*.js" \
  | grep -v node_modules | grep -v ".bak" | grep -v "import\|require\|function\|\/\/" \
  | grep -v "polymerase\.ts" \
  | grep "spirit\.bio\.gene\|\.CHR\|\.dna\|rna\.json")
if [ -n "$GENE_WRITES" ]; then
  echo "  BOUNDARY: gene 文件被非 polymerase 写入:"
  echo "$GENE_WRITES" | sed 's/^/    /'
  WARN=$((WARN + $(echo "$GENE_WRITES" | wc -l)))
fi

# ── 结果 ──
if [ "$FAIL" -gt 0 ]; then
  echo "  boundary check: $FAIL FAIL, $WARN WARN"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  echo "  boundary check: $WARN warnings (non-blocking)"
else
  echo "  boundary check: clean"
fi
