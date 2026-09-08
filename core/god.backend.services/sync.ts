// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { stmt } from "./db.ts";
import type { AuthUser } from "./auth.ts";
import { broadcastToUser } from "./messaging.ts";

const STORAGE_DIR = process.env.SYNC_STORAGE_DIR || "./storage";

function storagePath(githubId: number, filePath: string): string {
  return join(STORAGE_DIR, String(githubId), filePath);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export const syncRouter = new Hono();

syncRouter.get("/manifest", (c) => {
  const user = c.get("user") as AuthUser;
  const rows = stmt.getManifest.all(user.githubId) as Array<{
    path: string; hash: string; size: number; version: number; updated_at: string;
  }>;
  const files: Record<string, { hash: string; size: number; version: number; updatedAt: string }> = {};
  for (const r of rows) {
    files[r.path] = { hash: r.hash, size: r.size, version: r.version, updatedAt: r.updated_at };
  }
  return c.json({ files });
});

syncRouter.post("/push", async (c) => {
  const user = c.get("user") as AuthUser;
  const contentType = c.req.header("content-type") || "";

  stmt.expireLocks.run();

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const results: Array<{ path: string; version: number; ok: boolean; error?: string }> = [];

    // 收集涉及的所有 agent ID，检查是否被其他设备锁定
    const agentIds=new Set<string>();
    for(const [filePath] of form.entries()){
      const m=filePath.match(/^(MemoryData|SessionData|IdentityData|AppData|MemoirData)\/([a-f0-9]{8})\//);
      if(m) agentIds.add(m[2]);
    }
    const lockedByOthers:Record<string,string>={};
    for(const aid of agentIds){
      const existing=stmt.getLock.get(user.githubId,aid) as any;
      if(existing && existing.device_id!==user.deviceId){
        const hb=new Date(existing.heartbeat+"Z").getTime();
        if(Date.now()-hb<5*60*1000){ lockedByOthers[aid]=existing.device_id }
      }
    }

    for (const [filePath, value] of form.entries()) {
      if (typeof value === "string") continue;
      const m=filePath.match(/^(MemoryData|SessionData|IdentityData|AppData|MemoirData)\/([a-f0-9]{8})\//);
      const aid=m?m[2]:null;
      if(aid && lockedByOthers[aid]){
        results.push({ path: filePath, version: 0, ok: false, error: `locked by device ${lockedByOthers[aid]}` });
        continue;
      }
      const file = value as File;
      const buf = Buffer.from(await file.arrayBuffer());
      const hash = sha256(buf);
      const dst = storagePath(user.githubId, filePath);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, buf);
      stmt.upsertFile.run(user.githubId, filePath, hash, buf.length);
      const row = stmt.getManifest.all(user.githubId).find((r: any) => r.path === filePath) as any;
      results.push({ path: filePath, version: row?.version || 1, ok: true });
    }

    return c.json({ results });
  }

  const { path: filePath, content } = await c.req.json<{ path: string; content: string }>();
  if (!filePath || content === undefined) return c.json({ error: "path and content required" }, 400);

  // 检查该文件所属 agent 是否被其他设备锁定
  const m=filePath.match(/^(MemoryData|SessionData|IdentityData|AppData|MemoirData)\/([a-f0-9]{8})\//);
  if(m){
    const existing=stmt.getLock.get(user.githubId,m[2]) as any;
    if(existing && existing.device_id!==user.deviceId){
      const hb=new Date(existing.heartbeat+"Z").getTime();
      if(Date.now()-hb<5*60*1000){
        return c.json({ error: `locked by device ${existing.device_id}` }, 409);
      }
    }
  }

  const buf = Buffer.from(content, "base64");
  const hash = sha256(buf);
  const dst = storagePath(user.githubId, filePath);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, buf);
  stmt.upsertFile.run(user.githubId, filePath, hash, buf.length);

  const row = stmt.getManifest.all(user.githubId).find((r: any) => r.path === filePath) as any;
  return c.json({ path: filePath, version: row?.version || 1, hash, ok: true });
});

syncRouter.post("/pull", async (c) => {
  const user = c.get("user") as AuthUser;
  const { paths } = await c.req.json<{ paths: string[] }>();
  if (!paths?.length) return c.json({ error: "paths required" }, 400);

  const results: Array<{ path: string; content: string; hash: string; size: number } | { path: string; error: string }> = [];
  for (const p of paths) {
    const fp = storagePath(user.githubId, p);
    if (!existsSync(fp)) {
      results.push({ path: p, error: "not found" });
      continue;
    }
    const buf = readFileSync(fp);
    results.push({ path: p, content: buf.toString("base64"), hash: sha256(buf), size: buf.length });
  }
  return c.json({ results });
});

function broadcastPresence(githubId: number) {
  const locks = stmt.getAllLocks.all(githubId) as any[];
  broadcastToUser(githubId, {
    type: "presence",
    devices: locks.map((l: any) => ({
      personId: l.person_id,
      deviceId: l.device_id,
      since: l.acquired_at,
    })),
  });
}

syncRouter.get("/presence", (c) => {
  const user = c.get("user") as AuthUser;
  stmt.expireLocks.run();
  const locks = stmt.getAllLocks.all(user.githubId) as any[];
  return c.json({
    devices: locks.map((l: any) => ({
      personId: l.person_id,
      deviceId: l.device_id,
      since: l.acquired_at,
      heartbeat: l.heartbeat,
    })),
  });
});

// ── agent presence（AgentTableSync 2026-09-05：跨设备 agent 索引表）──
syncRouter.post("/agent-presence", async (c) => {
  const user = c.get("user") as AuthUser;
  try {
    const b = await c.req.json();
    const { sid, name, focus, version, model } = b || {};
    if (!sid || typeof sid !== "string") return c.json({ error: "sid required" }, 400);
    stmt.upsertPresence.run(user.githubId, sid, name || "", focus || "off", version || "", model || "", user.deviceId);
    return c.json({ ok: true });
  } catch (e) { console.error("[god.backend.services/sync.ts] " + ((e as any)?.message || e)); return c.json({ error: "bad json" }, 400); }
});

syncRouter.get("/agent-presence", (c) => {
  const user = c.get("user") as AuthUser;
  stmt.expirePresence.run();
  const rows = stmt.queryPresence.all(user.githubId) as any[];
  return c.json({ agents: rows });
});

syncRouter.delete("/agent-presence/:sid", (c) => {
  const user = c.get("user") as AuthUser;
  stmt.clearPresence.run(user.githubId, c.req.param("sid"));
  return c.json({ ok: true });
});

syncRouter.post("/lock/:personId", (c) => {
  const user = c.get("user") as AuthUser;
  const personId = c.req.param("personId");

  stmt.expireLocks.run();

  const existing = stmt.getLock.get(user.githubId, personId) as any;
  if (existing && existing.device_id !== user.deviceId) {
    const hb = new Date(existing.heartbeat + "Z").getTime();
    if (Date.now() - hb < 5 * 60 * 1000) {
      return c.json({
        error: "locked",
        holder: { deviceId: existing.device_id, since: existing.acquired_at },
      }, 409);
    }
  }

  stmt.acquireLock.run(user.githubId, personId, user.deviceId);
  const lock = stmt.getLock.get(user.githubId, personId) as any;
  if (lock && lock.device_id !== user.deviceId) {
    return c.json({
      error: "locked",
      holder: { deviceId: lock.device_id, since: lock.acquired_at },
    }, 409);
  }
  broadcastPresence(user.githubId);
  return c.json({ ok: true, personId });
});

syncRouter.post("/lock/:personId/heartbeat", (c) => {
  const user = c.get("user") as AuthUser;
  const personId = c.req.param("personId");
  stmt.heartbeatLock.run(user.githubId, personId, user.deviceId);
  const hbLock = stmt.getLock.get(user.githubId, personId) as any;
  if (!hbLock || hbLock.device_id !== user.deviceId) return c.json({ error: "lock not held" }, 404);
  broadcastPresence(user.githubId);
  return c.json({ ok: true });
});

syncRouter.delete("/lock/:personId", (c) => {
  const user = c.get("user") as AuthUser;
  const personId = c.req.param("personId");
  stmt.releaseLock.run(user.githubId, personId, user.deviceId);
  broadcastPresence(user.githubId);
  return c.json({ ok: true });
});

// 批量查询锁状态：客户端 push 前检查哪些 agent 被其他设备锁定
syncRouter.post("/locks/batch", async (c) => {
  const user = c.get("user") as AuthUser;
  const { agentIds } = await c.req.json() as any || {};
  if(!Array.isArray(agentIds)) return c.json({ error: "agentIds array required" }, 400);
  stmt.expireLocks.run();
  const locked:Record<string,string>={};
  for(const aid of agentIds){
    const existing=stmt.getLock.get(user.githubId,aid) as any;
    if(existing && existing.device_id!==user.deviceId){
      const hb=new Date(existing.heartbeat+"Z").getTime();
      if(Date.now()-hb<5*60*1000){ locked[aid]=existing.device_id }
    }
  }
  return c.json({ locked });
});
