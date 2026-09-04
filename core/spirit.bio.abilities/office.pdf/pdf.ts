// pdf.ts — office.pdf 主程序：PDF 文档读取能力接口 + 引擎工厂
// 模块分离：office.docx / office.pptx / office.xlsx / office.pdf 是独立服务。
// 引擎：PyMuPDF(fitz)——MuPDF 的 C 绑定，逐页 get_text 快且准（已装 1.25.5）。
// 扫描版/图片型 PDF 无文本层 → 需 vision.ocr 配合（另议）。
// 调用方式：TS 层 execFile python3 pdf-engine.py <path> --mode text|json（同 vision.ocr 模式）

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ENGINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "pdf-engine.py");
const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// ── 结果类型 ────────────────────────────────────────────────
export interface PdfBlock {
  /** page | section */
  type: string;
  text: string;
}

export interface PdfResult {
  text: string;
  blocks: PdfBlock[];
  pageCount: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface PdfBackend {
  /** 纯文本：逐页提取，页间分页 */
  readText(path: string): Promise<{ text: string } | { error: string }>;
  /** 带类型块（page/section），供 RAG 切片 */
  readBlocks(path: string): Promise<{ blocks: PdfBlock[]; pageCount: number } | { error: string }>;
}

// ── 引擎实现（PyMuPDF）──────────────────────────────────────
class PythonPdfBackend implements PdfBackend {
  async run(path: string, mode: "text" | "json"): Promise<PdfResult | { error: string }> {
    if (!existsSync(path)) return { error: `文件不存在: ${path}` };
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync("python3", [ENGINE_PATH, path, "--mode", mode], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const parsed = JSON.parse(stdout) as { text: string; blocks: PdfBlock[]; pageCount: number; truncated?: boolean };
      return {
        text: parsed.text ?? "",
        blocks: parsed.blocks ?? [],
        pageCount: parsed.pageCount ?? 0,
        elapsedMs: Date.now() - t0,
        truncated: parsed.truncated ?? false,
      };
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();
      return { error: `pdf 读取失败: ${msg.slice(0, 300)}` };
    }
  }

  async readText(path: string): Promise<{ text: string } | { error: string }> {
    const r = await this.run(path, "text");
    if ("error" in r) return r;
    return { text: r.text };
  }

  async readBlocks(path: string): Promise<{ blocks: PdfBlock[]; pageCount: number } | { error: string }> {
    const r = await this.run(path, "json");
    if ("error" in r) return r;
    return { blocks: r.blocks, pageCount: r.pageCount };
  }
}

// ── 引擎工厂 ────────────────────────────────────────────────
export function createPdfBackend(name: string = "python"): PdfBackend | null {
  switch (name) {
    case "python":
    case "default":
      return new PythonPdfBackend();
    default:
      return null;
  }
}
