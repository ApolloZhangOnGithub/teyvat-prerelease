#!/bin/bash
# teyvat installer — 必须通过 make 调用，不要直接 bash install.sh
# 防裸 install：① PAIMON_VIA_MAKE=1（make 流程显式声明）② MAKELEVEL 非空（make 自动注入的环境变量，
# 手动 bash/手动 export 伪造不了——2026-08-27 用户定稿：必须用 make）
[ "$PAIMON_VIA_MAKE" = "1" ] && [ -n "${MAKELEVEL:-}" ] || { echo "ERROR: 不要直接跑 install.sh。用 make dev-minutely。"; exit 1; }

PIN="0.80.7"
R='\033[0m'; RED='\033[31m'; GRN='\033[32m'; YLW='\033[33m'; DIM='\033[90m'
ok()   { echo -e "  ${GRN}OK${R}  $1"; }
warn() { echo -e "  ${YLW}WARN${R}  $1"; }
err()  { echo -e "  ${RED}ERROR${R}  $1"; exit 1; }
quiet_cp() { cp "$1" "$2" 2>/dev/null; }

# ── 定位源码 ──
# ⚠️ 2026-09-07 错误警示（LESSON 067）：wsl-compatibility-researcher-01 曾在此新增
#   "elif [ -d "$PKG_ROOT/deploy" ]" 分支（适配其擅自把 C.deploy 迁到 A.core/deploy/ 的结构）。
#   该迁移未获用户批准已回滚——**不要加 deploy/ 子目录分支、不要为"deploy 在 A.core 内"的结构服务**。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -d "$PKG_ROOT/A.core" ] && [ -f "$PKG_ROOT/A.core/package.json" ]; then
  IMPL="$PKG_ROOT/A.core"; DEPLOY="$PKG_ROOT/C.deploy"
elif [ -d "$PKG_ROOT/Codebase/core" ]; then
  IMPL="$PKG_ROOT/Codebase/core"; DEPLOY="$PKG_ROOT/Codebase/deploy"
elif [ -d "$PKG_ROOT/core" ]; then
  IMPL="$PKG_ROOT/core"; DEPLOY="$PKG_ROOT/deploy"
else
  err "core/ not found"
fi

echo ""
echo -e "  ${GRN}teyvat${R} installer"
echo "  ─────────────────────────────────────"

# ── 0. 系统依赖检查 + 自动装 ──
DEP_WARN=0

# 平台 / 架构（node 官方 tarball 用）
_TV_OS=$(uname -s)
_TV_ARCH=$(uname -m)
case "$_TV_ARCH" in x86_64|amd64) _NODE_ARCH=x64 ;; arm64|aarch64) _NODE_ARCH=arm64 ;; *) _NODE_ARCH=x64 ;; esac
_TV_NODE_VER="${NODE_VERSION:-24.21.0}"

# teyvat 自有工具链目录（node/bun 缺了装这里，不污染系统）
TOOLCHAIN="$HOME/.local/lib/teyvat/toolchain"
mkdir -p "$TOOLCHAIN/bin"

# 鲁棒查找命令：PATH → 常见位置 → env 目录（`${VAR:+...}` 防止空变量拼出 /node 这类路径）
_find_cmd() {
  command -v "$1" >/dev/null 2>&1 && { command -v "$1"; return 0; }
  local p; for p in "${@:2}"; do [ -n "$p" ] && [ -x "$p" ] && { echo "$p"; return 0; }; done
  return 1
}
_find_node() {
  local p
  p="$(_find_cmd node "$HOME/.local/bin/node" "$TOOLCHAIN/bin/node" /usr/local/bin/node /opt/homebrew/bin/node "${NVM_BIN:+$NVM_BIN/node}" "${VOLTA_HOME:+$VOLTA_HOME/bin/node}")" && { echo "$p"; return 0; }
  p="$(command ls "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"; [ -n "$p" ] && { echo "$p"; return 0; }
  p="$(command ls "$HOME"/.fnm/node-versions/*/installation/bin/node 2>/dev/null | tail -1)"; [ -n "$p" ] && { echo "$p"; return 0; }
  return 1
}
_find_bun() { _find_cmd bun "$HOME/.bun/bin/bun" "${BUN_INSTALL:+$BUN_INSTALL/bin/bun}"; }

# 自动装 node（官方 tarball → toolchain，版本 NODE_VERSION 可覆盖）
_install_node() {
  local _os=""; case "$_TV_OS" in Darwin) _os=darwin ;; *) _os=linux ;; esac
  local _dist="node-v${_TV_NODE_VER}-${_os}-${_NODE_ARCH}"
  echo "  …安装 node ${_TV_NODE_VER}（官方 tarball → $TOOLCHAIN）"
  curl -fsSL "https://nodejs.org/dist/v${_TV_NODE_VER}/${_dist}.tar.xz" | tar -xJ -C "$TOOLCHAIN" || { warn "node 下载/解压失败"; return 1; }
  ln -sfn "$TOOLCHAIN/$_dist/bin/node" "$TOOLCHAIN/bin/node"
  ln -sfn "$TOOLCHAIN/$_dist/bin/npm"  "$TOOLCHAIN/bin/npm"
  ln -sfn "$TOOLCHAIN/$_dist/bin/npx"  "$TOOLCHAIN/bin/npx"
  export PATH="$TOOLCHAIN/bin:$PATH"
  ok "node ${_TV_NODE_VER} 已装到 $TOOLCHAIN/bin"
}

# 自动装 bun（bun.sh 官方脚本 → ~/.bun）
_install_bun() {
  echo "  …安装 bun（官方脚本 → ~/.bun）"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || { warn "bun 安装失败（网络？）"; return 1; }
  export PATH="$HOME/.bun/bin:$PATH"
  ok "bun 已装到 ~/.bun/bin"
}

# curl 是下面 node/bun 安装器的前提
command -v curl >/dev/null 2>&1 || warn "未找到 curl — node/bun 自动安装会失败（先装 curl：apt install curl / dnf install curl / brew install curl）"

# node 必需（≥22.19.0）：缺失自动装
if _NODE_BIN="$(_find_node)"; then
  export PATH="$(dirname "$_NODE_BIN"):$PATH"
  ok "node $($_NODE_BIN --version 2>/dev/null)"
else
  warn "未找到 node — 自动安装"
  _install_node || err "node 安装失败，手动装（≥22.19.0）：curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts"
fi

# bun 必需（ear 语音 + bun build）：缺失自动装，失败仅 warn（不影响基本运行）
if _BUN_BIN="$(_find_bun)"; then
  export PATH="$(dirname "$_BUN_BIN"):$PATH"
  ok "bun $($_BUN_BIN --version 2>/dev/null)"
else
  warn "未找到 bun — 自动安装"
  _install_bun || warn "bun 自动装失败（ear 语音不可用）；手动：curl -fsSL https://bun.sh/install | bash"
fi

# tmux 供 execute 的 terminal 模式使用
# 2026-09-25（debug-01 修 Linux 安装阻断）：原标为“必需”并用 err 阻断整个部署——
# 但 Linux 上 dnf/apt 装包需 root，非 root 用户必然失败 → 整个安装被判“部署失败”
# （用户 Fedora 实测：tmux 装失败 → ✗ 部署失败，实际后面根本没跑）。
# 参照其他可选依赖（trafilatura/rapidocr/office）做法：装不上只 warn + DEP_WARN，不阻断。
if command -v tmux >/dev/null 2>&1; then
  ok "tmux 已就绪"
else
  warn "未找到 tmux — 尝试自动安装（仅 execute 的 terminal 模式需要，不影响其他功能）"
  # sudo -n：免密可用时才装，否则立即失败（绝不挂起等密码）
  if [ "$_TV_OS" = "Darwin" ]; then command -v brew >/dev/null 2>&1 && brew install tmux >/dev/null 2>&1
  elif command -v apt-get >/dev/null 2>&1; then (sudo -n apt-get install -y tmux || apt-get install -y tmux) >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then (sudo -n dnf install -y tmux || dnf install -y tmux) >/dev/null 2>&1
  fi
  if command -v tmux >/dev/null 2>&1; then ok "tmux 已装"
  else warn "tmux 未安装 — execute 的 terminal 模式不可用（其余功能正常）。手动: sudo dnf install -y tmux（Fedora）/ sudo apt install -y tmux（Debian）"; DEP_WARN=1; fi
fi

# git / rsync 必需（只报安装命令，不自动装）
for cmd in git rsync; do
  command -v "$cmd" >/dev/null 2>&1 || err "缺少必需依赖: $cmd（$([ "$_TV_OS" = "Darwin" ] && echo "brew install $cmd" || echo "apt install $cmd / dnf install $cmd")）"
done

# 功能依赖（缺了不致命，对应功能不可用）
_check_opt() {
  if command -v "$1" >/dev/null 2>&1; then return 0; fi
  warn "未找到 $1 — $2"
  DEP_WARN=1; return 1
}
_check_opt ffmpeg    "语音输入 (ear) 和音频播放 (iPod) 需要 ffmpeg。$([ "$_TV_OS" = "Darwin" ] && echo "安装: brew install ffmpeg" || echo "安装: apt install ffmpeg / dnf install ffmpeg")"
_check_opt ffprobe   "iPod 播放器获取音频时长需要 ffprobe (随 ffmpeg 安装)"
_check_opt python3   "OCR（rapidocr）和 office 文档解析需要 python3"
_check_opt curl      "同步服务和隧道检测需要 curl"

# typescript（2026-09-13 用户：全局 tsc 默认装——agent 编辑代码时的 npx tsc 语法检查依赖；缺了 npx 会拉到 npm 同名假包打“This is not the tsc command”）
if ! command -v tsc >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    npm install -g typescript 2>&1 | tail -1
    command -v tsc >/dev/null 2>&1 && echo "    ✓ typescript 已自动安装 (tsc 语法检查)" || warn "typescript 自动安装失败 — 手动: npm install -g typescript"
  fi
fi

# trafilatura（web fetch 正文过滤需要；python3 已有时检查 Python 包）
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "import trafilatura" >/dev/null 2>&1; then
    ok "trafilatura (正文提取)"
  else
    warn "未找到 trafilatura — web fetch 正文过滤(auto)不可用，尝试自动安装..."
    if command -v pip3 >/dev/null 2>&1; then
      if [ "$(id -u)" = "0" ]; then pip3 install trafilatura 2>&1 | tail -2; else pip3 install --user trafilatura 2>&1 | tail -2; fi
    fi
    if python3 -c "import trafilatura" >/dev/null 2>&1; then ok "trafilatura 已自动安装 (正文提取)"; else warn "trafilatura 自动安装失败 — web fetch 将 fallback（手动: pip3 install trafilatura）"; DEP_WARN=1; fi
  fi
fi

# ── Linux 剪贴板工具（2026-09-07 用户：TUI 复制需要 wl-copy(Wayland)/xclip(X11)，install 应自动安装；macOS 内置 pbcopy 无需）──
if [ "$(uname)" != "Darwin" ]; then
  _CLIP_OK=0
  command -v wl-copy >/dev/null 2>&1 && _CLIP_OK=1
  command -v xclip >/dev/null 2>&1 && _CLIP_OK=1
  if [ "$_CLIP_OK" = "0" ]; then
    warn "未找到 wl-copy/xclip — TUI 复制到系统剪贴板不可用，尝试自动安装..."
    _CLIP_PKGS="wl-clipboard xclip"
    if command -v apt-get >/dev/null 2>&1; then
      if [ "$(id -u)" = "0" ]; then apt-get install -y $_CLIP_PKGS 2>&1 | tail -2; else sudo apt-get install -y $_CLIP_PKGS 2>&1 | tail -2; fi
    elif command -v dnf >/dev/null 2>&1; then
      if [ "$(id -u)" = "0" ]; then dnf install -y $_CLIP_PKGS 2>&1 | tail -2; else sudo dnf install -y $_CLIP_PKGS 2>&1 | tail -2; fi
    elif command -v pacman >/dev/null 2>&1; then
      if [ "$(id -u)" = "0" ]; then pacman -Sy --noconfirm $_CLIP_PKGS 2>&1 | tail -2; else sudo pacman -Sy --noconfirm $_CLIP_PKGS 2>&1 | tail -2; fi
    fi
    command -v wl-copy >/dev/null 2>&1 && _CLIP_OK=1
    command -v xclip >/dev/null 2>&1 && _CLIP_OK=1
    if [ "$_CLIP_OK" = "1" ]; then ok "剪贴板工具已自动安装 (wl-clipboard/xclip)"; else warn "剪贴板工具自动安装失败 — TUI 复制不可用（手动: sudo apt install wl-clipboard xclip）"; DEP_WARN=1; fi
  else
    ok "剪贴板工具 (wl-copy/xclip)"
  fi
fi

# ── fd / ripgrep 预装（2026-09-22 用户：新电脑一进 agent，pi 总要现下载 fd，很傻——install 里先装好）──
# 谁要：pi 的 Find 工具（core/tools/find.js:157）与 @ 文件补全/搜索（modes/interactive/interactive-mode.js:742）
# 都调 pi 的 ensureTool("fd")/("rg")（utils/tools-manager.js）：先查 <agentDir>/bin 再查 PATH（fd 也认 fdfind），
# 都没有就在**启动时**从 GitHub 现下载（慢 + 要 GitHub 通路，新机器上就是"怎么又要装个东西"）。
# teyvat 在这里先装好，把那次意外下载拿掉；装不上不致命（pi 仍会自己下，或 PI_OFFLINE=1 关掉）。
_TM_MISS=""
command -v fd >/dev/null 2>&1 || command -v fdfind >/dev/null 2>&1 || _TM_MISS="fd"
command -v rg >/dev/null 2>&1 || _TM_MISS="${_TM_MISS:+$_TM_MISS }rg"
if [ -n "$_TM_MISS" ]; then
  warn "未找到 $_TM_MISS — pi 的 Find/@补全会用到，尝试自动安装（免得进 agent 时才现下载）..."
  if [ "$(uname)" = "Darwin" ]; then
    command -v brew >/dev/null 2>&1 && brew install fd ripgrep 2>&1 | tail -2
  elif command -v apt-get >/dev/null 2>&1; then
    # Debian 系包名是 fd-find（二进制 fdfind，pi 的 systemBinaryNames 认它）
    if [ "$(id -u)" = "0" ]; then apt-get install -y fd-find ripgrep 2>&1 | tail -2; else sudo apt-get install -y fd-find ripgrep 2>&1 | tail -2; fi
  elif command -v dnf >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ]; then dnf install -y fd-find ripgrep 2>&1 | tail -2; else sudo dnf install -y fd-find ripgrep 2>&1 | tail -2; fi
  elif command -v pacman >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ]; then pacman -Sy --noconfirm fd ripgrep 2>&1 | tail -2; else sudo pacman -Sy --noconfirm fd ripgrep 2>&1 | tail -2; fi
  elif command -v apk >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ]; then apk add fd ripgrep 2>&1 | tail -2; else sudo apk add fd ripgrep 2>&1 | tail -2; fi
  fi
  # 复检（Debian 系装出来的是 fdfind）
  if { command -v fd >/dev/null 2>&1 || command -v fdfind >/dev/null 2>&1; } && command -v rg >/dev/null 2>&1; then
    ok "fd / ripgrep 已自动安装（pi 的 Find/@补全 不再在启动时现下载）"
  else
    warn "fd/ripgrep 未能自动安装 — 进 agent 时 pi 会自己下载（需 GitHub 通路）；手动: brew install fd ripgrep | apt install fd-find ripgrep"
  fi
fi

# ── macOS Vision OCR 依赖 pyobjc（2026-09-22，a_great_agent_on_imac_01 报的 #9）──
# eyes(action=ocr) 在 macOS 走 Vision 框架（spirit.bio.abilities/vision.ocr/ocr-macvision.ts），需要
# pyobjc-framework-Quartz + pyobjc-framework-Vision；原来 install 没装 → 开箱即报"需要 PyObjC"（Linux 那边 rapidocr 有自动装，mac 这份漏了）。
# 注意 Homebrew Python 受 **PEP 668** 保护：普通 pip3 install 会被拒（要求 --break-system-packages）→ 按 pip 能力与身份选参数。
if [ "$(uname)" = "Darwin" ] && command -v python3 >/dev/null 2>&1; then
  if python3 -c "import Quartz, Vision" >/dev/null 2>&1; then
    ok "pyobjc (macOS Vision OCR)"
  else
    warn "未找到 pyobjc — macOS OCR (eyes ocr) 不可用，尝试自动安装..."
    _PIP_ARGS="--user"
    python3 -m pip install --help 2>/dev/null | grep -q "break-system-packages" && _PIP_ARGS="--user --break-system-packages"
    [ "$(id -u)" = "0" ] && _PIP_ARGS="--break-system-packages"
    python3 -m pip install $_PIP_ARGS pyobjc-framework-Quartz pyobjc-framework-Vision 2>&1 | tail -2
    if python3 -c "import Quartz, Vision" >/dev/null 2>&1; then ok "pyobjc 已自动安装 (macOS OCR)"; else warn "pyobjc 自动安装失败 — eyes ocr 在 macOS 不可用（手动: python3 -m pip install --user --break-system-packages pyobjc-framework-Quartz pyobjc-framework-Vision）"; DEP_WARN=1; fi
  fi
fi

# ── Linux OCR 引擎 rapidocr（2026-09-09 用户定稿：Linux 默认装 rapidocr + eyes ocr 用它——"先能用，慢就只能慢"）──
# macOS 用 Vision 框架无需装；Linux 无 Vision → rapidocr（PP-OCRv3 onnxruntime）本地兜底（质量~90%、复杂图 2.4s/张）
if [ "$(uname)" != "Darwin" ] && command -v python3 >/dev/null 2>&1; then
  if python3 -c "import rapidocr_onnxruntime" >/dev/null 2>&1; then
    ok "rapidocr (Linux OCR 引擎)"
  else
    warn "未找到 rapidocr — Linux OCR (eyes ocr) 不可用，尝试自动安装..."
    _RAPIDOCR_INSTALL="pip3 install rapidocr_onnxruntime onnxruntime pillow"
    if command -v pip3 >/dev/null 2>&1; then
      if [ "$(id -u)" = "0" ]; then $_RAPIDOCR_INSTALL 2>&1 | tail -2; else $_RAPIDOCR_INSTALL --user 2>&1 | tail -2; fi
    fi
    if python3 -c "import rapidocr_onnxruntime" >/dev/null 2>&1; then ok "rapidocr 已自动安装 (Linux OCR)"; else warn "rapidocr 自动安装失败 — eyes ocr 在 Linux 不可用（手动: pip3 install rapidocr_onnxruntime onnxruntime pillow）"; DEP_WARN=1; fi
  fi
fi

# office 读取能力（office.docx/pptx/xlsx/pdf + read 工具自动分发需要；缺了自动装——2026-09-09 用户：依赖都装不 warn）
OFFICE_PYDEPS="python-docx:docx python-pptx:pptx openpyxl:openpyxl PyMuPDF:fitz xlrd:xlrd"
if command -v python3 >/dev/null 2>&1; then
  _OFFICE_MISS=""
  for dep in $OFFICE_PYDEPS; do
    PKG="${dep%%:*}"; MOD="${dep##*:}"
    python3 -c "import $MOD" >/dev/null 2>&1 || _OFFICE_MISS="$_OFFICE_MISS $PKG"
  done
  if [ -n "$_OFFICE_MISS" ]; then
    warn "未找到 office 读取包:$_OFFICE_MISS — 自动安装..."
    if command -v pip3 >/dev/null 2>&1; then
      if [ "$(id -u)" = "0" ]; then pip3 install python-docx python-pptx openpyxl PyMuPDF xlrd 2>&1 | tail -2; else pip3 install --user python-docx python-pptx openpyxl PyMuPDF xlrd 2>&1 | tail -2; fi
    fi
    _OFFICE_MISS2=""
    for dep in $OFFICE_PYDEPS; do
      PKG="${dep%%:*}"; MOD="${dep##*:}"
      python3 -c "import $MOD" >/dev/null 2>&1 || _OFFICE_MISS2="$_OFFICE_MISS2 $PKG"
    done
    if [ -n "$_OFFICE_MISS2" ]; then warn "office 自动安装失败:$_OFFICE_MISS2（手动: pip3 install python-docx python-pptx openpyxl PyMuPDF xlrd）"; DEP_WARN=1; else ok "office 读取包已自动安装"; fi
  else
    for dep in $OFFICE_PYDEPS; do PKG="${dep%%:*}"; ok "office: $PKG"; done
  fi
fi

# Chrome/Chromium 检查（Safari 浏览器 app 需要）
CHROMIUM_FOUND=0
if [ -n "$CHROMIUM_PATH" ]; then
  [ -x "$CHROMIUM_PATH" ] && CHROMIUM_FOUND=1
fi
if [ "$CHROMIUM_FOUND" = "0" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    for b in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
      [ -x "$b" ] && { CHROMIUM_FOUND=1; break; }
    done
  else
    for b in google-chrome-stable google-chrome chromium-browser chromium; do
      command -v "$b" >/dev/null 2>&1 && { CHROMIUM_FOUND=1; break; }
    done
  fi
fi
if [ "$CHROMIUM_FOUND" = "1" ]; then
  ok "Chrome/Chromium"
else
  warn "未找到 Chrome/Chromium — Safari 浏览器 app 将不可用。$([ "$(uname)" = "Darwin" ] && echo "安装 Google Chrome 到 /Applications" || echo "安装: apt install chromium-browser / dnf install chromium")"
  DEP_WARN=1
fi

# Linux 音频后端检查
if [ "$(uname)" = "Linux" ]; then
  # TTS 输出的是 MP3——只有 ffplay/mpv/cvlc 能播（paplay/aplay 只支持 WAV，不能用）
  AUDIO_OUT=0
  for cmd in ffplay mpv cvlc; do command -v "$cmd" >/dev/null 2>&1 && { AUDIO_OUT=1; ok "MP3 播放 ($cmd)"; break; }; done
  [ "$AUDIO_OUT" = "1" ] || { warn "未找到 MP3 播放器 (ffplay/mpv/cvlc) — TTS 语音输出将不可用。安装: apt install ffmpeg（推荐，同时解决录入依赖）或 apt install mpv"; DEP_WARN=1; }

  # 麦克风录入需要 ffmpeg + pulse 或 alsa 输入设备
  AUDIO_IN=0
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -hide_banner -devices 2>&1 | grep -qE "pulse|alsa" && AUDIO_IN=1
  fi
  [ "$AUDIO_IN" = "1" ] && ok "音频输入 (pulse/alsa)" || { warn "ffmpeg 未检测到 pulse/alsa 输入设备 — 麦克风录入可能不可用。安装: apt install pulseaudio 或 apt install alsa-utils"; DEP_WARN=1; }
fi

[ "$DEP_WARN" = "0" ] && ok "所有可选依赖就绪" || warn "部分可选依赖缺失（上面的功能将不可用，其余功能正常）"
echo ""

# ── 1. runtime ──
RUNTIME="$HOME/.local/lib/teyvat/runtime"
PI_PKG="$RUNTIME/node_modules/@earendil-works/pi-coding-agent"
PI_DIST="$PI_PKG/dist"

CURRENT_VER=""
if [ -f "$PI_PKG/package.json" ]; then CURRENT_VER=$(node -e "try{console.log(require('$PI_PKG/package.json').version)}catch {}" 2>/dev/null); fi

if [ "$CURRENT_VER" = "$PIN" ]; then
  ok "runtime pi@$PIN"
else
  echo -e "  ${DIM}installing pi@$PIN...${R}"
  mkdir -p "$RUNTIME"
  [ -f "$RUNTIME/package.json" ] || echo '{"private":true}' > "$RUNTIME/package.json"
  ( cd "$RUNTIME" && npm install "@earendil-works/pi-coding-agent@$PIN" 2>&1 | tail -3 )
  # 2026-08-20：pi 代码用了 cli-highlight（语法高亮）但 package.json 未声明依赖（pi 的依赖声明 bug）→
  # 部署时显式安装，否则 interactive-mode.js:81 import 失败（高亮静默失效 + Cannot find package 错误）
  ( cd "$RUNTIME" && npm install cli-highlight 2>&1 | tail -1 )
  # 2026-09-14：teyvat 扩展新增依赖（/copy 富文本剪贴板的 markdown→HTML）——
  # A.core package.json 已声明（tsc/门禁用），运行时解析走 NODE_PATH=runtime/node_modules，这里同步装
  ( cd "$RUNTIME" && npm install marked 2>&1 | tail -1 )
  ok "runtime pi@$PIN"
fi

[ ! -f "$PI_DIST/core/tools/bash.js" ] && err "runtime broken"
node -e "const f='$PI_PKG/package.json',p=JSON.parse(require('fs').readFileSync(f,'utf8'));if(p.piConfig?.name!=='genshin'){p.piConfig=p.piConfig||{};p.piConfig.name='genshin';require('fs').writeFileSync(f,JSON.stringify(p,null,'\t'))}" 2>/dev/null

# 顶层 pi-ai / pi-agent-core / pi-tui 与 PIN 对齐（扩展经软链/imports 解析到顶层副本；不对齐 = 扩展侧与 pi 核心两个版本并存）
# 2026-09-14：加 pi-tui —— 它同样被扩展直接 import（heart/renderers 等），且 npm 重排树时会被挤进嵌套
# （实证：install marked 后顶层 pi-tui 被 prune 进 pi-coding-agent/node_modules，A.core 链接断 + 运行时解析炸）
for dep in pi-ai pi-agent-core pi-tui; do
  DEP_VER=$(node -e "try{console.log(require('$RUNTIME/node_modules/@earendil-works/$dep/package.json').version)}catch {}" 2>/dev/null)
  if [ "$DEP_VER" != "$PIN" ]; then
    echo -e "  ${DIM}aligning $dep@$PIN (was ${DEP_VER:-none})...${R}"
    ( cd "$RUNTIME" && npm install "@earendil-works/$dep@$PIN" 2>&1 | tail -1 )
    DEP_VER=$(node -e "try{console.log(require('$RUNTIME/node_modules/@earendil-works/$dep/package.json').version)}catch {}" 2>/dev/null)
  fi
  [ "$DEP_VER" = "$PIN" ] && ok "runtime $dep@$PIN" || warn "$dep version drift: ${DEP_VER:-none} (want $PIN)"
done

# ── 2026-09-24：model list 用最新模型目录（pi-models 独立于 PIN——0.87.1 的 models 目录，PIN 仍 0.80.7）──
# 只换 models.generated.js + providers/*.models.js（模型清单），不动 pi-ai 的 API（避免升级 PIN 的 override 不兼容风险）。
if [ -d "$DEPLOY/pi-models" ]; then
  cp "$DEPLOY/pi-models/models.generated.js" "$RUNTIME/node_modules/@earendil-works/pi-ai/dist/models.generated.js" 2>/dev/null && \
  cp "$DEPLOY/pi-models/model-catalog.js" "$RUNTIME/node_modules/@earendil-works/pi-ai/dist/model-catalog.js" 2>/dev/null && \
  mkdir -p "$RUNTIME/node_modules/@earendil-works/pi-ai/dist/providers/data" && \
  cp "$DEPLOY/pi-models/providers/"*.models.js "$RUNTIME/node_modules/@earendil-works/pi-ai/dist/providers/" 2>/dev/null && \
  cp "$DEPLOY/pi-models/providers/data/"*.json "$RUNTIME/node_modules/@earendil-works/pi-ai/dist/providers/data/" 2>/dev/null && \
  ok "pi-models updated (0.87.1 catalog)" || warn "pi-models copy failed"
fi

# ── 2. live integrity check ──
# 检查 runtime 是否被手动修改过（对比上次 install 保存的 manifest）
# make dev-minutely/dev-restore 走正常部署流程，跳过 drift 检查
MANIFEST="$RUNTIME/.teyvat-install-manifest"
if [ -f "$MANIFEST" ] && [ -z "$PAIMON_VER" ]; then
  DRIFT=""
  while IFS=$'\t' read -r hash file; do
    if [ -f "$file" ]; then
      current=$(md5 -q "$file" 2>/dev/null || md5sum "$file" 2>/dev/null | cut -d' ' -f1)
      [ "$current" = "$hash" ] || DRIFT="${DRIFT}\n  MODIFIED: ${file##*dist/}"
    else
      DRIFT="${DRIFT}\n  MISSING: ${file##*dist/}"
    fi
  done < "$MANIFEST"
  if [ -n "$DRIFT" ]; then
    echo -e "  ${RED}DRIFT DETECTED${R} — runtime was modified outside make:${DRIFT}"
    echo -e "  ${YLW}修复方法:${R}"
    echo -e "    1. 检查上面的 MODIFIED 文件是否有需要保存的改动"
    echo -e "    2. 如有，先把改动合并回 god.tui/overrides/ 源码"
    echo -e "    3. trash ~/.local/lib/teyvat/runtime/node_modules/@earendil-works/ 然后重新 make"
    exit 1
  fi
fi

# ── 3. restore stock dist before overrides ──
# 用 $DEPLOY（已按布局推导：dev=C.deploy，prerelease=deploy）替代硬编码 C.deploy——2026-09-05 prerelease 验证暴露
STOCK_BACKUP="$(dirname "$IMPL")/$(basename "$DEPLOY")/pi-image-source/v${PIN}"
# 缺失即报错：没有原版镜像就无法把 dist 复位，后续 overrides 会叠加在上一次的产物上，
# 表现为「改了源码但行为不变」或残留旧补丁 —— 静默跳过时这种退化极难发现。
[ -d "$STOCK_BACKUP" ] || err "原版镜像缺失: $STOCK_BACKUP（应随 C.deploy 一起版本控制）"
if [ -d "$STOCK_BACKUP/pi-coding-agent" ]; then
  # 2026-09-25（debug-01 修 Linux 安装报错）：rsync 只能创建**单级**目标目录——
  # $PI_DIST 的父目录（$PI_PKG）在 Linux 首次安装时可能尚不存在 →
  #   rsync: mkdir ".../pi-coding-agent/dist" failed: No such file or directory (2)
  #   rsync error: error in file IO (code 11)
  # 且旧写法无论成败都打 OK（假成功）。现：先建目录（幂等）再 rsync，失败如实报告（不阻断——下方 debug.js 兜底）。
  mkdir -p "$PI_DIST" 2>/dev/null
  if rsync -a --delete "$STOCK_BACKUP/pi-coding-agent/" "$PI_DIST/"; then
    ok "runtime pi-coding-agent dist restored from stock"
  else
    warn "pi-coding-agent dist 恢复未完成（不阻断；若后续行为异常请重跑安装）"
  fi
  # 2026-09-13（dev-01）：上面这行 --delete 会删掉 teyvat 的补丁 dist/debug.js，
  # 而 stub 重建原本在脚本后段 → make 的 extension load check（在 install **之前**跑）必然失败
  # （报 "Cannot find module .../dist/debug.js"）→ install 永不执行 → stub 永不重建（死循环，实测踩到）。
  # 因此紧跟 rsync 立刻补回（与后段创建逻辑一致）。
  mkdir -p "$PI_PKG/dist"
  [ -f "$PI_PKG/dist/debug.js" ] || echo 'export const debug = () => {};' > "$PI_PKG/dist/debug.js"
else
  err "原版镜像不完整: $STOCK_BACKUP/pi-coding-agent 不存在"
fi
if [ -d "$STOCK_BACKUP/pi-tui" ]; then
  _PI_TUI_RESTORE="$PI_PKG/node_modules/@earendil-works/pi-tui/dist"
  [ -d "$_PI_TUI_RESTORE" ] || _PI_TUI_RESTORE="$RUNTIME/node_modules/@earendil-works/pi-tui/dist"
  if [ -d "$_PI_TUI_RESTORE" ]; then
    rsync -a --delete "$STOCK_BACKUP/pi-tui/" "$_PI_TUI_RESTORE/"
    ok "runtime pi-tui dist restored from stock"
  fi
fi

# ── 3. runtime overrides ──
OVERRIDES="$IMPL/god.tui/overrides"
PI_TUI_DIST="$PI_PKG/node_modules/@earendil-works/pi-tui/dist"
if [ ! -d "$PI_TUI_DIST" ]; then PI_TUI_DIST="$RUNTIME/node_modules/@earendil-works/pi-tui/dist"; fi

# syntax gate
GATE_BAD=0
while IFS= read -r -d '' js; do
  node --check "$js" 2>/dev/null || { err "syntax error: ${js##*/}"; GATE_BAD=1; }
done < <(find "$OVERRIDES" -name "*.js" ! -name "*.bak" -print0 2>/dev/null)
node --check "$IMPL/god.tui/ui_elements/blocks_nongod.js" 2>/dev/null || { err "syntax error: blocks_nongod.js"; }

# overrides 实体拷贝进 pi dist（cp -f，不是 symlink——symlink 会让 Node 按真实路径解析
# relative import，从 source 树找依赖，路径就断了）
LINK_FAIL=0
_override() {
  cp -f "$1" "$2" 2>/dev/null || { echo -e "  ${RED}COPY FAIL${R}  $1 → $2"; LINK_FAIL=1; }
}
_override "$IMPL/god.tui/ui_elements/blocks_nongod.js" "$PI_DIST/modes/interactive/components/blocks_nongod.js"
_override "$IMPL/god.tui/ui_elements/env.js" "$PI_DIST/modes/interactive/components/env.js"
_override "$IMPL/god.tui/overrides/pi-tui/components/custom-message.js" "$PI_DIST/modes/interactive/components/custom-message.js"

# （2026-08-14 移除）tool-execution.js 的 visibleWidth/wrapTextWithAnsi 注入 sed：
# 源码 overrides 里已自带这两个 import 与 initBlockrender 带参调用，sed 长期 no-op

_override "$IMPL/god.tui/ui_elements/footer.js" "$PI_DIST/modes/interactive/components/footer.js"
# spinner.js 覆盖已移除：源文件在 73029b86 (2026-07-28) 随重构删除，无继任者，改用 pi 原生 spinner
_override "$IMPL/god.tui/ui_elements/statebar.js" "$PI_DIST/modes/interactive/components/statebar.js"
_override "$IMPL/god.tui/ui_elements/blocks_god.js" "$PI_DIST/modes/interactive/components/blocks_god.js"
for f in $(cd "$OVERRIDES/modes" && find . -name '*.js' -o -name '*.json'); do
  _override "$OVERRIDES/modes/$f" "$PI_DIST/modes/$f"
done
# pi-dist overrides（之前靠残留活着，现在纳入正式管理——npm update 不会再丢）
PI_DIST_OVERRIDES="$OVERRIDES/pi-dist"
if [ -d "$PI_DIST_OVERRIDES" ]; then
  for f in $(cd "$PI_DIST_OVERRIDES" && find . -name '*.js' ! -path './modes/interactive/components/diff.js'); do
    mkdir -p "$(dirname "$PI_DIST/$f")"
    _override "$PI_DIST_OVERRIDES/$f" "$PI_DIST/$f"
    # 同时复制到 pi-dist/ 以支持 tool-execution.js 的 ../../../pi-dist/... 引用路径
    mkdir -p "$(dirname "$PI_DIST/pi-dist/$f")"
    _override "$PI_DIST_OVERRIDES/$f" "$PI_DIST/pi-dist/$f"
  done
  # diff.js 桥接：仅放 pi-dist/，不能覆盖 dist/ 原始 diff.js
  mkdir -p "$(dirname "$PI_DIST/pi-dist/modes/interactive/components/diff.js")"
  _override "$PI_DIST_OVERRIDES/modes/interactive/components/diff.js" "$PI_DIST/pi-dist/modes/interactive/components/diff.js"
fi
# core/ overrides（tools、agent-session 等）
if [ -d "$OVERRIDES/core" ]; then
  for f in $(cd "$OVERRIDES/core" && find . -name '*.js'); do
    mkdir -p "$(dirname "$PI_DIST/core/$f")"
    _override "$OVERRIDES/core/$f" "$PI_DIST/core/$f"
  done
fi
# utils/ overrides（2026-08-18：changelog.js 屏蔽 pi 的 What's New——getChangelogPath 指向不存在路径）
if [ -d "$OVERRIDES/utils" ]; then
  for f in $(cd "$OVERRIDES/utils" && find . -name '*.js'); do
    mkdir -p "$(dirname "$PI_DIST/utils/$f")"
    _override "$OVERRIDES/utils/$f" "$PI_DIST/utils/$f"
  done
fi
if [ -d "$PI_TUI_DIST" ]; then
  _override "$IMPL/god.tui/ui_elements/blocks_nongod.js" "$PI_TUI_DIST/blocks_nongod.js"
  _override "$IMPL/god.tui/ui_elements/env.js" "$PI_TUI_DIST/env.js"
  for f in $(cd "$OVERRIDES/pi-tui" && find . -name '*.js'); do
    mkdir -p "$(dirname "$PI_TUI_DIST/$f")"
    _override "$OVERRIDES/pi-tui/$f" "$PI_TUI_DIST/$f"
  done
fi
# pi-ai overrides
AI_APPLIED=0
for AI_PKG in "$PI_PKG/node_modules/@earendil-works/pi-ai" "$RUNTIME/node_modules/@earendil-works/pi-ai"; do
  AI_VER=$(node -e "try{console.log(require('$AI_PKG/package.json').version)}catch {}" 2>/dev/null)
  [ "$AI_VER" = "$PIN" ] || continue
  for f in openai-completions.js openai-responses-shared.js transform-messages.js google-shared.js mistral-conversations.js; do
    if [ -f "$OVERRIDES/pi-ai/$f" ]; then _override "$OVERRIDES/pi-ai/$f" "$AI_PKG/dist/api/$f" && AI_APPLIED=1; fi
  done
  # teyvat 2026-09-07：覆盖 pi-ai providers 模型 catalog（deepseek.models.js 等，含官方 catalog 定制/新增模型）
  if [ -d "$OVERRIDES/pi-ai/providers" ]; then
    for f in $(cd "$OVERRIDES/pi-ai/providers" && find . -name '*.js' 2>/dev/null); do
      if [ -f "$OVERRIDES/pi-ai/providers/$f" ]; then _override "$OVERRIDES/pi-ai/providers/$f" "$AI_PKG/dist/providers/$f" && AI_APPLIED=1; fi
    done
  fi
done
[ "$AI_APPLIED" = "1" ] || warn "pi-ai overrides not applied (no pi-ai@$PIN found — check alignment / rebase golden)"
# theme overrides
for f in dark.json light.json; do
  _override "$OVERRIDES/modes/interactive/theme/$f" "$PI_DIST/modes/interactive/theme/$f"
done

# override 拷贝失败 = 线上继续跑旧渲染代码，必须响、必须停（2026-07-17 叠帧事故教训：部署失败不许静默）
[ "$LINK_FAIL" = "1" ] && err "runtime overrides 部署失败（上面有 COPY FAIL）— 线上会继续跑旧代码" || ok "runtime overrides (copied)"

# ── 4. genshin agent directory ──
PAIMON_AGENT="$HOME/.teyvat"
PAIMON_EXT="$HOME/.local/lib/teyvat/extensions"
EXT_NAME="teyvat"
if [ "$PAIMON_CHANNEL" = "dev-stable" ]; then EXT_NAME="teyvat-stable"; fi
mkdir -p "$PAIMON_EXT"
# dev-stable: 复制一份独立副本，不受后续 dev-minutely 影响
if [ "$PAIMON_CHANNEL" = "dev-stable" ]; then
  STABLE_DIR="$HOME/.local/lib/teyvat/extensions-stable/teyvat"
  # 2026-09-22（用户问“这些删除有必要吗/有更好办法吗”）：加 --exclude=node_modules ——
  # 它本来就要用符号链接指向 $IMPL/node_modules（下两行），先复制一份再删纯属白干（还多一次删除）。
  rsync -a --delete --exclude='.DS_Store' --exclude='node_modules' "$IMPL/" "$STABLE_DIR/" 2>/dev/null
  # dev-stable 副本用 $IMPL 的 node_modules（符号链接，不复制——单一来源）
  # 2026-09-22（不删原则）：**实目录改名留档**（同盘 mv = 瞬间），符号链接则被 ln -sfn 原子替换。
  if [ -e "$STABLE_DIR/node_modules" ] && [ ! -L "$STABLE_DIR/node_modules" ]; then
    mv "$STABLE_DIR/node_modules" "$STABLE_DIR/node_modules.REMOVED-$(date +%s)" 2>/dev/null || true
  fi
  ln -sfn "$IMPL/node_modules" "$STABLE_DIR/node_modules" 2>/dev/null
  IMPL="$STABLE_DIR"
fi
# 软链 node_modules → runtime，扩展 import 能解析到 @earendil-works/pi-tui 等
# 2026-09-22（不删原则）：实目录改名留档（不删）；ln -sfn 能原子替换同名符号链接。
if [ -e "$PAIMON_AGENT/node_modules" ] && [ ! -L "$PAIMON_AGENT/node_modules" ]; then
  mv "$PAIMON_AGENT/node_modules" "$PAIMON_AGENT/node_modules.REMOVED-$(date +%s)" 2>/dev/null || true
fi
ln -sfn "$RUNTIME/node_modules" "$PAIMON_AGENT/node_modules" 2>/dev/null
# @mariozechner 别名 → @earendil-works（扩展 import 时 Node 需要找到这个包）
# 2026-09-22（不删原则）：不再清空目录——目录在就直接（重）建里面的链接；
# 旧做法（整个 scope 是符号链接）则改名留档后重建，避免 ln 写进链接目标里。
if [ -L "$RUNTIME/node_modules/@mariozechner" ]; then
  mv "$RUNTIME/node_modules/@mariozechner" "$RUNTIME/node_modules/@mariozechner.REMOVED-$(date +%s)" 2>/dev/null || true
fi
mkdir -p "$RUNTIME/node_modules/@mariozechner" 2>/dev/null
ln -sfn "$RUNTIME/node_modules/@earendil-works/pi-coding-agent" "$RUNTIME/node_modules/@mariozechner/pi-coding-agent" 2>/dev/null
# 源码目录也需要（扩展从真实路径加载）
if [ -L "$IMPL/node_modules/@mariozechner" ]; then
  mv "$IMPL/node_modules/@mariozechner" "$IMPL/node_modules/@mariozechner.REMOVED-$(date +%s)" 2>/dev/null || true
fi
mkdir -p "$IMPL/node_modules/@mariozechner" 2>/dev/null
ln -sfn "$RUNTIME/node_modules/@earendil-works/pi-coding-agent" "$IMPL/node_modules/@mariozechner/pi-coding-agent" 2>/dev/null
# 2026-09-22（不删原则）：@earendil-works 不再清空重建——mkdir -p + ln -sfn 逐包（重）建就是幂等的。
# （残留的旧包链接极罕见且无害：它们指向 runtime，运行时不在就自然失效）
mkdir -p "$IMPL/node_modules/@earendil-works"
# 嵌套副本优先（pi 实际加载的那份），被 npm dedup 提升后回退顶层——保证扩展与 pi 核心用同一份
PI_TUI_PKG="$PI_PKG/node_modules/@earendil-works/pi-tui"
[ -d "$PI_TUI_PKG" ] || PI_TUI_PKG="$RUNTIME/node_modules/@earendil-works/pi-tui"
ln -sfn "$PI_TUI_PKG" "$IMPL/node_modules/@earendil-works/pi-tui"
PI_AI_PKG="$PI_PKG/node_modules/@earendil-works/pi-ai"
[ -d "$PI_AI_PKG" ] || PI_AI_PKG="$RUNTIME/node_modules/@earendil-works/pi-ai"
ln -sfn "$PI_AI_PKG" "$IMPL/node_modules/@earendil-works/pi-ai"
ln -sfn "$RUNTIME/node_modules/@earendil-works/pi-coding-agent" "$IMPL/node_modules/@earendil-works/pi-coding-agent"

for d in config agent RuntimeCache SessionData MemoryData IdentityData AgentFileData UserAccount MemoirData AgentWorkDir ProgramFiles sessions; do
  mkdir -p "$HOME/.teyvat/$d"
done
for f in auth.json models.json settings.json; do
  SRC="$HOME/.teyvat/config/$f"
  DEST="$HOME/.teyvat/agent/$f"
  # 2026-09-22（a_great_agent_on_imac_01 报的 #5：config/ 与 UserAccount/ 数据分裂）：
  # 旧体系（genshin）的真实配置在 UserAccount/，迁过来后 config/ 被下面的 touch 建成 **0 字节空文件**，
  # 而 pi 读的是 config/（经 agent/ 软链）→ 直接报 `Failed to parse models.json: Unexpected end of JSON input`。
  # 所以建空文件**之前**先做一次回填：config 缺失或为空、且 UserAccount 有内容 → 复制过来（UserAccount 原样保留，不删）。
  if [ ! -s "$SRC" ] && [ -s "$HOME/.teyvat/UserAccount/$f" ]; then
    mkdir -p "$HOME/.teyvat/config"
    cp "$HOME/.teyvat/UserAccount/$f" "$SRC"
    ok "回填 config/$f ← UserAccount/$f（迁移遗留；UserAccount 原文保留）"
  fi
  [ -e "$SRC" ] || touch "$SRC" 2>/dev/null
  ln -sfn "../config/$f" "$DEST" 2>/dev/null
done

# services.json — 第三方服务配置模板（不覆盖已有配置）
SERVICES_JSON="$HOME/.teyvat/config/services.json"
if [ ! -f "$SERVICES_JSON" ]; then
  cat > "$SERVICES_JSON" << 'SVCEOF'
{
  "brave": {
    "apiKey": ""
  },
  "weread": {
    "apiKey": ""
  },
  "doubao-voicengine": {
    "appId": "",
    "token": ""
  },
  "doubao-seed": {
    "url": "",
    "apiKey": "",
    "model": ""
  }
}
SVCEOF
  echo -e "  ${YLW}INFO${R}  created services.json — run /config to set API keys"
fi

# extensions (symlink for cross-module imports)
# dev-stable 只存实体副本到 extensions-stable/，不放 extensions/（避免工具冲突）
EXT_NAME="teyvat"
# ── 2026-09-22（用户原则：不要 rm 这类危险命令，安全性第一）：extensions 用「双槽轮换 + symlink 原子换向」──
# 之前：`rm -rf "$PAIMON_EXT/teyvat"` 再逐文件 rsync —— 整段窗口里固定路径**完全不存在**，
# 期间跑任何 genshin CLI 命令都 Cannot find module（实测 2026-09-07 21:14:32 用户撞上，还一度以为代码被篡改）。
# 现在：内容 rsync 到**另一个空闲槽**（.teyvat.slot-a / .teyvat.slot-b 两槽轮换），
# 全部就绪（含 node_modules 链接与内容校验）后，用一次 `ln -sfn` 换向——POSIX rename 原子：
#   · 读者要么看到完整旧目录、要么完整新目录，永无半成品；已打开的 fd 不受影响、新 open 原子；
#   · **磁盘占用恒定 2 份**（不随部署次数增长）→ 因此**无需清理任何旧目录**（不删东西）；
#   · 回滚 = 把链接指回另一个槽（上一版就在那里）；
#   · 固定路径仍是 `extensions/teyvat`，launcher 快照 / #paths(import.meta.url) / rna.json 等引用处都不用改。
# 旧名残留（曾用名 genshin-world.minutely / genshin-world / teyvat.minutely、以及 device）：**改名留档，不删**。
for _legacy in teyvat.minutely device; do
  if [ -e "$PAIMON_EXT/$_legacy" ]; then
    mv "$PAIMON_EXT/$_legacy" "$PAIMON_EXT/$_legacy.REMOVED-$(date +%s)" 2>/dev/null || true
  fi
done
_EXT_LINK="$PAIMON_EXT/teyvat"
_EXT_A="$PAIMON_EXT/.teyvat.slot-a"
_EXT_B="$PAIMON_EXT/.teyvat.slot-b"
# 当前链接指向哪个槽 → 本次写**另一个**（全程不动在用那份）
case "$(readlink "$_EXT_LINK" 2>/dev/null || true)" in
  *slot-a) _EXT_NEW="$_EXT_B" ;;
  *)       _EXT_NEW="$_EXT_A" ;;
esac
mkdir -p "$_EXT_NEW"
# 首次迁移：固定路径若还是真目录 → 改名留档（否则 ln -sfn 会在目录*里面*建链接），
# **并立刻把符号链接接回旧目录**——“固定路径不存在”的窗口只有 mv→ln 的毫秒级，不会横跨整个 rsync。只发生一次。
if [ -e "$_EXT_LINK" ] && [ ! -L "$_EXT_LINK" ]; then
  _EXT_PREV="$PAIMON_EXT/teyvat.pre-slot-$(date +%s)"
  mv "$_EXT_LINK" "$_EXT_PREV" 2>/dev/null || true
  ln -sfn "$(basename "$_EXT_PREV")" "$_EXT_LINK" 2>/dev/null || true
fi
# extensions 同步（三次重试防偶发竞态）→ 写进空闲槽
# 注：--exclude=node_modules 既不用把源码的 node_modules 搬过来（下面自己建链接），
# 也让 --delete 不会碰到本槽自己那份 node_modules（rsync 默认不删 excluded 项）。
RSYNC_OK=0
for attempt in 1 2 3; do
  if rsync -rptgo --delete --exclude='.DS_Store' --exclude='node_modules' "$IMPL/" "$_EXT_NEW/" 2>/dev/null; then
    RSYNC_OK=1; break
  fi
  sleep 0.3
done
if [ "$RSYNC_OK" = "0" ]; then
  err "rsync extensions 失败（3次重试均不成功）"
fi

# I.Ecosystems（服务端/生态域，2026-09-13 用户定稿：后端放 I.Ecosystems）同样同步进 runtime——
# genshin im --local 从 runtime 跑 god.backend.im/im.mjs（2026-09-16 从 I.Ecosystems/im.server 迁入），故必须随部署落地。
if [ -d "$PKG_ROOT/I.Ecosystems" ]; then
  RSYNC_ECO=0
  for attempt in 1 2 3; do
    if rsync -rptgo --delete --exclude='.DS_Store' "$PKG_ROOT/I.Ecosystems/" "$_EXT_NEW/I.Ecosystems/" 2>/dev/null; then
      RSYNC_ECO=1; break
    fi
    sleep 0.3
  done
  [ "$RSYNC_ECO" = "1" ] || err "rsync I.Ecosystems 失败（3次重试均不成功）"
fi


# 这里按内容逐字节校验源码树 vs 线上副本，不一致必须响、必须停。
# 注意：I.Ecosystems 是附加部署域（源在 $PKG_ROOT/I.Ecosystems，线上 teyvat/I.Ecosystems/），
# 不在 A.core 源码树内——主校验排除它，另在下方单独校验（2026-09-13 IM 迁移新增）。
# 2026-09-25（debug-01 修 Linux 部署阻塞）：原直接调 `shasum`——它是 macOS/Perl 专有，Fedora 默认**没有**（只有 sha256sum）。
# 无 fallback → 两侧校验和都为空 → 误判"extensions 副本与源码不一致（rsync 没落地）"→ **部署失败**（用户实测被阻断）。
# 统一走 sha256（shasum -a 256 / sha256sum 输出格式都是 "<hash>  <file>"，cut -f1 通吃；同一函数生成两侧值，算法一致即可）。
_TREE_HASH="$(command -v sha256sum >/dev/null 2>&1 && echo sha256sum || { command -v shasum >/dev/null 2>&1 && echo 'shasum -a 256'; })"
if [ -z "$_TREE_HASH" ]; then err "找不到 sha256sum/shasum——无法做部署校验（Linux: coreutils / macOS: perl 自带）"; fi
_tree_sum() { (cd "$1" && find . -type f -not -path '*/node_modules/*' -not -path './I.Ecosystems/*' -not -name '.DS_Store' -print0 | sort -z | xargs -0 $_TREE_HASH 2>/dev/null | $_TREE_HASH | cut -d' ' -f1); }
SRC_SUM=$(_tree_sum "$IMPL")
DST_SUM=$(_tree_sum "$_EXT_NEW")
if [ -z "$SRC_SUM" ] || [ "$SRC_SUM" != "$DST_SUM" ]; then
  err "extensions 部署校验失败：线上副本与源码不一致（rsync 没落地）— 线上是旧代码"
fi
# I.Ecosystems 附加域单独校验
if [ -d "$PKG_ROOT/I.Ecosystems" ]; then
  ECO_SRC=$(_tree_sum "$PKG_ROOT/I.Ecosystems")
  ECO_DST=$(_tree_sum "$_EXT_NEW/I.Ecosystems")
  if [ -z "$ECO_SRC" ] || [ "$ECO_SRC" != "$ECO_DST" ]; then
    err "I.Ecosystems 部署校验失败：线上副本与源码不一致"
  fi
fi
# extensions node_modules：pi-coding-agent 的嵌套 node_modules 有 pi-tui/pi-ai 完整依赖，
# 顶层 runtime/node_modules 有 pi-coding-agent 本身和 @sinclair/typebox。
# 合并两层到 extensions，避免 pi-tui 双实例（双实例 = kitty protocol 状态不共享 = 乱码）。
[ -d "$RUNTIME/node_modules/@sinclair/typebox" ] || ( cd "$RUNTIME" && npm install @sinclair/typebox --silent 2>&1 | tail -1 )
# 2026-09-22（不删原则）：不再清空本目录——用 ln -sfn 就地（重）建链接即可（已有链接被原子替换）。
mkdir -p "$_EXT_NEW/node_modules"
# 先链顶层（pi-coding-agent, @sinclair/typebox, @mariozechner 等）
for d in "$RUNTIME/node_modules/@earendil-works" "$RUNTIME/node_modules/@mariozechner" "$RUNTIME/node_modules/@sinclair"; do
  [ -d "$d" ] && ln -sfn "$d" "$_EXT_NEW/node_modules/$(basename "$d")" 2>/dev/null
done
# 再用嵌套的 pi-tui/pi-ai 覆盖顶层的（保证和 pi-coding-agent 用同一份）
PI_NESTED="$PI_PKG/node_modules/@earendil-works"
if [ -d "$PI_NESTED/pi-tui" ]; then
  ln -sfn "$PI_NESTED/pi-tui" "$_EXT_NEW/node_modules/@earendil-works/pi-tui" 2>/dev/null
fi
# ── 内容全部就绪（rsync + I.Ecosystems + node_modules + 校验都过了）→ 才原子换向 ──
# 这一步之前的任何失败都不会碰固定路径：线上始终是完整的旧版本，不是半成品。
ln -sfn "$(basename "$_EXT_NEW")" "$_EXT_LINK" 2>/dev/null || err "extensions symlink 换向失败: $_EXT_LINK"
ok "extensions 已原子换向 → $(basename "$_EXT_NEW")（双槽轮换；回滚=把链接指回另一个槽）"
# 不清理任何旧目录：两槽轮换天然把磁盘丁在 2 份（本次写入的槽，正是下一个部署要覆盖的那个）
if [ -d "$PI_NESTED/pi-ai" ]; then
  ln -sfn "$PI_NESTED/pi-ai" "$PAIMON_EXT/teyvat/node_modules/@earendil-works/pi-ai" 2>/dev/null
fi
# 打构建标记：部署副本标记为 deployed（源码保持 dev 不动）
# 2026-09-22（不删原则）：改成「写临时文件 + mv 覆盖」——跨平台（mac/GNU 的 sed -i 参数不同）、原子覆盖，
# 且**不产生 .bak**（残留文件会让下次 _tree_sum 校验不一致）。临时文件放在 ext 树**之外**（定名覆盖，不入校验）。
_paths_ts="$PAIMON_EXT/teyvat/paths.ts"
_paths_tmp="$PAIMON_EXT/../.tmp-paths-ts"
if sed 's/BUILD_MODE: "dev" | "release" = "dev"/BUILD_MODE: "dev" | "release" = "release"/' "$_paths_ts" > "$_paths_tmp" 2>/dev/null; then
  [ -s "$_paths_tmp" ] && ! cmp -s "$_paths_tmp" "$_paths_ts" && mv "$_paths_tmp" "$_paths_ts"
fi
# view-mode 扩展已退役（2026-07-16）：功能内化到渲染组件（__piViewMode 默认 full），launcher 不再加载
# 生成 mobile apps manifest（build + MD5）
if [ -f "$IMPL/universe.infotech/local.mobile/apps.build.sh" ]; then
  bash "$IMPL/universe.infotech/local.mobile/apps.build.sh" "$IMPL/universe.infotech/local.mobile" 2>/dev/null
  # 2026-09-13：这一步在 rsync 之后跑，只刷了源码树——部署副本的 apps.json 永远慢一个版本；部署副本也刷一遍
  [ -d "$PAIMON_EXT/teyvat/universe.infotech/local.mobile" ] && bash "$IMPL/universe.infotech/local.mobile/apps.build.sh" "$PAIMON_EXT/teyvat/universe.infotech/local.mobile" 2>/dev/null
fi
ok "extensions"

# ── 4b. mobile apps → ProgramFiles/Mobile (symlink) ──
PF_MOBILE="$HOME/.teyvat/ProgramFiles/Mobile"
DEPLOYED_APPS="$PAIMON_EXT/teyvat/universe.infotech/local.mobile/apps"
mkdir -p "$PF_MOBILE"
if [ -d "$DEPLOYED_APPS" ]; then
  for app_dir in "$DEPLOYED_APPS"/*/; do
    [ -d "$app_dir" ] || continue
    app_name=$(basename "$app_dir")
    [[ "$app_name" == @FUTURE.* || "$app_name" == @removed.* || "$app_name" == .* ]] && continue
    ln -sfn "$app_dir" "$PF_MOBILE/$app_name"
  done
  ok "mobile apps → ProgramFiles/Mobile"
fi

# ── 5. launcher ──
mkdir -p "$HOME/.local/bin"
LAUNCHER_SRC="$IMPL/god.frontend.cli/launcher.sh"
if [ -f "$LAUNCHER_SRC" ]; then
  cp "$LAUNCHER_SRC" "$HOME/.local/bin/genshin"
  chmod +x "$HOME/.local/bin/genshin"
  # 2026-09-12：touch 强制更新 mtime——让快照重建逻辑检测到源比快照新
  touch "$HOME/.local/bin/genshin"
fi
# 2026-09-25（debug-01 修 Linux “装完还是不能用”）：确保 ~/.local/bin 在 PATH。
# macOS 上它通常已在（用户环境自带）；**Fedora/Debian 等默认不含** → 装完跑 `genshin` 报“未找到命令”。
# 判定：当前 PATH 已含 → 不动（不污染 rc）；不含 → 幂等追加一次（带标记防重复）。
case ":$PATH:" in
  *":$HOME/.local/bin:"*)
    : # 已在 PATH（当前会话即可用），不改 shell rc
    ;;
  *)
    for _rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [ -f "$_rc" ] || continue
      grep -qF '.teyvat: ~/.local/bin' "$_rc" 2>/dev/null || printf '\n# teyvat: ~/.local/bin（genshin 启动器）\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$_rc"
    done
    warn "~/.local/bin 不在 PATH——已写入 shell rc（重开终端或 source 后生效）"
    ;;
esac
ok "launcher"

# ── 5b. mobile CLI ──
# 源码 2026-07-29 已移至 teyvat-sides/F.experimental/teyvat.accessibility/claudecode/
# （F.experimental = 尝试过但目前不用）。不再从 A.core 安装；~/.local/bin/mobile 若已存在则保持旧版。
MOBILE_CLI_DIR="$IMPL/universe.accessibility/claudecode"
if [ -f "$MOBILE_CLI_DIR/mobile-cli.sh" ]; then
  cp "$MOBILE_CLI_DIR/mobile-cli.sh" "$HOME/.local/bin/mobile"
  cp "$MOBILE_CLI_DIR/mobile-runner.mjs" "$HOME/.local/bin/mobile-runner.mjs"
  chmod +x "$HOME/.local/bin/mobile"
  ok "mobile cli"
else
  # 2026-09-25（debug-01 去噪）：源码已移入 F.experimental（弃用主线）是**预期状态**，
  # 每次 Linux/新机安装都打一行 WARN 只会让人误以为装坏了（房东原话：里面全是错误）。静默跳过。
  : # mobile cli 源码在 F.experimental（不在 A.core 是正常的）
fi

# ── 5c. identity CLI ──
# 源码已不在 A.core（仅存于 R.release/prerelease 与 historical）。
IDENTITY_CLI="$IMPL/spirit.abio.identity/identity-cli.sh"
if [ -f "$IDENTITY_CLI" ]; then
  cp "$IDENTITY_CLI" "$HOME/.local/bin/identity"
  chmod +x "$HOME/.local/bin/identity"
  ok "identity cli"
else
  : # identity cli 源码已不在 A.core（仅存发布仓/历史）——预期状态，静默（去噪）
fi

# ── 5d. npm dependencies: 自动安装 A.core package.json 中新增的依赖 ──
# 2026-09-13 23:05 教训（claude-code 引入、debug-01/dev-01 发现并加了 5d-2 自愈 + Makefile ensure-dev-links）：在 A.core 跑 npm install 会把
# 指向 runtime 的 @earendil-works/* 手工链接当"多余包"prune 掉 → 全项目 TS2307、部署卡死 3 分钟。根治：这一步不再在 A.core 跑 npm install
# （EXT_DIR 置空 = 跳过），A.core 的依赖解析靠 launcher 的 NODE_PATH → runtime；5d-2 的重链保留作自愈。新依赖走 runtime 安装流程。
EXT_DIR=""
if [ -n "$EXT_DIR" ] && [ -f "$EXT_DIR/package.json" ]; then
  echo "  installing dependencies..."
  (cd "$EXT_DIR" && npm install --no-save --no-audit --no-fund --loglevel=error 2>&1) || true
  # 5d-2（2026-09-13 dev-01）：npm install 的 prune 副作用自愈——npm 会把 node_modules 对齐 package.json，
  # 删掉未声明的手工链接包（@earendil-works/* 与 @mariozechner/*——pi 包只存在于 runtime，A.core 里是链接），
  # 导致全项目 TS2307×30、全团队部署卡死（23:05 实证，ISSUE 238）。立即从 runtime 重链（与 Makefile ensure-dev-links 同逻辑）。
  if [ -d "$RUNTIME/node_modules/@earendil-works" ]; then
    for p in pi-agent-core pi-ai pi-coding-agent pi-tui; do
      [ -e "$EXT_DIR/node_modules/@earendil-works/$p" ] || ln -sfn "$RUNTIME/node_modules/@earendil-works/$p" "$EXT_DIR/node_modules/@earendil-works/$p"
    done
    [ -e "$EXT_DIR/node_modules/@mariozechner/pi-coding-agent" ] || { mkdir -p "$EXT_DIR/node_modules/@mariozechner" 2>/dev/null; ln -sfn "$RUNTIME/node_modules/@mariozechner/pi-coding-agent" "$EXT_DIR/node_modules/@mariozechner/pi-coding-agent" 2>/dev/null; }
  fi
fi

# ── 6. shell completion ──
# 源文件不存在时【不得】往 rc 追加 source 行——否则 .zshrc 会一代代堆积指向空气的行
# （历史上已积压 .pi / .pim / .paimon ×2 / .genshin 五代死链）。
COMPL_SRC="$IMPL/god.frontend.cli/genshin-completion.zsh"
if [ -f "$COMPL_SRC" ]; then
  COMPL_DIR="$HOME/.teyvat/agent/config"
  mkdir -p "$COMPL_DIR"
  cp "$COMPL_SRC" "$COMPL_DIR/genshin-completion.zsh"
  SRC_LINE='source "$HOME/.teyvat/agent/config/genshin-completion.zsh" 2>/dev/null'
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$rc" ] || continue
    grep -qF '.teyvat/agent/config/genshin-completion.zsh' "$rc" || printf '\n# teyvat shell completion\n%s\n' "$SRC_LINE" >> "$rc"
  done
  ok "completion"
else
  warn "completion 源文件缺失: ${COMPL_SRC#$IMPL/}，跳过（未改动 shell rc）"
fi

# ── 6b. terminal scrollback → unlimited ──
if [ "$(uname)" = "Darwin" ]; then
  # iTerm2
  ITERM_PLIST="$HOME/Library/Preferences/com.googlecode.iterm2.plist"
  if [ -f "$ITERM_PLIST" ]; then
    ITERM_CHANGED=0
    ITERM_IDX=0
    while /usr/libexec/PlistBuddy -c "Print ':New Bookmarks:$ITERM_IDX:Name'" "$ITERM_PLIST" >/dev/null 2>&1; do
      CURRENT=$(/usr/libexec/PlistBuddy -c "Print ':New Bookmarks:$ITERM_IDX:Unlimited Scrollback'" "$ITERM_PLIST" 2>/dev/null)
      if [ "$CURRENT" != "true" ]; then
        /usr/libexec/PlistBuddy -c "Set ':New Bookmarks:$ITERM_IDX:Unlimited Scrollback' true" "$ITERM_PLIST" 2>/dev/null && ITERM_CHANGED=1
      fi
      ITERM_IDX=$((ITERM_IDX + 1))
    done
    if [ "$ITERM_CHANGED" = "1" ]; then
      ok "iTerm2 scrollback → unlimited ($ITERM_IDX profiles, restart iTerm2 to apply)"
    else
      ok "iTerm2 scrollback: unlimited ($ITERM_IDX profiles)"
    fi
  fi
fi

# ── 7. migration (one-time, silent unless triggered) ──
GLOBAL_PI_DIST=""
NPM_GLOBAL="$(npm root -g 2>/dev/null)"
SEARCH_PATHS=""
[ -n "$NPM_GLOBAL" ] && SEARCH_PATHS="$NPM_GLOBAL/@earendil-works/pi-coding-agent/dist"
SEARCH_PATHS="$SEARCH_PATHS /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist"
SEARCH_PATHS="$SEARCH_PATHS /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist"
SEARCH_PATHS="$SEARCH_PATHS /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist"
for c in $SEARCH_PATHS; do [ -f "$c/core/tools/bash.js" ] && { GLOBAL_PI_DIST="$c"; break; }; done

if [ -n "$GLOBAL_PI_DIST" ]; then
  GLOBAL_PKG="$(dirname "$GLOBAL_PI_DIST")"
  if [ -d "$GLOBAL_PKG/dist-traditional" ]; then
    GLOBAL_VER=$(node -e "try{console.log(require('$GLOBAL_PKG/package.json').version)}catch {}" 2>/dev/null)
    npm i -g "@earendil-works/pi-coding-agent@${GLOBAL_VER:-latest}" >/dev/null 2>&1
    ok "migration: global pi restored"
  fi
  if [ -f "$HOME/.local/bin/pi" ] && [ ! -L "$HOME/.local/bin/pi" ] && grep -q "person-based launcher" "$HOME/.local/bin/pi" 2>/dev/null; then
    mv "$HOME/.local/bin/pi" "$HOME/.local/bin/pi.old-launcher"
    ok "migration: old launcher renamed"
  fi
fi

# ── 7. version ──
if [ -n "$PAIMON_VER" ]; then
  mkdir -p "$HOME/.teyvat/agent"
  CHANNEL="${PAIMON_CHANNEL:-minutely}"
  # ISSUE 138：prerelease 双号——pinnedDev = 绑定的 dev 版本（类比 genshin/pi 双版本）。
  # PAIMON_PINNED_DEV 非空时记入 version.json；非 prerelease 通道不设。
  if [ -n "$PAIMON_PINNED_DEV" ] && [ "$PAIMON_PINNED_DEV" != "$PAIMON_VER" ]; then
    echo "{\"genshin\":\"$PAIMON_VER\",\"pinnedDev\":\"$PAIMON_PINNED_DEV\",\"pi\":\"$PIN\",\"channel\":\"$CHANNEL\"}" > "$HOME/.teyvat/agent/version.json"
    ok "version $PAIMON_VER ($CHANNEL, pin $PAIMON_PINNED_DEV, pi@$PIN)"
  else
    echo "{\"genshin\":\"$PAIMON_VER\",\"pi\":\"$PIN\",\"channel\":\"$CHANNEL\"}" > "$HOME/.teyvat/agent/version.json"
    # dev-stable: also save a separate version file for genshin -v listing
    if [ "$PAIMON_CHANNEL" = "dev-stable" ]; then
      echo "{\"genshin\":\"$PAIMON_VER\",\"pi\":\"$PIN\"}" > "$HOME/.teyvat/agent/version-stable.json"
    fi
    ok "version $PAIMON_VER ($CHANNEL, pi@$PIN)"
  fi
fi

# ── 8. 部署完整性验证 ──
# 不靠 quiet_cp 的返回值——直接检查目标文件是否存在
DEPLOY_ERRORS=0
_deployed() {
  if [ -e "$1" ]; then return; fi
  # 偶发 rsync 竞态：等 0.5s 再试一次
  sleep 0.2
  if [ -e "$1" ]; then return; fi
  echo -e "  ${RED}MISSING${R}  $1"
  DEPLOY_ERRORS=1
}

echo ""
echo "  verifying deployment..."

# runtime
_deployed "$PI_DIST/cli.js"
_deployed "$PI_DIST/core/tools/bash.js"

# overrides（interactive-mode.js + 它 require 的所有文件）
_deployed "$PI_DIST/modes/interactive/interactive-mode.js"
_deployed "$PI_DIST/modes/interactive/components/blocks_nongod.js"
_deployed "$PI_DIST/modes/interactive/components/footer.js"
_deployed "$PI_DIST/modes/interactive/components/status-indicator.js"
# spinner.js 验证已移除：源文件 73029b86 (2026-07-28) 随重构删除，dist 内无任何 import 引用它

# 扩展核心文件
EXT="$PAIMON_EXT/teyvat"
_deployed "$EXT/paths.ts"
_deployed "$EXT/index.ts"
_deployed "$EXT/package.json"
_deployed "$EXT/spirit.bio.organs/kernel.core/core.ts"
_deployed "$EXT/spirit.bio.organs/kernel.heart/heart.ts"
_deployed "$EXT/spirit.bio.organs/hands.executes/executes.ts"
_deployed "$EXT/spirit.bio.organs/head.mouth/mouth.ts"
_deployed "$EXT/spirit.bio.organs/head.ears/ears.ts"
# 2026-09-22（a_great_agent_on_imac_01 报的阻断 bug，IMAC 实测）：@ABANDONED.* 两个目录**不随包分发**——
# A.core/.gitignore:15 有 `*ABANDONED*`，发布仓里根本没有它们（已核实），且运行时也没有任何代码 import
# （core.ts 里的 import 已注释，只剩注释/字符串提及）。所以它们**不能**出现在这份"必须存在"清单里：
# 否则从发布仓装的新机器必定 MISSING → err 退出 → 连带跳过后续 patch 与 manifest 生成（安装直接挂）。
# 教训：这份清单应由"实际分发内容的 manifest"驱动，不该手写硬编码路径（手写=迟早和 .gitignore/重构对不上）。
# _deployed "$EXT/spirit.bio.organs/@ABANDONED.brain.metaconsciousness/metaconsciousness.ts"
# _deployed "$EXT/spirit.bio.organs/@ABANDONED.brain.hippocampus/hippocampus-sleep.ts"
_deployed "$EXT/spirit.bio.gene/rna.json"
_deployed "$EXT/god.frontend.cli/launcher.sh"
_deployed "$EXT/universe.infotech/cloud.servers/browser_service.cjs"
_deployed "$EXT/universe.infotech/local.mobile/system.kernel/kernel.ts"

# release 标记
if grep -q '"release"' "$EXT/paths.ts" 2>/dev/null; then
  ok "BUILD_MODE = release"
else
  warn "BUILD_MODE = dev（未标记为 release）"
fi

# launcher
_deployed "$HOME/.local/bin/genshin"

# require 路径验证：interactive-mode.js 引用的 components 必须存在
if [ -f "$PI_DIST/modes/interactive/interactive-mode.js" ]; then
  for req in $(grep -oE 'require\("[^"]+"\)' "$PI_DIST/modes/interactive/interactive-mode.js" | grep -oE '"[^"]+"' | tr -d '"'); do
    # 只检查相对路径
    case "$req" in ./*)
      TARGET="$PI_DIST/modes/interactive/$req"
      # 补 .js 后缀
      [ -f "$TARGET" ] || [ -f "${TARGET}.js" ] || { echo -e "  ${RED}BROKEN REQUIRE${R}  interactive-mode.js → $req"; DEPLOY_ERRORS=1; }
    ;; esac
  done
fi

if [ "$DEPLOY_ERRORS" = "0" ]; then
  ok "deployment verified"
else
  err "部署验证失败 — 上面标红的文件缺失，运行时会崩溃"
fi

echo ""
# （2026-09-13：manifest 生成移到文件末尾——原来在 read.js/model-resolver.js/model-registry.js 三个后置补丁之前算 md5，下一次 PAIMON_VER 为空的安装必报 DRIFT）

  # read/write/edit TUI: silent() → 显示 ⎿ 摘要（末尾执行，确保不被覆盖）
TE="$PI_DIST/modes/interactive/components/tool-execution.js"
if [ -f "$TE" ]; then
  # 2026-09-22（不删原则）：补丁脚本写进**固定暂存路径**（同名覆盖，不落 pi dist、不需要删除）
  _SCRATCH="$HOME/.local/lib/teyvat/.install-scratch"; mkdir -p "$_SCRATCH"
  _patch_read="$_SCRATCH/patch-read.cjs"
  cat > "$_patch_read" <<'ENDPATCH'
const fs = require('fs');
let src = fs.readFileSync(process.argv[2], 'utf8');
const oldLine = '            return renderMessage.silent();';
const newLine = '            const rawHd = ((result?.content || [])[0]?.text || "").split("\\n")[0] || "";\n            const hd = rawHd.replace(/\\s+/g, " ").replace(/(\\d+)/g, m => t.bold(m));\n            return renderMessage.summary(t, ctx, hd);';
src = src.split(oldLine).join(newLine);
fs.writeFileSync(process.argv[2], src);
console.log('patch-ok');
ENDPATCH
  node "$_patch_read" "$TE"

  # patch tui.js: Container.render 容错无 render 方法的 child
  _tui_js="$PI_PKG/node_modules/@earendil-works/pi-tui/dist/tui.js"
  if [ -f "$_tui_js" ]; then
    _patch_tui="$_SCRATCH/patch-tui.cjs"
    cat > "$_patch_tui" <<'ENDPATCH'
const fs = require('fs');
let src = fs.readFileSync(process.argv[2], 'utf8');
const oldLine = 'const childLines = child.render(width);';
const newLine = 'const childLines = typeof child.render === "function" ? child.render(width) : (typeof child === "string" ? [child] : []);';
src = src.split(oldLine).join(newLine);
fs.writeFileSync(process.argv[2], src);
console.log('patch-tui-ok');
ENDPATCH
    node "$_patch_tui" "$_tui_js"
  fi

  # patch read.js: getNonVisionImageNote 的 model.input.includes 缺 Array.isArray 防御（2026-09-07：models.dev 合成/第三方模型缺 input 字段 → Undefined reading 'includes'）。debug-01 只修了 pi-ai 5 处，漏了 pi-coding-agent read.js 这处。
  _read_js="$PI_DIST/core/tools/read.js"
  if [ -f "$_read_js" ]; then
    _patch_readimg="$_SCRATCH/patch-readimg.cjs"
    cat > "$_patch_readimg" <<'ENDPATCH'
const fs = require('fs');
let src = fs.readFileSync(process.argv[2], 'utf8');
const oldLine = 'if (!model || model.input.includes("image")) {';
const newLine = 'if (!model || !Array.isArray(model.input) || model.input.includes("image")) {';
if (src.includes(oldLine)) {
  src = src.split(oldLine).join(newLine);
  fs.writeFileSync(process.argv[2], src);
  console.log('patch-read-image-input-ok');
} else {
  console.log('patch-read-image-input-skip (pattern not found, already patched or version drift)');
}
ENDPATCH
    node "$_patch_readimg" "$_read_js"
  fi

  # patch model-resolver.js: deepseek provider 首次安装默认模型 pro → flash（2026-09-07 用户定稿：首次装 teyvat 默认 deepseek-v4-flash）
  _mr_js="$PI_DIST/core/model-resolver.js"
  if [ -f "$_mr_js" ]; then
    _patch_mr="$_SCRATCH/patch-model-resolver.cjs"
    cat > "$_patch_mr" <<'ENDPATCH'
const fs = require('fs');
let src = fs.readFileSync(process.argv[2], 'utf8');
const oldLine = 'deepseek: "deepseek-v4-pro",';
const newLine = 'deepseek: "deepseek-v4-flash",  // teyvat patch 2026-09-07: 首次安装默认 flash（原 v4-pro）';
if (src.includes(oldLine)) {
  src = src.split(oldLine).join(newLine);
  fs.writeFileSync(process.argv[2], src);
  console.log('patch-model-resolver-ok');
} else {
  console.log('patch-model-resolver-skip (pattern not found, already patched or version drift)');
}
ENDPATCH
    node "$_patch_mr" "$_mr_js"
  fi

  # ── 已移除：patch model-registry.js（contextWindow/maxTokens 继承）2026-09-22 ──
  # 原因（a_great_agent_on_imac_01 报的 #4：长期 `patch-model-registry:0 (期望 3)` 静默失配）：
  #   `model-registry.js` 现在是 teyvat 的**整文件 override**（god.tui/overrides/pi-dist/core/model-registry.js），
  #   而 ISSUE 143/144 的三条修复早已落在 override 里（L671-676 的 defaults 自带 contextWindow/maxTokens；
  #   且全文已无 `?? 128000` / `?? 16384`）——针对 stock 文件的字符串补丁再也匹配不到，永远 0/3。
  #   留着它=每次安装打一条唬人的 `0 (期望 3)`（静默 no-op 管线）。所以直接删。
  #   以后同类需求请改 override 源文件（走 make），不要再加后置字符串补丁。

  # patch runtime package.json: add #gene_riboswitch import (inline, no temp file)
  node -e "
    const fs=require('fs');
    const p='$PI_PKG/package.json';
    const pkg=JSON.parse(fs.readFileSync(p,'utf8'));
    pkg.imports=pkg.imports||{};
    if(!pkg.imports['#gene_riboswitch']){pkg.imports['#gene_riboswitch']='./dist/debug.js';fs.writeFileSync(p,JSON.stringify(pkg,null,2));}
  " 2>/dev/null
  # create stub debug.js
  mkdir -p "$PI_PKG/dist"
  if [ ! -f "$PI_PKG/dist/debug.js" ]; then
    echo 'export const debug = () => {};' > "$PI_PKG/dist/debug.js"
  fi
fi

# save manifest for next install's drift check（放在全部补丁之后，见上方注释）
: > "$MANIFEST"
for f in $(find "$PI_DIST" "$PI_TUI_DIST" -name '*.js' -not -name '*.map' 2>/dev/null); do
  h=$(md5 -q "$f" 2>/dev/null || md5sum "$f" 2>/dev/null | cut -d' ' -f1)
  printf '%s\t%s\n' "$h" "$f" >> "$MANIFEST"
done

echo -e "  ${GRN}done${R}""  Teyvat@$PIN"
echo -e "  ${YEL}WARN 程序没有热加载，需要重启后检查变更${R}"
echo ""
