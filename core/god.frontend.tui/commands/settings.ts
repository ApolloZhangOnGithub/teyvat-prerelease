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

// 2026-09-13：保存最近一次 ctx，供面板“功能入口”条目的 onActivate 使用（getAllItems 本身无 ctx）
let _ctx: any = null;

// 2026-09-13：把 /m /i /c /b /t 统一到设置面板。
// 背景：2026-09-11 的 1ecb240d（auto-checkpoint）把 register.ts 里这些独立命令的注册删了
// （意图是“合并进设置面板”），但面板 getAllItems 里并没有加回对应入口 → 模型切换等功能直接“消失”。
// 这里用 settings-list 支持的 item.onActivate 把它们做回面板可见入口（面板即全功能入口）。
function featureEntries(): any[] {
  const g = globalThis as any;
  let curModel = "";
  try { curModel = g.__genshinGetModel?.()?.id || ""; } catch { /* 模型未就绪（首个 turn 前） */ }
  const guard = (fn: () => any) => () => {
    try { fn(); } catch (e) { console.error("[god.frontend.tui/commands/settings.ts] feature entry: " + ((e as any)?.message || e)); }
  };
  return [
    { id: "_hdr_features", label: T("── 功能 ──", "── Features ──"), currentValue: "", values: [] },
    { id: "f_model", label: T("模型", "Model"), currentValue: curModel, values: [], onActivate: guard(() => {
      const h = g.__genshinHandleModelCommand;
      if (typeof h === "function") { h(); return; }
      _ctx?.ui?.notify?.(T("模型选择器未就绪", "Model selector not ready"), "error");
    }) },
    { id: "f_identity", label: T("身份与用量", "Identity & Usage"), currentValue: "", values: [], onActivate: guard(() => identityHandler("", _ctx)) },
    { id: "f_services", label: T("服务与凭证", "Services"), currentValue: "", values: [], onActivate: guard(() => configHandler("", _ctx)) },
    { id: "f_bg", label: T("后台任务", "Background"), currentValue: "", values: [], onActivate: guard(() => bgHandler("", _ctx)) },
    { id: "f_tools", label: T("工具管理", "Tools"), currentValue: "", values: [], onActivate: guard(() => { if (_toolsHandler) _toolsHandler("", _ctx); }) },
  ];
}

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
  const executeSummary = g.__genshinExecuteSummary === true;
  const executeResult = g.__genshinExecuteResult ?? "full";
  const waitShow = g.__genshinWaitShow === true;
  const toolElapsed = g.__genshinToolElapsed === true;
  const amemDisplay = g.__genshinAmemDisplay ?? "fold";
  const breakAnd = g.__genshinExecuteBreakAnd ?? false;

  const toolMode = toolExpanded ? T("完整", "Full") : T("摘要", "Summary");
  const readMode = readExpanded ? T("完整", "Full") : T("摘要", "Summary");
  // 2026-09-13（用户定稿）：Execute 摘要 = 显示/隐藏；Execute 结果 = 隐藏/摘要/全部；Wait 输出 = 隐藏/显示（默认隐藏）
  const exeSummaryMode = executeSummary ? T("显示", "Show") : T("隐藏", "Hide");
  const exeResultMode = executeResult === "hide" ? T("隐藏", "Hide") : executeResult === "summary" ? T("摘要", "Summary") : T("全部", "Full");
  const waitShowMode = waitShow ? T("显示", "Show") : T("隐藏", "Hide");

  const items: any[] = [
    ...featureEntries(),
    { id: "_hdr_display", label: T("── 显示 ──", "── Display ──"), currentValue: "", values: [] },
    { id: "renderMode", label: T("渲染模式", "Render Mode"), currentValue: renderMode, values: ["line", "streaming", "block"] },
    { id: "thinking", label: "Thinking", currentValue: thinkHidden ? T("隐藏", "Hidden") : (g.__genshinThinkingFirstLine ? T("首行", "First line") : T("完整", "Full")), values: [T("首行", "First line"), T("完整", "Full"), T("隐藏", "Hidden")] },
    { id: "codeHighlight", label: T("代码高亮", "Code Highlight"), currentValue: codeHighlight ? T("开", "On") : T("关", "Off"), values: [T("关", "Off"), T("开", "On")] },
    // 2026-09-13（用户）：Intention 工具输出——隐藏 / 显示（默认隐藏）
    { id: "intention", label: T("Intention 输出", "Intention Output"), currentValue: ((g as any).__genshinIntentionShow ?? false) ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
    { id: "toolExpanded", label: T("工具输出", "Tool Output"), currentValue: toolMode, values: [T("摘要", "Summary"), T("完整", "Full")] },
    // 2026-09-13（用户）：工具结果耗时戳 [0.009s] 默认隐藏
    { id: "toolElapsed", label: T("工具耗时", "Tool Elapsed"), currentValue: toolElapsed ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
    // 2026-09-13（用户）：Amem 输出三态——隐藏/折叠/显示（默认折叠）
    { id: "amemDisplay", label: T("Amem 输出", "Amem Output"), currentValue: amemDisplay === "hide" ? T("隐藏", "Hide") : amemDisplay === "show" ? T("显示", "Show") : T("折叠", "Fold"), values: [T("隐藏", "Hide"), T("折叠", "Fold"), T("显示", "Show")] },
  ];

  if (toolExpanded) {
    const writeExpanded = g.__genshinWriteExpanded ?? false;
    const editExpanded = g.__genshinEditExpanded ?? true;
    items.push(
      { id: "readExpanded", label: T("  Read", "  Read"), currentValue: readMode, values: [T("摘要", "Summary"), T("完整", "Full")] },
      { id: "writeExpanded", label: T("  Write", "  Write"), currentValue: writeExpanded ? T("完整", "Full") : T("摘要", "Summary"), values: [T("摘要", "Summary"), T("完整", "Full")] },
      { id: "editExpanded", label: T("  Edit", "  Edit"), currentValue: editExpanded ? T("完整", "Full") : T("摘要", "Summary"), values: [T("摘要", "Summary"), T("完整", "Full")] },
      { id: "executeSummary", label: T("  Execute 摘要", "  Execute Summary"), currentValue: exeSummaryMode, values: [T("隐藏", "Hide"), T("显示", "Show")] },
      { id: "executeResult", label: T("  Execute 结果", "  Execute Result"), currentValue: exeResultMode, values: [T("隐藏", "Hide"), T("摘要", "Summary"), T("全部", "Full")] },
      { id: "waitShow", label: T("  Wait 输出", "  Wait Output"), currentValue: waitShowMode, values: [T("隐藏", "Hide"), T("显示", "Show")] },
    );
    if (executeSummary) {
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
  const footerModel = g.__genshinFooterModel ?? true;
  const footerVersion = g.__genshinFooterVersion ?? true;
  const footerTokensValue = !footerTokenmaxxed ? T("隐藏", "Hide") : tokenmaxxedColorful ? T("多彩", "Colorful") : T("显示", "Show");
  items.push(
    { id: "_hdr_footer", label: T("── 底栏 ──", "── Footer ──"), currentValue: "", values: [] },
    { id: "footerAge", label: T("年龄", "Age"), currentValue: footerAge ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
    { id: "footerTokens", label: T("履历", "Tokens"), currentValue: footerTokensValue, values: [T("隐藏", "Hide"), T("显示", "Show"), T("多彩", "Colorful")] },
    { id: "footerProvider", label: T("供应商", "Provider"), currentValue: footerProvider ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
    { id: "footerModel", label: T("模型", "Model"), currentValue: footerModel ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
    { id: "footerVersion", label: T("版本号", "Version"), currentValue: footerVersion ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
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
    case "intention": {
      // 2026-09-13（用户）：Intention 工具输出隐藏/显示（默认隐藏）
      const on = value === T("显示", "Show");
      g.__genshinIntentionShow = on;
      save("intentionShow", on);
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
    case "executeSummary": {
      // 2026-09-13（用户定稿）：调用行摘要 显示/隐藏（隐藏=仅标题）
      const on = value === T("显示", "Show");
      g.__genshinExecuteSummary = on;
      save("executeSummary", on);
      break;
    }
    case "executeResult": {
      // 2026-09-13（用户定稿）：结果区 隐藏/摘要/全部
      const mode = value === T("隐藏", "Hide") ? "hide" : value === T("摘要", "Summary") ? "summary" : "full";
      g.__genshinExecuteResult = mode;
      save("executeResult", mode);
      break;
    }
    case "waitShow": {
      // 2026-09-13（用户）：Wait 输出 隐藏/显示（默认隐藏）
      const on = value === T("显示", "Show");
      g.__genshinWaitShow = on;
      save("waitShow", on);
      break;
    }
    case "toolElapsed": {
      // 2026-09-13（用户）：工具结果耗时戳 [0.009s] 默认隐藏
      const on = value === T("显示", "Show");
      g.__genshinToolElapsed = on;
      save("toolElapsed", on);
      break;
    }
    case "amemDisplay": {
      // 2026-09-13（用户）：Amem 输出 隐藏/折叠/显示（默认折叠）
      const mode = value === T("隐藏", "Hide") ? "hide" : value === T("显示", "Show") ? "show" : "fold";
      g.__genshinAmemDisplay = mode;
      save("amemDisplay", mode);
      break;
    }
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
    case "footerModel":
      g.__genshinFooterModel = value === T("显示", "Show");
      save("footerModel", g.__genshinFooterModel);
      break;
    case "footerVersion":
      g.__genshinFooterVersion = value === T("显示", "Show");
      save("footerVersion", g.__genshinFooterVersion);
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
  _ctx = ctx; // 供面板“功能入口”条目的 onActivate 使用（2026-09-13）
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
