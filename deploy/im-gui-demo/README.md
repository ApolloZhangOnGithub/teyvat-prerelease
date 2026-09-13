# im-gui-demo — Web IM demo

验证「选 agent → 发消息 → agent 回」链路的轻量 GUI（测试用，非精致版）。

## 启动

```bash
cd C.deploy/im-gui-demo
node server.mjs
# 浏览器打开 http://localhost:8790
```

环境变量：`IM_DEMO_SID`（默认 c0de0001）| `IM_DEMO_NAME`（默认 web-im-demo）| `IM_DEMO_PORT`（默认 8790）。

## 架构

```
浏览器 (index.html — 左侧 agent 列表 + 右侧聊天 + 底部输入)
   │  HTTP: /agents  /messages?peer=<sid>  POST /send
   │  SSE : /events（实时推送新消息）
   ▼
server.mjs（本进程 = 外部 bridge agent，sid=c0de0001）
   │  · 注册 SocialData/registry.json   → 可被 teyvat agent 寻址
   │  · 每 60s touch heartbeat/<sid>    → isAgentActive bridge fallback 判在线
   │  · 轮询自己 inbox（行数游标）      → SSE fan-out 给浏览器
   │  · 发消息 → 写目标 inbox + triggers（即时打断）
   ▼
~/.teyvat/SocialData/（teyvat social 管道）
   registry.json · heartbeat/<sid> · inbox/<sid>.jsonl · triggers/<sid>.json
   ▼
teyvat agents（dev-01 / support-01 / debug-01 / ...）
```

设计依据：`C.deploy/claude-code-bridge.py`（既有外部 bridge 范例）+ `B.docs/Dev.Common/Wiki/Cross-Framework(External Agent Bridge).WIKI`（外部 agent 接入清单 §4）。

## 已验证（2026-09-13 实测）

- ✅ **选 agent**：`GET /agents` → 6 个在线 + 65 个已注册；在线状态来自 `isAgentActive` 复刻判定（main.pid 心跳 / heartbeat fallback）
- ✅ **发消息**：`POST /send` → 写目标 agent 的 inbox + triggers → 对方**即时收到**（support-01 实测：被 interrupt 注入并回复）
- ✅ **收回复**：agent `social.send` 回 c0de0001 → registry 寻址 + heartbeat 在线判定通过 → 写入自己 inbox
- ✅ **对话重建**：`GET /messages?peer=<sid>` → 完整往返（我发的 + 收到的）
- ✅ **实时推送**：SSE `: connected` + 新消息立即 `data:` 帧

## 设计要点

- **SSE 而非 WebSocket**：零依赖（手写 WS 握手/帧解析太重）；`EventSource` 原生自动重连
- **行数游标读 inbox**：不重写文件——避免与 communicate.ts 的 append 竞态（bridge WIKI §6.2 教训）
- **heartbeat 而非伪造 main.pid**：走 bridge fallback 在线判定（WIKI §2.2 明确警告别伪造 pid）
- **零依赖**：仅 node 内置 `http` / `fs`，无需 `npm install`
- **发送直接写 inbox**：绕过 communicate.ts 的「对方必须在线」校验——demo 允许发给离线 agent（等它上线 drain）；前端用在线标记提示

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 前端页面（index.html） |
| GET | `/agents` | agent 列表（registry 全量 + online 标记，排除自己） |
| GET | `/messages?peer=<sid>` | 与该 peer 的对话（含收/发双向） |
| POST | `/send` | `{to, text, mode?}` → 投递（mode=interrupt 默认 / queue） |
| GET | `/events` | SSE 事件流 |

## 已知限制

- 单机（跨设备 social 投递尚未实现，与现有 social 语义一致）
- 无鉴权（本地 demo；默认监听 localhost）
- 群聊未做（仅单聊）
- 运行痕迹会留在 SocialData（demo 数据，无副作用）

## 退出

`Ctrl+C` → 清理 heartbeat（对方判离线）；registry 条目保留（下次启动覆盖）。
