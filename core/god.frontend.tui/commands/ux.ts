import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

export async function viewHandler(_args: any, ctx: any) {
  while (true) {
    const renderMode = (globalThis as any).__piRenderMode || "line";  // 2026-09-06 默认 line-by-line（用户定稿）
    const thinkHidden = (globalThis as any).__genshinGetThinkingHidden?.() ?? false;
    const toolExpanded = (globalThis as any).__genshinGetToolExpanded?.() ?? false;
    const compactExecute = (globalThis as any).__genshinCompactExecute ?? false;
    const executeDisplay = (globalThis as any).__genshinExecuteDisplay ?? "full";
    const breakAnd = (globalThis as any).__genshinExecuteBreakAnd ?? false;
    const codeHighlight = (globalThis as any).__genshinCodeHighlight ?? false;
    const readExpanded = (globalThis as any).__genshinReadExpanded ?? false;
    const tokenmaxxedColorful = (globalThis as any).__genshinTokenmaxxedColorful ?? false;
    const ctrlCToBg = (globalThis as any).__genshinCtrlCToBg ?? true;  // 2026-08-20：Ctrl+C 默认转后台（headless）
    const footerAge = (globalThis as any).__genshinFooterAge ?? false;  // footer 年龄显示，2026-09-06 起默认隐藏（/u 开）
    const footerTokenmaxxed = (globalThis as any).__genshinFooterTokenmaxxed ?? false;  // footer tokenmaxxed 默认隐藏（/u 开）
    const footerProvider = (globalThis as any).__genshinFooterProvider ?? false;  // footer provider 默认隐藏（/u 开）
    const showPinDev = (globalThis as any).__genshinShowPinDev ?? false;  // alpha 版本号后显示 pin dev（2026-09-07 用户需求：默认隐藏，/u 开——bump 后 alpha 号从 .1 重开，看 pin 才能对应 dev）

    // pad CJK: 2-col per char, ASCII: 1-col. target 12 visual cols
    const pad = (s: string, w: number) => { let c = 0; for (const ch of s) c += ch.charCodeAt(0) > 127 ? 2 : 1; return s + " ".repeat(Math.max(1, w - c)); };
    const RM = (m: string) => m === "streaming" ? "streaming" : m === "block" ? "block" : "line";
    const menu = [
      pad(T("渲染模式", "Render Mode"), 12) + RM(renderMode),
      pad("Thinking", 12) + (thinkHidden ? T("隐藏", "Hidden") : T("显示", "Visible")),
      pad(T("Tool 输出", "Tool Output"), 12) + (toolExpanded ? T("展开", "Expanded") : T("折叠", "Collapsed")),
      pad("Execute", 12) + (compactExecute ? "Compact" : T("完整", "Full")),
      pad(T("Exe 显示", "Execute View"), 12) + (executeDisplay === "full" ? T("标题+命令", "Title+Command") : executeDisplay === "title" ? T("仅标题", "Title only") : T("仅命令", "Command only")),
      pad(T("&& 换行", "&& Break"), 12) + (breakAnd ? T("拆分", "Split") : T("不拆", "Keep")),
      pad(T("代码高亮", "Code Highlight"), 12) + (codeHighlight ? T("开", "On") : T("关", "Off")),
      pad(T("Read 内容", "Read Content"), 12) + (readExpanded ? T("展开", "Expanded") : T("折叠", "Collapsed")),
      pad(T("履历多彩", "Colorful Rank"), 12) + (tokenmaxxedColorful ? T("开", "On") : T("关", "Off")),
      pad("Ctrl+C", 12) + (ctrlCToBg ? T("转后台", "To Bg") : T("停止", "Stop")),
      pad(T("Footer 年龄", "Footer Age"), 12) + (footerAge ? T("显示", "Show") : T("隐藏", "Hide")),
      pad(T("Footer 履历", "Footer Tokens"), 12) + (footerTokenmaxxed ? T("显示", "Show") : T("隐藏", "Hide")),
      pad(T("Footer 供应商", "Footer Provider"), 12) + (footerProvider ? T("显示", "Show") : T("隐藏", "Hide")),
      pad(T("Pin dev 显示", "Pin Dev"), 12) + (showPinDev ? T("显示", "Show") : T("隐藏", "Hide")),
    ];
    const pick = await ctx.ui.select(T("显示设置", "Display Settings"), menu);
    if (!pick) break;

    if (pick.startsWith(T("渲染模式", "Render Mode"))) {
      const options = [
        `streaming  ${renderMode === "streaming" ? "●" : "○"}  ${T("逐 token 渲染", "per-token render")}`,
        `line       ${renderMode === "line" ? "●" : "○"}  ${T("逐行渲染（默认）", "per-line render (default)")}`,
        `block      ${renderMode === "block" ? "●" : "○"}  ${T("逐块渲染（整段完成后显示）", "per-block render (show after block completes)")}`,
      ];
      const choice = await ctx.ui.select(T("渲染模式", "Render Mode"), options);
      if (!choice) continue;
      const mode = choice.startsWith("streaming") ? "streaming" : choice.startsWith("block") ? "block" : "line";
      (globalThis as any).__piRenderMode = mode;
      const handler = (globalThis as any).__genshinToggleRenderMode;
      if (handler) handler(mode);
    } else if (pick.startsWith("Thinking")) {
      const options = [
        `${T("显示", "Show")}  ${!thinkHidden ? "●" : "○"}  ${T("展示 thinking 块", "show thinking block")}`,
        `${T("隐藏", "Hide")}  ${thinkHidden ? "●" : "○"}  ${T("折叠 thinking 块", "collapse thinking block")}`,
      ];
      const choice = await ctx.ui.select(T("Thinking 显示", "Thinking Display"), options);
      if (!choice) continue;
      const show = choice.startsWith(T("显示", "Show"));
      const handler = (globalThis as any).__genshinToggleThinking;
      if (handler) handler(show);
    } else if (pick.startsWith(T("Tool 输出", "Tool Output"))) {
      const handler = (globalThis as any).__genshinToggleToolExpand;
      if (handler) handler(!toolExpanded);
    } else if (pick.startsWith(T("Exe 显示", "Execute View"))) {
      const options = [
        `${T("仅标题", "Title only")}     ${executeDisplay === "title" ? "●" : "○"}  ${T("只显示第一行 • Execute <标题>（默认）", "show first line • Execute <title> (default)")}`,
        `${T("标题+命令", "Title+Command")}  ${executeDisplay === "full" ? "●" : "○"}  ${T("第一行标题 + 下方命令详情区", "title line + command detail below")}`,
        `${T("仅命令", "Command only")}     ${executeDisplay === "command" ? "●" : "○"}  ${T("只显示命令（老形态，无标题）", "show command only (legacy, no title)")}`,
      ];
      const choice = await ctx.ui.select(T("Execute 显示", "Execute View"), options);
      if (!choice) continue;
      (globalThis as any).__genshinExecuteDisplay = choice.startsWith(T("仅标题", "Title only")) ? "title" : choice.startsWith(T("仅命令", "Command only")) ? "command" : "full";
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.executeDisplay = (globalThis as any).__genshinExecuteDisplay; sm.markModified("executeDisplay"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith("Execute")) {
      (globalThis as any).__genshinCompactExecute = !compactExecute;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.compactExecute = (globalThis as any).__genshinCompactExecute; sm.markModified("compactExecute"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith("&&")) {
      (globalThis as any).__genshinExecuteBreakAnd = !breakAnd;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.executeBreakAnd = (globalThis as any).__genshinExecuteBreakAnd; sm.markModified("executeBreakAnd"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith(T("代码高亮", "Code Highlight"))) {
      (globalThis as any).__genshinCodeHighlight = !codeHighlight;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.codeHighlight = (globalThis as any).__genshinCodeHighlight; sm.markModified("codeHighlight"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith("Read")) {
      (globalThis as any).__genshinReadExpanded = !readExpanded;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.readExpanded = (globalThis as any).__genshinReadExpanded; sm.markModified("readExpanded"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith(T("履历多彩", "Colorful Rank"))) {
      (globalThis as any).__genshinTokenmaxxedColorful = !tokenmaxxedColorful;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.tokenmaxxedColorful = (globalThis as any).__genshinTokenmaxxedColorful; sm.markModified("tokenmaxxedColorful"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith("Ctrl+C")) {
      (globalThis as any).__genshinCtrlCToBg = !ctrlCToBg;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.ctrlCToBg = (globalThis as any).__genshinCtrlCToBg; sm.markModified("ctrlCToBg"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith(T("Footer 年龄", "Footer Age"))) {
      // 2026-09-04 用户需求：footer 年龄（2.8w）显示开关
      (globalThis as any).__genshinFooterAge = !footerAge;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.footerAge = (globalThis as any).__genshinFooterAge; sm.markModified("footerAge"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith(T("Footer 履历", "Footer Tokens"))) {
      // 2026-09-04 用户需求：footer tokenmaxxed 显示开关
      (globalThis as any).__genshinFooterTokenmaxxed = !footerTokenmaxxed;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.footerTokenmaxxed = (globalThis as any).__genshinFooterTokenmaxxed; sm.markModified("footerTokenmaxxed"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith(T("Footer 供应商", "Footer Provider"))) {
      // 2026-09-04 用户需求：footer 模型名左侧具体 provider 显示开关（openrouter 显示路由 provider，如 AWS/Azure）
      (globalThis as any).__genshinFooterProvider = !footerProvider;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.footerProvider = (globalThis as any).__genshinFooterProvider; sm.markModified("footerProvider"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    } else if (pick.startsWith(T("Pin dev", "Pin Dev"))) {
      // 2026-09-07 用户需求：alpha 版本号后的 pin dev 显示开关（默认隐藏——bump 后 alpha 号从 .1 重开历史不连续，看 pin 才能对应 dev）
      (globalThis as any).__genshinShowPinDev = !showPinDev;
      try {
        const sm = (globalThis as any).__genshinSettingsManager;
        if (sm) { sm.globalSettings.showPinDev = (globalThis as any).__genshinShowPinDev; sm.markModified("showPinDev"); sm.save(); }
      } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
    }
  }
}
