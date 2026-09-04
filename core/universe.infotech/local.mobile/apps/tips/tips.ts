// apps/tips/tips.ts — tips tool (AI) — stub
import type { MobileApp } from "../../system.kernel/kernel.ts";

export async function tipsCmd(args: any, _ctx: any, _personDir: string): Promise<{ content: any[]; details: any }> {
  return { content: [{ type: "text", text: "tips 功能尚未实现" }], details: {} };
}

// ── MobileApp ──────────────────────────────────────────────────
export const app: MobileApp = {
  name: "tips",
  icon: "提示",
  messageDescription: "使用技巧",
  onOpen(_state, _personDir) {
    return {
      screen: "Tips\n\n功能开发中...",
      state: _state ?? {},
    };
  },
  onAction(_input, state, _personDir) {
    return { screen: "Tips\n\n功能开发中...", state };
  },
};
