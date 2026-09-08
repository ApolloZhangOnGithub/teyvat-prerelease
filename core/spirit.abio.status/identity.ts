// spirit.abio.identity/identity.ts — 身份查询（独立命令）
// agent 用 `identity` 查询"我是谁"：注册信息、组织归属、记忆等。
// 组织本身是社会结构（#status_organization）；这里只回答个体视角的问题。
//
// 用法:
//   identity              — 查自己（PAIMON_AGENT_ID / PAIMON_AGENT_NAME）
//   identity <id|名字>    — 查指定 agent
// 文档: B.docs/Dev.Common/Wiki/Identity.WIKI

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getOrgOfAgent, type Org } from "#status_organization";

// 本地时间格式化（用户要求：所有时间显示统一本地时区，不用 UTC slice）
function fmtLocal(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return (ts || "").slice(0, 19).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const PLIST_FILE = path.join(homedir(), ".teyvat/MemoryData/plist.json");
// 2026-08-18 统一配置目录（用户定稿：以后只用 ~/.teyvat，不用 ~/.pi 的垃圾）：
// 原 path.join(homedir(), ".pi/memory") 是 0.3.0 paimon→genshin 更名遗留——~/.pi/memory 不存在，
// 导致 identity.memoryDir 一直是 undefined。记忆实际在 ~/.teyvat/MemoryData/<id>/。
const MEMORY_ROOT = path.join(homedir(), ".teyvat/MemoryData");

// ── 类型 ──────────────────────────────────────────────────────
export interface AgentRecord {
  id: string;
  name: string;
  kind?: string;
  created?: string;
  lastSeen?: string;
  note?: string;
  model?: string;
  org?: string;
  archived?: boolean;
}

export interface Identity {
  ref: string;              // 查询时用的标识
  registered: boolean;      // 是否在 plist 注册
  record?: AgentRecord;     // plist 记录
  org?: Org;                // 组织归属（来自社会层注册表）
  memoryDir?: string;       // 记忆目录（存在才有）
  version?: { genshin?: string; pi?: string; channel?: string; ts?: string };
}

// ── plist ─────────────────────────────────────────────────────
function loadPlist(): AgentRecord[] {
  try {
    return JSON.parse(fs.readFileSync(PLIST_FILE, "utf8"));
  } catch (e) { console.error("[spirit.abio.status/identity.ts] " + ((e as any)?.message || e)); return []; }
}

// ── 解析身份：显式参数 > PAIMON_AGENT_ID > PAIMON_AGENT_NAME ──
export function resolveRef(explicit?: string): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.PAIMON_AGENT_ID) return process.env.PAIMON_AGENT_ID.trim();
  if (process.env.PAIMON_AGENT_NAME) return process.env.PAIMON_AGENT_NAME.trim();
  return null;
}

// ── 查询 ──────────────────────────────────────────────────────
export function getIdentity(ref: string): Identity {
  const plist = loadPlist();
  const record = plist.find(a => a.id === ref) || plist.find(a => a.name === ref);
  const agentId = record?.id || ref;

  const identity: Identity = {
    ref,
    registered: !!record,
    record,
    org: getOrgOfAgent(agentId),
  };

  const memDir = path.join(MEMORY_ROOT, agentId);
  if (fs.existsSync(memDir)) identity.memoryDir = memDir;

  // 版本号：从 startup.log 读取
  try {
    const slog = path.join(homedir(), ".teyvat", "LogData", agentId, "startup.log");
    const lines = fs.readFileSync(slog, "utf8").trim().split("\n");
    identity.version = JSON.parse(lines[lines.length - 1]);
  } catch (e) { console.error("[spirit.abio.status/identity.ts] " + ((e as any)?.message || e)); }

  return identity;
}

// ── 渲染 ──────────────────────────────────────────────────────
export function renderIdentity(idn: Identity): string {
  const lines = ["═══ 身份 ═══", ""];

  if (idn.record) {
    const r = idn.record;
    lines.push(`  ID:   ${r.id}`);
    lines.push(`  名字: ${r.name}`);
    if (r.kind) lines.push(`  类型: ${r.kind}`);
    // Model: plist first, fallback to settings.json
    let model = r.model;
    if (!model) {
      try {
        const settingsPath = path.join(homedir(), ".teyvat/config/settings.json");
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        model = settings.defaultModel;
      } catch (e) { console.error("[spirit.abio.status/identity.ts] " + ((e as any)?.message || e)); }
    }
    if (model) lines.push(`  模型: ${model}`);
    if (r.created) lines.push(`  创建: ${fmtLocal(r.created)}`);
    if (r.lastSeen) lines.push(`  上次活跃: ${fmtLocal(r.lastSeen)}`);
    if (r.note) lines.push(`  备注: ${r.note}`);
    if (r.archived) lines.push(`  状态: 已归档`);
  } else {
    lines.push(`  标识: ${idn.ref}`);
    lines.push(`  (未在 plist 注册——临时身份或外部调用者)`);
  }

  lines.push("");
  if (idn.org) {
    lines.push(`  组织: ${idn.org.name} (${idn.org.id})`);
    lines.push(`    成员: ${idn.org.members.join(", ")}`);
    lines.push(`    创建: ${idn.org.created}`);
  } else {
    lines.push("  组织: 无（未加入任何组织）");
  }

  if (idn.memoryDir) {
    lines.push("");
    lines.push(`  记忆目录: ${idn.memoryDir}`);
  }

  if (idn.version?.genshin) {
    lines.push("");
    lines.push(`  运行时: ${idn.version.genshin} (pi v${idn.version.pi || "?"}, ${idn.version.channel || "?"})`);
    if (idn.version.ts) lines.push(`  启动:   ${fmtLocal(idn.version.ts)}`);
  }

  return lines.join("\n");
}

// ── CLI 入口 ──────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    console.log("identity — 查询 agent 身份信息（注册信息、组织归属、记忆）\n\n用法:\n  identity              查自己 (PAIMON_AGENT_ID / PAIMON_AGENT_NAME)\n  identity <id|名字>    查指定 agent");
    process.exit(0);
  }
  const ref = resolveRef(arg);
  if (!ref) {
    console.error("无法确定身份：请传入 <id|名字>，或设置 PAIMON_AGENT_ID / PAIMON_AGENT_NAME");
    process.exit(1);
  }
  console.log(renderIdentity(getIdentity(ref)));
}
