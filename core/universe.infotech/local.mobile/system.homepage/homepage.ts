// system.homepage/homepage.ts — Mobile command implementation
// v0.2 spec: mobile --home, --notifications, --open, --close, --back, --appswitcher

import * as fs from "fs";
import * as path from "path";

// ── App registry ───────────────────────────────────────────────
interface AppDef {
  name: string;        // display name
  icon?: string;       // emoji icon
  messageDescription: string;
  category: "system" | "social" | "tools" | "productivity" | "media";
  homeActions: string[];  // available actions from home (shortcuts)
}

const BUILTIN_APPS: AppDef[] = [
  { name: "Messages",   icon: "", messageDescription: "即时通讯 — 聊天、群聊",     category: "social",       homeActions: ["open", "最近对话"] },
  { name: "Contacts",   icon: "", messageDescription: "通讯录 — 联系人管理",        category: "social",       homeActions: ["open", "搜索联系人"] },
  { name: "Calendar",   icon: "", messageDescription: "日历 — 日程、提醒",          category: "productivity", homeActions: ["open", "今日日程"] },
  { name: "Reminders",  icon: "", messageDescription: "提醒事项 — 待办与跟进",       category: "productivity", homeActions: ["open", "新建提醒"] },
  { name: "Notes",      icon: "", messageDescription: "备忘录 — 快速记事",          category: "productivity", homeActions: ["open", "新建笔记"] },
  { name: "Files",      icon: "", messageDescription: "文件 — 飞书文档、项目文件",   category: "tools",        homeActions: ["open", "最近文件"] },
  { name: "Terminal",   icon: "", messageDescription: "终端 — 代码与系统命令",       category: "tools",        homeActions: ["open", "运行命令"] },
  { name: "Settings",   icon: "", messageDescription: "设置 — 设备与偏好",          category: "system",       homeActions: ["open"] },
  { name: "Clock",      icon: "", messageDescription: "时钟 — 闹钟、计时器",        category: "system",       homeActions: ["open", "设置闹钟"] },
  { name: "Feed",       icon: "", messageDescription: "信息流 — 通知与事件回顾",     category: "system",       homeActions: ["open", "查看通知"] },
];

// ── Notification store ─────────────────────────────────────────
interface Notification {
  id: string;
  title: string;
  body: string;
  app: string;
  strength: number;  // 0–1
  ts: string;
  read: boolean;
}

function loadNotifications(personDir: string): Notification[] {
  if (!personDir) return [];
  const p = path.join(personDir, "mobile_notifications.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
}

function saveNotifications(personDir: string, notifs: Notification[]) {
  if (!personDir) return;
  const p = path.join(personDir, "mobile_notifications.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Keep last 200
  fs.writeFileSync(p, JSON.stringify(notifs.slice(-200), null, 2));
}

function addNotification(personDir: string, app: string, title: string, body: string, strength = 0.5) {
  const notifs = loadNotifications(personDir);
  notifs.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title, body, app, strength,
    ts: new Date().toISOString(),
    read: false,
  });
  saveNotifications(personDir, notifs);
  return notifs[notifs.length - 1];
}

// ── Mobile state ────────────────────────────────────────────────
interface MobileState {
  unlocked: boolean;
  currentApp: string | null;
  currentPage: string | null;  // within-app page
  appHistory: string[];        // back stack
}

const mobileStates = new Map<string, MobileState>();

function getState(personDir: string): MobileState {
  let s = mobileStates.get(personDir);
  if (!s) {
    s = { unlocked: true, currentApp: null, currentPage: null, appHistory: [] };
    mobileStates.set(personDir, s);
  }
  return s;
}

// ── Screen renderers ───────────────────────────────────────────

function renderHome(state: MobileState): string {
  const lines: string[] = [];
  lines.push("=== HOME ===");
  lines.push("");
  lines.push("常用应用:");
  for (const app of BUILTIN_APPS) {
    const icon = app.icon || "";
    lines.push(`  ${icon ? icon + " " : ""}${app.name} — ${app.messageDescription}`);
  }
  lines.push("");
  lines.push("系统命令: mobile --open <app> | mobile --notifications | mobile --appswitcher");
  if (state.currentApp) {
    lines.push(`当前应用: ${state.currentApp} ${state.currentPage ? `(${state.currentPage})` : ""}`);
  }
  return lines.join("\n");
}

function renderAppSwitcher(state: MobileState): string {
  const lines: string[] = ["=== APP SWITCHER ===", ""];
  if (state.appHistory.length === 0 && !state.currentApp) {
    lines.push("(没有运行的应用)");
  } else {
    if (state.currentApp) {
      lines.push(`   ${state.currentApp} ← 当前`);
    }
    const seen = new Set(state.currentApp ? [state.currentApp] : []);
    for (let i = state.appHistory.length - 1; i >= 0; i--) {
      const app = state.appHistory[i];
      if (!seen.has(app)) {
        lines.push(`    ${app}`);
        seen.add(app);
      }
    }
  }
  lines.push("");
  lines.push("mobile --open <app> 切换 | mobile --close 关闭当前 | mobile --back 返回");
  return lines.join("\n");
}

function renderNotifications(personDir: string): string {
  const notifs = loadNotifications(personDir);
  const lines: string[] = ["=== 通知中心 ===", ""];
  const unread = notifs.filter(n => !n.read);
  if (unread.length === 0) {
    lines.push("(没有新通知)");
  } else {
    for (const n of unread.slice(-20)) {
      const strengthIcon = n.strength >= 0.8 ? "[HIGH]" : n.strength >= 0.5 ? "[MED]" : "[LOW]";
      lines.push(`  ${strengthIcon} [${n.app}] ${n.title}`);
      if (n.body) lines.push(`       ${n.body.slice(0, 100)}`);
      lines.push("");
    }
    lines.push(`共 ${unread.length} 条未读`);
  }
  // Mark all as read
  for (const n of notifs) n.read = true;
  saveNotifications(personDir, notifs);
  return lines.join("\n");
}

function openApp(state: MobileState, appName: string): string {
  const app = BUILTIN_APPS.find(a =>
    a.name.toLowerCase() === appName.toLowerCase() ||
    a.name.includes(appName)
  );
  if (!app) {
    const names = BUILTIN_APPS.map(a => a.name).join(", ");
    return `Error: 未找到应用 "${appName}"。可用: ${names}`;
  }

  if (state.currentApp) {
    state.appHistory.push(state.currentApp);
  }
  state.currentApp = app.name;
  state.currentPage = "main";

  const lines: string[] = [
    `${app.icon ? app.icon + " " : ""}${app.name} — ${app.messageDescription}`,
    "",
    "可用操作:",
  ];
  for (const action of app.homeActions) {
    lines.push(`  • ${action}`);
  }
  lines.push("");
  lines.push("系统: mobile --back (返回) | mobile --close (关闭) | mobile --home");

  return lines.join("\n");
}

// ── Main handler ───────────────────────────────────────────────
export async function mobileCmd(args: any, ctx: any, personDir: string): Promise<any> {
  const state = getState(personDir);

  if (args.home || args._?.[0] === "home") {
    state.currentApp = null; state.currentPage = null;
    const out = renderHome(state);
    ctx.ui?.notify?.("home", "info");
    return { content: [{ type: "text", text: out }] };
  }

  if (args.notifications || args._?.[0] === "notifications") {
    const out = renderNotifications(personDir);
    ctx.ui?.notify?.("notifications", "info");
    return { content: [{ type: "text", text: out }] };
  }

  if (args.appswitcher || args._?.[0] === "appswitcher") {
    const out = renderAppSwitcher(state);
    ctx.ui?.notify?.("app switcher", "info");
    return { content: [{ type: "text", text: out }] };
  }

  if (args.close || args._?.[0] === "close") {
    const closed = state.currentApp;
    state.currentApp = state.appHistory.pop() ?? null;
    state.currentPage = null;
    const out = closed
      ? `关闭了 ${closed}。${state.currentApp ? `回到 ${state.currentApp}` : "回到主页"}`
      : "没有打开的应用。";
    ctx.ui?.notify?.(closed || "home", "info");
    return { content: [{ type: "text", text: out }] };
  }

  if (args.back || args._?.[0] === "back") {
    if (!state.currentApp) {
      return { content: [{ type: "text", text: "已在主页，没有可返回的。" }] };
    }
    // Back within app: go to main page
    if (state.currentPage && state.currentPage !== "main") {
      state.currentPage = "main";
      return { content: [{ type: "text", text: `返回 ${state.currentApp} 主页。` }] };
    }
    // Back from app to previous app or home
    const prev = state.appHistory.pop();
    state.currentApp = prev ?? null;
    state.currentPage = prev ? "main" : null;
    const out = prev
      ? `返回 ${prev}。`
      : "返回主页。";
    ctx.ui?.notify?.("back", "info");
    return { content: [{ type: "text", text: out }] };
  }

  if (args.open || args._?.[0] === "open") {
    const appName = (args.open || args._?.[1]) as string;
    if (!appName) {
      return { content: [{ type: "text", text: "用法: mobile --open <应用名>" }] };
    }
    const out = openApp(state, appName);
    ctx.ui?.notify?.(appName, "info");
    return { content: [{ type: "text", text: out }] };
  }

  // default: show home
  const out = renderHome(state);
  return { content: [{ type: "text", text: out }] };
}

// ── Public API for other extensions ────────────────────────────
export { BUILTIN_APPS, addNotification, loadNotifications, type Notification, type MobileState, getState };
