// vlm.ts — vision.vlm 主程序：VLM（视觉大模型）能力接口 + 供应商工厂
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 供应商实现按名选择：vlm-qwen.ts（qwen）。换/加供应商不改调用方。

import { QwenVlmBackend } from "./vlm-qwen.ts";

// ── VLM 后端接口（能力契约）──────────────────────────────────
export interface VlmResult { text: string; usage: any; }

export interface VlmBackend {
  /** 描述图片：图片路径 → 文字。成功 { text, usage }，失败 { error } */
  describeImage(imagePath: string, prompt: string, model: string): Promise<VlmResult | { error: string }>;
}

// ── 供应商工厂 ────────────────────────────────────────────────
export function createVlmBackend(name: string): VlmBackend | null {
  switch (name) {
    case "qwen":
      return new QwenVlmBackend();
    default:
      return null;
  }
}
