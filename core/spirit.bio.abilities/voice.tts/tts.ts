// tts.ts — voice.tts 主程序：TTS（语音合成）能力接口 + 供应商工厂
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 供应商实现按名选择：tts-bytedance.ts（豆包）。换/加供应商不改调用方。

import { BytedanceTtsBackend } from "./tts-bytedance.ts";

// ── TTS 后端接口（能力契约）──────────────────────────────────
export interface TtsBackend {
  /** 合成语音：文字 → MP3。成功 { mp3 }，失败 { error } */
  synthesize(text: string): Promise<{ mp3: Buffer } | { error: string }>;
}

// ── 供应商工厂 ────────────────────────────────────────────────
export function createTtsBackend(name: string): TtsBackend | null {
  switch (name) {
    case "doubao":
    case "bytedance":
      return new BytedanceTtsBackend();
    default:
      return null;
  }
}
