// god.frontend.tui/commands/copy.ts
// /copy 命令 — 拷贝历史回复（2026-09-14 用户定稿：可选择拷贝某条回复，利用 tree/trajectory 性质）
// 经典坑警示：teyvat 禁用了 pi 原生命令（interactive-mode L2439），所有 /command 必须经
// register.ts 的 pi.registerCommand 注册才会执行；本文件 handler 经 __genshinHandleCopyCommand
// 桥到 interactive-mode 的 handleCopyCommand（打开 TreeSelector 选择器）。若 register.ts 漏注册，
// /copy 会被当普通用户消息发给 agent（命令静默失效）——见 register.ts 顶部注释。
import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

export async function copyHandler(_args: any, ctx: any) {
  const handle = (globalThis as any).__genshinHandleCopyCommand;
  if (typeof handle === "function") { handle(); return; }
  ctx.ui.notify(T("复制未就绪（TUI 未初始化）", "Copy not ready (TUI not initialized)"), "error");
}
