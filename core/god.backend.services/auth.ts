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
    const deviceName = c.req.header("X-Device-Name");
    if (!auth?.startsWith("Bearer ") || !deviceId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const user = await resolveUser(auth.slice(7), deviceId, deviceName);
    if (!user) return c.json({ error: "invalid token" }, 401);
    // 设备名策略（2026-09-05）：带 X-Device-Name 时——若设备未命名(name=id 或不存在)用 hostname 注册；已有备注名只 touch 活跃不覆盖
    if (deviceName?.trim()) {
      const cur = stmt.getDeviceName.get(user.githubId, deviceId) as any;
      if (!cur || !cur.device_name || cur.device_name === deviceId) stmt.upsertDevice.run(deviceId, user.githubId, deviceName.trim());
      else stmt.touchDevice.run(user.githubId, deviceId);
    }
    c.set("user", user);
    await next();
  };
}

export const authRouter = new Hono();

// 设备上传 genshin 结果（POST body——header 限长/字符限制，2026-09-05 改）
authRouter.post("/device-state", async (c) => {
  const auth = c.req.header("Authorization");
  const deviceId = c.req.header("X-Device-Id");
  if (!auth?.startsWith("Bearer ") || !deviceId) return c.json({ error: "unauthorized" }, 401);
  const deviceName = c.req.header("X-Device-Name");
  const user = await resolveUser(auth.slice(7), deviceId, deviceName);
  if (!user) return c.json({ error: "invalid token" }, 401);
  const { agents } = await c.req.json<{ agents?: string }>().catch(() => ({}));
  if (typeof agents !== "string") return c.json({ error: "agents required" }, 400);
  stmt.upsertDeviceState.run(deviceId, user.githubId, JSON.stringify(agents), "");
  stmt.logSync.run(deviceId, user.githubId);
  stmt.pruneSyncLog.run(user.githubId, user.githubId);
  return c.json({ ok: true });
});

authRouter.get("/devices", async (c) => {
  const auth = c.req.header("Authorization");
  const deviceId = c.req.header("X-Device-Id");
  if (!auth?.startsWith("Bearer ") || !deviceId) return c.json({ error: "unauthorized" }, 401);
  // 自动更新：查询时带 X-Device-Name（真实 hostname）→ resolveUser 存 device_name（2026-09-05：设备名要自动真实非手动）
  const deviceName = c.req.header("X-Device-Name");
  const user = await resolveUser(auth.slice(7), deviceId, deviceName);
  if (!user) return c.json({ error: "invalid token" }, 401);
  // 活跃同步：设备带 X-Device-Agents（本机 genshin agent 清单）→ 存 device_states（2026-09-05：本地上传→拉取 0.3s）
  const agentsRaw = c.req.header("X-Device-Agents");
  if (agentsRaw && agentsRaw.length > 4 && agentsRaw.length < 20000) {
    try { JSON.parse(agentsRaw); stmt.upsertDeviceState.run(deviceId, user.githubId, agentsRaw, ""); stmt.logSync.run(deviceId, user.githubId); stmt.pruneSyncLog.run(user.githubId, user.githubId); } catch { /* 非法 JSON 忽略 */ }
  }
  const devices = stmt.listDevices.all(user.githubId);
  // 合并每设备的 genshin 状态（agents 清单 + 最后同步时间）
  const states = new Map((stmt.getDeviceStates.all(user.githubId) as any[]).map((s: any) => [s.device_id, s]));
  const out = devices.map((d: any) => {
    const st = states.get(d.device_id);
    return { ...d, agents: st ? JSON.parse(st.agents_json || "[]") : [], synced_at: st ? st.synced_at : null };
  });
  return c.json({ devices: out });
});

authRouter.put("/devices/:deviceId", async (c) => {
  const auth = c.req.header("Authorization");
  const deviceId = c.req.header("X-Device-Id");
  if (!auth?.startsWith("Bearer ") || !deviceId) return c.json({ error: "unauthorized" }, 401);
  const deviceName = c.req.header("X-Device-Name");
  const user = await resolveUser(auth.slice(7), deviceId, deviceName);
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
