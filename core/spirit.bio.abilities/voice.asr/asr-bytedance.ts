// asr-bytedance.ts — voice.asr 供应商实现：豆包/火山引擎 ASR 同传客户端
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 实现 AsrBackend 接口（asr.ts）。原 DoubaoTranscriber（python ears-mic_recorder.py 的 TS 重写）。
// protobuf 手写编解码：只覆盖实际使用的字段，字段号从 pb2 生成物反推。
// 运行时：Bun（WebSocket 自定义 header 需要）。

import { randomUUID } from "node:crypto";
import type { AsrBackend, EarResult } from "./asr.ts";
import { SAMPLE_RATE } from "./asr.ts";

export const WS_URL = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate";
export const RESOURCE_ID = "volc.service_type.10053";

// 豆包事件码（events_pb2.Type + 业务码）
export const EV = {
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  AsrDelta: 651,
  AsrDone: 652,
} as const;

// ── protobuf 最小编码器 ───────────────────────────────────────
// wire type: 0=varint, 2=length-delimited
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  if (n >= 0x80000000) v = n; // 事件码都远小于 2^31，安全
  do { let b = v & 0x7f; v = Math.floor(v / 128); if (v > 0) b |= 0x80; out.push(b); } while (v > 0);
  return out;
}
function tag(field: number, wire: number): number[] { return varint(field * 8 + wire); }
function lenDelim(field: number, payload: Uint8Array): Uint8Array {
  return concat([new Uint8Array(tag(field, 2)), new Uint8Array(varint(payload.length)), payload]);
}
function str(field: number, s: string): Uint8Array {
  return lenDelim(field, new TextEncoder().encode(s));
}
function uint(field: number, n: number): Uint8Array {
  return concat([new Uint8Array(tag(field, 0)), new Uint8Array(varint(n))]);
}
function concat(arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// TranslateRequest 字段号（自 ast_service_pb2 反推）：
//   #1 request_meta{#6 SessionID} #2 event #3 user{#1 uid,#2 did}
//   #4 source_audio{#4 format,#7 rate,#8 bits,#9 channel,#14 binary_data}
//   #6 request{#1 mode,#2 source_language,#3 target_language}
function encodeTranslateRequest(o: {
  sessionId: string; event: number; srcLang: string; tgtLang: string; pcm?: Uint8Array;
}): Uint8Array {
  const meta = str(6, o.sessionId);
  const user = concat([str(1, "pi-ear"), str(2, "pi-ear")]);
  const audioParts = [str(4, "wav"), uint(7, SAMPLE_RATE), uint(8, 16), uint(9, 1)];
  if (o.pcm && o.pcm.length) audioParts.push(lenDelim(14, o.pcm));
  const request = concat([str(1, "s2t"), str(2, o.srcLang), str(3, o.tgtLang)]);
  return concat([
    lenDelim(1, meta),
    uint(2, o.event),
    lenDelim(3, user),
    lenDelim(4, concat(audioParts)),
    lenDelim(6, request),
  ]);
}

// TranslateResponse: #1 response_meta{#3 StatusCode,#4 Message} #2 event #4 text
interface DecodedResponse { event: number; text: string; statusCode: number; message: string; }

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0, shift = 0;
  while (true) {
    const b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function decodeTranslateResponse(buf: Uint8Array): DecodedResponse {
  const out: DecodedResponse = { event: 0, text: "", statusCode: 0, message: "" };
  let pos = 0;
  while (pos < buf.length) {
    let t: number; [t, pos] = readVarint(buf, pos);
    const field = Math.floor(t / 8), wire = t & 7;
    if (wire === 0) {
      let v: number; [v, pos] = readVarint(buf, pos);
      if (field === 2) out.event = v;
    } else if (wire === 2) {
      let len: number; [len, pos] = readVarint(buf, pos);
      const payload = buf.subarray(pos, pos + len); pos += len;
      if (field === 4) out.text = new TextDecoder().decode(payload);
      else if (field === 1) {
        // response_meta 子消息
        let p = 0;
        while (p < payload.length) {
          let t2: number; [t2, p] = readVarint(payload, p);
          const f2 = Math.floor(t2 / 8), w2 = t2 & 7;
          if (w2 === 0) { let v2: number; [v2, p] = readVarint(payload, p); if (f2 === 3) out.statusCode = v2; }
          else if (w2 === 2) { let l2: number; [l2, p] = readVarint(payload, p); if (f2 === 4) out.message = new TextDecoder().decode(payload.subarray(p, p + l2)); p += l2; }
          else if (w2 === 5) p += 4; else if (w2 === 1) p += 8; else break;
        }
      }
    } else if (wire === 5) pos += 4;
    else if (wire === 1) pos += 8;
    else break;
  }
  return out;
}

// ── 工具 ──────────────────────────────────────────────────────
function nowStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── 豆包同传后端（惰性连接 + 空闲断开 + 断线重连，镜像 py 版）──
export class BytedanceAsrBackend implements AsrBackend {
  private q: Uint8Array[] = [];
  private onResult: ((r: EarResult) => void) | null = null;
  private running = false;
  active = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private appKey: string,
    private accessKey: string,
    private srcLang = "zh",
    private tgtLang = "zh",
    private idleCloseS = 3.0,
  ) {}

  start(onResult: (r: EarResult) => void) {
    this.onResult = onResult;
    this.running = true;
    this.loopPromise = this.worker();
  }

  feed(pcm: Uint8Array) {
    if (this.q.length < 600) this.q.push(pcm);
  }

  async stop() {
    this.running = false;
    if (this.loopPromise) await Promise.race([this.loopPromise, sleep(5000)]);
  }

  private handleResponse(r: DecodedResponse): boolean {
    if (r.event === EV.SessionFailed) {
      console.log(`[ear] 豆包会话失败: code=${r.statusCode}`);
      return true; // session dead
    }
    const text = (r.text || "").trim();
    if (r.event === EV.AsrDone && text) {
      this.onResult?.({ time: nowStamp(), text, translation: "", is_final: true });
    } else if (r.event === EV.AsrDelta && text) {
      this.onResult?.({ time: nowStamp(), text, translation: "", is_final: false });
    }
    return false;
  }

  private async worker() {
    let reconnectDelay = 2;
    const MAX_DELAY = 60;
    const SILENCE_100MS = new Uint8Array(3200);

    while (this.running) {
      // 等第一块 pcm（惰性连接）
      const firstPcm = this.q.shift();
      if (!firstPcm) { await sleep(50); continue; }

      const sessionId = randomUUID();
      let ws: any = null;
      let sessionDead = false;
      try {
        const msgs: Uint8Array[] = [];
        let closed = false, wsError: any = null;
        // Bun WebSocket 支持自定义 header；binaryType arraybuffer
        ws = new (globalThis as any).WebSocket(WS_URL, {
          headers: {
            "X-Api-App-Key": this.appKey,
            "X-Api-Access-Key": this.accessKey,
            "X-Api-Resource-Id": RESOURCE_ID,
            "X-Api-Connect-Id": randomUUID(),
          },
        });
        ws.binaryType = "arraybuffer";
        ws.onmessage = (ev: any) => { msgs.push(new Uint8Array(ev.data)); };
        ws.onclose = () => { closed = true; };
        ws.onerror = (e: any) => { wsError = e; closed = true; };
        const opened = new Promise<void>((res, rej) => {
          ws.onopen = () => res();
          setTimeout(() => rej(new Error("连接超时")), 10000);
          ws.addEventListener?.("error", () => rej(new Error("连接失败")));
        });
        await opened;

        ws.send(encodeTranslateRequest({ sessionId, event: EV.StartSession, srcLang: this.srcLang, tgtLang: this.tgtLang }));
        // 等 SessionStarted（15s 超时）
        const startDeadline = Date.now() + 15000;
        let started = false;
        while (Date.now() < startDeadline && !closed) {
          const m = msgs.shift();
          if (m) {
            const r = decodeTranslateResponse(m);
            if (r.event === EV.SessionStarted) { started = true; break; }
            throw new Error(`启动失败: event=${r.event} code=${r.statusCode}`);
          }
          await sleep(20);
        }
        if (!started) throw new Error(`启动失败: ${wsError ? "连接错误" : "超时"}`);

        this.active = true;
        reconnectDelay = 2;
        console.log("[ear] 豆包已连接");

        ws.send(encodeTranslateRequest({ sessionId, event: EV.TaskRequest, srcLang: this.srcLang, tgtLang: this.tgtLang, pcm: firstPcm }));
        let audioClock = performance.now() / 1000;
        let lastRealT = performance.now() / 1000;

        inner: while (this.running && !closed) {
          // 处理收到的消息
          let m: Uint8Array | undefined;
          while ((m = msgs.shift())) {
            if (this.handleResponse(decodeTranslateResponse(m))) { sessionDead = true; break inner; }
          }

          const now = performance.now() / 1000;
          if (now - lastRealT > this.idleCloseS) {
            ws.send(encodeTranslateRequest({ sessionId, event: EV.FinishSession, srcLang: this.srcLang, tgtLang: this.tgtLang }));
            const drainUntil = Date.now() + 3000;
            while (Date.now() < drainUntil && !closed) {
              let dm: Uint8Array | undefined;
              while ((dm = msgs.shift())) this.handleResponse(decodeTranslateResponse(dm));
              await sleep(50);
            }
            break;
          }

          if (now - audioClock > 2.0) audioClock = now - 2.0;
          while (audioClock <= now && this.running) {
            let pcm = this.q.shift();
            if (pcm) lastRealT = now;
            else pcm = SILENCE_100MS;
            ws.send(encodeTranslateRequest({ sessionId, event: EV.TaskRequest, srcLang: this.srcLang, tgtLang: this.tgtLang, pcm }));
            audioClock += pcm.length / 2.0 / SAMPLE_RATE;
          }
          await sleep(20);
        }
        if (closed && !sessionDead) reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      } catch (e: any) {
        const msg = String((e as any)?.message || e).slice(0, 120);
        if (!msg.includes("Connection") && !msg.toLowerCase().includes("timeout")) {
          console.log(`[ear] 豆包异常: ${msg}`);
        }
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      } finally {
        this.active = false;
        if (ws) {
          try { if (!sessionDead) ws.send(encodeTranslateRequest({ sessionId, event: EV.FinishSession, srcLang: this.srcLang, tgtLang: this.tgtLang })); } catch (e) { console.error("[spirit.bio.abilities/voice.asr/asr-bytedance.ts] " + ((e as any)?.message || e)); }
          try { ws.close(); } catch (e) { console.error("[spirit.bio.abilities/voice.asr/asr-bytedance.ts] " + ((e as any)?.message || e)); }
        }
        if (this.running) await sleep(reconnectDelay * 1000);
      }
    }
  }
}
