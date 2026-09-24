#!/bin/bash
# git-app-identity.sh — 输出 GitHub App 的 commit 身份 + push token（供 make 流程 eval）
# 用法: eval "$(bash git-app-identity.sh)" → 得 GIT_APP_NAME / GIT_APP_EMAIL / GIT_APP_TOKEN
# 无配置 / 取 token 失败 → 不输出任何东西（调用方退回普通 git 身份，不阻断部署）
# 文档: git-app-identity.sh.SPEC
CFG="${GIT_APP_CONFIG:-$HOME/.teyvat/AgentWorkDir/Individual/${PAIMON_AGENT_ID:-af5c5269}/.gh-app/config.env}"
[ -f "$CFG" ] || exit 0
# shellcheck disable=SC1090
. "$CFG"
[ -n "$appId" ] && [ -n "$privateKey" ] && [ -n "$installationId" ] || exit 0
TOKEN=$(node "$(dirname "$0")/github-app-token.cjs" "$appId" "$privateKey" "$installationId" 2>/dev/null)
[ -n "$TOKEN" ] || exit 0
printf "export GIT_APP_NAME='%s'\n" "$botName"
printf "export GIT_APP_EMAIL='%s'\n" "$botEmail"
printf "export GIT_APP_TOKEN='%s'\n" "$TOKEN"
