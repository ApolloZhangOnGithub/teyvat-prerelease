#!/bin/bash
# install-prerelease.sh — 新电脑一键部署 genshin prerelease（发布线 alpha）
# 用法: curl -fsSL paimon.beer/install-prerelease | bash
# 2026-09-09 房东定稿：所有依赖自动装 + 并行 + 动画（不串行不干等）
set -e
B='\033[1m'; D='\033[90m'; CY='\033[36m'; GRN='\033[32m'; Y='\033[33m'; RED='\033[31m'; R='\033[0m'
step() { echo -e "\n  ${CY}${B}▸ $1${R}"; }
ok()   { echo -e "  ${GRN}✓${R} $1"; }
err()  { echo -e "  ${RED}✗${R} $1"; exit 1; }

echo ""
echo -e "  ${B}genshin prerelease 安装${R}  ${D}(发布线 alpha)${R}"

OS=$(uname)
SUTO=""; [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && SUTO="sudo "

# ── 动画：spinner + 后台任务 ──
spinner() { # $1=pid $2=label——转圈直到进程结束
  local pid=$1 label="$2" chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
  printf "  ${D}%s  " "$label"
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${CY}%s${D} %s${R}" "${chars:i%10:1}" "$label"
    i=$((i+1)); sleep 0.08
  done
  printf "\r                        \r"
}
run_bg() { # $1=label 其余=命令——后台跑 + spinner 等待，返回退出码
  local label="$1"; shift
  "$@" >/dev/null 2>&1 &
  local pid=$!
  spinner "$pid" "$label"
  wait "$pid"
}

DIR="$HOME/.local/lib/teyvat/update-prerelease"
mkdir -p "$(dirname "$DIR")"

# ── 阶段 1：并行（拉仓库 + 装依赖 + 装 bun 三路同时）──
step "1/3 并行准备（拉发布仓库 + 装依赖 + bun）"

# 路 A：拉 prerelease 仓库
A_LABEL="拉 prerelease 仓库"
if [ ! -d "$DIR/.git" ]; then
  ( git clone --depth 1 https://github.com/ApolloZhangOnGithub/paimon-code-prerelease.git "$DIR" ) >/dev/null 2>&1 &
else
  ( git -C "$DIR" pull --ff-only ) >/dev/null 2>&1 &
  A_LABEL="更新 prerelease 仓库"
fi
A_PID=$!

# 路 B：系统依赖（brew/apt 一次装全）+ 路 C：bun（多路）——合并后台
MISSING=""
for c in git node tmux ffmpeg python3; do command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"; done
( if [ -n "$MISSING" ]; then
    if [ "$OS" = "Darwin" ]; then
      command -v brew >/dev/null 2>&1 || { /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/null >/dev/null 2>&1 || true; export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; }
      brew install git node tmux ffmpeg python3 >/dev/null 2>&1 || true
    else
      (${SUTO}apt-get update -qq >/dev/null 2>&1 && ${SUTO}apt-get install -y -qq git nodejs npm tmux ffmpeg python3 python3-pip >/dev/null 2>&1) || \
      (${SUTO}dnf install -y -q git nodejs tmux ffmpeg python3 python3-pip >/dev/null 2>&1) || \
      (${SUTO}yum install -y -q git nodejs tmux ffmpeg python3 python3-pip >/dev/null 2>&1) || true
    fi
  fi
  command -v bun >/dev/null 2>&1 || { curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true; command -v bun >/dev/null 2>&1 || npm install -g bun >/dev/null 2>&1 || true; }
  export PATH="$HOME/.bun/bin:$(npm config get prefix 2>/dev/null)/bin:$PATH"
) >/dev/null 2>&1 &
B_PID=$!

# 并行等待 + 转圈（先等仓库——快）
spinner "$A_PID" "$A_LABEL"
wait "$A_PID" || err "clone/pull prerelease 失败（网络/代理？）"
spinner "$B_PID" "安装依赖 + bun（git/node/tmux/ffmpeg/python3/bun）"
wait "$B_PID"

# 复查必需
command -v git  >/dev/null || err "git 装失败——手动: ${SUTO}brew install git / apt install git"
command -v node >/dev/null || err "node 装失败——手动: brew install node / apt install nodejs"
command -v bun  >/dev/null || err "bun 装失败——手动: curl -fsSL https://bun.sh/install | bash"

# ── 阶段 2：部署（直接显示 install.sh 真实步骤——不屏蔽，用户要看在干嘛）──
step "2/3 部署 genshin（runtime + 扩展 + launcher——见下方步骤）"
cd "$DIR"
export PAIMON_VIA_MAKE=1 MAKELEVEL=1 PAIMON_CHANNEL=prerelease
bash deploy/install.sh || err "部署失败——上面有具体报错，贴给我"

# ── 阶段 3：完成 ──
step "3/3 完成"
ok "安装完成！"
echo ""
echo -e "  ${B}启动:${R} genshin <agent名含数字>（如 genshin alice_20260909）"
echo -e "  ${B}列表:${R} genshin"
echo -e "  ${B}更新:${R} genshin update"
