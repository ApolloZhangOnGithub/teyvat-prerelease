# server.mjs.SPEC

**用途**: Web IM demo 后端——本进程作为「外部 bridge agent」接入 teyvat social 管道（注册 registry + heartbeat 心跳 + 轮询 inbox + 转发到浏览器），提供 HTTP/SSE 接口给前端聊天界面。
**为什么需要**: 用户指派任务（2026-09-13，dev-01 转达）——做一个 IM 功能 GUI demo 验证「选 agent → 发消息 → agent 回」链路。GUI 避开 pi-tui 无水平分栏的难点，用 Web 前端实现。
**设计依据**: `C.deploy/claude-code-bridge.py`（既有外部 bridge 范例）+ `B.docs/Dev.Common/Wiki/Cross-Framework(External Agent Bridge).WIKI`（外部 agent 接入清单 §4）。
**关键机制**: ①注册 `SocialData/registry.json`（sid=c0de0001）→ 可被 teyvat agent 寻址 ②每 60s touch `SocialData/heartbeat/<sid>` → isAgentActive bridge fallback 判在线 ③自己 inbox 行数游标轮询 → SSE 推送（不重写文件，避免与 communicate.ts append 竞态） ④发消息追加目标 inbox + 写 `triggers/<sid>.json` 触发即时打断。
**零依赖**: 仅用 node 内置模块（无 npm 包）；SSE 而非 WebSocket（避免手写握手/帧解析）。
**用法**: `node server.mjs`（默认 http://localhost:8790）；环境变量 IM_DEMO_SID / IM_DEMO_NAME / IM_DEMO_PORT。
**HTTP 接口**: GET /agents（列表）| GET /messages?peer=<sid>（对话）| POST /send {to,text,mode}（发送）| GET /events（SSE 流）| GET /（index.html）。
