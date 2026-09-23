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
import { renderToolCall, renderMessage, GUTTER, lineNumbered, SYM } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, statSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";
import { socialDataDir, logerr, runtimeCacheDir, syncEndpoint, SYNC_UA, writeFileAtomic } from "#paths";   // SYNC_UA 统一在 paths.ts（唯一真相源）
// heart-state：interrupt 唤醒 hibernated 用（communicate → heart-state 无环；heart.ts 反向 import communicate）
import { transition, heartState } from "../kernel.heart/heart-state.ts";

// ── 常量 ──────────────────────────────────────────────────────────────
// @DEP deferred 废弃（ISSUE 103）：类型字面量保留仅为兼容历史 inbox 数据（旧消息 mode_used 可能是 "deferred"），新发送不再允许
// 2026-09-24：muted **不是投递模式**（interrupt/queue 才是）——它是「**接收方未读状态**」，
// 且 **发送方不得决定、也不得知道**接收方是否静音（隐私）；由接收方在注入那一刻用自己的设置裁决。
export type SocialMode = "interrupt" | "queue" | "deferred";
export type SocialFocus = "off" | "deep" | "rest";

export const SOCIAL_DIR = socialDataDir();
const REGISTRY_FILE = join(SOCIAL_DIR, "registry.json");
const INBOX_DIR = join(SOCIAL_DIR, "inbox");
const GROUPS_DIR = join(SOCIAL_DIR, "groups");
const MUTES_DIR = join(SOCIAL_DIR, "mutes");
// public：公共聊天室（有生命周期的房间 + 追加式消息日志）——2026-09-24 champion-01 加
const PUBLIC_DIR = join(SOCIAL_DIR, "public_rooms");
// interrupt 跨进程触发文件目录：发送方写 <接收方sid>.json，接收方 fs.watch 即时响应（强制切断）
const TRIGGERS_DIR = join(SOCIAL_DIR, "triggers");
// 2026-09-07：外部框架 bridge agent 心跳目录（claude-code-bridge 等——非 teyvat 进程，无 MemoryData/<sid>/main.pid）
// 外部 agent 周期 touch SocialData/heartbeat/<sid>（内容随意）→ isAgentActive 视为在线（90s 窗口）
const HEARTBEAT_DIR = join(SOCIAL_DIR, "heartbeat");

const MAX_MSG_CHARS = 16_384;
// Cloudflare Bot Management 拦截无/默认 User-Agent（Error 1010）——所有到 sync server 的 fetch 必须带
// SYNC_UA 已移到 paths.ts 统一导出（2026-09-11）：漏 UA 会被 Cloudflare 403 error 1010

interface SocialMsg {
  id: string;
  from: string;        // sid
  from_name: string;
  to: string;          // sid | group:<gid> | public:<rid> | all
  chan?: string;       // 群/房间显示名（group 名或 public 房间名；public 属于 group 的一种；DM 无）
  chan_id?: string;    // 群/房间编号（创建时生成、**不可更改**）
  muted?: boolean;     // **接收方本地标注**（粘性）：该条被我静音的房间拦下、永不自动注入，只能 check-message 手动取。
                       // 注意：它不是发送方写的——发送方既不知道也无权决定（隐私，2026-09-24 用户定稿）
  mode: SocialMode;    // 发送方请求
  mode_used: SocialMode; // 实际生效
  at?: string[];       // @ 强调（群聊）
  text: string;
  ts: number;
  injected: boolean;   // 是否已注入接收方上下文
  pub?: string;        // E2E（2026-09-13）：发送方公钥（SPKI DER base64，随消息分发，公钥无密）
  enc?: { v: number; pub: string; iv: string };  // E2E：text = base64(ct+gcmTag)，用本端私钥 + enc.pub 派生密钥解密
}

interface Group {
  id: string;
  name: string;
  members: string[];
  created: number;
}

// public 房间（champion-01 2026-09-24）：与 Group 的区别——可主动 join/leave、可发现、有生命周期（closed/ttl）、
// 消息落盘成追加式日志（有 seq，可 history 续读），成员可对房间单独静音
interface PublicRoom {
  id: string;
  name: string;
  members: string[];      // 成员 sid
  member_names?: Record<string, string>;  // 成员注册名（2026-09-24 用户要求：注册身份必须有名字，不能只有 id）
  created: number;
  created_by: string;
  closed: boolean;
  closed_at?: number;
  closed_reason?: "dissolved" | "expired";   // 解散 vs TTL 过期（列表措辞据此区分）
  ttl_minutes?: number;   // 可选：N 分钟无消息自动关闭（<=0 或未设 = 不过期）
}

interface RegistryEntry {
  name: string;
  version: string;
  model: string;
  modelProvider?: string;
  lastSeen: number;
  focus: SocialFocus;
}

// ── 身份 ──────────────────────────────────────────────────────────────
let _mySid = "";
let _myName = "";
let _nameFromIdentity = "";
let _nameRefreshedAt = 0;
let _personDir = "";

function getMySid(): string {
  if (_mySid) return _mySid;
  // 测试/调试支持：PI_SOCIAL_SID 覆盖 session 解析（standalone 脚本用，不部署）
  const env = process.env.PI_SOCIAL_SID;
  return env && /^[a-f0-9]{8}$/.test(env) ? env : "";
}
function getMyName(): string {
  // 2026-09-24（ISSUE 275）：名字优先从 identity.json 解析（30s 缓存），不永久缓存 env——
  // 否则改名后（plist/identity.json 更新）运行中进程的 env 还是旧名，社交渲染/footer/DNA 头全是旧名，full-reboot 也无效。
  if (Date.now() - _nameRefreshedAt > 30_000) {
    const n = readNameFromIdentity();
    if (n) { _nameFromIdentity = n; _nameRefreshedAt = Date.now(); }
  }
  return _nameFromIdentity || _myName || process.env.PAIMON_AGENT_NAME || getMySid() || "unknown";
}

// 从 ~/.teyvat/IdentityData/<sid>/identity.json 读当前 name（改名后这里最先更新）
function readNameFromIdentity(): string {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) return "";
  try {
    const idFile = join(homedir(), ".teyvat", "IdentityData", sid, "identity.json");
    if (!existsSync(idFile)) return "";
    const d = JSON.parse(readFileSync(idFile, "utf8"));
    return typeof d?.name === "string" && d.name ? d.name : "";
  } catch { return ""; }
}

// 心跳时调用：检测 identity.json 的 name 是否变了，变了就同步 env + process.title + 缓存（下次 registry 写入用新名）
function syncNameFromIdentity(): void {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) return;
  const n = readNameFromIdentity();
  if (!n || n === _myName) return;
  const prev = _myName;
  _myName = n;
  _nameFromIdentity = n;
  _nameRefreshedAt = Date.now();
  try { process.env.PAIMON_AGENT_NAME = n; } catch { /* env 只读则忽略 */ }
  try { if (process.title && process.title.startsWith("genshin:")) process.title = process.title.replace(/^genshin:[^(]+/, `genshin:${n}`); } catch { /* title 只读则忽略 */ }
  console.error(`[social] name changed ${prev} → ${n}（synced env/title）`);
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
  // 2026-09-24（ISSUE 275）：心跳时先检测改名（identity.json name 变化）→ 同步 env/title，后续 registry 写入用新名。
  syncNameFromIdentity();
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
// 2026-09-11（prime-agent）：presence 失败日志限流。
// 实证：网络抖动时这个 catch 每 45s 触发一次、每次都写完整堆栈 —— 24 小时灌了 90 条，
// 7 天 303 条，是 catch-errors.log 长到 86MB 的主要来源（用户纪律③：日志噪音要治）。
// 规则：同一个方向 5 分钟内只记第一条；恢复后（下一条又写进日志时）自然是新的一条。
const PRESENCE_ERR_QUIET_MS = 5 * 60 * 1000;
const _presenceErrAt: Record<string, number> = {};
async function reportPresence(kind: "up" | "down"): Promise<void> {
  if (_reportInFlight) return;
  try {
    let b: any = null;
    try { b = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8")); } catch (e) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return; } // 未登录（无 binding.json）是正常态，不每 45s 刷一条
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
      try { agentsHeader = JSON.stringify(listAgents().map((a: any) => ({ sid: a.sid, name: a.name, version: a.version, model: a.model, focus: a.focus, state: agentLocalState(a.sid) }))); } catch { /* 清单构造失败不阻塞 presence 上报 */ }
      const headers: Record<string, string> = { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "Content-Type": "application/json", "User-Agent": SYNC_UA, "X-Device-Name": require("os").hostname() };
      if (agentsHeader) headers["X-Device-Agents"] = agentsHeader;
      // 2026-09-13：加超时——之前无超时，fetch 挂起时 _reportInFlight 一直为 true，后续所有 tick 静默跳过，直到 OS 断连才恢复
      await fetch(ep + "/sync/agent-presence", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    } else {
      await fetch(`${ep}/sync/agent-presence/${sid}`, { method: "DELETE", headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA }, signal: AbortSignal.timeout(10_000) });
    }
  } catch (e) {
    const now = Date.now();
    // 2026-09-13：限流改为跨进程——进程内变量各记各的，6 个 agent 进程各自 45s tick，同一网络抖动被记 6 遍（实证 235 条）。
    // 用 ErrorData/presence-err.<kind> 标记文件的 mtime 做全局 5 分钟节流；日志附 undici 的 cause code（"fetch failed" 本身不带原因）。
    if (now - (_presenceErrAt[kind] || 0) > PRESENCE_ERR_QUIET_MS && !_presenceQuietGlobal(kind, now)) {
      _presenceErrAt[kind] = now;
      const cause = (e as any)?.cause?.code || (e as any)?.name || "";
      logerr("SOC-PRESENCE", e, "reportPresence(" + kind + ")" + (cause ? ` cause=${cause}` : "") + " pid=" + process.pid + "（网络抖动类失败全机 5 分钟最多记一条）");
    }
  }
  finally { _reportInFlight = false; }
}
function _presenceQuietGlobal(kind: string, now: number): boolean {
  const dir = join(homedir(), ".teyvat", "ErrorData");
  const f = join(dir, `presence-err.${kind}`);
  try { if (now - statSync(f).mtimeMs < PRESENCE_ERR_QUIET_MS) return true; } catch { /* 无标记 = 不安静 */ }
  try { mkdirSync(dir, { recursive: true }); writeFileSync(f, String(now)); } catch { /* 写不了标记就退回进程内限流 */ }
  return false;
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
    // 2026-09-13（同上）：兼容两种返回形态——interactive-mode 的 AgentSession.model（带 .id）与 heart 挂的 ctx.model（Model 对象，同样 .id；SessionContext.model 形态则是 .modelId）
    const _gm = (globalThis as any).__genshinGetModel?.();
    const curModel = _gm?.id ?? _gm?.modelId;
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

// 2026-09-08（用户：状态机 AHW+FBO——自创 [在线] 乱做）：返回本机 agent 状态机态（仿 list.cjs——AHW=运行态 A/P/W/H + FB=位置态 F/B detached）
// 用于心跳清单上报（device_states agents 带 state）→ 跨设备显示与 CLI 列表状态机一致
function agentLocalState(sid: string): string {
  try {
    const f = require("fs");
    const rc = join(homedir(), ".teyvat", "RuntimeCache", sid);
    const mem = join(homedir(), ".teyvat", "MemoryData", sid);
    const ahw = (f.existsSync(join(mem, "paused")) || f.existsSync(join(rc, "paused"))) ? "P"
      : f.existsSync(join(rc, "main-resting")) ? "W"
      : f.existsSync(join(rc, "main-hibernate")) ? "H" : "A";
    const fb = f.existsSync(join(rc, "detached")) ? "B" : "F";
    return ahw + fb;
  } catch { return "AF"; }
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
  } catch { /* 无 pid 文件 / 进程不存在 / 心跳超时 = 离线——正常判定，不刷日志（2026-09-07 纪律③：高频判定 stat ENOENT 刷屏 5MB） */ }
  // bridge 心跳 fallback（外部 agent）
  try {
    const hb = join(HEARTBEAT_DIR, sid);
    const hst = require("fs").statSync(hb);
    if (Date.now() - hst.mtimeMs <= 90_000) return true;
  } catch { /* 无心跳文件 = 非 bridge agent——静默 */ }
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
// 2026-09-07（用户反馈：远端 agent send 渲染显示 id 而非 name）：远端名字缓存——remoteSendOne 查 presence 时填充，displayName/displayNameShort 读它。
const remoteNameCache = new Map<string, string>();
function displayName(sid: string): string {
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  const e = reg[sid];
  if (e) return `${e.name} (${sid})`;
  const remote = remoteNameCache.get(sid);
  return remote ? `${remote} (${sid})` : sid;
}
function displayNameShort(sid: string): string {
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  if (reg[sid]?.name) return reg[sid].name;
  return remoteNameCache.get(sid) ?? sid;
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

// ── public 聊天室（champion-01 2026-09-24）─────────────────────────────
// 元数据：<SOCIAL_DIR>/public_rooms/<rid>.json；消息：<rid>.msgs.jsonl（追加式，seq 从 1）
function publicMsgFile(rid: string): string { return join(PUBLIC_DIR, `${rid}.msgs.jsonl`); }
function loadPublic(rid: string): PublicRoom | null {
  return readJson<PublicRoom | null>(join(PUBLIC_DIR, `${rid}.json`), null);
}
function savePublic(r: PublicRoom): void {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeJson(join(PUBLIC_DIR, `${r.id}.json`), r);
}
function listPublics(): PublicRoom[] {
  try {
    mkdirSync(PUBLIC_DIR, { recursive: true });
    return readdirSync(PUBLIC_DIR).filter(f => f.endsWith(".json")).map(f => readJson<PublicRoom | null>(join(PUBLIC_DIR, f), null)).filter((r): r is PublicRoom => !!r);
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return []; }
}
// TTL 惰性回收（用户要求「可临时建立的聊天室」）：任何一次 public 操作前先回收过期房间。
//   「最后活动」= max(创建时刻, 最后一条消息时刻)；超过 ttl_minutes 未活动 → 自动解散（历史保留）。
//   不做后台定时器（避免常驻开销与多进程竞争），只在被访问时判定。
function sweepExpiredPublics(): void {
  try {
    for (const r of listPublics()) {
      if (r.closed || !r.ttl_minutes || r.ttl_minutes <= 0) continue;
      const msgs = readPublicMsgs(r.id);
      const lastMsg = msgs.length ? (Number(msgs[msgs.length - 1].ts) || 0) : 0;
      const lastActivity = Math.max(Number(r.created) || 0, lastMsg);
      if (Date.now() - lastActivity > r.ttl_minutes * 60_000) {
        r.closed = true;
        r.closed_at = Date.now();
        r.closed_reason = "expired";
        savePublic(r);
      }
    }
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
}
function myPublics(): PublicRoom[] {
  const me = getMyName();
  return listPublics().filter(r => r.members.includes(me) || r.members.includes(getMySid()));
}
// 房间消息日志（追加式 jsonl；坏行跳过并记日志，不静默吞——NORM-006）
function readPublicMsgs(rid: string): any[] {
  try {
    const raw = readFileSync(publicMsgFile(rid), "utf8");
    return raw.split("\n").filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] bad jsonl line in " + rid + ": " + ((e as any)?.message || e)); return null; }
    }).filter(Boolean);
  } catch (e) {
    if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e));
    return [];
  }
}
function appendPublicMsg(rid: string, m: any): void {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  appendFileSync(publicMsgFile(rid), JSON.stringify(m) + "\n", "utf8");
}
// public 房间静音（per-agent，两级：mute=房间静音 / at_mute=@ 也静音）
// 语义（2026-09-24 用户定稿）：
//   - 默认 @ 可**突破静音**（@ 到你 = interrupt，不管你否 mute 了房间）
//   - 可再启用 at_mute → 连 @ 也不打断
//   - 但**不能单独启用 at_mute**（必须 mute 已开）
type PublicMuteState = { mute?: boolean; at_mute?: boolean };

// 存储兼容（重要，2026-09-24 联调发现跨版本不兼容）：
//   <sid>.public.json    = **字符串数组**（房间静音列表）—— 老版本代码按数组读，必须保持数组格式，
//                          否则旧进程读到 map 会 `.includes is not a function` 炸（实测事故）
//   <sid>.public-at.json = 字符串数组（@ 也静音的房间列表）—— 新文件，老版本不读，天然安全
// 读时兼容过渡期的 map 格式，**写一律用数组**（向后兼容优先）
function loadPublicMutesOf(sid: string): string[] {
  const raw = readJson<any>(join(MUTES_DIR, `${sid}.public.json`), []);
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === "object") return Object.entries(raw).filter(([, v]) => !!(v as any)?.mute).map(([k]) => k);
  return [];
}
function loadPublicAtMutesOf(sid: string): string[] {
  // 注意：默认值必须用 null——若用 []，文件不存在时会命中 Array.isArray([]) 提前返回，回退分支永远不可达（实测踩过）
  const raw = readJson<any>(join(MUTES_DIR, `${sid}.public-at.json`), null);
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === "object") return Object.entries(raw).filter(([, v]) => !!(v as any)?.at_mute).map(([k]) => k);
  // 过渡期迁移：at_mute 曾存在旧 map 格式的 <sid>.public.json 里 → 读时也捞一遍
  // （实测事故：只读 -at.json 会让过渡期的 at_mute 丢失 → @ 静音失效）
  const legacy = readJson<any>(join(MUTES_DIR, `${sid}.public.json`), null);
  if (legacy && !Array.isArray(legacy) && typeof legacy === "object") return Object.entries(legacy).filter(([, v]) => !!(v as any)?.at_mute).map(([k]) => k);
  return [];
}
function saveMuteList(file: string, list: string[]): void {
  mkdirSync(MUTES_DIR, { recursive: true });
  writeJson(join(MUTES_DIR, file), list);
}
function loadPublicMuteStateOf(sid: string, rid: string): PublicMuteState {
  return { mute: loadPublicMutesOf(sid).includes(rid), at_mute: loadPublicAtMutesOf(sid).includes(rid) };
}
// 接收方裁决（2026-09-24 用户定稿）：这条消息对我而言是否「被静音房间」的消息。
//   —— **只有我自己的静音设置参与判定**；发送方既不知道也无权决定（隐私）。
//   —— @ 默认突破；mute+at_mute 双开则 @ 也不突破。
function isChanMutedByMe(m: any): boolean {
  const rid = m?.chan_id;
  if (!rid) return false;
  const st = loadPublicMuteStateOf(getMySid(), String(rid));
  if (!st.mute) return false;
  const isAt = Array.isArray(m.at) && m.at.includes(getMySid());
  return !(isAt && !st.at_mute);
}
// 统一设置入口：mute / at_mute 联动（at_mute 必须在 mute 之上）
function setPublicMuteFlags(rid: string, next: { mute?: boolean; at_mute?: boolean }): PublicMuteState {
  const sid = getMySid();
  if (!/^[a-f0-9]{8}$/.test(sid)) throw new Error("social public manage: cannot determine own session id");
  const mutes = loadPublicMutesOf(sid);
  const atMutes = loadPublicAtMutesOf(sid);
  const curMute = mutes.includes(rid);
  let mute = curMute;
  let atMute = atMutes.includes(rid);
  if (next.mute !== undefined) {
    const turningOn = next.mute === true && !curMute;
    mute = next.mute === true;
    if (!mute) atMute = false;                                                     // 关房间静音 → 连带关 @静音
    else if (turningOn && next.at_mute === undefined) atMute = false;               // 新开静音 → @ 默认不静音
  }
  if (next.at_mute !== undefined) atMute = next.at_mute === true;
  if (atMute && !mute) throw new Error("social public manage: 不能单独启用 @静音——请先开房间静音（mute:true），再设 at_mute:true");
  const setIn = (list: string[], val: boolean) => { const i = list.indexOf(rid); if (val && i < 0) list.push(rid); if (!val && i >= 0) list.splice(i, 1); return list; };
  saveMuteList(`${sid}.public.json`, setIn(mutes, mute));
  saveMuteList(`${sid}.public-at.json`, setIn(atMutes, atMute));
  return { mute, at_mute: atMute };
}
function setPublicMute(rid: string, on: boolean): void {
  setPublicMuteFlags(rid, { mute: on });
}
// 房间查找：接受编号（pXXXX）**或名称**（2026-09-24 用户要求：id/name 都可用）
function findPublic(idOrName: string): PublicRoom | null {
  const key = String(idOrName ?? "").trim();
  if (!key) return null;
  const byId = loadPublic(key);
  if (byId) return byId;
  const matches = listPublics().filter(r => r.name === key);
  if (matches.length > 1) throw new Error(`social public: 房间名 "${key}" 不唯一（${matches.length} 个）——请改用编号`);
  return matches[0] ?? null;
}
// 本地 registry 里的名字（查不到返回 null）——用于「注册起名」自动填充
function localNameOf(sid: string): string | null {
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  return reg[sid]?.name ?? null;
}
// 解析 `public:<id>` / `group:<id>` 目标 → 房间信息（2026-09-24 用户要求：send 的调用行/结果行要带房间上下文）
function channelOf(to: string): { id: string; name: string; kind: "public" | "group" } | null {
  const m = String(to ?? "").match(/^(public|group):(.+)$/);
  if (!m) return null;
  const kind = m[1] as "public" | "group";
  const id = m[2];
  let name = "";
  try { name = kind === "public" ? (findPublic(id)?.name ?? "") : (loadGroup(id)?.name ?? ""); }
  catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
  return { id, name, kind };
}
// 成员显示：优先用房内**注册名**，否则回退 displayName（后者自带 (sid) 后缀）
// 关闭原因措辞（解散 / TTL 过期）—— 过期房不该被说成「已解散」（2026-09-24）
function closedWord(x: PublicRoom): string {
  return x.closed_reason === "expired" ? "已过期（ttl 到期自动解散）" : "已解散";
}
function memberLabel(r: PublicRoom, sid: string): string {
  // 2026-09-24：本地 agent 优先用**当前**注册名（改名后不残留旧的房内快照）——
  // 房内 member_names 是加入时的快照，改名后不会自动更新；外部 agent（无本地 registry）才回退快照。
  const n = localNameOf(sid) ?? r.member_names?.[sid];
  if (!n) return displayName(sid);
  return n.includes(`(${sid})`) ? n : `${n} (${sid})`;   // 防重复拼 sid（displayName 已自带 (sid)，2026-09-24 tester 发现）
}
function publicMuteTag(st: PublicMuteState): string {
  if (st.mute && st.at_mute) return " [muted+@muted]";
  if (st.mute) return " [muted]";
  return "";
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

// 2026-09-13：收件箱文件的跨进程锁（mkdir 独占）。appendInbox 由**别的 agent 进程**直接写进我的 inbox，
// markInjected 是整文件读-改-写：不加锁时"读 → 对方 append → 我 writeFileSync 覆盖"会把对方刚发的消息整条丢掉（ISSUE 152 同类窗口）。
// 锁只保护这两个写入口；读者（readInbox / doctor）不加锁——原子 rename 保证读到的永远是完整文件。
function withInboxLock<T>(file: string, fn: () => T): T {
  const lock = file + ".lock";
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      // 持锁进程崩溃留下的陈锁：超过 5s 直接接管
      // 2026-09-14：陈锁接管改为先 rename 再删（两个等待者同时判定陈锁时，原 rmdir 会把对方刚 mkdir 的新锁删掉）；等待上限 8s > 陈锁阈值 5s，孤儿锁不会让前 3s 的 append 全部失败
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) { const dead = lock + ".stale-" + process.pid; renameSync(lock, dead); try { rmdirSync(dead); } catch { /* 空目录删不掉也不影响 */ } continue; } } catch { /* 锁已被别人释放/接管 → 重试 */ }
      if (Date.now() - t0 > 8000) throw new Error("inbox lock timeout: " + lock);
      Atomics.wait(sab, 0, 0, 15);
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch { /* 已被陈锁接管逻辑清掉 */ } }
}

function appendInbox(sid: string, msg: SocialMsg): void {
  try {
    mkdirSync(INBOX_DIR, { recursive: true });
    withInboxLock(inboxFile(sid), () => appendFileSync(inboxFile(sid), JSON.stringify(msg) + "\n", "utf8"));
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

// 粘性静音标记（2026-09-24 tester 指出）：静音判定**不能每次重算「当前」设置**，
// 否则「静音期间收到 → 解除静音 → 被补注入」就违背定稿（静音消息永不自动消费，只能 check-message 手动取）。
// 做法：接收方第一次见到「未注入且当时被我静音」的消息时，就地打上本地标记 muted:true（粘性），此后不再随设置变化。
function markMuted(sid: string, ids: string[]): void {
  try {
    const file = inboxFile(sid);
    if (!existsSync(file)) return;
    const idSet = new Set(ids);
    withInboxLock(file, () => {
      const lines = readFileSync(file, "utf8").split("\n");
      const out = lines.map(l => {
        if (!l.trim()) return l;
        try {
          const m = JSON.parse(l) as SocialMsg;
          if (idSet.has(m.id)) m.muted = true;
          return JSON.stringify(m);
        } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return l; }
      });
      writeFileAtomic(file, out.join("\n"));
    });
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
}
// 未注入消息分流：injectable=可自动注入；muted=被我静音拦下（含历史已标记的），并顺手把新遇到的打上粘性标记
function splitPending(sid: string, all: SocialMsg[]): { injectable: SocialMsg[]; muted: SocialMsg[] } {
  const injectable: SocialMsg[] = [];
  const muted: SocialMsg[] = [];
  const toMark: string[] = [];
  for (const m of all) {
    if (m.injected) continue;
    if (m.muted === true) { muted.push(m); continue; }
    if (isChanMutedByMe(m)) { muted.push(m); toMark.push(m.id); continue; }
    injectable.push(m);
  }
  if (toMark.length) markMuted(sid, toMark);
  return { injectable, muted };
}
function markInjected(sid: string, ids: string[]): void {
  try {
    const file = inboxFile(sid);
    if (!existsSync(file)) return;
    const idSet = new Set(ids);
    // 锁内读-改-写 + tmp+rename 原子落盘（原 writeFileSync 先截断：并发读者会读到半截、并发 append 会被覆盖丢失）
    withInboxLock(file, () => {
      const lines = readFileSync(file, "utf8").split("\n");
      const out = lines.map(l => {
        if (!l.trim()) return l;
        try {
          const m = JSON.parse(l) as SocialMsg;
          if (idSet.has(m.id)) m.injected = true;
          return JSON.stringify(m);
        } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return l; }
      });
      writeFileAtomic(file, out.join("\n"));
    });
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
  // 被静音房间的消息由**接收方自己**粘性判定（splitPending 会就地打标记）→ 不算未读
  const pending = splitPending(sid, all).injectable;
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
  // 被静音房间的消息**不自动注入**（接收方本地粘性判定；要看用 social check-message 手动取），因此不算 pending
  const pending = splitPending(sid, all).injectable;
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

// ── E2E 端到端加密（2026-09-13 用户拍板）──────────────────────
// 范围：走公网 server 的跨设备消息（server/CF 只见密文）；本机 SocialData 直投不出机器，不加密。
// 方案：每 agent 一对 ECDH P-256（私钥落盘 SocialData/e2e/<sid>.json；公钥随消息 pub 字段分发）。
//   双方互换公钥后 text 变 AES-256-GCM 密文（enc 字段带 iv + 发送方公钥）；无 enc = 明文（旧版兼容）。
//   首次联系对方必然明文（还不知道对方公钥）——对方回消息带 pub 后，本端下一轮起自动加密。
const E2E_DIR = join(homedir(), ".teyvat", "SocialData", "e2e");
const _e2eCache = new Map<string, { kp: any; pubB64: string }>();
function _e2eLoadPeers(): Record<string, string> {
  try { return JSON.parse(readFileSync(join(E2E_DIR, "peers.json"), "utf8")); } catch { return {}; }
}
function _e2eSavePeers(peers: Record<string, string>): void {
  try { mkdirSync(E2E_DIR, { recursive: true }); writeFileSync(join(E2E_DIR, "peers.json"), JSON.stringify(peers, null, 1), "utf8"); } catch { /* 非致命：缓存失败下轮重学 */ }
}
function e2eIdentity(sid: string): { kp: any; pubB64: string } {
  const hit = _e2eCache.get(sid);
  if (hit) return hit;
  mkdirSync(E2E_DIR, { recursive: true });
  const f = join(E2E_DIR, `${sid}.json`);
  let kp: any;
  try {
    const saved = JSON.parse(readFileSync(f, "utf8"));
    kp = { privateKey: createPrivateKey(saved.priv), publicKey: createPublicKey(saved.pub) };
  } catch (e: any) {
    // 2026-09-14：只有文件不存在才生成新密钥——EMFILE/EACCES/半截 JSON 等瞬时错误原来也会换钥匙，对端仍用旧公钥加密 → 之后每个 peer 丢一条消息
    if (e?.code !== "ENOENT") throw e;
    kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const priv = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    writeFileSync(f, JSON.stringify({ priv, pub }), "utf8");
  }
  const out = { kp, pubB64: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  _e2eCache.set(sid, out);
  return out;
}
function _e2eSharedKey(priv: any, peerPubB64: string): Buffer {
  const peer = createPublicKey({ key: Buffer.from(peerPubB64, "base64"), format: "der", type: "spki" });
  const secret = diffieHellman({ privateKey: priv, publicKey: peer });
  return createHash("sha256").update(secret).digest();
}
// 发送侧：有对方公钥则加密正文，无则原样（明文首发是设计内行为）。加密失败降级明文，不阻塞发送。
function e2eEncryptFor(fromSid: string, peerSid: string, text: string): { text: string; enc?: { v: number; pub: string; iv: string } } {
  try {
    const peerPub = _e2eLoadPeers()[peerSid];
    if (!peerPub) return { text };
    const { kp, pubB64 } = e2eIdentity(fromSid);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", _e2eSharedKey(kp.privateKey, peerPub), iv);
    const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return { text: Buffer.concat([ct, cipher.getAuthTag()]).toString("base64"), enc: { v: 1, pub: pubB64, iv: iv.toString("base64") } };
  } catch { return { text }; }
}
// 接收侧：有 enc → 解密并学对方公钥；无 enc 但带 pub → 学对方公钥（写 inbox 前调用——本地落盘与注入均为明文）
function e2eDecryptInPlace(p: any, mySid: string): void {
  try {
    if (p?.enc?.pub && p?.enc?.iv && typeof p.text === "string") {
      const { kp } = e2eIdentity(mySid);
      const decipher = createDecipheriv("aes-256-gcm", _e2eSharedKey(kp.privateKey, p.enc.pub), Buffer.from(p.enc.iv, "base64"));
      const buf = Buffer.from(p.text, "base64");
      decipher.setAuthTag(buf.subarray(buf.length - 16));
      p.text = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString("utf8");
      const peers = _e2eLoadPeers();
      if (peers[p.from] !== p.enc.pub) { peers[p.from] = p.enc.pub; _e2eSavePeers(peers); }
    } else if (typeof p?.pub === "string" && p?.from) {
      const peers = _e2eLoadPeers();
      if (peers[p.from] !== p.pub) { peers[p.from] = p.pub; _e2eSavePeers(peers); }
    }
  } catch (e) { console.error("[social-e2e] decrypt failed: " + ((e as any)?.message || e)); p.e2e_failed = true; /* 2026-09-14：不再覆盖 text/enc——密文保留在记录里，密钥恢复后还能解；原来直接写成"[无法解密]"，消息永久丢 */ }
}

/** 远端投递：POST /messages/send（type=agent-social，payload=完整 social 消息）。server 落库/ws 推送，不要求对方在线。 */
// 2026-09-07 Bug1（cross-device-communication-testor-01 报告）：远程 agent 名字路由——resolveSid 只查本地 registry，
// 远程 agent 名字只在 server presence（/sync/agent-presence）。单发分支本地解析失败时查远端 presence 补名字→sid。
async function findRemoteAgent(key: string): Promise<{ sid: string; name: string } | null> {
  try {
    let b: any = null;
    try { b = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8")); } catch { return null; }
    if (!b?.token || !b?.deviceId) return null;
    const res = await fetch(syncEndpoint() + "/sync/agent-presence", { signal: AbortSignal.timeout(10_000), headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA } });
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

async function remoteSendOne(toSid: string, text: string, mode: SocialMode, fromSid: string, fromName: string, chan: { kind: "group" | "public"; id: string; name: string } | null = null): Promise<{ to: string; mode_used: SocialMode; status: string }> {
  const b = loadBinding();
  if (!b) throw new Error(`social.send: ${toSid} 不在本机且未绑定 GitHub 账号——跨设备投递需要 binding`);
  // 2026-09-07（用户反馈：send 渲染显示 id 而非 name）：查 presence 拿远端名字填缓存，供 displayName 渲染（跨设备 agent 不在本地 registry）
  if (!remoteNameCache.has(toSid)) {
    try { const rmt = await findRemoteAgent(toSid); if (rmt) remoteNameCache.set(toSid, rmt.name); } catch { /* 名字获取失败不阻塞发送 */ }
  }
  const msg: SocialMsg = {
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    from: fromSid,
    from_name: fromName,
    to: chan ? `${chan.kind}:${chan.id}` : toSid,
    ...(chan ? { chan: chan.name, chan_id: chan.id } : {}),
    mode,
    mode_used: mode,
    text,
    ts: Date.now(),
    injected: false,
  };
  // E2E（2026-09-13）：远端消息必附本端公钥供对方学习；已有对方公钥则正文加密（server 只见密文）
  (msg as any).pub = e2eIdentity(fromSid).pubB64;
  const _e2e = e2eEncryptFor(fromSid, toSid, msg.text);
  msg.text = _e2e.text;
  if (_e2e.enc) (msg as any).enc = _e2e.enc;
  const ep = syncEndpoint();
  let res: Response;
  try {
    res = await fetch(ep + "/messages/send", { signal: AbortSignal.timeout(10_000), method: "POST", headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "Content-Type": "application/json", "User-Agent": SYNC_UA }, body: JSON.stringify({ toPerson: toSid, type: "agent-social", payload: msg }) });
  } catch (e: any) {
    throw new Error(`social.send: 跨设备投递网络错误 ${toSid}（${(e?.message || e)} url=${ep}/messages/send）`);
  }
  if (!res.ok) throw new Error(`social.send: 跨设备投递失败 ${toSid}（HTTP ${res.status}）`);
  const j = await res.json().catch(() => ({}));
  return { to: toSid, mode_used: mode, status: j?.delivered ? "remote-delivered" : "remote-queued" };
}

/** 拉 server pending 的 agent-social 消息 → 写本地 inbox（复用注入机制）。heart 周期经 touchPresence 节流 fire。 */
// 2026-09-13：in-flight 保护 + 超时——之前 server 挂起时每 45s（+30s）叠加一个悬挂请求，无上限
let _pullInFlight = false;
export async function pullRemoteMessages(): Promise<number> {
  if (_pullInFlight) return 0;
  _pullInFlight = true;
  try { return await _pullRemoteMessagesImpl(); } finally { _pullInFlight = false; }
}
async function _pullRemoteMessagesImpl(): Promise<number> {
  const b = loadBinding();
  const sid = getMySid();
  if (!b || !/^[a-f0-9]{8}$/.test(sid)) return 0;
  try {
    const res = await fetch(syncEndpoint() + `/messages/pending/${sid}`, { headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return 0;
    const j = await res.json().catch(() => ({ messages: [] }));
    let added = 0;
    for (const m of (j?.messages || [])) {
      if (m?.type !== "agent-social") continue;
      const p = m?.payload;
      if (!p || typeof p !== "object" || !p?.id) continue;
      // E2E（2026-09-13）：解密密文消息 / 学习对方公钥（写 inbox 前完成——本地落盘与注入均为明文）
      e2eDecryptInPlace(p, sid);
      if (readInbox(sid, 500).some((x: SocialMsg) => x.id === p.id)) continue; // 去重（server 标记延迟防重复注入）
      appendInbox(sid, p as SocialMsg);
      added++;
      // 2026-09-08（testor 复测实证：injected 但 handleTrigger 零打点 = trigger 未写入/未消费）诊断打点：定位拉到消息后写 trigger 环节
      console.error("[social-pull] got msg " + p.id + " mode=" + p.mode + " mode_used=" + p.mode_used + " added=" + added + " sid=" + sid);
      // ISSUE 125 跨设备扩展：写 trigger 文件让 handleTrigger 走打断路径（resting→working→inject）
      // 没有 trigger 时跨设备消息只能等 agent_end drain，wait 中不被打断
      if (p.mode_used === "interrupt" || p.mode_used === "queue") {
        try {
          mkdirSync(TRIGGERS_DIR, { recursive: true });
          const tf = join(TRIGGERS_DIR, `${sid}.json`);
          // 2026-09-22（ISSUE 151① 防御）：带上**写入者 pid**——消费端据此只认“本进程写的 trigger”，
          // 同 sid 的残留孤儿实例就抢不走（它看到 pid 不是自己、且写入者还活着 → 不碰）。
          writeFileSync(tf, JSON.stringify({ msgId: p.id, ts: p.ts, pid: process.pid }), "utf8");
          console.error("[social-pull] trigger written " + tf + " for " + p.id);
        } catch (e2) { console.error("[social-pull] trigger write FAILED: " + ((e2 as any)?.message || e2) + " dir=" + TRIGGERS_DIR); /* trigger 写入失败 → 降级为 agent_end drain */ }
      } else {
        console.error("[social-pull] no-trigger mode_used=" + p.mode_used + "（非 interrupt/queue——等 agent_end drain）");
      }
    }
    return added;
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return 0; } // 拉取失败静默（下次心跳再拉）
}

async function sendOne(to: string, text: string, mode: SocialMode, atList: string[], chan: { kind: "group" | "public"; id: string; name: string } | null, fromSid: string, fromName: string): Promise<{ to: string; mode_used: SocialMode; status: string }> {
  const receiverSid = to;
  // 跨设备：本机 registry 无此 sid → 远端投递（server messaging；对方设备 agent 拉取）。群/广播暂限本机。
  const reg = readJson<Record<string, RegistryEntry>>(REGISTRY_FILE, {});
  if (!reg[receiverSid]) {
    return remoteSendOne(receiverSid, text, mode, fromSid, fromName, chan);
  }
  // 2026-08-14 用户定稿：social 是实时消息，对方不在线（offline）目前不支持发送（离线队列以后再设计）。
  if (!isAgentActive(receiverSid)) {
    throw new Error(`social.send: ${receiverSid} 不在线（offline）——实时消息不支持发给离线 agent（离线投递以后再设计）`);
  }
  const focus = getFocus(receiverSid);
  const isAt = atList.includes(receiverSid);
  const atMuted = chan?.kind === "group" && loadMutesOf(receiverSid).includes(chan.id);
  const modeUsed = resolveMode({ receiverFocus: focus, requested: mode, isAt, atMuted });
  const msg: SocialMsg = {
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    from: fromSid,
    from_name: fromName,
    to: chan ? `${chan.kind}:${chan.id}` : to,
    ...(chan ? { chan: chan.name, chan_id: chan.id } : {}),
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
      // 2026-09-22（ISSUE 151①）：写入端带 pid 供消费端校验所有权。
      // ⚠️ 2026-09-24 修复：本地路径（sendOne）不能写发送方 pid——消费端 `trig.pid !== process.pid`
      // 用接收方 pid 比对，发送方 pid 永远不等 → trigger 被跳过、消息只在 agent_end 才补注（wait 期间传不进来）。
      // 远程路径（social-pull）写的是接收方自己 pid，所以正常。本地跨进程应不带 pid（老格式，照旧消费）。
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
      receipts.push(await sendOne(m, text, mode, atList, { kind: "group", id: gid, name: g.name }, fromSid, fromName));
    }
    if (offlineMembers.length) {
      receipts.push({ to: `(offline: ${offlineMembers.join(",")})`, mode_used: mode, status: "skipped-offline" });
    }
    return { receipts };
  }

  // public 聊天室（champion-01 2026-09-24）：先落房间日志（拿 seq），再分发给在线成员
  if (target.startsWith("public:")) {
    const rid0 = target.slice(7);
    const room = findPublic(rid0);
    if (!room) throw new Error(`social.send: public room ${rid0} not found`);
    const rid = room.id;   // 归一化：日志/编号一律用稳定 id（名称可变、编号不可变）
    if (room.closed) throw new Error(`social.send: public room "${room.name}" (${rid}) ${closedWord(room)}——不可再发（历史仍可读）`);
    if (!room.members.includes(fromSid) && !room.members.includes(fromName)) throw new Error(`social.send: not a member of public room ${room.name}`);
    const prev = readPublicMsgs(rid);
    const seq = prev.length ? (Number(prev[prev.length - 1].seq) || prev.length) + 1 : 1;
    appendPublicMsg(rid, { seq, id: `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, from: fromSid, from_name: fromName, text, ...(atList.length ? { at: atList } : {}), ts: Date.now() });
    const members = room.members.map((m: string) => resolveSid(m) ?? m).filter((m: string) => /^[a-f0-9]{8}$/.test(m));
    const offlineMembers: string[] = [];
    for (const m of members) { if (!isAgentActive(m)) offlineMembers.push(m); }
    const onlineMembers = members.filter(m => !offlineMembers.includes(m));
    for (const m of onlineMembers) {
      if (m === fromSid) continue;
      // 按收件人隔离错误：单个收件人投递失败不应让整条 send 抛错
      // （否则「消息已落库但调用方看到异常」＝半成功，重试会造成重复——2026-09-24 tester 指出）
      try {
        // 2026-09-24 用户定稿：**发送方不得决定、也不得知道**接收方是否静音（隐私——被屏蔽了不应该让发送方知道）；
        // 静音一律由**接收方**在注入那一刻用自己的设置裁决（见 getPendingInbox / handleTrigger / isChanMutedByMe）。
        receipts.push(await sendOne(m, text, atList.includes(m) ? "interrupt" : mode, atList, { kind: "public", id: rid, name: room.name }, fromSid, fromName));
      } catch (e) {
        console.error("[spirit.bio.organs/social.communicate/communicate.ts] public delivery failed for " + m + ": " + ((e as any)?.message || e));
        receipts.push({ to: m, mode_used: mode, status: "failed: " + ((e as any)?.message || e) });
      }
    }
    if (offlineMembers.length) {
      receipts.push({ to: `(offline: ${offlineMembers.join(",")})`, mode_used: mode, status: "skipped-offline" });
    }
    return { receipts, seq, room: rid };
  }

  // 广播
  if (target === "all" || target === "*") {
    const agents = listAgents().filter(a => a.sid !== fromSid);
    for (const a of agents) {
      receipts.push(await sendOne(a.sid, text, mode, [], null, fromSid, fromName));
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
  const r = await sendOne(toSid, text, mode, atList, null, fromSid, fromName);
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
    // 群/房间名（2026-09-24 用户要求：群消息不能只有发件人，要带对应 group 名称；public 属于 group）
    const chanTag = m.chan ? `${m.chan} · ` : "";
    return `${modeTag} ${ts} ${chanTag}${from}${atTag}: ${m.text}`;
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
      try { trig = JSON.parse(readFileSync(f, "utf8")); } catch (e: any) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return; } // ENOENT=已被 watch/interval 另一方消费（竞态）——静默
      // 2026-09-24（ISSUE 273 修复）：删除 ISSUE 151① 的 pid 所有权校验——它用「写入者 pid vs 接收方 pid」判断，
      // 但本地消息（sendOne）的 trigger 带的是**发送方** pid，接收方比对恒不等 → trigger 被跳过、消息滞留 inbox
      // （champion 02:41 实测：interrupt 消息 injected=false，要手动 inbox 拉）。同 sid 孤儿抢 trigger 已由
      // ISSUE 151②（launcher 启动幂等杀旧实例）解决，此处 pid 校验冗余且有害——一律消费（竞态靠 unlink 原子性）。
      try { unlinkSync(f); } catch (e: any) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return; } // 拿所有权失败 → 已由 watch/interval 另一方处理，放弃
      try {
        // 被静音房间的消息由**我自己**粘性判定不注入（trigger 消费是独立注入路径；2026-09-24 tester 实证曾漏过）
        const msgs = splitPending(mySid, readInbox(mySid, 50)).injectable;
        // 立即注入范围：interrupt 全部（强制切断）；queue 仅在 resting（wait 中）时注入（打断 wait）
        const resting = existsSync(join(homedir(), ".teyvat", "RuntimeCache", mySid, "main-resting"));
        // 2026-09-14（alice 实测 ISSUE）：queue 原来只覆盖 resting（wait），hibernated 时 toInject 为空 →
        // 消息滞留 inbox（alice 实测：hibernate 中 queue 消息 3h20m 未注入、injected:false；同场景 interrupt 9.8s 唤醒 ✓）。
        // hibernate 语义 = 长期"等消息"状态（wait 的超长形态，房东定义 queue 会打断等待方）——queue 对齐 interrupt：
        // hibernated 也注入；下方 toInject 非空时已有 hibernated 唤醒分支（transition working + 清 hibernate 标记），queue 复用。
        const hibernated = existsSync(join(homedir(), ".teyvat", "RuntimeCache", mySid, "main-hibernate"));
        const toInject = msgs.filter((m: SocialMsg) => m.mode_used === "interrupt" || ((resting || hibernated) && m.mode_used === "queue"));
        // 2026-09-08（testor 03:12 实证：消息 injected 但 wait 未被唤醒——诊断打点）：trigger 消费路径低频事件——打点定位静默失败点（toInject 空 / resting 判断 / sendCustomMessage 未达）
        console.error("[social-trigger] consumed " + f.split("/").pop() + " trig=" + JSON.stringify(trig) + " inboxUninjected=" + msgs.length + " toInject=" + toInject.length + " resting=" + resting);
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
          // 2026-09-08（testor 03:13 实证 + 推断确认）：markInjected 必须在 sendCustomMessage 成功之后——
          // 原顺序 markInjected 先执行，sendCustomMessage 抛错被外层 catch 吞（注释称"消息留在 inbox injected:false"与实际矛盾）
          // → 消息已 injected:true 不再兑底 → interrupt 打断丢失（wait 中无感知，只能查 history）。
          // 现：注入成功才标记；抛错时消息保持 injected:false → agent_end/下次 trigger 仍能兑底补注。
          try {
            sendCustomMessage(
              pi, "social-message", text,
              {
                from: toInject[0].from, from_name: toInject[0].from_name,
                ...(toInject[0].chan ? { chan: toInject[0].chan } : {}),
                mode: toInject[0].mode, mode_used: toInject[0].mode_used, ts: toInject[0].ts,
                ...(toInject[0].at?.length ? { at: toInject[0].at } : {}),
                interrupt: true,
              },
              { deliverAs: "interrupt" }, // agent-session.js override：abort 当前 run + 立即注入
            );
            markInjected(mySid, toInject.map((m: SocialMsg) => m.id));
            console.error("[social-trigger] injected OK " + toInject.length + " msgs → " + toInject.map((m: SocialMsg) => m.id).join(","));
          } catch (e2) {
            console.error("[social-trigger] sendCustomMessage FAILED: " + ((e2 as any)?.message || e2));
            console.error("[spirit.bio.organs/social.communicate/communicate.ts] sendCustomMessage(interrupt) 注入失败——消息未标记 injected（agent_end 兑底将补注）: " + ((e2 as any)?.message || e2));
          }
        }
        // queue 且非 resting → 留给 agent_end 轮后注入（不打断进行中的工作）
      } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 注入异常 → 消息留在 inbox（injected:false——2026-09-08 已改为注入成功才标记），agent_end 轮询仍能兑底 */ }
    };
    // 2026-09-13：/reload 重跑本函数——之前旧 watcher/timer 没句柄、只 unref 不清理，每 reload 一次触发文件被并发处理 N 次（unlink 争夺保证只注入一次，但落败方各打一条错误）
    if (_trigWatcher) { try { _trigWatcher.close(); } catch { /* 已关 */ } _trigWatcher = null; }
    if (_trigTimer) { try { clearInterval(_trigTimer); } catch { /* 已清 */ } _trigTimer = null; }
    const watcher = require("fs").watch(TRIGGERS_DIR, (_evt: string, filename: string | null) => {
      if (!filename || !filename.endsWith(".json")) return;
      const mySid = getMySid();
      if (!/^[a-f0-9]{8}$/.test(mySid) || filename !== `${mySid}.json`) return; // 只处理自己的触发文件
      handleTrigger(join(TRIGGERS_DIR, filename));
    });
    watcher.unref?.();
    _trigWatcher = watcher;
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
    _trigTimer = timer;
  } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* fs.watch 不可用 → 降级为 agent_end 轮后注入（原行为） */ }
}
let _trigWatcher: any = null;
let _trigTimer: ReturnType<typeof setInterval> | null = null;

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
      "  action:\"check-message\" [target] [new|latest N|latest A-B]  — 取消息 / 查历史（id 或 name 都支持；不支持 full）\n" +
      "      不带参数 / new      = 所有未读（拿走即已读）\n" +
      "      <房间id|名>           = 概览：共 N 条 / M 条新（并提示用 new 查看）\n" +
      "      <id> latest 10        = 最新 10 条；latest 10-20 = 继续往早（第 11..20 新）\n" +
      "      也支持普通会话（传 agent 的 sid/名），查与其往来；房间编号为 **6 位 hex**（agent sid 为 8 位 hex，**同空间、位数不同**）\n" +
      "  action:\"focus\"  mode?              — declare focus: off | deep | rest (no mode = show all)\n" +
      "  action:\"group\"  gop, ...           — group ops: create|list|send|mute|add|remove\n" +
      "      create: gname, members[]  /  send: gid, text, at?  /  mute: gid, on?  /  add|remove: gid, members[]\n" +
      "  action:\"public\" gop, ...            — 公共聊天室（⚠️ 仅供跨框架用：要和非 teyvat agent 一起聊天才开；teyvat 内部 agent 之间用 send / global 即可，不要用这个累赘）\n" +
      "      create: gname, members?, ttl_minutes? / list（含成员名单）/ join: gid / leave: gid\n" +
      "      send: gid, text, at?（gid 可用**编号或房间名**；@某人默认**突破静音**）/ history: gid, limit?\n" +
      "      rename: gid, gname（改名，**编号不变**，仅创建者）/ dissolve: gid（仅创建者；解散后成员收到通知、不可再发、历史仍可读）\n" +
      "      manage: gid, mute?, at_mute?（管理**自己**在该房间的权限；不带参数=查看当前设置）\n" +
      "          静音：被静音房间的消息**不自动注入**（只在 social inbox 显示「N 条未读 + 最新预览」，用 social check-message <房间id> 取全文）；**@ 默认突破静音**；要到 @ 也不打断，先 mute:true 再 at_mute:true（**不能单独开 at_mute**）\n" +
      "  action:\"global\" [device|<id>]     — cross-device view (devices + agents); list 也支持 scope:'local'|'remote'|'global'\n" +
      "Messages auto-inject: interrupt immediately, queue at turn end (hibernate blocked while pending).",
    promptSnippet: "social(action, ...) — send|list|inbox|focus|group|public|global",
    parameters: Type.Object({
      action: Type.String({ messageDescription: "send | list | inbox | check-message | focus | group | public | global（public=公共聊天室，仅供跨框架；check-message=取某房间被静音的消息（不自动注入的那批）；global=跨设备查看）" }),
      to: Type.Optional(Type.String({ messageDescription: "Target (send): sid | agent name | group:<gid> | all" })),
      text: Type.Optional(Type.String({ messageDescription: "send: 消息内容；check-message: 查询修饰（空/new/latest N/latest A-B）" })),
      mode: Type.Optional(Type.Union([
        Type.Literal("interrupt"), Type.Literal("queue"), // @DEP deferred 废弃 ISSUE 103
        Type.Literal("off"), Type.Literal("deep"), Type.Literal("rest"),
      ], { messageDescription: i18n("send: interrupt|queue (deferred 废弃, ISSUE 103); focus: off|deep|rest", "send: interrupt|queue (deferred deprecated, ISSUE 103); focus: off|deep|rest") })),
      at: Type.Optional(Type.Array(Type.String(), { messageDescription: "Highlighted members (send, by sid or name)" })),
      limit: Type.Optional(Type.Number({ messageDescription: "Max messages (inbox, default 20)" })),
      history: Type.Optional(Type.Boolean({ messageDescription: "Include history in inbox (default false — pending only)" })),
      gop: Type.Optional(Type.String({ messageDescription: "Group op: create | list | send | mute | add | remove" })),
      gname: Type.Optional(Type.String({ messageDescription: "群/房间名称（group create；public create / rename）" })),
      members: Type.Optional(Type.Array(Type.String(), { messageDescription: "Member sids/names (group create)" })),
      gid: Type.Optional(Type.String({ messageDescription: "群/房间编号（group send/mute；public 各操作——也可直接用房间名）" })),
      on: Type.Optional(Type.Boolean({ messageDescription: "Mute on/off (group mute, default true)" })),
      mute: Type.Optional(Type.Boolean({ messageDescription: "public manage: 房间静音（消息降 queue 不打断；@ 仍可突破）" })),
      at_mute: Type.Optional(Type.Boolean({ messageDescription: "public manage: @ 也静音（必须先 mute:true；默认@可突破静音）" })),
      mname: Type.Optional(Type.String({ messageDescription: "public join: 你的注册名（必填——注册身份不能只有 id；本地 agent 可省略，自动取注册名）" })),
      ttl_minutes: Type.Optional(Type.Number({ messageDescription: "public create: N 分钟无消息自动解散（可选；不填=不过期）" })),
      // global 跨设备视图参数（2026-09-05 用户定稿：social global [device | <device_id>]）
      view: Type.Optional(Type.String({ messageDescription: "global: 'device'=设备列表（默认跨设备 agents 概览）；具体 device_id=该设备 agents" })),
      device: Type.Optional(Type.String({ messageDescription: "global: 指定设备 id → 显示该设备 genshin（agent 列表）" })),
      remote: Type.Optional(Type.Boolean({ messageDescription: "list: include remote-machine agents (default false — local only)；推荐用 scope:'remote' 代替" })),
      scope: Type.Optional(Type.String({ messageDescription: i18n("list 范围: 'local'(默认本机) | 'remote'(含远程机器 agent) | 'global'(跨设备设备+agents 视图——等效旧 action:'global'；global 另支持 view:'device'=设备列表 / device:'<id>'=某设备 agents)", "list scope: 'local'(default)|'remote'|'global'(cross-device view; global also: view='device'=devices / device='<id>'=agents of that device)") })),
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
        const rcChan = channelOf(toName);
        // 2026-09-24 用户定稿：**发到房间用 in，发给人用 to**
        const toDisplay = rcChan
          ? `${rcChan.name ? theme.fg("room", rcChan.name) + " " : ""}(${theme.fg("room", rcChan.id)})`
          : (toName ? theme.fg("accent", toName) : "");
        const modeWord = args?.mode === "queue" ? "queue" : "interrupt";
        const article = /^[aeiou]/i.test(modeWord) ? "an" : "a";
        const title = rcChan
          ? `send ${article} ${modeWord} message in ${toDisplay}`.trim()
          : `send ${article} ${modeWord} message to ${toDisplay}`.trim();
        return renderToolCall.detail(theme, "Social", title, "");
      }
      // public gop 的调用行：send 也用「in <房间>」（与上面的房间私信一致）
      if (a === "public" && args?.gop === "send" && args?.gid) {
        const rc = channelOf(`public:${args.gid}`);
        const mw = args?.mode === "queue" ? "queue" : "interrupt";
        const art = /^[aeiou]/i.test(mw) ? "an" : "a";
        return renderToolCall.detail(theme, "Social", `send ${art} ${mw} message in ${theme.fg("room", rc?.name || String(args.gid))} (${theme.fg("room", String(args.gid))})`, "");
      }
      const d = a === "inbox" ? (args?.limit ? `(${args.limit})` : "")
        : a === "focus" ? (args?.mode ?? "")
        : a === "group" ? `${args?.gop ?? ""}${args?.gname || args?.gid ? ` ${args?.gname || args?.gid}` : ""}`
        : a === "public" ? `${args?.gop ?? ""}${args?.gid || args?.gname ? ` ${args?.gid || args?.gname}` : ""}`
        : a === "check-message" ? `${args?.gid ?? "new"}${args?.text ? ` ${args.text}` : ""}`
        : "";
      return renderToolCall.label(theme, "Social", [a, d].filter(Boolean).join(" "));
    },
    renderResult(result: any, _opts: any, theme: any, ctx: any) {
      const d = result?.details || {};
      const text = result?.details?._content?.[0]?.text ?? result?.content?.[0]?.text ?? "";
      if (ctx?.isError) return renderMessage.summary(theme, { isError: true }, text || "error");
      if (d.social) {
        // 2026-09-23：list 走 markdown 表格渲染（content 已是 markdown 文本，含表格）
        if (d.action === "list" && d.markdown && text) return renderMessage.markdown(theme, ctx, [{ type: "text", text }]);
        // 借鉴 Execute：摘要行 ⎿  + 时间戳行尾(dim)，内容缩进（无 ⎿）
        const { Text, Container } = require("@earendil-works/pi-tui");
        const indent = " ".repeat(GUTTER);
        const tsStr = fmtStamp(d.ts || Date.now());
        const c = new Container();
        const a = d.action;
        let summary = a || "done";
        if (a === "send") {
          if (d.count === 1 && d.modeUsed && !d.chanId) {
            // 单发（私信）：`Sent and <mode 高亮> <名称> (<sid>, in <mode> mode)`
            // 2026-09-24 用户定稿：**保留原状态式措辞**（mode 粗体高亮）——与调用行「send a/an <mode> message …」形成区别
            // ISSUE 110：接收方名字蓝紫色（accent 语义键，与调用行一致；bluePurple 不可用见 ISSUE 111）
            const name = d.targetName ?? d.target ?? "?";
            const sid = d.targetSid;
            summary = `Sent and ${theme.bold(d.modeUsed)} ${theme.fg("accent", String(name))}${sid ? ` (${sid})` : ""}`;
          } else if (d.chanId) {
            // 房间消息：状态式但**不列个人**（隐私定稿：发送方不得知个人投递态）——房间名/编号用 room 橙
            // 房间消息：**动作式**（`Sent a message in …`）——用户 2026-09-24 定稿：「Sent and <mode>」只用于**私信**；房间用动作式，且不显示 seq
            summary = `Sent a message in ${theme.fg("room", String(d.chanName ?? d.chanId))} (${theme.fg("room", String(d.chanId))})`;
          } else {
            summary = d.count === 1 ? `Sent to ${theme.fg("accent", d.targetDisplay ?? d.target ?? "?")}` : `Sent to ${theme.bold(String(d.count))} receivers`;
          }
        }
        else if (a === "list") summary = `Agents ${theme.bold(String(d.count ?? 0))}`;
        else if (a === "inbox") summary = `${d.count ? theme.bold(String(d.count)) : "No"} message${d.count === 1 ? "" : "s"}`;
        else if (a === "focus") summary = `focus ${theme.fg("accent", d.mode ?? "")}`;
        else if (a === "group") summary = `Group ${d.gop || ""}${d.count ? ` · ${theme.bold(String(d.count))} receivers` : ""}`;
        else if (a === "public") {
          // blockrender：public 不能只显示一个 “public” 字样（用户 2026-09-24：乱七八糟）
          const g = String(d.gop ?? "");
          const tag = d.roomName ? `${d.roomName}${d.roomId ? ` (${d.roomId})` : ""}` : (d.roomId ? String(d.roomId) : "");
          if (g === "create") summary = `create ${tag} · ${theme.bold(String(d.count ?? 0))} members`;
          else if (g === "list") summary = `${theme.bold(String(d.count ?? 0))} room(s)`;
          else if (g === "join") summary = `join ${theme.fg("room", tag)} as ${theme.fg("accent", String(d.memberName ?? ""))}`;
          else if (g === "leave") summary = `leave ${tag} · ${theme.bold(String(d.count ?? 0))} members left`;
          else if (g === "send") summary = `Sent a message in ${theme.fg("room", String(d.roomName ?? d.roomId ?? ""))} (${theme.fg("room", String(d.roomId ?? ""))})${d.at?.length ? ` @${d.at.map((x: string) => displayNameShort(x)).join(", ")}` : ""}${d.offline ? ` · ${d.offline} 位成员不在线` : ""}`;
          else if (g === "history") summary = `${tag} · ${theme.bold(String(d.count ?? 0))} msg`;
          else if (g === "rename") summary = `rename ${theme.fg("accent", String(d.oldName ?? ""))} → ${theme.fg("accent", String(d.roomName ?? ""))} (${d.roomId ?? ""})`;
          else if (g === "dissolve") summary = `dissolve ${tag} · notified ${theme.bold(String(d.count ?? 0))}`;
          else if (g === "mute" || g === "manage") summary = `set mute(${tag}) = ${d.mute ? "on" : "off"}${d.at_mute ? " +@mute" : ""}`;
          else summary = `${g} ${tag}`;
        }
        else if (a === "check-message") summary = `${d.unread !== undefined ? `${theme.bold(String(d.unread))} new / ` : ""}${theme.bold(String(d.count ?? 0))} msg`;
        c.addChild(new Text(indent + theme.fg("dim", SYM.result + "  ") + summary + "  " + theme.fg("dim", `[${tsStr}]`), 0, 0));
        // send / public send 都要显示消息正文（用户 2026-09-24：public 发出去根本看不到消息）；单发时 summary 已含接收方+mode，不再重复 receipt 行
        if ((a === "send" || (a === "public" && d.gop === "send")) && d.text) {
          c.addChild(new Text(indent + "  " + d.text, 0, 0));
        }
        const skipLines = a === "send" && d.count === 1;
        for (const ln of (skipLines ? [] : (d.lines || []))) {
          c.addChild(new Text(indent + "  " + ln, 0, 0));
        }
        // 2026-09-08（用户：global 结果只看到 ⎿ global 摘要、内容丢了——垃圾）：global 的设备/agent 详情在 content text（lines 空）——摘要后渲染 content
        if (a === "global" && text && text !== "(无设备)") {
          for (const ln of String(text).split("\n")) c.addChild(new Text(indent + "  " + ln, 0, 0));
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
          const sendChan = channelOf(String(p.to ?? ""));
          // 2026-09-24（tester 指出边界）：结果行的名字解析必须与摘要行同源——
          // localNameOf 只查本地 registry（无远程回退），跨机 agent / 直用 sid 发送时会退化成「sid (sid)」；
          // 改用 displayNameShort（含 remoteNameCache 回退，且不含 sid），与摘要行 :1310 一致。
          return { content: [{ type: "text", text: receipts.length === 1 ? `Sent and ${modeUsed} ${toSid ? displayNameShort(toSid) : p.to}${toSid ? ` (${toSid})` : ""}\n${p.text}` : `Sent and ${modeUsed} to ${receipts.length} receiver(s):\n${lines.map(l => "  " + l).join("\n")}\n\n${p.text}` }], details: { social: true, action: "send", count: receipts.length, target: p.to, targetDisplay: toSid ? displayName(toSid) : p.to, targetName: toSid ? displayNameShort(toSid) : p.to, targetSid: toSid, chanId: sendChan?.id, chanName: sendChan?.name, modeUsed, text: p.text, ts: Date.now(), lines } };
        }
        case "list": {
          // 2026-09-08（用户：list/global 冗余——组合参数）：list scope: 'local'(默认) | 'remote' | 'global'——scope=global 或带 view/device 参数时走跨设备视图（复用 socialGlobal；老 action:'global' 兼容别名同效果）；scope='remote' 走下方 remote 分支（等效旧 list remote:true）
          if (p.scope === "global" || p.view === "device" || p.device) {
            let b: any = null;
            try { b = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8")); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); }
            if (!b?.token || !b?.deviceId) return { content: [{ type: "text", text: "(未绑定——先 genshin login)" }], details: { social: true, action: "list", count: 0, lines: [] } };
            return socialGlobal(p, b);
          }
          touchPresence();
          const agents = listAgents();
          const me = getMySid();
          const now = Date.now();
          // AgentTableSync：remote=true 或 scope='remote' 时拉 server presence 合并（远端 agent = 别的机器，标 remote）
          const remoteLines: string[] = [];
          if (p.remote === true || p.scope === "remote") {
            try {
              const rb = JSON.parse(readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8"));
              if (rb?.token && rb?.deviceId) {
                const res = await fetch(syncEndpoint() + "/sync/agent-presence", { signal: AbortSignal.timeout(10_000), headers: { "Authorization": `Bearer ${rb.token}`, "X-Device-Id": rb.deviceId, "User-Agent": SYNC_UA } });
                const body: any = await res.json();
                // 2026-09-07（用户：remote agent 没显示具体设备——垃圾）：presence 只有 device_id 无设备名——补拉 auth/devices 拿 device_id→device_name 映射
                const devNames: Record<string, string> = {};
                try {
                  const dr = await fetch(syncEndpoint() + "/auth/devices", { signal: AbortSignal.timeout(10_000), headers: { "Authorization": `Bearer ${rb.token}`, "X-Device-Id": rb.deviceId, "User-Agent": SYNC_UA } });
                  const dj: any = await dr.json();
                  for (const dv of (dj?.devices ?? [])) devNames[String(dv.device_id)] = dv.device_name && dv.device_name !== dv.device_id ? dv.device_name : dv.device_id;
                } catch { /* 设备名拉取失败 → remote 行只显示 device_id */ }
                const localIds = new Set(agents.map(a => a.sid));
                for (const ra of (body?.agents ?? [])) {
                  if (localIds.has(ra.sid)) continue; // 本机 agent 已在本地列表
                  const lastTs = Date.parse(String(ra.last_seen).replace(" ", "T") + "Z") || 0;
                  const ago = lastTs ? Math.max(0, Math.floor((now - lastTs) / 1000)) : -1;
                  const online = ago >= 0 && ago < 300; // server 5min expirePresence 窗口
                  const state = online ? "online" : ago >= 0 ? `${Math.floor(ago / 60)}m ago` : "unknown";
                  const devName = devNames[String(ra.device_id)] || String(ra.device_id || "?");
                  remoteLines.push(`${ra.name} (${ra.sid})  focus:${ra.focus}  ${state}  设备:${devName}  ${ra.version} ${ra.model}`);
                }
              }
            } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* remote 拉取失败不影响本地列表 */ }
          }
          const allCount = agents.length + remoteLines.length;
          if (!allCount && !remoteLines.length) return { content: [{ type: "text", text: "(no agents registered)" }], details: { social: true, action: "list", count: 0, lines: [] } };
          const rows = agents.map(a => {
            const mark = a.sid === me ? " (me)" : "";
            const ago = a.lastSeen > 0 ? Math.max(0, Math.floor((now - a.lastSeen) / 1000)) : -1;
            const online = ago >= 0 && ago < 600;
            const state = online ? "online" : ago >= 0 ? `${Math.floor(ago / 60)}m ago` : "never";
            return `| ${a.name}${mark} | ${a.sid} | ${a.focus} | ${state} | ${a.version} | ${a.model} |`;
          });
          // 2026-09-23 用户：直接用原生 markdown 表格（| 竖线，TUI 自动渲染）
          const table = ["| 名称 | sid | focus | 状态 | 版本 | 模型 |", "|---|---|---|---|---|---|", ...rows]
            .concat(remoteLines.length ? ["", ...remoteLines.map(r => `- ${r}`)] : [])
            .join("\n");
          return { content: [{ type: "text", text: `Agents (${allCount}):\n\n${table}` }], details: { social: true, action: "list", count: allCount, markdown: true } };
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
          try { res = await fetch(_url, { signal: AbortSignal.timeout(10_000), headers: H }); } catch (e: any) {
            // 2026-09-05 诊断：fetch 网络层异常 → 返回真实信息（含 URL/cause）定位
            return { content: [{ type: "text", text: "(global 网络错误: " + (e?.message || e) + (e?.cause?.message ? " | cause: " + e.cause.message : "") + " | url=" + _url + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
          }
          if (!res.ok) return { content: [{ type: "text", text: "(server 查询失败: HTTP " + res.status + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
          const j: any = await res.json();
          const ds = (j?.devices ?? []).filter((d: any) => d.device_id === b.deviceId || (d.agents && String(d.agents).length > 2) || !d.archived);
          const fmtTs = (s: string) => { if (!s) return ""; try { return new Date(String(s).replace(" ", "T") + "Z").toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return s; } };
          // 2026-09-08（用户怒批：一堆版本号没状态）：拉 presence 拿各 agent 实时在线状态（与 socialGlobal() 同逻辑——两入口待统一去重）
          let presMap: Record<string, number> = {};
          try {
            const pr = await fetch(syncEndpoint() + "/sync/agent-presence", { signal: AbortSignal.timeout(10_000), headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA } });
            const pj: any = await pr.json();
            for (const pa of (pj?.agents ?? [])) presMap[String(pa.sid)] = Date.parse(String(pa.last_seen || "").replace(" ", "T") + "Z") || 0;
          } catch { /* presence 拉取失败 → 全离线 */ }
          const agentState = (a: any): string => {
    // 2026-09-08（用户：对齐 AHW+FBO 状态机——不显示自创 [在线]）：清单上报 state（AHW+FB）优先；presence 过期修正 [O]；无 state 旧数据 presence 兜底
    const st = typeof a?.state === 'string' && a.state.length === 2 ? a.state : '';
    const pres = presMap[String(a?.sid ?? '')];
    if (st) { if (pres && Date.now() - pres > 300000) return ' [O]'; return ' [' + st[0] + '] [' + st[1] + ']'; }
    if (!pres) return ' [O]';
    return Date.now() - pres < 300000 ? ' [A]' : ' [O]';
  };
          // 2026-09-07（Bug2 联动修复）：agents 现为结构化数组（X-Device-Agents 心跳存 listAgents JSON）——旧版从 genshin d 文本 "· N agents" 提取——兼容两者
          const agentCount = (d: any): string => {
            if (Array.isArray(d.agents)) return String(d.agents.length);
            const raw = typeof d.agents === "string" ? d.agents : "";
            if (raw) return (raw.match(/·\s*(\d+)\s*agents/) || [])[1] || (raw.includes("agents") ? "?" : "0");
            return "0";
          };
          const agentsToText = (d: any): string => {
            if (Array.isArray(d.agents) && d.agents.length) {
              // 状态优先——版本号/模型不默认显示
              return d.agents.map((a: any) => `  ${a.name || a.sid}${a.sid && a.sid !== a.name ? " (" + a.sid + ")" : ""}` + agentState(a)).join("\n");
            }
            return typeof d.agents === "string" && d.agents ? d.agents : "(该设备还没上传 agent 清单——跑过 genshin d 或多设备 45s 心跳后可见)";
          };
          // 视图 2：device=<id> → 该设备 genshin 输出全文
          if (p.device) {
            const hit = ds.find((d: any) => String(d.device_id) === String(p.device));
            if (!hit) return { content: [{ type: "text", text: "(找不到设备 " + p.device + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
            const name = hit.device_name && hit.device_name !== hit.device_id ? hit.device_name : hit.device_id;
            const txt = agentsToText(hit);
            return { content: [{ type: "text", text: "── " + name + " 的 agents" + (hit.synced_at ? " (快照 " + fmtTs(hit.synced_at) + ")" : "") + ": ──\n" + txt }], details: { social: true, action: "global", view: p.device, count: 1, lines: [] } };
          }
          // 视图 1：view="device" → 设备列表
          if (p.view === "device") {
            const lines: string[] = [];
            for (const d of ds) {
              const name = d.device_name && d.device_name !== d.device_id ? d.device_name : d.device_id;
              const nAgents = agentCount(d);
              lines.push("  " + name + " (" + d.device_id + ")  agents:" + nAgents + (d.synced_at ? "  同步:" + fmtTs(d.synced_at) : "") + (String(d.device_id) === b.deviceId ? "  [本机]" : ""));
            }
            return { content: [{ type: "text", text: "设备 (" + ds.length + "):\n" + lines.join("\n") }], details: { social: true, action: "global", view: "device", count: ds.length, lines } };
          }
          // 默认：跨设备 agents 概览——每设备一行（agent 数从 genshin 输出 "· N agents" 提取）
          const lines: string[] = [];
          for (const d of ds) {
            const name = d.device_name && d.device_name !== d.device_id ? d.device_name : d.device_id;
            const nAgents = agentCount(d);
            lines.push("  " + name + " (" + d.device_id + ")" + (String(d.device_id) === b.deviceId ? "  [本机]" : "") + "  · " + nAgents + " agents" + (d.synced_at ? "  同步:" + fmtTs(d.synced_at) : ""));
            // 2026-09-07（用户：agent 没显示具体设备——垃圾）：设备行下缩进列 agent（跨设备 agent 带设备一目了然）
            if (Array.isArray(d.agents) && d.agents.length) {
              for (const ag of d.agents) {
                lines.push("      " + (ag.name || ag.sid) + (ag.sid && ag.sid !== ag.name ? " (" + ag.sid + ")" : "") + agentState(ag));
              }
            }
          }
          if (!lines.length) return { content: [{ type: "text", text: "(无设备——多设备跑过 genshin d 后可见)" }], details: { social: true, action: "global", count: 0, lines: [] } };
          return { content: [{ type: "text", text: "跨设备 (" + ds.length + " 设备):\n" + lines.join("\n") + "\n\n细节: social({action:'global',view:'device'}) 设备列表；social({action:'global',device:'<id>'}) 看设备 agents" }], details: { social: true, action: "global", count: ds.length, lines } };
        }
        case "inbox": {
          const limit = Math.min(50, Math.max(1, p.limit ?? 20));
          const msgs = readInbox(getMySid(), 2000);
          const split = splitPending(getMySid(), msgs);
          const pending = split.injectable;
          const lines: string[] = [];
          // 2026-09-24（用户）：inbox 显示改成「total in history / No new message / in this session / (today) of (total)」，
          // 不再用 "-- pending (N) -- / -- history (N) -- / (inbox empty)" 这种垃圾格式。
          const now = Date.now();
          const sessionStart = now - Math.round(process.uptime() * 1000);
          const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
          const todayCount = msgs.filter(m => m.ts >= dayStart.getTime()).length;
          const inSessionCount = msgs.filter(m => m.ts >= sessionStart).length;
          const total = msgs.length;
          lines.push(`${total} total in history`);
          if (pending.length) {
            lines.push(`${pending.length} new message${pending.length > 1 ? "s" : ""}`);
            for (const m of pending) lines.push(`  [${m.mode_used}] ${m.chan ? m.chan + " · " : ""}${m.from_name} (${fmtTime(m.ts)}): ${m.text}`);
          } else {
            lines.push("No new message");
          }
          lines.push(`${inSessionCount} in this session`);
          lines.push(`${todayCount} (today) of ${total} (total in history)`);
          // 被静音房间的消息：**不自动注入**，只给「N 条未读 + 最新一条预览」，要看全文用 social check-message <房间id>
          // （2026-09-24 用户定稿：mute ≠ 降级 queue；手动 inbox 只给计数+预览）
          const mutedMsgs = split.muted;
          if (mutedMsgs.length) {
            const byRoom = new Map<string, SocialMsg[]>();
            for (const m of mutedMsgs) { const k = m.chan_id || m.chan || "?"; const arr = byRoom.get(k) ?? []; arr.push(m); byRoom.set(k, arr); }
            lines.push(`${mutedMsgs.length} muted (静音房间——用 social check-message <房间id> 查看)`);
            for (const [rid, arr] of byRoom) {
              const last = arr.reduce((a, b) => (a.ts >= b.ts ? a : b));
              const preview = String(last.text ?? "").replace(/\s+/g, " ").slice(0, 20);
              lines.push(`  ${last.chan || rid} (${rid}): ${arr.length} 条未读 · 最新 "${preview}${String(last.text ?? "").length > 20 ? "…" : ""}"`);
            }
          }
          if (p.history === true) {
            const history = msgs.filter(m => m.injected).slice(-Math.max(0, limit - pending.length));
            if (history.length) {
              lines.push(`-- history (${history.length}) --`);
              for (const m of history) lines.push(`  ${m.chan ? m.chan + " · " : ""}${m.from_name} (${fmtTime(m.ts)}): ${m.text}`);
            }
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details: { social: true, action: "inbox", count: pending.length, lines } };
        }
        case "check-message": {
          // 取消息 / 查历史（2026-09-24 用户定稿）——id 与 name 都支持；不支持 full
          //   check-message                    → 所有未读（new）
          //   check-message new                → 同上
          //   check-message <房间id|名>         → 概览：共 N 条 / M 条新（提示用 new）
          //   check-message <id> latest N      → 最新 N 条
          //   check-message <id> latest A-B    → 最新第 A..B 条（继续往早翻）
          //   非 room（普通会话）= 传 agent 的 sid/名 → 查与该 agent 的往来
          const arg1 = String(p.gid ?? "").trim();
          const arg2 = String(p.text ?? "").trim();
          const inbox = readInbox(getMySid(), 2000);
          const meSid = getMySid();
          // ① new（或空参）：所有未读（拿走即已读）
          if (!arg1 || arg1 === "new") {
            const unread = inbox.filter(m => !m.injected);
            if (!unread.length) return { content: [{ type: "text", text: "check-message: 没有未读" }], details: { social: true, action: "check-message", count: 0, lines: [] } };
            const lines = unread.map(m => `${m.chan ? `[${m.chan} ${m.chan_id ?? ""}] ` : ""}${m.from_name} (${fmtTime(m.ts)}): ${m.text}`);
            markInjected(meSid, unread.map(m => m.id));
            refreshSocialPending();
            return { content: [{ type: "text", text: `new — ${unread.length} 条未读：\n${lines.map(l => "  " + l).join("\n")}` }], details: { social: true, action: "check-message", count: unread.length, lines } };
          }
          // ② 解析目标：房间（6 位 hex，历史房有 9/12 位变体）或普通会话（agent sid 8 位 hex / 名字）——同空间、用位数区分
          const isSidLike = /^[a-f0-9]{8}$/.test(arg1);
          const isRoomIdLike = /^[a-f0-9]{6}$/.test(arg1);   // 注：非 8 位一律先按房间/名字查（findPublic 兜底），故历史变长编号仍可用
          const room = isRoomIdLike || !isSidLike ? findPublic(arg1) : null;
          const rid = room ? room.id : null;
          const peer = rid ? null : (resolveSid(arg1) ?? arg1);
          // 会话消息（房间 = 房间日志；普通会话 = 我的 inbox 里与对方的往来）
          const rows: Array<{ k: string; ts: number; who: string; text: string }> = rid
            ? readPublicMsgs(rid).map((m: any) => ({ k: `#${m.seq}`, ts: Number(m.ts) || 0, who: m.from_name || m.from, text: String(m.text ?? "") }))
            : inbox.filter(m => m.from === peer || m.to === peer).map(m => ({ k: fmtTime(m.ts), ts: m.ts, who: m.from_name || m.from, text: m.text }));
          rows.sort((a, b) => a.ts - b.ts);
          const unread = rid
            ? inbox.filter(m => !m.injected && (m.chan_id === rid || m.chan === rid))
            : inbox.filter(m => !m.injected && (m.from === peer || m.to === peer));
          const fullId = room ? room.id : String(peer);           // 用户要求：显示 id 要显示全，不要摘要
          const label = room ? `"${room.name}" (${fullId})` : `${localNameOf(String(peer)) ?? String(peer)} (${fullId})`;
          // ③ latest N / latest A-B
          const mwin = arg2.match(/^latest(?:\s+(\d+))?(?:\s*-\s*(\d+))?$/i);
          if (mwin) {
            const hi = Number(mwin[1] ?? 10) || 10;
            const lo = Number(mwin[2] ?? 0) || 0;
            const from = Math.max(0, rows.length - hi);
            const to = Math.max(from, rows.length - lo);
            const slice = rows.slice(from, to);
            if (!slice.length) return { content: [{ type: "text", text: `check-message ${label}: 该区间无消息（共 ${rows.length} 条）` }], details: { social: true, action: "check-message", count: 0, lines: [] } };
            const lines = slice.map(r => `${r.k} ${r.who}: ${r.text}`);
            return { content: [{ type: "text", text: `check-message ${label} latest ${lo ? `${hi}-${lo}` : hi}（共 ${rows.length} 条，本次 ${slice.length} 条）:\n${lines.map(l => "  " + l).join("\n")}` }], details: { social: true, action: "check-message", count: slice.length, lines } };
          }
          // ④ 只给目标：概览（总数 / 新数 / 提示）
          const tipKey = room ? room.id : String(peer);
          return { content: [{ type: "text", text: `check-message ${label}：共 ${rows.length} 条消息，${unread.length} 条新。\n  → 查看新消息：social({action:"check-message"}) 或 check-message new\n  → 查看历史：check-message ${tipKey} latest 10（继续往早：latest 10-20）` }], details: { social: true, action: "check-message", count: rows.length, unread: unread.length, lines: [`total ${rows.length}`, `new ${unread.length}`] } };
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
              const lines = gs.map(g => `${g.id} "${g.name}" (${g.members.length} members)${mutes.includes(g.id) ? " [@muted]" : ""}\n      members: ${g.members.map((x: string) => displayName(x) || x).join(", ")}`);
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
        case "public": {
          // public 聊天室（champion-01 2026-09-24）——⚠️ 仅供跨框架（与非 teyvat agent）聊天；
          // teyvat 内部 agent 之间用普通 social / social global 即可，无需这个。
          // 房间 id 复用 gid 字段传递。
          const gop = String(p.gop ?? "").trim();
          const me = getMySid();
          const meName = getMyName();
          sweepExpiredPublics();   // TTL 惰性回收：先回收过期房间，再做本次操作
          switch (gop) {
            case "create": {
              const name = String(p.gname ?? "").trim();
              if (!name) throw new Error("social public create: gname required");
              const members = (p.members ?? [])
                .map((m: string) => resolveSid(String(m).trim()) ?? String(m).trim())
                .filter((m: string) => !!m && m !== me && m !== meName);
              // 房间编号独立空间（2026-09-24 用户要求：room id 与 agent id 不能在同一个空间，位数不同）
              // 房间编号：与 agent sid **同空间（都是 hex）、仅位数不同**（room 6 位 / agent 8 位）
              // —— 2026-09-24 用户定稿：不要自造前缀/自造进制，保持 hex，用位数区分空间；6 位 = 16^6 ≈ 1677 万，
              //    实际房间数是个位到几十，纯随机即可，撞了就重摇（不用时间戳，时间戳会吃掉随机位）
              let rid = "";
              for (let i = 0; i < 8; i++) {
                rid = Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, "0");
                if (!loadPublic(rid)) break;
              }
              const ttl = Number(p.ttl_minutes ?? 0) || 0;
              const allMembers = [me, ...members];
              const names: Record<string, string> = {};
              for (const x of allMembers) names[x] = localNameOf(x) ?? x;
              const room: PublicRoom = { id: rid, name, members: allMembers, member_names: names, created: Date.now(), created_by: me, closed: false, ...(ttl > 0 ? { ttl_minutes: ttl } : {}) };
              savePublic(room);
              const memList = room.members.map((x: string) => memberLabel(room, x)).join(", ");
              return { content: [{ type: "text", text: `Public room "${name}" created (${rid})\nadmin: ${memberLabel(room, me)}  members: ${memList}` }], details: { social: true, action: "public", gop: "create", roomId: rid, roomName: name, count: room.members.length, lines: [`${rid} "${name}"`, `members: ${memList}`] } };
            }
            case "list": {
              const all = listPublics();
              if (!all.length) return { content: [{ type: "text", text: "(no public rooms)" }], details: { social: true, action: "public", gop: "list", count: 0, lines: [] } };
              const lines = all.map(r => {
                const members = r.members.map((x: string) => memberLabel(r, x)).join(", ") || "(none)";
                return `${r.id} "${r.name}" ${r.closed ? (r.closed_reason === "expired" ? "[expired]" : "[dissolved]") : "[open]"}${r.members.includes(me) ? " (joined)" : ""}${publicMuteTag(loadPublicMuteStateOf(me, r.id))}  admin: ${displayName(r.created_by)}\n      members(${r.members.length}): ${members}`;
              });
              return { content: [{ type: "text", text: `Public rooms:\n${lines.map(l => "  " + l).join("\n")}` }], details: { social: true, action: "public", gop: "list", count: all.length, lines } };
            }
            case "join": {
              const rid = String(p.gid ?? "").trim();
              if (!rid) throw new Error("social public join: gid(房间编号或名称) required");
              const r = findPublic(rid);
              if (!r) throw new Error(`social public join: room ${rid} not found`);
              if (r.closed) throw new Error(`social public join: room "${r.name}" ${closedWord(r)}`);
              // 注册身份必须起名（2026-09-24 用户要求：不能只有 id）——本地 agent 自动取注册名，外部 agent 必须传 mname
              const declared = String(p.mname ?? "").trim() || localNameOf(me) || "";
              if (!declared) throw new Error("social public join: 请用 mname 指定你的名字——注册身份必须有名字，不能只有 id");
              if (!r.member_names) r.member_names = {};
              r.member_names[me] = declared;
              if (!r.members.includes(me) && !r.members.includes(meName)) r.members.push(me);
              savePublic(r);
              return { content: [{ type: "text", text: `Joined "${r.name}" (${r.id}) as "${declared}" — members: ${r.members.length}` }], details: { social: true, action: "public", gop: "join", roomId: r.id, roomName: r.name, memberName: declared, count: r.members.length, lines: [`joined ${r.id}`, `as: ${declared}`, `members: ${r.members.length}`] } };
            }
            case "leave": {
              const rid = String(p.gid ?? "").trim();
              if (!rid) throw new Error("social public leave: gid(房间编号或名称) required");
              const r = findPublic(rid);
              if (!r) throw new Error(`social public leave: room ${rid} not found`);
              // 创建者退出（2026-09-24）：唯一出口是「房里只剩他一人 → 自动解散」（避免无 admin 孤儿房）；
              // 否则必须先移交管理权（移交机制待用户定），并给出明确出路提示。
              const isCreator = r.created_by === me || r.created_by === meName;
              const others = r.members.filter((x: string) => x !== me && x !== meName);
              if (isCreator) {
                if (others.length === 0) {
                  r.closed = true;
                  r.closed_at = Date.now();
                  r.closed_reason = "dissolved";
                  savePublic(r);
                  return { content: [{ type: "text", text: `房间 "${r.name}" (${r.id}) 只剩创建者一人——已自动解散` }], details: { social: true, action: "public", gop: "leave", roomId: r.id, roomName: r.name, count: 0, lines: [`auto-dissolved ${r.id}`] } };
                }
                throw new Error(`social public leave: 创建者不能直接退出——必须先移交管理权（移交机制待定）；或等其他成员全部退出后自动解散`);
              }
              r.members = others;
              savePublic(r);
              return { content: [{ type: "text", text: `Left "${r.name}" (${rid}) — members: ${r.members.length}` }], details: { social: true, action: "public", gop: "leave", roomId: r.id, roomName: r.name, count: r.members.length, lines: [`left ${r.id}`, `members: ${r.members.length}`] } };
            }
            case "send": {
              const rid = String(p.gid ?? "").trim();
              const text = String(p.text ?? "").trim();
              if (!rid) throw new Error("social public send: gid(房间编号或名称) required");
              if (!text) throw new Error("social public send: text required");
              const at = (p.at ?? []).map((a: string) => resolveSid(String(a).trim()) ?? String(a).trim()).filter(Boolean);
              const out = await sendMessage({ to: `public:${rid}`, text, mode: "interrupt", at });
              const receipts = out.receipts as any[];
              const rname2 = loadPublic(rid)?.name ?? rid;
              // 2026-09-24 用户定稿：房间消息的结算**面向房间**——不列个人、不暴露任何接收方的私人状态。
              // 发送方既不该决定、也不该知道接收方是否静音；收件人是「房间」而不是「人」。
              const off = receipts.filter((r: any) => String(r.status).includes("offline")).length;
              // 2026-09-24（tester 实测发现）：房间名不带引号，与摘要行 :1307 一致（原写死 in "${rname2}" 多了引号）
              // 渲染用 `Sent a message in …`（动作式）；content 也**不带 seq**（用户可见——用户问「seq 1 是什么意思」说明 content 也会被看到，故一并去掉；需要序号时用 check-message/history 查）
              return { content: [{ type: "text", text: `Sent a message in ${rname2} (${rid})${at.length ? ` @${at.map((x: string) => displayNameShort(x)).join(", ")}` : ""}${off ? ` (${off} 位成员不在线)` : ""}` }], details: { social: true, action: "public", gop: "send", roomId: rid, roomName: rname2, count: receipts.length, offline: off, seq: out.seq, modeUsed: "interrupt", text, at: at.length ? at : undefined, lines: [] } };
            }
            case "history": {
              const rid = String(p.gid ?? "").trim();
              if (!rid) throw new Error("social public history: gid(房间编号或名称) required");
              const r = findPublic(rid);
              if (!r) throw new Error(`social public history: room ${rid} not found`);
              const lim = Number(p.limit ?? 20) || 20;
              const msgs = readPublicMsgs(r.id).slice(-lim);
              const lines = msgs.map((m: any) => `#${m.seq} ${m.from_name || m.from}: ${m.text}`);
              return { content: [{ type: "text", text: `History "${r.name}" (${rid})${r.closed ? " [dissolved]" : ""} — last ${msgs.length}:\n${lines.map(l => "  " + l).join("\n") || "  (empty)"}` }], details: { social: true, action: "public", gop: "history", roomId: r.id, roomName: r.name, count: msgs.length, lines } };
            }
            case "dissolve": {
              const rid = String(p.gid ?? "").trim();
              if (!rid) throw new Error("social public dissolve: gid(房间编号或名称) required");
              const r = findPublic(rid);
              if (!r) throw new Error(`social public dissolve: room ${rid} not found`);
              if (r.created_by !== me && r.created_by !== meName) throw new Error(`social public dissolve: 只有创建者可解散（admin: ${displayName(r.created_by)}）`);
              if (r.closed) throw new Error(`social public dissolve: room "${r.name}" ${closedWord(r)}`);
              r.closed = true;
              r.closed_at = Date.now();
              r.closed_reason = "dissolved";
              savePublic(r);
              const notice = `[解散] 房间 "${r.name}" (${rid}) 已被创建者解散。历史仍可读，不可再发。`;
              const offline: string[] = [];
              let notified = 0;
              for (const m of r.members.map((x: string) => resolveSid(x) ?? x).filter((x: string) => /^[a-f0-9]{8}$/.test(x))) {
                if (m === me) continue;
                if (!isAgentActive(m)) { offline.push(m); continue; }
                try { await sendOne(m, notice, "interrupt", [], null, me, meName); notified++; }
                catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] dissolve notify failed for " + m + ": " + ((e as any)?.message || e)); }
              }
              return { content: [{ type: "text", text: `Dissolved "${r.name}" (${rid}) — notified ${notified}, offline ${offline.length}` }], details: { social: true, action: "public", gop: "dissolve", roomId: r.id, roomName: r.name, count: notified, lines: [`dissolved ${r.id}`, `notified: ${notified}, offline: ${offline.length}`] } };
            }
            case "mute": {
              const rid = String(p.gid ?? "").trim();
              if (!rid) throw new Error("social public mute: gid(房间编号或名称) required");
              const r = findPublic(rid);
              if (!r) throw new Error(`social public mute: room ${rid} not found`);
              const on = p.on !== false;
              // 与 join/send/history 对齐：已解散房间不再有任何消息，静音无意义 → 拒绝；
              // 但允许 on:false（取消静音）作为幂等清理（ISSUE: 联调发现 mute 曾静默成功）。
              if (r.closed && on) throw new Error(`social public mute: room "${r.name}" (${r.id}) ${closedWord(r)}——静音无意义（不再有房间消息）；如需清理旧静音，用 on:false`);
              const st = setPublicMuteFlags(r.id, { mute: on });
              return { content: [{ type: "text", text: `Public room "${r.name}" ${on ? "muted" : "unmuted"} for you (${r.id})${on ? "（@ 仍可突破）" : ""}` }], details: { social: true, action: "public", gop: "mute", roomId: r.id, roomName: r.name, lines: [`${on ? "muted" : "unmuted"} ${r.id}`], mute: st.mute, at_mute: st.at_mute } };
            }
            case "manage": {
              // 管理自己在该房间的权限/设置（2026-09-24 用户定稿：用某个 public 的 id/name 的 manage 来管理自己的权限）
              // 不带参数 = 只读展示当前设置
              const key = String(p.gid ?? "").trim();
              if (!key) throw new Error("social public manage: gid(房间编号或名称) required");
              const r = findPublic(key);
              if (!r) throw new Error(`social public manage: room ${key} not found`);
              const cur = loadPublicMuteStateOf(me, r.id);
              const mute = p.mute;
              const atMute = p.at_mute;
              if (mute === undefined && atMute === undefined) {
                return { content: [{ type: "text", text: `"${r.name}" (${r.id}) 你的设置：room mute=${cur.mute === true}, @mute=${cur.at_mute === true}\n（默认 @ 可突破静音；要到 @ 也不打断，需先 mute:true 再 at_mute:true）` }], details: { social: true, action: "public", gop: "manage", roomId: r.id, roomName: r.name, lines: [`${r.id} mute=${cur.mute === true} at_mute=${cur.at_mute === true}`], mute: cur.mute === true, at_mute: cur.at_mute === true } };
              }
              if (r.closed && (mute === true || atMute === true)) throw new Error(`social public manage: room "${r.name}" (${r.id}) ${closedWord(r)}——不能再开启静音`);
              const st = setPublicMuteFlags(r.id, { ...(mute !== undefined ? { mute } : {}), ...(atMute !== undefined ? { at_mute: atMute } : {}) });
              const desc = st.mute ? (st.at_mute ? "房间静音 + @ 也静音" : "房间静音（@ 仍可突破）") : "不静音（全部收）";
              return { content: [{ type: "text", text: `"${r.name}" (${r.id}) 已更新：${desc}` }], details: { social: true, action: "public", gop: "manage", roomId: r.id, roomName: r.name, lines: [`${r.id} ${desc}`], mute: st.mute, at_mute: st.at_mute } };
            }
            case "rename": {
              // 改名（编号不变）——2026-09-24 用户要求：支持改名但编号不可更改。仅创建者可改。
              const key = String(p.gid ?? "").trim();
              const newName = String(p.gname ?? "").trim();
              if (!key) throw new Error("social public rename: gid(房间编号或名称) required");
              if (!newName) throw new Error("social public rename: gname(新名称) required");
              const r = findPublic(key);
              if (!r) throw new Error(`social public rename: room ${key} not found`);
              if (r.closed) throw new Error(`social public rename: room "${r.name}" (${r.id}) ${closedWord(r)}——不可改名（历史仍可读）`);
              if (r.created_by !== me && r.created_by !== meName) throw new Error(`social public rename: 只有创建者可改名（admin: ${displayName(r.created_by)}）`);
              const old = r.name;
              r.name = newName;
              savePublic(r);
              return { content: [{ type: "text", text: `Renamed "${old}" → "${newName}"（编号 ${r.id} 不变）` }], details: { social: true, action: "public", gop: "rename", roomId: r.id, roomName: newName, oldName: old, lines: [`${r.id}: "${old}" → "${newName}"`] } };
            }
            default:
              throw new Error(`social public: unknown gop "${gop}" (create|list|join|leave|send|history|rename|dissolve|manage|mute)`);
          }
        }
        default:
          throw new Error(`social: unknown action "${action}" (send|list|inbox|check-message|focus|group|public)`);
      }
    },
  });
}

// ── 消息渲染器（blockrender 兼容）────────────────────────────────────
// ── 跨设备 agents 视图（2026-09-08 用户：list/global 应组合参数——提取共享供 list scope=global 与 global 兼容别名调用）──
// 拉 /auth/devices → 三视图：device=<id> 设备 agents 详情 / view='device' 设备列表 / 默认跨设备概览（每设备+agent 明细）
async function socialGlobal(p: any, b: any): Promise<any> {
  if (!b?.token || !b?.deviceId) return { content: [{ type: "text", text: "(未绑定——先 genshin login)" }], details: { social: true, action: "global", count: 0, lines: [] } };
  const H = { Authorization: "Bearer " + b.token, "X-Device-Id": b.deviceId, "X-Device-Name": require("os").hostname(), "User-Agent": SYNC_UA };
  const _url = syncEndpoint() + "/auth/devices";
  let res: Response;
  try { res = await fetch(_url, { signal: AbortSignal.timeout(10_000), headers: H }); } catch (e: any) {
    return { content: [{ type: "text", text: "(global 网络错误: " + (e?.message || e) + (e?.cause?.message ? " | cause: " + e.cause.message : "") + " | url=" + _url + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
  }
  if (!res.ok) return { content: [{ type: "text", text: "(server 查询失败: HTTP " + res.status + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
  const j: any = await res.json();
  const ds = (j?.devices ?? []).filter((d: any) => d.device_id === b.deviceId || (d.agents && String(d.agents).length > 2) || !d.archived);
  const fmtTs = (s: string) => { if (!s) return ""; try { return new Date(String(s).replace(" ", "T") + "Z").toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); return s; } };
  // 2026-09-08（用户怒批：一堆版本号没状态——"最重要的状态默认要显示，版本号用 version 参数看"）：拉 presence 拿各 agent 实时在线状态
  let presMap: Record<string, number> = {};
  try {
    const pr = await fetch(syncEndpoint() + "/sync/agent-presence", { signal: AbortSignal.timeout(10_000), headers: { "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA } });
    const pj: any = await pr.json();
    for (const pa of (pj?.agents ?? [])) presMap[String(pa.sid)] = Date.parse(String(pa.last_seen || "").replace(" ", "T") + "Z") || 0;
  } catch { /* presence 拉取失败 → 全离线显示 */ }
  const agentState = (a: any): string => {
    // 2026-09-08（用户：对齐 AHW+FBO 状态机——不显示自创 [在线]）：清单上报 state（AHW+FB）优先；presence 过期修正 [O]；无 state 旧数据 presence 兜底
    const st = typeof a?.state === 'string' && a.state.length === 2 ? a.state : '';
    const pres = presMap[String(a?.sid ?? '')];
    if (st) { if (pres && Date.now() - pres > 300000) return ' [O]'; return ' [' + st[0] + '] [' + st[1] + ']'; }
    if (!pres) return ' [O]';
    return Date.now() - pres < 300000 ? ' [A]' : ' [O]';
  };
  const agentCount = (d: any): string => {
    if (Array.isArray(d.agents)) return String(d.agents.length);
    const raw = typeof d.agents === "string" ? d.agents : "";
    if (raw) return (raw.match(/·\s*(\d+)\s*agents/) || [])[1] || (raw.includes("agents") ? "?" : "0");
    return "0";
  };
  const agentsToText = (d: any): string => {
    if (Array.isArray(d.agents) && d.agents.length) {
      // 状态优先——版本号/模型不默认显示（要看用 version/model 参数）
      return d.agents.map((a: any) => `  ${a.name || a.sid}${a.sid && a.sid !== a.name ? " (" + a.sid + ")" : ""}` + agentState(a)).join("\n");
    }
    return typeof d.agents === "string" && d.agents ? d.agents : "(该设备还没上传 agent 清单——跑过 genshin d 或多设备 45s 心跳后可见)";
  };
  if (p.device) {
    const hit = ds.find((d: any) => String(d.device_id) === String(p.device));
    if (!hit) return { content: [{ type: "text", text: "(找不到设备 " + p.device + ")" }], details: { social: true, action: "global", count: 0, lines: [] } };
    const name = hit.device_name && hit.device_name !== hit.device_id ? hit.device_name : hit.device_id;
    const txt = agentsToText(hit);
    return { content: [{ type: "text", text: "── " + name + " 的 agents" + (hit.synced_at ? " (快照 " + fmtTs(hit.synced_at) + ")" : "") + ": ──\n" + txt }], details: { social: true, action: "global", view: p.device, count: 1, lines: [] } };
  }
  if (p.view === "device") {
    const lines: string[] = [];
    for (const d of ds) {
      const name = d.device_name && d.device_name !== d.device_id ? d.device_name : d.device_id;
      const nAgents = agentCount(d);
      lines.push("  " + name + " (" + d.device_id + ")  agents:" + nAgents + (d.synced_at ? "  同步:" + fmtTs(d.synced_at) : "") + (String(d.device_id) === b.deviceId ? "  [本机]" : ""));
    }
    return { content: [{ type: "text", text: "设备 (" + ds.length + "):\n" + lines.join("\n") }], details: { social: true, action: "global", view: "device", count: ds.length, lines } };
  }
  const lines: string[] = [];
  for (const d of ds) {
    const name = d.device_name && d.device_name !== d.device_id ? d.device_name : d.device_id;
    const nAgents = agentCount(d);
    lines.push("  " + name + " (" + d.device_id + ")" + (String(d.device_id) === b.deviceId ? "  [本机]" : "") + "  · " + nAgents + " agents" + (d.synced_at ? "  同步:" + fmtTs(d.synced_at) : ""));
    if (Array.isArray(d.agents) && d.agents.length) {
      for (const ag of d.agents) {
        lines.push("      " + (ag.name || ag.sid) + (ag.sid && ag.sid !== ag.name ? " (" + ag.sid + ")" : "") + agentState(ag));
      }
    }
  }
  if (!lines.length) return { content: [{ type: "text", text: "(无设备——多设备跑过 genshin d 后可见)" }], details: { social: true, action: "global", count: 0, lines: [] } };
  return { content: [{ type: "text", text: "跨设备 (" + ds.length + " 设备):\n" + lines.join("\n") + "\n\n细节: social({action:'global' 或 list scope:'global', view:'device'}) 设备列表；device:'<id>' 看设备 agents（状态=实时 presence，版本/模型不默认显示）" }], details: { social: true, action: "global", count: ds.length, lines } };
}

function registerSocialRenderer(pi: ExtensionAPI): void {
  // 2026-09-13：budget-trip 补渲染器（backbone 声明 render:true 但从未注册——check-deploy 门禁第 6 段拦）。@UNUSED 类型但历史 session 回放可能命中，渲染成系统通知样式。
  pi.registerMessageRenderer("budget-trip", (message: any, _opts: any, theme: any) => {
    const { Text } = require("@earendil-works/pi-tui");
    const d = message.details || {};
    const body = d.text || d.message || "";
    return new Text(theme.fg("warning", "◇ ") + theme.bold("Budget Alert") + (body ? " — " + body : ""), 0, 0);
  });
  pi.registerMessageRenderer("social-message", (message: any, _opts: any, theme: any) => {
    const { Container, Text } = require("@earendil-works/pi-tui");
    const d = message.details || {};
    const from = d.from_name || d.from || "unknown";
    const chanTag = d.chan ? `${d.chan} · ` : "";   // 群/房间名（2026-09-24 用户要求：渲染不能只有发件人）
    const mode = d.mode_used || d.mode || "";
    const atTag = d.at?.length ? ` @${d.at.join(",")}` : "";
    // 收到消息：➤ from [mode] · HH:MM（时间戳在标签行尾，不沉底）— 专属 socialMessage 青蓝色
    // 2026-08-18 调暗：原 #4FC1FF（L65%）→ #3DBBFF（L62%，用户：message 太亮，与鲢鱼蓝 Result #718EF4 协调）
    // 2026-08-18 符号：◆ → ▸ → ➤（用户定稿：消息 ➤ / Result • / 事件 ✤；2026-08-27 Result 符号 » 改蓝点 •）
    const tsTag = d.ts ? ` · ${fmtTime(d.ts)}` : "";
    const label = `${chanTag}${from}${atTag} [${mode}]${tsTag}`;
    const content = emojifyTerminalSafe((message.content ?? "").toString());
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

// 2026-09-13（用户：emoji 在终端缺字形渲染成菱形——support 汇报的 ✅ 即此）：常见 emoji 规范化成终端安全符号。
// 只映射已知问题字符（✓/✗ 大多数字体有），不做 Unicode 范围剥除（避免误伤 ➤◆ 等终端安全符号）。发送侧不用 emoji 靠约定（support 已承诺），这里是渲染层兑底。
function emojifyTerminalSafe(s: string): string {
  return s
    .replace(/✅/g, "✓")
    .replace(/✔️?/g, "✓")
    .replace(/❌/g, "✗")
    .replace(/✖️?/g, "✗")
    .replace(/⚠️/g, "!")
    .replace(/🎉/g, "»")
    .replace(/🚀/g, "»")
    .replace(/🔥/g, "»")
    .replace(/🐛/g, "*")
    .replace(/💡/g, "*")
    .replace(/👍/g, "+");
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  // 2026-09-07（用户：跨电脑消息看不到秒级延迟——观测用）加秒
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
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
      // 2026-09-13：元意识/海马体/睡眠子进程也加载本器官——它们的 session 路径含主 agent 的 id，之前会用主 agent 的 sid registerSelf、
      // 跑自己的 presence/pull、并争抢同一个 triggers/<sid>.json（谁先 unlink 谁把消息注进自己的 session → 主 agent 收不到）。子会话直接不参与。
      if (sf && /metaconsciousnessSessions|HippocampusSessions|SleepSessions|NapSessions/.test(sf)) return;
      _startNetTick(); // 2026-09-14：幂等——/clear /resume 后确保 45s presence/pull 还在
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
  // 2026-09-13：/reload 会再次执行本入口——之前每次多一套 45s timer 且从不清理（presence/pull 频率 ×N）。句柄放模块级，重入先清；shutdown 也清并上报 offline。
  if (_netTickHandle) { try { clearInterval(_netTickHandle); } catch { /* 已清 */ } _netTickHandle = null; }
  _startNetTick();
  // 2026-09-14：session_shutdown 在 /clear /new /resume /fork /reload 时也会触发——原来一律清定时器 + 上报 offline，
  // 而 /clear /resume 不会重跑扩展工厂，45s 的 presence/pull 从此没了（agent 5 分钟后在 server 上"离线"、收不到远程消息）。只在真正退出时做。
  pi.on("session_shutdown", async (event: any) => {
    const reason = String((event as any)?.reason || "");
    if (["new", "resume", "fork", "reload", "switch"].includes(reason)) return;
    try { if (_netTickHandle) clearInterval(_netTickHandle); } catch { /* 已清 */ }
    // reportOffline 之前从未被调用（注释说 heart 退出钩子调，实际没有）→ 退出后 server 端最多 5 分钟仍显示在线并向其投递
    try { await Promise.race([reportOffline(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* 网络失败不阻塞退出 */ }
  });
}
let _netTickHandle: ReturnType<typeof setInterval> | null = null;
function _startNetTick() {
  if (_netTickHandle) return;
  _netTickHandle = setInterval(() => {
    try { reportPresence("up").catch(() => {}); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 静默 */ }
    try { pullRemoteMessages().catch(() => {}); } catch (e) { console.error("[spirit.bio.organs/social.communicate/communicate.ts] " + ((e as any)?.message || e)); /* 静默 */ }
  }, 45_000);
  if (typeof (_netTickHandle as any)?.unref === "function") (_netTickHandle as any).unref();
}
