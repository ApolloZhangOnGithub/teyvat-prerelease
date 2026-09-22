import { i18n } from "#tui_localizations";

export async function pauseHandler(args: any, ctx: any) {
  const handler = (globalThis as any).__genshinPauseHandler;
  if (!handler) { ctx.ui.notify(i18n("心跳未就绪", "heartbeat not ready"), "warning"); return; }
  await handler(args, ctx);
}
