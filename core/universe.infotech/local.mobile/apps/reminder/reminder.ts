// apps/reminder/reminders.ts — Reminders app
// v0.2 spec: 提醒事项 — 创建待办、到期提醒、完成/推迟、follow-up check
// "模型自己也可以follow up，然后后续提醒，要选择完成才能完成"

import * as fs from "fs";
import * as path from "path";

// ── Reminder types ──────────────────────────────────────────────
type ReminderPriority = "low" | "normal" | "high" | "critical";

type RepeatRule = "daily" | "weekly" | "monthly" | "yearly" | null;

interface Reminder {
  id: string;
  title: string;
  notes?: string;
  due?: string;            // ISO timestamp, null = no due date
  priority: ReminderPriority;
  completed: boolean;
  completedAt?: string;
  followUp: boolean;       // requires explicit completion check
  followUpInterval?: number; // minutes between follow-up nudges
  lastNudged?: string;
  tags: string[];
  created: string;
  updated: string;
  repeat?: RepeatRule;     // 重复规则
  notified?: boolean;      // 已推送通知
}

// ── Storage ─────────────────────────────────────────────────────
function remindersPath(personDir: string) {
  return path.join(personDir, "reminders.json");
}

function loadReminders(personDir: string): Reminder[] {
  try {
    return JSON.parse(fs.readFileSync(remindersPath(personDir), "utf8"));
  } catch {
    return [];
  }
}

function saveReminders(personDir: string, reminders: Reminder[]) {
  fs.writeFileSync(remindersPath(personDir), JSON.stringify(reminders, null, 2));
}

function genId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── 重复计算 ──
function calcNextDue(due: string, repeat: RepeatRule): string {
  const d = new Date(due);
  switch (repeat) {
    case "daily": d.setDate(d.getDate() + 1); break;
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString();
}

// ── 推送检查（被 mobile kernel 的 before_agent_start 调用）──
export function checkAndNotify(personDir: string): { title: string; due: string }[] {
  const reminders = loadReminders(personDir);
  const now = Date.now();
  const fired: { title: string; due: string }[] = [];

  for (const r of reminders) {
    if (r.completed || !r.due || r.notified) continue;
    if (new Date(r.due).getTime() <= now) {
      r.notified = true;
      r.updated = new Date().toISOString();
      fired.push({ title: r.title, due: r.due });
    }
  }

  if (fired.length > 0) saveReminders(personDir, reminders);
  return fired;
}

// ── Due check ──────────────────────────────────────────────────
function isOverdue(r: Reminder): boolean {
  if (r.completed || !r.due) return false;
  return new Date(r.due) <= new Date();
}

function needsNudge(r: Reminder): boolean {
  if (r.completed || !r.followUp || !r.followUpInterval || !r.lastNudged) return false;
  const nextNudge = new Date(r.lastNudged).getTime() + r.followUpInterval * 60 * 1000;
  return Date.now() >= nextNudge;
}

// ── Render ──────────────────────────────────────────────────────
function renderReminder(r: Reminder, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const check = r.completed ? "[DONE]" : isOverdue(r) ? "[OVERDUE]" : r.priority === "critical" ? "[!]" : r.priority === "high" ? "[HIGH]" : "[ ]";
  const dueStr = r.due ? ` · ${r.due.slice(0, 16).replace("T", " ")}` : "";
  const fuStr = r.followUp ? " · follow-up" : "";
  const tagsStr = (r.tags && r.tags.length > 0) ? ` · ${r.tags.join(", ")}` : "";
  const notesStr = r.notes ? `\n    ${r.notes}` : "";

  let line = `${check} ${prefix}**${r.title}**${dueStr}${fuStr}${tagsStr}${notesStr}`;
  if (r.completed && r.completedAt) {
    line += `\n    ✓ 完成于 ${r.completedAt.slice(0, 16).replace("T", " ")}`;
  }
  return line;
}

// ── Resolve ID or display index ────────────────────────────────
function resolveId(idOrIndex: string, reminders: Reminder[]): Reminder | undefined {
  // try exact ID match first
  const byId = reminders.find(x => x.id === idOrIndex);
  if (byId) return byId;
  // try display index (1-based) for non-completed items
  const idx = parseInt(idOrIndex, 10);
  if (!isNaN(idx) && idx >= 1) {
    const active = reminders.filter(r => !r.completed);
    return active[idx - 1];
  }
  return undefined;
}

// ── Main handler ───────────────────────────────────────────────
export async function remindersCmd(args: any, _ctx: any, personDir: string): Promise<any> {
  const reminders = loadReminders(personDir);

  // --add: create new reminder
  if (args.add) {
    const title = typeof args.add === "string" ? args.add : args._?.[1];
    if (!title) return { content: [{ type: "text", text: "Usage: reminders --add <title> [--due <ISO>] [--priority low|normal|high|critical] [--follow-up] [--notes <text>]" }] };

    const repeat = (args.repeat as RepeatRule) || null;
    const reminder: Reminder = {
      id: genId(),
      title,
      notes: args.notes as string | undefined,
      due: args.due as string | undefined,
      priority: (args.priority as ReminderPriority) || "normal",
      completed: false,
      followUp: !!args["follow-up"] || !!args.followUp,
      followUpInterval: (args.interval as number) || 60,
      tags: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      repeat,
      notified: false,
    };

    reminders.push(reminder);
    saveReminders(personDir, reminders);

    return { content: [{ type: "text", text: `Reminder created: **${title}**\n${renderReminder(reminder)}` }] };
  }

  // --complete <id>: mark as done
  if (args.complete) {
    const id = args.complete as string;
    const r = resolveId(id, reminders);
    if (!r) return { content: [{ type: "text", text: `Reminder not found: ${id}` }] };

    r.completed = true;
    r.completedAt = new Date().toISOString();
    r.updated = new Date().toISOString();

    // 重复提醒：完成后自动创建下一次
    let repeatMsg = "";
    if (r.repeat && r.due) {
      const nextDue = calcNextDue(r.due, r.repeat);
      const next: Reminder = {
        ...r,
        id: genId(),
        due: nextDue,
        completed: false,
        completedAt: undefined,
        notified: false,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      reminders.push(next);
      repeatMsg = `\n下次: ${nextDue.slice(0, 16)} (${r.repeat})`;
    }

    saveReminders(personDir, reminders);
    return { content: [{ type: "text", text: `Completed: **${r.title}**${repeatMsg}` }] };
  }

  // --uncomplete <id>: reopen
  if (args.uncomplete) {
    const id = args.uncomplete as string;
    const r = resolveId(id, reminders);
    if (!r) return { content: [{ type: "text", text: `Reminder not found: ${id}` }] };

    r.completed = false;
    r.completedAt = undefined;
    r.updated = new Date().toISOString();
    saveReminders(personDir, reminders);

    return { content: [{ type: "text", text: `Reopened: **${r.title}**` }] };
  }

  // --due <id> <ISO>: set/change due date
  if (args.due) {
    const id = typeof args.due === "string" && args.due.startsWith("r-") ? args.due : args._?.[1];
    const dueStr = (typeof args._?.[2] === "string" ? args._?.[2] : args.date) as string;
    if (!id || !dueStr) return { content: [{ type: "text", text: "Usage: reminders --due <id> <ISO timestamp>" }] };

    const r = resolveId(id, reminders);
    if (!r) return { content: [{ type: "text", text: `Reminder not found: ${id}` }] };

    r.due = dueStr;
    r.updated = new Date().toISOString();
    saveReminders(personDir, reminders);

    return { content: [{ type: "text", text: `Due set for **${r.title}**: ${dueStr}` }] };
  }

  // --nudge <id>: manually nudge (mark follow-up check done)
  if (args.nudge) {
    const id = args.nudge as string;
    const r = resolveId(id, reminders);
    if (!r) return { content: [{ type: "text", text: `Reminder not found: ${id}` }] };

    r.lastNudged = new Date().toISOString();
    r.updated = new Date().toISOString();
    saveReminders(personDir, reminders);

    return { content: [{ type: "text", text: `Nudged: **${r.title}** — next nudge in ${r.followUpInterval || 60} min.` }] };
  }

  // --tag <id> <tag>: add tag
  if (args.tag) {
    const id = args.tag as string;
    const tag = args._?.[1] as string;
    if (!tag) return { content: [{ type: "text", text: "Usage: reminders --tag <id> <tag>" }] };

    const r = resolveId(id, reminders);
    if (!r) return { content: [{ type: "text", text: `Reminder not found: ${id}` }] };

    if (!r.tags) r.tags = [];
    if (!r.tags.includes(tag)) {
      r.tags.push(tag);
      r.updated = new Date().toISOString();
      saveReminders(personDir, reminders);
    }
    return { content: [{ type: "text", text: `Tagged **${r.title}** with "${tag}".` }] };
  }

  // --show <id>: detail
  if (args.show) {
    const id = args.show as string;
    const r = resolveId(id, reminders);
    if (!r) return { content: [{ type: "text", text: `Reminder not found: ${id}` }] };

    const lines = [renderReminder(r), `  ID: \`${r.id}\``, `  Priority: ${r.priority}`, `  Tags: ${(r.tags || []).join(", ") || "—"}`];
    if (r.followUp) lines.push(`  Follow-up: every ${r.followUpInterval}min · last nudge: ${r.lastNudged || "never"}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // --overdue: list overdue items
  if (args.overdue) {
    const overdue = reminders.filter(r => isOverdue(r));
    if (overdue.length === 0) {
      return { content: [{ type: "text", text: "No overdue reminders." }] };
    }
    const lines = [`**Overdue (${overdue.length})**`];
    overdue.forEach((r, i) => lines.push(renderReminder(r, i)));
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // --search <q>: search
  if (args.search) {
    const q = (args.search as string).toLowerCase();
    const results = reminders.filter(r =>
      r.title.toLowerCase().includes(q) ||
      (r.notes && r.notes.toLowerCase().includes(q)) ||
      (r.tags && r.tags.some((t: string) => t.toLowerCase().includes(q)))
    );
    if (results.length === 0) return { content: [{ type: "text", text: `No reminders matching "${args.search}".` }] };

    const lines = [`**Search: "${args.search}" (${results.length})**`];
    results.forEach((r, i) => lines.push(renderReminder(r, i)));
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // --filter: active / completed / all
  if (args.filter) {
    const filter = args.filter as string;
    let filtered: Reminder[];
    if (filter === "active") filtered = reminders.filter(r => !r.completed);
    else if (filter === "completed") filtered = reminders.filter(r => r.completed);
    else if (filter === "followup") filtered = reminders.filter(r => r.followUp && !r.completed);
    else filtered = reminders;

    const label = filter === "active" ? "Active" : filter === "completed" ? "Completed" : filter === "followup" ? "Follow-up" : "All";
    const lines = [`**${label} Reminders (${filtered.length})**`];
    filtered.forEach((r, i) => lines.push(renderReminder(r, i)));
    lines.push("\nCommands: `reminders --add` · `reminders --complete <id>` · `reminders --due <id>` · `reminders --overdue` · `reminders --filter active|completed`");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // default: show active
  const active = reminders.filter(r => !r.completed);
  const completed = reminders.filter(r => r.completed);
  const overdue = active.filter(r => isOverdue(r));
  const followUps = active.filter(r => r.followUp);

  const lines: string[] = [];
  if (overdue.length > 0) {
    lines.push(`**Overdue (${overdue.length})**`);
    overdue.forEach((r, i) => lines.push(renderReminder(r, i)));
    lines.push("");
  }
  if (active.length > 0) {
    lines.push(`**Active (${active.length})**`);
    const notOverdue = active.filter(r => !isOverdue(r));
    notOverdue.forEach((r, i) => lines.push(renderReminder(r, i)));
    if (followUps.length > 0) lines.push(`\n${followUps.length} follow-ups pending`);
  }
  if (completed.length > 0) {
    lines.push(`\n**Completed (${completed.length})** — use \`reminders --filter completed\` to see`);
  }
  if (active.length === 0 && completed.length === 0) {
    lines.push("No reminders yet. Use `reminders --add <title>` to create one.");
  }

  lines.push("\nCommands: `--add` · `--complete <id>` · `--due <id>` · `--overdue` · `--filter active|completed|followup` · `--search <q>`");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export { type Reminder, loadReminders, isOverdue, needsNudge };

// ── MobileApp wrapper ──────────────────────────────────────────
import type { MobileApp } from "../../system.kernel/kernel.ts";

export const app: MobileApp = {
  name: "reminder",
  icon: "提醒",
  messageDescription: "待办提醒、到期跟踪、完成确认",

  onOpen(state, personDir) {
    const reminders = loadReminders(personDir);
    const active = reminders.filter(r => !r.completed);
    const overdue = active.filter(r => isOverdue(r));
    const lines = [
      "═══ 提醒事项 ═══",
      "",
      `  待办: ${active.length} 项${overdue.length > 0 ? ` (${overdue.length} 项逾期)` : ""}`,
      "",
      "  操作:",
      "    列表              — 查看所有待办",
      "    添加 <标题>       — 创建提醒",
      "    完成 <id>         — 标记完成",
      "    重开 <id>         — 重新打开",
      "    详情 <id>         — 查看详情",
      "    逾期              — 查看逾期项",
      "    搜索 <关键词>     — 搜索提醒",
      "    筛选 active|completed|followup",
      "",
      "  返回 — 回主屏幕",
    ];
    return { screen: lines.join("\n"), state: state ?? {} };
  },

  async onAction(input, state, personDir) {
    const trimmed = input.trim();
    let args: any = {};

    if (/^(列表|list)$/i.test(trimmed)) {
      args = {};
    } else if (/^(添加|add)\s+(.+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:添加|add)\s+(.+)$/i)!;
      let title = m[1];
      let due: string | undefined;
      // 解析 --due <ISO> 参数
      const dueMatch = title.match(/^(.*)\s+--due\s+(\S+)$/);
      if (dueMatch) { title = dueMatch[1]; due = dueMatch[2]; }
      args = { add: title, due };
    } else if (/^(完成|complete)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:完成|complete)\s+(\S+)$/i)!;
      args = { complete: m[1] };
    } else if (/^(重开|uncomplete|reopen)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:重开|uncomplete|reopen)\s+(\S+)$/i)!;
      args = { uncomplete: m[1] };
    } else if (/^(详情|show)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:详情|show)\s+(\S+)$/i)!;
      args = { show: m[1] };
    } else if (/^(逾期|overdue)$/i.test(trimmed)) {
      args = { overdue: true };
    } else if (/^(搜索|search)\s+(.+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:搜索|search)\s+(.+)$/i)!;
      args = { search: m[1] };
    } else if (/^(筛选|filter)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:筛选|filter)\s+(\S+)$/i)!;
      args = { filter: m[1] };
    } else if (/^(标签|tag)\s+(\S+)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:标签|tag)\s+(\S+)\s+(\S+)$/i)!;
      args = { tag: m[1], _: [undefined, m[2]] };
    } else if (/^(催促|nudge)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:催促|nudge)\s+(\S+)$/i)!;
      args = { nudge: m[1] };
    }

    const result = await remindersCmd(args, {}, personDir);
    return { screen: result.content[0].text, state: state ?? {} };
  },
};
