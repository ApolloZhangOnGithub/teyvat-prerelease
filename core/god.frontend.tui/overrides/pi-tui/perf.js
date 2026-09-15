// perf.js —— CPU 占用检测（跨平台，供 doRender 渲染降级用）
// 2026-09-16（windows agent 实测）：os.loadavg() 是 1 分钟指数平均（满载 4 秒后仍 0.46），
// 对瞬时 >99% 占用无感（语义是"平均运行队列长度"非"使用率"）。换 os.cpus() 差分（跨平台、不需起进程）。
// WSL 的 os.cpus() 只看 VM 内（VM 隔离看不到 Windows 侧负载）→ 需读 /proc/stat 的 steal 字段（宿主抢 CPU）。
import os from "node:os";
import fs from "node:fs";

let _lastCpu = null;
let _lastCpuPercent = 0;
let _lastSteal = null;
let _lastStealPercent = 0;
let _lastRenderMs = 0;

function _readProcStat() {
  if (process.platform !== "linux") return null;
  try {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    // parts: user nice sys idle iowait irq softirq steal guest guest_nice
    const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + (b || 0), 0);
    const steal = parts[7] || 0;
    return { idle, total, steal, at: Date.now() };
  } catch {
    return null;
  }
}

function _readOsCpus() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    idle += c.times.idle || 0;
    total += (c.times.user || 0) + (c.times.nice || 0) + (c.times.sys || 0) + (c.times.idle || 0) + (c.times.irq || 0);
  }
  return { idle, total, at: Date.now() };
}

// cpuPercent：os.cpus() 差分（两次采样求 idle 占比），跨平台可用。窗口默认 500ms（太短抖动大）。
export function cpuPercent(sampleWindowMs = 500) {
  const nowAt = Date.now();
  if (_lastCpu && nowAt - _lastCpu.at < sampleWindowMs) return _lastCpuPercent; // 先判窗口再读（省 32 核遍历）
  const now = _readOsCpus();
  if (!_lastCpu) {
    _lastCpu = now;
    return 0;
  }
  const idleDelta = now.idle - _lastCpu.idle;
  const totalDelta = now.total - _lastCpu.total;
  _lastCpu = now;
  if (totalDelta <= 0) return 0;
  _lastCpuPercent = (1 - idleDelta / totalDelta) * 100;
  return _lastCpuPercent;
}

// stealPercent：/proc/stat steal 字段的差分（宿主抢 CPU 占比，仅 Linux/WSL 有意义）。
export function stealPercent(sampleWindowMs = 500) {
  const nowAt = Date.now();
  if (_lastSteal && nowAt - _lastSteal.at < sampleWindowMs) return _lastStealPercent; // 先判窗口再读
  const now = _readProcStat();
  if (!now) return 0;
  if (!_lastSteal) {
    _lastSteal = now;
    return 0;
  }
  const stealDelta = now.steal - _lastSteal.steal;
  const totalDelta = now.total - _lastSteal.total;
  _lastSteal = now;
  if (totalDelta <= 0) return 0;
  _lastStealPercent = (stealDelta / totalDelta) * 100;
  return _lastStealPercent;
}

// isBusy：CPU 高占用判定。阈值走 env（GENSHIN_CPU_BUSY_PCT 默认 90；GENSHIN_STEAL_BUSY_PCT 默认 20；
// GENSHIN_RENDER_MS_BUSY 默认 30——每帧渲染耗时，直接测"渲染吃力"，跨平台零依赖，是 steal 在 WSL 取不到值时的有效补充）。
export function isBusy() {
  const cpuPct = Number(process.env.GENSHIN_CPU_BUSY_PCT) || 90;
  const stealPct = Number(process.env.GENSHIN_STEAL_BUSY_PCT) || 20;
  const renderPct = Number(process.env.GENSHIN_RENDER_MS_BUSY) || 30;
  return cpuPercent() > cpuPct || stealPercent() > stealPct || _lastRenderMs > renderPct;
}

// recordRenderMs：doRender 每帧调用，记录当帧渲染耗时（供 isBusy 的 renderMs 判据用）。
export function recordRenderMs(ms) {
  _lastRenderMs = ms;
}
