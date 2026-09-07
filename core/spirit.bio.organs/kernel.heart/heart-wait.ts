// kernel.heart/wait — 独立 wait 工具（从 next.ts 拆出）
// 文档: B.docs/Dev.Common/Wiki/Heart(Organ&Kernel).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { join } from "node:path";
import { runtimeCacheDir } from "#paths";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { heartState, setHasUserMessage, transition, dlog, personId, isWaitDisabled } from "./heart-state.ts";

export function registerWaitTool(pi: ExtensionAPI) {
  registerPaimonTool({
    name: "wait",
    label: "Wait",
    messageDescription:
      "Pause for N seconds before auto-resuming. Use when you need to wait for something or give the user time.\n" +
      "- wait_for_user: true = spend pause listening for user input\n" +
      "- next_steps: what to do when you wake up",
    promptSnippet: "wait({seconds:N}) to pause, wait({seconds:N, wait_for_user:true}) to listen",
    parameters: Type.Object({
      seconds: Type.Number({ messageDescription: "Seconds to pause (1-86400)" }),
      wait_for_user: Type.Optional(Type.Boolean({ messageDescription: "Listen for user input during wait" })),
      next_steps: Type.Optional(Type.String({ messageDescription: "What to do when you wake up" })),
      message: Type.Optional(Type.String({ messageDescription: "Optional message shown during wait (e.g. reason)" })),
    }),
    renderCall(args: any, theme: any) {
      const s = args?.seconds ?? "?";
      const wu = args?.wait_for_user ? " (for user)" : "";
      const msg = args?.message ? ` — ${args.message}` : "";
      const ns = args?.next_steps ? ` ${args.next_steps}` : "";
      return renderToolCall.label(theme, "Wait", `${s}s${wu}${msg}${ns}`);
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      // wait 由 spinner 系统接管显示，结束后由 continuous-resume 消息渲染 "• Waited XXs"
      return renderMessage.silent();
    },
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as { seconds: number; wait_for_user?: boolean; next_steps?: string; message?: string };
      // 已在阻塞态：
      // - resting（自身 wait 造成）→ 接管重新计时：安静清掉旧 timer 后走新 wait，不拒绝。
      //   修复 "Already resting. Ignoring wait." 死循环——terminate:true 依赖外部
      //   agent-session.js override（install.sh 部署），override 缺失时 agent loop
      //   不终止，模型会在 resting 状态反复调 wait，被拒后形成死循环（2026-08-13 报修）。
      // - hibernated / paused / error-backoff → 拒绝（wait 不该覆盖这些状态）
      const curState = heartState();
      if (curState !== "working") {
        if (curState === "resting") {
          (globalThis as any).__genshinWaitReason = ""; // 安静接管，不发中断消息
          transition({ kind: "working" }); // exitState 清旧 resumeTimer/countdownTimer + main-resting 文件
          dlog(`wait: takeover previous wait (resting→working), restart ${params.seconds}s`);
        } else {
          return { content: [{ type: "text", text: `Already ${curState}. Ignoring wait.` }] };
        }
      }
      if (isWaitDisabled()) {
        return { content: [{ type: "text", text: i18n("ERR: wait 已被禁用（/wait off）。用 hibernate 休息。", "ERR: wait is disabled (/wait off). Use hibernate to rest.") }], details: {}, isError: true };
      }
      // 兜底：清掉可能残留的陈旧打断标记——exitState 读这个标记判定"是否被打断"，
      // 若 wait 外（paused/hibernated 等）遗留了 user/command 标记，正常结束也会被误标
      // 成 interrupt（2026-08-15 用户报：同时出现红色 interrupted 折线和绿色 Waited 行）
      (globalThis as any).__genshinWaitReason = "";
      const secs = Math.max(1, params.seconds);
      const waiting = params.wait_for_user === true;
      setHasUserMessage(false);
      // 中断标记按 toolCallId 记录（__genshinWaitInterruptedId），不再用全局布尔复位——
      // 全局布尔会被新一轮 wait 清掉，导致上一个被打断的 wait 点翻绿（2026-08-14 用户报修）

      let remaining = secs;
      // 只提供纯倒计时 "7s/45s" 和 waiting-for-user 标志，前缀与括号由
      // statebar._restingTick 统一拼装（issue 071 附带：与 Working 显示同构，
      // 否则 bg 任务信息会拼到括号外面）。
      const label = () => {
        const elapsed = secs - remaining;
        // 根据总数选择单位：xs / xmxs / xhxm，elapsed 和 total 同单位
        const fmt = (s: number) => {
          if (secs >= 3600) { const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); return m > 0 ? `${h}h ${m}m` : `${h}h`; }
          if (secs >= 60) { const m = Math.floor(s/60); const sec = s%60; return m > 0 ? (sec > 0 ? `${m}m ${sec}s` : `${m}m`) : `${sec}s`; }
          return `${s}s`;
        };
        return `${fmt(elapsed)}/${fmt(secs)}`;
      };
      (globalThis as any).__genshinWaitForUser = waiting;
      // 2026-09-07（wait 折线颜色稳定化）：记本次 wait 是否 forUser（不随打断清——ESC/Ctrl+C 打断会清 ForUser，
      // 导致 wait for user 被 ESC 打断后用户又发消息仍画红——按 wait 属性判定稳定）
      (globalThis as any).__genshinWaitWasForUser = waiting;

      const countdownTimer = setInterval(() => {
        if (heartState() !== "resting") { clearInterval(countdownTimer); return; }
        if (globalThis.__piEscJustPressed === true) {
          globalThis.__piEscJustPressed = false;
          (globalThis as any).__genshinWaitReason = "esc";
          dlog("countdown: ESC → paused");
          (globalThis as any).__genshinWaitLabel = null;
          (globalThis as any).__genshinWaitForUser = false;
          transition({ kind: "paused", reason: "esc" });
          setHasUserMessage(false);
          return;
        }
        remaining--;
        if (remaining <= 0) { clearInterval(countdownTimer); return; }
        // 倒计时写入 globalThis，由 statebar._restingTick 与后台任务数拼装成一行
        // （issue 071 附带：原直接 setWorkingMessage 与 _restingTick 的 bg 消息互相覆盖）
        (globalThis as any).__genshinWaitLabel = label();
      }, 1000);

      // 立即写入初始倒计时（0s/50s），不等第一个 interval tick——
      // 否则 footer 要 1 秒后才出现倒计时（statebar._restingTick 在 transition 时就会读取）
      (globalThis as any).__genshinWaitLabel = label();

      const resumeTimer = setTimeout(() => {
        if (heartState() !== "resting") return;
        if (globalThis.__piEscJustPressed === true) {
          globalThis.__piEscJustPressed = false;
          (globalThis as any).__genshinWaitReason = "esc";
          dlog("resumeTimer: ESC → paused");
          (globalThis as any).__genshinWaitLabel = null;
          (globalThis as any).__genshinWaitForUser = false;
          transition({ kind: "paused", reason: "esc" });
          return;
        }
        dlog("resumeTimer: FIRED → alive");
        (globalThis as any).__genshinWaitLabel = null;
        (globalThis as any).__genshinWaitForUser = false;
        transition({ kind: "working" });
        try {
          // wait 结束消息：与唤醒 follow 同一条送达；带 next_steps 帮助模型恢复上下文
          let wakeMsg = i18n(`[wait ${secs}s 结束]`, `[wait ${secs}s ended]`);
          if (params.next_steps) wakeMsg += ` (next: ${params.next_steps})`;
          sendCustomMessage(pi, "continuous-resume", wakeMsg, { resumeType: "wait", noTopSpacer: true });
        } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-wait.ts] " + ((e as any)?.message || e)); }
      }, secs * 1000);

      transition({ kind: "resting", resumeTimer, countdownTimer, waitSecs: secs, waiting, toolCallId: _id, ts: Date.now() });
      try {
        const pid = personId();
        if (pid) require("fs").writeFileSync(join(runtimeCacheDir(pid), "main-resting"), String(Date.now()), "utf8");
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-wait.ts] " + ((e as any)?.message || e)); }
      // 注意：不再调 setWorkingMessage——倒计时由 statebar._restingTick 通过 __genshinWaitLabel 统一拼装，
      // 旧残留的 setWorkingMessage(label()) 会覆盖 footer 闪现裸 "0/50s"（issue 071 修复残留）
      dlog(`wait:${secs}s`);
      // terminate:true is handled by the agent-session.js override (god.frontend.tui/overrides).
      // It calls runner.abortFn() which stops the agent loop before the next turn.
      // renderResult 已改为 spinner(.75)，content 不再显示，保留 details 供状态机使用
      return { content: [{ type: "text", text: "" }], details: { wait: secs, waiting }, terminate: true };
    },
  });
}
