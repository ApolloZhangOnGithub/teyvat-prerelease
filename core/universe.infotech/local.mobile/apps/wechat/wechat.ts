import { registerShareTarget } from "../../system.share/share.ts";
// apps/wechat/imessage.ts — WeChat: 跨 agent 即时通讯 + 朋友圈
// ⚠️ 即将废弃（DEPRECATED）2026-08-13：由 Social Tool（social.communicate，~/.teyvat/SocialData/）替代。
// 保留代码供历史参考，不再维护。详见 Issues 002-wechat-deprecated.ISSUE。
// 消息存在 ~/.teyvat/data/appdata/wechat/wechat.jsonl，所有 agent 共享

import * as fs from "fs";
import { existsSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { appSharedDir, userFile } from "#paths";
import { homedir } from "node:os";
import type { MobileApp } from "../../system.kernel/kernel.ts";
import { loadReminders, isOverdue, needsNudge } from "../reminder/reminder.ts";

const SHARED_DIR = appSharedDir("wechat");
const MSG_FILE = path.join(SHARED_DIR, "wechat.jsonl");
const GROUPS_DIR = path.join(SHARED_DIR, "groups");

interface WechatMsg {
  from: string;
  to: string | "all";
  text: string;
  ts: number;
}

function getAgentName(): string {
  return process.env.PAIMON_AGENT_NAME || "unknown";
}

// ── 统一名称解析：优先通讯录，兜底原始 ID ──
function resolveName(id: string, personDir?: string): string {
  if (!personDir) return id;
  const contacts = loadContacts(personDir);
  const ct = contacts.find((c: any) => c.id === id || c.name === id);
  return ct?.name || id;
}

// ── 群 ID 归一化：防御级联 group: 前缀泄露 ──
function normalizeGroupId(gid: string, withPrefix = false): string {
  while (gid.startsWith("group:")) gid = gid.slice(6);
  return withPrefix ? `group:${gid}` : gid;
}

// ── 已读回执 ──
const READ_DIR = path.join(SHARED_DIR, "read");
function markRead(conversationKey: string): void {
  try {
    fs.mkdirSync(READ_DIR, { recursive: true });
    const me = getMySessionId();
    const file = path.join(READ_DIR, `${me}.json`);
    let data: Record<string, number> = {};
    try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
    data[conversationKey] = Date.now();
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
}
function getReadTs(agentSid: string, conversationKey: string): number {
  try {
    const file = path.join(READ_DIR, `${agentSid}.json`);
    if (!fs.existsSync(file)) return 0;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data[conversationKey] || 0;
  } catch { return 0; }
}

function sendWechatMsg(to: string, text: string): void {
  try { fs.mkdirSync(SHARED_DIR, { recursive: true }); } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
  // 归一化 group: 前缀，防级联泄露
  if (to.startsWith("group:")) to = normalizeGroupId(to, true);
  const msg: WechatMsg = { from: getAgentName(), to, text, ts: Date.now() };
  fs.appendFileSync(MSG_FILE, JSON.stringify(msg) + "\n");
  // I2: 通知唤醒 — 写 wakeup 文件给接收方
  if (to !== "all" && !to.startsWith("group:")) {
    try {
      let sid = to;
      if (!/^[a-f0-9]{8}$/.test(to)) {
        // 不是 session ID，从 presence 查
        const p = readPresence();
        for (const [k, v] of p) {
          if (v === to && /^[a-f0-9]{8}$/.test(k)) { sid = k; break; }
        }
      }
      if (/^[a-f0-9]{8}$/.test(sid)) {
        const wakeDir = path.join(homedir(), ".teyvat/wakeup");
        fs.mkdirSync(wakeDir, { recursive: true });
        fs.writeFileSync(path.join(wakeDir, `${sid}.wakeup`), JSON.stringify({ from: getAgentName(), text, ts: Date.now() }));
      }
    } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
  }
}

function readWechatMsgs(forAgent?: string, limit = 30, offset = 0): WechatMsg[] {
  try {
    const lines = fs.readFileSync(MSG_FILE, "utf8").trim().split("\n").filter(Boolean);
    let msgs: WechatMsg[] = [];
    for (const l of lines) { try { msgs.push(JSON.parse(l)); } catch { /* 跳过损坏行 */ } }
    if (forAgent) {
      const mySid = getMySessionId();
      const myGroups = listMyGroups();
      msgs = msgs.filter(m => {
        if (m.to === "all" || m.to === forAgent || m.from === forAgent || m.to === mySid) return true;
        if (m.to.startsWith("group:")) return myGroups.has(normalizeGroupId(m.to.slice(6)));
        return false;
      });
    }
    const limitMsgs = limit < 0 ? msgs : (() => {
      const start = Math.max(0, msgs.length - offset - limit);
      const end = msgs.length - offset;
      return msgs.slice(start, end);
    })();
    return limitMsgs;
  } catch { return []; }
}

// ── 消息搜索 ──
function searchMessages(forAgent: string, keyword: string, limit = 20): WechatMsg[] {
  const kw = keyword.toLowerCase();
  const all = readWechatMsgs(forAgent, -1); // -1 = unlimited
  return all.filter(m => m.text.toLowerCase().includes(kw)).slice(-limit).reverse();
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

// ── 会话聚合 ──
interface Conversation {
  key: string; label: string; type: "agent"|"group";
  lastMsg: WechatMsg; unread: number;
}
// ── 会话状态 (置顶/归档/删除) ──
interface ConvState { pinned: string[]; archived: string[]; deleted: string[]; }
function loadConvState(personDir: string): ConvState {
  const p = path.join(personDir, "conv_state.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return { pinned: [], archived: [], deleted: [] }; }
}
function saveConvState(personDir: string, cs: ConvState): void {
  try { fs.mkdirSync(personDir, { recursive: true }); fs.writeFileSync(path.join(personDir, "conv_state.json"), JSON.stringify(cs)); } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
}
function getConversations(msgs: WechatMsg[], me: string, convState?: ConvState, personDir?: string): Conversation[] {
  const map = new Map<string, Conversation>();
  const cs = convState || { pinned: [], archived: [], deleted: [] };
  for (const m of msgs) {
    let key: string, label: string, type: "agent"|"group";
    if (m.to.startsWith("group:")) {
      key = normalizeGroupId(m.to.slice(6)); label = loadGroup(key)?.name || key; type = "group";
    } else if (m.to === "all") continue;
    else { key = m.from === me ? m.to : m.from; label = resolveName(key, personDir); type = "agent"; }
    let conv = map.get(key);
    if (!conv) { conv = { key, label, type, lastMsg: m, unread: 0 }; map.set(key, conv); }
    if (m.ts > conv.lastMsg.ts) conv.lastMsg = m;
    if (m.to === me) conv.unread++;
  }
  return [...map.values()]
    .filter(c => !cs.deleted.includes(c.key) && !cs.archived.includes(c.key))
    .sort((a, b) => {
      const aPin = cs.pinned.includes(a.key) ? 1 : 0;
      const bPin = cs.pinned.includes(b.key) ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      return b.lastMsg.ts - a.lastMsg.ts;
    });
}
function getConversationMsgs(msgs: WechatMsg[], key: string): WechatMsg[] {
  return msgs.filter(m => {
    const normTo = m.to.startsWith("group:") ? normalizeGroupId(m.to.slice(6), true) : m.to;
    return normTo === `group:${key}` ||
      (m.from === key && m.to !== "all") ||
      (m.to === key && m.from !== "all");
  });
}
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + "..." : s; }
function padR(s: string, w: number): string { return " ".repeat(Math.max(0, w - s.length)) + s; }

// ── 群聊 ──
interface Group { id: string; name: string; members: string[]; created: string; }
function loadGroup(gid: string): Group | null {
  try { return JSON.parse(fs.readFileSync(path.join(GROUPS_DIR, `${gid}.json`), "utf8")); } catch { return null; }
}
function saveGroup(g: Group): void {
  try { fs.mkdirSync(GROUPS_DIR, { recursive: true }); fs.writeFileSync(path.join(GROUPS_DIR, `${g.id}.json`), JSON.stringify(g, null, 2)); } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
}
function listGroups(): Group[] {
  try {
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    return fs.readdirSync(GROUPS_DIR).filter(f => f.endsWith(".json")).map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(GROUPS_DIR, f), "utf8")); } catch { return null; }
    }).filter(Boolean) as Group[];
  } catch { return []; }
}
function listMyGroups(): Set<string> {
  const my = new Set<string>();
  const me = getAgentName();
  for (const g of listGroups()) { if (g.members.includes(me)) my.add(g.id); }
  return my;
}

function renderWechatInbox(agentName: string, personDir?: string): string {
  const msgs = readWechatMsgs(agentName);
  const lines = ["WeChat", ""];
  if (!msgs.length) {
    lines.push("  (没有消息)");
  } else {
    for (const m of msgs.slice(-20)) {
      const dir = m.from === agentName ? "→ " + m.to : resolveName(m.from, personDir) + " →";
      lines.push(`  [${fmtTime(m.ts)}] ${dir}: ${m.text}`);
    }
  }
  lines.push("");
  lines.push("  发消息 <名字> <内容>    发给某人");
  lines.push("  广播 <内容>             发给所有人");
  lines.push("  朋友圈                  查看动态");
  lines.push("  返回                    回主屏幕");
  return lines.join("\n");
}

// ── Talk types ─────────────────────────────────────────────────
interface TalkSession {
  id: string;
  type: "f2f" | "group" | "remote";  // f2f=面对面, group=群聊, remote=远程
  participants: string[];  // contact IDs
  initiator: string;       // who started
  state: "inviting" | "active" | "ended";
  created: string;
  ended?: string;
  visibility: "private" | "public";  // can others join?
  topic?: string;
  proposals: Proposal[];   // active proposals in this talk
}

interface TalkState {
  activeTalks: TalkSession[];  // talks I'm in
  currentTalkId: string | null; // which talk I'm focused on
}

interface Proposal {
  id: string;
  title: string;
  messageDescription?: string;
  proposer: string;
  votes: Record<string, "agree" | "disagree">;  // voterId → vote
  rule: "majority" | "unanimous";  // how to decide
  decided: boolean;
  result?: "passed" | "rejected";
  created: string;
  decidedAt?: string;
}

const talkStates = new Map<string, TalkState>();
const talkStore = new Map<string, TalkSession[]>(); // personDir → talks

function getState(personDir: string): TalkState {
  let s = talkStates.get(personDir);
  if (!s) {
    s = { activeTalks: [], currentTalkId: null };
    talkStates.set(personDir, s);
  }
  return s;
}

function loadTalks(personDir: string): TalkSession[] {
  let talks = talkStore.get(personDir);
  if (!talks) {
    const p = path.join(personDir, "talks.json");
    try { talks = JSON.parse(fs.readFileSync(p, "utf8")); } catch { talks = []; }
    talkStore.set(personDir, talks as TalkSession[]);
  }
  return talks as TalkSession[];
}

function saveTalks(personDir: string) {
  const talks = talkStore.get(personDir) ?? [];
  const p = path.join(personDir, "talks.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(talks, null, 2));
}

// ── Renderers ──────────────────────────────────────────────────
function renderTalkList(state: TalkState): string {
  const lines: string[] = ["--- 对话列表 ---", ""];
  if (state.activeTalks.length === 0) {
    lines.push("(没有进行中的对话)");
  } else {
    for (const t of state.activeTalks) {
      const marker = t.id === state.currentTalkId ? "" : " ";
      const participants = t.participants.join(", ");
      const status = t.state === "active" ? "进行中" : t.state === "inviting" ? "等待中" : "已结束";
      lines.push(`  ${marker} ${t.id} [${t.type}] ${participants} — ${status}`);
      if (t.topic) lines.push(`      主题: ${t.topic}`);
    }
  }
  lines.push("");
  lines.push("命令: talk --to <contactId> | talk --join <talkId> | talk --end | talk --leave | 「朋友圈」");
  return lines.join("\n");
}

function renderTalkDetail(state: TalkState): string {
  if (!state.currentTalkId) {
    return "当前没有在对话中。talk --list 查看可用对话，talk --to <id> 发起新对话。";
  }
  const talk = state.activeTalks.find(t => t.id === state.currentTalkId);
  if (!talk) {
    state.currentTalkId = null;
    return "对话已不存在。";
  }
  const lines: string[] = [
    `对话 ${talk.id}`,
    `   类型: ${talk.type} | 状态: ${talk.state}`,
    `   参与者: ${talk.participants.join(", ")}`,
    `   发起人: ${talk.initiator}`,
    `   创建: ${talk.created}`,
  ];
  if (talk.topic) lines.push(`   主题: ${talk.topic}`);
  lines.push("");
  lines.push("命令: talk --end (结束) | talk --leave (离开) | talk --list (列表)");
  return lines.join("\n");
}

// ── Contacts retrieval ─────────────────────────────────────────
function loadContacts(personDir: string): any[] {
  const p = path.join(personDir, "contacts.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
}

// ── Main handler ───────────────────────────────────────────────
export async function talkCmd(args: any, ctx: any, personDir: string): Promise<any> {
  const state = getState(personDir);
  state.activeTalks = loadTalks(personDir).filter(t => t.state !== "ended");

  // talk --list
  if (args.list || args._?.[0] === "list") {
    const out = renderTalkList(state);
    ctx.ui?.notify?.("对话列表", "info");
    return { content: [{ type: "text", text: out }] };
  }

  // talk --to <contactId> [--topic <text>]
  if (args.to || args._?.[0] === "to") {
    const contactId = (args.to || args._?.[1]) as string;
    if (!contactId) {
      return { content: [{ type: "text", text: "用法: talk --to <contactId> [--topic <文本>]" }] };
    }
    // Verify contact exists
    const contacts = loadContacts(personDir);
    const contact = contacts.find((c: any) => c.id === contactId || c.name === contactId);
    if (!contact) {
      return { content: [{ type: "text", text: `未找到联系人 "${contactId}"。先用 contacts --add 添加。` }] };
    }

    // Check if already in a talk with this contact
    const existing = state.activeTalks.find(t =>
      t.type === "f2f" && t.participants.includes(contactId) && t.state === "active"
    );
    if (existing) {
      state.currentTalkId = existing.id;
      return { content: [{ type: "text", text: `已在与 ${contact.name ?? contactId} 的对话中 (${existing.id})。` }] };
    }

    // Create new f2f talk
    const talkId = `talk-${Date.now().toString(36)}`;
    const topic = args.topic as string | undefined;
    const talk: TalkSession = {
      id: talkId,
      type: "f2f",
      participants: ["self", contactId],
      initiator: "self",
      state: "active",
      proposals: [],
      created: new Date().toISOString(),
      visibility: "private",
      topic,
    };

    state.activeTalks.push(talk);
    state.currentTalkId = talkId;
    const allTalks = loadTalks(personDir);
    allTalks.push(talk);
    talkStore.set(personDir, allTalks);
    saveTalks(personDir);

    ctx.ui?.notify?.(`与 ${contact.name ?? contactId} 发起对话`, "info");
    const out = [
      `开始与 ${contact.name ?? contactId} 的对话`,
      `   ID: ${talkId}`,
      topic ? `   主题: ${topic}` : "",
      `   你现在可以在此对话中交流。`,
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: out }] };
  }

  // talk --join <talkId>
  if (args.join || args._?.[0] === "join") {
    const talkId = (args.join || args._?.[1]) as string;
    if (!talkId) {
      return { content: [{ type: "text", text: "用法: talk --join <talkId>" }] };
    }
    const allTalks = loadTalks(personDir);
    const talk = allTalks.find(t => t.id === talkId && t.state === "active");
    if (!talk) {
      return { content: [{ type: "text", text: `未找到对话 "${talkId}" 或对话已结束。` }] };
    }
    if (talk.visibility === "private") {
      return { content: [{ type: "text", text: i18n(`对话 "${talkId}" 是私密的，无法加入。`, `Conversation "${talkId}" is private, cannot join.`) }] };
    }
    if (!talk.participants.includes("self")) {
      talk.participants.push("self");
    }
    if (!state.activeTalks.find(t => t.id === talkId)) {
      state.activeTalks.push(talk);
    }
    state.currentTalkId = talkId;
    saveTalks(personDir);
    ctx.ui?.notify?.(`加入对话 ${talkId}`, "info");
    return { content: [{ type: "text", text: `已加入对话 ${talkId}。参与者: ${talk.participants.join(", ")}` }] };
  }

  // talk --end
  if (args.end || args._?.[0] === "end") {
    if (!state.currentTalkId) {
      return { content: [{ type: "text", text: "当前没有进行中的对话。" }] };
    }
    const allTalks = loadTalks(personDir);
    const talk = allTalks.find(t => t.id === state.currentTalkId);
    if (talk) {
      talk.state = "ended";
      talk.ended = new Date().toISOString();
    }
    state.activeTalks = state.activeTalks.filter(t => t.id !== state.currentTalkId);
    const endedId = state.currentTalkId;
    state.currentTalkId = state.activeTalks[0]?.id ?? null;
    saveTalks(personDir);
    ctx.ui?.notify?.(`结束对话 ${endedId}`, "info");
    return { content: [{ type: "text", text: `对话 ${endedId} 已结束。` }] };
  }

  // talk --leave
  if (args.leave || args._?.[0] === "leave") {
    if (!state.currentTalkId) {
      return { content: [{ type: "text", text: "当前没有进行中的对话。" }] };
    }
    state.activeTalks = state.activeTalks.filter(t => t.id !== state.currentTalkId);
    const leftId = state.currentTalkId;
    state.currentTalkId = state.activeTalks[0]?.id ?? null;
    ctx.ui?.notify?.(`离开对话 ${leftId}`, "info");
    return { content: [{ type: "text", text: `已离开对话 ${leftId}。` }] };
  }

  // talk --propose <title> [--desc <text>] [--rule majority|unanimous]
  if (args.propose || args._?.[0] === "propose") {
    if (!state.currentTalkId) {
      return { content: [{ type: "text", text: "当前没有进行中的对话。先 talk --to <id> 发起对话。" }] };
    }
    const talk = state.activeTalks.find(t => t.id === state.currentTalkId);
    if (!talk) return { content: [{ type: "text", text: "对话状态异常。" }] };

    const title = (typeof args.propose === "string" ? args.propose : args._?.[1]) as string;
    if (!title) return { content: [{ type: "text", text: "用法: talk --propose <标题> [--desc <描述>] [--rule majority|unanimous]" }] };

    const proposal: Proposal = {
      id: `prop-${Date.now().toString(36)}`,
      title,
      messageDescription: args.desc as string | undefined,
      proposer: "self",
      votes: { "self": "agree" },  // proposer auto-agrees
      rule: (args.rule as "majority" | "unanimous") || "majority",
      decided: false,
      created: new Date().toISOString(),
    };

    talk.proposals = talk.proposals || [];
    talk.proposals.push(proposal);
    saveTalks(personDir);

    const lines = [
      `**提案: ${title}**`,
      `   ID: \`${proposal.id}\``,
      `   规则: ${proposal.rule === "unanimous" ? "全票通过" : "多数通过"}`,
      proposal.messageDescription ? `   描述: ${proposal.messageDescription}` : "",
      `   当前票数: agree=1, disagree=0`,
      `   参与者投票: talk --vote ${proposal.id} agree|disagree`,
    ];
    return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
  }

  // talk --vote <proposalId> agree|disagree
  if (args.vote || args._?.[0] === "vote") {
    if (!state.currentTalkId) {
      return { content: [{ type: "text", text: "当前没有进行中的对话。" }] };
    }
    const talk = state.activeTalks.find(t => t.id === state.currentTalkId);
    if (!talk) return { content: [{ type: "text", text: "对话状态异常。" }] };

    const propId = (args.vote || args._?.[1]) as string;
    const vote = ((args._?.[2] || args.agree ? "agree" : args.disagree ? "disagree" : null)) as string;
    if (!propId || !vote) return { content: [{ type: "text", text: "用法: talk --vote <proposalId> agree|disagree" }] };

    const proposal = (talk.proposals || []).find(p => p.id === propId);
    if (!proposal) return { content: [{ type: "text", text: `未找到提案: ${propId}` }] };
    if (proposal.decided) return { content: [{ type: "text", text: `提案已${proposal.result === "passed" ? "通过" : "驳回"}: **${proposal.title}**` }] };

    proposal.votes["self"] = vote as "agree" | "disagree";

    // Check if decided
    const agreeCount = Object.values(proposal.votes).filter(v => v === "agree").length;
    const disagreeCount = Object.values(proposal.votes).filter(v => v === "disagree").length;
    const total = talk.participants.length;

    let decided = false;
    if (proposal.rule === "unanimous") {
      decided = agreeCount === total;
    } else {
      decided = agreeCount > total / 2;
    }

    if (decided) {
      proposal.decided = true;
      proposal.result = "passed";
      proposal.decidedAt = new Date().toISOString();
    }

    saveTalks(personDir);

    const lines = [
      `**投票: ${vote.toUpperCase()}** → ${proposal.title}`,
      `   agree: ${agreeCount}  disagree: ${disagreeCount}`,
      `   总参与者: ${total}`,
      proposal.decided ? `\n**结果: ${proposal.result === "passed" ? "通过" : "驳回"}**` : `   还需 ${Math.floor(total / 2) + 1 - agreeCount} 票 agree 通过`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // talk --proposals: list active proposals
  if (args.proposals || args._?.[0] === "proposals") {
    if (!state.currentTalkId) {
      return { content: [{ type: "text", text: "当前没有进行中的对话。" }] };
    }
    const talk = state.activeTalks.find(t => t.id === state.currentTalkId);
    if (!talk || !talk.proposals || talk.proposals.length === 0) {
      return { content: [{ type: "text", text: "当前对话无活跃提案。用 talk --propose <标题> 发起。" }] };
    }

    const lines = ["**当前对话提案**"];
    for (const p of talk.proposals) {
      const agree = Object.values(p.votes).filter(v => v === "agree").length;
      const disagree = Object.values(p.votes).filter(v => v === "disagree").length;
      const status = p.decided ? (p.result === "passed" ? "通过" : "驳回") : `agree=${agree} disagree=${disagree}`;
      lines.push(`  \`${p.id}\` **${p.title}** — ${status} (${p.rule})`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // default: show current talk detail or list
  if (state.currentTalkId) {
    const out = renderTalkDetail(state);
    return { content: [{ type: "text", text: out }] };
  }
  const out = renderTalkList(state);
  ctx.ui?.notify?.("Talk", "info");
  return { content: [{ type: "text", text: out }] };
}

// ── Public API ─────────────────────────────────────────────────
export function getCurrentTalk(personDir: string): TalkSession | null {
  const state = getState(personDir);
  state.activeTalks = loadTalks(personDir).filter(t => t.state !== "ended");
  if (!state.currentTalkId) return null;
  return state.activeTalks.find(t => t.id === state.currentTalkId) ?? null;
}

export { type TalkSession, type TalkState };

function loadMoments(personDir: string): any[] {
  try { return JSON.parse(fs.readFileSync(path.join(personDir, "moments.json"), "utf8")); } catch { return []; }
}
function saveMoments(personDir: string, ms: any[]) {
  fs.mkdirSync(personDir, { recursive: true });
  fs.writeFileSync(path.join(personDir, "moments.json"), JSON.stringify(ms, null, 2));
}

registerShareTarget("WeChat", { name: "朋友圈", handler: (txt, dir) => { const ms = loadMoments(dir); ms.push({ id: "s" + Date.now(), text: txt, time: new Date().toISOString() }); saveMoments(dir, ms); return "已分享到朋友圈!"; } });
function renderMoments(personDir: string): string {
  const ms = loadMoments(personDir); const lines = ["--- 朋友圈 ---", ""];
  if (!ms.length) lines.push("  还没有动态。输入「发动态 <内容>」发布第一条。");
  else for (const m of ms.slice(-20).reverse()) lines.push(`  [${m.time.slice(0,16)}]\n  ${m.text}\n`);
  lines.push("", "命令: 发动态 <内容> | 删动态 <id> | 返回"); return lines.join("\n");
}
// ── message-service 客户端 ──
const MSG_SERVER = process.env.MSG_SERVER || "http://127.0.0.1:9224";

async function msgApi(action: string, params: Record<string, any> = {}): Promise<any> {
  try {
    const r = await fetch(MSG_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...params }),
      signal: AbortSignal.timeout(5000),
    });
    return await r.json();
  } catch (e: any) {
    return { error: e.message };
  }
}

function getMyId(): string {
  return process.env.PAIMON_AGENT_NAME || "unknown";
}
let _mySidCache = "";
function getMySessionId(): string {
  if (_mySidCache) return _mySidCache;
  try {
    // 从自己的 process.argv 读 --session-dir，比 ps+PID可靠得多
    for (const a of process.argv) {
      const m = a.match(/SessionData\/([a-f0-9]+)/);
      if (m) { _mySidCache = m[1]; return _mySidCache; }
    }
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
  return process.env.PAIMON_AGENT_NAME || "unknown";
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

import { execSync } from "child_process";
import { logerr } from "#paths";
import { i18n } from "#tui_localizations";

function discoverSessions(): Array<{pid: string, title: string}> {
  try {
    const pids = execSync("ps -eo pid,comm | grep '[c]laude$' | awk '{print $1}'", { encoding: "utf8", timeout: 2000 }).trim().split("\n").filter(Boolean);
    if (!pids.length) return [];
    const ttyMap: Record<string, string> = {};
    for (const p of pids) {
      const tty = execSync(`ps -p ${p} -o tty= 2>/dev/null`, { encoding: "utf8", timeout: 1000 }).trim();
      if (tty) ttyMap[`/dev/${tty}`] = p;
    }
    try {
      const raw = execSync(`osascript -e 'tell application "iTerm2"
        set output to ""
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              set output to output & (tty of s) & "|" & (name of s) & "\\n"
            end repeat
          end repeat
        end repeat
        return output
      end tell' 2>/dev/null`, { encoding: "utf8", timeout: 3000 }).trim();
      const result: Array<{pid: string, title: string}> = [];
      for (const line of raw.split("\n")) {
        const [dev, ...rest] = line.split("|");
        const pid = ttyMap[dev];
        if (pid) {
          const title = rest.join("|").replace(/^[⠁⠂⠄⡀⢀⠠⠐⠈✳⠿● ]+/, "").replace(/ *\(Python\)$/, "").replace(/ *\(-zsh\)$/, "").trim();
          result.push({ pid, title: title || "(无标题)" });
        }
      }
      return result;
    } catch {
      return pids.map(p => ({ pid: p, title: "(无标题)" }));
    }
  } catch { return []; }
}

// ── Agent 发现 ──
const PRESENCE_DIR = path.join(SHARED_DIR, "presence");

function getSysInfo(): { version: string; model: string; memory: string } {
  let version = "?";
  let model = "?";
  let memory = "?";
  try {
    const vf = path.join(homedir(), ".teyvat/version.json");
    if (fs.existsSync(vf)) {
      const v = JSON.parse(fs.readFileSync(vf, "utf8"));
      version = `${v.genshin || "?"} / pi ${v.pi || "?"}`;
    }
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
  try {
    const sf = userFile("settings.json");
    if (fs.existsSync(sf)) {
      const s = JSON.parse(fs.readFileSync(sf, "utf8"));
      model = s.defaultModel || "?";
    }
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
  try {
    const mu = process.memoryUsage();
    const mb = (mu.heapUsed / 1024 / 1024).toFixed(1);
    memory = `${mb}MB`;
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
  return { version, model, memory };
}
function updatePresence(): void {
  try {
    const sid = getMySessionId();
    const name = getAgentName();
    if (!/^[a-f0-9]{8}$/.test(sid)) return; // 没取到 session id，跳过
    const sys = getSysInfo();
    fs.mkdirSync(PRESENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PRESENCE_DIR, `${sid}.json`), JSON.stringify({ name, pid: process.pid, lastSeen: Date.now(), active: true, version: sys.version, model: sys.model, memory: sys.memory }));
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
}

function readPresence(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const files = fs.readdirSync(PRESENCE_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PRESENCE_DIR, f), "utf8"));
        const sid = f.replace(".json", "");
        if (data.name) m.set(sid, data.name);
        if (data.lastSeen) m.set(sid + "_ts", data.lastSeen);
        if (data.active !== undefined) m.set(sid + "_active", String(data.active));
        // agent 互查系统信息
        if (data.version) m.set(sid + "_version", data.version);
        if (data.model) m.set(sid + "_model", data.model);
        if (data.memory) m.set(sid + "_memory", data.memory);
      } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
    }
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
  return m;
}

let _agentCache: Array<{id: string, pid: string, name: string}> | null = null;
let _agentCacheTs = 0;
function discoverAgents(): Array<{id: string, pid: string, name: string, version?: string, model?: string, memory?: string}> {
  const now = Date.now();
  if (_agentCache && now - _agentCacheTs < 30000) return _agentCache;
  try {
    // 从 ps args 读取 genshin: 进程标题（comm 字段被截断，args 有完整标题）
    const agentPs = execSync("ps -eo pid,args | grep 'genshin:' | grep '(main,'", { encoding: "utf8", timeout: 2000 }).trim();
    if (!agentPs) { _agentCache = []; _agentCacheTs = now; return []; }
    const presence = readPresence();
    const agents: Array<{id: string, pid: string, name: string, lastSeen?: number, version?: string, model?: string, memory?: string}> = [];
    for (const line of agentPs.split("\n")) {
      const pid = line.trim().split(/\s+/)[0];
      const nm = line.match(/genshin:([^(]+)\(main,([a-f0-9]+)/);
      if (nm) {
        const sid = nm[2];
        // 从 presence 读实时 info，兜底从 startup.log 读版本号
        let version = presence.get(sid + "_version") || "?";
        let model = presence.get(sid + "_model") || "?";
        let memory = presence.get(sid + "_memory") || "?";
        // startup.log 版本永远是真实的（每次启动都写），优先于可能过时的 presence
        try {
          const slf = fs.readFileSync(path.join(homedir(), ".teyvat/MemoryData", sid, "startup.log"), "utf8");
          const lines = slf.trim().split("\n");
          const sl = JSON.parse(lines[lines.length - 1]);
          if (sl.genshin) version = `${sl.genshin} / pi ${sl.pi || "?"}`;
        } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
        agents.push({
          id: sid, pid,
          name: nm[1] || presence.get(sid) || sid,
          lastSeen: parseInt(presence.get(sid + "_ts") || "0"),
          version, model, memory,
        });
      }
    }
    _agentCache = agents; _agentCacheTs = now;
    return agents;
  } catch { return _agentCache || []; }
}

// ── 通讯录 ──
function renderContacts(agents: Array<{id:string, pid:string, name:string, lastSeen?:number, version?:string, model?:string, memory?:string}>): string {
  const lines = ["==== 通讯录 ====", ""];
  if (!agents.length) { lines.push("  未发现其他 agent"); lines.push(""); return lines.join("\n"); }
  const now = Date.now();
  const mySid = getMySessionId();
  for (const a of agents) {
    const isMe = a.id === mySid;
    const label = a.name !== a.id ? `${a.name} (${a.id})` : a.id;
    let status = ""; let statusIcon = "";
    if (isMe) { statusIcon = "🟢"; status = " [我]"; }
    else if (a.lastSeen) {
      const lastSeen = a.lastSeen;
      if (lastSeen < 1704067200000) { statusIcon = "⚫"; status = " 从未上线"; }
      else {
      const sec = (now - a.lastSeen) / 1000;
      if (sec < 10) { statusIcon = "●"; status = " 正在使用"; }
      else if (sec < 60) { statusIcon = "🟢"; status = " 刚刚"; }
      else if (sec < 3600) { statusIcon = "🟢"; status = ` ${Math.floor(sec/60)}分钟前`; }
      else if (sec < 86400) { statusIcon = "💤"; status = ` ${Math.floor(sec/3600)}小时前`; }
      else { statusIcon = "⚫"; status = ` ${Math.floor(sec/86400)}天前`; }
    }
    } else { statusIcon = "⚫"; status = " 从未上线"; }
    lines.push(`  ${statusIcon} ${label}${status}`);
    const info: string[] = [];
    if (a.version && a.version !== "?") info.push(a.version);
    if (a.model && a.model !== "?") info.push(a.model);
    if (a.memory && a.memory !== "?") info.push(a.memory);
    if (info.length) lines.push(`     ${info.join(" | ")}`);
    lines.push("");
  }
  lines.push("──");
  lines.push(`共 ${agents.length} 个 agent`);
  lines.push("");
  return lines.join("\n");
}

// ── 会话列表 (首页) ──
function renderConversationList(msgs: WechatMsg[], genshinAgents: Array<{id:string,pid:string,name:string,lastSeen?:number}>, mySid: string, me: string, personDir?: string): string {
  const lines = ["==== WeChat ====", ""];
  // Agents
  if (genshinAgents.length > 0) {
    lines.push("-- 联系人 --");
    for (const a of genshinAgents) {
      const mark = a.id === mySid ? " [我]" : "";
      const label = a.name !== a.id ? `${a.name} (${a.id})` : a.id;
      let status = "";
      if (a.id !== mySid) {
        const lastSeen = a.lastSeen || 0;
        // lastSeen=0 或早于 2024 年视为从未上线
        if (lastSeen < 1704067200000) status = " · 从未上线";
        else {
          const sec = (Date.now() - lastSeen) / 1000;
          if (sec < 10) status = " ● 正在使用";
          else if (sec < 60) status = " · 刚刚";
          else if (sec < 3600) status = ` · ${Math.floor(sec/60)}分钟前`;
          else if (sec < 86400) status = ` · ${Math.floor(sec/3600)}小时前`;
          else status = ` · ${Math.floor(sec/86400)}天前`;
        }
      }
      lines.push(`  ${label}${mark}${status}`);
    }
    lines.push("");
  }
  // 广播
  const bcMsgs = msgs.filter(m => m.to === "all");
  const bcLast = bcMsgs.length ? ` (${bcMsgs.length}条, 最后: ${fmtTime(bcMsgs[bcMsgs.length-1].ts)})` : "";
  lines.push("-- 广播 --" + bcLast);
  lines.push("  输入「广播 <内容>」发送"); lines.push("");
  // 会话
  const convs = getConversations(msgs, me, personDir ? loadConvState(personDir) : undefined, personDir);
  if (!convs.length) {
    lines.push("-- 会话 --");
    lines.push("  (还没有会话)");
  } else {
    lines.push("-- 会话 (输入序号进入) --");
    convs.forEach((c, i) => {
      const unread = c.unread ? ` [+${c.unread}]` : "";
      const preview = truncate(c.lastMsg.text.replace(/\n/g, " "), 20);
      const pinMark = (personDir && loadConvState(personDir).pinned.includes(c.key)) ? "📌" : "";
      lines.push(`  ${i+1}.${pinMark} ${c.label}${c.type==="group"?" [群]":""}${unread}`);
      lines.push(`     ${fmtTime(c.lastMsg.ts)} ${c.lastMsg.from === me ? "我:" : ""}${preview}`);
    });
  }
  lines.push("");
  lines.push("-- 功能 --");
  lines.push("  通讯录 | 朋友圈 | 搜索 <关键词>");
  lines.push("  建群 <群名> <成员...> | 刷新");
  lines.push("  置顶/归档/删除会话 <会话名>");
  lines.push("  发消息 <ID> <内容> (兼容旧格式)");
  lines.push("  返回 回主屏幕");
  return lines.join("\n");
}

// ── 聊天详情页 ──
function renderChatDetail(msgs: WechatMsg[], partner: string, partnerLabel: string, me: string, sysInfo?: { version?: string; model?: string; memory?: string }, totalMsgs?: number, offset?: number): string {
  const lines = [`==== ${partnerLabel} ====`];
  const chatMsgs = getConversationMsgs(msgs, partner);
  if (!chatMsgs.length) return lines.join("\n") + "\n\n(暂无消息)\n\n[发送 内容 | 返回 | 刷新]";
  lines.push("");
  const W = 42;
  // 获取对方已读时间 (需将 agent name → session ID)
  const presence = readPresence();
  let partnerSid = partner;
  if (!/^[a-f0-9]{8}$/.test(partner)) {
    for (const [k, v] of presence) {
      if (v === partner && /^[a-f0-9]{8}$/.test(k)) { partnerSid = k; break; }
    }
  }
  const readTs = partnerSid ? getReadTs(partnerSid, me) : 0;
  // 分组: 未读(全部) + 已读(最多5条)，其余翻页
  const unread: typeof chatMsgs = [];
  const read: typeof chatMsgs = [];
  for (const m of chatMsgs) {
    const isRead = m.from === me ? m.ts <= readTs : m.ts <= readTs;
    if (isRead) read.push(m); else unread.push(m);
  }
  const shownRead = read.slice(-5);
  const hiddenReadCt = read.length - shownRead.length;
  if (hiddenReadCt > 0) lines.push(`... 以上 ${hiddenReadCt} 条已读消息 (翻页查看)`);
  const allShown = [...read.slice(-5), ...unread];
  for (const m of allShown) {
    const ts = fmtTime(m.ts);
    const isRead = m.from === me && m.ts <= readTs;
    const mark = isRead ? " ✓✓" : "";
    if (m.from === me) {
      lines.push(padR(`${m.text}${mark}  [${ts}]`, W));
    } else {
      const fromDisplay = m.from === partner ? partnerLabel : m.from;
      lines.push(`[${ts}] ${fromDisplay}: ${m.text}`);
    }
  }
  // pagination hint
  if (totalMsgs !== undefined && offset !== undefined && offset + chatMsgs.length < totalMsgs) {
    lines.push(`\n[${offset + 1}-${offset + chatMsgs.length}/${totalMsgs}] 输入「翻页」加载更早`);
  } else if (totalMsgs !== undefined && offset !== undefined) {
    lines.push("\n已到顶部");
  }
  // footer: agent 互查系统信息
  if (sysInfo && (sysInfo.version || sysInfo.model || sysInfo.memory)) {
    lines.push("");
    lines.push("── 系统信息 ──");
    if (sysInfo.version) lines.push(`  版本: ${sysInfo.version}`);
    if (sysInfo.model) lines.push(`  模型: ${sysInfo.model}`);
    if (sysInfo.memory) lines.push(`  内存: ${sysInfo.memory}`);
  }
  lines.push("");
  lines.push("[发送 内容 | 返回 | 刷新]");
  return lines.join("\n");
}

// ── 通知中心: Reminder/Clock 检测（app 层，热加载可用）──
async function checkNotifications(personDir: string) {
  try {
    // 读取 per-app 通知设置
    let notifMode: Record<string, string> = {};
    try {
      const nf = path.join(personDir, "notif_settings.json");
      if (existsSync(nf)) notifMode = JSON.parse(readFileSync(nf, "utf8"));
    } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
    const canNotify = (app: string) => notifMode[app] !== "关闭";
    // 动态 import 避免 ESM 循环依赖
    const { pushNotification } = await import("../../system.kernel/kernel.ts");
    const reminders = loadReminders(personDir);
    const overdue = reminders.filter((r: any) => isOverdue(r) && !r.completed && !r.notified);
    if (canNotify("reminder")) {
      for (const r of overdue) {
        pushNotification(`[Reminder] ${r.title}${r.due ? ` (due ${r.due.slice(0, 16)})` : ""}`);
        r.notified = true;
      }
    }
    if (overdue.length > 0) {
      writeFileSync(path.join(personDir, "reminders.json"), JSON.stringify(reminders, null, 2));
    }
    // Clock 闹钟
    if (canNotify("clock")) {
      const af = path.join(personDir, "clock_alarms.json");
      if (existsSync(af)) {
        const alarms = JSON.parse(readFileSync(af, "utf8"));
        const now = new Date();
        const cur = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
        let fired = 0;
        for (const a of alarms) {
          if (a.enabled && a.time === cur && !a._notified) {
            pushNotification(`[Clock] ${a.label || "闹钟"} (${a.time})`);
            a._notified = true;
            fired++;
          }
        }
        if (fired > 0) writeFileSync(af, JSON.stringify(alarms, null, 2));
      }
    }
  } catch (e: any) {
    try { console.error("[wechat] checkNotifications failed:", e?.message || e); } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
  }
}

export const app: MobileApp = {
  name: "wechat",
  icon: "WeChat",
  messageDescription: "即时通讯、朋友圈、联系人",

  async onOpen(state, personDir) {
    // 通知检测: Reminder逾期 + Clock闹钟
    await checkNotifications(personDir);
    const st = { ...state, chatPartner: null, chatType: null };
    // 多会话标签: 初始化
    if (!st._tabs) { st._tabs = [{ chatPartner: null, chatType: null, chatLabel: "首页", _msgOffset: 0 }]; st._activeTab = 0; }
    const me = getMyId();
    const msgs: WechatMsg[] = readWechatMsgs(me);
    let genshinAgents: Array<{id:string,pid:string,name:string}> = [];
    try { updatePresence(); genshinAgents = discoverAgents(); } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
    const mySid = getMySessionId();
    // 标签栏
    const tabInfo = st._tabs.map((t: any, i: number) => i === (st._activeTab || 0) ? `[${i+1}◀${t.chatLabel||"首页"}]` : ` ${i+1} `).join("");
    let screen = `── ${tabInfo} ──\n` + renderConversationList(msgs, genshinAgents, mySid, me, personDir);
    // I2: 检查 wakeup 文件，显示通知
    try {
      const wakeDir = path.join(homedir(), ".teyvat/wakeup");
      if (fs.existsSync(wakeDir)) {
        const wakeFiles = fs.readdirSync(wakeDir).filter(f => f.endsWith(".wakeup"));
        if (wakeFiles.length > 0) {
          const alerts: string[] = [];
          for (const f of wakeFiles) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(wakeDir, f), "utf8"));
              alerts.push(`  ${resolveName(data.from, personDir)}: ${(data.text || "").slice(0, 40)}`);
            } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
            // 删除已处理的 wakeup
            try { fs.unlinkSync(path.join(wakeDir, f)); } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
          }
          if (alerts.length > 0) {
            screen = "⚠ 唤醒消息:\n" + alerts.join("\n") + "\n\n" + screen;
          }
        }
      }
    } catch (e) { console.error("[universe.infotech/local.mobile/apps/wechat/wechat.ts] " + ((e as any)?.message || e)); }
    return { screen, state: st };
  },
  async onAction(input, state, personDir) {
    const trimmed = input.trim();
    const me = getMyId();
    const st = state as any;

    // 截屏 → 同时存到相册(AppData/photos) + 分享目录
    if (trimmed === "截屏" || trimmed === "screenshot") {
      try {
        const { execSync: es } = await import("node:child_process");
        const fn = `screenshot_${Date.now()}.png`;
        // 主存储: 相册
        const photosDir = path.join(homedir(), ".teyvat/AppData/shared/photos");
        fs.mkdirSync(photosDir, { recursive: true });
        const photoFp = path.join(photosDir, fn);
        // 复制: 分享目录
        const sharedDir = path.join(SHARED_DIR, "shared");
        fs.mkdirSync(sharedDir, { recursive: true });
        const sharedFp = path.join(sharedDir, fn);
        // 截屏：darwin 用 screencapture，Linux 用 import/gnome-screenshot/scrot（依次探测）
        const shotCmd = (() => {
          if (process.platform === "darwin") return `screencapture -x ${JSON.stringify(photoFp)}`;
          for (const [bin, tmpl] of [
            ["import",          `import -window root ${JSON.stringify(photoFp)}`],
            ["gnome-screenshot", `gnome-screenshot -f ${JSON.stringify(photoFp)}`],
            ["scrot",            `scrot ${JSON.stringify(photoFp)}`],
          ] as Array<[string, string]>) {
            try { es(`which ${bin}`, { stdio: "ignore" }); return tmpl; } catch { /* 下一个 */ }
          }
          throw new Error("未找到截屏工具 (Linux: apt install scrot 或 imagemagick/gnome-screenshot)");
        })();
        es(shotCmd, { timeout: 5000 });
        // 复制到分享目录供微信发送
        fs.copyFileSync(photoFp, sharedFp);
        return { screen: `截屏已保存: ${fn}\n\n相册已更新。输入「分享图片 ${fn}」发送给当前聊天对象`, state };
      } catch (e: any) { return { screen: "截屏失败: " + e.message, state }; }
    }

    // 分享图片（仅允许图片格式）
    const shareMatch = trimmed.match(/^分享图片\s+(\S+)$/);
    if (shareMatch) {
      const fn = shareMatch[1];
      const ext = fn.split('.').pop()?.toLowerCase() || '';
      if (!['png','jpg','jpeg','gif','bmp','webp'].includes(ext)) {
        return { screen: `仅支持图片格式 (png/jpg/gif/bmp/webp)，当前文件: ${fn}`, state };
      }
      const fp = path.join(SHARED_DIR, "shared", fn);
      if (!existsSync(fp)) return { screen: `文件不存在: ${fn}`, state };
      if (st.chatPartner) {
        const to = st.chatType === "group" ? `group:${st.chatPartner}` : st.chatPartner;
        sendWechatMsg(to, `[图片] ${fn}`);
        return { screen: `图片已分享给 ${st.chatLabel}: ${fn}`, state };
      }
      return { screen: `请先进入一个会话再分享图片。\n\n文件: ${fn}`, state };
    }

    // ── 多会话标签命令 ──
    if (!st._tabs) { st._tabs = [{ chatPartner: null, chatType: null, chatLabel: "首页", _msgOffset: 0 }]; st._activeTab = 0; }
    const tabsAny: any[] = st._tabs;
    const actIdx: number = st._activeTab || 0;
    if (/^(新会话|new chat)$/i.test(trimmed)) {
      tabsAny.push({ chatPartner: null, chatType: null, chatLabel: "新会话", _msgOffset: 0 });
      st._activeTab = tabsAny.length - 1;
      return app.onOpen(state, personDir);
    }
    if (/^(关闭会话|close chat)$/i.test(trimmed)) {
      if (tabsAny.length <= 1) return { screen: "无法关闭最后一个会话标签", state };
      tabsAny.splice(actIdx, 1);
      if ((st._activeTab || 0) >= tabsAny.length) st._activeTab = tabsAny.length - 1;
      const act = tabsAny[st._activeTab];
      if (act.chatPartner) {
        return { screen: ``, state: { ...st, chatPartner: act.chatPartner, chatType: act.chatType, chatLabel: act.chatLabel, _msgOffset: act._msgOffset || 0 } };
      }
      return app.onOpen(state, personDir);
    }
    const sessMatch = trimmed.match(/^(会话|session)\s+(\d+)$/i);
    if (sessMatch) {
      const n = parseInt(sessMatch[2]);
      if (n < 1 || n > tabsAny.length) return { screen: `会话序号 1-${tabsAny.length}`, state };
      st._activeTab = n - 1;
      const act = tabsAny[st._activeTab];
      if (act.chatPartner) {
        return { screen: ``, state: { ...st, chatPartner: act.chatPartner, chatType: act.chatType, chatLabel: act.chatLabel, _msgOffset: act._msgOffset || 0, _activeTab: st._activeTab } };
      }
      return app.onOpen(state, personDir);
    }
    if (/^(会话列表|sessions)$/i.test(trimmed)) {
      const lines = [`═══ ${tabsAny.length} 个会话 ═══`, ""];
      for (let i = 0; i < tabsAny.length; i++) {
        const t = tabsAny[i];
        const mark = i === actIdx ? " ◀" : "";
        lines.push(`  [${i + 1}] ${t.chatLabel || "首页"}${mark}`);
      }
      return { screen: lines.join("\n"), state };
    }
    // ===== 聊天详情页模式 =====
    if (st.chatPartner) {
      const key = st.chatType === "group" ? normalizeGroupId(st.chatPartner, true) : st.chatPartner;
      const genshinAgents = discoverAgents();
      const agentInfo = genshinAgents.find(a => a.id === st.chatPartner || a.name === st.chatPartner);
      const sysInfo = agentInfo ? { version: agentInfo.version, model: agentInfo.model, memory: agentInfo.memory } : undefined;
      // 已读回执: 查看对话时标记已读
      markRead(key);
      if (trimmed === "返回" || trimmed === "back") return app.onOpen(state, personDir);
      if (trimmed === "刷新" || trimmed === "refresh") {
        const msgs: WechatMsg[] = readWechatMsgs(me);
        return { screen: renderChatDetail(msgs, key, st.chatLabel, me, sysInfo), state };
      }
      // 群改名（仅群聊）
      if (st.chatType === "group" && trimmed.startsWith("群改名 ")) {
        const newName = trimmed.slice(4).trim();
        if (!newName) return { screen: "用法: 群改名 <新名称>", state };
        const g = loadGroup(st.chatPartner);
        if (!g) return { screen: "群不存在", state };
        g.name = newName;
        saveGroup(g);
        return { screen: `群已改名为「${newName}」`, state: { ...st, chatLabel: newName } };
      }
      // 翻页: 加载更早的消息
      if (trimmed === "翻页" || trimmed === "更多" || trimmed === "more") {
        const curOffset = (st._msgOffset || 0) + 30;
        const msgs: WechatMsg[] = readWechatMsgs(me, 30, curOffset);
        const total = readWechatMsgs(me, -1).length;
        const loaded = msgs.length;
        if (loaded === 0) return { screen: "已到顶部", state };
        const screen = renderChatDetail(msgs, key, st.chatLabel, me, sysInfo, total, curOffset);
        return { screen, state: { ...st, _msgOffset: curOffset } };
      }
      // 发送消息: "发送 <内容>" 格式（避免与命令混淆）
      if (trimmed.startsWith("发送 ")) {
        const msg = trimmed.slice(3);
        if (!msg) return { screen: "(空消息)", state };
        const to = st.chatType === "group" ? `group:${st.chatPartner}` : st.chatPartner;
        sendWechatMsg(to, msg);
        const msgs: WechatMsg[] = readWechatMsgs(me);
        return { screen: renderChatDetail(msgs, to, st.chatLabel, me, sysInfo), state: { ...st, _msgOffset: 0 } };
      }
      return { screen: "(空输入或命令)", state };
    }

    // ===== 会话列表模式 =====
    const genshinAgentsAll = discoverAgents();
    function findSysInfo(partnerId: string) {
      const a = genshinAgentsAll.find(x => x.id === partnerId || x.name === partnerId);
      return a ? { version: a.version, model: a.model, memory: a.memory } : undefined;
    }
    // 进入会话（输入序号）
    const n = parseInt(trimmed);
    if (n >= 1) {
      const msgs: WechatMsg[] = readWechatMsgs(me);
      const convs = getConversations(msgs, me, loadConvState(personDir), personDir);
      if (n <= convs.length) {
        const c = convs[n-1];
        const key = c.type === "group" ? c.key : c.key;
        const sysInfo = c.type === "agent" ? findSysInfo(c.key) : undefined;
        // 更新当前标签信息
        if (st._tabs && (st._activeTab || 0) < st._tabs.length) {
          st._tabs[st._activeTab] = { ...st._tabs[st._activeTab], chatPartner: c.key, chatType: c.type, chatLabel: c.label };
        }
        return { screen: renderChatDetail(msgs, key, c.label, me, sysInfo), state: { ...state, chatPartner: c.key, chatType: c.type, chatLabel: c.label, _tabs: st._tabs, _activeTab: st._activeTab } };
      }
    }
    // 进入会话（输入名字/群名）
    const enterMatch = trimmed.match(/^(打开|进入)\s+(.+)$/);
    if (enterMatch) {
      const name = enterMatch[2].toLowerCase();
      const msgs: WechatMsg[] = readWechatMsgs(me);
      const convs = getConversations(msgs, me, loadConvState(personDir));
      const c = convs.find(c => c.label.toLowerCase().includes(name));
      if (c) {
        const key = c.type === "group" ? c.key : c.key;
        const sysInfo = c.type === "agent" ? findSysInfo(c.key) : undefined;
        return { screen: renderChatDetail(msgs, key, c.label, me, sysInfo), state: { ...state, chatPartner: c.key, chatType: c.type, chatLabel: c.label } };
      }
      return { screen: `未找到会话「${enterMatch[2]}」`, state };
    }

    // 发消息（兼容旧格式）
    const sendMatch = trimmed.match(/^发消息\s+(\S+)\s+(.+)$/);
    if (sendMatch) {
      let [, to, text] = sendMatch;
      if (/^\d+$/.test(to)) to = `claude-${to}`;
      if (/^[a-f0-9]{8}$/.test(to)) { const nm = readPresence().get(to); if (nm) to = nm; }
      sendWechatMsg(to, text);
      // 发送后直接进入该会话的详情页
      const msgs: WechatMsg[] = readWechatMsgs(me);
      const sysInfoSend = findSysInfo(to);
      return { screen: renderChatDetail(msgs, to, to, me, sysInfoSend), state: { ...state, chatPartner: to, chatType: "agent", chatLabel: to } };
    }

    // 建群
    const createGrp = trimmed.match(/^建群\s+(\S+)\s+(.+)$/);
    if (createGrp) {
      const gname = createGrp[1];
      const members = createGrp[2].split(/\s+/).filter(Boolean);
      if (!members.includes(me)) members.push(me);
      const gid = `g${Date.now().toString(36)}`;
      saveGroup({ id: gid, name: gname, members, created: new Date().toISOString() });
      return { screen: `群「${gname}」已创建 (${gid})\n成员: ${members.join(", ")}\n\n输入「返回」回首页`, state };
    }

    // 群聊 (旧格式兼容)
    const grpMatch = trimmed.match(/^群聊\s+(\S+)\s+(.+)$/);
    if (grpMatch) {
      const gid = grpMatch[1]; const text = grpMatch[2];
      const g = loadGroup(gid);
      if (!g) return { screen: `群 ${gid} 不存在`, state };
      if (!g.members.includes(me)) return { screen: `你不是群 ${g.name} 的成员`, state };
      sendWechatMsg(`group:${gid}`, text);
      const msgs: WechatMsg[] = readWechatMsgs(me);
      return { screen: renderChatDetail(msgs, `group:${gid}`, g.name, me), state: { ...state, chatPartner: gid, chatType: "group", chatLabel: g.name } };
    }

    // 广播
    const bcMatch = trimmed.match(/^广播\s+(.+)$/);
    if (bcMatch) {
      sendWechatMsg("all", bcMatch[1]);
      return { screen: "已广播", state };
    }

    // 朋友圈
    if (trimmed === "朋友圈") {
      return { screen: renderMoments(personDir), state: { ...state, chatPartner: null, chatType: null } };
    }
    // 发动态
    const momentMatch = trimmed.match(/^发动态\s+(.+)$/);
    if (momentMatch) {
      const ms = loadMoments(personDir);
      ms.push({ id: "m" + Date.now(), text: momentMatch[1], time: new Date().toISOString() });
      saveMoments(personDir, ms);
      return { screen: "已发布到朋友圈\n\n" + renderMoments(personDir), state };
    }

    // 通讯录
    if (trimmed === "通讯录" || trimmed.toLowerCase() === "contacts") {
      const agents = discoverAgents();
      return { screen: renderContacts(agents), state };
    }

    // ── 会话管理 ──
    const pinMatch = trimmed.match(/^置顶\s+(.+)$/);
    if (pinMatch) {
      const cs = loadConvState(personDir); const k = pinMatch[1];
      if (!cs.pinned.includes(k)) { cs.pinned.push(k); saveConvState(personDir, cs); }
      return app.onOpen(state, personDir);
    }
    const unpinMatch = trimmed.match(/^取消置顶\s+(.+)$/);
    if (unpinMatch) {
      const cs = loadConvState(personDir);
      cs.pinned = cs.pinned.filter(x => x !== unpinMatch[1]);
      saveConvState(personDir, cs);
      return app.onOpen(state, personDir);
    }
    const archMatch = trimmed.match(/^归档\s+(.+)$/);
    if (archMatch) {
      const cs = loadConvState(personDir); const k = archMatch[1];
      if (!cs.archived.includes(k)) { cs.archived.push(k); saveConvState(personDir, cs); }
      return app.onOpen(state, personDir);
    }
    const unarchMatch = trimmed.match(/^取消归档\s+(.+)$/);
    if (unarchMatch) {
      const cs = loadConvState(personDir);
      cs.archived = cs.archived.filter(x => x !== unarchMatch[1]);
      saveConvState(personDir, cs);
      return app.onOpen(state, personDir);
    }
    const delConvMatch = trimmed.match(/^删除会话\s+(.+)$/);
    if (delConvMatch) {
      const cs = loadConvState(personDir); const k = delConvMatch[1];
      if (!cs.deleted.includes(k)) { cs.deleted.push(k); saveConvState(personDir, cs); }
      return app.onOpen(state, personDir);
    }

    // 消息搜索
    const searchMatch = trimmed.match(/^搜索\s+(.+)$/);
    if (searchMatch) {
      const results = searchMessages(me, searchMatch[1]);
      if (!results.length) return { screen: `未找到包含「${searchMatch[1]}」的消息`, state };
      const lines = [`==== 搜索: ${searchMatch[1]} ====`, ""];
      for (const m of results) {
        const dir = m.from === me ? `→ ${m.to}` : `${resolveName(m.from, personDir)} →`;
        lines.push(`  [${fmtTime(m.ts)}] ${dir}`);
        lines.push(`  ${m.text}`);
        lines.push("");
      }
      lines.push(`共 ${results.length} 条结果`);
      return { screen: lines.join("\n"), state };
    }

    // 刷新
    if (trimmed === "刷新" || trimmed === "refresh") return app.onOpen(state, personDir);

    // 默认：刷新会话列表
    return app.onOpen(state, personDir);
  },
};
