# SPEC: check-copy-command.cjs
# 2026-09-14 dev-01：防经典坑回归门禁。teyvat 禁用 pi 原生命令（interactive-mode L2439），
# 所有 /command 必须 register.ts 注册；/copy、/m 若注册被删则命令静默失效（不报错、只当普通消息发给 agent）。
# 本门禁在 make _integrity 时检查注册是否完整，缺失即报错拦截部署。
