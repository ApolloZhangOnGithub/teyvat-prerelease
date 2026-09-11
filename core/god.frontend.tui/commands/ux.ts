import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

function save(key: string, value: any) {
  try {
    const sm = (globalThis as any).__genshinSettingsManager;
    if (sm) { sm.globalSettings[key] = value; sm.markModified(key); sm.save(); }
  } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
}

export async function viewHandler(_args: any, ctx: any) {
  while (true) {
    const renderMode = (globalThis as any).__piRenderMode || "line";
    const thinkHidden = (globalThis as any).__genshinGetThinkingHidden?.() ?? false;
    const toolExpanded = (globalThis as any).__genshinGetToolExpanded?.() ?? false;
    const readExpanded = (globalThis as any).__genshinReadExpanded ?? false;
    const codeHighlight = (globalThis as any).__genshinCodeHighlight ?? false;
    const executeDisplay = (globalThis as any).__genshinExecuteDisplay ?? "full";
    const compactExecute = (globalThis as any).__genshinCompactExecute ?? false;
    const breakAnd = (globalThis as any).__genshinExecuteBreakAnd ?? false;
    const ctrlCToBg = (globalThis as any).__genshinCtrlCToBg ?? true;
    const tokenmaxxedColorful = (globalThis as any).__genshinTokenmaxxedColorful ?? false;
    const footerAge = (globalThis as any).__genshinFooterAge ?? false;
    const footerTokenmaxxed = (globalThis as any).__genshinFooterTokenmaxxed ?? false;
    const footerProvider = (globalThis as any).__genshinFooterProvider ?? false;
    const showPinDev = (globalThis as any).__genshinShowPinDev ?? false;

    const D = "\x1b[90m"; const R = "\x1b[0m"; const B = "\x1b[1m";
    const pad = (s: string, w: number) => { let c = 0; for (const ch of s) c += ch.charCodeAt(0) > 127 ? 2 : 1; return s + " ".repeat(Math.max(1, w - c)); };
    const W = 16;

    const rmLabel = renderMode === "streaming" ? "streaming" : renderMode === "block" ? "block" : "line";
    const exLabel = executeDisplay === "title" ? T("仅标题", "title") : executeDisplay === "command" ? T("仅命令", "cmd") : T("标题+命令", "title+cmd");
    const exCompact = compactExecute ? " compact" : "";

    const menu = [
      `${D}── ${T("渲染", "Render")} ──${R}`,
      pad(T("  渲染模式", "  Render Mode"), W) + rmLabel,
      pad("  Thinking", W) + (thinkHidden ? T("隐藏", "Hidden") : T("显示", "Show")),
      pad(T("  代码高亮", "  Code Highlight"), W) + (codeHighlight ? T("开", "On") : T("关", "Off")),
      `${D}── ${T("工具输出", "Tool Output")} ──${R}`,
      pad(T("  Tool 展开", "  Tool Expand"), W) + (toolExpanded ? T("展开", "Expanded") : T("折叠", "Collapsed")),
      pad(T("  Read 内容", "  Read Content"), W) + (readExpanded ? T("展开", "Expanded") : T("折叠", "Collapsed")),
      pad(T("  Execute 调用", "  Execute Call"), W) + exLabel + exCompact,
      pad(T("  && 换行", "  && Break"), W) + (breakAnd ? T("拆分", "Split") : T("不拆", "Keep")),
      `${D}── ${T("Footer", "Footer")} ──${R}`,
      pad(T("  年龄", "  Age"), W) + (footerAge ? T("显示", "Show") : T("隐藏", "Hide")),
      pad(T("  履历", "  Tokens"), W) + (footerTokenmaxxed ? T("显示", "Show") : T("隐藏", "Hide")),
      pad(T("  供应商", "  Provider"), W) + (footerProvider ? T("显示", "Show") : T("隐藏", "Hide")),
      pad(T("  Pin dev", "  Pin dev"), W) + (showPinDev ? T("显示", "Show") : T("隐藏", "Hide")),
      pad(T("  履历多彩", "  Colorful Rank"), W) + (tokenmaxxedColorful ? T("开", "On") : T("关", "Off")),
      `${D}── ${T("行为", "Behavior")} ──${R}`,
      pad("  Ctrl+C", W) + (ctrlCToBg ? T("转后台", "To Bg") : T("停止", "Stop")),
    ];

    const pick = await ctx.ui.select(T("显示设置", "Display Settings"), menu);
    if (!pick) break;
    const trimmed = pick.replace(/^\s+/, "");

    // 分隔行不可选
    if (trimmed.startsWith("──")) continue;

    if (trimmed.startsWith(T("渲染模式", "Render Mode"))) {
      const options = [
        `streaming  ${renderMode === "streaming" ? "●" : "○"}  ${T("逐 token", "per-token")}`,
        `line       ${renderMode === "line" ? "●" : "○"}  ${T("逐行（默认）", "per-line (default)")}`,
        `block      ${renderMode === "block" ? "●" : "○"}  ${T("逐块（整段完成后）", "per-block")}`,
      ];
      const choice = await ctx.ui.select(T("渲染模式", "Render Mode"), options);
      if (!choice) continue;
      const mode = choice.startsWith("streaming") ? "streaming" : choice.startsWith("block") ? "block" : "line";
      (globalThis as any).__piRenderMode = mode;
      const handler = (globalThis as any).__genshinToggleRenderMode;
      if (handler) handler(mode);
    } else if (trimmed.startsWith("Thinking")) {
      const handler = (globalThis as any).__genshinToggleThinking;
      if (handler) handler(thinkHidden);
    } else if (trimmed.startsWith(T("代码高亮", "Code Highlight"))) {
      (globalThis as any).__genshinCodeHighlight = !codeHighlight;
      save("codeHighlight", !codeHighlight);
    } else if (trimmed.startsWith(T("Tool 展开", "Tool Expand"))) {
      const handler = (globalThis as any).__genshinToggleToolExpand;
      if (handler) handler(!toolExpanded);
    } else if (trimmed.startsWith(T("Read 内容", "Read Content"))) {
      (globalThis as any).__genshinReadExpanded = !readExpanded;
      save("readExpanded", !readExpanded);
    } else if (trimmed.startsWith(T("Execute 调用", "Execute Call"))) {
      // 合并子菜单：调用行格式 + compact + && 换行
      const options = [
        `${T("仅标题", "Title only")}      ${executeDisplay === "title" ? "●" : "○"}`,
        `${T("标题+命令", "Title+Command")}  ${executeDisplay === "full" ? "●" : "○"}`,
        `${T("仅命令", "Command only")}     ${executeDisplay === "command" ? "●" : "○"}`,
        `${T("结果折叠", "Compact result")}  ${compactExecute ? "●" : "○"}  ${T("（长输出只显示首行）", "(long output: first line only)")}`,
      ];
      const choice = await ctx.ui.select(T("Execute 显示", "Execute View"), options);
      if (!choice) continue;
      if (choice.startsWith(T("结果折叠", "Compact result"))) {
        (globalThis as any).__genshinCompactExecute = !compactExecute;
        save("compactExecute", !compactExecute);
      } else {
        const mode = choice.startsWith(T("仅标题", "Title only")) ? "title" : choice.startsWith(T("仅命令", "Command only")) ? "command" : "full";
        (globalThis as any).__genshinExecuteDisplay = mode;
        save("executeDisplay", mode);
      }
    } else if (trimmed.startsWith("&&")) {
      (globalThis as any).__genshinExecuteBreakAnd = !breakAnd;
      save("executeBreakAnd", !breakAnd);
    } else if (trimmed.startsWith(T("年龄", "Age"))) {
      (globalThis as any).__genshinFooterAge = !footerAge;
      save("footerAge", !footerAge);
    } else if (trimmed.startsWith(T("履历多彩", "Colorful Rank"))) {
      (globalThis as any).__genshinTokenmaxxedColorful = !tokenmaxxedColorful;
      save("tokenmaxxedColorful", !tokenmaxxedColorful);
    } else if (trimmed.startsWith(T("履历", "Tokens"))) {
      (globalThis as any).__genshinFooterTokenmaxxed = !footerTokenmaxxed;
      save("footerTokenmaxxed", !footerTokenmaxxed);
    } else if (trimmed.startsWith(T("供应商", "Provider"))) {
      (globalThis as any).__genshinFooterProvider = !footerProvider;
      save("footerProvider", !footerProvider);
    } else if (trimmed.startsWith("Pin dev")) {
      (globalThis as any).__genshinShowPinDev = !showPinDev;
      save("showPinDev", !showPinDev);
    } else if (trimmed.startsWith("Ctrl+C")) {
      (globalThis as any).__genshinCtrlCToBg = !ctrlCToBg;
      save("ctrlCToBg", !ctrlCToBg);
    }
  }
}
