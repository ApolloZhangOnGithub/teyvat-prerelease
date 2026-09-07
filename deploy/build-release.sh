#!/bin/bash
# build-github.sh — 从 DEV 打包发布
#
# 用法:
#   bash Codebase/deploy/scripts/build-github.sh 0.2.8          # 发 dev + stable
#   bash Codebase/deploy/scripts/build-github.sh 0.2.8 dev      # 只发 dev
#   bash Codebase/deploy/scripts/build-github.sh 0.2.8 stable   # 只发 stable
#
# 目录结构:
#   A.core/              ← 开发（无版本号）
#   R.release/
#     v0.2.8-dev/                      ← 全量快照 → push github-dev
#     v0.2.8-stable/                   ← 精简包 → npm publish
#     prerelease/                      ← 精简包 minutely → push github-prerelease
#     VERSION.INDEX                    ← 版本记录
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEV="$(cd "$SCRIPT_DIR/../A.core" && pwd)"
PARENT="$(dirname "$DEV")"
RELEASE_DIR="$PARENT/../teyvat-sides/R.release"

VER="${1:-}"
TARGET="${2:-all}"
# ISSUE 138（版本机制重构）：prerelease 双号——PINNED_DEV 用环境变量传入（不占参数位，兼容旧调用）
PINNED_DEV="${PINNED_DEV:-}"

if [ -z "$VER" ]; then
  echo "用法: $0 <版本号> [dev|stable|minutely|all]"
  echo "  例: $0 0.2.8"
  echo "  例: $0 0.2.8-dev.20250716.3 minutely"
  exit 1
fi

DEV_DIR="$RELEASE_DIR/v${VER}-dev"
STABLE_DIR="$RELEASE_DIR/v${VER}-stable"
PRERELEASE_DIR="$RELEASE_DIR/prerelease"
VERSION_INDEX="$RELEASE_DIR/VERSION.INDEX"

# ── 共用排除 ──
CLEAN_EXCLUDES=(
  --exclude='.DS_Store'
  --exclude='__pycache__'
  --exclude='*.pyc'
  --exclude='*.pyo'
  --exclude='node_modules'
  --exclude='*.log'
  --exclude='.env'
  --exclude='.env.*'
  --exclude='*.pem'
  --exclude='*.key'
  --exclude='*.crt'
  --exclude='data/cookies/'
  --exclude='authorize.TRUST'
  --exclude='head.ears/ears-config.json'
  --exclude='*ABANDONED*'
  --exclude='*REMOVED*'
  --exclude='*FUTURE*'
  --exclude='.git'
)

# ── 安全检查 ──
security_check() {
  local dir="$1" label="$2"
  local leaked=0
  local p1='7mTFF''zKEkzC4DcV3'
  local p2='53487''81537'
  local p3="$HOME"
  for pattern in "$p1" "$p2" "$p3"; do
    if grep -rq --exclude='build-github.sh' "$pattern" "$dir" 2>/dev/null; then
      echo "  LEAKED: $pattern"
      leaked=1
    fi
  done
  if [ "$leaked" -eq 1 ]; then
    echo "  Error: $label 有敏感信息泄露，中止。"
    return 1
  fi
  echo "  OK 安全检查通过"
}

# ══════════════════════════════════════════════════════════════════════
# DEV 版：全量（Codebase + Docs）→ github-dev
# ══════════════════════════════════════════════════════════════════════
build_dev() {
  echo ""
  echo "══ build v${VER}-dev ══"

  mkdir -p "$DEV_DIR"

  # A.core (全量代码)
  rsync -a --delete "${CLEAN_EXCLUDES[@]}" --exclude='debug/logs/' \
    "$DEV/" "$DEV_DIR/"

  # Docs
  rsync -a --delete "${CLEAN_EXCLUDES[@]}" \
    --exclude='Paper/' \
    --filter='- *Paper*/' \
    --exclude='*.aux' --exclude='*.out' --exclude='*.synctex.gz' --exclude='.!*' \
    --exclude='Readme/' \
    "$DEV/../B.docs/" "$DEV_DIR/Docs/"

  # .gitignore
  [ -f "$DEV/.gitignore" ] && cp "$DEV/.gitignore" "$DEV_DIR/.gitignore"

  # README.md
  if [ -f "$DEV_DIR/README.md" ]; then
    echo "  ERROR: $DEV_DIR/README.md already exists"; return 1
  fi
  [ -f "$DEV/../B.docs/Cook.Human/README_dev.md" ] && cp "$DEV/../B.docs/Cook.Human/README_dev.md" "$DEV_DIR/README.md"

  echo "  OK 打包完成"
  security_check "$DEV_DIR/" "dev" || return 1

  # git init + push
  if [ ! -d "$DEV_DIR/.git" ]; then
    cd "$DEV_DIR"
    git init -b main
    git remote add origin https://github.com/ApolloZhangOnGithub/teyvat-dev.git 2>/dev/null || echo "remote exists" >&2
  fi

  cd "$DEV_DIR"
  git add -A
  if git diff --cached --quiet 2>/dev/null; then
    echo "  无变更。"
  else
    git commit -m "v${VER}-dev $(date '+%Y-%m-%d %H:%M')"
    git push origin main --force
    echo "  OK pushed github-dev"
  fi
}

# ══════════════════════════════════════════════════════════════════════
# MINUTELY 版：精简（core + deploy + package.json）→ github-prerelease
# ══════════════════════════════════════════════════════════════════════
# ⚠️ 2026-09-07 错误警示（LESSON 067）：wsl-compatibility-researcher-01 曾把本函数擅自改成
#   "git tag 发布"（打 alpha tag 到 teyvat-dev，弃合成仓库）。用户从未拍板该方案，已回滚复原。
#   **保持合成仓库路线（build_minutely 打包推送 github-prerelease），不要改回 tag 方案。**
build_minutely() {
  echo ""
  echo "══ build ${VER} (minutely → prerelease) ══"

  mkdir -p "$PRERELEASE_DIR"

  # core（精简，无 debug）
  rsync -a --delete "${CLEAN_EXCLUDES[@]}" --exclude='debug/' \
    "$DEV/" "$PRERELEASE_DIR/core/"

  # deploy
  rsync -a --delete "${CLEAN_EXCLUDES[@]}" \
    "$DEV/../C.deploy/" "$PRERELEASE_DIR/deploy/"

  # package.json（ISSUE 138 双号：version=alpha 发布号，pinnedDev=绑定的 dev 版本号）
  # PINNED_DEV 为空（旧调用）时回退：version 即 dev 号（兼容；新调用必传）
  if [ -z "$PINNED_DEV" ]; then PINNED_DEV="$VER"; fi
  cat > "$PRERELEASE_DIR/package.json" << PKGEOF
{
  "name": "teyvat",
  "version": "$VER",
  "pinnedDev": "$PINNED_DEV",
  "description": "Living AI agent extension for pi-coding-agent",
  "license": "MIT",
  "os": ["darwin", "linux"],
  "engines": { "node": ">=18" },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.80.7"
  },
  "scripts": {
    "postinstall": "PAIMON_CHANNEL=prerelease PAIMON_VER=$VER PAIMON_PINNED_DEV=$PINNED_DEV bash deploy/install.sh"
  },
  "files": ["core/", "deploy/", "README.md"]
}
PKGEOF

  # README（每次覆盖）
  [ -f "$DEV/../B.docs/Cook.Human/README_release.md" ] && cp "$DEV/../B.docs/Cook.Human/README_release.md" "$PRERELEASE_DIR/README.md"

  # .gitignore
  cat > "$PRERELEASE_DIR/.gitignore" << 'GITEOF'
.DS_Store
__pycache__/
*.pyc
node_modules/
*.log
data/cookies/
*.pem
*.key
authorize.TRUST
head.ears/ears-config.json
*ABANDONED*
*REMOVED*
*FUTURE*
GITEOF

  echo "  OK 打包完成"
  security_check "$PRERELEASE_DIR/core/" "minutely" || return 1

  # git init + push
  if [ ! -d "$PRERELEASE_DIR/.git" ]; then
    cd "$PRERELEASE_DIR"
    git init -b main
    git remote add origin https://github.com/ApolloZhangOnGithub/teyvat-prerelease.git 2>/dev/null || echo "remote exists" >&2
  fi

  cd "$PRERELEASE_DIR"
  git add -A
  if git diff --cached --quiet 2>/dev/null; then
    echo "  无变更。"
  else
    git commit -m "${VER} (pin ${PINNED_DEV}) $(date '+%Y-%m-%d %H:%M')"
    git push origin main --force
    echo "  OK pushed github-prerelease"
  fi
}

# ══════════════════════════════════════════════════════════════════════
# STABLE 版：精简（core + deploy + package.json）→ npm publish
# ══════════════════════════════════════════════════════════════════════
build_stable() {
  echo ""
  echo "══ build v${VER}-stable (from live) ══"

  mkdir -p "$STABLE_DIR"

  # runtime（pi + deps）
  rsync -a --delete "${CLEAN_EXCLUDES[@]}" \
    "$HOME/.local/lib/teyvat/runtime/" "$STABLE_DIR/runtime/"

  # extensions（teyvat live copy）
  rsync -a --delete "${CLEAN_EXCLUDES[@]}" \
    "$HOME/.local/lib/teyvat/extensions/teyvat/" "$STABLE_DIR/extensions/teyvat/"

  # launcher
  mkdir -p "$STABLE_DIR/bin"
  cp "$HOME/.local/bin/genshin" "$STABLE_DIR/bin/genshin" 2>/dev/null || true

  # install.sh from live extensions
  if [ -f "$HOME/.local/lib/teyvat/extensions/teyvat/deploy/install.sh" ]; then
    cp "$HOME/.local/lib/teyvat/extensions/teyvat/deploy/install.sh" "$STABLE_DIR/install.sh"
  fi

  cat > "$STABLE_DIR/package.json" << PKGEOF
{
  "name": "teyvat",
  "version": "$VER",
  "description": "Living AI agent extension for pi-coding-agent",
  "license": "MIT",
  "os": ["darwin", "linux"],
  "engines": { "node": ">=18" }
}
PKGEOF

  echo "  OK 打包完成（live）"

  # README
  cat > "$STABLE_DIR/README.md" << 'EOFREADME'
# Teyvat v0.2.9

Living AI agent extension for pi-coding-agent.

## 安装

```bash
cp -a runtime/ ~/.local/lib/teyvat/runtime/
cp -a extensions/teyvat/ ~/.local/lib/teyvat/extensions/teyvat/
cp bin/genshin ~/.local/bin/genshin
chmod +x ~/.local/bin/genshin
```

## 依赖

- Node.js >= 18
- npm, git, rsync
- 可选：bun, tmux, ffmpeg, python3, Chrome/Chromium

## 启动

```bash
genshin <agent-name>
```
EOFREADME

  # 保存完整发布包到 RELEASE_DIR
  local RELEASE_PKG="$RELEASE_DIR/$VER-release"
  rm -rf "$RELEASE_PKG" 2>/dev/null
  cp -a "$STABLE_DIR" "$RELEASE_PKG"
  echo "  saved to $RELEASE_PKG"

  # GitHub Release → teyvat-prerelease
  cd "$RELEASE_PKG"
  local TGZ="teyvat-${VER}.tgz"
  tar czf "$TGZ" --exclude='.DS_Store' --exclude='node_modules/.cache' .
  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    if gh release view "v${VER}" --repo ApolloZhangOnGithub/teyvat-prerelease &>/dev/null 2>&1; then
      gh release upload "v${VER}" "$TGZ" --clobber --repo ApolloZhangOnGithub/teyvat-prerelease 2>/dev/null \
        && echo "  GitHub Release v${VER} asset updated" \
        || echo "  WARN: GitHub Release upload failed"
    else
      gh release create "v${VER}" "$TGZ" \
        --repo ApolloZhangOnGithub/teyvat-prerelease \
        --title "Teyvat v${VER}" \
        --notes "Live release from dev-stable. Runtime + extensions + launcher." \
        && echo "  GitHub Release v${VER} created" \
        || echo "  WARN: GitHub Release create failed"
    fi
  else
    echo "  WARN: gh not available, skip GitHub Release"
  fi

  # Push code to prerelease repo (same as minutely: core + deploy + tarball)
  mkdir -p "$PRERELEASE_DIR"
  rsync -a --delete "${CLEAN_EXCLUDES[@]}" --exclude='debug/' "$DEV/" "$PRERELEASE_DIR/core/"
  rsync -a --delete "${CLEAN_EXCLUDES[@]}" "$DEV/../C.deploy/" "$PRERELEASE_DIR/deploy/"
  cat > "$PRERELEASE_DIR/package.json" << PKGEOF
{
  "name": "teyvat",
  "version": "$VER",
  "description": "Living AI agent extension for pi-coding-agent",
  "license": "MIT",
  "os": ["darwin", "linux"],
  "engines": { "node": ">=18" },
  "dependencies": { "@earendil-works/pi-coding-agent": "0.80.7" },
  "scripts": { "postinstall": "PAIMON_CHANNEL=release PAIMON_VER=$VER bash deploy/install.sh" },
  "files": ["core/", "deploy/", "README.md"]
}
PKGEOF
  if [ ! -d "$PRERELEASE_DIR/.git" ]; then
    cd "$PRERELEASE_DIR"
    git init -b main
    git remote add origin https://github.com/ApolloZhangOnGithub/teyvat-prerelease.git 2>/dev/null || echo "remote exists" >&2
  fi
  cd "$PRERELEASE_DIR"
  git add -A
  if git diff --cached --quiet 2>/dev/null; then
    echo "  prerelease repo: 无变更"
  else
    git commit -m "${VER} $(date '+%Y-%m-%d %H:%M')"
    git push origin main --force
    echo "  OK pushed teyvat-prerelease"
  fi

  cd "$STABLE_DIR"
  local npm_ver
  npm_ver=$(npm view teyvat version 2>/dev/null || echo "")
  if [ "$npm_ver" != "$VER" ]; then
    echo "  npm publish ${VER}..."
    npm publish || echo "  WARN: npm publish 失败（可能需要 --otp）"
  else
    echo "  npm ${VER} 已是最新。"
  fi
}

# ── VERSION.INDEX ──
update_index() {
  local dev_ok="-" prerelease_ok="-" npm_ok="-"
  [ -f "$DEV_DIR/package.json" ] && dev_ok="github-dev"
  [ -d "$PRERELEASE_DIR/core" ] && prerelease_ok="prerelease"
  [ -d "$STABLE_DIR/core" ] && prerelease_ok="stable"

  local npm_ver
  npm_ver=$(npm view teyvat version 2>/dev/null || echo "")
  [ "$npm_ver" = "$VER" ] && npm_ok="npm@${VER}"

  local line
  line=$(printf "%-30s %-14s %-16s %-14s %s" "v${VER}" "$dev_ok" "$prerelease_ok" "$npm_ok" "$(date '+%Y-%m-%d %H:%M')")

  # 创建或更新
  if [ ! -f "$VERSION_INDEX" ]; then
    printf "%-30s %-14s %-16s %-14s %s\n" "VERSION" "DEV" "PRERELEASE" "NPM" "DATE" > "$VERSION_INDEX"
    echo "---" >> "$VERSION_INDEX"
    echo "" >> "$VERSION_INDEX"
  fi

  # 去掉旧的同版本行，追加新行
  grep -v "^v${VER} " "$VERSION_INDEX" > "${VERSION_INDEX}.tmp" 2>/dev/null || touch "${VERSION_INDEX}.tmp"
  mv "${VERSION_INDEX}.tmp" "$VERSION_INDEX"
  echo "$line" >> "$VERSION_INDEX"
  echo "  OK VERSION.INDEX 已更新"
}

# ── 执行 ──
echo "── build-github v${VER} (${TARGET}) ──"

case "$TARGET" in
  dev)      build_dev ;;
  stable)   build_stable ;;
  minutely) build_minutely ;;
  all)      build_dev; build_stable ;;
  *)        echo "用法: $0 <版本号> [dev|stable|minutely|all]"; exit 1 ;;
esac

update_index

echo ""
echo "── 完成 v${VER} ──"
