// xlsx.ts — office.xlsx 主程序：Excel(.xlsx) 文档读取能力接口 + 引擎工厂
// 模块分离：office.docx / office.pptx / office.xlsx / office.pdf 是独立服务。
// 引擎：openpyxl（data_only=False 保留公式原文）——实测对比胜出方案
//   （vs pandas 公式变 NaN+对齐噪音 / unstructured 丢公式，见 word_reader_research/output/CONCLUSION.md）
// 调用方式：TS 层 execFile python3 xlsx-engine.py <path> --mode text|json（同 vision.ocr 模式）

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ENGINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "xlsx-engine.py");
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

// ── 结果类型 ────────────────────────────────────────────────
export interface XlsxBlock {
  /** row | section */
  type: string;
  text: string;
}

export interface XlsxResult {
  text: string;
  blocks: XlsxBlock[];
  elapsedMs: number;
  truncated: boolean;
}

export interface XlsxBackend {
  /** 纯文本：多 sheet 逐行，公式保留原文 */
  readText(path: string): Promise<{ text: string } | { error: string }>;
  /** 带类型块（row/section），供 RAG 切片 */
  readBlocks(path: string): Promise<{ blocks: XlsxBlock[] } | { error: string }>;
}

// ── 引擎实现（openpyxl）────────────────────────────────────
class PythonXlsxBackend implements XlsxBackend {
  async run(path: string, mode: "text" | "json"): Promise<XlsxResult | { error: string }> {
    if (!existsSync(path)) return { error: `文件不存在: ${path}` };
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync("python3", [ENGINE_PATH, path, "--mode", mode], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const parsed = JSON.parse(stdout) as { text: string; blocks: XlsxBlock[]; truncated?: boolean };
      return {
        text: parsed.text ?? "",
        blocks: parsed.blocks ?? [],
        elapsedMs: Date.now() - t0,
        truncated: parsed.truncated ?? false,
      };
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();
      return { error: `xlsx 读取失败: ${msg.slice(0, 300)}` };
    }
  }

  async readText(path: string): Promise<{ text: string } | { error: string }> {
    const r = await this.run(path, "text");
    if ("error" in r) return r;
    return { text: r.text };
  }

  async readBlocks(path: string): Promise<{ blocks: XlsxBlock[] } | { error: string }> {
    const r = await this.run(path, "json");
    if ("error" in r) return r;
    return { blocks: r.blocks };
  }
}

// ── 引擎工厂 ────────────────────────────────────────────────
export function createXlsxBackend(name: string = "python"): XlsxBackend | null {
  switch (name) {
    case "python":
    case "default":
      return new PythonXlsxBackend();
    default:
      return null;
  }
}
