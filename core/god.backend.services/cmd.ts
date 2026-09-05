// cmd.ts — 跨设备 genshin 命令执行通道（2026-09-05）
// 用途：`genshin d <目标设备> <genshin命令>` = 请求那台设备运行一次 genshin 命令 → 结果回 server → 请求方显示。
// 机制（不需要 SSH，走 server 通道 + 设备侧轮询）：
//   Mac 请求 ──POST /cmd/request──▶ server(device_cmds 表 pending)
//   设备执行器 ──GET /cmd/poll──▶ 拉到 pending → 本机执行 genshin 命令
//   设备执行器 ──POST /cmd/result──▶ 回报结果 → status=done
//   Mac ──GET /cmd/result/:id──▶ 取结果显示
// 挂在 authMiddleware 后（server.ts app.route("/cmd", cmdRouter)）——所有端点需 Authorization + X-Device-Id。
import { Hono } from "hono";
import { stmt } from "./db.ts";
import type { AuthUser } from "./auth.ts";

export const cmdRouter = new Hono();

// 请求方：请求某设备执行一条 genshin 命令（只能请求自己账号下的设备）；cmd 可空 = 设备跑 genshin 主列表（2026-09-05 用户定稿默认）
cmdRouter.post("/request", async (c) => {
  const user = c.get("user") as AuthUser;
  const { device_id, cmd } = await c.req.json<{ device_id?: string; cmd?: string }>().catch(() => ({}));
  if (!device_id) return c.json({ error: "device_id required" }, 400);
  const own = stmt.listDevices.all(user.githubId).some((d: any) => d.device_id === device_id);
  if (!own) return c.json({ error: "device not found in your account" }, 404);
  const info = stmt.requestCmd.run(user.githubId, device_id, String(cmd || ""));
  const id = Number(info.lastInsertRowid);
  return c.json({ ok: true, id });
});

// 设备执行器：拉自己 device_id 的待执行命令（一次一条 pending）
cmdRouter.get("/poll", async (c) => {
  const user = c.get("user") as AuthUser;
  const deviceId = c.req.header("X-Device-Id");
  if (!deviceId) return c.json({ error: "X-Device-Id required" }, 400);
  const row = stmt.pollPendingCmd.get(deviceId) as any;
  if (!row) return c.json({ ok: true, cmd: null });
  // claim → running（防多执行器重复拉）
  stmt.claimCmd.run(row.id);
  return c.json({ ok: true, cmd: { id: row.id, cmd: row.cmd } });
});

// 设备执行器：回报执行结果
cmdRouter.post("/result", async (c) => {
  const user = c.get("user") as AuthUser;
  const { cmd_id, ok, output } = await c.req.json<{ cmd_id?: number; ok?: boolean; output?: string }>().catch(() => ({}));
  if (!cmd_id) return c.json({ error: "cmd_id required" }, 400);
  const row = stmt.getCmd.get(cmd_id, user.githubId) as any;
  if (!row) return c.json({ error: "cmd not found" }, 404);
  stmt.completeCmd.run(ok ? "done" : "failed", String(output || ""), cmd_id);
  return c.json({ ok: true });
});

// 请求方：查命令结果（cmd_id 属于当前用户）
cmdRouter.get("/result/:id", async (c) => {
  const user = c.get("user") as AuthUser;
  const id = Number(c.req.param("id"));
  const row = stmt.getCmd.get(id, user.githubId) as any;
  if (!row) return c.json({ error: "cmd not found" }, 404);
  return c.json({ cmd: { id: row.id, device_id: row.device_id, cmd: row.cmd, status: row.status, result: row.result, created_at: row.created_at, updated_at: row.updated_at } });
});

// 请求方：我的命令历史
cmdRouter.get("/list", async (c) => {
  const user = c.get("user") as AuthUser;
  const rows = stmt.listMyCmds.all(user.githubId);
  return c.json({ cmds: rows });
});
