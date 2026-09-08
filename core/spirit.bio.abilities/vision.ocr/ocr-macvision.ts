// ── 命名来由（2026-09-09 dev-01）：engine 是 OCR 主概念——macvision/rapidocr 是 engine 的两种实现（非平行 provider 层）。
// ts 封装名不带 engine 词（ocr-macvision.ts / ocr-rapidocr.ts）；py 引擎本体带 engine 词（ocr-engine-*.py）——
// ts 与 py 组件名不得相同（仅后缀不同不算区分——NORM 001「同名不同扩展禁止」）。
// ocr-macvision.ts — vision.ocr macVision 引擎封装（macOS Vision 框架，本地离线——调 ocr-engine-macvision.py）
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 实现 OcrEngine 接口（ocr.ts）。通过 python3 + ocr-engine-macvision.py（PyObjC）调用系统 Vision：
//   不依赖网络、不花钱、中英混排准确率高（实测比 tesseract 快 ~10 倍，全屏 Retina 截图 ~1.4s）。
// 日志 → ~/.teyvat/LogData/<agentId>/eyes.log（与 vlm.ts 同款，JSON 行）。

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
  const target = join(dir, "ocr-engine-macvision.py"); // 平台目标引擎
  if (existsSync(target)) return target;
  try {
    const hits = readdirSync(dir).filter(f => f.startsWith("ocr-engine-") && f.endsWith(".py"));
    if (hits.length) return join(dir, hits[0]);
  } catch { /* readdir 失败 → 返回目标名让 execFile 报错 */ }
  return target;
}
const OCR_TIMEOUT_MS = 120_000; // 含 python 冷启动 + 大图放大，留足余量
const MAX_BUFFER = 16 * 1024 * 1024;

// PyObjC 可用性只探测一次（进程内缓存）。缺依赖时给出可操作的安装提示（不静默）。
let pyobjcCache: null | boolean = null;
function hasPyObjc(): boolean {
  if (pyobjcCache !== null) return pyobjcCache;
  try {
    execFileSync("python3", ["-c", "import Quartz, Vision, Foundation"], { timeout: 15_000 });
    pyobjcCache = true;
  } catch (e) { console.error("[spirit.bio.abilities/vision.ocr/ocr-macvision.ts] " + ((e as any)?.message || e));
    pyobjcCache = false;
  }
  return pyobjcCache;
}

function logEyes(entry: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "eyes.log"), JSON.stringify(entry) + "\n");
  } catch (e) { console.error("[spirit.bio.abilities/vision.ocr/ocr-macvision.ts] " + ((e as any)?.message || e));
    // 日志失败不影响主流程
  }
}

function buildArgs(imagePath: string, options: OcrOptions, mode: "text" | "json"): string[] {
  const args = [resolveEngine(), imagePath, "--mode", mode];
  args.push("--lang", ...(options.lang?.length ? options.lang : ["zh-Hans", "en"]));
  if (options.upscale !== undefined) args.push("--upscale", String(options.upscale));
  if (mode === "json") {
    if (options.group) args.push("--group");
    if (options.gap !== undefined) args.push("--gap", String(options.gap));
  }
  return args;
}

export class MacvisionOcrEngine implements OcrEngine {
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
