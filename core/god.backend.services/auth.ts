// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { Hono } from "hono";
import { stmt } from "./db.ts";

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";

export interface AuthUser {
  githubId: number;
  login: string;
  avatarUrl: string;
  deviceId: string;
}

const tokenCache = new Map<string, AuthUser>();

export async function resolveUser(token: string, deviceId: string, deviceName?: string): Promise<AuthUser | null> {
  const cached = tokenCache.get(token);
  if (cached && cached.deviceId === deviceId) return cached;

  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "genshin-sync" },
  });
  if (!res.ok) return null;

  const gh = (await res.json()) as { id: number; login: string; avatar_url: string };
  const user: AuthUser = { githubId: gh.id, login: gh.login, avatarUrl: gh.avatar_url, deviceId };

  stmt.upsertUser.run(gh.id, gh.login, gh.avatar_url);
  // device_name 优先用 client 上报的 hostname（X-Device-Name），无则回落 deviceId（2026-09-05：设备要可识别名称）
  stmt.upsertDevice.run(deviceId, gh.id, deviceName?.trim() || deviceId);
  tokenCache.set(token, user);
  return user;
}

export function authMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const auth = c.req.header("Authorization");
    const deviceId = c.req.header("X-Device-Id");
    if (!auth?.startsWith("Bearer ") || !deviceId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const user = await resolveUser(auth.slice(7), deviceId);
    if (!user) return c.json({ error: "invalid token" }, 401);
    c.set("user", user);
    await next();
  };
}

export const authRouter = new Hono();

authRouter.get("/devices", async (c) => {
  const auth = c.req.header("Authorization");
  const deviceId = c.req.header("X-Device-Id");
  if (!auth?.startsWith("Bearer ") || !deviceId) return c.json({ error: "unauthorized" }, 401);
  const user = await resolveUser(auth.slice(7), deviceId);
  if (!user) return c.json({ error: "invalid token" }, 401);
  const devices = stmt.listDevices.all(user.githubId);
  return c.json({ devices });
});

authRouter.put("/devices/:deviceId", async (c) => {
  const auth = c.req.header("Authorization");
  const deviceId = c.req.header("X-Device-Id");
  if (!auth?.startsWith("Bearer ") || !deviceId) return c.json({ error: "unauthorized" }, 401);
  const user = await resolveUser(auth.slice(7), deviceId);
  if (!user) return c.json({ error: "invalid token" }, 401);
  const target = c.req.param("deviceId");
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name || "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  // 只允许改自己账号下的设备
  const owned = stmt.listDevices.all(user.githubId).some((d: any) => d.device_id === target);
  if (!owned) return c.json({ error: "device not found" }, 404);
  stmt.renameDevice.run(name, user.githubId, target);
  return c.json({ ok: true });
});

authRouter.post("/github", async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  if (!code) return c.json({ error: "code required" }, 400);
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.json({ error: tokenData.error || "token exchange failed" }, 400);
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "genshin-sync" },
  });
  if (!userRes.ok) return c.json({ error: "github user fetch failed" }, 400);

  const gh = (await userRes.json()) as { id: number; login: string; avatar_url: string };
  stmt.upsertUser.run(gh.id, gh.login, gh.avatar_url);

  return c.json({
    token: tokenData.access_token,
    user: { githubId: gh.id, login: gh.login, avatarUrl: gh.avatar_url },
  });
});

authRouter.post("/device-flow/start", async (c) => {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
  });
  return c.json(await res.json());
});

authRouter.post("/device-flow/poll", async (c) => {
  const { device_code } = await c.req.json<{ device_code: string }>();
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  const data = (await res.json()) as { access_token?: string; error?: string; interval?: number };
  if (data.access_token) {
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${data.access_token}`, "User-Agent": "genshin-sync" },
    });
    const gh = (await userRes.json()) as { id: number; login: string; avatar_url: string };
    stmt.upsertUser.run(gh.id, gh.login, gh.avatar_url);
    return c.json({
      token: data.access_token,
      user: { githubId: gh.id, login: gh.login, avatarUrl: gh.avatar_url },
    });
  }
  return c.json(data);
});
