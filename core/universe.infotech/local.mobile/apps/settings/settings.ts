import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";

function asyncShSafe(cmd: string, timeout: number): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (_err, stdout, stderr) => {
      resolve((stdout || "") + (stderr || ""));
    });
  });
}
import type { MobileApp } from "../../system.kernel/kernel.ts";
import { getRegion, setRegion } from "../calendar/calendar.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { logerr } from "#paths";

// apps/settings/settings.ts — 系统设置

// ── 通知设置持久化 ──
function loadNotifSettings(personDir: string): Record<string, string> {
  try {
    const f = path.join(personDir, "notif_settings.json");
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, "utf8"));
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/settings/settings.ts] " + ((e as any)?.message || e)); return {}; }
}
function saveNotifSettings(personDir: string, s: Record<string, string>) {
  try {
    mkdirSync(personDir, { recursive: true });
    writeFileSync(path.join(personDir, "notif_settings.json"), JSON.stringify(s));
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/settings/settings.ts] " + ((e as any)?.message || e)); }
}

async function getPiVersion(): Promise<string> {
  const raw = await asyncShSafe("node -e 'console.log(require(\"@earendil-works/pi-coding-agent/package.json\").version)'", 3000);
  return raw.trim() || "?";
}

function loadCostTotal(personDir: string): { main: number; hippocampus: number; metaconsciousness: number; total: number; sessions: number } {
  const f = path.join(personDir, "cost_total.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { console.error("[universe.infotech/local.mobile/apps/settings/settings.ts] " + ((e as any)?.message || e)); return { main: 0, hippocampus: 0, metaconsciousness: 0, total: 0, sessions: 0 }; }
}

function loadCostCurrent(personDir: string, role: string): number {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(personDir, `cost-${role}.json`), "utf8"));
    return d.cost || 0;
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/settings/settings.ts] " + ((e as any)?.message || e)); return 0; }
}

export async function settingsCmd(args: any, _ctx: any, personDir: string): Promise<{ content: any[]; details: any }> {
  const a = args.action || "";
  if (a === "status") {
    const piVer = await getPiVersion();
    const costTotal = loadCostTotal(personDir);
    const costCurr = {
      main: loadCostCurrent(personDir, "main"),
      hippocampus: loadCostCurrent(personDir, "hippocampus"),
      metaconsciousness: loadCostCurrent(personDir, "metaconsciousness"),
      total: 0,
    };
    costCurr.total = costCurr.main + costCurr.hippocampus + costCurr.metaconsciousness;
    const info = {
      platform: process.platform, arch: process.arch, pi: piVer, node: process.version,
      cwd: process.cwd(), uptime: Math.floor(process.uptime()),
      costCurrent: costCurr, costTotal,
    };
    const lines = [
      `平台: ${info.platform}/${info.arch}`, `pi: v${info.pi}`, `Node: ${info.node}`, `运行时间: ${info.uptime}s`,
      ``, `--- 费用 ---`, `当前会话: $${costCurr.total.toFixed(4)}`,
      `  主意识: $${costCurr.main.toFixed(4)}`, `  海马体: $${costCurr.hippocampus.toFixed(4)}`, `  元意识: $${costCurr.metaconsciousness.toFixed(4)}`,
      `累计(全部会话): $${costTotal.total.toFixed(4)} (${costTotal.sessions}次会话)`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }], details: info };
  }
  if (a === "region" || a === "地区") {
    const current = getRegion(personDir);
    return { content: [{ type: "text", text: `**地区设置**\n\n当前: ${current === "CN" ? "中国" : "美国"}\n\n切换: 地区 中国 | 地区 美国` }], details: {} };
  }
  if (a === "地区 中国") { setRegion(personDir, "CN"); return { content: [{ type: "text", text: "地区已切换为 **中国**。" }], details: {} }; }
  if (a === "地区 美国") { setRegion(personDir, "US"); return { content: [{ type: "text", text: "地区已切换为 **美国**。" }], details: {} }; }
  if (a === "dev" || a === "开发者模式") {
    const statePath = path.join(homedir(), ".teyvat/RuntimeCache", personDir.split("/").pop()!, "mobile-state.json");
    let st: any = {};
    try { st = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (e) { console.error("[universe.infotech/local.mobile/apps/settings/settings.ts] " + ((e as any)?.message || e)); }
    st.devMode = !st.devMode;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(st));
    return { content: [{ type: "text", text: `开发者模式: ${st.devMode ? "开启 🟢" : "关闭 ⚪"}${st.devMode ? " (app 代码修改后无需重启)" : ""}` }], details: {} };
  }
  return { content: [{ type: "text", text: `未知操作: ${a}。可用: status | 地区 | 开发者模式` }], details: {} };
}

// ── MobileApp ──
export const app: MobileApp = {
  name: "settings",
  icon: "设置",
  messageDescription: "系统设置与状态",
  onOpen(_state, personDir) {
    const region = getRegion(personDir);
    const regionLabel = region === "US" ? "美国" : "中国";
    const ns = loadNotifSettings(personDir);
    const notifLines = Object.keys(ns).length > 0
      ? Object.entries(ns).map(([a,m]) => `  通知·${a}: ${m}`).join("\n")
      : "  (未设置)";
    return {
      screen: [
        "设置", "",
        `地区: ${regionLabel}`, "",
        "── 通知设置 ──", notifLines, "",
        "命令:",
        "  通知 <app> <全局|静默|关闭>  — 设置 app 通知模式",
        "  通知列表                     — 查看所有通知设置",
        "  状态         — 查看系统状态与费用",
        "  地区         — 查看地区设置",
        "  开发者模式   — 切换 Mobile 开发者模式",
      ].join("\n"),
      state: _state ?? {},
    };
  },
  async onAction(input, state, personDir) {
    const trimmed = input.trim();
    const notifMatch = trimmed.match(/^通知\s+(\S+)\s+(全局|静默|关闭)$/);
    if (notifMatch) {
      const [, app, mode] = notifMatch;
      const s = loadNotifSettings(personDir);
      s[app] = mode;
      saveNotifSettings(personDir, s);
      return { screen: `${app} 通知已设为「${mode}」`, state };
    }
    if (trimmed === "通知列表") {
      const s = loadNotifSettings(personDir);
      const lines = Object.keys(s).length > 0 ? Object.entries(s).map(([a,m]) => `  ${a}: ${m}`) : ["  (无设置)"];
      return { screen: ["通知设置列表", "", ...lines, "", "设置: 通知 <app> <全局|静默|关闭>"].join("\n"), state };
    }
    let action = trimmed;
    if (trimmed === "状态") action = "status";
    else if (trimmed === "地区") action = "region";
    else if (trimmed.startsWith("地区 ")) action = trimmed;
    else if (trimmed === "开发者模式") action = "dev";
    else return this.onOpen(state, personDir);
    const result = await settingsCmd({ action }, {}, personDir);
    return { screen: result.content[0].text, state };
  },
};
