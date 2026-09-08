// god.backend.services/files.ts — 临时文件分享（ISSUE 142 网盘式，2026-09-08 用户定稿）
// 上传（鉴权）得 {url, password} → 24h 过期 + 自动随机密码 + 单文件 1MB 上限。
// 路由：POST /auth/files（经 authRouter——自行鉴权）；GET /files/<id>?key=（公开下载——注册在 authMiddleware 前）
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveUser } from "./auth.ts";
import { stmt } from "./db.ts";

export const SHARE_DIR = process.env.SYNC_SHARE_DIR || "/opt/genshin-sync/share";
export const MAX_SHARE_BYTES = 1024 * 1024; // 单文件上限 1MB（用户 01:27 定稿）
mkdirSync(SHARE_DIR, { recursive: true });

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const BASE_URL = `https://sync.paimon.beer`;

// ── 上传（POST /auth/files——鉴权 agent）──
// 请求: raw body（octet-stream）+ header X-File-Name（原始文件名）+ Content-Length ≤ 1MB
// 返回: { url, password, expires_at, filename, size }（password 自动随机——用户定稿）
export async function uploadFile(c: any): Promise<Response> {
  const auth = c.req.header("Authorization");
  const deviceId = c.req.header("X-Device-Id");
  const deviceName = c.req.header("X-Device-Name");
  if (!auth?.startsWith("Bearer ") || !deviceId) return c.json({ error: "unauthorized" }, 401);
  const user = await resolveUser(auth.slice(7), deviceId, deviceName);
  if (!user) return c.json({ error: "invalid token" }, 401);

  const filename = decodeURIComponent((c.req.header("X-File-Name") || "file")).replace(/[\\/:*?"<>|]/g, "_").slice(-120); // 2026-09-09：中文文件名支持——client 传 encodeURIComponent，这里 decode 还原
  const cl = parseInt(c.req.header("Content-Length") || "0", 10);
  if (cl > MAX_SHARE_BYTES) {
    return c.json({ error: `file too large (max ${MAX_SHARE_BYTES} bytes = 1MB)`, maxBytes: MAX_SHARE_BYTES }, 413);
  }
  const body = await c.req.arrayBuffer().catch(() => null);
  if (!body || body.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (body.byteLength > MAX_SHARE_BYTES) return c.json({ error: "file too large (max 1MB)" }, 413);

  const id = randomBytes(12).toString("hex");            // 下载路径 /files/<id>
  const password = randomBytes(9).toString("hex");       // 自动随机密码（18 hex）
  writeFileSync(join(SHARE_DIR, id), Buffer.from(body));
  stmt.insertShare.run(id, user.githubId, filename, body.byteLength, sha256(password));

  return c.json({
    url: `${BASE_URL}/files/${id}`,
    password,
    filename,
    size: body.byteLength,
    expires_in_hours: 24,
    note: "下载: curl '<url>?key=<password>' -o <filename>；24h 后过期",
  });
}

// ── 下载（GET /files/:id?key=——公开，key+过期校验）──
export async function downloadFile(c: any): Promise<Response> {
  const id = c.req.param("id") || "";
  if (!/^[a-f0-9]{24}$/.test(id)) return c.json({ error: "not found" }, 404);
  const row = stmt.getShare.get(id) as any;
  if (!row) return c.json({ error: "not found" }, 404);
  const key = (c.req.query("key") || "").toString();

  // 过期检查 + 懒清理
  if (Date.parse(row.expires_at.replace(" ", "T") + "Z") < Date.now()) {
    stmt.deleteShare.run(id);
    try { const { unlinkSync } = await import("node:fs"); if (existsSync(join(SHARE_DIR, id))) unlinkSync(join(SHARE_DIR, id)); } catch { /* 忽略 */ }
    return c.json({ error: "expired" }, 410);
  }
  // 密码校验（sha256）——2026-09-08：浏览器友好（无 key/错 key 返回 HTML 表单页，API 请求保持 JSON 403）
  if (!key || sha256(key) !== row.password_hash) {
    const accept = (c.req.header("Accept") || "") + " " + (c.req.header("User-Agent") || "");
    const isBrowser = /text\/html|Mozilla/i.test(accept) && !/curl|fetch|node|genshin/i.test(accept);
    if (isBrowser) {
      const ok = !key ? "" : "";
      const errMsg = key ? "密码错误，请重试" : "此文件受密码保护";
      const fname = (row.filename || "file").replace(/[<>&"]/g, "");
      const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>teyvat 文件下载</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#f5f6f8;margin:0;padding:0">
<div style="max-width:440px;margin:80px auto;background:#fff;border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.08);padding:32px">
<h2 style="margin:0 0 6px;font-size:18px">📎 ${fname}</h2>
<p style="color:#888;margin:0 0 20px;font-size:13px">${row.size || 0} bytes · 分享后 24 小时过期</p>
<div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px">🔒 ${errMsg}——请输入访问密码</div>
<form method="get" action="/files/${id}">
<input type="password" name="key" required placeholder="访问密码" autofocus style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d0d5dd;border-radius:8px;font-size:15px;margin-bottom:12px">
<button type="submit" style="width:100%;box-sizing:border-box;padding:12px;background:#1a56db;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer">下载文件</button>
</form>
</div></body></html>`;
      return c.html(html);
    }
    return c.json({ error: "forbidden" }, 403);
  }

  const fp = join(SHARE_DIR, id);
  if (!existsSync(fp)) { stmt.deleteShare.run(id); return c.json({ error: "gone" }, 404); }
  const data = readFileSync(fp);
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", `attachment; filename="${encodeURIComponent(row.filename || "file")}"`);
  return c.body(data);
}

// ── 过期清理（server.ts 60s interval 调——db 权威，磁盘懒清理已覆盖下载路径）──
export function cleanupExpiredShares(): void {
  try { stmt.cleanupExpiredShares.run(); } catch (e) { console.error("[god.backend.services/files.ts] " + ((e as any)?.message || e)); }
}
