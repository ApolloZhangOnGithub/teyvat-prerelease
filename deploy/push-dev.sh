#!/bin/bash
# push-dev.sh — 从 DEV 直接 push 到 github-dev，不打包不复制
# 用法: bash C.deploy/push-dev.sh [commit message]
#
# 2026-09-11（prime-agent）修复：
#   ① 旧写法 `SCRIPT_DIR/../..` 是** Continents 重构前**的假设（那时 deploy 在 Codebase/deploy/，两跳才到 DEV 根）。
#      现在 SCRIPT_DIR=C.deploy，两跳会到 TEYVAT/ —— 也就是会把**上层目录** git init 并 force-push 到 teyvat-dev；
#      ② 它会往那写 .gitignore，可能覆盖仓库自己那份（A.core/.gitignore 里有 *.LESSON/*.SPEC 等规则）。
#   改动：只在确认布局后操作；push 根与 build-release.sh 的 build_dev 一致 = A.core（teyvat-dev 根 = A.core 内容 + Docs/）。
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"          # 仓库根（含 A.core/ C.deploy/ B.docs/）
# fail-closed：布局不对就直接停，绝不在未知目录里 git init / force-push
if [ ! -f "$ROOT/A.core/package.json" ]; then
  echo "  ERROR: 期望 $ROOT 是仓库根（应含 A.core/package.json），实际不是。"
  echo "         请勿在布局不符时运行本脚本（历史上它会 git init + force-push 错误目录）。"
  exit 1
fi
DEV="$ROOT/A.core"                            # push 根 = A.core（与 build-release.sh 的 build_dev 一致）
git -C "$DEV" rev-parse --git-dir >/dev/null 2>&1 || { echo "  ERROR: $DEV 不是 git 仓库"; exit 1; }

echo "── push-dev ──"

# .gitignore：只在缺失时补一份最小版，绝不覆盖仓库自己的（A.core/.gitignore 有 *.LESSON/*.SPEC 等规则）
if [ ! -f "$DEV/.gitignore" ]; then
  cat > "$DEV/.gitignore" << 'EOF'
.DS_Store
__pycache__/
*.pyc
*.pyo
node_modules/
*.log
.env
.env.*
*.pem
*.key
*.crt
data/cookies/
authorize.TRUST
head.ears/ears-config.json
*ABANDONED*
*REMOVED*
debug/debug.data.logs/
App/openchamber/node_modules/
App/openchamber/bun.lock
EOF
fi   # ← if [ ! -f "$DEV/.gitignore" ]

git -C "$DEV" add -A
if git -C "$DEV" diff --cached --quiet 2>/dev/null; then
  echo "  无变更。"
  exit 0
fi

MSG="${1:-dev $(date '+%m-%d %H:%M')}"
git -C "$DEV" commit -m "$MSG"
git -C "$DEV" push origin main --force
echo "  OK pushed → github-dev"
echo ""
echo "  另一台机器（仓库是私有的，raw.githubusercontent 匿名取不到 —— 用官方入口）："
echo "    bash <(curl -fsSL https://paimon.beer/install-dev)"
