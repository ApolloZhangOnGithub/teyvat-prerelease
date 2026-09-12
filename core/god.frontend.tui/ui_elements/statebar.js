// god.frontend.tui/ui_elements/statebar.js
// ── StatusBar: 状态栏唯一真相源 ──────────────────────────────────────────────
// 所有状态文字、颜色、Working 计时器、token 统计、thinking 检测集中在此。
// 其他文件不允许硬编码状态标签/颜色——一律从这里取。

import { formatTokens } from "./footer.js";
import { theme } from "../theme/theme.js";
import { debug } from '#gene_riboswitch';

const SPARKLE_CHARS = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPARKLE_FRAMES = [...SPARKLE_CHARS, ...[...SPARKLE_CHARS].reverse()];
const SPARKLE_INTERVAL = 120; // ⚠️ 千万不要调整——动画帧率是用户体验，不可降（2026-08-18 曾误降 300ms 被用户否决："别动我的动画帧率"）。性能优化应走局部重绘（状态栏区域 invalidate 而非全屏 requestRender），而不是降帧率。见 LESSON 061
const SHIMMER_SPEED = 200;
const SHIMMER_HI = {
  warning: '\x1b[38;2;255;235;120m',
  accent: '\x1b[38;2;215;220;255m',
};

export const STATUS_DEFS = {
  "working":              { label: "Working...",        color: "warning" },
  // 2026-08-13 用户规范：wait/hibernate 进行中 = 黄色（与工具调用行黄点一致）
  "resting":              { label: "Waiting...",        color: "warning" },
  "hibernated":           { label: "Hibernating...",    color: "warning" },
  "paused":               { label: "Paused",            color: "accent" },
  "aborted":              { label: "Aborted",           color: "error" },
  "error-backoff":        { label: "Retrying",          color: "error" },
  "sleeping(compacting)": { label: "Compacting Memory", color: "accent" },
  "sleeping(nap)":        { label: "Nap",               color: "accent" },
  "sleeping(sleep)":      { label: "Sleeping",          color: "accent" },
};

export function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) { const m = Math.floor(s / 60); const sec = s % 60; return sec === 0 ? `${m}m` : `${m}m ${sec}s`; }
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// 后台任务标签：`2 background tasks, lasting 10m 5s, 5m 30s`（无任务返回空；时长用 fmtElapsed 同格式）
// 最多显示 MAX_BG_SHOW 个，超出折叠为 (+N more) 防止 footer 溢出
function bgRunningLabel() {
  const bg = globalThis.__genshinBgCount ?? (typeof process !== 'undefined' ? process.__genshinBgCount : undefined);
  if (!(bg > 0)) return "";
  let label = bg === 1 ? "1 background task" : `${bg} background tasks`;
  const starts = globalThis.__genshinBgStarts ?? (typeof process !== 'undefined' ? process.__genshinBgStarts : undefined);
  if (Array.isArray(starts) && starts.length > 0) {
    const now = Date.now();
    const MAX_BG_SHOW = 3;
    const shown = starts.slice(0, MAX_BG_SHOW).map(s => fmtElapsed(now - s));
    const hidden = starts.length - shown.length;
    label += `, lasting ${shown.join(", ")}`;
    if (hidden > 0) label += ` (+${hidden} more)`;
  }
  return label;
}

// 未读消息标签：`2 msgs pending`（有 interrupt 时 `2 msgs pending (1 interrupt)` + warning 色；无消息返回空）
// 数据来自 __genshinSocialPending（communicate.ts getPendingInbox 更新，不读盘）
function socialPendingLabel() {
  const p = globalThis.__genshinSocialPending ?? (typeof process !== 'undefined' ? process.__genshinSocialPending : undefined);
  if (!p || !(p.count > 0)) return "";
  let label = p.count === 1 ? "1 msg pending" : `${p.count} msgs pending`;
  if (p.interrupt > 0) {
    label += ` (${p.interrupt} interrupt)`;
    return theme.fg("warning", label);
  }
  return theme.fg("accent", label);
}

// ── 动词库：session 结束后的回忆动词 ──
const SESSION_VERBS = {
  hibernate: "Brewed",
  pause: "Paused",
  restart: "Restarted",
  shutdown: "Ended",
  default: "Brewed",
};

// ── 预格式化带颜色的状态文本（footer 直接渲染，不再二次上色）──
function colored(color, label, detail) {
  if (!detail) return theme.fg(color, label);
  return theme.fg(color, label) + " " + `(${detail})`;
}

export class StatusBar {
  _status = null;
  _footer = null;
  _timer = null;
  _startTime = null;
  // ISSUE 104：本轮 prefill 计时基准（agent_start 时刷新）。
  // 与 _startTime（working 段 elapsed）分离——连续 turn 间状态保持 working，
  // _startTime 不重置，若 prefilling 用它算时长会显示跨轮累积的假象。
  _prefillStartTime = null;
  _turnTokensAtStart = 0;
  _isThinking = false;
  _thinkStartTime = null;
  _toolActivity = null;
  _toolStartTime = null;
  _sessionAccumulated = 0;
  _segmentStartTime = null;
  _getOutputTokens = null;
  _getStreamingTokens = null;
  _requestRender = null;
  _sparkleFrame = 0;
  _sparkleTimer = null;
  _shimmerStartTime = 0;
  _tickFn = null;

  constructor(footer, requestRender) {
    this._footer = footer;
    this._requestRender = requestRender;
  }

  setTokenCallbacks(getOutput, getStreaming) {
    this._getOutputTokens = getOutput;
    this._getStreamingTokens = getStreaming;
  }

  _startSparkle() {
    clearInterval(this._sparkleTimer);
    this._sparkleFrame = 0;
    this._shimmerStartTime = Date.now();
    this._sparkleTimer = setInterval(() => {
      this._sparkleFrame = (this._sparkleFrame + 1) % SPARKLE_FRAMES.length;
      globalThis.__genshinSparkleFrame = this._sparkleFrame;
      this._tickFn?.();
      this._requestRender?.();
    }, SPARKLE_INTERVAL);
  }

  _sparkle() {
    return SPARKLE_FRAMES[this._sparkleFrame % SPARKLE_FRAMES.length];
  }

  _shimmerLabel(color, text) {
    const elapsed = Date.now() - this._shimmerStartTime;
    const n = text.length;
    const cycleLen = n + 20;
    const pos = Math.floor(elapsed / SHIMMER_SPEED);
    const idx = n + 10 - (pos % cycleLen);
    const s = idx - 1, e = idx + 1;
    if (s >= n || e < 0) return theme.fg(color, text);
    const cs = Math.max(0, s), ce = Math.min(n, e + 1);
    const hi = SHIMMER_HI[color];
    if (!hi) return theme.fg(color, text);
    let r = '';
    if (cs > 0) r += theme.fg(color, text.slice(0, cs));
    r += hi + text.slice(cs, ce) + '\x1b[39m';
    if (ce < n) r += theme.fg(color, text.slice(ce));
    return r;
  }

  transition(status) {
    // 防重入：已是 hibernated 且再次切换到 hibernated 时，不重置计时器
    if (this._status === "hibernated" && status === "hibernated") return;
    // 离开 hibernated → 清全局 interval
    if (globalThis.__hbTimers?.has("main")) {
      clearInterval(globalThis.__hbTimers.get("main"));
      globalThis.__hbTimers.delete("main");
    }
    if (globalThis.__restTimers?.has("main")) {
      clearInterval(globalThis.__restTimers.get("main"));
      globalThis.__restTimers.delete("main");
    }
    const prevStatus = this._status;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._sparkleTimer) { clearInterval(this._sparkleTimer); this._sparkleTimer = null; }
    // 累计时间：离开 working/resting 时结算当前段
    if ((this._status === "working" || this._status === "resting") &&
        status !== "working" && status !== "resting" && this._segmentStartTime) {
      this._sessionAccumulated += Date.now() - this._segmentStartTime;
      this._segmentStartTime = null;
    }
    this._status = status;
    this._toolActivity = null;
    this._toolStartTime = null;
    const def = STATUS_DEFS[status] || { label: status, color: "dim" };

    if (status === "working" || status === "resting") {
      if (!this._segmentStartTime) this._segmentStartTime = Date.now();
    }

    if (status === "working") {
      if (prevStatus !== "working") {
        this._startTime = Date.now();
        this._prefillStartTime = Date.now();
      }
      this._isThinking = false;
      this._thinkStartTime = null;
      this._tickFn = () => this._workingTick();
      this._startSparkle();
      this._footer?.setSpinner(theme.fg("warning", this._sparkle()) + " " + this._shimmerLabel("warning", "Working..."), null);
    } else if (status === "resting") {
      if (prevStatus !== "resting") {
        this._startTime = Date.now();
      }
      this._tickFn = null;
      this._footer?.setSpinner(theme.fg("accent", (globalThis.__genshinSYM?.snow || "❄")) + " " + theme.fg("accent", "Waiting..."), null);
      if (!globalThis.__restTimers) globalThis.__restTimers = new Map();
      if (globalThis.__restTimers.has("main")) clearInterval(globalThis.__restTimers.get("main"));
      const rid = setInterval(() => {
        this._restingTick();
        this._requestRender?.();
      }, 1000);
      globalThis.__restTimers.set("main", rid);
      this._restingTick();
    } else if (status === "hibernated") {
      this._startTime = Date.now();
      const total = this._sessionAccumulated + (this._segmentStartTime ? Date.now() - this._segmentStartTime : 0);
      if (total > 5000) {
        globalThis.__genshinSessionElapsed = total;
        globalThis.__genshinSessionEndVerb = SESSION_VERBS.hibernate;
      }
      this._tickFn = null;
      this._footer?.setSpinner(theme.fg("accent", (globalThis.__genshinSYM?.snow || "❄")) + " " + theme.fg("accent", "Hibernating..."), null);
      if (!globalThis.__hbTimers) globalThis.__hbTimers = new Map();
      if (globalThis.__hbTimers.has("main")) clearInterval(globalThis.__hbTimers.get("main"));
      const id = setInterval(() => {
        this._hibernateTick();
        this._requestRender?.();
      }, 1000);
      globalThis.__hbTimers.set("main", id);
      this._hibernateTick();
    } else {
      this._startTime = null;
      this._tickFn = null;
      this._footer?.setSpinner(colored(def.color, def.label), null);
    }
    this._requestRender?.();
  }

  resetTurnTokens(base) {
    this._turnTokensAtStart = base || 0;
  }

  // ISSUE 104：每轮 agent 开始刷新 prefill 基准。
  // 连续 turn（自动续命）间 heart 状态保持 working，transition("working") 不重置
  // _startTime；若 prefill 计时继续用旧起点，新一轮 prefill 阶段（tk=0）会显示
  // "prefilling for Xm"（X=整个 working 段时长）的假象。
  beginTurn() {
    this._prefillStartTime = Date.now();
  }

  setMessage(text) {
    if (!text) return;
    const def = STATUS_DEFS[this._status] || { color: "accent" };
    const prefix = (this._status === "resting" || this._status === "hibernated")
      ? theme.fg(def.color, (globalThis.__genshinSYM?.snow || "❄")) + " "
      : "";
    this._footer?.updateSpinnerText(prefix + colored(def.color, text));
  }

  setThinking(active) {
    if (active && !this._isThinking) {
      this._isThinking = true;
      this._thinkStartTime = Date.now();
    } else if (!active) {
      this._isThinking = false;
      this._thinkStartTime = null;
    }
  }

  setToolActivity(name) {
    const activityNames = { read: 'reading', write: 'writing', edit: 'editing', web: 'fetching', execute: 'executing', amem: 'managing memory', status: 'querying', search: 'searching', intentions: 'writing intentions', hibernate: 'hibernating', wait: 'waiting' };
    this._toolActivity = activityNames[name] || name;
    this._toolStartTime = Date.now();
    // 立即渲染，不等 120ms sparkle tick（write/edit 执行 <120ms 时 tick 来不及显示）
    this._workingTick();
    this._requestRender?.();
  }

  clearToolActivity() {
    this._toolActivity = null;
    this._toolStartTime = null;
  }

  stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _workingTick() {
    if (!this._startTime) return;
    // 会话重载（/reload）期间：状态栏显示 Reloading... (Xs)，不再让用户误以为卡死（2026-08-14）
    const reloadSince = globalThis.__genshinReloadingSince;
    if (reloadSince) {
      const secs = Math.round((Date.now() - reloadSince) / 1000);
      this._footer?.updateSpinnerText(theme.fg("warning", "Reloading... (" + secs + "s)"));
      return;
    }
    const elapsed = fmtElapsed(Date.now() - this._startTime);
    const parts = [elapsed];

    const completed = (this._getOutputTokens?.() || 0) - this._turnTokensAtStart;
    const streaming = this._getStreamingTokens?.() || 0;
    const tk = completed + streaming;
    if (tk > 0) parts.push(`${formatTokens(tk)} tokens`);

    if (this._toolActivity && this._toolStartTime) {
      const actMs = Date.now() - this._toolStartTime;
      parts.push(actMs < 1000 ? this._toolActivity : `${this._toolActivity} for ${fmtElapsed(actMs)}`);
    } else if (this._isThinking && this._thinkStartTime) {
      const thinkMs = Date.now() - this._thinkStartTime;
      parts.push(thinkMs < 1000 ? "thinking" : `thinking for ${fmtElapsed(thinkMs)}`);
    } else if (tk === 0) {
      const prefillMs = Date.now() - (this._prefillStartTime || this._startTime);
      if (prefillMs >= 1000) parts.push(`prefilling for ${fmtElapsed(prefillMs)}`);
      else parts.push("prefilling");
    }

    const bgLabel = bgRunningLabel();
    if (bgLabel) parts.push(bgLabel);
    const msgLabel = socialPendingLabel();
    if (msgLabel) parts.push(msgLabel);

    const sparkle = theme.fg("warning", this._sparkle());
    const label = this._shimmerLabel("warning", "Working...");
    const detail = parts.join(" · ");
    this._footer?.updateSpinnerText(sparkle + " " + label + (detail ? " (" + detail + ")" : ""));
  }

  _restingTick() {
    const waitLabel = globalThis.__genshinWaitLabel;
    const waitForUser = globalThis.__genshinWaitForUser === true;
    const def = STATUS_DEFS[this._status] || { color: "accent" };
    // wait 倒计时与后台任务拼成一行，前缀/括号与 Working 同构（issue 071 附带）
    const parts = [];
    if (waitLabel) parts.push(waitLabel);
    const bgLabel = bgRunningLabel();
    if (bgLabel) parts.push(bgLabel);
    const msgLabel = socialPendingLabel();
    if (msgLabel) parts.push(msgLabel);
    if (parts.length > 0) {
      const monTitle = (globalThis.__genshinWaitMonitorTitle || "").trim();
      const label = waitForUser ? "Waiting for user..." : "Waiting...";
      const detail = theme.fg(def.color, parts.join(" · "));
      const monPart = monTitle ? " " + theme.fg("dim", monTitle) : "";
      this._footer?.updateSpinnerText(theme.fg(def.color, (globalThis.__genshinSYM?.snow || "❄")) + " " + theme.fg(def.color, label) + " (" + detail + ")" + monPart);
    }
  }

  _hibernateTick() {
    if (!this._startTime) return;
    const now = Date.now();
    const diff = now - this._startTime;
    const elapsed = fmtElapsed(diff);
    const acc = this._sessionAccumulated + (this._segmentStartTime ? now - this._segmentStartTime : 0);
    const accSec = Math.floor(acc / 1000);
    const accLabel = accSec < 10 ? "a brief stretch"
      : accSec < 60 ? "a short stint"
      : accSec < 600 ? "some honest work"
      : accSec < 3600 ? "diligent work"
      : "a long haul";
    const accStr = accSec > 5 ? `, after ${fmtElapsed(acc)} of ${accLabel}` : "";
    const untilTs = globalThis.__genshinHibernateUntilTs;
    const untilLabel = globalThis.__genshinHibernateUntil;
    // 倒计时（与 wait 同构）：(elapsed/total)，total 由 until 时间戳计算；无 until 时只显示 elapsed
    let timer = elapsed;
    if (untilTs && untilTs > this._startTime) {
      const totalSec = Math.max(1, Math.round((untilTs - this._startTime) / 1000));
      timer = `${fmtElapsed(Math.round(diff / 1000) * 1000)}/${fmtElapsed(totalSec * 1000)}`;
    }
    const parts = [timer];
    if (accStr) parts.push(accStr.replace(/^, /, ""));
    if (untilLabel) parts.push(`wake at ${theme.fg("accent", untilLabel)}`);
    const bgLabel = bgRunningLabel();
    if (bgLabel) parts.push(bgLabel);
    const msgLabel = socialPendingLabel();
    if (msgLabel) parts.push(msgLabel);
    const detail = parts.join(" · ");
    const snowflake = theme.fg("warning", (globalThis.__genshinSYM?.snow || "❄"));
    const label = theme.fg("warning", "Hibernating...");
    const text = snowflake + " " + label + (detail ? " (" + detail + ")" : "");
    this._footer?.updateSpinnerText(text);
    this._requestRender?.();
  }

  getStatus() { return this._status; }

  dispose() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._sparkleTimer) { clearInterval(this._sparkleTimer); this._sparkleTimer = null; }
  }
}
