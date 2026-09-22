// god.tui/commands/register.ts
// god 层自己注册所有用户命令。agent 内核不 import 这个文件。
// headless 模式下不加载此文件，agent 照常运行，只是没有 /xxx 命令。
// 文档: B.docs/Dev.Common/Wiki/Slash&Tools(Concept).WIKI

import { toolsHandler } from "./tools.ts";
import { authdirHandler, authdirCompletions } from "./authdir.ts";
import { quitHandler } from "./exit.ts";
import { detachHandler } from "./detach.ts";
import { pauseHandler } from "./pause.ts";
import { settingsHandler, setToolsHandler } from "./settings.ts";
import { copyHandler } from "./copy.ts";
import { modelHandler } from "./model.ts";
import { loginHandler, logoutHandler } from "./login.ts";
import { configHandler } from "./config.ts";
import { i18n } from "#tui_localizations";

// ── 为什么用短名注册 ──────────────────────────────────────────────────────────
// pi 的 runner.js 在 resolveRegisteredCommands() 里做 `{...command, invocationName}`，
// 其中 invocationName 由 command.name 现算（只在重名时加 :n 后缀），展开在后 ——
// 所以注册时传的 invocationName 必被覆盖、永远不生效。interactive-mode.js 又拿这个
// 覆盖后的值当显示名和调用名。结论：**唯一能决定 /xxx 的就是 name 本身**。
// 故这里直接用短名当 name，长名放进 description 作提示（见 desc）。
//
// 短名策略（2026-09-22 / ISSUE 262 重写）：teyvat 用自己的短名（s/a/q/h/p/m…）。
// **扩展命令与 pi 内置名撞名会被静默过滤**（autocomplete 剔除 + 不可达，不是报错而是消失——见 ISSUE 252 /copy 事故）。
// 所以想复用某个内置名，必须把它从 `overrides/pi-dist/core/slash-commands.js` 的 BUILTIN_SLASH_COMMANDS 里删掉，
// 并过 `check-command-conflict.cjs` 门禁。已复用的内置名：**copy**（2026-09-14）、**login / logout**（2026-09-22）。
// 其余内置名（changelog/clone/export/fork/hotkeys/import/model/name/new/reload/resume/scoped-models/
// session/settings/share/tree/trust）在 teyvat 全部不可达——teyvat 禁用了 pi 的内置命令分派（interactive-mode :2468）。

// 长名列宽：取最长长名（changelog 类不算，只看我们自己的）+ 2 空格，保证描述列对齐。
const LABEL_W = 10;

function desc(long: string, zh: string, en: string) {
  const label = long.padEnd(LABEL_W);
  return i18n(`${label}${zh}`, `${label}${en}`);
}

export function registerGodCommands(pi: any) {
  // tools handler 需要 pi 实例——注入到 settings.ts 供 /s 的 Tools 标签页使用
  const th = toolsHandler(() => pi.getActiveTools() ?? [], (t: string[]) => pi.setActiveTools(t));
  setToolsHandler(th);

  pi.registerCommand("s", {
    description: desc("settings", "设置面板（身份/显示/服务/模型/工具/推理/后台/实验）", "Settings panel"),
    getArgumentCompletions: (prefix: string) => {
      const tabs = ["identity", "services", "model", "tools", "bg"]; // 2026-09-13：只列有 handler 的子命令（display/effort/experimental 没有对应入口，只会开通用面板）
      return tabs.filter(t => t.startsWith(prefix.toLowerCase())).map(t => ({ label: t, value: t }));
    },
    handler: settingsHandler,
  });
  pi.registerCommand("a", {
    description: desc("authdir", "白名单授权目录 + 工具持久授权", "Whitelist dirs + persistent tool auth"),
    messageDescription: i18n("白名单: /a <目录> [分钟] | /a all | /a root | /a remove <目录|all> | /a max-upload-size <MB>（单文件上传上限，默认 1、硬顶 30）| 工具授权: /a enable-<tool> 启用 | /a disable-<tool> 撤销（持久跨 session）", "Whitelist: /a <dir> [min] | /a all | /a remove <dir|all> | /a max-upload-size <MB> (max upload size, default 1, cap 30) | Tool auth: /a enable-<tool> | /a disable-<tool> (persistent)"),
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
    description: desc("hide", "转后台 headless 运行", "Move to background (headless)"),
    handler: detachHandler,
  });
  pi.registerCommand("p", {
    description: desc("pause", "暂停/恢复当前 Agent", "Pause/resume agent"),
    handler: pauseHandler,
  });
  // 2026-09-14：/copy 与 /m 必须显式注册——teyvat 禁用 pi 原生命令（interactive-mode L2439），
  // 未注册的命令会被 onSubmit 当普通用户消息发给 agent（命令静默失效，经典坑）。
  // 勿删这两行注册：删除后 /copy、/m 静默失效（不报错、只是不执行）。
  pi.registerCommand("copy", {
    description: desc("copy", "拷贝历史回复（树选择器）", "Copy a reply from history (tree selector)"),
    handler: copyHandler,
  });
  pi.registerCommand("m", {
    description: desc("model", "切换模型（搜索式选择器）", "Switch model (search selector)"),
    handler: modelHandler,
  });
  // 2026-09-22（ISSUE 262）：①/login /logout 接回 pi 原生认证菜单——桥到 interactive-mode 的
  // handleLoginCommand / showOAuthSelector("logout")（上游实现一直都在，只是分派块被禁后没人调）
  // ②/c 补注册——它一直是「文档定稿的凭证入口」却漏注册，敲 /c 会被当普通消息发给 agent（静默失效）。
  pi.registerCommand("login", {
    description: desc("login", "Provider 认证（OAuth / API key 菜单）", "Provider auth (OAuth / API key)"),
    messageDescription: i18n("用法: /login 打开菜单 | /login <provider> 直接登录", "Usage: /login opens the menu | /login <provider> to sign in"),
    handler: loginHandler,
  });
  pi.registerCommand("logout", {
    description: desc("logout", "移除已存凭证（authStorage）", "Remove stored credentials (authStorage)"),
    handler: logoutHandler,
  });
  pi.registerCommand("c", {
    description: desc("config", "服务与凭证（凭证入口）", "Services & credentials"),
    handler: configHandler,
  });
  // 2026-09-14：注册 trace——/copy 失效排查用，确认本函数真的执行+copy真的注册进 runner
  try { console.error(`[cmd-reg] registerGodCommands done: s,a,q,h,p,copy,m,login,logout,c (pi=${typeof pi?.registerCommand})`); } catch (e) { console.error("[god.tui/commands/register.ts] " + ((e as any)?.message || e)); }
}
