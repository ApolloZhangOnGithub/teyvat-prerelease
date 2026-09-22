// memory-history-fetch-by-block.ts — 按 blocktrace id 取具体块（amem id summary/get 的实现，2026-09-23）
// 组件文件（主名=memory，组件名=history-fetch-by-block）——同 asr-bytedance.ts 命名。
// blockId 是 blocktrace（god.tui/ui_elements/blocktrace.ts）给 context.md 条目打的统一 id：
//   工具块（toolCall+toolResult 同 id）= tc-<toolCallId>；消息块 = bt-<seq>。
// 只读 context.md；历史数据（2026-09-23 之前）无 blockId，故取不到——不碰历史。

import { readFileSync, existsSync } from "node:fs";

export interface BlockHit {
  blockId: string;
  kind: string;
  tool?: string;
  length: number;
  opening: string;
  full: string;
}

/** 从 context.md 按 blockId 找块。同一 blockId 可能命中多条（工具往返 toolCall+toolResult 同 id）。 */
export function fetchBlockById(ctxPath: string, blockId: string): { hits: BlockHit[]; error?: string } {
  if (!existsSync(ctxPath)) return { hits: [], error: `context.md 不存在: ${ctxPath}` };
  const hits: BlockHit[] = [];
  for (const line of readFileSync(ctxPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: any;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.blockId !== blockId) continue;
    const kind = o.type === "toolCall" ? "toolCall"
      : (o.role === "toolResult" || o.role === "tool") ? "toolResult"
      : o.type === "think" ? "think"
      : o.role === "user" ? "user"
      : "assistant";
    const content = o.content || o.text || o.think || (o.tool ? JSON.stringify(o.tool) : "") || "";
    hits.push({
      blockId,
      kind,
      tool: o.tool?.name || o.toolName || undefined,
      length: content.length,
      opening: content.slice(0, 80),
      full: content,
    });
  }
  return { hits };
}

/** 摘要态（amem id 默认）：N 条记录 + 每条 kind/长度/开头 80 字符 + 提示用 get 取全文 */
export function formatBlockSummary(blockId: string, hits: BlockHit[]): string {
  if (!hits.length) {
    return `[blocktrace] 未找到块 ${blockId}。blockId 只覆盖 2026-09-23 起的新条目（历史数据未打 id），或该块已归档。`;
  }
  const lines = hits.map((h, i) => {
    const label = h.kind + (h.tool ? `:${h.tool}` : "");
    const op = h.opening.replace(/\n/g, " ");
    return `  ${i + 1}. [${label}] ${h.length} 字符 — ${op}${h.length > 80 ? "…" : ""}`;
  });
  return `[blocktrace] ${blockId}：${hits.length} 条记录\n${lines.join("\n")}\n\n要获得全文请使用 get。`;
}

/** 全文态（amem id get） */
export function formatBlockFull(blockId: string, hits: BlockHit[]): string {
  if (!hits.length) return `[blocktrace] 未找到块 ${blockId}。`;
  return hits.map((h) => `\n═══ ${h.kind}${h.tool ? `:${h.tool}` : ""} (${h.length} 字符) ═══\n${h.full}`).join("\n");
}
