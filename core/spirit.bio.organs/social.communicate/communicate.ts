// social.communicate/communicate.ts — Social Tool：agent 间对等通讯器官
// 命名规范：func social.communicate → 主文件 communicate.ts，配套 communicate-ZZ.ts
// 所有 genshin agent 平等，全对全可达。无层级、无 per-peer 权限矩阵。
//
// 设计（2026-08-13 用户定稿）：
//   - 投递模式：interrupt（立刻打断，默认）/ queue（轮后）
//   - @DEP deferred 已废弃（ISSUE 103）：不提醒+不能已读≈丢信。代码注释保留，见 downgrade/getPendingInbox。
//   - 裁决：接收方 focus（off/deep/rest）降级 + 群 @ 静音
//   - @：群聊定向强调（提升为 interrupt，群静音则 queue）
//   - 注入时机：heart agent_end 检查 inbox；hibernate 前检查
//   - 渲染：social-message 消息类型 + blockrender renderMessage.external
//   - 透明：focus 状态公开，mode_used 回执给发送方
//   - 存储：~/.teyvat/SocialData/（一等数据目录，单一根目录，无分叉）
//
// 文档: B.docs/Dev.Common/Wiki/Social(Agent Communication).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { registerPaimonTool, sendCustomMessage } from "#kernel_backbone";
import { renderToolCall, renderMessage, GUTTER, lineNumbered } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { socialDataDir, logerr, runtimeCacheDir, syncEndpoint } from "#paths";
// heart-state：interrupt 唤醒 hibernated 用（communicate → heart-state 无环；heart.ts 反向 import communicate）
import { transition, heartState } from "../kernel.heart/heart-state.ts";

// ── 常量 ──────────────────────────────────────────────────────────────
// @DEP deferred 废弃（ISSUE 103）：类型字面量保留仅为兼容历史 inbox 数据（旧消息 mode_used 可能是 "deferred"），新发送不再允许
export type SocialMode = "interrupt" | "queue" | "deferred";
export type SocialFocus = "off" | "deep" | "rest";

export const SOCIAL_DIR = socialDataDir();
const REGISTRY_FILE = join(SOCIAL_DIR, "registry.json");
const INBOX_DIR = join(SOCIAL_DIR, "inbox");
const GROUPS_DIR = join(SOCIAL_DIR, "groups");
const MUTES_DIR = join(SOCIAL_DIR, "mutes");
// interrupt 跨进程触发文件目录：发送方写 <接收方sid>.json，接收方 fs.watch 即时响应（强制切断）
const TRIGGERS_DIR = join(SOCIAL_DIR, "triggers");
// 2026-09-07：外部框架 bridge agent 心跳目录（claude-code-bridge 等——非 teyvat 进程，无 MemoryData/<sid>/main.pid）
// 外部 agent 周期 touch SocialData/heartbeat/<sid>（内容随意）→ isAgentActive 视为在线（90s 窗口）
const HEARTBEAT_DIR = join(SOCIAL_DIR, "heartbeat");

const MAX_MSG_CHARS = 16_384;
// Cloudflare Bot Management 拦截无/默认 User-Agent（Error 1010）——所有到 sync server 的 fetch 必须带
const SYNC_UA = "genshin-sync/1.0";

interface SocialMsg {
  id: string;
  from: string;        // sid
  from_name: string;
  to: string;          // sid | group:<gid> | all
  mode: SocialMode;    // 发送方请求
  mode_used: SocialMode; // 实际生效
  at?: string[];       // @ 强调（群聊）
  text: string;
  ts: number;
  injected: boolean;   // 是否已注入接收方上下文
}

interface Group {
  id: string;
  name: string;
  members: string[];
  created: number;
}

interface RegistryEntry {
  name: string;
  version: string;
  model: string;
  lastSeen: number;
  focus: SocialFocus;
}

// ── 身份 ──────────────────────────────────────────────────────────────
let _mySid = "";
let _myName = "";
let _personDir = "";

function getMySid(): string {
  if (_mySid) return _mySid;
  // 测试/调试支持：PI_SOCIAL_SID 覆盖 session 解析（standalone 脚本用，不部署）
  const env = process.env.PI_SOCIAL_SID;
  return env && /^[a-f0-9]{8}$/.test(env) ? env : "";
}
function getMyName(): string {
  return _myName || process.env.PAIMON_AGENT_NAME || _mySid || "unknown";
}

// ── 文件辅助 ──────────────────────────────────────────────────────────
function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return fallback; }
}
function writeJson(file: string, data: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  } catch (e: any) { logerr("SOC001", e); }
}

// ── registry：启动注册 + 心跳 ─────────────────────────────────────────
export function registerSelf(): void {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) return;
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  const sys = getSysInfo();
  reg[sid] = {
    name: getMyName(),
    version: sys.version,
    model: sys.model,
    lastSeen: Date.now(),
    focus: reg[sid]?.focus ?? "off",
  };
  writeJson(REGISTRY_FILE, reg);
}

let _lastPresenceTouch = 0;
function touchPresence(): void {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) return;
  // 节流：30 秒内不重复写 registry（agent_end 每轮都会调）
  const now = Date.now();
  if (now - _lastPresenceTouch < 30_000) return;
  _lastPresenceTouch = now;
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  if (!reg[sid]) return;
  // 2026-08-18 修复：心跳同时刷新 model/version（原只刷 lastSeen）——
  // /m 切换模型后注册表的 model 字段立即（≤30s）反映当前模型，不再停留启动时快照。
  const sys = getSysInfo();
  reg[sid].lastSeen = now;
  reg[sid].model = sys.model;
  reg[sid].version = sys.version;
  writeJson(REGISTRY_FILE, reg);
  // AgentTableSync（2026-09-05）：心跳同时上报远端 server（有 binding 时）——跨设备可见
  reportPresence("up").catch(() => {});
  // 2026-09-07 跨设备接收：心跳节流通过时同时拉 server pending 的 agent-social 消息 → 本地 inbox（复用注入）。
  // fire-and-forget：拉取失败静默，下次心跳（30s）再拉。PROPOSAL 036 缺口 4。
  pullRemoteMessages().catch(() => {});
}

// ── 跨设备 presence 上报（AgentTableSync 2026-09-05）────────────────────
// 有 GitHub binding 时，把本 agent 轻量状态上报 sync server（/sync/agent-presence）——
// 别的机器 social.list({remote:true}) 能看到本机 agent。上报失败不阻塞本地（纯增量）。
let _reportInFlight = false;
async function reportPresence(kind: "up" | "down"): Promise<void> {
  if (_reportInFlight) return;
  try {
    let b: any = null;
    try { b = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8")); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return; }
    if (!b?.token || !b?.deviceId) return;
    const sid = getMySid();
    if (!/^[a-f0-9]{8}$/.test(sid)) return;
    _reportInFlight = true;
    const ep = syncEndpoint();
    if (kind === "up") {
      const sys = getSysInfo();
      const body = { sid, name: getMyName(), focus: getFocus(), version: sys.version, model: sys.model };
      // 2026-09-07：活跃同步顺带更新 device_states（alice 反馈：agent 清单上传原只靠 genshin d spawn，一次性不可靠）——
      // /sync/* 都走 authMiddleware（server L16），带 X-Device-Agents + X-Device-Name 即存 device_states + 更新真实设备名，随 45s timer 周期刷新。
      let agentsHeader = "";
      try { agentsHeader = JSON.stringify(listAgents().map((a: any) => ({ sid: a.sid, name: a.name, version: a.version, model: a.model, focus: a.focus }))); } catch { /* 清单构造失败不阻塞 presence 上报 */ }
      const headers: Record<string, string> = { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "Content-Type": "application/json", "User-Agent": SYNC_UA, "X-Device-Name": require("os").hostname() };
      if (agentsHeader) headers["X-Device-Agents"] = agentsHeader;
      await fetch(ep + "/sync/agent-presence", { method: "POST", headers, body: JSON.stringify(body) });
    } else {
      await fetch(`${ep}/sync/agent-presence/${sid}`, { method: "DELETE", headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA } });
    }
  } catch (e) { logerr("SOC-PRESENCE", e, "reportPresence(" + kind + ")"); }
  finally { _reportInFlight = false; }
}

export async function reportOffline(): Promise<void> { await reportPresence("down"); } // 优雅退出上报 offline（heart 退出钩子调）


function getSysInfo(): { version: string; model: string } {
  let version = "?";
  let model = "?";
  try {
    // 2026-08-18 修复：版本读 agent 级 version.json（launcher/make 部署写的位置，含 genshin+pi 双版本）；
    // 原读 ~/.teyvat/version.json（全局）是旧值/缺 genshin 字段 → 显示 "? / pi 0.80.3"。
    const vf = join(homedir(), ".teyvat/agent/version.json");
    if (existsSync(vf)) {
      const v = JSON.parse(readFileSync(vf, "utf8"));
      // 2026-08-20 用户定稿：不再显示 pi 版本——pi 只是 extension（扩展组件）的缩写，不是运行环境；
      // 显示它会让 agent（模型）误以为自己运行在 pi 上。只保留 genshin 版本。
      version = `${v.genshin || "?"}`;
    }
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
  try {
    // 2026-08-18 修复：模型优先取当前 session 实际模型（/m 切换后立即反映，headless 无 TUI 桥则回退）；
    // 回退读 agent 级 settings（~/.teyvat/agent/settings.json，setModel 持久化 defaultModel 处）——
    // 原读 ~/.teyvat/settings.json（全局）在 /m 切换后不更新。
    const curModel = (globalThis as any).__genshinGetModel?.()?.id;
    if (curModel) {
      model = curModel;
    } else {
      const sf = join(homedir(), ".teyvat/agent/settings.json");
      if (existsSync(sf)) {
        const s = JSON.parse(readFileSync(sf, "utf8"));
        model = s.defaultModel || "?";
      }
    }
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
  return { version, model };
}

export function listAgents(): Array<{ sid: string; name: string; focus: SocialFocus; lastSeen: number; version: string; model: string }> {
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  // 2026-08-14 用户报修：list 扫出一堆归档/废弃 agent（testbot、旧版 genshin 等）。
  // 只返回运行中（active）的 agent：main.pid 心跳 90s 窗口 + 进程存活（与 list.cjs 一致）。
  // 归档 agent 无心跳文件 → 自然过滤；offline（未运行）也不显示。广播(all)同样只覆盖 active。
  return Object.entries(reg)
    .filter(([sid]) => isAgentActive(sid))
    .map(([sid, e]) => ({ sid, name: e.name, focus: e.focus, lastSeen: e.lastSeen, version: e.version, model: e.model }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/** 运行中判定：① teyvat 进程 agent：MemoryData/<sid>/main.pid 心跳文件 90s 内触碰且进程存活（与 CLI list.cjs 同源逻辑）；
 *  ② 外部 bridge agent（2026-09-07）：无 main.pid 时退回检查 SocialData/heartbeat/<sid> 文件 mtime 90s 内 = 在线（claude-code-bridge 等跨框架 agent）。 */
export function isAgentActive(sid: string): boolean {
  try {
    const pf = join(homedir(), ".teyvat", "MemoryData", sid, "main.pid");
    const st = require("fs").statSync(pf);
    if (Date.now() - st.mtimeMs <= 90_000) {
      const pid = parseInt(readFileSync(pf, "utf8").trim(), 10);
      if (pid) { process.kill(pid, 0); return true; }
    }
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 无 pid 文件 / 进程不存在 / 心跳超时 */ }
  // bridge 心跳 fallback（外部 agent）
  try {
    const hb = join(HEARTBEAT_DIR, sid);
    const hst = require("fs").statSync(hb);
    if (Date.now() - hst.mtimeMs <= 90_000) return true;
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 无心跳文件 */ }
  return false;
}

function resolveSid(nameOrSid: string): string | null {
  if (/^[a-f0-9]{8}$/.test(nameOrSid)) return nameOrSid;
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  for (const [sid, e] of Object.entries(reg)) {
    if (e.name === nameOrSid) return sid;
  }
  return null;
}

/** 显示名：name (sid)；未知 sid 原样返回 */
function displayName(sid: string): string {
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  const e = reg[sid];
  return e ? `${e.name} (${sid})` : sid;
}
function displayNameShort(sid: string): string {
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  return reg[sid]?.name ?? sid;
}

// ── focus ─────────────────────────────────────────────────────────────
export function setFocus(mode: SocialFocus): void {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) return;
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  if (!reg[sid]) registerSelf();
  const reg2 = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  if (!reg2[sid]) return;
  reg2[sid].focus = mode;
  writeJson(REGISTRY_FILE, reg2);
}

export function getFocus(sid?: string): SocialFocus {
  const target = sid || getMySid();
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  return reg[target]?.focus ?? "off";
}

// ── 群 ────────────────────────────────────────────────────────────────
function loadGroup(gid: string): Group | null {
  return readJson<Group | null>(join(GROUPS_DIR, `${gid}.json`), null);
}
function saveGroup(g: Group): void {
  mkdirSync(GROUPS_DIR, { recursive: true });
  writeJson(join(GROUPS_DIR, `${g.id}.json`), g);
}
function listGroups(): Group[] {
  try {
    mkdirSync(GROUPS_DIR, { recursive: true });
    return readdirSync(GROUPS_DIR).filter(f => f.endsWith(".json")).map(f => readJson<Group | null>(join(GROUPS_DIR, f), null)).filter((g): g is Group => !!g);
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return []; }
}
function myGroups(): Group[] {
  const me = getMyName();
  return listGroups().filter(g => g.members.includes(me) || g.members.includes(getMySid()));
}

// ── 群 @ 静音（按群，不按人）─────────────────────────────────────────
function loadMutes(): string[] {
  const sid = getMySid();
  return readJson<string[]>(join(MUTES_DIR, `${sid}.json`), []);
}
function loadMutesOf(sid: string): string[] {
  return readJson<string[]>(join(MUTES_DIR, `${sid}.json`), []);
}
function setGroupMute(gid: string, on: boolean): void {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) return;
  const mutes = loadMutes();
  const idx = mutes.indexOf(gid);
  if (on && idx < 0) mutes.push(gid);
  if (!on && idx >= 0) mutes.splice(idx, 1);
  writeJson(join(MUTES_DIR, `${sid}.json`), mutes);
}

// ── 投递裁决 ──────────────────────────────────────────────────────────
function downgrade(mode: SocialMode, focus: SocialFocus): SocialMode {
  // @DEP deferred 已废弃（ISSUE 103）：历史消息 mode_used 可能是 "deferred"，兜底映射为 queue
  if (mode === "deferred") mode = "queue";
  // deep/rest 一律降到 queue（不再有 deferred 档）
  if (focus === "deep" || focus === "rest") return "queue";
  return mode;
}

function resolveMode(opts: {
  receiverFocus: SocialFocus;
  requested: SocialMode;
  isAt: boolean;
  atMuted: boolean;
}): SocialMode {
  let mode = opts.requested;
  // @ 提升：群聊里被 @ 者按 interrupt 处理（除非该群 @ 被静音 → queue）
  if (opts.isAt) mode = opts.atMuted ? "queue" : "interrupt";
  // focus 降级：deep/rest 全降到 queue（@DEP deferred 已废弃，ISSUE 103）
  return downgrade(mode, opts.receiverFocus);
}

// ── 消息 ──────────────────────────────────────────────────────────────
function inboxFile(sid: string): string { return join(INBOX_DIR, `${sid}.jsonl`); }

function appendInbox(sid: string, msg: SocialMsg): void {
  try {
    mkdirSync(INBOX_DIR, { recursive: true });
    appendFileSync(inboxFile(sid), JSON.stringify(msg) + "\n", "utf8");
  } catch (e: any) { logerr("SOC002", e); }
}

function readInbox(sid: string, limit = 50): SocialMsg[] {
  try {
    if (!existsSync(inboxFile(sid))) return [];
    const lines = readFileSync(inboxFile(sid), "utf8").trim().split("\n").filter(Boolean);
    const msgs: SocialMsg[] = [];
    for (const l of lines.slice(-limit)) { try { msgs.push(JSON.parse(l)); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 2026-09-07：外部写入坏行（如 claude-code-bridge 未转义 JSON）静默跳过——脏数据不是代码错误，不刷日志（纪律③） */ } }
    return msgs;
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return []; }
}

function markInjected(sid: string, ids: string[]): void {
  try {
    const file = inboxFile(sid);
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n");
    const idSet = new Set(ids);
    const out = lines.map(l => {
      if (!l.trim()) return l;
      try {
        const m = JSON.parse(l) as SocialMsg;
        if (idSet.has(m.id)) m.injected = true;
        return JSON.stringify(m);
      } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return l; }
    });
    writeFileSync(file, out.join("\n"), "utf8");
  } catch (e: any) { logerr("SOC003", e); }
  // 2026-08-14 修复：标记 injected 后立即刷新未读计数——否则 statebar 的
  // __genshinSocialPending 停留在旧值，显示过期的 "N msgs pending"。
  refreshSocialPending();
}

/** 刷新 footer/statebar 未读计数（内存变量 __genshinSocialPending，不读盘由调用方控制时机） */
export function refreshSocialPending(): void {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) return;
  const all = readInbox(sid, 200);
  const pending = all.filter(m => !m.injected);
  // @DEP deferred 字段保留仅为兼容历史数据，新消息不会有 deferred
  const counts = { count: pending.length, interrupt: 0, queue: 0, deferred: 0 };
  for (const m of pending) { if (m.mode_used in counts) counts[m.mode_used]++; }
  (globalThis as any).__genshinSocialPending = counts;
  (process as any).__genshinSocialPending = counts;
}

/** 未注入的消息（按注入优先级排序：interrupt > queue）
 *  upto: 只取优先级 <= upto 的消息（interrupt < queue）。意图栈非空时传 "queue"（不注入低优先级）。
 *  @DEP deferred 已废弃（ISSUE 103）：order 里保留仅为兼容历史数据排序，历史 deferred 消息当 queue 处理。
 *
 *  ⚠️ 历史注释已清理：interrupt 强制切断已在 0.3.1-dev.20260814.10 实现（watchInterruptTriggers + deliverAs:"interrupt"），
 *  本条目的旧开发责任注释过时，2026-08-17 移除（见 ISSUE 103 关联段）。 */
export function getPendingInbox(limit = 10, upto?: SocialMode): SocialMsg[] {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) return [];
  touchPresence();
  const order: Record<SocialMode, number> = { interrupt: 0, queue: 1, deferred: 2 }; // @DEP deferred 仅为兼容历史数据
  const uptoRank = upto ? order[upto] : 2;
  const all = readInbox(sid, 200);
  const pending = all.filter(m => !m.injected);
  refreshSocialPending(); // footer 感知：更新全局未读数（statebar 读变量不读盘；含 interrupt 时高亮）
  return pending
    .filter(m => order[m.mode_used] <= uptoRank)
    .sort((a, b) => order[a.mode_used] - order[b.mode_used] || a.ts - b.ts)
    .slice(0, limit);
}

/** heart agent_end 调用：有未注入消息返回 true */
export function hasPendingSocial(): boolean {
  return getPendingInbox(1).length > 0;
}

/** 注入并标记已注入，返回格式化文本 */
export function drainPendingSocial(limit = 10, upto?: SocialMode): string {
  const msgs = getPendingInbox(limit, upto);
  if (!msgs.length) return "";
  markInjected(getMySid(), msgs.map(m => m.id));
  return formatPendingMsgs(msgs);
}

/** 注入并标记已注入，返回 { 格式化文本, 渲染 details（from/mode_used/at）}；无消息返回 null */
export function drainPendingSocialWithMeta(limit = 10, upto?: SocialMode): { text: string; meta: Record<string, unknown> } | null {
  const msgs = getPendingInbox(limit, upto);
  if (!msgs.length) return null;
  markInjected(getMySid(), msgs.map(m => m.id));
  const first = msgs[0];
  return {
    text: formatPendingMsgs(msgs),
    meta: {
      from: first.from,
      from_name: first.from_name,
      mode: first.mode,
      mode_used: first.mode_used,
      ts: first.ts,
      ...(first.at?.length ? { at: first.at } : {}),
    },
  };
}

// ── 发送 ──────────────────────────────────────────────────────────────
// ── 跨设备 helpers（2026-09-07，PROPOSAL 036 缺口 2/3/4）─────────────────────
// 本机 agent = 本地 registry 有；远端 agent = registry 无 → 经 server messaging 投递（person 级语义，type=agent-social，
// server 落库 pending → 对方设备周期拉取写本地 inbox。离线投递由 server 兕底（7 天清理）。
function loadBinding(): { token: string; deviceId: string } | null {
  try {
    const b = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8"));
    if (b?.token && b?.deviceId) return { token: b.token, deviceId: b.deviceId };
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 未绑定 */ }
  return null;
}

/** 远端投递：POST /messages/send（type=agent-social，payload=完整 social 消息）。server 落库/ws 推送，不要求对方在线。 */
// 2026-09-07 Bug1（cross-device-communication-testor-01 报告）：远程 agent 名字路由——resolveSid 只查本地 registry，
// 远程 agent 名字只在 server presence（/sync/agent-presence）。单发分支本地解析失败时查远端 presence 补名字→sid。
async function findRemoteAgent(key: string): Promise<{ sid: string; name: string } | null> {
  try {
    let b: any = null;
    try { b = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8")); } catch { return null; }
    if (!b?.token || !b?.deviceId) return null;
    const res = await fetch(syncEndpoint() + "/sync/agent-presence", { headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA } });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    const agents = (j.agents || []) as any[];
    const localReg = readJson<Record<string, unknown>>(REGISTRY_FILE, {});
    for (const a of agents) {
      if ((a.sid === key || a.name === key) && !localReg[a.sid]) return { sid: a.sid, name: a.name };  // 排除本机 agent（本地 registry 有的走本机逻辑）
    }
    return null;
  } catch { return null; }
}

async function remoteSendOne(toSid: string, text: string, mode: SocialMode, fromSid: string, fromName: string): Promise<{ to: string; mode_used: SocialMode; status: string }> {
  const b = loadBinding();
  if (!b) throw new Error(`social.send: ${toSid} 不在本机且未绑定 GitHub 账号——跨设备投递需要 binding`);
  const msg: SocialMsg = {
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    from: fromSid,
    from_name: fromName,
    to: toSid,
    mode,
    mode_used: mode,
    text,
    ts: Date.now(),
    injected: false,
  };
  const ep = syncEndpoint();
  let res: Response;
  try {
    res = await fetch(ep + "/messages/send", { method: "POST", headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "Content-Type": "application/json", "User-Agent": SYNC_UA }, body: JSON.stringify({ toPerson: toSid, type: "agent-social", payload: msg }) });
  } catch (e: any) {
    throw new Error(`social.send: 跨设备投递网络错误 ${toSid}（${(e?.message || e)} url=${ep}/messages/send）`);
  }
  if (!res.ok) throw new Error(`social.send: 跨设备投递失败 ${toSid}（HTTP ${res.status}）`);
  const j = await res.json().catch(() => ({}));
  return { to: toSid, mode_used: mode, status: j?.delivered ? "remote-delivered" : "remote-queued" };
}

/** 拉 server pending 的 agent-social 消息 → 写本地 inbox（复用注入机制）。heart 周期经 touchPresence 节流 fire。 */
export async function pullRemoteMessages(): Promise<number> {
  const b = loadBinding();
  const sid = getMySid();
  if (!b || !/^[a-f0-9]{8}$/.test(sid)) return 0;
  try {
    const res = await fetch(syncEndpoint() + `/messages/pending/${sid}`, { headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA } });
    if (!res.ok) return 0;
    const j = await res.json().catch(() => ({ messages: [] }));
    let added = 0;
    for (const m of (j?.messages || [])) {
      if (m?.type !== "agent-social") continue;
      const p = m?.payload;
      if (!p || typeof p !== "object" || !p?.id) continue;
      if (readInbox(sid, 500).some((x: SocialMsg) => x.id === p.id)) continue; // 去重（server 标记延迟防重复注入）
      appendInbox(sid, p as SocialMsg);
      added++;
      // ISSUE 125 跨设备扩展：写 trigger 文件让 handleTrigger 走打断路径（resting→working→inject）
      // 没有 trigger 时跨设备消息只能等 agent_end drain，wait 中不被打断
      if (p.mode_used === "interrupt" || p.mode_used === "queue") {
        try {
          mkdirSync(TRIGGERS_DIR, { recursive: true });
          writeFileSync(join(TRIGGERS_DIR, `${sid}.json`), JSON.stringify({ msgId: p.id, ts: p.ts }), "utf8");
        } catch { /* trigger 写入失败 → 降级为 agent_end drain */ }
      }
    }
    return added;
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return 0; } // 拉取失败静默（下次心跳再拉）
}

async function sendOne(to: string, text: string, mode: SocialMode, atList: string[], isGroup: boolean, gid: string | null, fromSid: string, fromName: string): Promise<{ to: string; mode_used: SocialMode; status: string }> {
  const receiverSid = to;
  // 跨设备：本机 registry 无此 sid → 远端投递（server messaging；对方设备 agent 拉取）。群/广播暂限本机。
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  if (!reg[receiverSid]) {
    return remoteSendOne(receiverSid, text, mode, fromSid, fromName);
  }
  // 2026-08-14 用户定稿：social 是实时消息，对方不在线（offline）目前不支持发送（离线队列以后再设计）。
  if (!isAgentActive(receiverSid)) {
    throw new Error(`social.send: ${receiverSid} 不在线（offline）——实时消息不支持发给离线 agent（离线投递以后再设计）`);
  }
  const focus = getFocus(receiverSid);
  const isAt = atList.includes(receiverSid);
  const atMuted = isGroup && gid !== null && loadMutesOf(receiverSid).includes(gid);
  const modeUsed = resolveMode({ receiverFocus: focus, requested: mode, isAt, atMuted });
  const msg: SocialMsg = {
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    from: fromSid,
    from_name: fromName,
    to: isGroup && gid ? `group:${gid}` : to,
    mode,
    mode_used: modeUsed,
    ...(atList.length ? { at: atList } : {}),
    text,
    ts: Date.now(),
    injected: false,
  };
  appendInbox(receiverSid, msg);
  // 2026-08-14 interrupt/queue 跨进程触发：写触发文件，接收方 fs.watch 即时响应。
  // interrupt → 立即打断（abort 当前 turn）；queue → 接收方 wait（resting）时也打断（用户 2026-08-14 要求），工作中留给 agent_end。
  if (modeUsed === "interrupt" || modeUsed === "queue") {
    try {
      mkdirSync(TRIGGERS_DIR, { recursive: true });
      writeFileSync(join(TRIGGERS_DIR, `${receiverSid}.json`), JSON.stringify({ msgId: msg.id, ts: msg.ts }), "utf8");
    } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 触发文件失败 → 降级为 agent_end 轮后注入 */ }
  }
  return { to: receiverSid, mode_used: modeUsed, status: modeUsed === "interrupt" ? "alert" : "queued" };
}

async function sendMessage(opts: { to: string; text: string; mode?: SocialMode; at?: string[] }): Promise<any> {
  const text = String(opts.text ?? "").trim();
  if (!text) throw new Error("social.send: message cannot be empty");
  if (text.length > MAX_MSG_CHARS) throw new Error(`social.send: message too long (${text.length} > ${MAX_MSG_CHARS})`);
  const mode: SocialMode = opts.mode ?? "interrupt"; // 默认 interrupt（用户 2026-08-17 定稿；@DEP deferred 废弃 ISSUE 103）
  const atList = (opts.at ?? []).map(a => resolveSid(a) ?? a).filter((a): a is string => !!a);
  const fromSid = getMySid();
  const fromName = getMyName();
  if (!/^[a-f0-9]{8}$/.test(fromSid)) throw new Error("social.send: cannot determine own session id");

  const target = String(opts.to ?? "").trim();
  const receipts: any[] = [];

  // 群聊
  if (target.startsWith("group:")) {
    const gid = target.slice(6);
    const g = loadGroup(gid);
    if (!g) throw new Error(`social.send: group ${gid} not found`);
    if (!g.members.includes(fromSid) && !g.members.includes(fromName)) throw new Error(`social.send: not a member of group ${g.name}`);
    const members = g.members.map(m => resolveSid(m) ?? m).filter(m => /^[a-f0-9]{8}$/.test(m));
    // 2026-08-14 用户定稿：实时消息，离线成员不发送（跳过并在回执注明，离线投递以后再设计）
    const offlineMembers: string[] = [];
    for (const m of members) { if (!isAgentActive(m)) offlineMembers.push(m); }
    const onlineMembers = members.filter(m => !offlineMembers.includes(m));
    for (const m of onlineMembers) {
      if (m === fromSid) continue;
      receipts.push(await sendOne(m, text, mode, atList, true, gid, fromSid, fromName));
    }
    if (offlineMembers.length) {
      receipts.push({ to: `(offline: ${offlineMembers.join(",")})`, mode_used: mode, status: "skipped-offline" });
    }
    return { receipts };
  }

  // 广播
  if (target === "all" || target === "*") {
    const agents = listAgents().filter(a => a.sid !== fromSid);
    for (const a of agents) {
      receipts.push(await sendOne(a.sid, text, mode, [], false, null, fromSid, fromName));
    }
    return { receipts };
  }

  // 单发
  let toSid = resolveSid(target);
  if (!toSid) {
    // 2026-09-07 Bug1：远程 agent 名字本地 registry 解析不到 → 查 server presence 补名字路由（testor-01 报告）
    const rmt = await findRemoteAgent(target);
    if (rmt) toSid = rmt.sid;
  }
  if (!toSid) throw new Error(`social.send: unknown target "${target}" (use sid, agent name, group:<gid>, or all)`);
  if (toSid === fromSid) throw new Error("social.send: cannot message self");
  const r = await sendOne(toSid, text, mode, atList, false, null, fromSid, fromName);
  return { receipts: [r] };
}

// ── 格式化（注入给 agent 的文本）─────────────────────────────────────
export function formatPendingMsgs(msgs: SocialMsg[]): string {
  if (!msgs.length) return "";
  const lines = msgs.map(m => {
    const from = m.from_name || m.from;
    const atTag = m.at?.length ? ` (at ${m.at.join(",")})` : "";
    const modeTag = `[${m.mode_used}]`;
    // 发送时间戳（MM-DD HH:MM；无 ts 不显示）——2026-08-14 用户要求：消息带发送时间
    const ts = m.ts ? new Date(m.ts).toLocaleString("sv").slice(5, 16) : "";
    return `${modeTag} ${ts} ${from}${atTag}: ${m.text}`;
  });
  return lines.join("\n");
}

// ── interrupt/queue 跨进程触发：fs.watch triggers 目录，发现自己的触发文件 → 即时响应 ──
// （2026-08-14：interrupt = 与用户输入同级强制切断；queue = 接收方 wait（resting）时也打断，工作中留给 agent_end）
// （2026-08-18 可靠性修复：macOS fs.watch 偶发丢事件 → 触发文件滞留、wait 挂起时 agent_end 不触发 → 消息延迟/丢失。
//   新增 setInterval 扫描兑底：每 8s 检查自己的触发文件，与 watch 共用 handleTrigger；先读后 unlink 拿所有权防重复注入）
function watchInterruptTriggers(pi: ExtensionAPI): void {
  try {
    mkdirSync(TRIGGERS_DIR, { recursive: true });
    // 触发文件处理（watch 事件与 interval 兑底共用）：先读内容，再 unlink 拿所有权（失败=已被其他处理器处理→放弃防重复）
    const handleTrigger = (f: string) => {
      const mySid = getMySid();
      if (!/^[a-f0-9]{8}$/.test(mySid)) return;
      let trig: any = null;
      try { trig = JSON.parse(readFileSync(f, "utf8")); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return; }
      try { unlinkSync(f); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return; } // 拿所有权失败 → 已由 watch/interval 另一方处理，放弃
      try {
        const msgs = readInbox(mySid, 50).filter((m: SocialMsg) => !m.injected);
        // 立即注入范围：interrupt 全部（强制切断）；queue 仅在 resting（wait 中）时注入（打断 wait）
        const resting = existsSync(join(homedir(), ".teyvat", "RuntimeCache", mySid, "main-resting"));
        const toInject = msgs.filter((m: SocialMsg) => m.mode_used === "interrupt" || (resting && m.mode_used === "queue"));
        if (toInject.length) {
          // ── interrupt 唤醒 hibernated（2026-08-14 用户报修）──
          // 此前 interrupt 在 hibernated 时照常注入 → _flushBatch 开新 turn →
          // before_agent_start 见 hibernated 注入"你已进入休眠，立即停止"→ 消息丢失、状态不变。
          // interrupt 语义 = 强制打断（含休眠），必须在注入前唤醒 + 清理 hibernate 标记
          // （与 heart.ts input 唤醒同款；metaconsciousness 的 aware 仍按"hibernated 不唤醒"设计，不受影响）。
          // ISSUE 125（2026-09-04）：wait(resting) 窗口 sendMessage 会被 pi 框架吞掉（outbox 只是延迟兑底）——
          // 注入前统一打断阻塞态：resting 也先转 working（exitState 清 wait timer + main-resting），
          // interrupt/queue(resting) 的“打断 wait”语义才真正成立（实测 test-01 wait 期间 queue 滞留 8 分钟）。
          if (heartState() === "resting") {
            transition({ kind: "working" });
          }
          if (heartState() === "hibernated") {
            transition({ kind: "working" });
            try {
              try { unlinkSync(join(runtimeCacheDir(mySid), "main-hibernate")); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
              try { unlinkSync(join(runtimeCacheDir(mySid), "mc-hibernate")); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
              try { unlinkSync(join(runtimeCacheDir(mySid), "wake-at")); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
              try { unlinkSync(join(runtimeCacheDir(mySid), "wake-until")); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
            } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
          }
          const text = formatPendingMsgs(toInject);
          markInjected(mySid, toInject.map((m: SocialMsg) => m.id));
          sendCustomMessage(
            pi, "social-message", text,
            {
              from: toInject[0].from, from_name: toInject[0].from_name,
              mode: toInject[0].mode, mode_used: toInject[0].mode_used, ts: toInject[0].ts,
              ...(toInject[0].at?.length ? { at: toInject[0].at } : {}),
              interrupt: true,
            },
            { deliverAs: "interrupt" }, // agent-session.js override：abort 当前 run + 立即注入
          );
        }
        // queue 且非 resting → 留给 agent_end 轮后注入（不打断进行中的工作）
      } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 注入异常 → 消息留在 inbox（injected:false），agent_end 轮询仍能兑底 */ }
    };
    const watcher = require("fs").watch(TRIGGERS_DIR, (_evt: string, filename: string | null) => {
      if (!filename || !filename.endsWith(".json")) return;
      const mySid = getMySid();
      if (!/^[a-f0-9]{8}$/.test(mySid) || filename !== `${mySid}.json`) return; // 只处理自己的触发文件
      handleTrigger(join(TRIGGERS_DIR, filename));
    });
    watcher.unref?.();
    // 2026-08-18 兑底扫描：fs.watch 丢事件时（macOS 已知问题）触发文件会滞留，wait 挂起期间 agent_end 不触发，
    // 此定时器是唯一兑底——保证 interrupt/queue 消息最多延迟一个扫描周期（8s），不会永久丢失。
    const timer = setInterval(() => {
      try {
        const mySid = getMySid();
        if (!/^[a-f0-9]{8}$/.test(mySid)) return;
        const f = join(TRIGGERS_DIR, `${mySid}.json`);
        if (!existsSync(f)) return;
        handleTrigger(f);
      } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
    }, 8000);
    timer.unref?.();
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* fs.watch 不可用 → 降级为 agent_end 轮后注入（原行为） */ }
}

// ── 工具：单一 social 工具，action 参数区分操作 ─────────────────────
function registerSocialTools(pi: ExtensionAPI): void {
  watchInterruptTriggers(pi);
  registerPaimonTool({
    name: "social",
    label: "Social",
    messageDescription:
      "Agent-to-agent communication (all agents are equal, peer-to-peer).\n" +
      "One tool — action parameter selects the operation:\n" +
      "  action:\"send\"   to, text, mode?, at?  — send a message\n" +
      "      to: sid | agent name | group:<gid> | \"all\"\n" +
      "      mode: interrupt (alert now, default) | queue (after current turn)\n" +
      "      (deferred 已废弃: 不提醒+不能已读≈丢信, ISSUE 103)\n" +
      "      at: [sids] highlight group members (they get interrupt unless muted)\n" +
      "      receipt shows mode_used — receiver focus may downgrade your mode\n" +
      "  action:\"list\"                      — all agents + focus (public; check before sending)\n" +
      "  action:\"inbox\"  limit?             — your messages (pending first, then history)\n" +
      "  action:\"focus\"  mode?              — declare focus: off | deep | rest (no mode = show all)\n" +
      "  action:\"group\"  gop, ...           — group ops: create|list|send|mute|add|remove\n" +
      "      create: gname, members[]  /  send: gid, text, at?  /  mute: gid, on?  /  add|remove: gid, members[]\n" +
      "Messages auto-inject: interrupt immediately, queue at turn end (hibernate blocked while pending).",
    promptSnippet: "social(action, ...) — send|list|inbox|focus|group",
    parameters: Type.Object({
      action: Type.String({ messageDescription: "send | list | inbox | focus | group | global（跨设备 agents 发现：global=device 设备列表 / global+device=某设备 agents）" }),
      to: Type.Optional(Type.String({ messageDescription: "Target (send): sid | agent name | group:<gid> | all" })),
      text: Type.Optional(Type.String({ messageDescription: "Message content (send)" })),
      mode: Type.Optional(Type.Union([
        Type.Literal("interrupt"), Type.Literal("queue"), // @DEP deferred 废弃 ISSUE 103
        Type.Literal("off"), Type.Literal("deep"), Type.Literal("rest"),
      ], { messageDescription: i18n("send: interrupt|queue (deferred 废弃, ISSUE 103); focus: off|deep|rest", "send: interrupt|queue (deferred deprecated, ISSUE 103); focus: off|deep|rest") })),
      at: Type.Optional(Type.Array(Type.String(), { messageDescription: "Highlighted members (send, by sid or name)" })),
      limit: Type.Optional(Type.Number({ messageDescription: "Max messages (inbox, default 20)" })),
      history: Type.Optional(Type.Boolean({ messageDescription: "Include history in inbox (default false — pending only)" })),
      gop: Type.Optional(Type.String({ messageDescription: "Group op: create | list | send | mute | add | remove" })),
      gname: Type.Optional(Type.String({ messageDescription: "Group name (group create)" })),
      members: Type.Optional(Type.Array(Type.String(), { messageDescription: "Member sids/names (group create)" })),
      gid: Type.Optional(Type.String({ messageDescription: "Group id (group send/mute)" })),
      on: Type.Optional(Type.Boolean({ messageDescription: "Mute on/off (group mute, default true)" })),
      // global 跨设备视图参数（2026-09-05 用户定稿：social global [device | <device_id>]）
      view: Type.Optional(Type.String({ messageDescription: "global: 'device'=设备列表（默认跨设备 agents 概览）；具体 device_id=该设备 agents" })),
      device: Type.Optional(Type.String({ messageDescription: "global: 指定设备 id → 显示该设备 genshin（agent 列表）" })),
      remote: Type.Optional(Type.Boolean({ messageDescription: "list: include remote-machine agents (default false — local only)" })),
    }),
    renderCall(args: any, theme: any) {
      // 2026-08-15 统一：与 amem 一致——工具名 + action 参数，不用 "Social.Inbox" 这种分层名（用户：全是点垃圾）
      const a = args?.action ?? "";
      if (a === "send") {
        // ISSUE 113（2026-08-18 用户指示）：命令区只要一句话 "send a/an <mode> message to <to>"。
        // 2026-08-18 用户定稿（"说几百遍"）：**调用行不要正文垃圾**——正文只在结果区显示一次（renderResult），
        // 不再作为详情区 body 传进调用行（此前导致调用行显示正文 = 用户看到的垃圾）。
        // 名字用蓝紫色（accent #B1B9F9；注：bluePurple 是 vars 色值键非 colors 语义键，theme.fg 不认会抛错——ISSUE 111）。
        const toName = String(args?.to ?? "");
        const toDisplay = toName ? theme.fg("accent", toName) : "";
        const modeWord = args?.mode === "queue" ? "queue" : "interrupt";
        const article = /^[aeiou]/i.test(modeWord) ? "an" : "a";
        const title = `send ${article} ${modeWord} message to ${toDisplay}`.trim();
        return renderToolCall.detail(theme, "Social", title, "");
      }
      const d = a === "inbox" ? (args?.limit ? `(${args.limit})` : "")
        : a === "focus" ? (args?.mode ?? "")
        : a === "group" ? `${args?.gop ?? ""}${args?.gname || args?.gid ? ` ${args?.gname || args?.gid}` : ""}`
        : "";
      return renderToolCall.label(theme, "Social", [a, d].filter(Boolean).join(" "));
    },
    renderResult(result: any, _opts: any, theme: any, ctx: any) {
      const d = result?.details || {};
      const text = result?.details?._content?.[0]?.text ?? result?.content?.[0]?.text ?? "";
      if (ctx?.isError) return renderMessage.summary(theme, { isError: true }, text || "error");
      if (d.social) {
        // 借鉴 Execute：摘要行 ⎿  + 时间戳行尾(dim)，内容缩进（无 ⎿）
        const { Text, Container } = require("@earendil-works/pi-tui");
        const indent = " ".repeat(GUTTER);
        const tsStr = fmtStamp(d.ts || Date.now());
        const c = new Container();
        const a = d.action;
        let summary = a || "done";
        if (a === "send") {
          if (d.count === 1 && d.modeUsed) {
            // 单发：Sent and <mode 高亮> <名称> (<sid>, in <mode> mode)
            // ISSUE 110：接收方名字蓝紫色（accent 语义键，与调用行一致；bluePurple 不可用见 ISSUE 111）
            const name = d.targetName ?? d.target ?? "?";
            const sid = d.targetSid;
            summary = `Sent and ${theme.bold(d.modeUsed)} ${theme.fg("accent", String(name))}${sid ? ` (${sid}, in ${d.modeUsed} mode)` : ""}`;
          } else {
            summary = d.count === 1 ? `Sent to ${theme.fg("accent", d.targetDisplay ?? d.target ?? "?")}` : `Sent to ${theme.bold(String(d.count))} receivers`;
          }
        }
        else if (a === "list") summary = `Agents ${theme.bold(String(d.count ?? 0))}`;
        else if (a === "inbox") summary = `${d.count ? theme.bold(String(d.count)) : "No"} message${d.count === 1 ? "" : "s"}`;
        else if (a === "focus") summary = `focus ${theme.fg("accent", d.mode ?? "")}`;
        else if (a === "group") summary = `Group ${d.gop || ""}${d.count ? ` · ${theme.bold(String(d.count))} receivers` : ""}`;
        c.addChild(new Text(indent + theme.fg("dim", "⎿  ") + summary + "  " + theme.fg("dim", `[${tsStr}]`), 0, 0));
        // send 显示发送的具体内容（用户要求）；单发时 summary 已含接收方+mode，不再重复 receipt 行
        if (a === "send" && d.text) {
          c.addChild(new Text(indent + "  " + d.text, 0, 0));
        }
        const skipLines = a === "send" && d.count === 1;
        for (const ln of (skipLines ? [] : (d.lines || []))) {
          c.addChild(new Text(indent + "  " + ln, 0, 0));
        }
        return c;
      }
      if (!text) return renderMessage.silent();
      return renderMessage.output(theme, ctx, [{ type: "text", text }]);
    },
    async execute(_id, rawParams, _signal, _onUpdate, _ctx) {
      const action = String(rawParams?.action ?? "").trim();
      const p = (rawParams ?? {}) as any;
      switch (action) {
        case "send": {
          if (!p.to) throw new Error("social send: to required");
          if (!p.text) throw new Error("social send: text required");
          if (p.mode && !["interrupt", "queue"].includes(p.mode)) throw new Error(`social send: mode must be interrupt|queue (deferred 废弃, ISSUE 103), got "${p.mode}"`);
          const out = await sendMessage({ to: p.to, text: p.text, mode: p.mode ?? "interrupt", at: p.at ?? [] });
          const receipts = out.receipts as any[];
          const lines = receipts.map(r => `${displayName(r.to)}: ${r.status} (mode: ${r.mode_used})`);
          const toSid = receipts[0]?.to ?? "";
          const modeUsed = receipts[0]?.mode_used ?? p.mode ?? "interrupt";
          return { content: [{ type: "text", text: `Sent to ${receipts.length} receiver(s):\n${lines.map(l => "  " + l).join("\n")}\n\n${p.text}` }], details: { social: true, action: "send", count: receipts.length, target: p.to, targetDisplay: toSid ? displayName(toSid) : p.to, targetName: toSid ? displayNameShort(toSid) : p.to, targetSid: toSid, modeUsed, text: p.text, ts: Date.now(), lines } };
        }
        case "list": {
          touchPresence();
          const agents = listAgents();
          const me = getMySid();
          const now = Date.now();
          // AgentTableSync：remote=true 时拉 server presence 合并（远端 agent = 别的机器，标 remote）
          const remoteLines: string[] = [];
          if (p.remote === true) {
            try {
              const rb = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8"));
              if (rb?.token && rb?.deviceId) {
                const res = await fetch(syncEndpoint() + "/sync/agent-presence", { headers: { "Authorization": `Bearer ${rb.token}`, "X-Device-Id": rb.deviceId, "User-Agent": SYNC_UA } });
                const body: any = await res.json();
                const localIds = new Set(agents.map(a => a.sid));
                for (const ra of (body?.agents ?? [])) {
                  if (localIds.has(ra.sid)) continue; // 本机 agent 已在本地列表
                  const lastTs = Date.parse(String(ra.last_seen).replace(" ", "T") + "Z") || 0;
                  const ago = lastTs ? Math.max(0, Math.floor((now - lastTs) / 1000)) : -1;
                  const online = ago >= 0 && ago < 300; // server 5min expirePresence 窗口
                  const state = online ? "online" : ago >= 0 ? `${Math.floor(ago / 60)}m ago` : "unknown";
                  remoteLines.push(`${ra.name} (${ra.sid})  focus:${ra.focus}  ${state}  remote:${ra.device_id === rb.deviceId ? "?" : "other"}  ${ra.version} ${ra.model}`);
                }
              }
            } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* remote 拉取失败不影响本地列表 */ }
          }
          const allCount = agents.length + remoteLines.length;
          if (!allCount && !remoteLines.length) return { content: [{ type: "text", text: "(no agents registered)" }], details: { social: true, action: "list", count: 0, lines: [] } };
          const lines = agents.map(a => {
            const mark = a.sid === me ? " (me)" : "";
            const ago = a.lastSeen > 0 ? Math.max(0, Math.floor((now - a.lastSeen) / 1000)) : -1;
            const online = ago >= 0 && ago < 600;
            const state = online ? "online" : ago >= 0 ? `${Math.floor(ago / 60)}m ago` : "never";
            return `${a.name} (${a.sid})${mark}  focus:${a.focus}  ${state}  ${a.version} ${a.model}`;
          }).concat(remoteLines.length ? [`-- remote (${remoteLines.length}) --`].concat(remoteLines) : []);
          return { content: [{ type: "text", text: `Agents (${allCount}):\n${lines.map(l => "  " + l).join("\n")}` }], details: { social: true, action: "list", count: allCount, lines } };
        }
        case "global": {
          // 跨设备 agents 发现（2026-09-05 用户定稿）：拉 /auth/devices（设备+各设备上传的 genshin 结果）
          // 视图：默认=跨设备 agents 概览；view="device"=设备列表；device=<id>=该设备 genshin 输出
          let b: any = null;
          try { b = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8")); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 未绑定/损坏 → 下方提示 login */ }
          if (!b?.token || !b?.deviceId) return { content: [{ type: "text", text: "(未绑定——先 genshin login)" }], details: { social: true, action: "global", count: 0, lines: [] } };
          const H = { Authorization: "Bearer " + b.token, "X-Device-Id": b.deviceId, "X-Device-Name": require("os").hostname(), "User-Agent": SYNC_UA };
          const _url = syncEndpoint() + "/auth/devices";
          let res: Response;
          try { res = await fetch(_url, { headers: H }); } catch (e: any) {
            // 2026-09-05 诊断：fetch 网络层异常 → 返回真实信息（含 URL/cause）定位
            return { content: [{ type: "text", text: "(global 网络错误: " + (e?.message || e) + (e?.cause?.message ? " | cause: " + e.cause.message : "") + " | url=" + _url + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
          }
          if (!res.ok) return { content: [{ type: "text", text: "(server 查询失败: HTTP " + res.status + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
          const j: any = await res.json();
          const ds = (j?.devices ?? []).filter((d: any) => d.device_id === b.deviceId || (d.agents && String(d.agents).length > 2) || !d.archived);
          const fmtTs = (s: string) => { if (!s) return ""; try { return new Date(String(s).replace(" ", "T") + "Z").toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return s; } };
          // 视图 2：device=<id> → 该设备 genshin 输出全文
          if (p.device) {
            const hit = ds.find((d: any) => String(d.device_id) === String(p.device));
            if (!hit) return { content: [{ type: "text", text: "(找不到设备 " + p.device + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
            const name = hit.device_name && hit.device_name !== hit.device_id ? hit.device_name : hit.device_id;
            const raw = hit.agents;
            const txt = typeof raw === "string" ? raw : "(该设备还没上传 genshin 结果)";
            return { content: [{ type: "text", text: "── " + name + " 的 genshin" + (hit.synced_at ? " (快照 " + fmtTs(hit.synced_at) + ")" : "") + ": ──\n" + txt }], details: { social: true, action: "global", view: p.device, count: 1, lines: [] } };
          }
          // 视图 1：view="device" → 设备列表
          if (p.view === "device") {
            const lines: string[] = [];
            for (const d of ds) {
              const name = d.device_name && d.device_name !== d.device_id ? d.device_name : d.device_id;
              const nAgents = typeof d.agents === "string" && d.agents ? (String(d.agents).match(/·\s*(\d+)\s*agents/) || [])[1] || "?" : "0";
              lines.push("  " + name + " (" + d.device_id + ")  agents:" + nAgents + (d.synced_at ? "  同步:" + fmtTs(d.synced_at) : "") + (String(d.device_id) === b.deviceId ? "  [本机]" : ""));
            }
            return { content: [{ type: "text", text: "设备 (" + ds.length + "):\n" + lines.join("\n") }], details: { social: true, action: "global", view: "device", count: ds.length, lines } };
          }
          // 默认：跨设备 agents 概览——每设备一行（agent 数从 genshin 输出 "· N agents" 提取）
          const lines: string[] = [];
          for (const d of ds) {
            const name = d.device_name && d.device_name !== d.device_id ? d.device_name : d.device_id;
            const raw = typeof d.agents === "string" ? d.agents : "";
            const nAgents = (String(raw).match(/·\s*(\d+)\s*agents/) || [])[1] || "0";
            lines.push("  " + name + " (" + d.device_id + ")" + (String(d.device_id) === b.deviceId ? "  [本机]" : "") + "  · " + nAgents + " agents" + (d.synced_at ? "  同步:" + fmtTs(d.synced_at) : ""));
          }
          if (!lines.length) return { content: [{ type: "text", text: "(无设备——多设备跑过 genshin d 后可见)" }], details: { social: true, action: "global", count: 0, lines: [] } };
          return { content: [{ type: "text", text: "跨设备 (" + ds.length + " 设备):\n" + lines.join("\n") + "\n\n细节: social({action:'global',view:'device'}) 设备列表；social({action:'global',device:'<id>'}) 看设备 agents" }], details: { social: true, action: "global", count: ds.length, lines } };
        }
        case "inbox": {
          const limit = Math.min(50, Math.max(1, p.limit ?? 20));
          const msgs = readInbox(getMySid(), 200);
          const pending = msgs.filter(m => !m.injected);
          const lines: string[] = [];
          // 默认只看 pending（待处理），不刷历史；history:true 才带
          if (pending.length) {
            lines.push(`-- pending (${pending.length}) --`);
            for (const m of pending) lines.push(`[${m.mode_used}] ${m.from_name} (${fmtTime(m.ts)}): ${m.text}`);
          }
          if (p.history === true) {
            const history = msgs.filter(m => m.injected).slice(-Math.max(0, limit - pending.length));
            if (history.length) {
              lines.push(`-- history (${history.length}) --`);
              for (const m of history) lines.push(`${m.from_name} (${fmtTime(m.ts)}): ${m.text}`);
            }
          }
          if (!lines.length) return { content: [{ type: "text", text: "(inbox empty)" }], details: { social: true, action: "inbox", count: 0, lines: [] } };
          return { content: [{ type: "text", text: lines.map(l => l.startsWith("--") ? l : "  " + l).join("\n") }], details: { social: true, action: "inbox", count: pending.length, lines } };
        }
        case "focus": {
          const mode = p.mode as SocialFocus | undefined;
          if (mode) {
            if (!["off", "deep", "rest"].includes(mode)) throw new Error(`social focus: mode must be off|deep|rest, got "${mode}"`);
            setFocus(mode);
            return { content: [{ type: "text", text: `focus set to ${mode}` }], details: { social: true, action: "focus", mode, lines: [] } };
          }
          const agents = listAgents();
          const lines = agents.map(a => `${a.name} (${a.sid})${a.sid === getMySid() ? " (me)" : ""}: ${a.focus}`);
          return { content: [{ type: "text", text: `Focus states:\n${lines.map(l => "  " + l).join("\n")}` }], details: { social: true, action: "focus", mode: "", lines } };
        }
        case "group": {
          const gop = String(p.gop ?? "").trim();
          const me = getMySid();
          switch (gop) {
            case "create": {
              const name = String(p.gname ?? "").trim();
              if (!name) throw new Error("social group create: gname required");
              const members = (p.members ?? [])
                .map((m: string) => resolveSid(String(m).trim()) ?? String(m).trim())
                .filter((m: string) => !!m && m !== me);
              const gid = `g${Date.now().toString(36)}`;
              const g: Group = { id: gid, name, members: [me, ...members], created: Date.now() };
              saveGroup(g);
              return { content: [{ type: "text", text: `Group "${name}" created (${gid})\nmembers: ${g.members.join(", ")}` }], details: { social: true, action: "group", gop: "create", lines: [`${gid} "${name}"`, `members: ${g.members.join(", ")}`] } };
            }
            case "list": {
              const gs = myGroups();
              if (!gs.length) return { content: [{ type: "text", text: "(no groups)" }], details: { social: true, action: "group", gop: "list", count: 0, lines: [] } };
              const mutes = loadMutes();
              const lines = gs.map(g => `${g.id} "${g.name}" (${g.members.length} members)${mutes.includes(g.id) ? " [@muted]" : ""}`);
              return { content: [{ type: "text", text: `Groups:\n${lines.map(l => "  " + l).join("\n")}` }], details: { social: true, action: "group", gop: "list", count: gs.length, lines } };
            }
            case "send": {
              const gid = String(p.gid ?? "").trim();
              const text = String(p.text ?? "").trim();
              if (!gid) throw new Error("social group send: gid required");
              if (!text) throw new Error("social group send: text required");
              const g = loadGroup(gid);
              if (!g) throw new Error(`social group send: group ${gid} not found`);
              const at = (p.at ?? []).map((a: string) => resolveSid(String(a).trim()) ?? String(a).trim()).filter(Boolean);
              const out = await sendMessage({ to: `group:${gid}`, text, mode: "interrupt", at }); // @DEP deferred→interrupt（ISSUE 103，群发默认 interrupt 保证送达）
              const receipts = out.receipts as any[];
              const lines = receipts.map(r => `${displayName(r.to)}: ${r.status} (mode: ${r.mode_used})`);
              return { content: [{ type: "text", text: `Group "${g.name}" (${receipts.length} receivers):\n${lines.map(l => "  " + l).join("\n")}` }], details: { social: true, action: "group", gop: "send", count: receipts.length, lines } };
            }
            case "mute": {
              const gid = String(p.gid ?? "").trim();
              if (!gid) throw new Error("social group mute: gid required");
              const g = loadGroup(gid);
              if (!g) throw new Error(`social group mute: group ${gid} not found`);
              const on = p.on !== false;
              setGroupMute(gid, on);
              return { content: [{ type: "text", text: `@ alerts ${on ? "muted" : "unmuted"} for group ${g.name} (${gid})` }], details: { social: true, action: "group", gop: "mute", lines: [`@ alerts ${on ? "muted" : "unmuted"} for ${g.name} (${gid})`] } };
            }
            case "add": {
              const gid = String(p.gid ?? "").trim();
              if (!gid) throw new Error("social group add: gid required");
              const g = loadGroup(gid);
              if (!g) throw new Error(`social group add: group ${gid} not found`);
              const addMembers = (p.members ?? []).map((m: string) => resolveSid(String(m).trim()) ?? String(m).trim()).filter(Boolean);
              if (!addMembers.length) throw new Error("social group add: members required");
              const added: string[] = [];
              for (const m of addMembers) { if (!g.members.includes(m)) { g.members.push(m); added.push(m); } }
              saveGroup(g);
              return { content: [{ type: "text", text: `Added ${added.length} member(s) to ${g.name}: ${added.map(displayName).join(", ") || "(none new)"}\nmembers (${g.members.length}): ${g.members.map(displayName).join(", ")}` }], details: { social: true, action: "group", gop: "add", lines: [`${added.length} added: ${added.map(displayName).join(", ") || "(none new)"}`, `members (${g.members.length}): ${g.members.map(displayName).join(", ")}`] } };
            }
            case "remove": {
              const gid = String(p.gid ?? "").trim();
              if (!gid) throw new Error("social group remove: gid required");
              const g = loadGroup(gid);
              if (!g) throw new Error(`social group remove: group ${gid} not found`);
              const rm = (p.members ?? []).map((m: string) => resolveSid(String(m).trim()) ?? String(m).trim()).filter(Boolean);
              if (!rm.length) throw new Error("social group remove: members required");
              const before = g.members.length;
              g.members = g.members.filter(m => !rm.includes(m));
              saveGroup(g);
              const removed = before - g.members.length;
              return { content: [{ type: "text", text: `Removed ${removed} member(s) from ${g.name}\nmembers (${g.members.length}): ${g.members.map(displayName).join(", ")}` }], details: { social: true, action: "group", gop: "remove", lines: [`${removed} removed`, `members (${g.members.length}): ${g.members.map(displayName).join(", ")}`] } };
            }
            default:
              throw new Error(`social group: unknown gop "${gop}" (create|list|send|mute|add|remove)`);
          }
        }
        default:
          throw new Error(`social: unknown action "${action}" (send|list|inbox|focus|group)`);
      }
    },
  });
}

// ── 消息渲染器（blockrender 兼容）────────────────────────────────────
function registerSocialRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("social-message", (message: any, _opts: any, theme: any) => {
    const { Container, Text } = require("@earendil-works/pi-tui");
    const d = message.details || {};
    const from = d.from_name || d.from || "unknown";
    const mode = d.mode_used || d.mode || "";
    const atTag = d.at?.length ? ` @${d.at.join(",")}` : "";
    // 收到消息：➤ from [mode] · HH:MM（时间戳在标签行尾，不沉底）— 专属 socialMessage 青蓝色
    // 2026-08-18 调暗：原 #4FC1FF（L65%）→ #3DBBFF（L62%，用户：message 太亮，与鲢鱼蓝 Result #718EF4 协调）
    // 2026-08-18 符号：◆ → ▸ → ➤（用户定稿：消息 ➤ / Result • / 事件 ✤；2026-08-27 Result 符号 » 改蓝点 •）
    const tsTag = d.ts ? ` · ${fmtTime(d.ts)}` : "";
    const label = `${from}${atTag} [${mode}]${tsTag}`;
    const content = (message.content ?? "").toString();
    const c = new Container();
    c.addChild(new Text(theme.fg("socialMessage", "➤") + " " + theme.fg("socialMessage", theme.bold(label)), 0, 0));
    if (content) {
      // 内容用 markdown 同款行号渲染（blocks_nongod.lineNumbered）；每行独立 Text 保证对齐
      const rendered = lineNumbered(content, theme);
      const contIndent = " ".repeat(GUTTER);
      for (const line of rendered.split("\n")) c.addChild(new Text(contIndent + line, 0, 0));
    }
    return c;
  });
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// 标准时间戳（带年/毫秒）：2026-08-14 03:40:09.641
function fmtStamp(ts: number = Date.now()): string {
  const d = new Date(ts);
  const p2 = (x: number) => String(x).padStart(2, "0");
  const p3 = (x: number) => String(x).padStart(3, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

// ── 器官入口 ──────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // 身份：从 session file 解析 sid（同 brain.intentions）
  pi.on("session_start", async (_event, ctx) => {
    try {
      const sf = (ctx as any).sessionManager?.getSessionFile?.();
      if (sf) {
        const m = sf.match(/([a-f0-9]{8})\//);
        if (m) {
          _mySid = m[1];
          _personDir = join(homedir(), ".teyvat", "MemoryData", m[1]);
          _myName = process.env.PAIMON_AGENT_NAME || _mySid;
          registerSelf();
        }
      }
    } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
  });

  registerSocialTools(pi);
  registerSocialRenderer(pi);
  // 2026-09-07：跨设备 presence/接收独立周期（修复缺陷：原来挂 touchPresence 依赖 getPendingInbox 调用——
  // wait/hibernate/无消息时永不触发 → server presence 掉线 + 远端消息不拉）。独立 45s timer：
  // reportPresence(up) 维持 server presence + pullRemoteMessages 拉远端消息写本地 inbox。
  // 与 touchPresence 30s 节流互补（消息活跃时双保险）。unref：不阻止 agent 进程正常退出。
  const _netTick = setInterval(() => {
    try { reportPresence("up").catch(() => {}); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 静默 */ }
    try { pullRemoteMessages().catch(() => {}); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 静默 */ }
  }, 45_000);
  if (typeof (_netTick as any)?.unref === "function") (_netTick as any).unref();
}
