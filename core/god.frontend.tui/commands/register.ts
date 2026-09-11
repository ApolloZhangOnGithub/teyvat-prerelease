// god.frontend.tui/commands/register.ts
// god 层自己注册所有用户命令。agent 内核不 import 这个文件。
// headless 模式下不加载此文件，agent 照常运行，只是没有 /xxx 命令。
// 文档: B.docs/Dev.Common/Wiki/Slash&Tools(Concept).WIKI

import { toolsHandler } from "./tools.ts";
import { authdirHandler, authdirCompletions } from "./authdir.ts";
import { quitHandler } from "./exit.ts";
import { detachHandler } from "./detach.ts";
import { pauseHandler } from "./pause.ts";
import { experimentalHandler } from "./devs.ts";
import { settingsHandler } from "./settings.ts";
import { i18n } from "#tui_localizations";

// ── 为什么用短名注册 ──────────────────────────────────────────────────────────
// pi 的 runner.js 在 resolveRegisteredCommands() 里做 `{...command, invocationName}`，
// 其中 invocationName 由 command.name 现算（只在重名时加 :n 后缀），展开在后 ——
// 所以注册时传的 invocationName 必被覆盖、永远不生效。interactive-mode.js 又拿这个
// 覆盖后的值当显示名和调用名。结论：**唯一能决定 /xxx 的就是 name 本身**。
// 故这里直接用短名当 name，长名放进 description 作提示（见 desc）。
//
// 短名已核对不与 pi 内置命令冲突（changelog/clone/copy/export/fork/hotkeys/import/
// login/logout/model/name/new/reload/resume/scoped-models/session/settings/share/
// tree/trust）—— 撞名的扩展命令会被 interactive-mode.js 直接过滤掉，不是报错而是消失。

// 长名列宽：取最长长名（changelog 类不算，只看我们自己的）+ 2 空格，保证描述列对齐。
const LABEL_W = 8;

function desc(long: string, zh: string, en: string) {
  const label = long.padEnd(LABEL_W);
  return i18n(`${label}${zh}`, `${label}${en}`);
}

export function registerGodCommands(pi: any) {
  pi.registerCommand("s", {
    description: desc("settings", "设置（身份/显示/服务/模型/推理/后台）", "Settings (identity/display/services/model/effort/bg)"),
    handler: settingsHandler,
  });
  pi.registerCommand("t", {
    description: desc("tools", "列出当前可用工具", "List available tools"),
    handler: toolsHandler(() => pi.getActiveTools() ?? [], (t) => pi.setActiveTools(t)),
  });
  pi.registerCommand("a", {
    description: desc("authdir", "白名单授权目录 + 工具持久授权", "Whitelist dirs + persistent tool auth"),
    messageDescription: i18n("白名单: /a <目录> [分钟] | /a all | /a root | /a remove <目录|all> | 工具授权: /a enable-<tool> 启用 | /a disable-<tool> 撤销（持久跨 session）", "Whitelist: /a <dir> [min] | /a all | /a remove <dir|all> | Tool auth: /a enable-<tool> | /a disable-<tool> (persistent)"),
    getArgumentCompletions: authdirCompletions,
    handler: (args: string, ctx: any) => authdirHandler(args, ctx, {
      getActive: () => pi.getActiveTools() ?? [],
      setActive: (t: string[]) => pi.setActiveTools(t),
    }),
  });
  pi.registerCommand("q", {
    description: desc("exit", "退出当前 Agent", "Quit current agent"),
    handler: quitHandler,
  });
  pi.registerCommand("h", {
    description: desc("hide", "隐藏显示但保持运行（转后台 headless，/h）", "Hide display, keep running (background, /h)"),
    handler: detachHandler,
  });
  pi.registerCommand("p", {
    description: desc("pause", "暂停/恢复当前 Agent", "Pause/resume agent"),
    handler: pauseHandler,
  });
  pi.registerCommand("d", {
    description: desc("devs", "实验性功能", "Experimental features"),
    handler: experimentalHandler,
  });
}
