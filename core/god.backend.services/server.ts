// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { authRouter, authMiddleware, resolveUser } from "./auth.ts";
import { syncRouter } from "./sync.ts";
import { messagingRouter, registerWs, routeMessage } from "./messaging.ts";
import { cmdRouter } from "./cmd.ts";
import { stmt } from "./db.ts";

const app = new Hono();

app.use("*", cors());
app.route("/auth", authRouter);

app.use("/*", authMiddleware());
app.route("/sync", syncRouter);

app.use("/messages/*", authMiddleware());
app.route("/messages", messagingRouter);
app.route("/cmd", cmdRouter);

app.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

app.get("/auth/wiki-verify", async (c) => {
  const token = c.req.header("X-Paimon-Token") || c.req.query("token") || "";
  if (!token) return c.text("denied", 403);

  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "genshin-sync" },
  });
  if (!res.ok) return c.text("denied", 403);
  return c.text("ok", 200);
});

app.get("/auth/wiki-cookie", async (c) => {
  const token = c.req.query("token") || "";
  if (!token) return c.text("missing token", 403);

  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "genshin-sync" },
  });
  if (!res.ok) return c.text("invalid token", 403);

  c.header("Set-Cookie", `genshin_token=${token}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`);
  return c.redirect("/");
});

setInterval(() => {
  stmt.expireLocks.run();
  stmt.expireMessages.run();
}, 60_000);

const port = parseInt(process.env.PORT || "3456");

const httpServer = serve({ fetch: app.fetch, port });

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url!, `http://localhost:${port}`);
  const token = url.searchParams.get("token");
  const deviceId = url.searchParams.get("deviceId");
  const personId = url.searchParams.get("personId");

  if (!token || !deviceId || !personId) {
    ws.close(4001, "missing params");
    return;
  }

  const user = await resolveUser(token, deviceId);
  if (!user) { ws.close(4001, "unauthorized"); return; }

  const cleanup = registerWs(user.githubId, personId, ws);

  const pending = stmt.pullMessages.all(user.githubId, personId) as any[];
  for (const r of pending) {
    ws.send(JSON.stringify({
      fromPerson: r.from_person, fromDevice: r.from_device,
      type: r.type, payload: JSON.parse(r.payload), ts: r.created_at,
    }));
    stmt.markDelivered.run(r.id);
  }

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.to && msg.payload !== undefined) {
        const full = {
          fromPerson: personId,
          fromDevice: deviceId,
          ...msg,
          ts: new Date().toISOString(),
        };
        const delivered = routeMessage(user.githubId, msg.to, full);
        if (!delivered) {
          stmt.pushMessage.run(
            user.githubId, personId!, deviceId!, msg.to,
            msg.type || "text", JSON.stringify(msg.payload),
          );
        }
        ws.send(JSON.stringify({ ack: true, delivered }));
      }
    } catch (e) { console.error("[god.backend.services/server.ts] " + ((e as any)?.message || e)); }
  });

  ws.on("close", () => {
    cleanup();
  });
});

console.log(`genshin sync server listening on :${port}`);
