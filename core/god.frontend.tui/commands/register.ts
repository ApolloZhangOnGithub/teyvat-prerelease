// god.frontend.tui/commands/register.ts
// god 层自己注册所有用户命令。agent 内核不 import 这个文件。
// headless 模式下不加载此文件，agent 照常运行，只是没有 /xxx 命令。
// 文档: B.docs/Dev.Common/Wiki/Slash&Tools(Concept).WIKI

import { configHandler } from "./config.ts";
import { toolsHandler } from "./tools.ts";
import { authdirHandler, authdirCompletions } from "./authdir.ts";
import { quitHandler } from "./exit.ts";
import { detachHandler } from "./detach.ts";
import { pauseHandler } from "./pause.ts";
import { identityHandler } from "./infos.ts";
import { viewHandler } from "./ux.ts";
import { modelHandler } from "./model.ts";
import { effortHandler } from "./effort.ts";
import { experimentalHandler } from "./devs.ts";
import { bgHandler } from "./bg.ts";
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
  pi.registerCommand("c", {
    description: desc("config", "配置第三方服务 API", "Configure 3rd-party APIs"),
    handler: configHandler,
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
  pi.registerCommand("i", {
    description: desc("infos", "Agent 身份与上下文用量", "Agent identity & context usage"),
    handler: identityHandler,
  });
  pi.registerCommand("u", {
    description: desc("ux", "渲染方式管理", "Render View Management"),
    handler: viewHandler,
  });
  pi.registerCommand("m", {
    description: desc("model", "切换模型", "Switch model"),
    handler: modelHandler,
  });
  pi.registerCommand("e", {
    description: desc("effort", "推理强度", "Reasoning effort"),
    handler: effortHandler,
  });
  pi.registerCommand("d", {
    description: desc("devs", "实验性功能", "Experimental features"),
    handler: experimentalHandler,
  });
  pi.registerCommand("b", {
    description: desc("bg", "查看/终止后台任务", "View/kill background tasks"),
    messageDescription: i18n("/b 查看后台任务 | /b kill @N 终止", "/b list background tasks | /b kill @N"),
    handler: bgHandler,
  });
}
