#!/bin/bash
# bootstrap.sh — 新电脑一键部署 teyvat
# 用法: curl -fsSL paimon.beer/install-dev | bash
#
# 前提: git, node (>=18), bun, gh (GitHub CLI, 已 gh auth login)
set -e

R='\033[0m'; G='\033[32m'; Y='\033[33m'; B='\033[1m'; D='\033[90m'
step() { echo -e "\n  ${B}[$1]${R} $2"; }
ok()   { echo -e "  ${G}✓${R} $1"; }
warn() { echo -e "  ${Y}!${R} $1"; }
die()  { echo -e "  \033[31m✗${R} $1"; exit 1; }

echo ""
echo -e "  ${B}teyvat${R} bootstrap"
echo -e "  ───────────────────────────────────"

# ── 0. 检查依赖 ──
step 0 "检查依赖"
command -v git  >/dev/null || die "需要 git"
command -v node >/dev/null || die "需要 node (>=18)"
command -v bun  >/dev/null || die "需要 bun (curl -fsSL https://bun.sh/install | bash)"
command -v gh   >/dev/null || die "需要 gh CLI ($([ "$(uname)" = "Darwin" ] && echo "brew install gh" || echo "https://cli.github.com") && gh auth login)"
gh auth status  >/dev/null 2>&1 || die "请先 gh auth login"
ok "git, node, bun, gh"

command -v tmux    >/dev/null || warn "tmux 未安装 — 元意识/睡眠功能需要"
command -v ffmpeg  >/dev/null || warn "ffmpeg 未安装 — 语音输入/音频播放需要"
command -v python3 >/dev/null || warn "python3 未安装 — session 初始化需要"

# ── 1. 克隆源码 ──
step 1 "克隆源码"
INSTALL_DIR="$HOME/.local/lib/teyvat/source"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "  ${D}已存在，更新...${R}"
  cd "$INSTALL_DIR" && git fetch -q origin && git reset -q --hard origin/main
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  gh repo clone ApolloZhangOnGithub/teyvat-dev "$INSTALL_DIR" -- --depth 1
fi
ok "源码 → $INSTALL_DIR"

# ── 2. 安装依赖 ──
step 2 "安装依赖"
cd "$INSTALL_DIR/A.core"
if [ ! -d "node_modules" ]; then
  bun install 2>&1 | tail -3
fi
ok "node_modules"

# ── 3. 部署 runtime / overrides / extensions ──
step 3 "部署 teyvat"
RUNTIME="$HOME/.local/lib/teyvat/runtime"
if [ -f "$RUNTIME/.teyvat-install-manifest" ]; then
  echo -e "  ${D}检测到旧安装，清理 manifest 重新部署...${R}"
  : > "$RUNTIME/.teyvat-install-manifest"
fi
PAIMON_VIA_MAKE=1 PAIMON_CHANNEL="minutely" PAIMON_VER="bootstrap" bash "$INSTALL_DIR/C.deploy/install.sh" || die "部署失败"

# ── 4. 登录 ──
step 4 "登录"
if genshin whoami >/dev/null 2>&1; then
  ok "已登录: $(genshin whoami 2>&1 | head -1 | sed 's/^ *//')"
else
  genshin login
fi

# ── 5. 同步数据 ──
step 5 "同步数据"
curl -sf --connect-timeout 5 https://sync.paimon.beer/health >/dev/null 2>&1 || die "sync 服务不可用 (sync.paimon.beer)"
ok "sync 服务连通"
genshin sync pull 2>&1 || die "数据同步失败"
ok "同步完成"

# ── 完成 ──
echo ""
echo -e "  ${G}${B}安装完成${R}"
echo ""
echo -e "  使用: ${B}genshin <agent名>${R}  启动/进入 agent"
echo -e "        ${B}genshin${R}             列出所有 agent"
echo -e "        ${B}genshin sync${R}        查看同步状态"
echo ""
