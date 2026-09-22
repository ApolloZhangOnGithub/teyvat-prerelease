// spirit.bio.organs/head.eyes/eyes.ts — 眼睛：看图工具层（VL 视觉 + 本地 OCR）
// 能力层：vision.ocr（macOS Vision 本地 OCR，免配置中英混排）+ 模型直接看图（native）
// 2026-09-16（用户：先把 vlm 注释掉、禁用）：VL 描述（vision.vlm / qwen VL）通路已禁用，保留 ocr / native。
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
// 2026-09-16（用户：vlm 禁用）：import { createVlmBackend } from "#vision_vlm";
import { createOcrEngine } from "#vision_ocr";
import type { OcrStructured } from "#vision_ocr";
// 2026-09-22（PROPOSAL 041）：读活 app 的 UI 元素树（macOS AX）
import { createAxEngine } from "#vision_ax";
import type { AxResult } from "#vision_ax";

// ── 配置与 backend（模块级单例）────────────────────────────────────────
// 2026-09-16（用户：vlm 禁用）：const DEFAULT_MODEL = "qwen3-vl-plus";
// 2026-09-16（用户：vlm 禁用）：const DEFAULT_PROMPT = i18n("请用中文简洁描述这张图片/截图的内容。", "Please briefly describe this image/screenshot in English.");
// 2026-09-16（用户：vlm 禁用）：const vlm = createVlmBackend("qwen")!;
// 2026-09-09（first-tester 漏改）：OCR engine 无参按平台选（darwin→macvision / Linux→rapidocr）——之前硬传 "vision" 绕过平台选择，Linux 上永远走 macvision 报缺 PyObjC
const ocr = createOcrEngine()!;
// 2026-09-22（PROPOSAL 041）：AX 读 UI 树——仅 macOS 有实现（非 darwin 时 createAxEngine() 返回 null，case "ax" 给提示）
const ax = createAxEngine();

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
// 2026-09-16（用户：vlm 禁用）——formatLook 随 vlm 一并禁用：
// function formatLook(r: any, model: string): { content: any[]; details: any; isError: boolean } {
//   if ("error" in r) {
//     return { content: [{ type: "text", text: i18n(`Eyes vlm 失败: ${r.error}`, `Eyes vlm failed: ${r.error}`) }], details: {}, isError: true };
//   }
//   const usage = r.usage
//     ? `\n\n---\ntokens: ${r.usage.total_tokens} (${i18n("入", "in")}${r.usage.prompt_tokens} ${i18n("出", "out")}${r.usage.completion_tokens}) · 模型: ${model}`
//     : "";
//   return { content: [{ type: "text", text: r.text + usage }], details: { model }, isError: false };
// }

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

// 2026-09-22（PROPOSAL 041）：AX 结果 → 工具输出。tree 给出缩进结构（role + title/value），text 给纯文本。
// 与 ocr 的分工写进 messageDescription：活界面用 ax（精确），图片文件用 ocr。
function formatAx(r: AxResult): { content: any[]; details: any; isError: boolean } {
  const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s);
  const head = [
    `${r.app.name} (pid ${r.app.pid}${r.app.frontmost ? ", frontmost" : ""})`,
    `${r.counts.elements} 元素 / ${r.counts.withText} 有文本`,
    `${r.elapsedMs}ms`,
    r.counts.truncated ? `已截断 ${r.counts.dumped}/${r.counts.max}` : `输出 ${r.counts.dumped} 条`,
    r.rolesFiltered ? i18n("角色已过滤", "roles filtered") : i18n("全角色", "all roles"),
  ].join(" · ");
  let body: string;
  if (r.texts) {
    body = r.texts.length ? r.texts.join("\n") : i18n("(无文本)", "(no text)");
  } else {
    body = (r.nodes || [])
      .map((n) => {
        const role = n.subrole ? `${n.role}/${n.subrole}` : n.role;
        const bits = [
          n.title ? `"${clip(n.title, 120)}"` : "",
          n.value ? `= ${clip(n.value)}` : "",
          n.desc ? `desc=${clip(n.desc, 120)}` : "",
        ].filter(Boolean);
        return `${"  ".repeat(n.depth)}${role}${bits.length ? " " + bits.join(" ") : ""}`;
      })
      .join("\n");
    if (!body) body = i18n("(无文本元素)", "(no text elements)");
  }
  const hint = r.hint ? `\n\n${i18n("提示", "hint")}：${r.hint}` : "";
  return {
    content: [{ type: "text", text: `${head}\n\n${body}${hint}` }],
    details: { app: r.app, counts: r.counts, walkedFrom: r.walkedFrom },
    isError: false,
  };
}

export default function (pi: ExtensionAPI) {
  registerPaimonTool({
    name: "eyes",
    label: "Eyes",
    messageDescription:
      "看图/读屏：本地 OCR + 图片注入 + 读活 app 的 UI 树（AX）。一个工具，action 参数选择操作：\n" +
      // 2026-09-16（用户：vlm 禁用）：action:"vlm" 已禁用
      "  action:\"ocr\"   path, mode?           — 本地 OCR：macOS 用 Vision（免配置、中英混排、快）；Linux 用 rapidocr（install 自动装——质量~90% 复杂图慢~2.4s）\n" +
      "      mode: text=纯文本（默认）| structure=带坐标行 + 区域分类（menubar/sidebar/content/button/statusbar）\n" +
      "  action:\"native\" path                   — 把图片作为 image 块注入当前模型（模型看原图；需当前为视觉模型，否则提示切换）\n" +
      // 2026-09-22（PROPOSAL 041）
      "  action:\"ax\"     app?, mode?, ...       — 读某个**活 app 的 UI 元素树**（macOS 辅助功能 AX）：文本**零识别错**、带结构（角色/层级）、能读**屏幕外**内容（如终端回滚缓冲）。仅 macOS；需「辅助功能」授权\n" +
      "      app: 名字子串（如 \"Safari\"；不传=最前台 app）| pid: 直接指定进程（优先于 app）\n" +
      "      mode: tree=结构树（默认，含 role/title/value）| text=纯文本（按树序去重，最接近「精确 OCR」）\n" +
      "      roles: 角色白名单（如 \"AXButton,AXStaticText\"；不传=内置文本角色）| depth: 树深度（默认 8）| max: 最多元素（默认 200）\n" +
      "      选型：**活 app 的界面**用 ax（精确、有结构）；**图片文件/截图**用 ocr（唯一手段）。两者互补，不是替代",
    promptSnippet: "Eyes({action, path?, app?, ...}) — ocr=本地提取文字 | native=注入图给当前模型看 | ax=读活 app 的 UI 树（macOS；vlm 已禁用）",
    parameters: Type.Object({
      action: Type.String({ messageDescription: "ocr | native | ax（vlm 已禁用）" }),
      path: Type.Optional(Type.String({ messageDescription: i18n("图片文件路径（action=ocr/native 必填；ax 不用）", "Image file path (required for ocr/native; unused by ax)") })),
      // 2026-09-16（用户：vlm 禁用）——model/prompt 参数仅 vlm 用，注释禁用：
      // model: Type.Optional(Type.String({ messageDescription: i18n("VL 模型（action=vlm，默认 qwen3-vl-plus）", "VL model (action=vlm, default qwen3-vl-plus)") })),
      // prompt: Type.Optional(Type.String({ messageDescription: i18n("自定义提问（action=vlm）", "Custom question (action=vlm)") })),
      mode: Type.Optional(Type.String({ messageDescription: i18n("ocr：text（默认）| structure；ax：tree（默认）| text", "ocr: text (default) | structure; ax: tree (default) | text") })),
      // 2026-09-22（PROPOSAL 041）：ax 参数
      app: Type.Optional(Type.String({ messageDescription: i18n("ax 目标 app 名字子串（如 Safari）；不传=最前台 app", "ax target app name substring (e.g. Safari); omit = frontmost app") })),
      pid: Type.Optional(Type.Number({ messageDescription: i18n("ax 目标进程 pid（优先于 app）", "ax target pid (takes precedence over app)") })),
      roles: Type.Optional(Type.String({ messageDescription: i18n("ax 角色白名单，逗号分隔（如 AXButton,AXStaticText）", "ax role whitelist, comma separated") })),
      depth: Type.Optional(Type.Number({ messageDescription: i18n("ax 树深度上限（默认 8）", "ax tree depth limit (default 8)") })),
      max: Type.Optional(Type.Number({ messageDescription: i18n("ax 最多输出元素数（默认 200）", "ax max elements to output (default 200)") })),
    }),
    renderCall(args: any, theme: any) {
      const a = args?.action ?? "ocr"; // 2026-09-16（用户：vlm 禁用）默认 action 改为 ocr
      // 2026-08-15 统一：与 amem/social 一致——工具名 + action，不用 "Eyes.Ocr" 分层名
      // 2026-09-22（PROPOSAL 041）：ax 的「目标」是 app/pid 而非 path
      let detail: string;
      if (a === "ax") {
        detail = `${args?.app || (args?.pid ? `pid ${args.pid}` : "frontmost")}${args?.mode === "text" ? " [text]" : ""}${args?.roles ? ` roles=${args.roles}` : ""}`;
      } else if (a === "ocr") {
        detail = `${args?.path || "?"}${args?.mode === "structure" ? " [structure]" : ""}`;
      } else {
        detail = `${args?.path || "?"}${args?.model ? ` [${args.model}]` : ""}`;
      }
      return renderToolCall.label(theme, "Eyes", `${a} ${detail}`);
    },
    renderResult(result: any, _opts: any, theme: any, ctx: any) {
      return renderMessage.output(theme, ctx, resultContent(result));
    },
    async execute(_id, rawParams, _signal, _onUpdate, _ctx) {
      const p = (rawParams ?? {}) as any;
      const action = String(p.action ?? "ocr").trim(); // 2026-09-16（用户：vlm 禁用）默认 action 改为 ocr
      // 2026-09-22（PROPOSAL 041）：path 改可选——ax 用 app/pid，不用 path；只对 ocr/native 强校验
      if ((action === "ocr" || action === "native" || action === "vlm") && !p.path) {
        return { content: [{ type: "text", text: i18n("Eyes 的 ocr/native 需要 path（图片路径）。用法: Eyes({action:'ocr'|'native', path})；读屏用 Eyes({action:'ax', app?})", "Eyes ocr/native require path (image path). Usage: Eyes({action:'ocr'|'native', path}); for screen reading use Eyes({action:'ax', app?})") }], details: {}, isError: true };
      }
      switch (action) {
        // 2026-09-16（用户：vlm 先注释掉、禁用）：
        // case "vlm": {
        //   const model = p.model || DEFAULT_MODEL;
        //   const prompt = p.prompt || DEFAULT_PROMPT;
        //   return formatLook(await vlm.describeImage(p.path, prompt, model), model);
        // }
        case "vlm": {
          return { content: [{ type: "text", text: i18n("Eyes 的 vlm 动作已禁用（2026-09-16）。请用 ocr（本地提取文字）或 native（把图注入当前视觉模型）。", "Eyes vlm action is disabled (2026-09-16). Use ocr (local text extraction) or native (inject the image into a vision model).") }], details: {}, isError: true };
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
        case "ax": {
          // 2026-09-22（PROPOSAL 041）：读活 app 的 UI 元素树（macOS AX）——精确文本 + 结构，与 ocr 互补
          if (!ax) {
            return { content: [{ type: "text", text: i18n("Eyes 的 ax 仅 macOS 可用（Windows 走 UIA、Linux 走 AT-SPI2，均未实现）。", "Eyes ax is macOS-only (Windows UIA / Linux AT-SPI2 not implemented).") }], details: {}, isError: true };
          }
          const r = await ax.read({
            app: p.app,
            pid: p.pid,
            depth: p.depth,
            max: p.max,
            roles: p.roles,
            mode: p.mode === "text" ? "text" : "tree",
          });
          if ("error" in r) return { content: [{ type: "text", text: r.error }], details: {}, isError: true };
          return formatAx(r);
        }
        default:
          return { content: [{ type: "text", text: i18n(`未知 action: ${action}。用 ocr（本地 OCR）| native（注入图给视觉模型）| ax（读活 app 的 UI 树，仅 macOS）。vlm 已禁用。`, `Unknown action: ${action}. Use ocr (local OCR) | native (inject image to a vision model) | ax (read a live app's UI tree, macOS only). vlm is disabled.`) }], details: {}, isError: true };
      }
    },
  });
}
