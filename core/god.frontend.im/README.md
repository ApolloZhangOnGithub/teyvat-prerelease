# god.frontend.im — IM 前端 + 使用说明

Web IM（微信式布局：左 agent 列表 + 右聊天 + 底部输入）。两种用法：

## 启动

```bash
genshin im --local   # 本机模式：起本机后端（god.backend.im，:8790）+ 开浏览器 localhost
genshin im           # 公网模式：自动打开公网网页（im.html，连公网 server）
```

环境变量：`IM_DEMO_SID`（默认 c0de0001）| `IM_DEMO_NAME`（默认 web-im-demo）| `IM_DEMO_PORT`（默认 8790）。

## 架构（2026-09-13 定稿）

- **前端**：`A.core/god.frontend.im/`（本目录）——index.html 本机版 / im.html 公网版
- **本机后端**：`god.backend.im/im.mjs`——`genshin im --local` 启动，读本机 SocialData + bridge 注册 + SSE
- **公网后端**：`A.core/god.backend.services/`（部署于阿里云 /opt/genshin-sync/）——auth/sync/messaging，im.html 直连
- **公网入口**：https://sync.paimon.beer/im/（nginx alias /opt/paimon-im/；Cloudflare 规则放行 /im/ 后生效）

```
【本机模式】浏览器(index.html) ──HTTP/SSE──> god.backend.im/im.mjs ──> ~/.teyvat/SocialData/ ──> teyvat agents
【公网模式】浏览器(im.html) ──HTTPS──> sync.paimon.beer（god.backend.services）──> 各设备 agent
```

设计依据：`C.deploy/claude-code-bridge.py`（外部 bridge 范例）+ `B.docs/Dev.Common/Wiki/Cross-Framework(External Agent Bridge).WIKI`。

## 本机后端机制（server.mjs）

- 注册 SocialData/registry.json（sid=c0de0001, name=web-im-demo）→ 可被 agent 寻址
- 每 60s touch heartbeat/<sid> → isAgentActive bridge fallback 判在线
- 轮询自己 inbox（行数游标，不重写文件）→ SSE 推给浏览器
- 浏览器发消息 → 追加目标 agent 的 inbox/<sid>.jsonl + 写 triggers/<sid>.json（即时打断）

## HTTP 接口（本机后端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 前端页面（god.frontend.im/index.html） |
| GET | `/agents` | agent 列表（registry 全量 + online 标记，排除自己） |
| GET | `/messages?peer=<sid>` | 与该 peer 的对话（收/发双向） |
| POST | `/send` | `{to, text, mode?}` → 投递（mode=interrupt 默认 / queue） |
| GET | `/events` | SSE 事件流 |
| GET | `/version` | 源码版本 vs 运行时版本（stale 提示重启） |

## 已知限制

- 本机模式单机（跨设备走公网模式）；无鉴权（默认 localhost）；群聊未做
- 运行痕迹留在 SocialData（bridge 数据，无副作用）

## 退出

后端进程 Ctrl+C → 清理 heartbeat；registry 条目保留（下次启动覆盖）。
