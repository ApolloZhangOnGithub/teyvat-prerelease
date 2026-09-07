// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { Hono } from "hono";
import { stmt } from "./db.ts";
import type { AuthUser } from "./auth.ts";

const wsConnections = new Map<string, Set<any>>();

function wsKey(githubId: number, personId: string): string {
  return `${githubId}:${personId}`;
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
  }>();
  if (!toPerson || payload === undefined) {
    return c.json({ error: "toPerson and payload required" }, 400);
  }

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
      fromPerson: r.from_person,
      fromDevice: r.from_device,
      type: r.type,
      payload: JSON.parse(r.payload),
      ts: r.created_at,
    })),
  });
});
