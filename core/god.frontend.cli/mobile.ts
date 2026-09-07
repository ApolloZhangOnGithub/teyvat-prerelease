#!/usr/bin/env bun
// god.frontend.cli/mobile.ts
// ── 人类手机 TUI ──────────────────────────────────────────────────────────
// 和 agent 的手机 (universe.infotech/local.mobile/system.kernel/kernel.ts) 共享 app 代码，
// 数据独立。启动: genshin m g
//
// 数据:  ~/.teyvat/UserAccount/phone/state.json     — 手机状态
//        ~/.teyvat/UserAccount/phone/screen.txt      — 最后屏幕
//        ~/.teyvat/UserAccount/phone/apps/<appName>/  — 各 app 数据

import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAIMON_HOME = process.env.PAIMON_HOME || join(homedir(), ".teyvat");
const PHONE_HOME = join(PAIMON_HOME, "UserAccount/phone");
const PHONE_STATE_FILE = join(PHONE_HOME, "state.json");
const PHONE_SCREEN_FILE = join(PHONE_HOME, "screen.txt");
const PHONE_APPS_DATA = join(PHONE_HOME, "apps");
const PROGRAM_FILES_MOBILE = join(PAIMON_HOME, "ProgramFiles/Mobile");

mkdirSync(PHONE_HOME, { recursive: true });
mkdirSync(PHONE_APPS_DATA, { recursive: true });

// ── i18n ──
const LANG = process.env.PAIMON_LANG || (process.env.LANG?.includes("zh") ? "zh" : "en");
const ZH = LANG === "zh";
function t(zh: string, en: string): string { return ZH ? zh : en; }

// ── App 接口（和 kernel.ts 一致）──

interface QuickAction {
  action: string;
  description: string;
}

interface MobileApp {
  name: string;
  icon: string;
  messageDescription: string;
  quickActions?: QuickAction[];
  onOpen(state: any, personDir: string): { screen: string; state: any } | Promise<{ screen: string; state: any }>;
  onAction(input: string, state: any, personDir: string): Promise<{ screen: string; state: any }> | { screen: string; state: any };
}

// ── 状态（和 kernel.ts MobileState 一致）──

interface PhoneState {
  currentApp: string | null;
  appStates: Record<string, any>;
  notifications: { from: string; text: string; ts: number }[];
  notificationMode: string;
}

const state: PhoneState = {
  currentApp: null,
  appStates: {},
  notifications: [],
  notificationMode: "normal",
};

let _lastScreen = "";
let _recording = false;
let _recFrames: any[] = [];

function loadState() {
  try {
    const saved = JSON.parse(readFileSync(PHONE_STATE_FILE, "utf8"));
    state.currentApp = saved.currentApp ?? null;
    state.appStates = saved.appStates ?? {};
    state.notifications = saved.notifications ?? [];
    state.notificationMode = saved.notificationMode ?? "normal";
  } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); }
}

function saveState(screen?: string) {
  if (screen) _lastScreen = screen;
  try {
    writeFileSync(PHONE_STATE_FILE, JSON.stringify(state, null, 2));
    if (screen) {
      writeFileSync(PHONE_SCREEN_FILE, screen);
      if (_recording) {
        _recFrames.push({ ts: Date.now(), app: state.currentApp || t("主屏幕", "Home"), screen });
      }
    }
  } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); }
}

// ── App 注册 ──

const apps: Map<string, MobileApp> = new Map();

function registerApp(app: MobileApp) {
  apps.set(app.name, app);
}

// ── 屏幕渲染（和 kernel.ts 一致）──

function vw(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) w += 2;
    else w += 1;
  }
  return w;
}

function padR(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - vw(s)));
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function renderHome(): string {
  const allApps = [...apps.values()];
  const COLS = 3;
  const GAP = 2;
  const colW = [0, 0, 0];
  for (let i = 0; i < allApps.length; i++) {
    const col = i % COLS;
    const w = vw(` ${allApps[i].name} `);
    if (w > colW[col]) colW[col] = w;
  }
  const innerW = colW[0] + (colW[1] > 0 ? GAP + colW[1] : 0) + (colW[2] > 0 ? GAP + colW[2] : 0);
  const hr = "─".repeat(Math.max(innerW, 10));
  const lines: string[] = [];
  lines.push(`┌${hr}┐`);
  lines.push(`│${padR("📱 aPhone", innerW)}│`);
  lines.push(`├${hr}┤`);
  for (let i = 0; i < allApps.length; i += COLS) {
    const cells: string[] = [];
    for (let col = 0; col < COLS; col++) {
      const app = allApps[i + col];
      if (app) cells.push(padR(` ${app.name}`, colW[col]));
      else cells.push(" ".repeat(colW[col] || 1));
    }
    lines.push(`│${cells.join(" ".repeat(GAP))}│`);
  }
  lines.push(`├${hr}┤`);
  const mode = state.notificationMode || "normal";
  const unread = state.notifications.length;
  lines.push(`│${padR(unread > 0
    ? t(` 🔴 ${unread}条通知 | 输入「通知」查看`, ` 🔴 ${unread} notification(s) | type "notifications"`)
    : t(" 无新通知", " No notifications"), innerW)}│`);
  lines.push(`│${padR(t(` 模式: ${mode}`, ` Mode: ${mode}`), innerW)}│`);
  lines.push(`└${hr}┘`);
  return lines.join("\n");
}

function renderNotifications(): string {
  const lines = [t("═══ 通知中心 ═══", "═══ Notifications ═══"), ""];
  if (state.notifications.length === 0) {
    lines.push(t("  (无通知)", "  (empty)"));
  } else {
    for (const n of state.notifications.slice(-10)) {
      lines.push(`    [${n.from}] ${n.text}`);
    }
  }
  lines.push("", t("输入「清除通知」清除全部 | 「返回」回主屏幕", "'clear' to clear | 'back' to home"));
  return lines.join("\n");
}

// ── 显示屏幕（清屏 + 顶部渲染 + 底部留空给输入）──

function showScreen(screen: string) {
  clearScreen();
  const rows = process.stdout.rows || 24;
  const screenLines = screen.split("\n");
  process.stdout.write(screen + "\n");
  const pad = Math.max(0, rows - screenLines.length - 2);
  if (pad > 0) process.stdout.write("\n".repeat(pad));
}

// ── 输入路由（和 kernel.ts handleInput 逻辑一致）──

function findApp(input: string): MobileApp | null {
  const lower = input.toLowerCase().trim();
  for (const [, app] of apps) {
    if (lower === app.name.toLowerCase() || lower === app.icon.toLowerCase()) return app;
  }
  return null;
}

function isBack(input: string): boolean {
  return /^(返回|back|主页|home|退出|exit|主屏幕)$/i.test(input.trim());
}

function getAppDataDir(appName: string): string {
  const dir = join(PHONE_APPS_DATA, appName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function handleInput(input: string): Promise<string> {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  if (isBack(trimmed)) {
    state.currentApp = null;
    saveState();
    return renderHome();
  }

  // ── 截图（和 kernel.ts 一致）──
  if (/^(截图|截屏|screenshot)$/i.test(trimmed)) {
    try {
      const photosDir = join(PAIMON_HOME, "AppData/shared/photos");
      mkdirSync(photosDir, { recursive: true });
      const fn = `mobilepic_${Date.now()}.mobilepic`;
      const snap = { type: "mobilepic", ts: Date.now(), app: state.currentApp || t("主屏幕", "Home"), screen: _lastScreen || t("(空)", "(empty)") };
      writeFileSync(join(photosDir, fn), JSON.stringify(snap, null, 2));
      return t(`截图已保存: ${fn}\n\n打开「相册」app 浏览。`, `Screenshot saved: ${fn}`);
    } catch (e: any) { return t("截图失败: ", "Screenshot failed: ") + e.message; }
  }

  // ── 录屏（和 kernel.ts 一致）──
  if (/^(开始录屏|录屏|record)$/i.test(trimmed)) {
    if (_recording) return t("已在录屏中。输入「停止录屏」结束。", "Already recording. Type 'stop' to end.");
    _recording = true;
    _recFrames = [];
    if (_lastScreen) _recFrames.push({ ts: Date.now(), app: state.currentApp || t("主屏幕", "Home"), screen: _lastScreen });
    return t("录屏已开始。操作完成后输入「停止录屏」保存。", "Recording started. Type 'stop' to save.");
  }
  if (/^(停止录屏|stop recording)$/i.test(trimmed)) {
    if (!_recording) return t("当前未在录屏。输入「开始录屏」开始。", "Not recording. Type 'record' to start.");
    _recording = false;
    try {
      const photosDir = join(PAIMON_HOME, "AppData/shared/photos");
      mkdirSync(photosDir, { recursive: true });
      const fn = `mobilelog_${Date.now()}.mobilelog`;
      const rec = { type: "mobilelog", ts_start: _recFrames[0]?.ts || Date.now(), ts_end: Date.now(), frames: _recFrames };
      writeFileSync(join(photosDir, fn), JSON.stringify(rec, null, 2));
      const count = _recFrames.length;
      _recFrames = [];
      return t(`录屏已保存: ${fn}\n共 ${count} 帧`, `Recording saved: ${fn}\n${count} frames`);
    } catch (e: any) { return t("录屏保存失败: ", "Recording save failed: ") + e.message; }
  }

  // ── 通知 ──
  if (/^(通知|notifications?)$/i.test(trimmed)) {
    state.currentApp = null;
    return renderNotifications();
  }

  if (/^(清除通知|clear notifications?|clear)$/i.test(trimmed)) {
    state.notifications = [];
    saveState();
    return t("通知已全部清除。", "Notifications cleared.");
  }

  // ── 发消息（和 kernel.ts 一致）──
  const sendMsgMatch = trimmed.match(/^(发消息|send)\s+(\S+)\s+(.+)/i);
  if (sendMsgMatch) {
    const target = sendMsgMatch[2];
    const text = sendMsgMatch[3];
    if (!text.trim()) return t("消息不能为空", "Message cannot be empty");
    try {
      const wd = join(PAIMON_HOME, "AppData/shared/wechat");
      mkdirSync(wd, { recursive: true });
      const msg = { from: "god", to: target, text: text.trim(), ts: Date.now() };
      appendFileSync(join(wd, "wechat.jsonl"), JSON.stringify(msg) + "\n");
      try {
        const wakeDir = join(PAIMON_HOME, "RuntimeCache", target, "wake");
        mkdirSync(wakeDir, { recursive: true });
        appendFileSync(join(wakeDir, "wechat.wake"), JSON.stringify({ from: "god", ts: Date.now() }) + "\n");
      } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); }
      return t(`📨 已发送给 ${target}\n${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`,
               `📨 Sent to ${target}\n${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);
    } catch (e: any) { return t("发送失败: ", "Send failed: ") + e.message; }
  }

  // ── 锁屏 ──
  if (/^(锁屏|lock)$/i.test(trimmed)) {
    state.currentApp = null;
    return t("手机已锁定。再次使用 genshin m g 解锁。", "Phone locked. Use 'genshin m g' to unlock.");
  }

  // ── 控制中心（和 kernel.ts 一致）──
  if (/^(控制中心|control)$/i.test(trimmed)) {
    const mode = state.notificationMode || "normal";
    const normal = mode === "normal" ? "[ON]" : "";
    const focus = mode === "focus" ? "[ON]" : "";
    const dnd = mode === "dnd" ? "[ON]" : "";
    return `Control Center\n\n  ${normal} ${t("正常", "Normal")}  ${focus} ${t("专注", "Focus")}  ${dnd} ${t("勿扰", "DND")}\n\n  ${t("输入 正常/专注/勿扰 切换", "Type normal/focus/dnd to switch")}`;
  }
  if (/^(勿扰|dnd)$/i.test(trimmed)) {
    state.notificationMode = "dnd";
    saveState();
    return t("[DND] 勿扰模式", "[DND] Do Not Disturb");
  }
  if (/^(专注|focus)$/i.test(trimmed)) {
    state.notificationMode = "focus";
    saveState();
    return t("[FOCUS] 专注模式", "[FOCUS] Focus Mode");
  }
  if (/^(正常|normal)$/i.test(trimmed)) {
    state.notificationMode = "normal";
    saveState();
    return t("[ON] 正常模式", "[ON] Normal Mode");
  }

  // ── Quick Actions 查询（和 kernel.ts 一致）──
  if (/^quickactions$/i.test(trimmed)) {
    const lines: string[] = ["═══ Quick Actions ═══", ""];
    for (const [, a] of apps) {
      if (a.quickActions?.length) {
        const actions = a.quickActions.map(q =>
          q.action === "*" ? `(*) ${q.description}` : `${q.action} — ${q.description}`
        );
        lines.push(`  ${a.name}: ${actions.join(", ")}`);
      }
    }
    if (lines.length === 2) lines.push(t("  (暂无 app 声明了 Quick Actions)", "  (none)"));
    lines.push("", t("用法: quickactions <app名> 查看详情\n直接调用: <app名> <action> <参数>",
                      "Usage: quickactions <appName>\nDirect: <appName> <action> <args>"));
    return lines.join("\n");
  }

  // Quick Action 路由
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx > 0) {
    const firstWord = trimmed.slice(0, spaceIdx);
    const rest = trimmed.slice(spaceIdx + 1);
    const target = findApp(firstWord);
    if (target?.quickActions?.length) {
      const actionWord = rest.split(/\s+/)[0];
      const matched = target.quickActions.find(q => q.action === actionWord || q.action === "*");
      if (matched) {
        const personDir = getAppDataDir(target.name);
        const result = await target.onAction(rest, {}, personDir);
        return result.screen;
      }
    }
  }

  // In-app: forward input to current app
  if (state.currentApp) {
    const switchApp = findApp(trimmed);
    if (switchApp && switchApp.name !== state.currentApp &&
        (lower === switchApp.name.toLowerCase() || lower.startsWith(switchApp.name.toLowerCase() + " "))) {
      state.currentApp = switchApp.name;
      const personDir = getAppDataDir(switchApp.name);
      const appState = state.appStates[switchApp.name] ?? {};
      const result = await switchApp.onOpen(appState, personDir);
      state.appStates[switchApp.name] = result.state;
      saveState(result.screen);
      return result.screen;
    }
    if (switchApp && switchApp.name === state.currentApp && lower === switchApp.name.toLowerCase()) {
      const personDir = getAppDataDir(switchApp.name);
      const appState = state.appStates[switchApp.name] ?? {};
      const result = await switchApp.onOpen(appState, personDir);
      state.appStates[switchApp.name] = result.state;
      saveState(result.screen);
      return result.screen;
    }

    const app = apps.get(state.currentApp);
    if (!app) { state.currentApp = null; saveState(); return renderHome(); }
    const personDir = getAppDataDir(state.currentApp);
    const appState = state.appStates[state.currentApp] ?? {};
    const result = await app.onAction(trimmed, appState, personDir);
    state.appStates[state.currentApp] = result.state;
    saveState(result.screen);
    return result.screen;
  }

  // Open app
  const app = findApp(trimmed);
  if (app) {
    state.currentApp = app.name;
    const personDir = getAppDataDir(app.name);
    const appState = state.appStates[app.name] ?? {};
    const result = await app.onOpen(appState, personDir);
    state.appStates[app.name] = result.state;
    saveState(result.screen);
    return result.screen;
  }

  return renderHome() + "\n\n" + t(
    `没有找到「${trimmed}」，请从上面选择一个 app。`,
    `App "${trimmed}" not found.`
  );
}

// ── App 自动发现（和 kernel.ts 一致）──

async function discoverApps() {
  if (!existsSync(PROGRAM_FILES_MOBILE)) {
    console.error(`App directory not found: ${PROGRAM_FILES_MOBILE}`);
    return;
  }
  for (const folder of readdirSync(PROGRAM_FILES_MOBILE)) {
    if (folder.startsWith(".") || folder.startsWith("@")) continue;
    const appDir = join(PROGRAM_FILES_MOBILE, folder);
    try {
      const candidates = readdirSync(appDir).filter(
        (f: string) => f.endsWith(".ts") && !f.includes(".SPEC") && !f.includes(".CHANGELOG") && !f.includes(".test") && !f.includes("test.ts")
      );
      for (const file of candidates) {
        try {
          const mod = await import(join(appDir, file));
          if (mod.app?.name && mod.app?.onOpen && mod.app?.onAction) {
            registerApp(mod.app);
            break;
          }
        } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); }
      }
    } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); }
  }
}

// ── WeChat 消息轮询（和 kernel.ts 一致）──

const WECHAT_MSG_FILE = join(PAIMON_HOME, "AppData/shared/wechat/wechat.jsonl");
let _lastMsgLine = 0;

function pollWeChat(): boolean {
  let changed = false;
  try {
    const raw = readFileSync(WECHAT_MSG_FILE, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    for (let i = _lastMsgLine; i < lines.length; i++) {
      try {
        const m = JSON.parse(lines[i]);
        // 用户是管理员(god)，所有消息都显示为通知
        const preview = (m.text || "").slice(0, 80);
        const label = m.from && m.to ? `${m.from}→${m.to}` : (m.from || "?");
        state.notifications.unshift({ from: label, text: preview, ts: Date.now() });
        if (state.notifications.length > 50) state.notifications.length = 50;
        changed = true;
      } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); }
    }
    _lastMsgLine = lines.length;
  } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); }
  if (changed) saveState();
  return changed;
}

// ── 主循环 ──

async function main() {
  loadState();
  await discoverApps();

  // 初始化 WeChat 消息偏移（跳过历史）
  try {
    const raw = readFileSync(WECHAT_MSG_FILE, "utf8");
    _lastMsgLine = raw.trim().split("\n").filter(Boolean).length;
  } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); }

  function getPrompt(): string {
    return state.currentApp ? `${state.currentApp}> ` : "phone> ";
  }

  const homeScreen = renderHome();
  _lastScreen = homeScreen;
  showScreen(homeScreen);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(),
  });

  rl.prompt();

  // 自动刷新：每 3 秒检查新消息，有变化则刷新屏幕
  setInterval(() => {
    if (pollWeChat()) {
      const screen = state.currentApp ? _lastScreen : renderHome();
      showScreen(screen);
      rl.setPrompt(getPrompt());
      rl.prompt();
    }
  }, 3000);

  rl.on("line", async (line) => {
    const input = line.trim();
    if (input === "q" || input === "quit") {
      clearScreen();
      rl.close();
      process.exit(0);
    }

    let screen: string;
    if (!input) {
      screen = state.currentApp
        ? ((() => { try { return readFileSync(PHONE_SCREEN_FILE, "utf8"); } catch (e) { console.error("[god.frontend.cli/mobile.ts] " + ((e as any)?.message || e)); return renderHome(); } })())
        : renderHome();
    } else {
      try {
        screen = await handleInput(input);
      } catch (e: any) {
        screen = `Error: ${e.message}`;
      }
    }

    _lastScreen = screen;
    showScreen(screen);
    rl.setPrompt(getPrompt());
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

main().catch(e => { console.error(e); process.exit(1); });
