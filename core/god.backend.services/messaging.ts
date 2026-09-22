// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { Hono } from "hono";
import { stmt } from "./db.ts";
import type { AuthUser } from "./auth.ts";

const wsConnections = new Map<string, Set<any>>();

function wsKey(githubId: number, personId: string): string {
  return `${githubId}:${personId}`;
}

// 2026-09-22（ISSUE 150 剩余项：WS 假活连接治理）：
// `routeMessage` 对**死连接**调 `ws.send()` 不会立刻报错（TCP 要等到超时才暴露）→ 连接表里会积累"假活"条目：
// 既占内存，又让 routeMessage 误判"已即时推送"（150 的主修复已改成**总是落库**，所以不影响送达——这里是治本）。
//
// 做法（**保守**）：每 30s 扫一遍——readyState 已非 OPEN 的直接摘掉；同时发一个 ping 促使死链路尽快"爆"而触发 close 回调。
// **不因"没收到 pong"就 terminate**：Bun 的 ServerWebSocket 与 Node 的 ws 对 pong 事件支持不一致，
// 误判会一口气踢掉所有正常连接（比假活更糟）。宁可不治也不误伤。
const WS_HEARTBEAT_MS = 30_000;
let _wsHeartbeat: any = null;
function _ensureWsHeartbeat() {
  if (_wsHeartbeat) return;
  _wsHeartbeat = setInterval(() => {
    for (const [k, conns] of wsConnections) {
      for (const ws of conns) {
        if (ws?.readyState !== undefined && ws.readyState !== 1) { conns.delete(ws); continue; }
        try { ws.ping?.(); } catch { conns.delete(ws); }
      }
      if (conns.size === 0) wsConnections.delete(k);
    }
  }, WS_HEARTBEAT_MS);
  _wsHeartbeat.unref?.(); // 不阻止进程退出（服务/测试均可）
}

export function broadcastToUser(githubId: number, msg: any) {
  const payload = JSON.stringify(msg);
  for (const [key, conns] of wsConnections) {
    if (key.startsWith(`${githubId}:`)) {
      for (const ws of conns) {
        try { ws.send(payload); } catch (e) { console.error("[god.backend.services/messaging.ts] " + ((e as any)?.message || e)); }
      }
    }
  }
}

export function routeMessage(githubId: number, toPerson: string, msg: any) {
  const key = wsKey(githubId, toPerson);
  const conns = wsConnections.get(key);
  if (conns?.size) {
    const payload = JSON.stringify(msg);
    for (const ws of conns) {
      try { ws.send(payload); } catch (e) { console.error("[god.backend.services/messaging.ts] " + ((e as any)?.message || e)); }
    }
    return true;
  }
  return false;
}

export function registerWs(githubId: number, personId: string, ws: any) {
  const key = wsKey(githubId, personId);
  if (!wsConnections.has(key)) wsConnections.set(key, new Set());
  wsConnections.get(key)!.add(ws);
  _ensureWsHeartbeat(); // 2026-09-22（ISSUE 150）：惰性启动心跳（首个连接注册时起，unref 不阻进程退出）
  return () => {
    wsConnections.get(key)?.delete(ws);
    if (wsConnections.get(key)?.size === 0) wsConnections.delete(key);
  };
}

export const messagingRouter = new Hono();

messagingRouter.post("/send", async (c) => {
  const user = c.get("user") as AuthUser;
  const { toPerson, type, payload } = await c.req.json<{
    toPerson: string; type?: string; payload: any;
  }>().catch(() => ({} as any));
  if (!toPerson || payload === undefined) {
    return c.json({ error: "toPerson and payload required" }, 400);
  }
  if (typeof toPerson !== "string" || toPerson.length > 64) return c.json({ error: "bad toPerson" }, 400);

  const msg = {
    fromPerson: user.deviceId,
    fromDevice: user.deviceId,
    toPerson,
    type: type || "text",
    payload,
    ts: new Date().toISOString(),
  };

  // 2026-09-08（WS 假活丢消息修复——testor 实证：02:52/53 消息没收到直到 interrupt；messages 表 18:57 后全空 = 全走 WS 推送 delivered true 不落库，WS 死连接假活则消息丢失）：
  // 总是落库（pending）——WS 推送只作即时通知（真活时秒达）；收件人 WS 假活/离线时靠周期拉取（/messages/pending）兜底，client 按 msg id 去重，消息永不丢。
  stmt.pushMessage.run(
    user.githubId, msg.fromPerson, msg.fromDevice, toPerson,
    msg.type, JSON.stringify(payload),
  );
  const delivered = routeMessage(user.githubId, toPerson, msg);
  return c.json({ ok: true, delivered });
});

messagingRouter.get("/pending/:personId", (c) => {
  const user = c.get("user") as AuthUser;
  const personId = c.req.param("personId");
  const rows = stmt.pullMessages.all(user.githubId, personId) as any[];
  for (const r of rows) stmt.markDelivered.run(r.id);
  return c.json({
    messages: rows.map((r) => ({
      id: r.id, // 2026-09-13：带 id——注释一直说"client 按 msg id 去重"，回包却没有 id
      fromPerson: r.from_person,
      fromDevice: r.from_device,
      type: r.type,
      payload: JSON.parse(r.payload),
      ts: r.created_at,
    })),
  });
});

// 历史消息（2026-09-13 IM）：全量历史（含已投递），前端据此重建会话与聊天记录（消息不再“丢”）。
// 返回顺序 id 降序（最新在前），前端自行按 payload.from/to 归会话。
function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return { text: s }; }
}
messagingRouter.get("/history", (c) => {
  const user = c.get("user") as AuthUser;
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "500", 10) || 500, 1), 2000);
  const sid = (c.req.query("sid") || "").toString().trim();
  // 带 sid → 只返回该 sid ↔ 各 agent 的消息（排除 agent↔agent 跨设备消息，大幅减小体积）
  const rows = sid
    ? (stmt.listPeerMessages.all(user.githubId, sid, sid, limit) as any[])
    : (stmt.listAllMessages.all(user.githubId, limit) as any[]);
  return c.json({
    messages: rows.map((r) => ({
      id: r.id, from_person: r.from_person, to_person: r.to_person,
      type: r.type, payload: safeParse(r.payload), ts: r.created_at,
    })),
  });
});

// 收藏（2026-09-14：跨设备同步，替代前端 localStorage）
messagingRouter.get("/favorites", (c) => {
  const user = c.get("user") as AuthUser;
  const rows = stmt.listFavorites.all(user.githubId) as any[];
  return c.json({ favorites: rows.map((r) => ({ id: r.id, text: r.text, from: r.from_name, ts: r.ts })) });
});
messagingRouter.post("/favorites", async (c) => {
  const user = c.get("user") as AuthUser;
  const body = (await c.req.json().catch(() => ({}))) as { text?: string; from_name?: string; ts?: number };
  if (!body.text) return c.json({ error: "text required" }, 400);
  stmt.addFavorite.run(user.githubId, String(body.text).slice(0, 2000), body.from_name || "我", body.ts || Date.now());
  return c.json({ ok: true });
});
messagingRouter.delete("/favorites", (c) => {
  const user = c.get("user") as AuthUser;
  const ts = parseInt(c.req.query("ts") || "0", 10);
  if (ts) stmt.deleteFavorite.run(user.githubId, ts);
  return c.json({ ok: true });
});
