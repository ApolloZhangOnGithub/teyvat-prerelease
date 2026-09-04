// ocr-vision.ts — vision.ocr 供应商实现：macOS Vision 框架（本地离线）
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 实现 OcrBackend 接口（ocr.ts）。通过 python3 + ocr-vision-engine.py（PyObjC）调用系统 Vision：
//   不依赖网络、不花钱、中英混排准确率高（实测比 tesseract 快 ~10 倍，全屏 Retina 截图 ~1.4s）。
// 日志 → ~/.teyvat/LogData/<agentId>/eyes.log（与 vlm.ts 同款，JSON 行）。

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { OcrBackend, OcrOptions, OcrStructured } from "./ocr.ts";

const execFileAsync = promisify(execFile);
const ENGINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "ocr-vision-engine.py");
const OCR_TIMEOUT_MS = 120_000; // 含 python 冷启动 + 大图放大，留足余量
const MAX_BUFFER = 16 * 1024 * 1024;

// PyObjC 可用性只探测一次（进程内缓存）。缺依赖时给出可操作的安装提示（不静默）。
let pyobjcCache: null | boolean = null;
function hasPyObjc(): boolean {
  if (pyobjcCache !== null) return pyobjcCache;
  try {
    execFileSync("python3", ["-c", "import Quartz, Vision, Foundation"], { timeout: 15_000 });
    pyobjcCache = true;
  } catch {
    pyobjcCache = false;
  }
  return pyobjcCache;
}

function logEyes(entry: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "eyes.log"), JSON.stringify(entry) + "\n");
  } catch {
    // 日志失败不影响主流程
  }
}

function buildArgs(imagePath: string, options: OcrOptions, mode: "text" | "json"): string[] {
  const args = [ENGINE_PATH, imagePath, "--mode", mode];
  args.push("--lang", ...(options.lang?.length ? options.lang : ["zh-Hans", "en"]));
  if (options.upscale !== undefined) args.push("--upscale", String(options.upscale));
  if (mode === "json") {
    if (options.group) args.push("--group");
    if (options.gap !== undefined) args.push("--gap", String(options.gap));
  }
  return args;
}

export class VisionOcrBackend implements OcrBackend {
  async readText(imagePath: string, options: OcrOptions = {}): Promise<{ text: string } | { error: string }> {
    if (!existsSync(imagePath)) return { error: `文件不存在: ${imagePath}` };
    if (!hasPyObjc()) {
      return { error: "需要 PyObjC（macOS Vision 本地 OCR）：pip3 install pyobjc-framework-Quartz pyobjc-framework-Vision" };
    }
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync("python3", buildArgs(imagePath, options, "text"), {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      logEyes({ ts: new Date().toISOString(), mode: "text", path: imagePath, lang: options.lang, upscale: options.upscale, elapsedMs: Date.now() - t0, ok: true });
      return { text: stdout.replace(/\s+$/, "") };
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();
      logEyes({ ts: new Date().toISOString(), mode: "text", path: imagePath, error: msg.slice(0, 500), ok: false });
      return { error: `OCR 失败: ${msg.slice(0, 300)}` };
    }
  }

  async readStructure(imagePath: string, options: OcrOptions = {}): Promise<OcrStructured | { error: string }> {
    if (!existsSync(imagePath)) return { error: `文件不存在: ${imagePath}` };
    if (!hasPyObjc()) {
      return { error: "需要 PyObjC（macOS Vision 本地 OCR）：pip3 install pyobjc-framework-Quartz pyobjc-framework-Vision" };
    }
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync("python3", buildArgs(imagePath, options, "json"), {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const parsed = JSON.parse(stdout) as Omit<OcrStructured, "image"> & { image: { width: number; height: number } };
      logEyes({ ts: new Date().toISOString(), mode: "structure", path: imagePath, group: options.group, elapsedMs: Date.now() - t0, ok: true });
      return { ...parsed, image: { ...parsed.image, path: imagePath } };
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();
      logEyes({ ts: new Date().toISOString(), mode: "structure", path: imagePath, error: msg.slice(0, 500), ok: false });
      return { error: `OCR 失败: ${msg.slice(0, 300)}` };
    }
  }
}
