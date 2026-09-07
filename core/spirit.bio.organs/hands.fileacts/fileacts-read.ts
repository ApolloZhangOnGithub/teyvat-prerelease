// fileacts-read.ts — read 工具覆盖实现：office 格式自动分发 + pi 原逻辑回退
// 背景：office.docx/pptx/xlsx/pdf 能力已实现（TS 层 execFile 调 python 引擎，见 spirit.bio.abilities/office.*）。
// 用户指令（2026-08-13）：把这些功能封装在 read 中针对这些格式 + 兼容底层 pi + 覆盖原 read。
// 机制：注册 name="read" 的扩展工具（pi toolRegistry 后写覆盖内置同名工具，已验证 agent-session.js _refreshToolRegistry）。
// 分发：.docx/.pptx/.xlsx/.pdf → office.* 能力；其余格式 → createReadToolDefinition 原生逻辑（文本/图片/offset/limit 不变）。

import { Type } from "@sinclair/typebox";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerPaimonTool } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { createDocxBackend } from "#office_docx";
import { createPptxBackend } from "#office_pptx";
import { createXlsxBackend } from "#office_xlsx";
import { createPdfBackend } from "#office_pdf";

const OFFICE_EXTS = new Map<string, "docx" | "pptx" | "xlsx" | "pdf">([
  [".docx", "docx"],
  [".pptx", "pptx"],
  [".xlsx", "xlsx"],
  [".pdf", "pdf"],
]);

// 2026-09-07 用户定稿：read 加 image 参数——带 image 则把图作为 image 块嵌入（模型看原图），
// 否则图片仅返回元信息标记并提示用 image 参数（默认不嵌入，避免 read 图片总是塞图占 token）。
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|bmp)$/i;

function extOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? "." + m[1]! : "";
}

async function readOffice(kind: "docx" | "pptx" | "xlsx" | "pdf", path: string): Promise<{ text: string } | { error: string }> {
  switch (kind) {
    case "docx": return createDocxBackend("python")!.readText(path);
    case "pptx": return createPptxBackend("python")!.readText(path);
    case "xlsx": return createXlsxBackend("python")!.readText(path);
    case "pdf": return createPdfBackend("python")!.readText(path);
  }
}

export default function registerReadTool(_pi: any): void {
  // pi 原生 read 定义（文本/图片/offset/limit/截断行为保持原样）——office 格式之外走它
  const baseRead = createReadToolDefinition(process.cwd(), {});

  registerPaimonTool({
    name: "read",
    label: "read",
    messageDescription:
      "Read file contents. " + i18n("文本/图片/代码文件 → 原样读取（支持 offset/limit）。", "text/image/code files → read as-is (offset/limit supported). ") +
      i18n("Office 文档（docx/pptx/xlsx/pdf）→ 自动提取文本内容（含页眉页脚/备注/表格/公式），供 agent 直接阅读。", "Office docs (docx/pptx/xlsx/pdf) → text auto-extracted (headers/footers/notes/tables/formulas), ready for the agent to read."),
    promptSnippet: "Read file contents (office docs auto-extracted)",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: Type.Object({
      path: Type.String({ messageDescription: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ messageDescription: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ messageDescription: "Maximum number of lines to read" })),
    }),
    renderCall(args: any, theme: any) {
      const range = args?.offset !== undefined || args?.limit !== undefined
        ? `:${args?.offset ?? 1}${args?.limit !== undefined ? `-${args.offset + args.limit - 1}` : ""}`
        : "";
      return renderToolCall.label(theme, "read", `${args?.path || "?"}${range}`);
    },
    renderResult(result: any, _opts: any, t: any, ctx: any) {
      if (ctx?.isError) return renderMessage.summary(t, { isError: true }, (result?.content || [])[0]?.text);
      const text = (result?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      const head = text.split("\n").slice(0, 12).join("\n");
      const more = text.split("\n").length > 12 ? `\n... (${text.split("\n").length - 12} more lines, expand to view)` : "";
      return renderMessage.output(t, ctx, [{ type: "text", text: head + more }]);
    },
    async execute(_id: any, params: any, signal: any, onUpdate: any, ctx: any) {
      if (!params?.path) return { content: [{ type: "text", text: i18n("用法: read <路径> [offset=N] [limit=N]", "Usage: read <path> [offset=N] [limit=N]") }], isError: true };
      const ext = extOf(params.path);
      const kind = OFFICE_EXTS.get(ext);
      if (kind) {
        const r = await readOffice(kind, params.path);
        if ("error" in r) return { content: [{ type: "text", text: i18n(`read ${params.path} 失败: ${r.error}`, `read ${params.path} failed: ${r.error}`) }], isError: true };
        return { content: [{ type: "text", text: r.text }] };
      }
      // 2026-09-07 用户定稿：图片嵌入统一走 eyes 的 action:"native"（当前模型看原图）——read 读图时提示引导，不再自己嵌入
      if (IMAGE_EXTS.test(ext)) {
        return { content: [{ type: "text", text: i18n(`图片文件 [${params.path}]。如需模型看图（原图嵌入，需视觉模型），请用 Eyes(action:'native', path="${params.path}") 注入；或 Eyes(action:'vlm', path=...) 让 VL 描述、Eyes(action:'ocr', path=...) 提取文字。`, `Image file [${params.path}]. To have the model see the original (needs a vision model), use Eyes(action:'native', path="${params.path}") to inject; or Eyes(action:'vlm', path=...) for VL description, Eyes(action:'ocr', path=...) for text extraction.`) }] };
      }
      // 非 office：走 pi 原生 read（文本截断 / offset/limit 全保留）
      return baseRead.execute(_id, params, signal, onUpdate, ctx);
    },
  });
}
