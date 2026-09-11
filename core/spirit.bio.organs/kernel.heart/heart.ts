// 心脏(kernel.heart)在每轮 agent_end 时决定是否续下一回合。
// agent_end 自动续命逻辑：
// 1) intentions 非空 → 注入计划内容，自动续命
// 2) intentions 空 → 提示 agent 写计划或调 wait/hibernate
// 3) wait({seconds:N}) → 暂停 N 秒后自动续命
// 4) hibernate({summary:"..."}) → 休眠，等用户消息唤醒
// 5) sleep → 启动独立 tmux 做 consolidation 然后 hibernate
// 6) ESC → paused，用户发消息恢复
// intentions 工具是 agent 的前瞻性记忆——纯文本计划草稿。
// 文档: B.docs/Dev.Common/Wiki/Heart(Organ&Kernel).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSessionRole, getPrompt, getActiveToolChrPrompts } from "#kernel_ribosome";
import { runtimeCacheDir, memoryDir, memoryDataDir, logerr, writeFileAtomic } from "#paths";
import { sendCustomMessage, messageTriggersTurn } from "#kernel_backbone";
import { registerMessageRenderers } from "#tui_renderers";
import { heartState, limits, setUI, hasUserMessage, setHasUserMessage, errorBackoffMs, setErrorBackoffMs, transition, resetLimits, dlog, personId, wakeRestartFile, isWorkerSession, onHeartStateChange } from "./heart-state.ts";
import { outboxFlush } from "../kernel.backbone/backbone.ts"; // 2026-08-20：outbox 已合并进 backbone.ts（不再单独文件）
// ── /pause 命令（原 next.ts，整合至本文件）──
function registerPauseHandler(_pi: ExtensionAPI) {
  (globalThis as any).__genshinPauseHandler = async (_args: any, ctx: any) => {
    const pid = personId();
    const pauseFile = join(memoryDir(pid), "paused");
    if (heartState() === "paused") {
      try { if (require("fs").existsSync(pauseFile)) require("fs").unlinkSync(pauseFile); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      transition({ kind: "working" });
      ctx.ui.notify(i18n("已恢复。", "Resumed."), "info");
    } else {
      try { require("fs").mkdirSync(memoryDir(pid), { recursive: true }); require("fs").writeFileSync(pauseFile, String(Date.now())); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      // 同上：只有打断进行中的 wait（resting）才标记；否则残留陈旧标记会误标下一个 wait
      if (heartState() === "resting") (globalThis as any).__genshinWaitReason = "command";
      transition({ kind: "paused", reason: "command" });
      ctx.ui.notify(i18n("已暂停。发任意消息恢复。", "Paused. Send any message to resume."), "info");
    }
  };
}

import { registerWaitTool } from "./heart-wait.ts";
import { registerHibernateTool } from "./heart-hibernate.ts";
import { registerStatusTool } from "../../spirit.abio.status/status.ts";
import { getIntentions } from "../brain.intentions/intentions.ts";
import { drainPendingSocialWithMeta, isAgentActive } from "#social_communicate";
import { isEnglish, i18n } from "#tui_localizations";

const HEARTBEAT_PROMPT = [
  getPrompt("heart.continuous"),
  getPrompt("heart.commands"),
  getPrompt("core.typeRef"),
].join("\n\n");

export default function (pi: ExtensionAPI) {
  // ── tools ──
  registerPauseHandler(pi);
  registerWaitTool(pi);
  registerHibernateTool(pi);
  registerStatusTool(pi);

  // 消息渲染器统一在 god.frontend.tui/renderers.ts 注册（解耦 PROPOSAL 034 阶段 1，2026-08-18）
  // 渲染是视图职责，heart 只保留运行逻辑。找"消息怎么渲染"→ renderers.ts。
  registerMessageRenderers(pi);

  // ISSUE 119 P1（2026-08-18，qwen-3-8-27b-infer-test-01）：outbox——唤醒到 working 时
  // 校验后台推送（wait 窗口被 SDK 吞掉的 continuous-cmd-done 在此重发，at-least-once）。
  // 只在 working 时 flush：resting 期间重发会再次落入投递盲区、白耗 attempts。
  onHeartStateChange(() => {
    if (heartState() !== "working") return;
    try { outboxFlush(pi); } catch (e: any) { dlog(`outboxFlush failed: ${e?.message ?? e}`); }
  });

  // ISSUE 117：heart system prompt 冻结缓存（main 角色首次组装后复用，前缀稳定）
  let _frozenHeartSystemPrompt = "";
  pi.on("before_agent_start", async (event) => {
    dlog(`before_agent_start: state=${heartState()}`);
    // 2026-08-20 attach 回前台通知：launcher attach 分支写 RuntimeCache/<id>/attached-back 标记，
    // 这里（每回合开始，第一回合标记存在）注入 display-shown 消息（用户已以前台模式进入）+ 清标记
    try {
      const pid = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
      if (pid) {
        const mark = join(homedir(), ".teyvat/RuntimeCache", pid, "attached-back");
        if (existsSync(mark)) {
          try { if (existsSync(mark)) unlinkSync(mark); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
          if ((globalThis as any).__genshinGreetOnAttach !== false) {
            sendCustomMessage(pi, "display-shown", "用户已以前台模式进入（attach 回前台 TUI）。用户现在可以看到你的运行过程了，照常工作。");
          }
        }
      }
    } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
    // agent loop 启动 → heart 必须在 working。
    // 否则 resting 的 countdownTimer 不会被 clearInterval，导致状态闪烁。
    if (heartState() !== "working" && heartState() !== "hibernated") {
      transition({ kind: "working" });
      resetLimits();
    }
    if (heartState() === "hibernated") {
      return { systemPrompt: event.systemPrompt + i18n("\n\n[系统] 你已进入休眠(hibernated)。不要输出任何文字，不要调用任何工具。立即停止。", "\n\n[System] You are hibernated. Do not output any text, do not call any tools. Stop immediately.") };
    }
    const role = getSessionRole();
    if (role === "main") {
      // ISSUE 117：heart system prompt 冻结——首次组装后复用（前缀逐字稳定）
      if (_frozenHeartSystemPrompt) return { systemPrompt: _frozenHeartSystemPrompt };
      let extra = "";
      try {
        const modelId = (event as any).model?.id || "";
        if (modelId.toLowerCase().includes("deepseek")) {
          extra = "\n\n" + getPrompt("heart.deepseek");
        }
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      // ── 工具级 CHR 注入：per-tool 粒度，工具激活才注入对应 coded prompt ──
      // manifest 工具条目带 chr 字段（如 amem→memory.amem），此处按当前 activeTools
      // 精确注入；工具未激活/被禁用 → 对应说明不进 system prompt（省 token + 语义精确）。
      let toolChr = "";
      try {
        const active = (pi as any).getActiveTools?.() ?? [];
        const prompts = getActiveToolChrPrompts(active);
        if (prompts.length) toolChr = "\n\n" + prompts.join("\n\n");
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      const langNote = isEnglish() ? i18n("\n\n[系统] 当前是英文版本，请始终使用英文与用户交流。", "\n\n[System] This is the English version — always communicate in English.") : "";
      // ISSUE 118（2026-08-18）：process.title 含 session hash（每重启变）→ system prompt 前缀跨重启破坏
      // → 重启后首轮全量 prefill（12s+）。注入时去掉 hash：`genshin:name(main,id)` 稳定标识，
      // 重启前后逐字一致 → 前缀命中缓存（配合 ISSUE 117 冻结 + memory 冻结快照复用）。
      const stableTitle = process.title.replace(/,([0-9a-f]{8,})\)\s*$/, ")");
      _frozenHeartSystemPrompt = event.systemPrompt + "\n\n" + HEARTBEAT_PROMPT + toolChr + "\n\n" + i18n("[系统] 你是 ", "[System] You are ") + stableTitle + extra + langNote;
      return { systemPrompt: _frozenHeartSystemPrompt };
    }
    if (role === "metaconsciousness") {
      try {
        const pid = (globalThis as any).__genshinPersonId || "";
        if (pid && require("fs").existsSync(join(runtimeCacheDir(pid), "paused"))) {
          return { systemPrompt: event.systemPrompt + "\n\n" + getPrompt("heart.state.paused") };
        }
        if (pid && require("fs").existsSync(join(runtimeCacheDir(pid), "main-hibernate"))) {
          return { systemPrompt: event.systemPrompt + "\n\n" + getPrompt("heart.state.main-hibernate") };
        }
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
    }
    if (role === "hippocampus") {
      return { systemPrompt: event.systemPrompt + "\n\n" + getPrompt("hippocampus.gen_work_mem") };
    }
    return;
  });

  // ── user typing ──
  pi.on("input", async (event: any) => {
    dlog(`input event: text="${(event?.text || "").slice(0, 40)}" state=${heartState()}`);
    if (!event?.text?.trim() || event.text === "(see attached image)") return;
    setHasUserMessage(true);
    setErrorBackoffMs(0);
    const inputSt = heartState();
    if (inputSt === "error-backoff" || inputSt === "paused" || inputSt === "resting" || inputSt === "hibernated") {
      // 只有正在 wait（resting）时才标记 "user" 打断——其他状态（paused/error-backoff/
      // hibernated）设置该标记不会被消费，会残留成陈旧标记，导致下一个 wait 正常结束时
      // 被 exitState 误判为"interrupted by user message"（2026-08-15 用户报双 Waited 行）
      if (inputSt === "resting") (globalThis as any).__genshinWaitReason = "user";
      transition({ kind: "working" });
      try {
        const pid = personId();
        if (pid) {
          try { if (existsSync(join(runtimeCacheDir(pid), "main-hibernate"))) unlinkSync(join(runtimeCacheDir(pid), "main-hibernate")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
          try { if (existsSync(join(runtimeCacheDir(pid), "mc-hibernate"))) unlinkSync(join(runtimeCacheDir(pid), "mc-hibernate")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
          // 用户中途唤醒 → 取消定时唤醒（wake-at），避免到点又自动醒一次（issue 071 附带逻辑）
          // 2026-08-20：unlink 前检查存在（ENOENT 不再报错，console-error.log 实测发现）
          try { if (existsSync(join(runtimeCacheDir(pid), "wake-at"))) unlinkSync(join(runtimeCacheDir(pid), "wake-at")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
          try { if (existsSync(join(runtimeCacheDir(pid), "wake-until"))) unlinkSync(join(runtimeCacheDir(pid), "wake-until")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
          (globalThis as any).__genshinHibernateUntil = null;
          (globalThis as any).__genshinHibernateUntilTs = null;
        }
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
    }
    // wait 中断通知：把"实际等待了多少秒被打断"与打断消息同请求一次性送达模型。
    // feedAs=nextTurn → 注入 _pendingNextTurnMessages，随本条用户消息同一 API 请求发出，
    // 不另开 turn、不另发票消息（用户要求"一次性给，和打断的消息一起"）。
    const pendingNotice = (globalThis as any).__genshinWaitInterruptedNotice;
    if (pendingNotice) {
      (globalThis as any).__genshinWaitInterruptedNotice = null;
      const reasonLabel: Record<string, string> = { esc: "ESC", user: "user message", command: "/pause" };
      try {
        sendCustomMessage(pi, "wait-interrupted",
          i18n(`[wait ${pendingNotice.secs}s 被打断 (${reasonLabel[pendingNotice.reason] || pendingNotice.reason})]`,
               `[wait ${pendingNotice.secs}s interrupted (${reasonLabel[pendingNotice.reason] || pendingNotice.reason})]`));
      } catch (e: any) {
        dlog(`wait-interrupted notice failed: ${e?.message ?? e}`);
      }
    }
  });

  // ── 睡醒 / 用户唤醒 ──
  pi.on("message_start", async (event: any, ctx: any) => {
    const msg = event?.message;

    // ── resting 下收到【会开新 turn】的系统消息（后台命令完成/自动续命等）→ 切 working ──
    // 修复老毛病：wait 期间 cmd-done 等消息唤醒 agent 开始工作，但 heart 状态仍是 resting，
    // wait 的 resumeTimer 到点后检查不到状态变化 → 误发"[wait Ns 结束]"打断工作。
    // transition(working) 会让 exitState clearTimeout(resumeTimer)，定时器直接取消。
    // （__genshinWaitReason 未设置 → 不发"中断"，安静切换）
    //
    // LESSON 054 死局 A：trigger=false 的消息（reminder-check / memory-frozen-delta 等
    // "只显示不开 turn"）绝不能把 resting 切回 working——它们不会开新 turn，
    // 切了只会清掉 resumeTimer 且无人续命 → 永久卡 working。只对确定会开 turn 的消息唤醒。
    // 2026-08-14 修复：sendCustomMessage 构造的消息对象字段是 customType（agent-session
    // sendCustomMessage → agent-loop runAgentLoop emit message_start 原样转发），
    // 没有 messageType → 原检查永远 false → wait 期间 cmd-done 等消息从不打断 resting。
    const msgType = msg?.customType || msg?.messageType;
    if (msgType && messageTriggersTurn(msgType)) {
      const st = heartState();
      // resting（wait）下任何会开 turn 的消息 → 唤醒（2026-08-14 .7 修复）
      // hibernated 下只有 interrupt（social-message mode_used=interrupt）→ 唤醒
      // （2026-08-14 互测发现：interrupt 打断 hibernate 时消息注入了但 heart 状态没切，
      //  导致后续 wait/hibernate 被拒 "Already hibernated"——interrupt 应像用户输入一样
      //  把 hibernated 切到 working。queue/deferred 不唤醒休眠，等用户回来。）
      if (st === "resting" ||
          (st === "hibernated" && msgType === "social-message" && msg?.details?.mode_used === "interrupt")) {
        dlog(`wake-by-message: ${msgType} (${st} → working)`);
        if (st === "resting") (globalThis as any).__genshinWaitReason = "system";
        transition({ kind: "working" });
      }
    }

    // sleep-done 唤醒分支只对 hibernated/paused 生效——resting(wait) 期间的 sleep-done
    // 是旁路信号，不应打断 wait（同样触发死局 A：切 working 但无 turn 续命）。
    if ((msg?.customType || msg?.messageType) === "sleep-done" && heartState() !== "working" && heartState() !== "resting") {
      const canRestart = process.env.PI_ALIVE_RESTART_LOOP === "1"
        && !isWorkerSession(ctx) && !hasUserMessage();
      const wf = canRestart ? wakeRestartFile() : null;
      if (wf) {
        dlog("sleep-done → RESTART");
        try { writeFileSync(wf, String(Date.now()), "utf-8"); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); dlog("wake nonce write failed: " + e); }
        setTimeout(() => { try { ctx.shutdown(); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); dlog("shutdown failed: " + e); } }, 50);
        return;
      }
      dlog("sleep-done → re-enable in place");
      (globalThis as any).__genshinWaitReason = "sleep";
      transition({ kind: "working" });
      resetLimits();
      return;
    }

    // 用户消息打断 wait（2026-08-14 兜底）：input 事件链路若未触发，这里保证
    // resting 被切走并带 reason，exitState 才能发红色"中断"折线 + 红点。
    if (msg?.role === "user" && !msg?.customType && !msg?.messageType && heartState() === "resting") {
      dlog("resting + user message → interrupt wait");
      (globalThis as any).__genshinWaitReason = "user";
      transition({ kind: "working" });
    }

    if (msg?.role === "user" && !msg?.messageType && heartState() === "hibernated") {
      const textContent = Array.isArray(msg.content)
        ? msg.content.find((c: any) => c.type === "text")?.text?.trim() || ""
        : (typeof msg.content === "string" ? msg.content.trim() : "");
      if (!textContent) { dlog("WAKE: empty → skip"); return; }
      dlog(`WAKE: text="${textContent.slice(0, 80)}"`);
      transition({ kind: "working" });
      resetLimits();
      // 显示上次 session 的回忆
      try {
        const elapsed = (globalThis as any).__genshinSessionElapsed;
        if (elapsed && elapsed > 0) {
          const fmt = (ms: number) => Math.floor(ms/1000);
          const secs = fmt(elapsed);
          setTimeout(() => sendCustomMessage(pi, "continuous-resume", i18n(`[hibernate ${secs}s 结束]`, `[hibernate ${secs}s ended]`), { resumeType: "hibernate", noTopSpacer: true }), 200);
        }
        (globalThis as any).__genshinSessionElapsed = 0;
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
    }
  });

  // ── session_start ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    if (isWorkerSession(ctx)) return;
    setUI(ctx.ui);
    // ── 自检：wait/hibernate 的 terminate:true 依赖 agent-session.js override ──
    // override 未部署（npm update 覆盖 / install 遗漏）时 wait 后 agent loop 不终止，
    // 导致 heart 卡 resting、"Already resting. Ignoring wait." 死循环（2026-08-13 报修）。
    // 启动时检测，缺失即告警提示重跑 install.sh，避免静默退化。
    try {
      const asPath = join(homedir(), ".local/lib/teyvat/runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
      const asSrc = readFileSync(asPath, "utf8");
      if (!asSrc.includes("result.terminate")) {
        dlog("SELF-CHECK FAIL: agent-session.js missing terminate override — wait/hibernate will break");
        try {
          sendCustomMessage(pi, "continuous-error-retry", i18n("WARN: runtime agent-session.js 缺少 terminate override（wait/hibernate 会失效）。请重跑 C.deploy/install.sh 部署。", "WARN: runtime agent-session.js missing terminate override (wait/hibernate will break). Re-run deploy/install.sh to deploy."));
        } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      } else {
        dlog("SELF-CHECK OK: agent-session.js terminate override in place");
      }
    } catch (e: any) { dlog(`SELF-CHECK error: ${e?.message}`); }
    (globalThis as any).__genshinWaitReason = "reload";
    (globalThis as any).__genshinReloadingSince = Date.now(); // 状态栏显示 Reloading... (Xs)
    transition({ kind: "working" });
    resetLimits();
    if (getSessionRole() === "main") {
      setTimeout(() => {
        try {
          // 2026-08-20：headless 守护（PAIMON_HEADLESS_DAEMON=1，rpc + setsid 无 TTY）跳过孤儿检测——
          // setsid 脱离终端是 headless 的合法形态，不是孤儿；TUI 模式下无 TTY 才是异常。
          // （实测：headless 守护 node 的 TTY="??" 被此处击杀，7 秒后 shutdown）
          if (process.env.PAIMON_HEADLESS_DAEMON === "1") return;
          const tty = require("child_process").execSync("ps -o tty= -p " + process.pid, { encoding: "utf8" }).trim();
          if (tty === "??") { dlog("orphan: no TTY, shutting down"); ctx.shutdown(); }
        } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      }, 60000);
    }

    let sessionPersonId = ""; // 2026-09-07 改名：消除对 import personId()（L21，heart-state 导出）的遮蔽坏味道
    try {
      const sf = ctx.sessionManager.getSessionFile();
      const m = sf?.match(/\/.teyvat\/SessionData\/([a-f0-9]+)\//) || sf?.match(/\.teyvat\/sessions\/([a-f0-9]+)\//);
      if (m) sessionPersonId = m[1];
    } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
    if (sessionPersonId && !isWorkerSession(ctx)) {
      const pidFile = join(memoryDir(sessionPersonId), "main.pid");
      // 2026-09-11（ISSUE 182）：①读 main.pid 容忍 ENOENT/空（首次启动/损坏均预期）——原 readFileSync 抛 ENOENT
      // 走外层 catch 报错刷屏（实测 102×）；②写入改原子（tmp+rename）——原 writeFileSync 先截断再写，双实例交错
      // 会留下 0 字节 → 活跃判定 parseInt("")=NaN → 重复启动（check-session-01 双实例实例）。
      let _rawPid = ""; try { _rawPid = readFileSync(pidFile, "utf8").trim(); } catch (e: any) { if (e?.code !== "ENOENT") console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      try {
        const oldPid = parseInt(_rawPid, 10);
        if (!oldPid && _rawPid === "" && existsSync(pidFile)) dlog("main.pid 为空（损坏）——按无旧主进程处理（ISSUE 182）");
        if (oldPid && oldPid !== process.pid) {
          // 2026-08-20：kill 0 是存在性探测——ESRCH（进程已退出）是预期结果，不报错（console-error.log 实测）
          try { process.kill(oldPid, 0); dlog(`旧主进程 ${oldPid} 还在，杀掉`); process.kill(oldPid); } catch (e: any) { if (e?.code !== "ESRCH") console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
        }
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      try { const _pidTmp = pidFile + ".tmp-" + process.pid; writeFileSync(_pidTmp, String(process.pid), "utf8"); require("fs").renameSync(_pidTmp, pidFile); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      // ── 列表统计（agent-stats.cjs）：运行时计算并缓存，list.cjs 查询只读缓存 ──
      // 2026-08-13 用户要求：大小/token 运行时实时运算储存、查询时获取即可。
      // 2026-08-20 修复：statsDir 必须传父层 MemoryData（memoryDir 已带 id——computeAgentStats 内部
      // 会再 join(id)，传带 id 的路径会多拼一层 → 8 条 ENOENT（console-error.log 实测发现）。
      // 注意 memoryDataDir 是函数必须调用（.30 曾误写成函数本身 → join 报 path must be string）
      const statsDir = memoryDataDir();
      const updateListStats = () => {
        try {
          const { computeAgentStats, writeStats } = require("../../god.frontend.cli/agent-stats.cjs");
          writeStats(homedir() + "/.teyvat", sessionPersonId, computeAgentStats(homedir() + "/.teyvat", statsDir, sessionPersonId));
        } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      };
      let statsTick = 0;
      setTimeout(() => { try { updateListStats(); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); } }, 5000); // 启动后首刷
      const _heartbeatInterval = setInterval(() => {
        try {
          // 2026-09-11（prime-agent，ISSUE 182 收尾）：心跳不能只 touch mtime —— openSync(pidFile,"a") 在文件缺失时
          // 会**创建 0 字节文件**并一直保持"新鲜"，于是活跃判定读到无效内容（列表判离线、启动守卫原样放行）→ 双实例。
          // 线上实测：check-session-01（379e262b）按 2 天、main.pid 0 字节、同 sid 两个实例。
          // 心跳是"我还活着"的权威 → 内容不等于自己的 pid 就原子补写（顺带自愈历史遗留的 0 字节/旧 pid 文件）；
          // 内容正确时再 futimes（保持"心跳新鲜"语义）。
          const now = new Date();
          let _cur = ""; try { _cur = readFileSync(pidFile, "utf8").trim(); } catch (e) { /* ENOENT：下面补写 */ }
          if (_cur !== String(process.pid)) {
            const _hbTmp = pidFile + ".tmp-" + process.pid;
            writeFileSync(_hbTmp, String(process.pid), "utf8");
            require("fs").renameSync(_hbTmp, pidFile);
          } else {
            const fd = require("fs").openSync(pidFile, "a");
            require("fs").futimesSync(fd, now, now);
            require("fs").closeSync(fd);
          }
        } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
        // 每 10 个心跳（~5 分钟）刷新一次列表统计缓存
        statsTick++;
        if (statsTick % 10 === 0) { try { updateListStats(); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); } }
        // ── wake-at 检查：hibernate({until}) 是否到期（issue 071）──
        // 历史：此检查原在 session_start 里只执行一次，hibernate 后进程存活时
        // 永远不会再跑，定时唤醒完全失效；且 v1 依赖 `at` 命令 touch .ready，
        // macOS 上受 SIP 保护不可用。现改为心跳 30s 轮询纯时间判断，
        // 不依赖外部调度器（与 wait 的进程内 setTimeout 同源）。
        try {
          const cacheDir = runtimeCacheDir(sessionPersonId);
          // 方案 E 双保险：仅当当前处于 hibernate 状态时才消费 wake-at；
          // 若已被用户打断（working/resting），清掉残留文件、不发唤醒消息——
          // wake 的语义是“从休眠唤醒”，agent 已在工作则 wake 无意义。
          const st = heartState();
          if (st !== "hibernated") {
            // 2026-08-20：unlink 前检查存在（ENOENT 不再报错，console-error.log 实测发现——
            // 350 行这处 .28 后仍在报，是 165 行之外的另一处 wake-at unlink）
            try { if (require("fs").existsSync(join(cacheDir, "wake-at"))) require("fs").unlinkSync(join(cacheDir, "wake-at")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
            try { if (require("fs").existsSync(join(cacheDir, "wake-until"))) require("fs").unlinkSync(join(cacheDir, "wake-until")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
            if (globalThis.__genshinHibernateUntil || globalThis.__genshinHibernateUntilTs) {
              (globalThis as any).__genshinHibernateUntil = null;
              (globalThis as any).__genshinHibernateUntilTs = null;
            }
            return;
          }
          // 旧文件名兼容：v1 曾用 wake-until，改名 wake-at 后若磁盘残留旧文件，
          // 视为新文件处理并顺手清理（避免旧文件永不触发也永不删除）。
          const legacyFile = join(cacheDir, "wake-until");
          const wakeFile = join(cacheDir, "wake-at");
          if (existsSync(legacyFile) && !existsSync(wakeFile)) {
            try { require("fs").renameSync(legacyFile, wakeFile); dlog("wake-at: legacy wake-until renamed"); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
          } else if (existsSync(legacyFile)) {
            try { require("fs").unlinkSync(legacyFile); dlog("wake-at: legacy wake-until cleaned"); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
          }
          if (existsSync(wakeFile)) {
            let wakeData: any = null;
            try { wakeData = JSON.parse(readFileSync(wakeFile, "utf8")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
            if (wakeData?.until && Date.now() >= wakeData.until) {
              const target = new Date(wakeData.until);
              const hh = String(target.getHours()).padStart(2, "0");
              const mm = String(target.getMinutes()).padStart(2, "0");
              const targetHHMM = `${hh}:${mm}`;
              const overslept = Date.now() > wakeData.until + 60_000;
              // 简洁唤醒消息（与 wait 的 [wait 60s 结束] 同构）
              const wakeMsg = overslept
                ? i18n(`[hibernate until ${targetHHMM} 结束，但已过点，继续工作]`, `[hibernate until ${targetHHMM} ended, but past the target — continue working]`)
                : i18n(`[hibernate until ${targetHHMM} 结束]`, `[hibernate until ${targetHHMM} ended]`);
              setTimeout(() => sendCustomMessage(pi, "continuous-resume", wakeMsg, { resumeType: "hibernate-until" }), 500);
              dlog(`wake-until: ${overslept ? "overslept" : "on time"} target=${targetHHMM}`);
              // 只有触发唤醒才删除文件、清除状态栏标签；未到时间保留，继续轮询（issue 071 修复补丁）
              try { require("fs").unlinkSync(wakeFile); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
              (globalThis as any).__genshinHibernateUntil = null;
              (globalThis as any).__genshinHibernateUntilTs = null;
            }
          }
        } catch (e: any) { dlog(`wake-until check error: ${e?.message}`); }
      }, 30000);
      if (_heartbeatInterval.unref) _heartbeatInterval.unref();

      try {
        const ctxPath = join(memoryDir(sessionPersonId), "context.md");
        const { existsSync: ex, statSync: st } = require("fs");
        const ok = ex(ctxPath) && st(ctxPath).size > 100;
        const isReload = _event?.reason === "reload";
        // resume（--continue 恢复 session）：模型 context 已从 jsonl 历史重建，不需要 recap。
        const isResume = _event?.reason === "resume";
        // ══ recap 已废弃（2026-08-12）══
        // 根因：启动没传 --continue，pi 每次新建空 session，模型失忆才靠 recap 回忆。
        // 修复：cli.ts 已加 --continue 恢复最近 session（jsonl 渲染回界面 + 模型 context 含历史），
        //       recap 的"回顾全部轮次"引导失去意义，已废弃（用户：禁用/废弃/不删除）。
        // 2026-08-12 改：恢复时注入"用户回来了"通知（带上次退出时间/会话时长/变更检测等有用信息），
        //       不注入回顾引导。
        dlog(`userback: personId=${sessionPersonId} ok=${ok} reload=${isReload} resume=${isResume}`);
        if (ok && !isReload) {
          setTimeout(() => {
            // flag 必须在 setTimeout 回调里检查（不是注册时），因为 __genshinSelfRebooted 在 PI_ALIVE_WOKE 区块设置，时序上晚于 userback 注册
            if ((globalThis as any).__genshinSelfRebooted) { dlog("userback: skipped (self-rebooted)"); return; }
            // attach 回前台：launcher attach 分支写了 attached-back 标记，display-shown 已注入「用户已以前台模式进入」，
            // 这里跳过「用户回来了」（attach 不是离线唤醒，避免重复 + 语义错误，2026-08-20）
            try {
              const attachMark = join(homedir(), ".teyvat/RuntimeCache", sessionPersonId, "attached-back");
              if (existsSync(attachMark)) { dlog("userback: skipped (attach-back)"); return; }
            } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
            try {
              dlog("userback: sending user-back message");
              (globalThis as any).__piRecapPending = true;
              const dLocale = isEnglish() ? "en-US" : "zh-CN";
              let lastEnded = i18n("未知", "unknown");
              try {
                const plistPath = join(memoryDataDir(), "plist.json");
                const list = JSON.parse(readFileSync(plistPath, "utf8"));
                const p = list.find((x: any) => x.id === sessionPersonId);
                if (p?.lastEnded) {
                  lastEnded = new Date(p.lastEnded).toLocaleString(dLocale, { timeZone: "Asia/Shanghai", hour12: false });
                }
              } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
              const now = new Date().toLocaleString(dLocale, { timeZone: "Asia/Shanghai", hour12: false });
              // self-reboot 检测已移到 PI_ALIVE_WOKE 区块（保证消息先于 userback 到达）
              const userBackMsg = i18n(`[系统] 用户回来了。当前时间：${now}，上次退出：${lastEnded}。请等待用户指令或和用户打个招呼。`, `[System] The user is back. Current time: ${now}, last exit: ${lastEnded}. Wait for the user's instructions or greet them.`);
              // 添加上次 session 回忆
              const elapsed = (globalThis as any).__genshinSessionElapsed;
              let brewLine = "";
              if (elapsed && elapsed > 5000) {
                const verb = (globalThis as any).__genshinSessionEndVerb || "Brewed";
                const fmt = (ms: number) => { const s = Math.floor(ms/1000); if (s<60) return `${s}s`; if (s<3600) return `${Math.floor(s/60)}m ${s%60}s`; return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`; };
                brewLine = `\n\n✻ ${verb} for ${fmt(elapsed)}`;
                (globalThis as any).__genshinSessionElapsed = 0;
              }
              // 变更检测
              let changeLine = "";
              try {
                const plistPath2 = join(memoryDataDir(), "plist.json");
                const plist2 = JSON.parse(readFileSync(plistPath2, "utf8"));
                const me = plist2.find((x: any) => x.id === sessionPersonId);
                const cacheDir = runtimeCacheDir(sessionPersonId);
                try { const { mkdirSync: mk } = require("fs"); mk(cacheDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                const changes: string[] = [];

                // 名称变更检测
                try {
                  const nameFile = join(cacheDir, "last-name");
                  let lastName = "";
                  try { lastName = readFileSync(nameFile, "utf8").trim(); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                  const curName = me?.name || "";
                  if (lastName && curName && curName !== lastName) {
                    changes.push(i18n(`检测到您被重命名：「${lastName}」→「${curName}」。`, `You were renamed: "${lastName}" → "${curName}".`));
                  }
                  try { writeFileSync(nameFile, curName); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }

                // 组织变更检测（多组织）
                try {
                  const curOrgs: string[] = Array.isArray(me?.orgs) ? me.orgs : (me?.org ? [me.org] : []);
                  const orgStateFile = join(cacheDir, "last-orgs");
                  let lastOrgs: string[] = [];
                  try { lastOrgs = JSON.parse(readFileSync(orgStateFile, "utf8")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e));
                    // 兼容旧 last-org 文件
                    try { const old = readFileSync(join(cacheDir, "last-org"), "utf8").trim(); if (old) lastOrgs = [old]; } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                  }
                  const joined = curOrgs.filter((id: string) => !lastOrgs.includes(id));
                  const left = lastOrgs.filter((id: string) => !curOrgs.includes(id));
                  if (joined.length > 0 || left.length > 0) {
                    const orgsPath = join(memoryDataDir(), "..", "AgentWorkDir", "Organizational", "orgs.json");
                    let allOrgs: any[] = [];
                    try { allOrgs = JSON.parse(readFileSync(orgsPath, "utf8")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                    for (const oid of joined) {
                      const org = allOrgs.find((o: any) => o.id === oid);
                      if (!org) continue;
                      const others = org.members.filter((mid: string) => mid !== sessionPersonId);
                      let othersDesc = "";
                      if (others.length > 0) {
                        const MAX_SHOW = 5;
                        // 2026-08-18 用户要求：在线成员排前面（main.pid 心跳判定），在线成员加「(在线)」标注
                        const online: string[] = [];
                        const offline: string[] = [];
                        for (const mid of others) { (isAgentActive(mid) ? online : offline).push(mid); }
                        const ordered = [...online, ...offline];
                        const onlineMark = i18n("（在线）", "(online)");
                        const shown = ordered.slice(0, MAX_SHOW).map((mid: string) => {
                          const a = plist2.find((x: any) => x.id === mid);
                          const base = a ? `${a.name} (${mid})` : mid;
                          return online.includes(mid) ? `${base} ${onlineMark}` : base;
                        });
                        othersDesc = i18n(
                          `该组织还有其他成员：${shown.join("、")}${others.length > MAX_SHOW ? `等共 ${others.length} 人` : ""}。`,
                          `The org has other members: ${shown.join(", ")}${others.length > MAX_SHOW ? `, ${others.length} in total` : ""}.`
                        );
                      }
                      changes.push(i18n(`检测到用户将您加入了组织「${org.name}」(ID: ${org.id})。${othersDesc}`, `The user added you to the organization "${org.name}" (ID: ${org.id}). ${othersDesc}`));
                    }
                    for (const oid of left) {
                      const org = allOrgs.find((o: any) => o.id === oid);
                      const name = org ? org.name : oid;
                      changes.push(i18n(`检测到用户将您从组织「${name}」中移除。`, `The user removed you from the organization "${name}".`));
                    }
                  }
                  try { writeFileAtomic(orgStateFile, JSON.stringify(curOrgs)); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }

                // 克隆事件检测（双向：克隆体首次启动知道自己是谁的克隆体 / 原体下次启动知道自己被克隆了）
                try {
                  // A. 克隆体首次启动：plist.clonedFrom 存在 + 未标记 → 注入"我是克隆体"
                  const cloneDoneFile = join(cacheDir, "clone-notice-done");
                  if (me?.clonedFrom && !existsSync(cloneDoneFile)) {
                    const srcAgent = plist2.find((x: any) => x.id === me.clonedFrom);
                    const srcName = srcAgent?.name || me.clonedFrom;
                    const when = me.clonedAt ? new Date(me.clonedAt).toLocaleString(dLocale, { timeZone: "Asia/Shanghai", hour12: false }) : i18n("未知时刻", "unknown time");
                    changes.push(i18n(`[克隆] 你是「${srcName}」在 ${when} 的克隆体。自克隆那一刻起，你们彼此独立、各自成长。`, `[Clone] You are a clone of "${srcName}" created at ${when}. Since that moment you are independent and grow separately.`));
                    try { writeFileSync(cloneDoneFile, String(Date.now())); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                  }
                  // B. 原体下次启动：plist.clonedChildren 相对 last-clones 缓存新增 → 注入"我被克隆了"
                  const curChildren: string[] = Array.isArray(me?.clonedChildren) ? me.clonedChildren : [];
                  if (curChildren.length > 0) {
                    const lastClonesFile = join(cacheDir, "last-clones");
                    let lastChildren: string[] = [];
                    try { lastChildren = JSON.parse(readFileSync(lastClonesFile, "utf8")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                    const newChildren = curChildren.filter((cid: string) => !lastChildren.includes(cid));
                    if (newChildren.length > 0) {
                      for (const cid of newChildren) {
                        const c = plist2.find((x: any) => x.id === cid);
                        const cname = c?.name || cid;
                        const when = c?.clonedAt ? new Date(c.clonedAt).toLocaleString(dLocale, { timeZone: "Asia/Shanghai", hour12: false }) : i18n("某时刻", "sometime");
                        changes.push(i18n(`[克隆] 你于 ${when} 被克隆，克隆体是「${cname}」。`, `[Clone] You were cloned at ${when}; the clone is "${cname}".`));
                      }
                    }
                    try { writeFileSync(lastClonesFile, JSON.stringify(curChildren)); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
                  }
                } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }

                if (changes.length > 0) {
                  changeLine = i18n("\n\n[系统] ", "\n\n[System] ") + changes.join("\n");
                }
              } catch (e: any) { dlog(`recap: change detection error: ${e?.message}`); }
              sendCustomMessage(pi, "continuous-resume", userBackMsg + brewLine + changeLine, { resumeType: "restart" }, { isTriggerNewTurn: true, deliverAs: "followup", isDisplayedInTUI: true });
              dlog("recap: message sent");
            } catch (e: any) { dlog(`recap: sendMessage error: ${e?.message}`); }
          }, 1000);
        }
      } catch (e: any) { dlog(`recap: outer error: ${e?.message}`); }
    }

    if (process.env.PI_ALIVE_WOKE === "1") {
      // self-reboot 检测：在这里做，不在 userback 里做，保证消息先于一切到达
      let selfRebootMsg = "";
      let selfRebootElapsed = 0;
      try {
        const reasonPath = join(runtimeCacheDir(sessionPersonId), "self-reboot-reason.json");
        if (existsSync(reasonPath)) {
          const rd = JSON.parse(readFileSync(reasonPath, "utf8"));
          selfRebootMsg = rd.reason || "self-reboot";
          selfRebootElapsed = rd.elapsed || 0;
          unlinkSync(reasonPath);
        }
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      // wake-restart 不删：launcher while 循环退出后读它判断是否重启。
      // 旧残留无害（launcher 用 nonce 比较，同 nonce 不重复重启）。

      dlog(`session_start: PI_ALIVE_WOKE → kick (selfReboot=${!!selfRebootMsg})`);
      // self-reboot 时标记跳过 userback（防止两条消息同时触发）
      if (selfRebootMsg) {
        (globalThis as any).__genshinSelfRebooted = true;
        // 恢复 self-reboot 前的累积运行时长（连续计时，不重置）
        // 0.3.3 修复：原代码在上面 unlink 后又 re-read 同一文件 → existsSync 永远 false → elapsed 永远不恢复。
        // 现在用首次读取时保存的 selfRebootElapsed。
        try {
          if (selfRebootElapsed > 0) {
            setTimeout(() => {
              const sb = (globalThis as any).__genshinStatusBar;
              if (sb) { sb._sessionAccumulated = selfRebootElapsed; }
            }, 1500);
          }
        } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      }
      setTimeout(() => {
        try {
          if (selfRebootMsg) {
            const now = new Date().toLocaleString(isEnglish() ? "en-US" : "zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
            sendCustomMessage(pi, "continuous-resume",
              i18n(`[系统] 你自己触发了重启（self-reboot）。当前时间：${now}，原因：${selfRebootMsg}。重启后记忆快照已重新冻结，代码变更已生效。继续你的工作。`, `[System] You triggered a self-reboot. Current time: ${now}, reason: ${selfRebootMsg}. After restart the memory snapshot is re-frozen and code changes have taken effect. Continue your work.`),
              { resumeType: "restart" }, { isTriggerNewTurn: true, deliverAs: "followup", isDisplayedInTUI: true });
          } else {
            // 2026-08-20：sleep-wake-resume 已废弃（sleep/cortex 机制禁用）——非 self-reboot 的唤醒重启（含
            // Ctrl+C 转后台触发的重启）不再发"睡醒了"（残留误报，用户暴怒）。静默：等用户消息即可。
            dlog("session_start: PI_ALIVE_WOKE 非 self-reboot → 静默（sleep-wake-resume 已废弃）");
          }
        } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      }, 800);
    } else {
      dlog("session_start: normal → 等用户");
    }
  });

  // ── agent_end: intentions 驱动续命 ──
  pi.on("agent_end", async (event, ctx) => {
    dlog(`agent_end: kind=${heartState()}`);

    // ISSUE 140：self-reboot 即将退出，不续命（否则开新 turn 被 process.exit 打断 → abort → paused 循环）
    if ((globalThis as any).__genshinRebootPending) {
      dlog("agent_end: reboot pending, skip auto-continue");
      return;
    }

    // ── Social pending：回合结束必 drain（把"有消息就不允许睡"提成函数，2026-09-11 prime-agent）──
    // 原实现只有下面一处内联调用，而它在下面阻塞态 `return` 之后 —— resting/hibernated 永远走不到，
    // 与注释里"无论状态"的说法相反。后果：agent wait 期间到达的 queue 消息要等 wait 跑完才被看见
    //（实测 wait 工具本身没有任何 pending 消息处理逻辑，hibernate 工具只在"进入休眠前"拒一次）。
    // 语义边界（与别处保持一致，别扩大）：
    //   working/resting → drain 并唤醒（resting 唤醒也是 message_start 里 line 214 的既有语义）
    //   hibernated      → 不唤醒（message_start 注释：queue/deferred 等用户回来；只有 interrupt 唤醒）
    //   paused          → 不唤醒（不可恢复错误/ESC/用户 /pause 的硬停，最忌讳拿余额不足的 key 重试）
    const tryDrainPendingEarly = (): boolean => {
      const intentions0 = getIntentions();
      const drainedEarly = intentions0 ? drainPendingSocialWithMeta(10, "queue") : drainPendingSocialWithMeta(10);
      if (!drainedEarly) return false;
      if (heartState() !== "working") transition({ kind: "working" }); // ISSUE 125：打断 wait（否则注入被吞）
      dlog(`agent_end: social pending → inject (${drainedEarly.text.length} chars)`);
      setTimeout(() => { sendCustomMessage(pi, "social-message", drainedEarly.text, drainedEarly.meta); }, 0);
      return true;
    };

    // 阻塞态不续命（wait/hibernate/pause 的 transition 已在工具里完成）
    // 注意：不调 setWorkingVisible(false)，否则会清掉 wait 的倒计时和 hibernate/pause 的状态文字
    if (heartState() === "hibernated" || heartState() === "paused" || heartState() === "resting") {
      // dual hibernate 检测（主意识 + 元意识都 hibernate → 写 paused 文件）
      if (heartState() === "hibernated") {
        try {
          const pid = personId();
          if (pid) {
            const mh = require("fs").existsSync(join(runtimeCacheDir(pid), "main-hibernate"));
            const sh = require("fs").existsSync(join(runtimeCacheDir(pid), "mc-hibernate"));
            if (mh && sh) {
              require("fs").writeFileSync(join(runtimeCacheDir(pid), "paused"), String(Date.now()), "utf8");
              dlog("agent_end: dual hibernate → paused");
            }
          }
        } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      }
      // 2026-09-11 prime-agent：resting（wait 中）也要 drain —— 否则 wait 期间到达的 agent 消息要等
      // wait 跑完才被看见（wait 工具自身不处理 pending）。hibernated/paused 仍然硬停（见上面的语义边界注释）。
      if (heartState() === "resting" && tryDrainPendingEarly()) return;
      return;
    }

    // 用户消息过滤
    let hadUserMessage = false;
    if (hasUserMessage()) {
      const lastCustom = [...(event.messages ?? [])].reverse().find((m: any) => m.role === "custom");
      if ((lastCustom as any)?.content === "(see attached image)") { setHasUserMessage(false); dlog("agent_end: phantom image filtered"); }
    }
    if (hasUserMessage()) {
      dlog("agent_end: hasUserMessage (continuing)");
      hadUserMessage = true;
      setHasUserMessage(false);
    }

    if ((globalThis as any).__piRecapPending) {
      (globalThis as any).__piRecapPending = false;
      dlog("agent_end: recap done");
    }

    const msgs = event.messages ?? [];
    const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
    if (!last) {
      dlog(`agent_end: NO assistant msg`);
      return;
    }

    const sr = (last as any).stopReason;
    dlog(`agent_end: stopReason=${sr}`);

    // ESC → paused
    if (sr === "aborted") {
      if (globalThis.__piEscJustPressed === true) {
        globalThis.__piEscJustPressed = false;
        dlog("agent_end: ESC → paused");
        transition({ kind: "paused", reason: "esc" });
        return;
      }
      // 用户 steer 打断（hasUserMessage 已消费）→ 不需要心跳续命——steer 已经把用户消息
      // 注入到了 agent loop，pi 会自动用 steer 消息开新 turn。这里直接放行让主循环继续。
      // 修复 ISSUE 174：之前无条件 return 导致 steer 后心跳停止、prefilling 状态不出现。
      if (hadUserMessage) {
        dlog("agent_end: aborted by user steer (continuing — steer delivered)");
        return;
      }
      // 非 ESC 非用户的 abort（内部 abort/reload 等）→ 不续命，等下次触发
      dlog("agent_end: aborted (non-ESC, non-user)");
      return;
    }

    // error → 指数退避（不可恢复错误直接 pause）
    if (sr === "error") {
      const errObj = (last as any).error || (event as any).error;
      const errMsg = (last as any).errorMessage || errObj?.message || errObj || "unknown";
      dlog(`agent_end: ERROR: ${errMsg}`);
      try {
        const pid = (globalThis as any).__genshinPersonId || "unknown";
        const ed = `${homedir()}/.teyvat/ErrorData/${pid}`;
        mkdirSync(ed, { recursive: true });
        const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
        const errStack = errObj?.stack ? `\n${errObj.stack}` : (errObj instanceof Error ? `\n${errObj.stack}` : "");
        const es2 = (last as any)?.errorStack || (event as any)?.errorStack || (last as any)?.error?.errorStack || (event as any)?.error?.errorStack || "";
        appendFileSync(`${ed}/crash.log`, `[${ts}] ${errMsg}${errStack}${es2 ? `\n--- errorStack ---\n${es2}` : ""} (${process.title})\n`);
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      // ISSUE 035：不可恢复错误（余额不足/被封/硬限流）→ 直接 pause，不重试
      const errStr = String(errMsg).toLowerCase();
      const isFatal = /402|insufficient.balance|quota.exceeded|account.deactivated|billing|payment.required/i.test(errStr)
        || (errObj?.status === 402 || errObj?.statusCode === 402);
      if (isFatal) {
        dlog(`agent_end: FATAL error (pause, no retry): ${errMsg}`);
        try { sendCustomMessage(pi, "continuous-error-retry", i18n(`【系统暂停】不可恢复错误: ${String(errMsg).slice(0, 200)}。已暂停，充值/解决后按任意键恢复。`, `[paused] Fatal error: ${String(errMsg).slice(0, 200)}. Paused — press any key after resolving.`)); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
        transition({ kind: "paused", reason: "fatal-error" });
        return;
      }
      setErrorBackoffMs(errorBackoffMs() ? Math.min(errorBackoffMs() * 2, 300_000) : 20_000);
      const waitMs = errorBackoffMs();
      const retryTimer = setTimeout(() => {
        if (heartState() !== "error-backoff") return;
        transition({ kind: "working" });
        try { sendCustomMessage(pi, "continuous-error-retry", i18n(`【系统自动】WARN: API 错误: ${String(errMsg).slice(0, 200)}。${Math.round(waitMs / 1000)}s 后重试。`, `[auto] WARN: API error: ${String(errMsg).slice(0, 200)}. Retrying in ${Math.round(waitMs / 1000)}s.`)); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
      }, waitMs);
      transition({ kind: "error-backoff", retryTimer });
      return;
    }

    // API 恢复：上次还在退避 → 注入恢复通知
    if (errorBackoffMs() > 0) {
      try { sendCustomMessage(pi, "continuous-error-retry", i18n("【系统自动】API 已恢复，继续工作。", "[auto] API recovered, continue working.")); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
    }
    setErrorBackoffMs(0);

    // ── Social pending：任何回合结束都 drain（ISSUE 125，2026-09-04）──
    // 原 drain 在下方 calledWait/calledHibernate return 之后且要求 working 状态——
    // “回复完就 wait/hibernate”的 agent：回合结束时状态已是 resting/hibernated → drain 被双重跳过 → pending 永远滞留（实测 test-01 重启后 queue 依然 pending）。
    // 修复：有 pending 时无论状态，先打断阻塞态（transition working，否则注入被吞）+ 立即注入开新回合处理——有消息就不允许睡。
    if (tryDrainPendingEarly()) return; // 消息已注入开新回合处理，本轮不走续命/wait 路径

    // wait/hibernate 工具已调用 → 状态已转移，不续命（上面的阻塞态检查兜底）
    const calledWait = (last as any).content?.some?.((c: any) => c.type === "toolCall" && c.name === "wait");
    const calledHibernate = (last as any).content?.some?.((c: any) => c.type === "toolCall" && c.name === "hibernate");
    if (calledWait || calledHibernate) {
      dlog(`agent_end: ${calledWait ? "wait" : "hibernate"} tool called`);
      return;
    }

    // limits 检查
    if (limits().maxCount > 0 && limits().count >= limits().maxCount) { dlog("agent_end: maxCount reached"); return; }
    if (limits().timeLimitMs > 0 && Date.now() - limits().startTime >= limits().timeLimitMs) { dlog("agent_end: timeLimit reached"); return; }

    // ── intentions 驱动续命 ──
    // 只在 working 状态续命；resting/hibernated 说明 agent 刚调了 wait/hibernate，不应打搅
    if (heartState() !== "working") { dlog(`agent_end: state=${heartState()}, skip auto-continue`); return; }
    limits().count++;
    const intentions = getIntentions();
    // ── Social Tool：agent 消息优先于续命决策 ──
    // 意图栈非空：注入 interrupt/queue 消息（deferred 留给意图栈空时）
    // 意图栈空：注入所有消息（interrupt/queue/deferred）——有消息就不能 hibernate
    //
    // ⚠️ 开发责任（2026-08-14 用户追责，待修）：interrupt 在此也是 agent_end 轮后注入
    // （drainPendingSocialWithMeta），与 queue 实质无区别，未实现强制切断。
    // 正确语义：interrupt 应与用户输入同级直接打断（abort 当前 turn + 立即注入）。
    // 责任开发者: message-between-agents-implement-01（多 agent communicate）
    // 来源: 0.3.1-dev.20260813.7 / .19；状态: to-fix
    if (heartState() === "working") {
      const drained = intentions ? drainPendingSocialWithMeta(10, "queue") : drainPendingSocialWithMeta(10);
      if (drained) {
        dlog(`agent_end: social messages → inject (${drained.text.length} chars)`);
        setTimeout(() => {
          sendCustomMessage(pi, "social-message", drained.text, drained.meta);
        }, 0);
        return;
      }
    }
    if (intentions) {
      dlog(`agent_end: intentions non-empty → auto-continue (count=${limits().count})`);
      setTimeout(() => {
        sendCustomMessage(pi, "continuous-next",
          i18n(`【系统自动】继续工作（非用户指令，意图栈非空自动续命）。你的计划：\n${intentions}\n\n做完的删掉（intentions({old_string:'done item', new_string:''})），有新的加上。没事做了就调 wait 或 hibernate。`,
               `[auto] Continue working (system auto-continue, not a user instruction). Your plan:\n${intentions}\n\nRemove finished items (intentions({old_string:'done item', new_string:''})), add new ones. If nothing left to do, call wait or hibernate.`));
      }, 0);
    } else {
      dlog(`agent_end: intentions empty → prompt to plan (count=${limits().count})`);
      setTimeout(() => {
        sendCustomMessage(pi, "continuous-next",
          i18n(`【系统自动】你的意图栈为空（非用户指令）。如果有事做，用 intentions 工具写入计划再继续。如果无事可做，调 wait({seconds:N}) 等待或 hibernate({summary:'...'}) 休眠。`,
               `[auto] Your intention stack is empty (not a user instruction). If you have work to do, write a plan with the intentions tool and continue. If not, call wait({seconds:N}) to pause or hibernate({summary:'...'}) to sleep.`));
      }, 0);
    }
  });

  // ── session_shutdown ──
  pi.on("session_shutdown", async () => {
    // /h detach 导致的 shutdown 不切 paused——headless 子进程会接管，不应留 paused 标记
    if ((globalThis as any).__genshinDetaching) {
      dlog("session_shutdown: detach mode, skip paused transition");
    } else if (heartState() !== "hibernated") {
      (globalThis as any).__genshinWaitReason = "shutdown";
      transition({ kind: "paused", reason: "shutdown" });
    }
    setHasUserMessage(false);
    // 终刷列表统计缓存（list.cjs 查询只读缓存，进程退出前落一次最新的）
    try {
      const pid = personId();
      if (pid) {
        const memDir = memoryDir(pid);
        const { computeAgentStats, writeStats } = require("../../god.frontend.cli/agent-stats.cjs");
        writeStats(homedir() + "/.teyvat", pid, computeAgentStats(homedir() + "/.teyvat", memDir, pid));
      }
    } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart.ts] " + ((e as any)?.message || e)); }
  });

  // ── agent_start ──
  pi.on("agent_start", async (_event, ctx) => {
    (globalThis as any).__genshinReloadingSince = null; // reload 结束，恢复常规 Working 显示
    setHasUserMessage(false);
    if (heartState() === "working") {
      limits().count = 0;
      limits().startTime = Date.now();
    } else {
      dlog(`agent_start: ${heartState()} (non-working, tools will self-guard)`);
    }
  });
}
