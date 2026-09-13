#!/usr/bin/env node
/**
 * im-gui-demo — 轻量 Web IM demo（验证「选 agent → 发消息 → agent 回」链路）
 *
 * 角色：本进程是一个「外部 bridge agent」，经 social 管道与 teyvat agent 双向通讯。
 *   参考：C.deploy/claude-code-bridge.py + B.docs/.../Cross-Framework(External Agent Bridge).WIKI
 *
 * 机制（对齐 communicate.ts / bridge.py）：
 *   1. 注册 SocialData/registry.json（sid=c0de0001, name=web-im-demo）→ 可被 teyvat agent 寻址
 *   2. 每 60s touch SocialData/heartbeat/<sid> → isAgentActive 的 bridge fallback 判在线
 *   3. 轮询自己 inbox（行数游标，不重写文件）→ SSE 推给浏览器
 *   4. 浏览器发消息 → 追加目标 agent 的 inbox/<sid>.jsonl + 写 triggers/<sid>.json（即时打断）
 *
 * 零依赖：仅用 node 内置模块。
 * 启动：node server.mjs   （浏览器打开 http://localhost:8790）
 * 环境变量：IM_DEMO_SID / IM_DEMO_NAME / IM_DEMO_PORT
 */
import http from "node:http";
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  statSync, renameSync, unlinkSync, readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ── 路径与常量（对齐 communicate.ts）─────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const SOCIAL = join(HOME, ".teyvat", "SocialData");
const REGISTRY_FILE = join(SOCIAL, "registry.json");
const INBOX_DIR = join(SOCIAL, "inbox");
const TRIGGERS_DIR = join(SOCIAL, "triggers");
const HEARTBEAT_DIR = join(SOCIAL, "heartbeat");
const GROUPS_DIR = join(SOCIAL, "groups");

// ── 跨设备（AgentTableSync：sync.paimon.beer；对齐 communicate.ts）──
const SYNC_UA = "genshin-sync/1.0";
const USER_ACCOUNT = join(HOME, ".teyvat", "UserAccount");
function syncEndpoint() {
  try {
    const svc = readJson(join(USER_ACCOUNT, "services.json"), {});
    if (svc["genshin-sync"]?.endpoint) return svc["genshin-sync"].endpoint;
  } catch { /* 无配置 → 默认 */ }
  return "https://sync.paimon.beer";
}
function loadBinding() {
  try {
    const b = readJson(join(USER_ACCOUNT, "binding.json"), null);
    if (b?.token && b?.deviceId) return b;
  } catch { /* 未绑定 */ }
  return null;
}
function syncHeaders(b) {
  return { Authorization: `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA };
}
// 远端 agent 列表（30s 缓存）
let _remoteCache = { at: 0, agents: [] };
async function listRemoteAgents() {
  if (Date.now() - _remoteCache.at < 30_000) return _remoteCache.agents;
  const b = loadBinding();
  if (!b) return [];
  try {
    const res = await fetch(syncEndpoint() + "/sync/agent-presence", { headers: syncHeaders(b), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return _remoteCache.agents;
    const j = await res.json();
    const agents = Array.isArray(j.agents) ? j.agents : [];
    _remoteCache = { at: Date.now(), agents };
    return agents;
  } catch {
    return _remoteCache.agents; // 网络失败 → 用旧缓存（降级不报错）
  }
}
// 远端在线判定：last_seen 在 5 分钟内（与 server 的 expirePresence 窗口一致）
function remoteLastSeen(r) {
  const ls = (r && r.last_seen) || "";
  const t = ls ? Date.parse(ls.replace(" ", "T") + "Z") : 0;
  return t || Date.now();
}
function remoteOnline(r) {
  return Date.now() - remoteLastSeen(r) < 5 * 60 * 1000;
}
// 上报自身 presence（跨设备可见）
async function reportPresenceRemote() {
  const b = loadBinding();
  if (!b) return;
  try {
    await fetch(syncEndpoint() + "/sync/agent-presence", {
      method: "POST",
      headers: { ...syncHeaders(b), "Content-Type": "application/json" },
      body: JSON.stringify({ sid: SELF_SID, name: SELF_NAME, focus: "off", version: "im-gui-demo", model: "web" }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* 静默 */ }
}
// 拉远端发给我的消息 → 写本地 inbox（去重；SSE 会自动推）
let _pullBusy = false;
async function pullRemoteMessages() {
  if (_pullBusy) return;
  const b = loadBinding();
  if (!b) return;
  _pullBusy = true;
  try {
    const res = await fetch(syncEndpoint() + `/messages/pending/${SELF_SID}`, { headers: syncHeaders(b), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const j = await res.json().catch(() => ({ messages: [] }));
    const seen2 = new Set(readMyInbox().map((m) => m.id));
    for (const m of (j.messages || [])) {
      if (m?.type !== "agent-social") continue;
      const p = m?.payload;
      if (!p || !p.id || seen2.has(p.id)) continue;
      appendLine(inboxFile(SELF_SID), p);
      seen2.add(p.id);
    }
  } catch { /* 静默 */ } finally {
    _pullBusy = false;
  }
}

// 版本：源码版本（VERSION 文件）× 运行时版本（启动时快照）分离
function readVersionFile() {
  try {
    return readFileSync(join(__dir, "VERSION"), "utf8").trim();
  } catch {
    return "0.0.0";
  }
}
const RUNTIME_VERSION = readVersionFile(); // 启动时快照（当前部署运行的版本）
const STARTED_AT = Date.now();

const SELF_SID = process.env.IM_DEMO_SID || "c0de0001";
const SELF_NAME = process.env.IM_DEMO_NAME || "web-im-demo";
const PORT = parseInt(process.env.IM_DEMO_PORT || "8790", 10);
const ACTIVE_MS = 90_000; // isAgentActive 在线窗口
const POLL_MS = 1500; // inbox 轮询（SSE 推送）
const HEARTBEAT_MS = 60_000; // 心跳周期

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── 文件辅助 ──────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file); // 原子写（同 communicate.ts writeJson）
  } catch (e) {
    console.error("[im-demo] writeJson:", e.message);
  }
}
function appendLine(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}
function inboxFile(sid) {
  return join(INBOX_DIR, `${sid}.jsonl`);
}

// ── 在线判定（复刻 communicate.ts isAgentActive）────────────────────────
function isAgentActive(sid) {
  // ① teyvat 进程 agent：MemoryData/<sid>/main.pid 心跳 ≤90s + 进程存活
  try {
    const pf = join(HOME, ".teyvat", "MemoryData", sid, "main.pid");
    const st = statSync(pf);
    if (Date.now() - st.mtimeMs <= ACTIVE_MS) {
      const pid = parseInt(readFileSync(pf, "utf8").trim(), 10);
      if (pid) {
        process.kill(pid, 0);
        return true;
      }
    }
  } catch {
    /* 无 pid / 进程不存在 / 超时 = 离线（正常态，静默） */
  }
  // ② 外部 bridge agent：heartbeat/<sid> mtime ≤ 90s（只 stat 不读）
  try {
    if (Date.now() - statSync(join(HEARTBEAT_DIR, sid)).mtimeMs <= ACTIVE_MS) return true;
  } catch {
    /* 非 bridge agent——静默 */
  }
  return false;
}

// ── agent 列表（registry 全量 + 在线标记；自己除外）────────────────────
function listAgents() {
  const reg = readJson(REGISTRY_FILE, {});
  const agents = Object.entries(reg)
    .filter(([sid]) => sid !== SELF_SID)
    .map(([sid, e]) => ({
      sid,
      name: e.name || sid,
      focus: e.focus || "off",
      model: e.model || "",
      version: e.version || "",
      lastSeen: e.lastSeen || 0,
      online: isAgentActive(sid),
    }))
    .sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
  return { agents, total: agents.length, online: agents.filter((a) => a.online).length };
}

// ── 自己身份：注册 + 心跳 ───────────────────────────────────────────────
function registerSelf() {
  const reg = readJson(REGISTRY_FILE, {});
  reg[SELF_SID] = {
    name: SELF_NAME,
    version: "im-gui-demo",
    model: "web",
    lastSeen: Date.now(),
    focus: reg[SELF_SID]?.focus ?? "off",
  };
  writeJson(REGISTRY_FILE, reg);
}
function touchHeartbeat() {
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
    writeFileSync(
      join(HEARTBEAT_DIR, SELF_SID),
      JSON.stringify({ ts: Date.now(), pid: process.pid }),
      "utf8"
    );
  } catch (e) {
    console.error("[im-demo] heartbeat:", e.message);
  }
}

// ── 自己 inbox：全量读（含发出的镜像 out:true）─────────────────────────
function readMyInbox() {
  const f = inboxFile(SELF_SID);
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null; // 坏行跳过（外部写入）
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
function readInboxMessages(sid) {
  const f = inboxFile(sid);
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}
// 与某 peer（sid 或 group:<gid>）的对话
function conversation(peer) {
  if (String(peer).startsWith("group:")) {
    // 群：聚合所有群成员 inbox 里 to=group:<gid> 的消息（按 id 去重、按时间排序）
    const gid = String(peer).slice(6);
    const g = readJson(join(GROUPS_DIR, `${gid}.json`), null);
    const members = [SELF_SID, ...((g && g.members) || [])];
    const byId = new Map();
    for (const m of members) {
      for (const msg of readInboxMessages(m)) {
        if (msg.to !== peer) continue;
        if (byId.has(msg.id)) continue;
        byId.set(msg.id, msg);
      }
    }
    return [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }
  return readMyInbox().filter((m) => (m.out && m.to === peer) || (!m.out && m.from === peer));
}

// ── 归档标记（plist.json：{id,name,archived,...}[]，archive.cjs 写入）──
const PLIST_FILE = join(HOME, ".teyvat", "MemoryData", "plist.json");
function loadArchivedMap() {
  const map = {};
  try {
    const arr = readJson(PLIST_FILE, []);
    for (const p of Array.isArray(arr) ? arr : []) {
      if (p && p.id) map[p.id] = !!p.archived;
    }
  } catch {
    /* 无 plist = 全部视为未归档 */
  }
  return map;
}

// ── 群聊（对齐 communicate.ts：groups/<gid>.json {id,name,members,created}）──
function listGroups() {
  try {
    if (!existsSync(GROUPS_DIR)) return [];
    return readdirSync(GROUPS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(join(GROUPS_DIR, f), null))
      .filter(Boolean)
      .sort((a, b) => (b.created || 0) - (a.created || 0));
  } catch {
    return [];
  }
}
function createGroup(name, members) {
  const gid = "gm" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const g = {
    id: gid,
    name: name || "群聊",
    members: [...new Set([SELF_SID, ...members])], // 自己也是成员（微信群语义）
    created: Date.now(),
  };
  mkdirSync(GROUPS_DIR, { recursive: true });
  writeFileSync(join(GROUPS_DIR, `${gid}.json`), JSON.stringify(g, null, 2), "utf8");
  return g;
}
function sendToGroup(gid, text, mode) {
  const g = readJson(join(GROUPS_DIR, `${gid}.json`), null);
  if (!g) throw new Error(`group ${gid} not found`);
  const ts = Date.now();
  const id = `msg_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const msg = {
    id, from: SELF_SID, from_name: SELF_NAME, to: `group:${gid}`,
    mode, mode_used: mode, text, ts, injected: false,
  };
  for (const m of g.members || []) {
    if (m === SELF_SID) continue;
    appendLine(inboxFile(m), msg); // 群发给每个成员
    try {
      mkdirSync(TRIGGERS_DIR, { recursive: true });
      writeFileSync(join(TRIGGERS_DIR, `${m}.json`), JSON.stringify({ msgId: id, ts }), "utf8");
    } catch (e) {
      console.error("[im-demo] group trigger:", e.message);
    }
  }
  const outMsg = { ...msg, out: true };
  appendLine(inboxFile(SELF_SID), outMsg); // 自己镜像
  return outMsg;
}

// 会话列表（微信式）：registry agent ∪ 群 ∪ 有消息往来的 peer，附最后一条消息
async function conversations() {
  const { agents } = listAgents();
  const inbox = readMyInbox();
  const lastByPeer = {};
  for (const m of inbox) {
    // 群消息：自己发的与别人发的 to 都是 group:<gid> → 会话归群；单聊：out 归 to、in 归 from
    const peer = m.out
      ? m.to
      : (m.to && String(m.to).startsWith("group:") ? m.to : m.from);
    if (!peer || peer === SELF_SID) continue;
    if (!lastByPeer[peer] || m.ts > lastByPeer[peer].ts) lastByPeer[peer] = m;
  }
  const archMap = loadArchivedMap();
  const list = agents.map((a) => ({ ...a, archived: !!archMap[a.sid], lastMsg: lastByPeer[a.sid] || null }));
  for (const g of listGroups()) {
    const key = `group:${g.id}`;
    list.push({
      sid: key, name: g.name || g.id, online: true, isGroup: true,
      members: g.members || [], model: "", lastSeen: g.created || 0,
      lastMsg: lastByPeer[key] || null,
    });
  }
  // 跨设备 agent（先合并：有消息往来的远程 agent 也要用 remote 信息，否则会被下面当无信息孤儿标离线）
  const remoteAgents = await listRemoteAgents();
  const localSids = new Set(Object.keys(readJson(REGISTRY_FILE, {})));
  for (const r of remoteAgents) {
    if (!r || !r.sid || localSids.has(r.sid)) continue;
    if (list.find((x) => x.sid === r.sid)) continue;
    list.push({
      sid: r.sid, name: r.name || r.sid, online: remoteOnline(r), remote: true,
      deviceId: r.device_id || r.deviceId || "", model: r.model || "",
      lastSeen: remoteLastSeen(r), archived: false, lastMsg: lastByPeer[r.sid] || null,
    });
  }
  // 补：有消息往来、但既不在 registry 也不在当前 presence 的 peer（会话记录仍要显示）
  for (const [peer, m] of Object.entries(lastByPeer)) {
    if (!list.find((x) => x.sid === peer)) {
      list.push({ sid: peer, name: peer, online: false, model: "", lastSeen: 0, archived: !!archMap[peer], lastMsg: m });
    }
  }
  // 有消息的按最后消息时间降序；没聊过的按 lastSeen 降序
  list.sort((a, b) => (b.lastMsg?.ts || 0) - (a.lastMsg?.ts || 0) || b.lastSeen - a.lastSeen);
  return list;
}

// ── 发送：写目标 inbox + triggers（+ 自己 inbox 镜像）───────────────────
async function sendTo(peerSid, text, mode = "interrupt") {
  if (String(peerSid).startsWith("group:")) return sendToGroup(String(peerSid).slice(6), text, mode);
  // 不在本机 registry → 跨设备投递（POST /messages/send，server 落库 + 目标设备拉取）
  const reg0 = readJson(REGISTRY_FILE, {});
  if (!reg0[peerSid]) return await sendToRemote(peerSid, text, mode);
  const ts = Date.now();
  const id = `msg_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const msg = {
    id,
    from: SELF_SID,
    from_name: SELF_NAME,
    to: peerSid,
    mode,
    mode_used: mode,
    text,
    ts,
    injected: false,
  };
  appendLine(inboxFile(peerSid), msg); // 投递给目标 agent
  try {
    // 触发文件：目标 agent fs.watch 到 → 立即注入（即时打断）
    mkdirSync(TRIGGERS_DIR, { recursive: true });
    writeFileSync(join(TRIGGERS_DIR, `${peerSid}.json`), JSON.stringify({ msgId: id, ts }), "utf8");
  } catch (e) {
    console.error("[im-demo] trigger:", e.message);
  }
  const outMsg = { ...msg, out: true }; // out: 标记「我发出的」（前端据此靠右渲染）
  appendLine(inboxFile(SELF_SID), outMsg); // 镜像到自己 inbox（对话时间线）
  return outMsg; // 修 bug：返回带 out —— 原先返回无 out，前端乐观渲染靠左，刷新后才对
}

// 跨设备发送（server 落库 → 目标设备 pullRemoteMessages 拉取）
async function sendToRemote(peerSid, text, mode) {
  const b = loadBinding();
  if (!b) throw new Error("跨设备发送需要绑定 GitHub 账号（无 binding.json）");
  const ts = Date.now();
  const id = `msg_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const msg = { id, from: SELF_SID, from_name: SELF_NAME, to: peerSid, mode, mode_used: mode, text, ts, injected: false };
  const res = await fetch(syncEndpoint() + "/messages/send", {
    method: "POST",
    headers: { ...syncHeaders(b), "Content-Type": "application/json" },
    body: JSON.stringify({ toPerson: peerSid, type: "agent-social", payload: msg }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`跨设备投递失败 HTTP ${res.status}`);
  const outMsg = { ...msg, out: true, remote: true };
  appendLine(inboxFile(SELF_SID), outMsg);
  return outMsg;
}

// ── SSE：轮询自己 inbox 新行 → 推给所有浏览器连接 ───────────────────────
const sseClients = new Set();
let lastCount = readMyInbox().length; // 启动时跳过历史（同 bridge.py 行数游标）
setInterval(() => {
  const all = readMyInbox();
  if (all.length > lastCount) {
    const fresh = all.slice(lastCount);
    lastCount = all.length;
    for (const m of fresh) {
      const payload = `data: ${JSON.stringify(m)}\n\n`;
      for (const c of sseClients) {
        try {
          c.write(payload);
        } catch {
          sseClients.delete(c);
        }
      }
    }
  } else if (all.length < lastCount) {
    lastCount = all.length; // 文件被截断（异常）→ 重置游标
  }
}, POLL_MS);

// ── HTTP 服务 ─────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 首页
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = readFileSync(join(__dir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end("index.html missing");
    }
  }

  // 版本信息（源码版本 vs 运行时版本：stale=true 表示源码已改但进程未重启）
  if (req.method === "GET" && url.pathname === "/version") {
    const src = readVersionFile();
    return sendJson(res, 200, {
      name: "im-gui-demo",
      version: RUNTIME_VERSION,     // 运行时（部署中）版本
      sourceVersion: src,           // 源码当前版本
      stale: src !== RUNTIME_VERSION,
      channel: "test",
      startedAt: STARTED_AT,
      sourceDir: __dir,
    });
  }

  // agent 列表
  if (req.method === "GET" && url.pathname === "/agents") {
    const { agents, total, online } = listAgents();
    return sendJson(res, 200, { self: { sid: SELF_SID, name: SELF_NAME }, agents, total, online });
  }

  // 会话列表（微信式，含最后一条消息 + 群）
  if (req.method === "GET" && url.pathname === "/conversations") {
    return sendJson(res, 200, {
      self: { sid: SELF_SID, name: SELF_NAME },
      conversations: await conversations(),
    });
  }

  // 群列表
  if (req.method === "GET" && url.pathname === "/groups") {
    return sendJson(res, 200, { groups: listGroups() });
  }

  // 创建群聊
  if (req.method === "POST" && url.pathname === "/groups") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on("end", () => {
      try {
        const { name, members } = JSON.parse(body || "{}");
        if (!Array.isArray(members) || !members.length) return sendJson(res, 400, { error: "members required" });
        return sendJson(res, 200, { ok: true, group: createGroup(name, members) });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    });
    return;
  }

  // 某 peer 的对话
  if (req.method === "GET" && url.pathname === "/messages") {
    const peer = url.searchParams.get("peer") || "";
    if (!peer) return sendJson(res, 400, { error: "peer required" });
    return sendJson(res, 200, { peer, messages: conversation(peer) });
  }

  // 发消息
  if (req.method === "POST" && url.pathname === "/send") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { to, text, mode } = JSON.parse(body || "{}");
        if (!to || !text) return sendJson(res, 400, { error: "to and text required" });
        const msg = await sendTo(String(to), String(text), mode === "queue" ? "queue" : "interrupt");
        return sendJson(res, 200, { ok: true, msg });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    });
    return;
  }

  // SSE 事件流
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end("not found");
});

// ── 启动 / 退出 ────────────────────────────────────────────────────────
registerSelf();
touchHeartbeat();
reportPresenceRemote();
pullRemoteMessages();
const hbTimer = setInterval(touchHeartbeat, HEARTBEAT_MS);
setInterval(() => { reportPresenceRemote(); }, 60_000);   // 跨设备 presence 上报
setInterval(pullRemoteMessages, 5_000);                  // 跨设备消息拉取

server.listen(PORT, () => {
  console.log(`[im-demo] listening  http://localhost:${PORT}`);
  console.log(`[im-demo] identity   ${SELF_NAME} (${SELF_SID})`);
  console.log(`[im-demo] social dir ${SOCIAL}`);
});

function shutdown() {
  clearInterval(hbTimer);
  try {
    unlinkSync(join(HEARTBEAT_DIR, SELF_SID)); // 清心跳 → 对方判离线
  } catch {
    /* ignore */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  console.log("\n[im-demo] bye");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
