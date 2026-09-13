// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { Hono } from "hono";
import { createRequire } from "node:module";
import { stmt } from "./db.ts";

// 2026-09-13：GitHub OAuth 需访问 github.com（国内直连 10s 超时；api.github.com 部分可达）。
// Node 原生 fetch（undici）不读 GITHUB_PROXY 环境变量，必须显式设置全局 dispatcher。
// ⚠️ 不能用 top-level await——tsx 以 CJS 加载时抛 ERR_REQUIRE_ASYNC_MODULE（2026-09-13 线上实证导致服务起不来）；改用 createRequire 同步加载。
if (process.env.GITHUB_PROXY) {
  try {
    const undici = createRequire(import.meta.url)("undici");
    undici.setGlobalDispatcher(new undici.ProxyAgent(process.env.GITHUB_PROXY));
    console.log("[auth] using GITHUB_PROXY=" + process.env.GITHUB_PROXY);
  } catch (e) {
    console.error("[auth] GITHUB_PROXY setup failed (继续直连): " + ((e as any)?.message || e));
  }
}

// 2026-09-13：GitHub OAuth 请求重试（alice 实测：单次成功率仅 ~50%——GFW 对 github.com 概率性 SYN 丢包；
// 失败发生在 TCP 连接阶段（请求未达 GitHub）→ authorization code 未被消耗，**可安全重试**。
// 短超时（4s）+ 重试 4 次 + 短退避 → 成功率 50% → ~94%；不要用手动 --resolve 固定其他 GitHub IP（实测全不通，必须默认 DNS）。
async function fetchWithRetry(url: string, init: RequestInit, opts: { attempts?: number; timeoutMs?: number } = {}): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const delays = [200, 500, 1000, 1500];
  let lastErr: any = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
    }
  }
  throw lastErr;
}

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";

export interface AuthUser {
  githubId: number;
  login: string;
  avatarUrl: string;
  deviceId: string;
}

// 2026-09-13（审计）：① 缓存带 TTL（10 分钟）+ 容量上限——原来命中过的 token 到进程重启前都有效，GitHub 侧撤销毫无作用；
// ② 401 的 token 负缓存 60s——原来每个非法 Bearer 都打一次 api.github.com；③ token/deviceId 先做字符校验——
// 含 >255 字符的值放进 fetch header 会同步抛 TypeError；④ 缓存 miss 时不再覆盖设备备注名（原 upsertDevice 每次都 SET device_name）。
const TOKEN_RE = /^[A-Za-z0-9_\-]{10,255}$/;
const ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
const CACHE_TTL_MS = 10 * 60 * 1000;
const NEG_TTL_MS = 60 * 1000;
const CACHE_MAX = 5000;
const tokenCache = new Map<string, { user: AuthUser; at: number }>();
const negCache = new Map<string, number>();

function _evict<K, V>(m: Map<K, V>, max: number) { while (m.size > max) { const k = m.keys().next().value as K; m.delete(k); } }

export async function resolveUser(token: string, deviceId: string, deviceName?: string): Promise<AuthUser | null> {
  if (!TOKEN_RE.test(token) || !ID_RE.test(deviceId)) return null;
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    if (cached.user.deviceId === deviceId) return cached.user;
    // 同一 token 换设备：用户信息可复用，只补设备行
    const user: AuthUser = { ...cached.user, deviceId };
    stmt.insertDeviceIfMissing.run(deviceId, user.githubId, deviceName?.trim() || deviceId);
    tokenCache.set(token, { user, at: cached.at });
    return user;
  }
  const neg = negCache.get(token);
  if (neg && now - neg < NEG_TTL_MS) return null;

  let res: Response | null = null;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "genshin-sync" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { return null; }
  if (!res.ok) { negCache.set(token, now); _evict(negCache, CACHE_MAX); return null; }

  const gh = (await res.json()) as { id: number; login: string; avatar_url: string };
  const user: AuthUser = { githubId: gh.id, login: gh.login, avatarUrl: gh.avatar_url, deviceId };

  stmt.upsertUser.run(gh.id, gh.login, gh.avatar_url);
  // device_name 优先用 client 上报的 hostname（X-Device-Name），无则回落 deviceId（2026-09-05：设备要可识别名称）；已有行只 touch，不覆盖备注名
  stmt.insertDeviceIfMissing.run(deviceId, gh.id, deviceName?.trim() || deviceId);
  tokenCache.set(token, { user, at: now });
  _evict(tokenCache, CACHE_MAX);
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
    // 2026-09-07（Bug2 真因：X-Device-Agents 只在 /auth/devices handler 读——client 45s 上报 POST /sync/agent-presence 带 header 没人处理 → synced_at 永不刷）。
    // authMiddleware 是所有 /sync/* 请求前置——任一请求带 X-Device-Agents 即 upsert device_states（agent 清单 + synced_at=now），周期上报自然刷新。
    const agentsRaw = c.req.header("X-Device-Agents");
    if (agentsRaw && agentsRaw.length > 4 && agentsRaw.length < 20000) {
      try { JSON.parse(agentsRaw); stmt.upsertDeviceState.run(deviceId, user.githubId, agentsRaw, ""); stmt.logSync.run(deviceId, user.githubId); stmt.pruneSyncLog.run(user.githubId, user.githubId); } catch (e) { console.error("[god.backend.services/auth.ts] " + ((e as any)?.message || e)); /* 非法 JSON 忽略 */ }
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
  if (agents.length > 20000) return c.json({ error: "agents too large (max 20000)" }, 413); // 与 header 路径同上限
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
    try { JSON.parse(agentsRaw); stmt.upsertDeviceState.run(deviceId, user.githubId, agentsRaw, ""); stmt.logSync.run(deviceId, user.githubId); stmt.pruneSyncLog.run(user.githubId, user.githubId); } catch (e) { console.error("[god.backend.services/auth.ts] " + ((e as any)?.message || e)); /* 非法 JSON 忽略 */ }
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
  const tokenRes = await fetchWithRetry("https://github.com/login/oauth/access_token", {
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
  const res = await fetchWithRetry("https://github.com/login/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
  });
  return c.json(await res.json());
});

authRouter.post("/device-flow/poll", async (c) => {
  const { device_code } = await c.req.json<{ device_code: string }>();
  const res = await fetchWithRetry("https://github.com/login/oauth/access_token", {
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
