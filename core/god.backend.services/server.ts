// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { authRouter, authMiddleware, resolveUser } from "./auth.ts";
import { syncRouter } from "./sync.ts";
import { messagingRouter, registerWs, routeMessage } from "./messaging.ts";
import { stmt } from "./db.ts";
import { uploadFile, downloadFile, cleanupExpiredShares } from "./files.ts";

const app = new Hono();

app.use("*", cors());
// 2026-09-13（审计）：请求体上限——@hono/node-server 默认无限制，任何 GitHub 账号都能把内存/磁盘灌满。/sync/push 保留 20MB（多文件 multipart），其余 2MB。
const _pushLimit = bodyLimit({ maxSize: 20 * 1024 * 1024 });
const _defaultLimit = bodyLimit({ maxSize: 2 * 1024 * 1024 });
// 2026-09-22（ISSUE 142）：/auth/files 单独放宽——单文件上传上限由 /a max-upload-size 授权
// （默认 1MB、硬顶 30MB），服务端按硬顶+余量放行（真正把关在客户端 webacts + files.ts 的 MAX_SHARE_BYTES）。
const _uploadLimit = bodyLimit({ maxSize: 32 * 1024 * 1024 });
// 2026-09-14：两条 use 都会命中 /sync/push，第二条 2MB 生效 → 20MB 形同虚设；按路径二选一
app.use("*", (c, next) => (c.req.path === "/sync/push" ? _pushLimit(c, next) : c.req.path === "/auth/files" ? _uploadLimit(c, next) : _defaultLimit(c, next)));

// 2026-09-13（审计，线上实证 GET /health → 401）：这三条公开路由必须注册在 authMiddleware 之前——Hono 按注册顺序匹配，
// 之前排在 app.use("/*", authMiddleware()) 之后，bootstrap.sh 的 curl /health 每次都失败、本地隧道探测永远探不到、wiki auth_request 永远 denied。
app.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

const TOKEN_RE = /^[A-Za-z0-9_\-]{10,255}$/;
app.get("/auth/wiki-verify", async (c) => {
  const token = c.req.header("X-Paimon-Token") || c.req.query("token") || "";
  if (!token || !TOKEN_RE.test(token)) return c.text("denied", 403);
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "genshin-sync" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return c.text("denied", 403);
  return c.text("ok", 200);
});

// 临时文件分享（2026-09-08 ISSUE 142）：上传挂 authRouter（自行鉴权——必须在 app.route("/auth") 前注册才生效）；下载公开（authMiddleware 前）
authRouter.post("/files", uploadFile);
app.get("/files/:id", downloadFile);

// 2026-09-13（IM 公网版）：IM 前端静态托管（公开，放在 authMiddleware 之前）。
// 背景：CF 边缘直连本机源站的 TLS 握手不通（paimon.beer / wiki 均为 525），但本域经 Cloudflare Tunnel 可达，
// 所以公网 IM 页面由本服务直接吐出（https://sync.paimon.beer/im/）；paimon.beer/im/ 由 Worker 反代到本域。
const IM_STATIC_DIR = process.env.IM_STATIC_DIR || "/opt/paimon-im";
const IM_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon",
};
app.get("/im", (c) => c.redirect("/im/"));
app.get("/im/", (c) => {
  const f = join(IM_STATIC_DIR, "index.html");
  if (!existsSync(f)) return c.text("IM frontend not deployed", 404);
  return c.html(readFileSync(f, "utf8"));
});
app.get("/im/:file", (c) => {
  const name = (c.req.param("file") || "").replace(/[^A-Za-z0-9._-]/g, "");   // 防目录穿越
  const f = join(IM_STATIC_DIR, name);
  if (!name || !existsSync(f)) return c.text("not found", 404);
  const ext = (name.split(".").pop() || "").toLowerCase();
  return c.body(readFileSync(f), 200, { "Content-Type": IM_MIME[ext] || "application/octet-stream" });
});

app.route("/auth", authRouter);

app.use("/*", authMiddleware());
app.route("/sync", syncRouter);

app.use("/messages/*", authMiddleware());
app.route("/messages", messagingRouter);

// （/health 与 /auth/wiki-verify 已上移到 authMiddleware 之前；/auth/wiki-cookie 删除——把 GitHub token 放进 URL 与 cookie，且没有任何读者。）

setInterval(() => {
  stmt.expireLocks.run();
  stmt.expireMessages.run();
  cleanupExpiredShares();
}, 60_000);

const port = parseInt(process.env.PORT || "3456");

const httpServer = serve({ fetch: app.fetch, port });

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  // 只接受根路径的升级；其余直接断开
  let pathname = "/";
  try { pathname = new URL(req.url || "/", `http://localhost:${port}`).pathname; } catch { /* 非法 URL → 断开 */ }
  if (pathname !== "/" && pathname !== "/ws") { try { socket.destroy(); } catch { /* 已断 */ } return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

const ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
// 2026-09-13（审计 HIGH）：connection 回调是 async 且无人 catch——token 含 >255 的字符时 fetch 同步抛 TypeError（ByteString），
// 或 api.github.com 瞬时网络错误，都变成 unhandledRejection → 进程退出（任何人一条 wss://…/?token=%E4%BD%A0 就能打挂服务）。
wss.on("connection", async (ws, req) => {
  ws.on("error", (e: any) => console.error("[god.backend.services/server.ts] ws error: " + (e?.message || e)));
  try {
    await handleWsConnection(ws, req);
  } catch (e: any) {
    console.error("[god.backend.services/server.ts] ws handshake failed: " + (e?.message || e));
    try { ws.close(1011, "internal error"); } catch { /* 已关 */ }
  }
});

async function handleWsConnection(ws: any, req: any) {
  const url = new URL(req.url!, `http://localhost:${port}`);
  const token = url.searchParams.get("token");
  const deviceId = url.searchParams.get("deviceId");
  const personId = url.searchParams.get("personId");

  if (!token || !deviceId || !personId || !TOKEN_RE.test(token) || !ID_RE.test(deviceId) || !ID_RE.test(personId)) {
    ws.close(4001, "missing or invalid params");
    return;
  }

  const user = await resolveUser(token, deviceId);
  if (!user) { ws.close(4001, "unauthorized"); return; }

  const cleanup = registerWs(user.githubId, personId, ws);

  const pending = stmt.pullMessages.all(user.githubId, personId) as any[];
  for (const r of pending) {
    ws.send(JSON.stringify({
      id: r.id, fromPerson: r.from_person, fromDevice: r.from_device,
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
        // 与 messaging.ts 一致：总是先落库，WS 推送只做即时通知（假活/离线靠 /messages/pending 拉取兜底）
        stmt.pushMessage.run(
          user.githubId, personId!, deviceId!, msg.to,
          msg.type || "text", JSON.stringify(msg.payload),
        );
        const delivered = routeMessage(user.githubId, msg.to, full);
        ws.send(JSON.stringify({ ack: true, delivered }));
      }
    } catch (e) { console.error("[god.backend.services/server.ts] " + ((e as any)?.message || e)); }
  });

  ws.on("close", () => {
    cleanup();
  });
}

console.log(`genshin sync server listening on :${port}`);
