# index.html.SPEC

**用途**: Web IM demo 前端——单页聊天界面（微信式布局：左 agent 列表 + 右聊天区 + 底部输入）。
**为什么需要**: 用户指派任务（2026-09-13）——GUI demo 验证「选 agent → 发消息 → agent 回」。前端需展示 agent 列表（在线状态）、切换选中 agent、显示对话、发送消息、SSE 实时接收 agent 回复。
**技术选型**: 纯原生 HTML+CSS+JS（无框架、无构建）——demo 用，快速可跑；flexbox 左右分栏；EventSource 接 SSE 实时推送。
**配套**: server.mjs（同目录后端，提供 /agents /messages /send /events）。
**用法**: 由 server.mjs 在 GET / 时直接吐出本文件（浏览器打开 http://localhost:8790）。
