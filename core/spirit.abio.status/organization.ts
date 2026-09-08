// 组织是社会层的共享结构：全局注册表 + 成员管理。
// 个体侧的"我属于哪个组织"见 #status_identity（只读）。
//
// 用法 (CLI):
//   organization list                    — 列出所有组织
//   organization create <名称> <成员...> — 创建组织
//   organization join <orgId> <agentId>  — 加入（自动退出其他组织）
//   organization leave <agentId>         — 退出
// 文档: B.docs/Dev.Common/Wiki/Organization(Social Belonging).WIKI

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// PAIMON_HOME: 测试沙箱钩子(Bun 的 homedir() 不跟进程内 HOME 修改)
const ROOT = process.env.PAIMON_HOME || homedir();
const ORG_DIR = path.join(ROOT, ".teyvat/AgentWorkDir/Organizational");
const ORG_FILE = path.join(ORG_DIR, "orgs.json");
const PLIST_FILE = path.join(ROOT, ".teyvat/MemoryData/plist.json");

// ── 类型 ──────────────────────────────────────────────────────
export interface Org {
  id: string;
  name: string;
  members: string[];
  created: string;
}

// ── 存储 ──────────────────────────────────────────────────────
export function loadOrgs(): Org[] {
  try {
    if (!fs.existsSync(ORG_FILE)) return [];
    return JSON.parse(fs.readFileSync(ORG_FILE, "utf8"));
  } catch (e) { console.error("[spirit.abio.status/organization.ts] " + ((e as any)?.message || e)); return []; }
}

export function saveOrgs(orgs: Org[]) {
  try {
    fs.mkdirSync(ORG_DIR, { recursive: true });
    fs.writeFileSync(ORG_FILE, JSON.stringify(orgs, null, 2));
  } catch (e) { console.error("[spirit.abio.status/organization.ts] " + ((e as any)?.message || e)); }
}

function genOrgId(): string {
  // 6位随机hex，不与agent ID冲突（agent是8位）
  return Math.random().toString(16).slice(2, 8);
}

// ── plist 同步：组织变动时更新个体的归属指针 ──────────────────
function setAgentOrg(agentId: string, orgId: string | null) {
  try {
    if (!fs.existsSync(PLIST_FILE)) return;
    const plist = JSON.parse(fs.readFileSync(PLIST_FILE, "utf8"));
    const agent = plist.find((a: any) => a.id === agentId);
    if (agent) {
      if (orgId) agent.org = orgId;
      else delete agent.org;
      fs.writeFileSync(PLIST_FILE, JSON.stringify(plist, null, 2));
    }
  } catch (e) { console.error("[spirit.abio.status/organization.ts] " + ((e as any)?.message || e)); }
}

// ── 组织操作 ──────────────────────────────────────────────────
export function createOrg(name: string, members: string[]): Org {
  const orgs = loadOrgs();
  // 一个 agent 只能在一个组织：先从其他组织移除
  for (const x of orgs) {
    x.members = x.members.filter(m => !members.includes(m));
  }
  const org: Org = { id: genOrgId(), name, members, created: new Date().toISOString().slice(0, 10) };
  orgs.push(org);
  saveOrgs(orgs);
  for (const m of members) setAgentOrg(m, org.id);
  return org;
}

export function joinOrg(orgId: string, agentId: string): { ok: boolean; org?: Org; error?: string } {
  const orgs = loadOrgs();
  const o = orgs.find(x => x.id === orgId);
  if (!o) return { ok: false, error: `组织 ${orgId} 不存在` };
  // 一个 agent 只能在一个组织：先从其他组织移除
  for (const x of orgs) {
    if (x.members.includes(agentId)) {
      x.members = x.members.filter(m => m !== agentId);
    }
  }
  if (!o.members.includes(agentId)) o.members.push(agentId);
  saveOrgs(orgs);
  setAgentOrg(agentId, orgId);
  return { ok: true, org: o };
}

export function leaveOrg(agentId: string): boolean {
  const orgs = loadOrgs();
  let removed = false;
  for (const o of orgs) {
    if (o.members.includes(agentId)) {
      o.members = o.members.filter(m => m !== agentId);
      removed = true;
    }
  }
  if (removed) { saveOrgs(orgs); setAgentOrg(agentId, null); }
  return removed;
}

// ── 查询 ──────────────────────────────────────────────────────
export function getOrg(orgId: string): Org | undefined {
  return loadOrgs().find(o => o.id === orgId);
}

export function getOrgOfAgent(agentId: string): Org | undefined {
  return loadOrgs().find(o => o.members.includes(agentId));
}

// ── CLI 入口 ──────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "create" && rest.length >= 2) {
    const org = createOrg(rest[0], rest.slice(1));
    console.log(`组织「${org.name}」已创建 (${org.id})\n成员: ${org.members.join(", ")}`);
  } else if (cmd === "join" && rest.length === 2) {
    const r = joinOrg(rest[0], rest[1]);
    console.log(r.ok ? `${rest[1]} 已加入「${r.org!.name}」` : r.error);
  } else if (cmd === "leave" && rest.length === 1) {
    console.log(leaveOrg(rest[0]) ? `${rest[0]} 已退出组织` : `${rest[0]} 未在任何组织`);
  } else if (cmd === "list" || !cmd) {
    const orgs = loadOrgs();
    if (orgs.length === 0) { console.log("(暂无组织)"); }
    for (const o of orgs) console.log(`${o.name} (${o.id})\n  成员: ${o.members.join(", ")}\n  创建: ${o.created}`);
  } else {
    console.log("用法: organization list | create <名称> <成员...> | join <orgId> <agentId> | leave <agentId>");
    process.exit(1);
  }
}
