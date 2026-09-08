// ── 命名来由（2026-09-09 dev-01）：OCR engine 能力入口——createOcrEngine() 按平台选 engine（darwin→macvision / Linux→rapidocr）。
// engine 是主概念（OcrEngine 接口）——macvision/rapidocr 是 engine 实现（非平行 provider 层）。
// ocr.ts — vision.ocr 主程序：本地 OCR（文字 + 结构化布局）能力接口 + 供应商工厂
// 模块分离：OCR 与 VLM 是独立服务（vision.ocr / vision.vlm）。
//   文字：readText      —— 截图/图片 → 纯文本（喂给 agent 直接读）
//   结构：readStructure —— 文字块 + 像素坐标 + 行聚合 + 区域分类（GUI→TUI 化、UI 元素定位）
// 供应商按名选择（ts 模式，参考 vision.vlm / voice.tts）：
//   ocr-macvision.ts（macOS Vision 框架——darwin 默认）/ ocr-rapidocr.ts（Linux rapidocr 兜底——2026-09-09）
// 换/加供应商不改调用方：新增供应商文件 + 工厂加分支。

import { MacvisionOcrEngine } from "./ocr-macvision.ts";
import { RapidocrOcrEngine } from "./ocr-rapidocr.ts";

// ── 结果类型 ────────────────────────────────────────────────
export interface OcrBlock {
  text: string;
  /** 像素坐标（左上原点，原图坐标系——自动放大时坐标已折算回原图） */
  x: number;
  y: number;
  w: number;
  h: number;
  centerX: number;
  centerY: number;
  area: number;
}

export interface OcrLine {
  /** 同一视觉行内的文字块合并（行内按 x 排序） */
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type OcrRegionType = "menubar" | "statusbar" | "sidebar" | "content" | "button" | "unknown";

export interface OcrRegion extends OcrLine {
  texts: string[];
  type: OcrRegionType;
}

export interface OcrStructured {
  image: { path: string; width: number; height: number };
  elapsedMs: number;
  blocks: OcrBlock[];
  lines: OcrLine[];
  totalBlocks: number;
  regions?: OcrRegion[];
  totalRegions?: number;
}

export interface OcrOptions {
  /** Vision recognitionLanguages，默认 ["zh-Hans", "en"] */
  lang?: string[];
  /** 0=auto（≤200万像素自动 2x——本质是 Retina 分辨率补偿：非 Retina 截图文字仅 10-12px，需 2x 到 Retina 等效才不漏行）1=不放大 N=强制 N 倍（1~4） */
  upscale?: number;
  /** readStructure 时额外输出区域聚合 + 分类 */
  group?: boolean;
  /** 区域聚合的垂直间隙阈值（px），默认 30 */
  gap?: number;
}

export interface OcrEngine {
  readText(imagePath: string, options?: OcrOptions): Promise<{ text: string } | { error: string }>;
  readStructure(imagePath: string, options?: OcrOptions): Promise<OcrStructured | { error: string }>;
}

// ── 供应商工厂 ────────────────────────────────────────────────
// 2026-09-09（用户定稿：Linux 默认 rapidocr——"先能用，慢就只能慢"）：默认按平台选——
// macOS（darwin）→ Vision 框架；Linux 等无 Vision → rapidocr（PP-OCRv3 onnxruntime 本地兜底，质量 ~90%/慢 2.4s）。
export function createOcrEngine(name?: string): OcrEngine | null {
  const resolved = name ?? (process.platform === "darwin" ? "vision" : "rapidocr");
  switch (resolved) {
    case "vision":
    case "default":
      return new MacvisionOcrEngine();
    case "rapidocr":
      return new RapidocrOcrEngine();
    default:
      return null;
  }
}
