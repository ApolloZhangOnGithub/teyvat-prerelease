#!/bin/bash
# telemetry-update.sh — update 遥测管线（2026-09-09 用户定稿：update 操作要留痕 + 自动上报绑定账号）
# 功能：genshin update / install 完成后被 launcher 调用——
#   ① 本地日志（~/.teyvat/update-history.jsonl，每台可查"谁/何时/从→到"）
#   ② server 遥测上报（sync.paimon.beer/sync/update-telemetry——X-Device-Id 认证绑定账号——集中可见各台 update 历史）
# 用法: telemetry-update.sh <from_ver> <to_ver> <channel> [trigger]   （trigger: user/agent，默认 user）
# 失败静默（遥测非关键——不阻塞 update 主流程、不刷屏）
set -u
FROM_VER="${1:-unknown}"; TO_VER="${2:-unknown}"; CHANNEL="${3:-unknown}"; TRIGGER="${4:-user}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── ① 本地日志（append jsonl）──
LOG_FILE="$HOME/.teyvat/update-history.jsonl"
mkdir -p "$HOME/.teyvat" 2>/dev/null
# 设备身份（2026-09-09）：与 communicate loadBinding 同源——UserAccount/binding.json 的 deviceId + token（Bearer 认证）
_DEVICE_ID=""; _TOKEN=""
_BIND="$HOME/.teyvat/UserAccount/binding.json"
[ -f "$_BIND" ] && _BIND_INFO=$(node -e "try{const b=JSON.parse(require('fs').readFileSync('$HOME/.teyvat/UserAccount/binding.json','utf8'));console.log((b.deviceId||'')+'|'+(b.token||''))}catch(e){console.log('')}" 2>/dev/null)
_DEVICE_ID="${_BIND_INFO%%|*}"; _TOKEN="${_BIND_INFO#*|}"
[ -z "$_DEVICE_ID" ] && _DEVICE_ID=$(cat "$HOME/.teyvat/RuntimeCache/.device-id" 2>/dev/null || hostname)
_ENTRY=$(printf '{"ts":"%s","device_id":"%s","from":"%s","to":"%s","channel":"%s","trigger":"%s"}' "$TS" "$_DEVICE_ID" "$FROM_VER" "$TO_VER" "$CHANNEL" "$TRIGGER")
echo "$_ENTRY" >> "$LOG_FILE" 2>/dev/null
# 裁剪（只留最近 200 条——防无限增长）
tail -200 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null

# ── ② server 遥测上报（best effort——失败静默）──
_PAYLOAD="{\"from\":\"$FROM_VER\",\"to\":\"$TO_VER\",\"channel\":\"$CHANNEL\",\"ts\":\"$TS\",\"trigger\":\"$TRIGGER\"}"
if [ -n "$_TOKEN" ] && [ -n "$_DEVICE_ID" ]; then
  curl -s -m 8 -X POST "https://sync.paimon.beer/sync/update-telemetry" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $_TOKEN" \
    -H "X-Device-Id: $_DEVICE_ID" \
    -H "User-Agent: genshin-sync/1.0" \
    -d "$_PAYLOAD" >/dev/null 2>&1 || true
fi
exit 0
