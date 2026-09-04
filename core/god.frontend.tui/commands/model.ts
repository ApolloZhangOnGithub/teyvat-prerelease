// god.frontend.tui/commands/model.ts
// /m 命令 — 切换模型（2026-09-04 用户定稿：改走 pi 原生搜索式选择器，全量模型 + 搜索过滤 +
// 当前模型 ★ 置顶 + provider 徽标——替代旧 DS_MODELS 白名单静态菜单）。
// 旧白名单机制与两次误判历史见：B.docs/Dev.Common/Wiki/Model(Agent Config).WIKI
import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

export async function modelHandler(_args: any, ctx: any) {
  // 走 interactive-mode 的 pi 原生 ModelSelectorComponent（搜索式，全量 getAvailable + 当前模型 ★ 置顶）
  const handle = (globalThis as any).__genshinHandleModelCommand;
  if (typeof handle === "function") { handle(); return; }
  // fallback：桥未就绪（headless 等）——提示
  ctx.ui.notify(T("模型选择器未就绪（TUI 未初始化）", "Model selector not ready (TUI not initialized)"), "error");
}
