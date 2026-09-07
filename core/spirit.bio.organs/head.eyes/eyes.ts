// spirit.bio.organs/head.eyes/eyes.ts — 眼睛：看图工具层（VL 视觉 + 本地 OCR）
// 能力层：vision.vlm（qwen VL 描述图片）+ vision.ocr（macOS Vision 本地 OCR，免配置中英混排）
// 封装模式参考 social：一个工具，action 参数选操作，每种 action 的参数在 messageDescription 里写清楚；
// backend 模块级单例 + formatX 纯函数（hands.webacts 同款）。
//
// 文档: B.docs/Dev.Common/Wiki/Eyes(Organ).WIKI
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
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

// 2026-09-07 用户定稿：图片可由当前（视觉）模型直接看——图作为 image 块注入上下文（非 VL/OCR 外部通道）。
// 检测当前模型是否支持图片：模型配置 input 含 "image"（如 deepseek-v4-flash-vision-exp）；否则提示切换视觉模型。
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};
function isVisionModel(model: any): boolean {
  const inp = model?.input ?? model?.capabilities ?? [];
  return Array.isArray(inp) ? inp.includes("image") : false;
}
function currentModel(ctx: any): any {
  return ctx?.model ?? (globalThis as any).__genshinGetModel?.() ?? ctx?.session?.model;
}

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
      "看图：VL 视觉 + 本地 OCR + 图片注入。一个工具，action 参数选择操作：\n" +
      "  action:\"vlm\"   path, model?, prompt?  — 用 VL 模型描述图片内容\n" +
      "      model 默认 qwen3-vl-plus；prompt 缺省为「请用中文简洁描述这张图片/截图的内容。」\n" +
      "  action:\"ocr\"   path, mode?           — 本地 macOS Vision OCR（免配置、离线、中英混排）\n" +
      "      mode: text=纯文本（默认）| structure=带坐标行 + 区域分类（menubar/sidebar/content/button/statusbar）\n" +
      "  action:\"native\" path                   — 把图片作为 image 块注入当前模型（模型看原图；需当前为视觉模型，否则提示切换）",
    promptSnippet: "Eyes({action, path, ...}) — vlm=VL 描述图片 | ocr=本地提取文字 | native=注入图给当前模型看",
    parameters: Type.Object({
      action: Type.String({ messageDescription: "vlm | ocr | native" }),
      path: Type.String({ messageDescription: i18n("图片文件路径", "Image file path") }),
      model: Type.Optional(Type.String({ messageDescription: i18n("VL 模型（action=vlm，默认 qwen3-vl-plus）", "VL model (action=vlm, default qwen3-vl-plus)") })),
      prompt: Type.Optional(Type.String({ messageDescription: i18n("自定义提问（action=vlm）", "Custom question (action=vlm)") })),
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
        case "native": {
          // 2026-09-07 用户定稿：图片作为 image 块注入当前模型（模型看原图）。需当前为视觉模型，否则提示切换。/m
          const model = currentModel(_ctx);
          if (!isVisionModel(model)) {
            const mid = model?.id ?? model?.model ?? "?";
            return { content: [{ type: "text", text: i18n(`当前模型 ${mid} 不支持看图（非视觉模型）。请先用 /m 切换到视觉模型（如 deepseek-v4-flash-vision-exp），再用 Eyes(action:'native') 注入图片。`, `Current model ${mid} does not support images (not a vision model). Switch to a vision model via /m (e.g. deepseek-v4-flash-vision-exp) first, then Eyes(action:'native') to embed the image.`) }], details: {}, isError: true };
          }
          try {
            const ext = p.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
            const mime = IMAGE_MIME["." + ext] || "image/png";
            const buf = await readFile(p.path);
            return { content: [
              { type: "text", text: i18n(`图片 [${p.path}]（注入当前模型，模型可见原图）`, `Image [${p.path}] (injected to current model, model sees original)`) },
              { type: "image", data: buf.toString("base64"), mimeType: mime },
            ], details: {}, isError: false };
          } catch (e: any) {
            return { content: [{ type: "text", text: i18n(`Eyes native 失败: ${e?.message || e}`, `Eyes native failed: ${e?.message || e}`) }], details: {}, isError: true };
          }
        }
        default:
          return { content: [{ type: "text", text: i18n(`未知 action: ${action}。用 vlm（VL 描述图片）或 ocr（本地 OCR）。`, `Unknown action: ${action}. Use vlm (VL image description) or ocr (local OCR).`) }], details: {}, isError: true };
      }
    },
  });
}
