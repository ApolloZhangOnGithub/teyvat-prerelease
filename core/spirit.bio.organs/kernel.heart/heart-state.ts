// 文档: B.docs/Dev.Common/Wiki/Heart(Organ&Kernel).WIKI
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSessionRole } from "#kernel_ribosome";
import { runtimeCacheDir } from "#paths";
import { debug } from "#gene_riboswitch";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

declare global { var __piEscJustPressed: boolean | undefined; }

// ── debug（PI_DEBUG=D0001 开启，走统一 debug 管线）──
export function dlog(msg: string) {
  debug.log("D0001", msg);
}

// ── types ──
export type Timer = ReturnType<typeof setTimeout>;
export type Interval = ReturnType<typeof setInterval>;

export type Heart =
  | { kind: "working" }
  | { kind: "resting"; resumeTimer: Timer; countdownTimer: Interval; waitSecs?: number; waiting?: boolean; interruptReason?: string; toolCallId?: string; ts?: number }
  | { kind: "hibernated"; ts: number; unloadTimer?: Timer }
  | { kind: "paused"; reason: string }
  | { kind: "error-backoff"; retryTimer: Timer };

export interface Limits {
  maxCount: number;
  timeLimitMs: number;
  count: number;
  startTime: number;
  timeLimitTimer: Timer | null;
}

// ── 心脏运行时状态（各字段独立导出，不用猜 S 是什么）──
let _heart: Heart = { kind: "working" };
let _limits: Limits = { maxCount: -1, timeLimitMs: -1, count: 0, startTime: 0, timeLimitTimer: null };
let _errorBackoffMs = 0;
let _hasUserMessage = false;

// ── 状态变化订阅（解耦 PROPOSAL 034 阶段 3，2026-08-18）──
// heart 不再直接持有/调用 TUI 对象：状态变化 = 发事件，UI 订阅后自己刷新。
// setUI(ui) 保留为兼容入口（heart.ts session_start 注入）——注入的 ui 被包装成
// 订阅者回调，heart 只存回调列表、不存 UI 引用。未来多视图：任意订阅者都能收到状态通知。
let _subscribers: Array<() => void> = [];

export function heartState(): Heart["kind"] { return _heart.kind; }
export function heartRaw(): Heart { return _heart; }
export function limits(): Limits { return _limits; }

export function onHeartStateChange(cb: () => void): () => void {
  _subscribers.push(cb);
  return () => { const i = _subscribers.indexOf(cb); if (i >= 0) _subscribers.splice(i, 1); };
}

export function setUI(ui: any) {
  (globalThis as any).__genshinRefreshUI = refreshUI;
  onHeartStateChange(() => {
    try {
      if (typeof ui.invalidate === "function") ui.invalidate();
      if (typeof ui.requestRender === "function") ui.requestRender();
    } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
  });
}
// （2026-08-14 已移除 setHeartPi：打断折线改由 wait 组件自己渲染，exitState 不再需要 pi；
// LESSON 056 记录的 require 坑已由 check-require-entry 门禁防复发）
export function refreshUI(): void {
  // 2026-08-18 解耦阶段 3：从"直接调 _ui 对象"改为"分发状态变化事件"——
  // heart 不持有任何 UI 引用，订阅者收到后自己刷新（刷新失败不影响状态机主流程）。
  for (const cb of [..._subscribers]) {
    try { cb(); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
  }
}

export function hasUserMessage(): boolean { return _hasUserMessage; }
export function setHasUserMessage(v: boolean) { _hasUserMessage = v; }
export function errorBackoffMs(): number { return _errorBackoffMs; }
export function setErrorBackoffMs(v: number) { _errorBackoffMs = v; }

// ── state machine ──────────────────────────────────────────────────────────
//
//  working ─┬──→ resting ──┬──→ working  (timer fires)
//           │              └──→ paused   (ESC)
//           ├──→ hibernated ──→ working  (user message / sleep-done)
//           ├──→ paused ──────→ working  (user input / /pause toggle)
//           └──→ error-backoff → working (retry timer / user input)
//
//  入口：session_start → working
//  出口：session_shutdown → paused
//
// 设计原则：
//   1. transition() 是唯一修改 _heart 的地方
//   2. 退出旧状态：清 timer、清 UI、清磁盘标记
//   3. 工具自守卫：非 working 状态时 wait/hibernate 拒绝执行
//   4. 所有副作用集中在 transition() 内，event handler 只做条件判断 + 调 transition

function exitState(cur: Heart): void {
  if (cur.kind === "resting") {
    clearTimeout(cur.resumeTimer);
    clearInterval(cur.countdownTimer);
    // 被打断 → 发红色折线中断消息（reason 由打断者在 transition 前写入 __genshinWaitReason）
    if (cur.waitSecs) {
      try {
        const reason = (globalThis as any).__genshinWaitReason;
        // 2026-08-14：只对"用户可见"的打断原因画折线/红点（user message / ESC / /pause）；
        // 内部原因（reload/shutdown/sleep 等）静默退出——用户不需要知道，也不该看到垃圾文案。
        const USER_VISIBLE_REASONS = new Set(["user", "esc", "command"]);
        if (reason && USER_VISIBLE_REASONS.has(reason)) {
          // 打断折线由 wait 组件自己画（位置天然正确、秒数取实际等待值）
          dlog(`wait interrupted: reason=${reason} toolCallId=${cur.toolCallId || ""}`);
          (globalThis as any).__genshinWaitReason = "";
          (globalThis as any).__genshinWaitInterruptedId = cur.toolCallId || ""; // 该 wait 调用行点变红（按 id，不随新 wait 复位）
          (globalThis as any).__genshinWaitInterruptedReason = reason;
          // 实际等待秒数（用户要求：折线显示真正等了多少秒，而不是请求的秒数）
          const actualSecs = cur.ts ? Math.max(1, Math.round((Date.now() - cur.ts) / 1000)) : (cur.waitSecs ?? 0);
          (globalThis as any).__genshinWaitInterruptedSecs = actualSecs;
          // 模型侧通知：把"已等待多少秒被打断"与打断消息同请求一次性送达
          // （heart.ts input handler 消费后走 sendCustomMessage nextTurn）
          (globalThis as any).__genshinWaitInterruptedNotice = { secs: actualSecs, reason };
        }
        else {
          if (reason) dlog(`wait exit quiet (internal reason=${reason})`);
          else dlog(`wait exit without reason (cur.waitSecs=${cur.waitSecs})`);
          (globalThis as any).__genshinWaitReason = "";
        }
      } catch (e: any) {
        dlog(`wait interrupt handling failed: ${e?.message ?? e}`);
      }
    }
    try {
      const pid = personId();
      if (pid) require("fs").unlinkSync(join(runtimeCacheDir(pid), "main-resting"));
    } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
    // 离开 resting 一律清 wait 显示全局量（此前只有 wait 工具自身路径清理，
    // 被打断路径会残留 __genshinWaitLabel/__genshinWaitForUser）
    try { (globalThis as any).__genshinWaitLabel = null; } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
    try { (globalThis as any).__genshinWaitForUser = false; } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
  } else if (cur.kind === "hibernated") {
    // 醒来得早 → 取消"长时间休眠卸载"定时器（消息区没卸载就不需要重建）
    if (cur.unloadTimer) clearTimeout(cur.unloadTimer);
  } else if (cur.kind === "error-backoff") {
    clearTimeout(cur.retryTimer);
  }
  if (cur.kind !== "working" && _limits.timeLimitTimer) {
    clearTimeout(_limits.timeLimitTimer);
    _limits.timeLimitTimer = null;
  }
}

function enterState(to: Heart): void {
  // 状态进入动作：只设 UI status。不做 abort——状态守卫在各工具 execute 入口。
  try { setStatus(to.kind as any); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
}

export function transition(to: Heart): void {
  const cur = _heart;
  dlog(`transition: ${cur.kind} → ${to.kind}`);
  exitState(cur);
  _heart = to;
  (globalThis as any).__genshinHeartState = to.kind;
  enterState(to);
  // 离开 hibernated → 若消息区曾被卸载，唤醒即重建（status bar 不在此范围，从未中断）
  if (cur.kind === "hibernated") {
    try { (globalThis as any).__genshinRestoreChat?.(); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
  }
  // 点颜色依赖 heart 状态（wait/hibernate 黄点 → 结束变绿/红），状态一变必须重渲染，
  // 否则点被缓存在组件 Text 里永远停在旧色（2026-08-13 用户报修）
  refreshUI();
}

// ── resetLimits ──
export function resetLimits(): void {
  if (_limits.timeLimitTimer) { clearTimeout(_limits.timeLimitTimer); _limits.timeLimitTimer = null; }
  _limits = { maxCount: -1, timeLimitMs: -1, count: 0, startTime: Date.now(), timeLimitTimer: null };
}

// ── helpers ──
export function personId(): string {
  const m = process.title.match(/genshin:[^(]+\([^,]+,\s*([^,)]+)/);
  if (m?.[1]) return m[1];
  // ISSUE 112（2026-08-18 连锁修复）：process.title 在 K020 fail-fast 抛错后可能未设置
  // （title 设置在 K020 检查之后）→ personId 空 → validateExecute 的"自己 ID 放行"与
  // root 授权检查（selfId 匹配）全部失效，连自己的 LogData 都读不了。
  // fallback 链：process.title → env（launcher 启动时始终设置）→ 全局。
  const g = (globalThis as any).__genshinPersonId;
  if (g) return String(g);
  return process.env.PAIMON_AGENT_ID || "";
}

export function wakeRestartFile(): string | null {
  try {
    return (globalThis as any).__genshinRuntimeDir ? (globalThis as any).__genshinRuntimeDir + "/wake-restart" : null;
  } catch { return null; }
}

export function isWorkerSession(ctx: any): boolean {
  try {
    const sf = ctx?.sessionManager?.getSessionFile?.() || "";
    return /metaconsciousnessSessions|HippocampusSessions|SleepSessions/.test(sf);
  } catch { return false; }
}

export function isToolDisabled(toolName: string): boolean {
  try {
    const role = getSessionRole();
    // manifest role 检查
    const mf = JSON.parse(readFileSync(`${homedir()}/.teyvat/agent/extensions/teyvat/spirit.bio.gene/tools.manifest.json`, "utf8"));
    const roleDef = mf?.roles?.[role];
    if (roleDef && !roleDef.includes(toolName)) return true;
    // settings.json 禁用检查
    try {
      const sf = JSON.parse(readFileSync(`${homedir()}/.teyvat/agent/config/settings.json`, "utf8"));
      if ((sf.tools?.disabled || []).includes(toolName)) return true;
    } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
    // 元意识 hibernate 额外条件：主意识必须先 hibernate
    if (role === "metaconsciousness" && toolName === "hibernate") {
      const pid = (globalThis as any).__genshinPersonId || "";
      if (!pid || !existsSync(join(runtimeCacheDir(pid), "main-hibernate"))) return true;
    }
    return false;
  } catch { return false; }
}

export function isHibernateDisabled(): boolean { return isToolDisabled("hibernate"); }
export function isWaitDisabled(): boolean { return isToolDisabled("wait"); }

// ── UI 状态桥接 (从 spirit.abio.status 迁入) ──
export type AgentStatus =
  | "working" | "resting" | "hibernated" | "paused"
  | "aborted" | "error-backoff"
  | "sleeping(compacting)" | "sleeping(nap)" | "sleeping(sleep)";

let _agentStatus: AgentStatus = "working";
let _statusUI: any = null;

export function initStatusUI(ui: any) { _statusUI = ui; }
export function getStatus(): AgentStatus { return _agentStatus; }

export function setStatus(status: AgentStatus) {
  _agentStatus = status;
  try { require("#gene_riboswitch").debug.log("D0004", `setStatus ${status}`); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
  try { _statusUI?.setStatus?.("genshin-status", status); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-state.ts] " + ((e as any)?.message || e)); }
}
