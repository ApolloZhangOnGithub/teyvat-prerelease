// asr.ts — voice.asr 主程序：ASR（语音识别）能力接口 + 公共工具 + 供应商工厂
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 供应商实现按名选择：asr-bytedance.ts（豆包/火山引擎同传）。换/加供应商不改调用方。

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BytedanceAsrBackend } from "./asr-bytedance.ts";

export const SAMPLE_RATE = 16000;
export const CHUNK_MS = 100;
export const CHUNK_SIZE = (SAMPLE_RATE * CHUNK_MS) / 1000; // 1600 samples

// ── ASR 后端接口（能力契约）──────────────────────────────────
export interface EarResult { time: string; text: string; translation: string; is_final: boolean; }

export interface AsrBackend {
  /** 当前是否有活跃会话 */
  active: boolean;
  /** 启动：注册结果回调（含非最终结果） */
  start(onResult: (r: EarResult) => void): void;
  /** 喂 PCM 音频块 */
  feed(pcm: Uint8Array): void;
  /** 停止并等待内部循环退出 */
  stop(): Promise<void>;
}

export interface AsrConfig {
  appKey: string;
  accessKey: string;
  srcLang?: string;
  tgtLang?: string;
  idleCloseS?: number;
}

// ── 供应商工厂 ────────────────────────────────────────────────
export function createAsrBackend(name: string, cfg: AsrConfig): AsrBackend | null {
  switch (name) {
    case "doubao":
    case "bytedance":
      return new BytedanceAsrBackend(
        cfg.appKey, cfg.accessKey,
        cfg.srcLang || "zh", cfg.tgtLang || "zh",
        cfg.idleCloseS ?? 3.0,
      );
    default:
      return null;
  }
}

// ── 配置加载（凭证 + ear 参数；与原 py load_config 行为一致）──
export interface EarConfig {
  doubao_app_key: string;
  doubao_access_key: string;
  src_lang: string;
  tgt_lang: string;
  silence_rms: number;
  silence_hangover_s: number;
  idle_close_s: number;
  asr_backend?: string;
  [k: string]: any;
}

export function loadConfig(): EarConfig {
  const cfg: EarConfig = {
    doubao_app_key: "",
    doubao_access_key: "",
    src_lang: "zh",
    tgt_lang: "zh",
    silence_rms: 120,
    silence_hangover_s: 1.5,
    idle_close_s: 3.0,
  };
  // ~/.teyvat/UserAccount/services.json（兼容旧 config/）
  try {
    const ua = join(homedir(), ".teyvat/UserAccount/services.json");
    const legacy = join(homedir(), ".teyvat/config/services.json");
    const svc = JSON.parse(readFileSync(existsSync(ua) ? ua : legacy, "utf8"))["doubao-voicengine"] || {};
    if (svc.appId) cfg.doubao_app_key = svc.appId;
    if (svc.token) cfg.doubao_access_key = svc.token;
  } catch (e) { console.error("[spirit.bio.abilities/voice.asr/asr.ts] " + ((e as any)?.message || e)); }
  return cfg;
}

// ── 音频工具（模块内共享）──────────────────────────────────────
// 解析 WAV：返回 fmt 元信息 + data 块的 PCM 字节
export interface WavData { sampleRate: number; channels: number; bits: number; pcm: Uint8Array; }

export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`不是有效的 WAV 文件: ${path}`);
  }
  let sampleRate = 0, channels = 0, bits = 0;
  let pcm: Uint8Array | null = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === "data") {
      pcm = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2); // chunk 按 2 字节对齐
  }
  if (!pcm) throw new Error(`WAV 缺少 data 块: ${path}`);
  return { sampleRate, channels, bits, pcm };
}
