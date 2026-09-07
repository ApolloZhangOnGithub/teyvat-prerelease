#!/usr/bin/env bun
// ears-recorder.ts — 语音录制 → ASR → ear_output.jsonl
// 文档: B.docs/Dev.Common/Wiki/Ears(Organ).WIKI
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 麦克风模式（默认）和文件模式合一。
//
// 用法：
//   bun ears-recorder.ts <output_jsonl>                          # 麦克风模式
//   bun ears-recorder.ts --mode file <media> <output_jsonl> ...  # 文件模式
//
// 文件模式选项：--backend doubao|whisper  --lang xx  --speed N  --chunk N  --model xx

import { existsSync, mkdirSync, appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { connect, type Socket } from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createAsrBackend, loadConfig, readWav, SAMPLE_RATE, CHUNK_SIZE, type EarResult,
} from "#voice_asr";

// 2026-08-20：语音控制/状态/产物一律用 teyvat 专属目录（~/.teyvat/RuntimeCache），不写系统 /tmp——
// 安全 + 无冲突（多 agent 共用 /tmp 会互踩）+ 不依赖系统自动清理（用户定稿：永远不用 tmp）。
// 必须与 ears.ts / mouth.ts 同步（跨进程通信路径一致）。
const CTL_FILE = join(homedir(), ".teyvat/RuntimeCache/ear_control.json");
const MUTE_FILE = join(homedir(), ".teyvat/RuntimeCache/pi_mouth_speaking");
const BYTES_PER_CHUNK = CHUNK_SIZE * 2;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════
//  麦克风模式
// ══════════════════════════════════════════════════════════════════

interface Source {
  open(): Promise<void>;
  read(): Promise<Uint8Array>;
  close(): void;
}

class RemoteMicrophone implements Source {
  static HOST = "127.0.0.1";
  static PORT = 7691;
  private sock: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;

  static available(): Promise<boolean> {
    return new Promise(res => {
      const s = connect({ host: RemoteMicrophone.HOST, port: RemoteMicrophone.PORT, timeout: 300 });
      s.once("connect", () => { s.destroy(); res(true); });
      s.once("error", () => res(false));
      s.once("timeout", () => { s.destroy(); res(false); });
    });
  }

  async open() {
    await new Promise<void>((res, rej) => {
      this.sock = connect({ host: RemoteMicrophone.HOST, port: RemoteMicrophone.PORT });
      this.sock.once("connect", () => res());
      this.sock.once("error", rej);
    });
    this.sock!.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); });
    this.sock!.on("close", () => { this.closed = true; });
    console.log(`[ear] 远端麦克风 (rtw mic_relay ${RemoteMicrophone.HOST}:${RemoteMicrophone.PORT})`);
  }

  async read(): Promise<Uint8Array> {
    while (this.buf.length < BYTES_PER_CHUNK) {
      if (this.closed) throw new Error("mic relay disconnected");
      await sleep(10);
    }
    const chunk = this.buf.subarray(0, BYTES_PER_CHUNK);
    this.buf = this.buf.subarray(BYTES_PER_CHUNK);
    return new Uint8Array(chunk);
  }

  close() { try { this.sock?.destroy(); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears-recorder.ts] " + ((e as any)?.message || e)); } }
}

class FfmpegMicrophone implements Source {
  private proc: ChildProcess | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private dead = false;

  private inputCandidates(): Array<{ fmt: string; devs: string[] }> {
    if (process.platform === "darwin") {
      const dev = process.env.EAR_MIC_DEVICE || ":default";
      return [{ fmt: "avfoundation", devs: [dev, ":0"] }];
    }
    const dev = process.env.EAR_MIC_DEVICE || "default";
    return [
      { fmt: "pulse", devs: [dev] },
      { fmt: "alsa", devs: [dev, "hw:0"] },
    ];
  }

  async open() {
    for (const { fmt, devs } of this.inputCandidates()) {
      for (const dev of devs) {
        const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error",
          "-f", fmt, "-i", dev, "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "-"],
          { stdio: ["ignore", "pipe", "pipe"] });
        const ok = await new Promise<boolean>(res => {
          const t = setTimeout(() => res(true), 1500);
          p.once("exit", () => { clearTimeout(t); res(false); });
          p.once("error", () => { clearTimeout(t); res(false); });
        });
        if (ok) {
          this.proc = p;
          p.stdout!.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); });
          p.once("exit", () => { this.dead = true; });
          console.log(`[ear] 麦克风 ffmpeg ${fmt} "${dev}" (${SAMPLE_RATE}Hz, 1ch)`);
          return;
        }
      }
    }
    throw new Error(`无法打开麦克风（ffmpeg：已尝试 ${this.inputCandidates().map(c => c.fmt).join("/")}）`);
  }

  async read(): Promise<Uint8Array> {
    while (this.buf.length < BYTES_PER_CHUNK) {
      if (this.dead) throw new Error("ffmpeg 麦克风进程退出");
      await sleep(10);
    }
    const chunk = this.buf.subarray(0, BYTES_PER_CHUNK);
    this.buf = this.buf.subarray(BYTES_PER_CHUNK);
    return new Uint8Array(chunk);
  }

  close() { try { this.proc?.kill(); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears-recorder.ts] " + ((e as any)?.message || e)); } }
}

async function runMic(outputPath: string) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const cfg = loadConfig();
  if (!cfg.doubao_app_key || !cfg.doubao_access_key) {
    console.log("[ear] doubao-voicengine 未配置");
    process.exit(1);
  }
  console.log(`[ear] 启动 — 源语言=${cfg.src_lang} 目标=${cfg.tgt_lang}`);
  console.log(`[ear] 输出 ${outputPath}`);

  const source: Source = await RemoteMicrophone.available()
    ? new RemoteMicrophone()
    : new FfmpegMicrophone();
  await source.open();

  const transcriber = createAsrBackend("doubao", {
    appKey: cfg.doubao_app_key,
    accessKey: cfg.doubao_access_key,
    srcLang: cfg.src_lang,
    tgtLang: cfg.tgt_lang,
    idleCloseS: Number(cfg.idle_close_s),
  });
  if (!transcriber) { console.error("[ear] 无可用 ASR 后端"); process.exit(1); }
  transcriber.start((rec: EarResult) => {
    if (rec.is_final && rec.text) {
      appendFileSync(outputPath, JSON.stringify(rec) + "\n");
      console.log(`[ear ✓] ${rec.text}`);
    }
  });

  const silenceRms = Number(cfg.silence_rms);
  const hangoverS = Number(cfg.silence_hangover_s);
  let voiceUntil = 0;
  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  try {
    while (running) {
      const pcm = await source.read();
      if (existsSync(MUTE_FILE)) continue;
      const audio = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
      let sum = 0;
      for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
      const rms = audio.length ? Math.sqrt(sum / audio.length) : 0;
      const now = performance.now() / 1000;
      if (rms >= silenceRms) voiceUntil = now + hangoverS;
      if (now <= voiceUntil) transcriber.feed(pcm);
    }
  } finally {
    console.log("[ear] 关闭");
    await transcriber.stop();
    source.close();
    process.exit(0);
  }
}

// ══════════════════════════════════════════════════════════════════
//  文件模式
// ══════════════════════════════════════════════════════════════════

const MEDIA_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv", ".m4v", ".mpg", ".mpeg", ".3gp", ".m4a", ".mp3", ".ogg", ".wma", ".aac", ".flac"]);

function isMediaFile(path: string): boolean {
  return MEDIA_EXT.has(extname(path).toLowerCase());
}

function extractAudio(videoPath: string): string {
  // 2026-08-20：不写系统 /tmp——迁移到 teyvat RuntimeCache（随机名不冲突，处理完 finally 自删）
  const tmp = join(homedir(), ".teyvat/RuntimeCache", `ear-extract-${randomUUID()}.wav`);
  let dur = 0;
  try {
    const r = execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], { encoding: "utf8", timeout: 10000 });
    dur = parseFloat(r.trim()) || 0;
  } catch (e) { console.error("[spirit.bio.organs/head.ears/ears-recorder.ts] " + ((e as any)?.message || e)); }
  console.error(`[ear-file] 提取音频: ${basename(videoPath)} (${dur.toFixed(0)}s) → WAV`);
  execFileSync("ffmpeg", ["-y", "-v", "quiet", "-i", videoPath, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-f", "wav", tmp], { timeout: 120000 });
  return tmp;
}

function pollControl(): any {
  try {
    const ctl = JSON.parse(readFileSync(CTL_FILE, "utf8"));
    try { unlinkSync(CTL_FILE); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears-recorder.ts] " + ((e as any)?.message || e)); }
    return ctl;
  } catch (e) { console.error("[spirit.bio.organs/head.ears/ears-recorder.ts] " + ((e as any)?.message || e)); return null; }
}

async function runFileDoubao(wavPath: string, outputJsonl: string, speed: number, chunk: number) {
  const cfg = loadConfig();
  if (!cfg.doubao_app_key) { console.error("[ear-file] doubao key missing"); return; }
  const wav = readWav(wavPath);
  const rate = wav.sampleRate;
  const totalFrames = wav.pcm.length / (wav.bits / 8) / wav.channels;

  const t = createAsrBackend("doubao", { appKey: cfg.doubao_app_key, accessKey: cfg.doubao_access_key });
  if (!t) { console.error("[ear-file] 无可用 ASR 后端"); return; }
  let count = 0;
  let fedFrames = 0;
  t.start((rec: EarResult) => {
    if (rec.text && rec.is_final) {
      const posSec = Math.round((fedFrames / rate) * 10) / 10;
      appendFileSync(outputJsonl, JSON.stringify({ ts: Date.now() / 1000, position: posSec, feed: posSec, text: rec.text, backend: "doubao" }) + "\n");
      console.log(`[${posSec.toFixed(0)}s] ${rec.text}`);
      count++;
    }
  });

  let paused = false;
  let pos = 0;
  let chunkSize = chunk;
  const bytesPerFrame = (wav.bits / 8) * wav.channels;

  while (pos < totalFrames) {
    const ctl = pollControl();
    if (ctl) {
      const action = ctl.action || ctl.state || "";
      if (action === "stop") break;
      if (action === "pause") paused = true;
      if (action === "resume" || action === "play") paused = false;
      let seekTo: number | null = null;
      if (action === "seek" && ctl.seconds != null) seekTo = Number(ctl.seconds);
      else if (ctl.seek != null) seekTo = Number(ctl.seek);
      if (seekTo != null) {
        const np = Math.floor(seekTo * rate);
        if (np >= 0 && np < totalFrames) pos = np;
        paused = false;
      }
      if (ctl.speed != null) speed = Number(ctl.speed);
      if (ctl.chunk != null) chunkSize = Math.floor(Number(ctl.chunk));
    }
    if (paused) { await sleep(100); continue; }

    const start = pos * bytesPerFrame;
    const end = Math.min(start + chunkSize * bytesPerFrame, wav.pcm.length);
    if (start >= wav.pcm.length) break;
    pos += chunkSize;
    fedFrames = pos;
    t.feed(wav.pcm.subarray(start, end));
    await sleep(100 / speed);
  }
  const deadline = Date.now() + 15000;
  while (t.active && Date.now() < deadline) await sleep(200);
  await t.stop();
  console.error(`[ear-file] done (${count} segs)`);
}

function runFileWhisper(wavPath: string, outputJsonl: string, lang: string, model: string) {
  console.error(`[ear-file] whisper (${model})...`);
  const script = `
import json, sys, time
from faster_whisper import WhisperModel
m = WhisperModel(sys.argv[3], device="cpu", compute_type="int8")
segs, _ = m.transcribe(sys.argv[1], language=sys.argv[2], beam_size=5)
count = 0
for seg in segs:
    rec = {"ts": time.time(), "start": round(seg.start,1), "end": round(seg.end,1), "text": seg.text.strip(), "backend": "whisper"}
    open(sys.argv[4], 'a').write(json.dumps(rec, ensure_ascii=False) + "\\n")
    print(f"[{seg.start:.1f}s] {seg.text.strip()}", flush=True)
    count += 1
print(f"[ear-file] done ({count} segs)", file=sys.stderr)
`;
  execFileSync("python3", ["-c", script, wavPath, lang, model, outputJsonl], { stdio: ["ignore", "inherit", "inherit"] });
}

async function runFile(mediaFile: string, outputJsonl: string, backend: string, lang: string, speed: number, chunk: number, model: string) {
  let audioPath = mediaFile;
  let tmpWav: string | null = null;
  if (isMediaFile(mediaFile)) {
    tmpWav = extractAudio(mediaFile);
    audioPath = tmpWav;
  }

  try {
    if (backend === "whisper") runFileWhisper(audioPath, outputJsonl, lang, model);
    else await runFileDoubao(audioPath, outputJsonl, speed, chunk);
  } finally {
    if (tmpWav && existsSync(tmpWav)) unlinkSync(tmpWav);
    process.exit(0);
  }
}

// ══════════════════════════════════════════════════════════════════
//  入口
// ══════════════════════════════════════════════════════════════════

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string, def: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] || def) : def; };
  const mode = opt("mode", "mic");
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { i++; continue; }
    positional.push(argv[i]);
  }

  if (mode === "file") {
    const [mediaFile, outputJsonl] = positional;
    if (!mediaFile || !outputJsonl) { console.error("[ear] 缺少参数: <media_file> <output_jsonl>"); process.exit(2); }
    await runFile(mediaFile, outputJsonl, opt("backend", "doubao"), opt("lang", "en"),
      parseFloat(opt("speed", "1.0")) || 1.0, parseInt(opt("chunk", "1600")) || 1600, opt("model", "small"));
  } else {
    const outputPath = positional[0];
    if (!outputPath) { console.error("[ear] 缺少参数: <output_jsonl>"); process.exit(2); }
    await runMic(outputPath);
  }
}

main().catch(e => { console.error(`[ear] ${e?.message || e}`); process.exit(1); });
