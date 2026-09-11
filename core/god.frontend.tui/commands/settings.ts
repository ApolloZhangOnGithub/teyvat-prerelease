// god.frontend.tui/commands/settings.ts
// /s 命令 — 统一设置入口，扁平 SettingsList（所有可切换设置合并到一个列表）
import { i18n } from "#tui_localizations";
import { identityHandler } from "./infos.ts";
import { configHandler } from "./config.ts";
import { bgHandler } from "./bg.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const T = (zh: string, en: string) => i18n(zh, en);

let _toolsHandler: ((args: any, ctx: any) => Promise<void>) | null = null;
export function setToolsHandler(h: (args: any, ctx: any) => Promise<void>) { _toolsHandler = h; }

function save(key: string, value: any) {
  try {
    const sm = (globalThis as any).__genshinSettingsManager;
    if (sm) { sm.globalSettings[key] = value; sm.markModified(key); sm.save(); }
  } catch (e) { console.error("[god.frontend.tui/commands/settings.ts] " + ((e as any)?.message || e)); }
}

// effort 映射
const EFFORT_MAP: [string, string][] = [["max", "high"], ["high", "medium"], ["low", "low"]];

function getAllItems() {
  const g = globalThis as any;

  // ── 显示 ──
  const renderMode = g.__piRenderMode || "line";
  const thinkHidden = g.__genshinGetThinkingHidden?.() ?? false;
  const toolExpanded = g.__genshinGetToolExpanded?.() ?? false;
  const readExpanded = g.__genshinReadExpanded ?? false;
  const codeHighlight = g.__genshinCodeHighlight ?? false;
  const executeDisplay = g.__genshinExecuteDisplay ?? "full";
  const compactExecute = g.__genshinCompactExecute ?? false;
  const breakAnd = g.__genshinExecuteBreakAnd ?? false;

  const toolMode = toolExpanded ? T("完整", "Full") : T("摘要", "Summary");
  const readMode = readExpanded ? T("完整", "Full") : T("摘要", "Summary");
  const exeCallMode = executeDisplay === "title" ? T("仅标题", "Title") : executeDisplay === "command" ? T("仅命令", "Cmd") : T("标题+命令", "Title+Cmd");
  const exeResultMode = compactExecute ? T("摘要", "Summary") : T("完整", "Full");

  const items: any[] = [
    { id: "_hdr_display", label: T("── 显示 ──", "── Display ──"), currentValue: "", values: [] },
    { id: "renderMode", label: T("渲染模式", "Render Mode"), currentValue: renderMode, values: ["line", "streaming", "block"] },
    { id: "thinking", label: "Thinking", currentValue: thinkHidden ? T("隐藏", "Hidden") : (g.__genshinThinkingFirstLine ? T("首行", "First line") : T("完整", "Full")), values: [T("首行", "First line"), T("完整", "Full"), T("隐藏", "Hidden")] },
    { id: "codeHighlight", label: T("代码高亮", "Code Highlight"), currentValue: codeHighlight ? T("开", "On") : T("关", "Off"), values: [T("关", "Off"), T("开", "On")] },
    { id: "toolExpanded", label: T("工具输出", "Tool Output"), currentValue: toolMode, values: [T("摘要", "Summary"), T("完整", "Full")] },
  ];

  if (toolExpanded) {
    const writeExpanded = g.__genshinWriteExpanded ?? false;
    const editExpanded = g.__genshinEditExpanded ?? true;
    items.push(
      { id: "readExpanded", label: T("  Read", "  Read"), currentValue: readMode, values: [T("摘要", "Summary"), T("完整", "Full")] },
      { id: "writeExpanded", label: T("  Write", "  Write"), currentValue: writeExpanded ? T("完整", "Full") : T("摘要", "Summary"), values: [T("摘要", "Summary"), T("完整", "Full")] },
      { id: "editExpanded", label: T("  Edit", "  Edit"), currentValue: editExpanded ? T("完整", "Full") : T("摘要", "Summary"), values: [T("摘要", "Summary"), T("完整", "Full")] },
      { id: "executeDisplay", label: T("  Execute 调用", "  Execute Call"), currentValue: exeCallMode, values: [T("仅标题", "Title"), T("标题+命令", "Title+Cmd"), T("仅命令", "Cmd")] },
      { id: "compactExecute", label: T("  Execute 结果", "  Execute Result"), currentValue: exeResultMode, values: [T("摘要", "Summary"), T("完整", "Full")] },
    );
    if (executeDisplay !== "title") {
      items.push({ id: "breakAnd", label: T("    && 换行", "    && Break"), currentValue: breakAnd ? T("拆分", "Split") : T("不拆", "Keep"), values: [T("不拆", "Keep"), T("拆分", "Split")] });
    }
  }

  // ── 推理 ──
  const curPi = (g.__genshinGetThinkingLevel?.()) || "high";
  const curEffort = EFFORT_MAP.find(([, pi]) => pi === curPi)?.[0] || "max";
  items.push(
    { id: "_hdr_reasoning", label: T("── 推理 ──", "── Reasoning ──"), currentValue: "", values: [] },
    { id: "effort", label: "Effort", currentValue: curEffort, values: EFFORT_MAP.map(([ds]) => ds) },
  );

  // ── 行为 ──
  const ctrlCToBg = g.__genshinCtrlCToBg ?? true;
  items.push(
    { id: "_hdr_behavior", label: T("── 行为 ──", "── Behavior ──"), currentValue: "", values: [] },
    { id: "ctrlC", label: "Ctrl+C", currentValue: ctrlCToBg ? T("转后台", "To Bg") : T("停止", "Stop"), values: [T("转后台", "To Bg"), T("停止", "Stop")] },
    { id: "greetOnAttach", label: T("回来打招呼", "Greet on attach"), currentValue: (g.__genshinGreetOnAttach ?? true) ? T("开", "On") : T("关", "Off"), values: [T("开", "On"), T("关", "Off")] },
    { id: "unloadMode", label: T("休眠卸载", "Hibernate unload"), currentValue: (g.__genshinUnloadMode || "seamless") === "classic" ? T("传统", "Classic") : T("无感", "Seamless"), values: [T("无感", "Seamless"), T("传统", "Classic")] },
  );

  // ── Footer ──
  const footerAge = g.__genshinFooterAge ?? false;
  const footerTokenmaxxed = g.__genshinFooterTokenmaxxed ?? false;
  const tokenmaxxedColorful = g.__genshinTokenmaxxedColorful ?? false;
  const footerProvider = g.__genshinFooterProvider ?? false;
  const footerTokensValue = !footerTokenmaxxed ? T("隐藏", "Hide") : tokenmaxxedColorful ? T("多彩", "Colorful") : T("显示", "Show");
  items.push(
    { id: "_hdr_footer", label: T("── 底栏 ──", "── Footer ──"), currentValue: "", values: [] },
    { id: "footerAge", label: T("年龄", "Age"), currentValue: footerAge ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
    { id: "footerTokens", label: T("履历", "Tokens"), currentValue: footerTokensValue, values: [T("隐藏", "Hide"), T("显示", "Show"), T("多彩", "Colorful")] },
    { id: "footerProvider", label: T("供应商", "Provider"), currentValue: footerProvider ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
  );

  // ── 实验 ──
  const expFlag = g.__genshinExperimental ?? 0x0001;
  const xattrOn = !!(expFlag & 0x0001);
  let researchOn = true;
  try {
    const { existsSync, readFileSync } = require("node:fs");
    const { userFile } = require("#paths");
    const p = userFile("settings.json");
    if (existsSync(p)) { const s = JSON.parse(readFileSync(p, "utf8")); if (typeof s.research === "boolean") researchOn = s.research; }
  } catch { /* settings not found */ }
  items.push(
    { id: "_hdr_experimental", label: T("── 实验 ──", "── Experimental ──"), currentValue: "", values: [] },
    { id: "xattr", label: T("xattr 文件元数据", "xattr metadata"), currentValue: xattrOn ? T("开", "On") : T("关", "Off"), values: [T("关", "Off"), T("开", "On")] },
    { id: "research", label: T("RESEARCH logits", "RESEARCH logits"), currentValue: researchOn ? T("开", "On") : T("关", "Off"), values: [T("关", "Off"), T("开", "On")] },
  );

  return items;
}

function handleChange(id: string, value: string) {
  const g = globalThis as any;
  switch (id) {
    case "renderMode":
      g.__piRenderMode = value;
      g.__genshinToggleRenderMode?.(value);
      break;
    case "thinking": {
      const isHidden = value === T("隐藏", "Hidden");
      const isFirstLine = value === T("首行", "First line");
      g.__genshinToggleThinking?.(!isHidden);
      g.__genshinThinkingFirstLine = isFirstLine;
      save("thinkingFirstLine", isFirstLine);
      break;
    }
    case "codeHighlight": {
      const on = value === T("开", "On");
      g.__genshinCodeHighlight = on;
      save("codeHighlight", on);
      break;
    }
    case "toolExpanded":
      g.__genshinToggleToolExpand?.(value === T("完整", "Full"));
      break;
    case "readExpanded":
      g.__genshinReadExpanded = value === T("完整", "Full");
      save("readExpanded", g.__genshinReadExpanded);
      break;
    case "writeExpanded":
      g.__genshinWriteExpanded = value === T("完整", "Full");
      save("writeExpanded", g.__genshinWriteExpanded);
      break;
    case "editExpanded":
      g.__genshinEditExpanded = value === T("完整", "Full");
      save("editExpanded", g.__genshinEditExpanded);
      break;
    case "executeDisplay": {
      const mode = value === T("仅标题", "Title") ? "title" : value === T("仅命令", "Cmd") ? "command" : "full";
      g.__genshinExecuteDisplay = mode;
      save("executeDisplay", mode);
      break;
    }
    case "compactExecute":
      g.__genshinCompactExecute = value === T("摘要", "Summary");
      save("compactExecute", g.__genshinCompactExecute);
      break;
    case "breakAnd":
      g.__genshinExecuteBreakAnd = value === T("拆分", "Split");
      save("executeBreakAnd", g.__genshinExecuteBreakAnd);
      break;
    case "effort": {
      const entry = EFFORT_MAP.find(([ds]) => ds === value);
      if (entry) g.__genshinSetThinkingLevel?.(entry[1]);
      break;
    }
    case "ctrlC":
      g.__genshinCtrlCToBg = value === T("转后台", "To Bg");
      save("ctrlCToBg", g.__genshinCtrlCToBg);
      break;
    case "greetOnAttach":
      g.__genshinGreetOnAttach = value === T("开", "On");
      save("greetOnAttach", g.__genshinGreetOnAttach);
      break;
    case "unloadMode": {
      const mode = value === T("传统", "Classic") ? "classic" : "seamless";
      g.__genshinUnloadMode = mode;
      save("unloadMode", mode);
      break;
    }
    case "footerAge":
      g.__genshinFooterAge = value === T("显示", "Show");
      save("footerAge", g.__genshinFooterAge);
      break;
    case "footerTokens": {
      const isHide = value === T("隐藏", "Hide");
      const isColorful = value === T("多彩", "Colorful");
      g.__genshinFooterTokenmaxxed = !isHide;
      g.__genshinTokenmaxxedColorful = isColorful;
      save("footerTokenmaxxed", !isHide);
      save("tokenmaxxedColorful", isColorful);
      break;
    }
    case "footerProvider":
      g.__genshinFooterProvider = value === T("显示", "Show");
      save("footerProvider", g.__genshinFooterProvider);
      break;
    case "xattr": {
      const on = value === T("开", "On");
      let flag = g.__genshinExperimental ?? 0x0001;
      flag = on ? (flag | 0x0001) : (flag & ~0x0001);
      g.__genshinExperimental = flag;
      try {
        const { existsSync, readFileSync, writeFileSync } = require("node:fs");
        const { userFile } = require("#paths");
        const p = userFile("settings.json");
        const s = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
        s.experimental = flag;
        writeFileSync(p, JSON.stringify(s, null, 2));
      } catch (e) { console.error("[settings.ts] " + ((e as any)?.message || e)); }
      break;
    }
    case "research": {
      const on = value === T("开", "On");
      g.__genshinResearch = on;
      try {
        const { existsSync, readFileSync, writeFileSync } = require("node:fs");
        const { userFile } = require("#paths");
        const p = userFile("settings.json");
        const s = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
        s.research = on;
        writeFileSync(p, JSON.stringify(s, null, 2));
      } catch (e) { console.error("[settings.ts] " + ((e as any)?.message || e)); }
      break;
    }
  }
}

// 保留子命令快捷方式
const SUB_HANDLERS: Record<string, (args: any, ctx: any) => Promise<void>> = {
  i: identityHandler, identity: identityHandler,
  c: configHandler, services: configHandler, config: configHandler,
  b: bgHandler, bg: bgHandler, background: bgHandler,
  m: async (_a: any, ctx: any) => {
    const handle = (globalThis as any).__genshinHandleModelCommand;
    if (typeof handle === "function") { await handle(); return; }
    ctx.ui.notify(T("模型选择器未就绪", "Model selector not ready"), "error");
  },
  t: async (a: any, ctx: any) => {
    if (_toolsHandler) { await _toolsHandler(a, ctx); return; }
    ctx.ui.notify(T("工具管理未就绪", "Tools manager not ready"), "error");
  },
};

export async function settingsHandler(args: any, ctx: any) {
  const argStr = typeof args === "string" ? args.trim() : args?.args?.trim?.() || "";
  if (argStr) {
    const handler = SUB_HANDLERS[argStr] || SUB_HANDLERS[argStr.toLowerCase()];
    if (handler) { await handler(args, ctx); return; }
  }

  const showSettingsList = (globalThis as any).__genshinShowSettingsList;
  if (!showSettingsList) {
    ctx.ui.notify(T("设置列表未就绪", "Settings list not ready"), "error");
    return;
  }

  await showSettingsList(T("设置", "Settings"), getAllItems, handleChange);
}

// 带路径的 showSettingsList 包装——子页面使用
export function settingsPath(...segments: string[]): string[] | string {
  const root = T("设置", "Settings");
  return segments.length > 0 ? [root, ...segments] : root;
}
