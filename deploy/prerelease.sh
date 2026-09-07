#!/bin/bash
# prerelease.sh — prerelease 版本线（ISSUE 138 重构）
#   版本线: dev = 0.3.2-dev.YYYYMMDD.N（make dev-minutely 递增）| prerelease = 0.3.2-alpha.YYYYMMDD.M
#   M 独立计数（.alpha-counter），pin 对应 dev（默认最新 / dev= 指定），代码变化防空转，双号落盘。
# 用法: bash prerelease.sh <A.core路径> <CORE package.json version> <dev参数(可空)> <build-release.sh路径>
set -u
CORE="${1:?A.core 路径}"
REL_VER="${2:?package.json version}"
DEV_ARG="${3:-}"
BUILD_RELEASE="${4:-}"

TODAY=$(date +%Y%m%d)
DEV_COUNTER="$CORE/.build-counter"
ALPHA_COUNTER="$CORE/.alpha-counter"

# ── pin 的 dev 版本 ──
if [ -n "$DEV_ARG" ]; then
  PINNED_DEV="$DEV_ARG"
else
  if [ ! -f "$DEV_COUNTER" ]; then echo "  ERROR: 无 dev 构建记录，先 make dev-minutely"; exit 1; fi
  # .build-counter 三段格式: "日期 计数 版本线"（与 .alpha-counter 同构）；三变量 read 防 bash 把第三段吞进 DEV_COUNT
  # （曾两变量 read → DEV_COUNT="49 0.3.3-dev" 带尾巴 → PINNED_DEV 拼出 "...49 0.3.3-dev" 错值，2026-09-07 修复）
  read DEV_DATE DEV_COUNT DEV_REL_VER < "$DEV_COUNTER"
  if [ "$DEV_DATE" != "$TODAY" ]; then
    echo "  ERROR: 今天无 dev-minutely 构建（.build-counter 是 $DEV_DATE），先 make dev-minutely 再发 prerelease"; exit 1
  fi
  PINNED_DEV="$REL_VER.$TODAY.$DEV_COUNT"
fi

# ── alpha 独立计数（2026-09-07 修复：与 dev 同规则——同天递增前提是版本号不变，跨天或版本 bump 均重置 M=1）──
if [ -f "$ALPHA_COUNTER" ]; then
  read ALPHA_DATE ALPHA_COUNT ALPHA_REL_VER < "$ALPHA_COUNTER"
  if [ "$ALPHA_DATE" = "$TODAY" ] && [ "$ALPHA_REL_VER" = "$REL_VER" ]; then M=$((ALPHA_COUNT + 1)); else M=1; fi
else
  M=1
fi

# ── 代码变化校验：M 递增不得空转 ──
LAST_COMMIT_FILE="$CORE/.alpha-last-commit"
CUR_COMMIT=$(cd "$CORE" && git rev-parse HEAD 2>/dev/null)
if [ -z "$CUR_COMMIT" ]; then CUR_COMMIT="none"; fi
if [ "$M" -gt 1 ] && [ -f "$LAST_COMMIT_FILE" ]; then
  LAST_COMMIT=$(cat "$LAST_COMMIT_FILE" 2>/dev/null)
  if [ -n "$LAST_COMMIT" ] && [ "$LAST_COMMIT" = "$CUR_COMMIT" ]; then
    echo "  ERROR: 代码与上一 prerelease 相同 (HEAD $CUR_COMMIT) -- M 不递增防空转。先 make dev-minutely 提交新代码再发"; exit 1
  fi
fi

# ── alpha 版本号：REL_VER 的 -dev 段 → -alpha ──
ALPHA_BASE=$(node -e "const v=process.argv[1].replace(/-dev$/,'');console.log(v+'-alpha')" "$REL_VER")
ALPHA_VER="$ALPHA_BASE.$TODAY.$M"
echo "$TODAY $M $REL_VER" > "$ALPHA_COUNTER"
echo "$CUR_COMMIT" > "$LAST_COMMIT_FILE"
echo -e "  teyvat $ALPHA_VER (prerelease, pin $PINNED_DEV)"

# ── 调 build-release.sh（双号经环境变量传入）──
if [ -n "$BUILD_RELEASE" ] && [ -f "$BUILD_RELEASE" ]; then
  export PINNED_DEV="$PINNED_DEV"
  export ALPHA_VER="$ALPHA_VER"
  bash "$BUILD_RELEASE" "$ALPHA_VER" minutely
else
  echo "  [dry-run] ALPHA_VER=$ALPHA_VER PINNED_DEV=$PINNED_DEV (BUILD_RELEASE 未给，仅生成版本号)"
fi
