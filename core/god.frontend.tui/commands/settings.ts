// god.frontend.tui/commands/settings.ts
// /s 命令 — 统一设置入口（多标签页），各标签页对应已有的 /i /u /c /m /e /b 命令
import { i18n } from "#tui_localizations";
import { identityHandler } from "./infos.ts";
import { viewHandler } from "./ux.ts";
import { configHandler } from "./config.ts";
import { effortHandler } from "./effort.ts";
import { bgHandler } from "./bg.ts";

const T = (zh: string, en: string) => i18n(zh, en);

const TABS = [
  { key: "identity", label: () => T("身份", "Identity"),  handler: identityHandler },
  { key: "display",  label: () => T("显示", "Display"),   handler: viewHandler },
  { key: "services", label: () => T("服务", "Services"),  handler: configHandler },
  { key: "model",    label: () => T("模型", "Model"),     handler: (_a: any, ctx: any) => {
    const handle = (globalThis as any).__genshinHandleModelCommand;
    if (typeof handle === "function") { handle(); return; }
    ctx.ui.notify(T("模型选择器未就绪", "Model selector not ready"), "error");
  }},
  { key: "effort",   label: () => T("推理", "Effort"),    handler: effortHandler },
  { key: "bg",       label: () => T("后台", "Background"), handler: bgHandler },
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
    const options = TABS.map(t => `${B}${t.label()}${R}  ${D}/${t.key.charAt(0)}${R}`);
    const pick = await ctx.ui.select(`${A}${B}${T("设置", "Settings")}${R}`, options);
    if (!pick) break;
    const idx = options.indexOf(pick);
    if (idx < 0) break;
    await TABS[idx].handler(args, ctx);
  }
}
