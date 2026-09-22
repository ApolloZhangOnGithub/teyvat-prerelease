// god.tui/commands/login.ts
// /login、/logout —— 接回 pi 原生的 provider 认证菜单（2026-09-22 / ISSUE 262）。
// pi 的登录实现完好保留在 interactive-mode（handleLoginCommand / showOAuthSelector 等），
// 只是「内置命令分派块」被 teyvat 禁用后没人调 → 本文件注册命令，经 globalThis 桥回调实例方法。
// 若 register.ts 漏注册，/login 会被当普通用户消息发给 agent（命令静默失效）——见 ISSUE 252 / 262。
import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

/** /login [provider] —— 无参开「OAuth / API key」选择菜单；带参直接对该 provider 发起登录 */
export async function loginHandler(args: any, ctx: any) {
  const ref = typeof args === "string" ? args.trim() : (args?.args?.trim?.() ?? "");
  const handle = (globalThis as any).__genshinHandleLoginCommand;
  if (typeof handle === "function") { await handle(ref); return; }
  ctx.ui.notify(T("登录菜单未就绪（TUI 未初始化）", "Login menu not ready (TUI not initialized)"), "error");
}

/** /logout —— 列出 authStorage 里已存的凭证并移除（只清 authStorage；不动 env 与 models.json） */
export async function logoutHandler(_args: any, ctx: any) {
  const handle = (globalThis as any).__genshinHandleLogoutCommand;
  if (typeof handle === "function") { await handle(); return; }
  ctx.ui.notify(T("登出菜单未就绪（TUI 未初始化）", "Logout menu not ready (TUI not initialized)"), "error");
}
