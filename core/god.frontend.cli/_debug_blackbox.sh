#!/bin/bash
# _debug_blackbox.sh — pi 终端黑匣子录屏
# 用法: _debug_blackbox.sh <person-id> <person-name> <role> -- <command...>
# 用 macOS 自带 script 命令录（分配 pty，不干扰 TUI）

PERSON_ID="$1"; shift
PERSON_NAME="$1"; shift
ROLE="$1"; shift
shift # skip --

if [ -z "$PERSON_ID" ] || [ $# -eq 0 ]; then
  exec "$@" 2>/dev/null || exit 1
fi

BOX_DIR="$HOME/.teyvat/BlackboxData/$PERSON_ID"
mkdir -p "$BOX_DIR"

TS=$(date +%Y%m%d-%H%M%S)
LOG_FILE="$BOX_DIR/${TS}-${ROLE}.log"

echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"person\":\"$PERSON_NAME\",\"id\":\"$PERSON_ID\",\"role\":\"$ROLE\",\"log\":\"$LOG_FILE\",\"cmd\":\"$*\"}" >> "$BOX_DIR/manifest.jsonl"

# script 命令跨平台差异：macOS(BSD) 支持 `script -q file cmd...`（file 后全部当 command）；
# GNU util-linux script 会把 cmd 里的 -x 选项误当自己的选项（如 node 的 -ne → "无效的选项 -- n"），
# 需用 -c 传命令串。printf %q 保留参数边界防引号破坏。
if [ "$(uname)" = "Darwin" ]; then
  exec script -q "$LOG_FILE" "$@"
else
  exec script -q -c "$(printf '%q ' "$@")" "$LOG_FILE"
fi
