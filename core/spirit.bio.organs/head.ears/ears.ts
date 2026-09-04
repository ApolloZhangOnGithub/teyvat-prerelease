// head.ears — Voice input (bios func)
// 文档: B.docs/Dev.Common/Wiki/Ears(Organ).WIKI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { openSync, readFileSync, statSync, unlinkSync, writeSync, writeFileSync, watch, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPrompt } from "#kernel_ribosome";
import { personDir as getPersonDir } from "#paths";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { i18n } from "#tui_localizations";

const PROMPT = getPrompt("ear.listen");
const BUN = (() => {
  try { return execSync("which bun", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
  const home = process.env.HOME;
  if (home) { const p = `${home}/.bun/bin/bun`; try { execSync(`test -x "${p}"`, { stdio: "ignore" }); return p; } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); } }
  return "bun";
})();
const __dirname = dirname(fileURLToPath(import.meta.url));
const RECORDER_SCRIPT = resolve(__dirname, "ears-recorder.ts");

interface EarState {
  personDir: string | null;
  listening: boolean;
  recorderType: 'mic' | 'file';
  fileBackend: 'doubao' | 'whisper';
  fileSpeed: number;
}

function isRecorderAlive(): boolean {
  try { execSync("pgrep -f 'ears-recorder.ts'", { stdio: "ignore" }); return true; }
  catch { return false; }
}

export default function (pi: ExtensionAPI) {
  // 语音注入消息渲染（MESSAGE_TYPES "ear" render:true 但此前无渲染器）
  pi.registerMessageRenderer("ear", (message: any, _opts: any, theme: any) => {
    return renderMessage.notice(theme, "Voice", (message.content ?? "").toString());
  });
  let state: EarState = {
    personDir: null, listening: false, recorderType: 'mic', fileBackend: 'doubao', fileSpeed: 1.0
  };
  let watcher: ReturnType<typeof watch> | null = null;
  let offset = 0;
  let recorderProc: ChildProcess | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  // NORM-011: ear 运行时数据放 RuntimeCache，不污染 MemoryData
  // 2026-08-20：语音通信/产物一律用 teyvat 专属目录（~/.teyvat/RuntimeCache），不写系统 /tmp——
  // 安全（tmp 系统共享可被其他进程读写）+ 无冲突（多 agent 共用 /tmp 文件会互踩）+ 不依赖系统自动清理（用户定稿：永远不用 tmp）。
  const voiceRc = (name: string) => join(homedir(), ".teyvat/RuntimeCache", name);
  const earFile = () => (state.personDir
    ? `${state.personDir.replace('/MemoryData/', '/RuntimeCache/')}/ear_output.jsonl`
    : voiceRc('ear_output.jsonl'));

  function startRecorder(filePath: string = '') {
    if (isRecorderAlive()) return;
    recorderProc = null;
    const file = earFile();
    const logDir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "ear_debug.log");
    const logFd = openSync(logFile, "a");
    let args: string[];
    if (filePath) {
      const backend = state.fileBackend || 'doubao';
      const lang = 'zh';
      args = [RECORDER_SCRIPT, "--mode", "file", filePath, file, "--backend", backend, "--lang", lang, "--speed", String(state.fileSpeed)];
    } else {
      args = [RECORDER_SCRIPT, file];
    }
    writeSync(logFd, `${new Date().toISOString()} [keep-alive] spawn ${args.join(' ')}\n`);
    recorderProc = spawn(BUN, args, { detached: true, stdio: ["ignore", logFd, logFd] });
    recorderProc.unref();
  }

  function stopRecorder() {
    if (recorderProc) { recorderProc.kill(); recorderProc = null; }
    try { execSync("pkill -f 'ears-recorder.ts' 2>/dev/null || true"); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); } // || true：pkill 无匹配（录音进程不在）是正常，不抛 Command failed
  }

  function startKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (!state.listening || !state.personDir) return;
      if (state.recorderType === 'mic' && !isRecorderAlive()) startRecorder();
    }, 5000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  }

  // ── 语音缓冲 ──
  let speechBuffer: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const FLUSH_DELAY = 3000;

  function flushBuffer() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (speechBuffer.length === 0) return;
    const combined = speechBuffer.join(" ");
    speechBuffer = [];
    // 2026-08-13 修复：注册名是 "ear"（单数），此前发 "ears"（未注册）会抛错，语音注入一直失效
    sendCustomMessage(pi, "ear", combined);
  }

  function startWatch() {
    if (watcher) { try { watcher.close(); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); } watcher = null; }
    if (!state.personDir) return;
    try { execSync(`touch "${earFile()}"`); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
    try { const existing = readFileSync(earFile(), "utf8"); offset = existing.length; } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
    watcher = watch(earFile(), async () => {
      if (!state.listening || !state.personDir) return;
      try {
        const muteStat = statSync(voiceRc("pi_mouth_speaking"));
        if (Date.now() - muteStat.mtimeMs < 30000) return;
        unlinkSync(voiceRc("pi_mouth_speaking"));
      } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
      try {
        const content = await readFile(earFile(), "utf8");
        if (content.length <= offset) return;
        const newPart = content.slice(offset);
        offset = content.length;
        for (const line of newPart.trim().split("\n").filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            const text = entry.text || entry.translation || "";
            if (!text.trim()) continue;
            if (entry.is_final !== false && text.trim()) {
              speechBuffer.push(text);
              if (flushTimer) clearTimeout(flushTimer);
              flushTimer = setTimeout(flushBuffer, FLUSH_DELAY);
            }
          } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
        }
      } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
    });
  }

  function stopWatch() {
    flushBuffer();
    if (watcher) { try { watcher.close(); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); } watcher = null; }
    watcher = null;
    offset = 0;
  }

  function ok(text: string) {
    return { content: [{ type: "text", text }], details: {} };
  }
  function err(text: string) {
    return { content: [{ type: "text", text: i18n(`ERR: ${text}`, `ERR: ${text}`) }], details: {}, isError: true };
  }

  const earParamsSchema = Type.Object({
    action: Type.Optional(Type.String({ messageDescription: "on/off/file/status/pause/resume/seek/stop" })),
    path: Type.Optional(Type.String({ messageDescription: i18n("WAV 文件路径（action=file 时必填）", "WAV file path (required for action=file)") })),
    backend: Type.Optional(Type.String({ messageDescription: i18n("ASR 后端：doubao 或 whisper（action=file 时可选）", "ASR backend: doubao or whisper (optional for action=file)") })),
    speed: Type.Optional(Type.Number({ messageDescription: i18n("播放速度倍数 0.25-4.0（action=file 时可选，默认 1.0）", "Playback speed 0.25-4.0x (optional for action=file, default 1.0)") })),
    seconds: Type.Optional(Type.Number({ messageDescription: i18n("跳转秒数（action=seek 时必填）", "Seek seconds (required for action=seek)") })),
  });

  registerPaimonTool({
    name: "ear",
    label: "Ears",
    messageDescription: i18n("开关语音监听（豆包 ASR 实时转写）。on/off/file/status/pause/resume/seek/stop。", "Toggle voice listening (Doubao ASR live transcription). on/off/file/status/pause/resume/seek/stop."),
    promptSnippet: "ear({action:'on|off|file|status|pause|resume|seek|stop'})",
    parameters: earParamsSchema,
    renderCall(args: any, theme: any) {
      const act = args?.action || "";
      const detail = act === 'file' ? args?.path : act === 'seek' ? `${args?.seconds || 0}s` : "";
      return renderToolCall.label(theme, `Ears ${act}`, detail);
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const content = resultContent(result);
      return renderMessage.summary(theme, ctx, content?.[0]?.text);
    },
    async execute(_id: string, params: any) {
      const act = params?.action || "";

      if (act === "on") {
        if (!state.personDir) return err("没有 personDir（需先 session_start）");
        state.listening = true;
        state.recorderType = 'mic';
        startRecorder();
        startKeepAlive();
        startWatch();
        return ok("耳朵已开启。语音输入将实时转写并注入");
      }

      if (act === "file") {
        const fpath = params?.path || '';
        if (!fpath) return err("path 参数必填");
        if (!state.personDir) return err("没有 personDir");
        const backend = params?.backend || state.fileBackend;
        if (backend === 'whisper' || backend === 'doubao') state.fileBackend = backend;
        const speed = parseFloat(params?.speed) || 1.0;
        state.fileSpeed = Math.max(0.25, Math.min(4.0, speed));
        state.recorderType = 'file';
        stopRecorder();
        stopKeepAlive();
        stopWatch();
        state.listening = true;
        startRecorder(fpath);
        startWatch();
        return ok(`耳朵已开启（文件模式）：${fpath}，后端=${state.fileBackend}，速度=${state.fileSpeed}x`);
      }

      if (act === "off") {
        state.listening = false;
        stopRecorder();
        stopKeepAlive();
        stopWatch();
        return ok("耳朵已关闭");
      }

      if (act === "pause") {
        if (state.recorderType !== 'file') return err("仅文件模式支持暂停");
        try { writeFileSync(voiceRc("ear_control.json"), JSON.stringify({ action: "pause" })); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
        return ok("耳朵已暂停");
      }
      if (act === "resume") {
        if (state.recorderType !== 'file') return err("仅文件模式支持恢复");
        try { writeFileSync(voiceRc("ear_control.json"), JSON.stringify({ action: "resume" })); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
        return ok("耳朵已恢复");
      }
      if (act === "seek") {
        if (state.recorderType !== 'file') return err("仅文件模式支持跳转");
        const sec = parseFloat(params?.seconds) || 0;
        try { writeFileSync(voiceRc("ear_control.json"), JSON.stringify({ action: "seek", seconds: sec })); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
        return ok(`耳朵跳转到 ${sec}s`);
      }
      if (act === "stop") {
        if (state.recorderType !== 'file') return err("仅文件模式支持停止");
        try { writeFileSync(voiceRc("ear_control.json"), JSON.stringify({ action: "stop" })); } catch (e) { console.error("[spirit.bio.organs/head.ears/ears.ts] " + ((e as any)?.message || e)); }
        state.listening = false;
        stopRecorder();
        stopKeepAlive();
        stopWatch();
        return ok("耳朵已停止");
      }

      let msg: string;
      if (state.listening) {
        msg = state.recorderType === 'file'
          ? `耳朵监听中（文件模式，${state.fileBackend}，${state.fileSpeed}x）`
          : "耳朵开启中";
      } else {
        msg = "耳朵已关闭。ear({action:'on'}) 开启";
      }
      return ok(msg);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const sf = ctx.sessionManager.getSessionFile();
    if (!sf) return;
    if (sf.includes("metaconsciousnessSessions") || sf.includes("HippocampusSessions") || sf.includes("SleepSessions")) return;
    state.personDir = getPersonDir(sf);
    state.listening = false;
  });

  // [2026-08-15 统一管线] 工具级 prompt 注入已收敛至 heart.ts before_agent_start
  // （per-tool 粒度：Ears 工具激活才注入 ear.listen）。此处不再重复注入。
  // pi.on("before_agent_start", async (event) => {
  //   if (!state.listening) return;
  //   return { systemPrompt: event.systemPrompt + "\n\n" + PROMPT };
  // });

  pi.on("session_shutdown", () => {
    state.listening = false;
    stopRecorder();
    stopWatch();
    stopKeepAlive();
  });
}
