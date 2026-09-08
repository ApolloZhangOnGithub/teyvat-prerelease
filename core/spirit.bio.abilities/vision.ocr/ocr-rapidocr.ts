// ── 命名来由（2026-09-09 dev-01）：engine 是 OCR 主概念——macvision/rapidocr 是 engine 的两种实现（非平行 provider 层）。
// ts 封装名不带 engine 词（ocr-macvision.ts / ocr-rapidocr.ts）；py 引擎本体带 engine 词（ocr-engine-*.py）——
// ts 与 py 组件名不得相同（仅后缀不同不算区分——NORM 001「同名不同扩展禁止」）。
// ocr-rapidocr.ts — vision.ocr 供应商实现：Linux rapidocr（PP-OCRv3，onnxruntime 本地兜底）
// 2026-09-09（用户定稿：Linux 默认装 rapidocr + eyes ocr 用它——"慢就只能慢，先能用"）
// macOS 用 ocr-vision.ts（Vision 框架，默认）；Linux 无 Vision → 本供应商（质量 ~90%、复杂图 2.4s/张——first-tester 实测）。
// 实现 OcrEngine 接口（ocr.ts）——输出格式与 ocr-vision-engine 对齐（ts 端同解析）。
// 日志 → ~/.teyvat/LogData/<agentId>/eyes.log（与 ocr-vision.ts 同款）。

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { OcrEngine, OcrOptions, OcrStructured } from "./ocr.ts";

const execFileAsync = promisify(execFile);
// 2026-09-09（ISSUE 156）：引擎路径动态发现——目标存在用之；不存在（部署 rename 后）目录扫 ocr-engine-*.py fallback——
// 消费者不硬编码死文件名——rename（保持 ocr-engine-* 模式）后新进程照用；都不在则返回目标名（execFile 报错走友好处理）
function resolveEngine(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const target = join(dir, "ocr-engine-rapidocr.py"); // 平台目标引擎
  if (existsSync(target)) return target;
  try {
    const hits = readdirSync(dir).filter(f => f.startsWith("ocr-engine-") && f.endsWith(".py"));
    if (hits.length) return join(dir, hits[0]);
  } catch { /* readdir 失败 → 返回目标名让 execFile 报错 */ }
  return target;
}
const OCR_TIMEOUT_MS = 180_000; // rapidocr 首载模型冷启动 + 识别，留足余量
const MAX_BUFFER = 16 * 1024 * 1024;

// rapidocr 可用性只探测一次（进程内缓存）。缺依赖时给出可操作的安装提示（不静默）。
let rapidocrCache: null | boolean = null;
export function hasRapidocr(): boolean {
  if (rapidocrCache !== null) return rapidocrCache;
  try {
    execFileSync("python3", ["-c", "import rapidocr_onnxruntime"], { timeout: 15_000 });
    rapidocrCache = true;
  } catch (e) {
    console.error("[spirit.bio.abilities/vision.ocr/ocr-rapidocr.ts] " + ((e as any)?.message || e));
    rapidocrCache = false;
  }
  return rapidocrCache;
}

function logEyes(entry: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "eyes.log"), JSON.stringify(entry) + "\n");
  } catch { /* 日志失败静默 */ }
}

function buildArgs(imagePath: string, options: OcrOptions, mode: "text" | "json"): string[] {
  const args = [resolveEngine(), imagePath, "--mode", mode];
  if (options.group) args.push("--group");
  if (typeof options.gap === "number") args.push("--gap", String(options.gap));
  return args;
}

export class RapidocrOcrEngine implements OcrEngine {
  async readText(imagePath: string, options: OcrOptions = {}): Promise<{ text: string } | { error: string }> {
    if (!existsSync(imagePath)) return { error: `文件不存在: ${imagePath}` };
    if (!hasRapidocr()) {
      return { error: "需要 rapidocr（Linux 本地 OCR）：pip3 install rapidocr_onnxruntime onnxruntime pillow（或 install.sh Linux 分支已自动装）" };
    }
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync("python3", buildArgs(imagePath, options, "text"), {
        timeout: OCR_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
      });
      const text = stdout.trim();
      logEyes({ ts: new Date().toISOString(), mode: "text", path: imagePath, engine: "rapidocr", elapsedMs: Date.now() - t0, ok: true });
      return { text };
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();
      logEyes({ ts: new Date().toISOString(), mode: "text", path: imagePath, engine: "rapidocr", error: msg.slice(0, 500), ok: false });
      return { error: `OCR 失败: ${msg.slice(0, 300)}` };
    }
  }

  async readStructure(imagePath: string, options: OcrOptions = {}): Promise<OcrStructured | { error: string }> {
    if (!existsSync(imagePath)) return { error: `文件不存在: ${imagePath}` };
    if (!hasRapidocr()) {
      return { error: "需要 rapidocr（Linux 本地 OCR）：pip3 install rapidocr_onnxruntime onnxruntime pillow（或 install.sh Linux 分支已自动装）" };
    }
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync("python3", buildArgs(imagePath, options, "json"), {
        timeout: OCR_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
      });
      const parsed = JSON.parse(stdout) as Omit<OcrStructured, "image"> & { image: { width: number; height: number } };
      logEyes({ ts: new Date().toISOString(), mode: "structure", path: imagePath, engine: "rapidocr", group: options.group, elapsedMs: Date.now() - t0, ok: true });
      return { ...parsed, image: { ...parsed.image, path: imagePath } };
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();
      logEyes({ ts: new Date().toISOString(), mode: "structure", path: imagePath, engine: "rapidocr", error: msg.slice(0, 500), ok: false });
      return { error: `OCR 失败: ${msg.slice(0, 300)}` };
    }
  }
}
