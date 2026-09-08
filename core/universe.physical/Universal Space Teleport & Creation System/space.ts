// universe.engine/space/space.ts — Space (空间) system implementation
// v0.2 spec: space --env, --detail, --move, --list
// Space defines the environment the model inhabits — who's around, what can be interacted with

import * as fs from "node:fs";
import * as path from "node:path";

// ── Space definition ──────────────────────────────────────────
interface SpaceDef {
  id: string;
  name: string;
  messageDescription: string;
  type: "private" | "public" | "workspace" | "f2f" | "solo";
  members: string[];      // agent/human IDs in this space
  owner: string;          // creator
  discoverable: boolean;
  joinPolicy: "open" | "approval" | "invite_only";
  createdAt: string;
}

interface SpaceState {
  currentSpaceId: string;
  spaceHistory: string[];  // for back navigation
}

const spaceStates = new Map<string, SpaceState>();

// ── Built-in spaces ───────────────────────────────────────────
const BUILTIN_SPACES: SpaceDef[] = [
  {
    id: "solo",
    name: "独自空间",
    messageDescription: "你的私人空间——独自沉思、工作的地方。外界无法打扰。",
    type: "solo",
    members: [],
    owner: "system",
    discoverable: false,
    joinPolicy: "invite_only",
    createdAt: new Date().toISOString(),
  },
  {
    id: "terminal",
    name: "终端对话",
    messageDescription: "与用户的直接对话空间——传统的 pi 终端会话。",
    type: "private",
    members: ["user"],
    owner: "user",
    discoverable: false,
    joinPolicy: "invite_only",
    createdAt: new Date().toISOString(),
  },
  {
    id: "lobby",
    name: "公共大厅",
    messageDescription: "所有 agent 和用户可以自由进出的公共空间。可以在这里遇到其他人并发起对话。",
    type: "public",
    members: [],
    owner: "system",
    discoverable: true,
    joinPolicy: "open",
    createdAt: new Date().toISOString(),
  },
];

// ── State management ──────────────────────────────────────────
function getState(personDir: string): SpaceState {
  let s = spaceStates.get(personDir);
  if (!s) {
    s = { currentSpaceId: "terminal", spaceHistory: [] };
    spaceStates.set(personDir, s);
  }
  return s;
}

function getSpace(id: string): SpaceDef | undefined {
  return BUILTIN_SPACES.find(s => s.id === id);
}

// ── Renderers ─────────────────────────────────────────────────
function renderEnv(state: SpaceState): string {
  const space = getSpace(state.currentSpaceId);
  const lines: string[] = [];
  lines.push("=== SPACE ===");
  lines.push("");
  lines.push(`当前空间: ${space?.name ?? state.currentSpaceId}`);
  if (space) {
    lines.push(`   类型: ${space.type} | ${space.messageDescription}`);
    lines.push(`   成员: ${space.members.length > 0 ? space.members.join(", ") : "(空)"}`);
    lines.push(`   加入: ${space.joinPolicy}`);
  }
  lines.push("");
  lines.push("可用空间:");
  const discoverable = BUILTIN_SPACES.filter(s => s.discoverable || s.id === state.currentSpaceId);
  for (const s of discoverable) {
    const marker = s.id === state.currentSpaceId ? "" : " ";
    lines.push(`  ${marker} ${s.id}: ${s.name} — ${s.messageDescription.slice(0, 60)}`);
  }
  lines.push("");
  lines.push("命令: space --move <id> | space --detail <id> | space --list");
  return lines.join("\n");
}

function renderDetail(spaceId: string): string {
  const space = getSpace(spaceId);
  if (!space) {
    return `Error: 未找到空间 "${spaceId}"。可用: ${BUILTIN_SPACES.map(s => s.id).join(", ")}`;
  }
  const lines: string[] = [
    `${space.name} (${space.id})`,
    `   类型: ${space.type}`,
    `   描述: ${space.messageDescription}`,
    `   成员: ${space.members.length > 0 ? space.members.join(", ") : "(空)"}`,
    `   创建者: ${space.owner}`,
    `   加入策略: ${space.joinPolicy}`,
    `   可发现: ${space.discoverable ? "是" : "否"}`,
    `   创建于: ${space.createdAt}`,
  ];
  return lines.join("\n");
}

function renderList(): string {
  const lines: string[] = ["=== 所有空间 ===", ""];
  for (const s of BUILTIN_SPACES) {
    lines.push(`  ${s.id}: ${s.name} (${s.type}) — ${s.messageDescription.slice(0, 50)}`);
  }
  return lines.join("\n");
}

// ── Main handler ──────────────────────────────────────────────
export async function spaceCmd(args: any, ctx: any, personDir: string): Promise<any> {
  const state = getState(personDir);

  // space --list
  if (args.list || args._?.[0] === "list") {
    const out = renderList();
    ctx.ui?.notify?.("空间列表", "info");
    return { content: [{ type: "text", text: out }] };
  }

  // space --move <spaceId>
  if (args.move || args._?.[0] === "move") {
    const targetId = (args.move || args._?.[1]) as string;
    if (!targetId) {
      return { content: [{ type: "text", text: "用法: space --move <spaceId>" }] };
    }
    const target = getSpace(targetId);
    if (!target) {
      return { content: [{ type: "text", text: `Error: 未找到空间 "${targetId}"。可用: ${BUILTIN_SPACES.map(s => s.id).join(", ")}` }] };
    }
    // Check join policy
    if (target.joinPolicy === "invite_only" && target.owner !== "user" && target.owner !== "system") {
      return { content: [{ type: "text", text: `"${target.name}" 仅限邀请。需要 space --request ${targetId}` }] };
    }
    if (state.currentSpaceId !== targetId) {
      state.spaceHistory.push(state.currentSpaceId);
    }
    state.currentSpaceId = targetId;
    ctx.ui?.notify?.(`移动到 ${target.name}`, "info");
    return { content: [{ type: "text", text: `已移动到 ${target.name} (${target.id})。\n${target.messageDescription}` }] };
  }

  // space --detail <spaceId>
  if (args.detail || args._?.[0] === "detail") {
    const targetId = (args.detail || args._?.[1]) as string;
    if (!targetId) {
      // Show current space detail
      const out = renderDetail(state.currentSpaceId);
      return { content: [{ type: "text", text: out }] };
    }
    const out = renderDetail(targetId);
    return { content: [{ type: "text", text: out }] };
  }

  // space --back (return to previous space)
  if (args.back || args._?.[0] === "back") {
    const prev = state.spaceHistory.pop();
    if (!prev) {
      return { content: [{ type: "text", text: "没有上一个空间。" }] };
    }
    state.currentSpaceId = prev;
    const space = getSpace(prev);
    ctx.ui?.notify?.(`返回 ${space?.name ?? prev}`, "info");
    return { content: [{ type: "text", text: `返回 ${space?.name ?? prev}。` }] };
  }

  // default: show current space env
  const out = renderEnv(state);
  ctx.ui?.notify?.("Space", "info");
  return { content: [{ type: "text", text: out }] };
}

// ── Public API ────────────────────────────────────────────────
export function getCurrentSpace(personDir: string): SpaceDef | undefined {
  return getSpace(getState(personDir).currentSpaceId);
}

export function setSpace(personDir: string, spaceId: string): boolean {
  const space = getSpace(spaceId);
  if (!space) return false;
  const state = getState(personDir);
  state.spaceHistory.push(state.currentSpaceId);
  state.currentSpaceId = spaceId;
  return true;
}

export { BUILTIN_SPACES, getSpace, type SpaceDef, type SpaceState };
