// spirit.bio.organs/head.eyes/eyes.ts — 眼睛：看图工具层（VL 视觉 + 本地 OCR）
// 能力层：vision.vlm（qwen VL 描述图片）+ vision.ocr（macOS Vision 本地 OCR，免配置中英混排）
// 封装模式参考 social：一个工具，action 参数选操作，每种 action 的参数在 messageDescription 里写清楚；
// backend 模块级单例 + formatX 纯函数（hands.webacts 同款）。
//
// 文档: B.docs/Dev.Common/Wiki/Eyes(Organ).WIKI
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { registerPaimonTool, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { createVlmBackend } from "#vision_vlm";
import { createOcrBackend } from "#vision_ocr";
import type { OcrStructured } from "#vision_ocr";

// ── 配置与 backend（模块级单例）────────────────────────────────────────
const DEFAULT_MODEL = "qwen3-vl-plus";
const DEFAULT_PROMPT = i18n("请用中文简洁描述这张图片/截图的内容。", "Please briefly describe this image/screenshot in English.");
const vlm = createVlmBackend("qwen")!;
const ocr = createOcrBackend("vision")!;

// ── 格式化：能力结果 → 工具结果（execute 只做取参/调用/格式化）─────────
function formatLook(r: any, model: string): { content: any[]; details: any; isError: boolean } {
  if ("error" in r) {
    return { content: [{ type: "text", text: i18n(`Eyes vlm 失败: ${r.error}`, `Eyes vlm failed: ${r.error}`) }], details: {}, isError: true };
  }
  const usage = r.usage
    ? `\n\n---\ntokens: ${r.usage.total_tokens} (${i18n("入", "in")}${r.usage.prompt_tokens} ${i18n("出", "out")}${r.usage.completion_tokens}) · 模型: ${model}`
    : "";
  return { content: [{ type: "text", text: r.text + usage }], details: { model }, isError: false };
}

function formatOcrText(r: any): { content: any[]; details: any; isError: boolean } {
  if ("error" in r) {
    return { content: [{ type: "text", text: i18n(`OCR 失败: ${r.error}`, `OCR failed: ${r.error}`) }], details: {}, isError: true };
  }
  return { content: [{ type: "text", text: r.text || i18n("(未识别到文字)", "(no text recognized)") }], details: {}, isError: false };
}

function formatOcrStructure(r: OcrStructured): { content: any[]; details: any; isError: boolean } {
  const lines = r.lines.map((l) => `${l.y}:${l.x} ${l.text}`).join("\n");
  const regions = (r.regions || []).map((g) => `[${g.type}] ${g.texts.join(" ")}`).join("\n");
  const text = `图片 ${r.image.width}x${r.image.height}, ${r.totalBlocks} 块, ${r.lines.length} 行:\n${lines}\n\n区域:\n${regions}`;
  return { content: [{ type: "text", text }], details: { totalBlocks: r.totalBlocks, totalRegions: r.totalRegions ?? 0 }, isError: false };
}

export default function (pi: ExtensionAPI) {
  registerPaimonTool({
    name: "eyes",
    label: "Eyes",
    messageDescription:
      "看图：VL 视觉 + 本地 OCR。一个工具，action 参数选择操作：\n" +
      "  action:\"look\"  path, model?, prompt?  — 用 VL 模型描述图片内容\n" +
      "      model 默认 qwen3-vl-plus；prompt 缺省为「请用中文简洁描述这张图片/截图的内容。」\n" +
      "  action:\"ocr\"   path, mode?           — 本地 macOS Vision OCR（免配置、离线、中英混排）\n" +
      "      mode: text=纯文本（默认）| structure=带坐标行 + 区域分类（menubar/sidebar/content/button/statusbar）",
    promptSnippet: "Eyes({action, path, ...}) — vlm=VL 描述图片 | ocr=本地提取文字（text/structure）",
    parameters: Type.Object({
      action: Type.String({ messageDescription: "vlm | ocr" }),
      path: Type.String({ messageDescription: i18n("图片文件路径", "Image file path") }),
      model: Type.Optional(Type.String({ messageDescription: i18n("VL 模型（action=look，默认 qwen3-vl-plus）", "VL model (action=look, default qwen3-vl-plus)") })),
      prompt: Type.Optional(Type.String({ messageDescription: i18n("自定义提问（action=look）", "Custom question (action=look)") })),
      mode: Type.Optional(Type.String({ messageDescription: i18n("ocr 输出模式：text（默认）| structure（action=ocr）", "ocr output mode: text (default) | structure (action=ocr)") })),
    }),
    renderCall(args: any, theme: any) {
      const a = args?.action ?? "vlm";
      // 2026-08-15 统一：与 amem/social 一致——工具名 + action，不用 "Eyes.Ocr" 分层名
      const detail = a === "ocr"
        ? `${args?.path || "?"}${args?.mode === "structure" ? " [structure]" : ""}`
        : `${args?.path || "?"}${args?.model ? ` [${args.model}]` : ""}`;
      return renderToolCall.label(theme, "Eyes", `${a} ${detail}`);
    },
    renderResult(result: any, _opts: any, theme: any, ctx: any) {
      return renderMessage.output(theme, ctx, resultContent(result));
    },
    async execute(_id, rawParams, _signal, _onUpdate, _ctx) {
      const p = (rawParams ?? {}) as any;
      const action = String(p.action ?? "vlm").trim();
      if (!p.path) {
        return { content: [{ type: "text", text: i18n("Eyes 需要 path（图片路径）。用法: Eyes({action:'vlm'|'ocr', path})", "Eyes requires path (image path). Usage: Eyes({action:'vlm'|'ocr', path})") }], details: {}, isError: true };
      }
      switch (action) {
        case "vlm": {
          const model = p.model || DEFAULT_MODEL;
          const prompt = p.prompt || DEFAULT_PROMPT;
          return formatLook(await vlm.describeImage(p.path, prompt, model), model);
        }
        case "ocr": {
          if (p.mode === "structure") {
            const r = await ocr.readStructure(p.path, { group: true });
            if ("error" in r) return { content: [{ type: "text", text: i18n(`OCR 失败: ${r.error}`, `OCR failed: ${r.error}`) }], details: {}, isError: true };
            return formatOcrStructure(r);
          }
          return formatOcrText(await ocr.readText(p.path));
        }
        default:
          return { content: [{ type: "text", text: i18n(`未知 action: ${action}。用 vlm（VL 描述图片）或 ocr（本地 OCR）。`, `Unknown action: ${action}. Use vlm (VL image description) or ocr (local OCR).`) }], details: {}, isError: true };
      }
    },
  });
}
