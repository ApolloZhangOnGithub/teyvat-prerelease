# SPEC: check-command-registered.cjs —— 命令注册完整性门禁

# 2026-09-22 dev-01（ISSUE 262）：由 check-copy-command.cjs 泛化而来（改名 + 覆盖全部命令面）。

# 背景（为什么存在）：teyvat 禁用了 pi 的原生命令分派
#   （god.frontend.tui/overrides/modes/interactive/interactive-mode.js:2468 把内置命令分派块整块换成注释），
#   所有 /command 必须经 god.frontend.tui/commands/register.ts 的 pi.registerCommand 注册。
#   未注册的 /xxx **不报错**，而是被 onSubmit 当普通用户消息发给 agent —— 静默失效。
#   历史事故：/copy、/m 曾漏注册（ISSUE 252）；`/c` 漏注册很久才被发现（ISSUE 262）。

# 三类检查：
#   ① 注册：REQUIRED 列表里每个命令都要有 registerCommand("<name>"
#   ② handler 来源：命令的 handler 必须真从对应文件 import（防"注册了个不存在的名字"）
#   ③ 桥：handler 需回调 InteractiveMode 实例方法的命令（copy/m/login/logout），
#      桥名必须同时在 interactive-mode（暴露）与 handler 文件（引用）出现

# 已接入 Makefile `_integrity`（部署前拦截）。新增命令请登记进 REQUIRED / IMPORTS / BRIDGES。

# 关联：ISSUE 262（本条）、ISSUE 252（/copy 撞名事故）、
#       WIKI: B.docs/Dev.Common/Wiki/Slash&Tools(Concept).WIKI（「pi 内置命令被禁用 + 复用内置名三件套」）
