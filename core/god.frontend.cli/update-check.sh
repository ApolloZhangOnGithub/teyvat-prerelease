#!/bin/bash
# 后台轻量版本检测（2026-09-11）
# 用法：后台静默运行，结果缓存到 ~/.teyvat/RuntimeCache/update-check.json
# 频率：每 4 小时最多检查一次（读 checked 时间戳）
# 错误：网络失败静默退出，不影响任何功能
set -e

CACHE="$HOME/.teyvat/RuntimeCache/update-check.json"
VER_JSON="$HOME/.teyvat/agent/version.json"
mkdir -p "$(dirname "$CACHE")" 2>/dev/null

# 频率限制：4 小时内不重复检查
if [ -f "$CACHE" ]; then
  LAST=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CACHE','utf8')).checked||'')}catch{}" 2>/dev/null)
  if [ -n "$LAST" ]; then
    AGE=$(node -e "console.log(Math.floor((Date.now()-new Date('$LAST').getTime())/1000))" 2>/dev/null)
    [ "${AGE:-0}" -lt 14400 ] && exit 0
  fi
fi

# 读当前版本和通道
CURRENT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$VER_JSON','utf8')).genshin||'')}catch{console.log('')}" 2>/dev/null)
CHANNEL=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$VER_JSON','utf8')).channel||'minutely')}catch{console.log('minutely')}" 2>/dev/null)

# minutely 通道不检查远端（dev 自动构建）
[ "$CHANNEL" = "minutely" ] && exit 0

# 查远端版本
AVAILABLE=""
if [ "$CHANNEL" = "prerelease" ] || [ "$CHANNEL" = "beta" ]; then
  AVAILABLE=$(git ls-remote --tags https://github.com/ApolloZhangOnGithub/paimon-code-prerelease.git 2>/dev/null | awk -F/ '{print $NF}' | sort -V | tail -1 || true)
  # fallback：查远端 package.json
  if [ -z "$AVAILABLE" ]; then
    AVAILABLE=$(curl -sL --max-time 5 "https://raw.githubusercontent.com/ApolloZhangOnGithub/paimon-code-prerelease/main/package.json" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).version)}catch{}})" 2>/dev/null || true)
  fi
elif [ "$CHANNEL" = "release" ]; then
  AVAILABLE=$(curl -sL --max-time 5 "https://raw.githubusercontent.com/ApolloZhangOnGithub/teyvat-release/main/package.json" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).version)}catch{}})" 2>/dev/null || true)
fi

# 写缓存
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node -e "require('fs').writeFileSync('$CACHE', JSON.stringify({available:'${AVAILABLE:-}',current:'${CURRENT:-}',channel:'$CHANNEL',checked:'$NOW'}, null, 2))" 2>/dev/null || true
