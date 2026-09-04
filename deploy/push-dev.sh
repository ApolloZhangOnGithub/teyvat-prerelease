#!/bin/bash
# push-dev.sh — 从 DEV 直接 push 到 github-dev，不打包不复制
# 用法: bash Codebase/deploy/push-dev.sh [commit message]
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEV="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "── push-dev ──"

cd "$DEV"

# 确保有 git
if [ ! -d .git ]; then
  git init -b main
  git remote add origin https://github.com/ApolloZhangOnGithub/teyvat-dev.git 2>/dev/null || echo "remote already exists" >&2
  echo "  OK git init"
fi

# 确保 .gitignore 存在
cat > .gitignore << 'EOF'
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

git add -A
if git diff --cached --quiet 2>/dev/null; then
  echo "  无变更。"
  exit 0
fi

MSG="${1:-dev $(date '+%m-%d %H:%M')}"
git commit -m "$MSG"
git push origin main --force
echo "  OK pushed → github-dev"
echo ""
echo "  另一台机器:"
echo "    git clone https://github.com/ApolloZhangOnGithub/teyvat-dev.git"
echo "    cd teyvat-dev && bash Codebase/deploy/install.sh"
