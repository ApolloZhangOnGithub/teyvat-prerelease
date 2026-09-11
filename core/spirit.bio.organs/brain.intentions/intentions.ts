// brain.intentions — 前瞻性记忆（意图栈）
// agent 用 edit 接口自由编辑纯文本计划。agent_end 时检查：非空→续命，空→提示停下。
// 持久化到 MemoryData/{id}/intentions.txt，重启不丢失。
// 文档: B.docs/Dev.Common/Wiki/Intentions(Agent's Tool).WIKI
// 规范: B.docs/Dev.Common/Norms/Top-Level/008-intentions-tool-render.NORM
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { registerPaimonTool } from "#kernel_backbone";
import { renderToolCall, renderMessage, GUTTER, dot, lineNumbered } from "#tui_blockrender";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const MAX_INTENTIONS_LEN = 3000;
let _buffer = "";
let _filePath: string | null = null;

function saveIntentions(): void {
  if (!_filePath) return;
  try {
    mkdirSync(dirname(_filePath), { recursive: true });
    writeFileSync(_filePath, _buffer, "utf-8");
  } catch (e) { console.error("[spirit.bio.organs/brain.intentions/intentions.ts] " + ((e as any)?.message || e)); }
}

function loadIntentions(): void {
  if (!_filePath) return;
  try {
    if (existsSync(_filePath)) {
      _buffer = readFileSync(_filePath, "utf-8").trim().slice(0, MAX_INTENTIONS_LEN);
    }
  } catch (e) { console.error("[spirit.bio.organs/brain.intentions/intentions.ts] " + ((e as any)?.message || e)); }
}

export function getIntentions(): string { return _buffer; }
export function clearIntentions(): void { _buffer = ""; saveIntentions(); }

export interface IntentionItem { num: number; text: string; status: "pending" | "done" | ""; }
export function getIntentionItems(): IntentionItem[] {
  const lines = _buffer.split("\n").filter(l => l.trim());
  return lines.map((line, i) => {
    const trimmed = line.trim();
    const done = /^[✓✅☑]\s/.test(trimmed);
    const pending = /^\d+[.)]\s/.test(trimmed);
    return {
      num: i + 1,
      text: trimmed,
      status: done ? "done" : (pending ? "pending" : ""),
    };
  });
}

function lineCount(): number {
  return _buffer.split("\n").filter(l => l.trim()).length;
}

function intentionWord(n: number): string {
  return n === 1 ? "1 intention" : `${n} intentions`;
}

export default function (_pi: ExtensionAPI) {
  // 持久化路径：从 agent 的 MemoryData 目录读写 intentions
  _pi.on("session_start", async (_event, ctx) => {
    try {
      const sf = (ctx as any).sessionManager?.getSessionFile?.();
      if (sf) {
        const m = sf.match(/([a-f0-9]{8})\//);
        if (m) {
          _filePath = join(homedir(), ".teyvat", "MemoryData", m[1], "intentions.txt");
          loadIntentions();
        }
      }
    } catch (e) { console.error("[spirit.bio.organs/brain.intentions/intentions.ts] " + ((e as any)?.message || e)); }
  });

  registerPaimonTool({
    name: "intentions",
    label: "Intentions",
    messageDescription:
      "Read or edit your intentions — what you plan to do next.\n" +
      "- No params → read current intentions\n" +
      "- new_string only → write (overwrite all, default force)\n" +
      "- old_string + new_string → edit (find and replace)\n" +
      "Use this to plan ahead. Non-empty intentions = you keep working. Empty = system asks you to plan or stop.",
    promptSnippet: "intentions() to read, intentions({new_string:'plan'}) to write (overwrites), intentions({old_string:'...', new_string:'...'}) to edit",
    parameters: Type.Object({
      old_string: Type.Optional(Type.String({ messageDescription: "Text to find (omit to replace all or read)" })),
      new_string: Type.Optional(Type.String({ messageDescription: "Replacement text (omit old_string to replace entire content)" })),
      force: Type.Optional(Type.Boolean({ messageDescription: "Force overwrite non-empty stack (skip error)" })),
    }),
    renderCall(args: any, theme: any) {
      // renderCall 只渲染标题行（dot + Intention），不渲染 ⎿ 结果——那是 renderResult 的职责
      return renderToolCall.label(theme, "Intention");
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const content = result?.details?._content || result?.content || [];
      let text = content?.[0]?.text || "";
      // 2026-08-18 用户定稿：剥离 feed 层 append 的 [result N tokens, ctx X.Xk]（backbone.ts 拼进 content
      // 给模型感知结果大小与 context 总量，渲染层不需要显示——不剥会漏在兜底渲染里，还会污染 edit/write 的 diff 与行数）
      text = text.replace(/\n*\[result\s+[\d.]+[kM]?\s*tokens?(?:,\s*(?:ctx|contexted)\s+[\d.]+[kM]?)?\]\s*$/, "");
      // 编辑器风格渲染（与 pi 内置 Edit 一致，NORM 008）：unified diff → renderDiff
      const { renderDiff } = require("@earendil-works/pi-coding-agent/dist/modes/interactive/components/diff.js");
      const { generateDiffString } = require("@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js");

      if (result?.details?.action === "read") {
        if (!text || text === "(empty)") return renderMessage.silent();
        const { Text: Txt, Container: CC } = require("@earendil-works/pi-tui");
        const cc = new CC();
        const lineCount = text.split("\n").filter((l: string) => l.trim()).length;
        const indent = " ".repeat(GUTTER);
        cc.addChild(new Txt(indent + theme.fg("dim", "⎿  ") + `${lineCount} lines`, 0, 0));
        const rendered = lineNumbered(text, theme);
        const contIndent = " ".repeat(GUTTER + 3);
        for (const line of rendered.split("\n")) cc.addChild(new Txt(contIndent + line, 0, 0));
        return cc;
      }
      if ((ctx?.isError || result?.isError) && text) {
        return renderMessage.summary(theme, { isError: true }, text);
      }
      // 空栈：不显示冗余的 (cleared)/(empty) 结果行
      // （含 "(cleared) xxx" 这种清空态却带残留文本的，一律静默，避免向用户回显全文）
      if (text === "(cleared)" || text === "(empty)" || text.startsWith("(cleared)") || text.startsWith("(empty)")) {
        return renderMessage.silent();
      }
      if (text && result?.details?.action === "edit") {
        const oldStr = (result?.details?._old || "");
        const newStr = (result?.details?._new || "");
        const oldLines = oldStr.split("\n").filter((l: string) => l.trim()).length;
        const newLines = newStr.split("\n").filter((l: string) => l.trim()).length;
        let added = newStr && !oldStr ? newLines : 0;
        let removed = oldStr && !newStr ? oldLines : 0;
        if (!added && !removed) { removed = oldLines; added = newLines; }
        // 摘要 + 编辑器风格 diff（行号/红绿/词级高亮，同 pi Edit）
        const num = (n: number) => theme.bold(theme.fg("text", String(n)));
        const summary = `Removed ${num(removed)} intention${removed !== 1 ? "s" : ""}, added ${num(added)} intention${added !== 1 ? "s" : ""}`;
        const diff = renderDiff(generateDiffString(oldStr, newStr).diff);
        return renderMessage.output(theme, ctx, [{ type: "text", text: summary + "\n" + diff }]);
      }
      // write（formed / rewritten）— 摘要 + 全新增 diff
      if (text && result?.details?.action === "write") {
        const newLines = text.split("\n").filter((l: string) => l.trim()).length;
        const verb = (result?.details as any)?._force ? "Rewrote" : "Formed";
        const num = (n: number) => theme.bold(theme.fg("text", String(n)));
        const summary = `${verb} ${num(newLines)} intention${newLines !== 1 ? "s" : ""}`;
        const diff = renderDiff(generateDiffString("", text).diff);
        return renderMessage.output(theme, ctx, [{ type: "text", text: summary + "\n" + diff }]);
      }
      if (text) {
        return renderMessage.output(theme, ctx, [{ type: "text", text }]);
      }
      return renderMessage.silent();
    },
    async execute(_id, rawParams, _signal, _onUpdate, _ctx) {
      const params = rawParams as { old_string?: string; new_string?: string; force?: boolean };

      // read
      if (params.old_string === undefined && params.new_string === undefined) {
        const items = getIntentionItems();
        const pending = items.filter(i => i.status === "pending").length;
        const done = items.filter(i => i.status === "done").length;
        const summary = items.length > 0
          ? `[${pending} pending, ${done} done]\n${_buffer}`
          : "(empty)";
        return { content: [{ type: "text", text: summary }], details: { action: "read", pending, done } };
      }

      // write (replace all) — 默认强制覆盖（用户要求机制：不提示非空）
      // 原非空检查（已注释保留，2026-08-12 用户要求默认 force）：
      //   if (_buffer.trim() && !params.force) {
      //     return { content: [{ type: "text", text: `意图栈非空（${intentionWord(lineCount())}）。用 intentions({force:true, new_string:'...'}) 强制覆盖。\n\n当前内容:\n${_buffer}` }], isError: true };
      //   }
      if (params.old_string === undefined && params.new_string !== undefined) {
        _buffer = params.new_string.slice(0, MAX_INTENTIONS_LEN);
        saveIntentions();
        const truncated = params.new_string.length > MAX_INTENTIONS_LEN ? ` (截断, 原${params.new_string.length}字符)` : "";
        return { content: [{ type: "text", text: (_buffer || "(cleared)") + truncated }], details: { action: "write", _force: params.force === true } };
      }

      // edit (find & replace)
      if (params.old_string !== undefined && params.new_string !== undefined) {
        if (params.old_string && !_buffer.includes(params.old_string)) {
          return { content: [{ type: "text", text: `old_string not found in intentions.\nCurrent:\n${_buffer || "(empty)"}` }], isError: true };
        }
        if (params.old_string === "") {
          _buffer = _buffer + ((_buffer && params.new_string) ? "\n" : "") + params.new_string;
        } else {
          _buffer = _buffer.replace(params.old_string, params.new_string);
        }
        if (_buffer.length > MAX_INTENTIONS_LEN) _buffer = _buffer.slice(0, MAX_INTENTIONS_LEN);
        _buffer = _buffer.trim();
        saveIntentions();
        return { content: [{ type: "text", text: _buffer || "(cleared)" }], details: { action: "edit", _old: params.old_string, _new: params.new_string } };
      }

      return { content: [{ type: "text", text: _buffer || "(empty)" }], details: {} };
    },
  });
}
