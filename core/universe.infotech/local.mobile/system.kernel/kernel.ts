import { runtimeCacheDir, DIRS, PROGRAM_FILES_MOBILE, appPersonDir, setApiAgent, writeFileAtomic } from "#paths";
import { Text } from "@earendil-works/pi-tui";
// system.kernel/kernel.ts - 手机内核 // 2026-06-20-0841
// 唯一注册的 tool: mobile。状态机 + app 路由 + 通知 + 提醒检查。
// 所有 app 通过 registerApp() 接入。apps.json 是唯一真相源。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadReminders, isOverdue, needsNudge } from "../apps/reminder/reminder.ts";
import { startGameServer } from "../system.server/game-server.ts";
import path from "node:path";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

// ── i18n 辅助：通过 #tui_localizations 导入 ──
import { i18n } from "#tui_localizations";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { personDataDir as getPersonDir } from "#paths";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
import { exec, execSync } from "node:child_process";

// ── 浏览器服务（Safari 动态渲染用）──
const BROWSER_PORT = process.env.BROWSER_PORT ? Number(process.env.BROWSER_PORT) : 0;
const PORT_FILE = `${homedir()}/.teyvat/browser-service.port`;
function readBrowserUrl(): string {
  try { const port = readFileSync(PORT_FILE, "utf8").trim(); if (port) return `http://127.0.0.1:${port}`; } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
  return `http://127.0.0.1:${BROWSER_PORT}`;
}
let _browserPid: number | null = null;
let _browserReady = false;
let _browserStarting = false;

function startBrowserIfNeeded(): void {
  if (_browserReady || _browserStarting) return;
  _browserStarting = true;
  const svcPath = path.resolve(fileURLToPath(import.meta.url), "../../../universe.infotech/cloud.servers/browser_service.cjs");
  if (!existsSync(svcPath)) { _browserStarting = false; return; }
  // 先异步检查是否已经跑着
  fetch(readBrowserUrl(), { signal: AbortSignal.timeout(500) })
    .then(() => { _browserReady = true; _browserStarting = false; })
    .catch(() => {
      // 没跑，启动
      const child = exec(`node ${JSON.stringify(svcPath)}`, { env: { ...process.env, BROWSER_PORT: String(BROWSER_PORT) } });
      _browserPid = child.pid ?? null;
      child.unref();
      const poll = (n: number) => {
        if (n <= 0) { _browserStarting = false; return; }
        setTimeout(() => {
          fetch(readBrowserUrl(), { signal: AbortSignal.timeout(500) })
            .then(() => { _browserReady = true; _browserStarting = false; })
            .catch(() => poll(n - 1));
        }, 500);
      };
      poll(20);
    });
}

export function browserStatus(): string {
  if (_browserReady) return "dynamic (JS rendering)";
  if (_browserStarting) return "loading...";
  return "static (text only)";
}
export function isBrowserReady(): boolean { return _browserReady; }

// ── App 接口 ──

export interface QuickAction {
  action: string;
  description: string;
}

export interface MobileApp {
  name: string;
  icon: string;
  messageDescription: string;
  quickActions?: QuickAction[];
  onOpen(state: any, personDir: string): { screen: string; state: any } | Promise<{ screen: string; state: any }>;
  onAction(input: string, state: any, personDir: string): Promise<{ screen: string; state: any }> | { screen: string; state: any };
}

// ── 状态（持久化到磁盘，extension 重载不丢）──

interface MobileState {
  currentApp: string | null;
  appStates: Record<string, any>;
  notifications: { from: string; text: string; ts: number }[];
  notificationMode: string;
  installedApps: { name: string; desc: string }[];
  devMode: boolean;
}

let _stateFile = "";
let _lastScreen = ""; // I3: 追踪最后渲染的屏幕文本，供截图命令使用
let _recording = false; // I3: 录屏状态
let _recFrames: any[] = []; // I3: 录屏帧缓存
const state: MobileState = {
  currentApp: null,
  appStates: {},
  notifications: [],
  notificationMode: "normal",
  installedApps: [],
  devMode: false,
};

function loadState() {
  if (!_stateFile) return;
  try {
    const saved = JSON.parse(readFileSync(_stateFile, "utf8"));
    state.currentApp = saved.currentApp ?? null;
    state.appStates = saved.appStates ?? {};
    state.notifications = saved.notifications ?? [];
    state.notificationMode = saved.notificationMode ?? "normal";
    state.devMode = saved.devMode ?? false;
  } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
}

function saveState(screen?: string) {
  if (screen) _lastScreen = screen;
  if (!_stateFile) return;
  try {
    mkdirSync(dirname(_stateFile), { recursive: true });
    writeFileAtomic(_stateFile, JSON.stringify(state));
    if (screen) {
      writeFileAtomic(_stateFile.replace('-state.json', '-screen.txt'), screen);
      // I3: 录屏中自动捕获帧
      if (_recording) {
        _recFrames.push({ ts: Date.now(), app: state.currentApp || i18n("主屏幕", "Home"), screen });
      }
    }
  } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
}

const apps: Map<string, MobileApp> = new Map();
const _loadCache = new Map<string, { app: MobileApp; ts: number }>();

// ── Per-agent app 注册表 ──
let _agentAppsFile = "";
let _agentAppList: string[] | null = null;

function loadAgentApps(id: string) {
  _agentAppsFile = path.join(appPersonDir(id, "mobile"), "apps.json");
  try {
    _agentAppList = JSON.parse(readFileSync(_agentAppsFile, "utf8")).apps;
  } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e));
    _agentAppList = null;
  }
}

function saveAgentApps() {
  if (!_agentAppsFile) return;
  try {
    mkdirSync(dirname(_agentAppsFile), { recursive: true });
    writeFileSync(_agentAppsFile, JSON.stringify({ apps: _agentAppList }, null, 2));
  } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
}

function isAppAllowed(appDirName: string): boolean {
  if (!_agentAppList) return true;
  return _agentAppList.includes(appDirName);
}

export function addAgentApp(dirName: string) {
  if (!_agentAppList) _agentAppList = [];
  if (!_agentAppList.includes(dirName)) _agentAppList.push(dirName);
  saveAgentApps();
}

export function removeAgentApp(dirName: string) {
  if (!_agentAppList) return;
  _agentAppList = _agentAppList.filter(d => d !== dirName);
  saveAgentApps();
}
// ── 动态加载 App（dev mode 下每次用 ?t= 绕过 Node ESM 缓存）──
async function loadApp(name: string): Promise<MobileApp | undefined> {
  // devMode 从 settings.json 实时读取，不用 state（state 是启动快照）
  let dm = false;
  try { const sf = JSON.parse(readFileSync(path.join(homedir(), ".teyvat/agent/config/settings.json"), "utf8")); dm = !!sf.developerMode; } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
  if (!dm) return apps.get(name);
  // Session 级缓存：5s TTL，超时重新加载
  const hit = _loadCache.get(name);
  if (hit && Date.now() - hit.ts < 5000) return hit.app;
  if (existsSync(PROGRAM_FILES_MOBILE)) {
    for (const appFolder of readdirSync(PROGRAM_FILES_MOBILE)) {
      if (appFolder.startsWith(".") || appFolder.startsWith("@FUTURE.") || appFolder.startsWith("@removed.")) continue;
      if (!isAppAllowed(appFolder)) continue;
      const appDir = path.join(PROGRAM_FILES_MOBILE, appFolder);
      try {
        const candidates = readdirSync(appDir).filter((f: string) => f.endsWith(".ts") && !f.includes(".SPEC") && !f.includes(".CHANGELOG") && !f.includes(".test") && !f.includes("test.ts"));
        for (const file of candidates) {
          try {
            const fullPath = path.join(appDir, file);
            try { const req = createRequire(import.meta.url); delete req.cache[req.resolve(fullPath)]; } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
            const mod = await import(fullPath + `?t=${Date.now()}`);
            if (mod.app && mod.app.name === name) {
              _loadCache.set(name, { app: mod.app, ts: Date.now() });
              registerApp(mod.app);
              return mod.app;
            }
          } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
        }
      } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
    }
  }
  // dev mode fallback
  const fb = apps.get(name);
  if (fb) _loadCache.set(name, { app: fb, ts: Date.now() });
  return fb;
}


// ── App 注册 ──

export function registerApp(app: MobileApp) {
  apps.set(app.name, app);
  // 同步到 state，供 CLI 渲染
  if (!state.installedApps) state.installedApps = [];
  if (!state.installedApps.find((a: any) => a.name === app.name)) {
    state.installedApps.push({ name: app.name, desc: app.messageDescription });
  }
}

// ── 通知 ──

export function pushNotification(text: string) {
  state.notifications.push({ from: i18n("系统", "System"), text, ts: Date.now() });
  if (state.notifications.length > 50) state.notifications.shift();
}

// ── 屏幕渲染 ──

import { logerr } from "#paths";

// 终端可见宽度：CJK/emoji 约占 2 列，ASCII 占 1 列
function vw(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x4e00 && c <= 0x9fff || c >= 0x3000 && c <= 0x303f || c >= 0xff00 && c <= 0xffef) w += 2;
    else if (c > 0x7f && c < 0x2000) w += 1;
    else w += 1;
  }
  return w;
}

function padR(s: string, w: number): string { return s + " ".repeat(Math.max(0, w - vw(s))); }

function renderHome(): string {
  const allApps = [...apps.values()];
  const COLS = 3;
  const GAP = 2;
  // 按列计算最大宽度
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
  const unread = (state.notifications || []).length;
  lines.push(`│${padR(unread > 0 ? ` ${unread}${i18n("条通知 | 输入「通知」查看", " notification(s) | type 'notifications'")}` : i18n(" 无新通知", "  No new notifications"), innerW)}│`);
  lines.push(`│${padR(i18n(` 模式: ${mode}`, `  Mode: ${mode}`), innerW)}│`);
  lines.push(`└${hr}┘`);
  return lines.join("\n");
}

function renderNotifications(): string {
  const lines = [i18n("═══ 通知中心 ═══", "═══ Notifications ═══"), ""];
  if (state.notifications.length === 0) {
    lines.push(i18n("  (无通知)", "  (none)"));
  } else {
    for (const n of state.notifications.slice(-10)) {
      lines.push(`    [${n.from}] ${n.text}`);
    }
  }
  lines.push("");
  lines.push(i18n("输入「清除通知」清除全部 | 「主屏幕」回主屏幕", "'clear' to clear all | 'home' to go back"));
  return lines.join("\n");
}

// ── 输入路由 ──

function findApp(input: string): MobileApp | null {
  const lower = input.toLowerCase().trim();
  for (const [, app] of apps) {
    if (lower === app.name.toLowerCase() || lower === app.icon.toLowerCase()) return app;
  }
  return null;
}

function isBack(input: string): boolean {
  return /^(主屏幕|主页|home|退出|exit)$/i.test(input.trim());
}

async function handleInput(input: string, personDir: string): Promise<string> {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  if (isBack(trimmed)) {
    state.currentApp = null;
    saveState();
    const s = renderHome(); _lastScreen = s; return s;
  }

  if (/^(截图|截屏|screenshot)$/i.test(trimmed)) {
    try {
      const photosDir = path.join(homedir(), ".teyvat/AppData/shared/photos");
      mkdirSync(photosDir, { recursive: true });
      const fn = `mobilepic_${Date.now()}.mobilepic`;
      const snap: any = { type: "mobilepic", ts: Date.now(), app: state.currentApp || i18n("主屏幕", "Home"), screen: _lastScreen || i18n("(空)", "(empty)") };
      writeFileSync(path.join(photosDir, fn), JSON.stringify(snap, null, 2));
      return i18n(`截图已保存: ${fn}\n\n打开「相册」app 浏览。`, `Screenshot saved: ${fn}\n\nOpen the Photos app to browse.`);
    } catch (e: any) { return i18n("截图失败: ", "Screenshot failed: ") + e.message; }
  }

  // I3: 录屏 — 开始/停止
  if (/^(开始录屏|录屏|record)$/i.test(trimmed)) {
    if (_recording) return i18n("已在录屏中。输入「停止录屏」结束。", "Already recording. Type 'stop' to end.");
    _recording = true;
    _recFrames = [];
    // 捕获当前屏幕作为第一帧
    if (_lastScreen) _recFrames.push({ ts: Date.now(), app: state.currentApp || i18n("主屏幕", "Home"), screen: _lastScreen });
    return i18n("录屏已开始。操作完成后输入「停止录屏」保存。", "Recording started. Type 'stop' to save.");
  }
  if (/^(停止录屏|stop)$/i.test(trimmed)) {
    if (!_recording) return i18n("当前未在录屏。输入「开始录屏」开始。", "Not recording. Type 'record' to start.");
    _recording = false;
    try {
      const photosDir = path.join(homedir(), ".teyvat/AppData/shared/photos");
      mkdirSync(photosDir, { recursive: true });
      const fn = `mobilelog_${Date.now()}.mobilelog`;
      const rec: any = {
        type: "mobilelog",
        ts_start: _recFrames[0]?.ts || Date.now(),
        ts_end: Date.now(),
        frames: _recFrames,
      };
      writeFileSync(path.join(photosDir, fn), JSON.stringify(rec, null, 2));
      _recFrames = [];
      return i18n(`录屏已保存: ${fn}\n共 ${rec.frames.length} 帧\n\n打开「相册」app 浏览。`, `Recording saved: ${fn}\n${rec.frames.length} frames\n\nOpen the Photos app to browse.`);
    } catch (e: any) { return i18n("录屏保存失败: ", "Recording save failed: ") + e.message; }
  }

  if (/^(通知|notifications?)$/i.test(trimmed)) {
    state.currentApp = null;
    return renderNotifications();
  }

  if (/^(清除通知|clear notifications?)$/i.test(trimmed)) {
    state.notifications = [];
    saveState();
    return i18n("通知已全部清除。", "Notifications cleared.");
  }

  // ── 全局快捷: 发消息 <ID> <内容> → 任何地方直接发送，不下钻微信 ──
  const sendMsgMatch = trimmed.match(/^发消息\s+(\S+)\s+(.+)/);
  if (sendMsgMatch) {
    const target = sendMsgMatch[1];
    const text = sendMsgMatch[2];
    if (!text.trim()) return i18n("消息不能为空", "Message cannot be empty");
    try {
      const { appendFileSync: afs, mkdirSync: mks } = await import("node:fs");
      const { join } = await import("node:path");
      const wd = join(homedir(), ".teyvat/AppData/shared/wechat");
      mks(wd, { recursive: true });
      const msg = { from: process.env.PAIMON_AGENT_NAME || "unknown", to: target, text: text.trim(), ts: Date.now() };
      afs(join(wd, "wechat.jsonl"), JSON.stringify(msg) + "\n");
      try { const wd2 = join(homedir(), ".teyvat/RuntimeCache", target, "wake"); mks(wd2, { recursive: true }); afs(join(wd2, "wechat.wake"), JSON.stringify({ from: msg.from, ts: Date.now() }) + "\n"); } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
      const ctx = state.currentApp ? i18n(` (当前在 ${state.currentApp})`, ` (now in ${state.currentApp})`) : "";
      return i18n(`已发送给 ${target}${ctx}\n${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`, `Sent to ${target}${ctx}\n${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);
    } catch (e: any) { return i18n("发送失败: ", "Send failed: ") + e.message; }
  }

  if (/^(锁屏|lock)$/i.test(trimmed)) {
    state.currentApp = null;
    return i18n("手机已锁定。再次使用 mobile 解锁。", "Phone locked. Use 'mobile' to unlock.");
  }

  // 控制中心：切换通知模式（紧凑面板）
  if (/^(控制中心|control)$/i.test(trimmed)) {
    const mode = state.notificationMode || "normal";
    const normal = mode === "normal" ? "[ON]" : "";
    const focus = mode === "focus" ? "[ON]" : "";
    const dnd = mode === "dnd" ? "[ON]" : "";
    return `Control Center\n\n  ${normal} ${i18n("正常", "Normal")}  ${focus} ${i18n("专注", "Focus")}  ${dnd} ${i18n("勿扰", "DND")}\n\n  ${i18n("输入 正常/专注/勿扰 切换", "Type normal/focus/dnd to switch")}`;
  }
  if (/^(勿扰|dnd)$/i.test(trimmed)) {
    state.notificationMode = "dnd";
    saveState();
    return i18n("[DND] 勿扰模式 — 通知不会激活 agent", "[DND] Do-Not-Disturb — notifications will not activate the agent");
  }
  if (/^(专注|focus)$/i.test(trimmed)) {
    state.notificationMode = "focus";
    saveState();
    return i18n("[FOCUS] 专注模式 — 仅重要通知激活", "[FOCUS] Focus mode — only important notifications activate");
  }
  if (/^(正常|normal)$/i.test(trimmed)) {
    state.notificationMode = "normal";
    saveState();
    return i18n("[ON] 正常模式 — 所有通知激活 agent", "[ON] Normal mode — all notifications activate the agent");
  }

  // ── Quick Actions 查询 ──
  if (/^quickactions$/i.test(trimmed)) {
    const lines: string[] = ["═══ Quick Actions ═══", ""];
    for (const [, a] of apps) {
      if (a.quickActions && a.quickActions.length > 0) {
        const actions = a.quickActions.map(q => q.action === "*" ? i18n(`(任意输入) ${q.description}`, `(any input) ${q.description}`) : `${q.action} — ${q.description}`);
        lines.push(`  ${a.name}: ${actions.join(", ")}`);
      }
    }
    if (lines.length === 2) lines.push(i18n("  (暂无 app 声明了 Quick Actions)", "  (no app declared Quick Actions)"));
    lines.push("", i18n("用法: quickactions <app名> 查看详情", "Usage: quickactions <app-name> for details"), i18n("直接调用: <app名> <action> <参数>", "Direct call: <app-name> <action> <args>"));
    return lines.join("\n");
  }
  const qaQueryMatch = trimmed.match(/^quickactions\s+(.+)/i);
  if (qaQueryMatch) {
    const qaName = qaQueryMatch[1].trim();
    const qaApp = findApp(qaName);
    if (!qaApp) return i18n(`未找到 app「${qaName}」`, `App not found: "${qaName}"`);
    const loaded = await loadApp(qaApp.name);
    if (!loaded?.quickActions?.length) return i18n(`${qaApp.name} 没有声明 Quick Actions`, `${qaApp.name} has no Quick Actions declared`);
    const lines = [`${qaApp.name} Quick Actions:`, ""];
    for (const q of loaded.quickActions) {
      const usage = q.action === "*" ? `${qaApp.name} ${i18n("<参数>", "<args>")}` : `${qaApp.name} ${q.action} ${i18n("<参数>", "<args>")}`;
      lines.push(`  ${q.action === "*" ? "*" : q.action} — ${q.description}`);
      lines.push(i18n(`    用法: ${usage}`, `    usage: ${usage}`));
    }
    return lines.join("\n");
  }

  // ── Quick Action 路由：无状态一步调用 ──
  const qaSpaceIdx = trimmed.indexOf(" ");
  if (qaSpaceIdx > 0) {
    const qaFirstWord = trimmed.slice(0, qaSpaceIdx);
    const qaRest = trimmed.slice(qaSpaceIdx + 1);
    const qaTarget = findApp(qaFirstWord);
    if (qaTarget) {
      const qaLoaded = await loadApp(qaTarget.name);
      if (qaLoaded?.quickActions?.length) {
        const qaActionWord = qaRest.split(/\s+/)[0];
        const qaMatched = qaLoaded.quickActions.find((q: QuickAction) => q.action === qaActionWord || q.action === "*");
        if (qaMatched) {
          const qaResult = await qaLoaded.onAction(qaRest, {}, personDir);
          return qaResult.screen;
        }
      }
    }
  }

  if (state.currentApp) {
    // 直接切换到另一个 app，不需要先返回主屏幕
    // 仅当输入以 app 名开头时才切换（防止 "发消息 test-safari" 被劫持）
    const switchApp = findApp(trimmed);
    if (switchApp) {
      const freshApp = await loadApp(switchApp.name) || switchApp;
      if (freshApp.name !== state.currentApp &&
          (lower === switchApp.name.toLowerCase() || lower.startsWith(switchApp.name.toLowerCase() + " "))) {
        state.currentApp = switchApp.name;
        const appState = state.appStates[switchApp.name] ?? {};
        const result = await switchApp.onOpen(appState, personDir);
        state.appStates[switchApp.name] = result.state;
        saveState();
        return result.screen;
      }
      // 已在当前 app 内，又输入了同一个 app 名 → 刷新主页，不当地址栏搜索
      if (switchApp.name === state.currentApp && lower === switchApp.name.toLowerCase()) {
        const appState = state.appStates[switchApp.name] ?? {};
        const result = await switchApp.onOpen(appState, personDir);
        state.appStates[switchApp.name] = result.state;
        saveState();
        return result.screen;
      }
    }
    const app = await loadApp(state.currentApp!);
    if (!app) { state.currentApp = null; saveState(); return renderHome(); }
    const appState = state.appStates[state.currentApp] ?? {};
    const result = await app.onAction(trimmed, appState, personDir);
    state.appStates[state.currentApp] = result.state;
    saveState();
    return result.screen;
  }

  const app = findApp(trimmed);
  if (app) {
    const freshApp = await loadApp(app.name) || app;
    state.currentApp = freshApp.name;
    const appState = state.appStates[freshApp.name] ?? {};
    // Safari 进入时自动启动浏览器服务
    if (freshApp.name === "Safari") {
      startBrowserIfNeeded();
      const result = await freshApp.onOpen(appState, personDir);
      state.appStates[freshApp.name] = result.state;
      saveState();
      const mode = _browserReady ? "🟢 dynamic" : _browserStarting ? "🟡 loading..." : "⚪ static";
      return result.screen + "\n  mode: " + mode;
    }
    const result = await freshApp.onOpen(appState, personDir);
    state.appStates[freshApp.name] = result.state;
    saveState();
    return result.screen;
  }

  return renderHome() + i18n("\n\n没有找到「" + trimmed + "」，请从上面选择一个 app。", "\n\nNo app found named \"" + trimmed + "\". Pick one from the list above.");
}

// ── 入口 ──

export default function (pi: ExtensionAPI) {
  let personDir: string | null = null;
  let registered = false;

  pi.on("session_start", async (_event, ctx) => {
    // if (registered) return; // 调试：允许重注册，打 jiti 缓存绕过
    const sf = (ctx as any).sessionManager?.getSessionFile?.();
    if (!sf) return;
    personDir = getPersonDir(sf);
    if (!personDir) return;
    const id = personDir.match(/[a-f0-9]+$/)?.[0] || 'x';
    setApiAgent(id);
    _stateFile = path.join(runtimeCacheDir(id), "mobile-state.json");
    loadState();
    loadAgentApps(id);

    // 游戏联机服务器（幂等，已运行则跳过）
    if (!sf.includes("metaconsciousnessSessions") && !sf.includes("HippocampusSessions") && !sf.includes("SleepSessions")) {
      startGameServer();
    }

    // 轮询 WeChat 共享文件，收到新消息时 steer 激活 agent
    // 启动时先跳到当前末尾，避免把历史消息当新通知 flood
    const MSG_FILE = path.join(homedir(), ".teyvat/AppData/shared/wechat/wechat.jsonl");
    let _lastMsgLine = 0;
    try {
      const existing = readFileSync(MSG_FILE, "utf8");
      _lastMsgLine = existing.trim().split("\n").filter(Boolean).length;
    } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
    const pollMsgs = () => {
      try {
        const raw = readFileSync(MSG_FILE, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const name = process.env.PAIMON_AGENT_NAME || "";
        for (let i = _lastMsgLine; i < lines.length; i++) {
          try {
            const m = JSON.parse(lines[i]);
            // 检查是否是发给我的群组消息
            let inGroup = false;
            let groupName = "";
            if (m.to.startsWith("group:")) {
              try {
                const gid = m.to.replace(/^(group:)+/, "");
                const gf = path.join(homedir(), ".teyvat/AppData/shared/wechat/groups", `${gid}.json`);
                if (existsSync(gf)) {
                  const g = JSON.parse(readFileSync(gf, "utf8"));
                  inGroup = g.members?.includes(name) || false;
                  groupName = g.name || gid;
                }
              } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
            }
            if (m.to === name || m.to === "all" || m.to === id || inGroup) {
              const preview = (m.text || "").slice(0, 80);
              if (state.notificationMode !== "dnd") {
                try {
                  const feedContent = `[Notification from WeChat] Message from ${m.from}: ${m.text}`;
                  sendCustomMessage(pi, "mobile-notification", feedContent, { app: "WeChat", from: m.from, text: m.text, group: inGroup ? groupName : "" });
                } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
              }
              state.notifications = state.notifications || [];
              state.notifications.unshift({ from: m.from, text: preview, ts: Date.now() });
              if (state.notifications.length > 50) state.notifications.length = 50;
            }
          } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
        }
        _lastMsgLine = lines.length;
      } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
    };
    setInterval(pollMsgs, 5000);
    // 延迟到第一个 before_agent_start 后执行，确保 memory snapshot 已注入前缀（否则 cache miss）
    let _pollStarted = false;
    pi.on("before_agent_start", () => {
      if (!_pollStarted) { _pollStarted = true; pollMsgs(); }
    });

    // ── mobile-notification 渲染器 ──
    pi.registerMessageRenderer("mobile-notification", (message, _opts, theme) => {
      const d = (message.details || {}) as any;
      const from = d.from || "unknown";
      const msgText = (d.text as string) || String(message.content || "");
      const label = `Notification from WeChat`;
      const body = `  Message from ${from}: ${msgText}`;
      return renderMessage.alert(theme, {}, label, body);
    });

    pi.registerMessageRenderer("reminder-check", (message, _opts, theme) => {
      const c = message.content;
      const body = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b:any)=>b.type==="text").map((b:any)=>b.text).join("\n") : String(c??"");
      return renderMessage.notice(theme, "Reminder", body);
    });

    // ── App 自动发现：扫描 ProgramFiles/Mobile/，按 agent 注册表过滤 ──
    const firstRun = _agentAppList === null;
    const discoveredDirs: string[] = [];
    if (existsSync(PROGRAM_FILES_MOBILE)) {
      for (const appFolder of readdirSync(PROGRAM_FILES_MOBILE)) {
        if (appFolder.startsWith(".") || appFolder.startsWith("@FUTURE.") || appFolder.startsWith("@removed.")) continue;
        if (!isAppAllowed(appFolder)) continue;
        const appDir = path.join(PROGRAM_FILES_MOBILE, appFolder);
        try {
          const candidates = readdirSync(appDir).filter((f: string) => f.endsWith(".ts") && !f.includes(".SPEC") && !f.includes(".CHANGELOG") && !f.includes(".test") && !f.includes("test.ts"));
          for (const file of candidates) {
            try {
              const mod = await import(path.join(appDir, file) + `?t=${Date.now()}`);
              if (mod.app && mod.app.name && mod.app.onOpen && mod.app.onAction) {
                registerApp(mod.app);
                discoveredDirs.push(appFolder);
                break;
              }
            } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); /* app import failed */ }
          }
        } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); /* app dir scan failed */ }
      }
    }
    if (firstRun && discoveredDirs.length > 0) {
      _agentAppList = discoveredDirs;
      saveAgentApps();
    }
    saveState(); // 保存 installedApps
  });

  // ── 注册 mobile tool（顶层，不在 session_start 里——必须在 before_agent_start 之前注册）──
  let _mobileQueue: Promise<any> = Promise.resolve();

  registerPaimonTool({
    name: "mobile",
    label: "Mobile",
    messageDescription: i18n("手机 - 打开查看主屏幕，输入 app 名字打开应用，在应用内操作。支持 Quick Actions 一步调用", "Mobile - view the home screen, type an app name to open it and operate inside. Supports Quick Actions one-step calls. Note: the phone UI is NOT localized (Chinese only) — decide how to handle it yourself."),
    promptSnippet: "Use your mobile: open apps, check notifications, play games, browse web. Quick Actions: use 'quickactions' to list available shortcuts, or call directly like 'safari 搜索 xxx' / 'weather 深圳' for one-step stateless operations without entering the app.",
    parameters: {
      type: "object" as any,
      properties: {
        input: { type: "string", messageDescription: i18n("操作内容（app名/动作）。空=查看当前屏幕，「主屏幕」回主页", "Action (app name/command). Empty = view current screen, 'home' = back to home") },
      },
    },
    renderCall(args: any, theme: any) {
      // 标准调用行管线：Mobile 无独立标题参数，指令本体放详情区（与 M 对齐）
      return renderToolCall.detail(theme, "Mobile", "", String(args?.input ?? ""));
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      if (result?.details?.loading) return renderMessage.spinner();
      return renderMessage.output(theme, ctx, resultContent(result));
    },
    async execute(_id: string, args: any) {
      const input = String(args?.input ?? "").trim();
      const t0 = Date.now();
      if (!input) {
        if (state.currentApp && _lastScreen) {
          return { content: [{ type: "text", text: _lastScreen }], details: {} };
        }
        const homeScreen = renderHome();
        saveState(homeScreen);
        return { content: [{ type: "text", text: homeScreen }], details: {} };
      }
      const pd = personDir!;
      // 快速操作同步返回，慢速操作走后台队列
      // 先启动 handleInput，用同一个 Promise 避免竞态重复调用
      const handlePromise = handleInput(input, pd).then(screen => ({ screen: screen || i18n("(无返回)", "(no output)") }));
      const fastResult = await Promise.race([
        handlePromise,
        new Promise(r => setTimeout(() => r(null), 200)),
      ]);
      if (fastResult) {
        const screen = (fastResult as any).screen;
        saveState(screen);
        return { content: [{ type: "text", text: screen }], details: {} };
      }
      // 慢速操作：复用同一个 handlePromise，不重复触发
      _mobileQueue = _mobileQueue.then(() => handlePromise).then((result: any) => {
        const screen = result.screen || i18n("(无返回)", "(no output)");
        saveState(screen);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        try {
          sendCustomMessage(pi, "continuous-cmd-done", i18n(`Mobile 完成 (${elapsed}s):\n${screen.slice(0, 8000)}`, `Mobile done (${elapsed}s):\n${screen.slice(0, 8000)}`));
        } catch (e) { console.error("[universe.infotech/local.mobile/system.kernel/kernel.ts] " + ((e as any)?.message || e)); }
      }).catch(() => {});
      const label = input.startsWith("http") ? input : (input.length > 80 ? input.slice(0, 77) + "..." : input);
      return { content: [{ type: "text", text: i18n(`Mobile 加载中... (${label})`, `Mobile loading... (${label})`) }], details: { loading: true } };
    },
  });
}

