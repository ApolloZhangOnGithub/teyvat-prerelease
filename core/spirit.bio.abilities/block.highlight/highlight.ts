// highlight.ts — block.highlight 主程序（2026-09-23，blocktrace 的第一个应用）
// 模型调 Highlight 给某个块染色。块用 blocktrace id（bt-*/tc-*）定位。
// 实际染色调 TUI 钩子 globalThis.__genshinHighlightBlock（interactive-mode.js 挂载），工具只做校验 + 转发。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { registerPaimonTool, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { HIGHLIGHT_COLORS, isValidColor, colorList } from "./highlight-color.ts";
import { pinBlock, unpinBlock } from "./highlight-pin.ts";

export default function (pi: ExtensionAPI) {
  registerPaimonTool({
    name: "highlight",
    messageDescription:
      "给某个块（消息/工具调用/工具结果等）染成特别颜色，让它在 TUI 里醒目。块用 blocktrace 唯一 id（bt-*/tc-*）定位，或传内容子串兜底匹配。\n" +
      "  用法：Highlight({block, color?}) — 染色；Highlight({block, unpin:true}) — 取消高亮\n" +
      `  可用颜色：${colorList()}\n` +
      "  block 从哪来：execute 结果里的 recId、或 amem id 查到的 blockId（tc-*/bt-*）",
    promptSnippet: "Highlight({block, color?, pin?, unpin?}) — 给块染色（blocktrace id 或内容子串）",
    parameters: Type.Object({
      block: Type.String({ messageDescription: "blocktrace 块 id（bt-*/tc-*）或内容子串" }),
      color: Type.Optional(Type.String({ messageDescription: "颜色名（red/green/yellow/blue/magenta/cyan/orange/white）" })),
      pin: Type.Optional(Type.Boolean({ messageDescription: "固定高亮（跨滚动/重建不丢）" })),
      unpin: Type.Optional(Type.Boolean({ messageDescription: "取消高亮" })),
    }),
    execute: async (p: any, ctx: any) => {
      const hook = (globalThis as any).__genshinHighlightBlock;
      if (typeof hook !== "function") {
        return { content: [{ type: "text", text: "highlight 未就绪：TUI 尚未挂载 __genshinHighlightBlock 钩子（需重启加载 interactive-mode.js）。" }], details: {}, isError: true };
      }
      // 取消高亮
      if (p.unpin) {
        unpinBlock(p.block);
        hook(p.block, null, false);
        return { content: [{ type: "text", text: `已取消 ${p.block} 的高亮` }], details: { block: p.block, unpinned: true } };
      }
      // 校验颜色
      if (!p.color || !isValidColor(p.color)) {
        return { content: [{ type: "text", text: `颜色无效「${p.color ?? ""}」。可用：${colorList()}` }], details: {}, isError: true };
      }
      if (p.pin === true) pinBlock(p.block);
      const ok = hook(p.block, HIGHLIGHT_COLORS[p.color], p.pin === true);
      if (ok === false) {
        return { content: [{ type: "text", text: `未找到块 ${p.block}（可能该 id 不在当前 TUI 组件里，或历史块已滚出/重建）。` }], details: {}, isError: true };
      }
      return {
        content: [{ type: "text", text: `已给 ${p.block} 染成 ${p.color}${p.pin ? "（已 pin）" : ""}` }],
        details: { block: p.block, color: p.color, pinned: p.pin === true },
      };
    },
    renderCall(args: any, theme: any) {
      const label = args?.unpin ? "取消高亮" : `${args?.color || "?"} 染色`;
      return renderToolCall.label(theme, "Highlight", `${args?.block || "?"} ${label}`);
    },
    renderResult(result: any, _opts: any, theme: any, ctx: any) {
      return renderMessage.output(theme, ctx, resultContent(result));
    },
  });
}
