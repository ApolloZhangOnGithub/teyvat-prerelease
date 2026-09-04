// docx.ts — office.docx 主程序：Word(.docx) 文档读取能力接口 + 引擎工厂
// 模块分离：office.docx / office.pptx / office.xlsx / office.pdf 是独立服务。
// 引擎：python-docx 全量遍历（段落+表格+页眉+页脚+文本框XML）——实测对比胜出方案
//   （vs docx2txt 无结构 / mammoth&pandoc 丢页眉页脚 / unstructured 丢文本框，见 word_reader_research/output/CONCLUSION.md）
// 调用方式：TS 层 execFile python3 docx-engine.py <path> --mode text|json（同 vision.ocr 模式）

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ENGINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "docx-engine.py");
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

// ── 结果类型 ────────────────────────────────────────────────
export interface DocxBlock {
  /** text | title | table | textbox | section */
  type: string;
  text: string;
}

export interface DocxResult {
  text: string;
  blocks: DocxBlock[];
  elapsedMs: number;
  truncated: boolean;
}

export interface DocxBackend {
  /** 纯文本：段落+表格+页眉+页脚+文本框，喂给 agent 直接读 */
  readText(path: string): Promise<{ text: string } | { error: string }>;
  /** 带类型块（text/title/table/textbox/section），供 RAG 切片 */
  readBlocks(path: string): Promise<{ blocks: DocxBlock[] } | { error: string }>;
}

// ── 引擎实现（python-docx 全量遍历）────────────────────────
class PythonDocxBackend implements DocxBackend {
  async run(path: string, mode: "text" | "json"): Promise<DocxResult | { error: string }> {
    if (!existsSync(path)) return { error: `文件不存在: ${path}` };
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync("python3", [ENGINE_PATH, path, "--mode", mode], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const parsed = JSON.parse(stdout) as { text: string; blocks: DocxBlock[]; truncated?: boolean };
      return {
        text: parsed.text ?? "",
        blocks: parsed.blocks ?? [],
        elapsedMs: Date.now() - t0,
        truncated: parsed.truncated ?? false,
      };
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();
      return { error: `docx 读取失败: ${msg.slice(0, 300)}` };
    }
  }

  async readText(path: string): Promise<{ text: string } | { error: string }> {
    const r = await this.run(path, "text");
    if ("error" in r) return r;
    return { text: r.text };
  }

  async readBlocks(path: string): Promise<{ blocks: DocxBlock[] } | { error: string }> {
    const r = await this.run(path, "json");
    if ("error" in r) return r;
    return { blocks: r.blocks };
  }
}

// ── 引擎工厂 ────────────────────────────────────────────────
export function createDocxBackend(name: string = "python"): DocxBackend | null {
  switch (name) {
    case "python":
    case "default":
      return new PythonDocxBackend();
    default:
      return null;
  }
}
