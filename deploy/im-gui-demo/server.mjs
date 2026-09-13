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
  statSync, renameSync, unlinkSync,
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
// 与某 peer 的对话：我发的（out，to=peer）+ 收到的（from=peer）
function conversation(peer) {
  return readMyInbox().filter(
    (m) => (m.out && m.to === peer) || (!m.out && m.from === peer)
  );
}

// 会话列表（微信式）：registry agent ∪ 有消息往来的 peer，附最后一条消息
function conversations() {
  const { agents } = listAgents();
  const inbox = readMyInbox();
  const lastByPeer = {};
  for (const m of inbox) {
    const peer = m.out ? m.to : m.from;
    if (!peer || peer === SELF_SID) continue;
    if (!lastByPeer[peer] || m.ts > lastByPeer[peer].ts) lastByPeer[peer] = m;
  }
  const list = agents.map((a) => ({ ...a, lastMsg: lastByPeer[a.sid] || null }));
  for (const [peer, m] of Object.entries(lastByPeer)) {
    if (!list.find((x) => x.sid === peer)) {
      list.push({ sid: peer, name: peer, online: false, model: "", lastSeen: 0, lastMsg: m });
    }
  }
  // 有消息的按最后消息时间降序；没聊过的按 lastSeen 降序
  list.sort((a, b) => (b.lastMsg?.ts || 0) - (a.lastMsg?.ts || 0) || b.lastSeen - a.lastSeen);
  return list;
}

// ── 发送：写目标 inbox + triggers（+ 自己 inbox 镜像）───────────────────
function sendTo(peerSid, text, mode = "interrupt") {
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

const server = http.createServer((req, res) => {
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

  // agent 列表
  if (req.method === "GET" && url.pathname === "/agents") {
    const { agents, total, online } = listAgents();
    return sendJson(res, 200, { self: { sid: SELF_SID, name: SELF_NAME }, agents, total, online });
  }

  // 会话列表（微信式，含最后一条消息）
  if (req.method === "GET" && url.pathname === "/conversations") {
    return sendJson(res, 200, {
      self: { sid: SELF_SID, name: SELF_NAME },
      conversations: conversations(),
    });
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
    req.on("end", () => {
      try {
        const { to, text, mode } = JSON.parse(body || "{}");
        if (!to || !text) return sendJson(res, 400, { error: "to and text required" });
        const msg = sendTo(String(to), String(text), mode === "queue" ? "queue" : "interrupt");
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
const hbTimer = setInterval(touchHeartbeat, HEARTBEAT_MS);

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
