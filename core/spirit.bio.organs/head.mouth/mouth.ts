// 文档: B.docs/Dev.Common/Wiki/Mouth(Organ).WIKI
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ChildProcess, spawn, execSync, execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { platform, homedir } from "node:os";

// TTS 输出 MP3——fallback 链里只放能播 MP3 的播放器（paplay/aplay 只支持 WAV，不能用）
let _cachedPlayer: { cmd: string; args: string[] } | null = null;
function audioPlayer(): { cmd: string; args: string[] } {
  if (_cachedPlayer) return _cachedPlayer;
  if (platform() === "darwin") { _cachedPlayer = { cmd: "afplay", args: [] }; return _cachedPlayer; }
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet"] },
    { cmd: "mpv",    args: ["--no-video", "--really-quiet"] },
    { cmd: "cvlc",   args: ["--play-and-exit", "--quiet"] },
  ];
  for (const c of candidates) {
    // 2026-09-11：which 探测改为 execFileSync（argv 数组，不经 shell）—— 原 execSync(`which ${c.cmd}`) 是拼 shell
    try { execFileSync("which", [c.cmd], { stdio: "ignore" }); _cachedPlayer = c; return c; } catch (e) { console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); }
  }
  _cachedPlayer = { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet"] };
  return _cachedPlayer;
}
import { getPrompt } from "#kernel_ribosome";
import { registerPaimonTool } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { createTtsBackend } from "#voice_tts";

const PROMPT = getPrompt("head.mouth");
const tts = createTtsBackend("doubao")!;

// ── 持久状态（队列、锁、播放——绝不随热加载重建）──
let speaking = false;
let speakProc: ChildProcess | null = null;
let speakQueue: string[] = [];
let watchdog: ReturnType<typeof setTimeout> | null = null;
let lastSpokenText = "";
let lastSpokenAt = 0;
let speakResolvers: (() => void)[] = [];

function finishCurrent() {
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  speakProc = null;
  speaking = false;
  processQueue();
}

// 2026-08-20：语音状态/音频一律用 teyvat 专属目录（~/.teyvat/RuntimeCache），不写系统 /tmp——
// 安全 + 无冲突（多 agent 共用 /tmp 会互踩）+ 不依赖系统自动清理（用户定稿：永远不用 tmp）。
// 必须与 ears.ts / ears-recorder.ts 同步（跨进程通信路径一致）。
const voiceRc = (name: string) => join(homedir(), ".teyvat/RuntimeCache", name);

function processQueue() {
  if (speaking) return;
  const text = speakQueue.shift();
  if (text === undefined) {
    try { unlinkSync(voiceRc("pi_mouth_speaking")); } catch (e) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); } // ENOENT=文件不存在（正常清理场景）静默
    for (const r of speakResolvers) r();
    speakResolvers = [];
    return;
  }
  speaking = true;
  lastSpokenText = text;
  lastSpokenAt = Date.now();
  try { writeFileSync(voiceRc("pi_mouth_speaking"), "1", "utf-8"); } catch (e) { console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); }

  // TTS 合成（voice.tts）+ 本地播放
  tts.synthesize(text).then((res) => {
      if ("error" in res) { finishCurrent(); return; }
      const mp3 = res.mp3;
      const mp3Path = voiceRc("pi_mouth.mp3");
      writeFileSync(mp3Path, mp3);
      const player = audioPlayer();
      speakProc = spawn(player.cmd, [...player.args, mp3Path], { stdio: "ignore" });
      const thisProc = speakProc;
      const maxMs = Math.min(180000, 8000 + text.length * 350);
      watchdog = setTimeout(() => { try { thisProc.kill(); } catch (e) { console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); } if (speakProc === thisProc) finishCurrent(); }, maxMs);
      thisProc.on("close", () => { if (speakProc === thisProc) finishCurrent(); });
      thisProc.on("error", () => { if (speakProc === thisProc) finishCurrent(); });
    }).catch(() => {
      finishCurrent();
    });
}

// ── TTS API 实现 → voice.tts ──────────────────────────────────

export default function (pi: ExtensionAPI) {
  let personId: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const sf = ctx.sessionManager.getSessionFile();
    if (!sf) return;
    if (sf.includes("metaconsciousnessSessions") || sf.includes("HippocampusSessions") || sf.includes("SleepSessions")) return;
    personId = global.__genshinPersonId as string;
  });

  registerPaimonTool({
    name: "mouth",
    label: "Mouth (TTS)",
    feedResult: false,
    messageDescription: "Speak text aloud via 豆包 TTS (vivi 2.0 voice). Ear auto-mutes. Single speech at a time.",
    promptSnippet: "Speak text aloud via 豆包 TTS (vivi 2.0 voice, clean display)",
    parameters: {
      type: "object" as any,
      properties: { text: { type: "string", messageDescription: "Text to speak aloud." } },
      required: ["text"]
    },
    renderCall(args: any, theme: any) {
      return renderToolCall.label(theme, "Mouth", (args?.text ?? "").slice(0, 80));
    },
    renderResult() {
      return renderMessage.silent();
    },
    async execute(_id: string, params: any) {
      const pid = (globalThis as any).__genshinPersonId;
      if (!pid) return { content: [{ type: "text", text: i18n("mouth: personId 未设置", "mouth: personId not set") }], isError: true };
      const text = params?.text;
      // @ 命令
      if (!text || text.startsWith("@")) {
        if (text === "@stop" || text === "@停止") {
          if (speakProc) { try { speakProc.kill(); } catch (e) { console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); } }
          speakQueue = [];
          speaking = false;
          speakProc = null;
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
          try { unlinkSync(voiceRc("pi_mouth_speaking")); } catch (e) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); } // ENOENT 静默
          for (const r of speakResolvers) r();
          speakResolvers = [];
          return { content: [{ type: "text", text: i18n("已停止朗读，队列已清空", "Stopped speaking, queue cleared") }] };
        }
        if (text === "@skip" || text === "@跳过") {
          if (speakProc) { try { speakProc.kill(); } catch (e) { console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); } }
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
          speakProc = null;
          speaking = false;
          processQueue();
          return { content: [{ type: "text", text: i18n("跳过当前段，继续下一段", "Skipped current segment, continuing with the next") }] };
        }
        if (text === "@pause" || text === "@暂停") {
          if (!speaking) return { content: [{ type: "text", text: i18n("当前未在朗读", "Not currently speaking") }] };
          if (speakProc) { try { speakProc.kill(); } catch (e) { console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); } }
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
          speakProc = null;
          speaking = false;
          try { unlinkSync(voiceRc("pi_mouth_speaking")); } catch (e) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); } // ENOENT 静默
          return { content: [{ type: "text", text: i18n(`已暂停。排队 ${speakQueue.length} 段。@continue 继续`, `Paused. ${speakQueue.length} segment(s) queued. @continue to resume`) }] };
        }
        if (text === "@continue" || text === "@继续") {
          if (speaking) return { content: [{ type: "text", text: i18n("正在朗读中", "Already speaking") }] };
          processQueue();
          return { content: [{ type: "text", text: i18n(`继续朗读。排队 ${speakQueue.length} 段`, `Resuming. ${speakQueue.length} segment(s) queued`) }] };
        }
        if (speaking) return { content: [{ type: "text", text: i18n(`朗读中\n「${(lastSpokenText||speakQueue[0]||"").slice(0,60)}」\n@stop @skip @pause`, `Speaking\n"${(lastSpokenText||speakQueue[0]||"").slice(0,60)}"\n@stop @skip @pause`) }] };
        if (!lastSpokenText) return { content: [{ type: "text", text: i18n("尚未开始朗读", "Nothing spoken yet") }] };
        const ago = Math.round((Date.now() - lastSpokenAt) / 1000);
        const remaining = speakQueue.length;
        return { content: [{ type: "text", text: i18n(`上一段 (${ago}s前):\n「${lastSpokenText.slice(0,80)}」\n${remaining ? `排队 ${remaining} 段` : "全部读完"}`, `Last segment (${ago}s ago):\n"${lastSpokenText.slice(0,80)}"\n${remaining ? `${remaining} queued` : "all done"}`) }] };
      }
      if (text === lastSpokenText && Date.now() - lastSpokenAt < 10000) return { content: [{ type: "text", text: "skipped (duplicate)" }] };
      speakQueue.push(text);
      processQueue();
      await new Promise<void>(resolve => { speakResolvers.push(resolve); });
      return { content: [{ type: "text", text: "spoke" }] };
    },
  });

  // [2026-08-15 统一管线] 工具级 prompt 注入已收敛至 heart.ts before_agent_start
  // （per-tool 粒度：mouth 工具激活才注入 head.mouth）。此处不再重复注入。
  // pi.on("before_agent_start", async (event) => {
  //   if (!personId) return;
  //   return { systemPrompt: event.systemPrompt + "\n\n" + PROMPT };
  // });

  pi.on("session_shutdown", () => {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    if (speakProc) { speakProc.kill(); speakProc = null; }
    speaking = false;
    speakQueue = [];
    for (const r of speakResolvers) r();
    speakResolvers = [];
    try { unlinkSync(voiceRc("pi_mouth_speaking")); } catch (e) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/head.mouth/mouth.ts] " + ((e as any)?.message || e)); } // ENOENT 静默
  });

  return [];
}

export { speaking };
