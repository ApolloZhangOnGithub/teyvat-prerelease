// god.frontend.tui/commands/settings.ts
// /s 命令 — 统一设置入口（多标签页），各标签页对应已有的 /i /u /c /m /e /b 命令
import { i18n } from "#tui_localizations";
import { identityHandler } from "./infos.ts";
import { viewHandler } from "./ux.ts";
import { configHandler } from "./config.ts";
import { effortHandler } from "./effort.ts";
import { bgHandler } from "./bg.ts";
import { experimentalHandler } from "./devs.ts";

const T = (zh: string, en: string) => i18n(zh, en);

// tools handler 需要 pi 实例传入，在 registerGodCommands 时注入
let _toolsHandler: ((args: any, ctx: any) => Promise<void>) | null = null;
export function setToolsHandler(h: (args: any, ctx: any) => Promise<void>) { _toolsHandler = h; }

const TABS = [
  { key: "identity",     shortcut: "i", label: () => T("身份", "Identity"),     handler: identityHandler },
  { key: "display",      shortcut: "u", label: () => T("显示", "Display"),      handler: viewHandler },
  { key: "services",     shortcut: "c", label: () => T("服务", "Services"),     handler: configHandler },
  { key: "model",        shortcut: "m", label: () => T("模型", "Model"),        handler: async (_a: any, ctx: any) => {
    const handle = (globalThis as any).__genshinHandleModelCommand;
    if (typeof handle === "function") { await handle(); return; }
    ctx.ui.notify(T("模型选择器未就绪", "Model selector not ready"), "error");
  }},
  { key: "effort",       shortcut: "e", label: () => T("推理", "Effort"),       handler: effortHandler },
  { key: "tools",        shortcut: "t", label: () => T("工具", "Tools"),        handler: async (a: any, ctx: any) => {
    if (_toolsHandler) { await _toolsHandler(a, ctx); return; }
    ctx.ui.notify(T("工具管理未就绪", "Tools manager not ready"), "error");
  }},
  { key: "bg",           shortcut: "b", label: () => T("后台", "Background"),   handler: bgHandler },
  { key: "experimental", shortcut: "d", label: () => T("实验", "Experimental"), handler: experimentalHandler },
];

export async function settingsHandler(args: any, ctx: any) {
  const argStr = typeof args === "string" ? args.trim() : args?.args?.trim?.() || "";
  // /s <tab> 直接跳到指定标签页
  if (argStr) {
    const tab = TABS.find(t => t.key.startsWith(argStr) || t.label().toLowerCase().startsWith(argStr.toLowerCase()));
    if (tab) { await tab.handler(args, ctx); return; }
  }

  while (true) {
    const D = "\x1b[90m"; const R = "\x1b[0m"; const B = "\x1b[1m"; const A = "\x1b[96m";
    const options = TABS.map(t => `${B}${t.label()}${R}  ${D}/${t.shortcut}${R}`);
    const pick = await ctx.ui.select(`${A}${B}${T("设置", "Settings")}${R}`, options);
    if (!pick) break;
    const idx = options.indexOf(pick);
    if (idx < 0) break;
    await TABS[idx].handler(args, ctx);
  }
}
