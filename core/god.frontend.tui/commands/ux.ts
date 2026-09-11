import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

function save(key: string, value: any) {
  try {
    const sm = (globalThis as any).__genshinSettingsManager;
    if (sm) { sm.globalSettings[key] = value; sm.markModified(key); sm.save(); }
  } catch (e) { console.error("[god.frontend.tui/commands/ux.ts] " + ((e as any)?.message || e)); }
}

export async function viewHandler(_args: any, ctx: any) {
  // 用 SettingsList 组件实现左右键切值
  const showSettingsList = (globalThis as any).__genshinShowSettingsList;
  if (!showSettingsList) {
    ctx.ui.notify(T("设置列表未就绪", "Settings list not ready"), "error");
    return;
  }

  const getItems = () => {
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

    // Execute 调用模式决定 && 换行是否可见（仅标题模式下命令行都不显示，&& 换行无意义）
    const exeItems: any[] = [
      { id: "executeDisplay", label: T("Execute 调用", "Execute Call"), currentValue: executeDisplay === "title" ? T("仅标题", "Title") : executeDisplay === "command" ? T("仅命令", "Cmd") : T("标题+命令", "Title+Cmd"), values: [T("仅标题", "Title"), T("标题+命令", "Title+Cmd"), T("仅命令", "Cmd")] },
    ];
    if (executeDisplay !== "title") {
      exeItems.push({ id: "breakAnd", label: T("  && 换行", "  && Break"), currentValue: breakAnd ? T("拆分", "Split") : T("不拆", "Keep"), values: [T("不拆", "Keep"), T("拆分", "Split")] });
    }
    exeItems.push({ id: "compactExecute", label: T("Execute 结果", "Execute Result"), currentValue: compactExecute ? "Compact" : T("完整", "Full"), values: [T("完整", "Full"), "Compact"] });

    // Footer 履历：隐藏/显示/多彩 三态合一
    const footerTokensValue = !footerTokenmaxxed ? T("隐藏", "Hide") : tokenmaxxedColorful ? T("多彩", "Colorful") : T("显示", "Show");
    const footerTokensValues = [T("隐藏", "Hide"), T("显示", "Show"), T("多彩", "Colorful")];

    return [
      { id: "renderMode", label: T("渲染模式", "Render Mode"), currentValue: renderMode, values: ["line", "streaming", "block"] },
      { id: "thinking", label: "Thinking", currentValue: thinkHidden ? T("隐藏", "Hidden") : T("显示", "Show"), values: [T("显示", "Show"), T("隐藏", "Hidden")] },
      { id: "codeHighlight", label: T("代码高亮", "Code Highlight"), currentValue: codeHighlight ? T("开", "On") : T("关", "Off"), values: [T("关", "Off"), T("开", "On")] },
      { id: "toolExpanded", label: T("工具输出", "Tool Output"), currentValue: toolExpanded ? T("展开", "Expanded") : T("折叠", "Collapsed"), values: [T("折叠", "Collapsed"), T("展开", "Expanded")],
        description: T("展开=显示工具结果详情，折叠=只显示摘要行", "Expanded=show tool result details, Collapsed=summary only") },
      { id: "readExpanded", label: T("  Read 内容", "  Read Content"), currentValue: readExpanded ? T("展开", "Expanded") : T("折叠", "Collapsed"), values: [T("折叠", "Collapsed"), T("展开", "Expanded")] },
      ...exeItems,
      { id: "ctrlC", label: "Ctrl+C", currentValue: ctrlCToBg ? T("转后台", "To Bg") : T("停止", "Stop"), values: [T("转后台", "To Bg"), T("停止", "Stop")] },
      { id: "footerAge", label: T("Footer 年龄", "Footer Age"), currentValue: footerAge ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
      { id: "footerTokens", label: T("Footer 履历", "Footer Tokens"), currentValue: footerTokensValue, values: footerTokensValues },
      { id: "footerProvider", label: T("Footer 供应商", "Footer Provider"), currentValue: footerProvider ? T("显示", "Show") : T("隐藏", "Hide"), values: [T("隐藏", "Hide"), T("显示", "Show")] },
    ];
  };

  const onChange = (id: string, value: string) => {
    switch (id) {
      case "renderMode": {
        (globalThis as any).__piRenderMode = value;
        const handler = (globalThis as any).__genshinToggleRenderMode;
        if (handler) handler(value);
        break;
      }
      case "thinking": {
        const show = value === T("显示", "Show");
        const handler = (globalThis as any).__genshinToggleThinking;
        if (handler) handler(show);
        break;
      }
      case "codeHighlight": {
        const on = value === T("开", "On");
        (globalThis as any).__genshinCodeHighlight = on;
        save("codeHighlight", on);
        break;
      }
      case "toolExpanded": {
        const expanded = value === T("展开", "Expanded");
        const handler = (globalThis as any).__genshinToggleToolExpand;
        if (handler) handler(expanded);
        break;
      }
      case "readExpanded": {
        const expanded = value === T("展开", "Expanded");
        (globalThis as any).__genshinReadExpanded = expanded;
        save("readExpanded", expanded);
        break;
      }
      case "executeDisplay": {
        const mode = value === T("仅标题", "Title") ? "title" : value === T("仅命令", "Cmd") ? "command" : "full";
        (globalThis as any).__genshinExecuteDisplay = mode;
        save("executeDisplay", mode);
        break;
      }
      case "compactExecute": {
        const compact = value === "Compact";
        (globalThis as any).__genshinCompactExecute = compact;
        save("compactExecute", compact);
        break;
      }
      case "breakAnd": {
        const on = value === T("拆分", "Split");
        (globalThis as any).__genshinExecuteBreakAnd = on;
        save("executeBreakAnd", on);
        break;
      }
      case "ctrlC": {
        const toBg = value === T("转后台", "To Bg");
        (globalThis as any).__genshinCtrlCToBg = toBg;
        save("ctrlCToBg", toBg);
        break;
      }
      case "footerAge": {
        const show = value === T("显示", "Show");
        (globalThis as any).__genshinFooterAge = show;
        save("footerAge", show);
        break;
      }
      case "footerTokens": {
        // 三态：隐藏 / 显示 / 多彩
        const isHide = value === T("隐藏", "Hide");
        const isColorful = value === T("多彩", "Colorful");
        (globalThis as any).__genshinFooterTokenmaxxed = !isHide;
        (globalThis as any).__genshinTokenmaxxedColorful = isColorful;
        save("footerTokenmaxxed", !isHide);
        save("tokenmaxxedColorful", isColorful);
        break;
      }
      case "footerProvider": {
        const show = value === T("显示", "Show");
        (globalThis as any).__genshinFooterProvider = show;
        save("footerProvider", show);
        break;
      }
      case "colorfulRank": {
        const on = value === T("开", "On");
        (globalThis as any).__genshinTokenmaxxedColorful = on;
        save("tokenmaxxedColorful", on);
        break;
      }
    }
  };

  await showSettingsList(T("显示设置", "Display Settings"), getItems, onChange);
}
