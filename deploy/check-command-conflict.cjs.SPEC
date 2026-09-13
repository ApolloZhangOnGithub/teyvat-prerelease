# SPEC: check-command-conflict.cjs
# 2026-09-14 dev-01：ISSUE 252 定稿方案——make 时管线检查扩展 slash 命令与 pi 内置命令的撞名冲突。
# 背景：BUILTIN_SLASH_COMMANDS 是 pi 的占坑 manifest，扩展 registerCommand 同名命令会被静默废掉
# （autocomplete 跳过 + 不可达，诊断只在启动横幅 [Extension issues]，不进任何日志——ISSUE 252 /copy 事故）。
# 本门禁在 _integrity 阶段扫描 god.frontend.tui/commands/*.ts 的全部 registerCommand 名，与
# overrides/pi-dist/core/slash-commands.js 的内置 name 清单求交集；非空 → exit 1 列出冲突与两种解法。
