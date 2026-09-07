#!/usr/bin/env bun
// god.technology/health/health.ts
// ── Developer Health Dashboard ── Apple Health 风格 TUI ──────────────────
// 启动: genshin god h  或  genshin god health
//
// 数据源:
//   ~/.teyvat/SessionData/     — 会话 JSONL (tokens, cost, timestamps)
//   ~/.teyvat/MemoryData/plist.json — agent 列表
//   git log                     — commit 历史
//   pmset -g log                — macOS 睡眠/唤醒周期

import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const H = homedir();
const PAIMON = process.env.PAIMON_HOME || join(H, ".teyvat");
const SESSION_DIR = join(PAIMON, "SessionData");
const PLIST = join(PAIMON, "MemoryData", "plist.json");
const DEV_ROOT = process.env.PAIMON_EXT || join(H, ".local/lib/teyvat/extensions/teyvat");

const LANG = process.env.PAIMON_LANG || (process.env.LANG?.includes("zh") ? "zh" : "en");
const ZH = LANG === "zh";
function t(zh: string, en: string): string { return ZH ? zh : en; }

// ── ANSI helpers ──

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

function vw(s: string): number {
  let w = 0;
  for (const ch of [...String(s).replace(/\x1b\[[0-9;]*m/g, "")]) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) w += 2;
    else w += 1;
  }
  return w;
}

function padR(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - vw(s)));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Data collection ──

interface SessionSummary {
  id: string;
  agentId: string;
  start: number;
  end: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  model: string;
}

interface CommitInfo {
  hash: string;
  date: number;
  message: string;
}

interface SleepCycle {
  sleepStart: number;
  wakeEnd: number;
  duration: number;
}

interface AgentInfo {
  id: string;
  name: string;
  kind: string;
  created: number;
  lastSeen: number;
  archived: boolean;
}

function collectSessions(daysBack: number = 7): SessionSummary[] {
  const cutoff = Date.now() - daysBack * 86400000;
  const sessions: SessionSummary[] = [];
  if (!existsSync(SESSION_DIR)) return sessions;

  for (const agentDir of readdirSync(SESSION_DIR)) {
    const agentPath = join(SESSION_DIR, agentDir);
    try { if (!statSync(agentPath).isDirectory()) continue; } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); continue; }

    const scanDir = (dir: string) => {
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".jsonl")) continue;
          const fp = join(dir, file);
          try {
            const stat = statSync(fp);
            if (stat.mtimeMs < cutoff) continue;
          } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); continue; }

          try {
            const raw = readFileSync(fp, "utf8");
            let start = 0, end = 0, messages = 0;
            let inputTokens = 0, outputTokens = 0, totalTokens = 0, cost = 0;
            let model = "";
            for (const line of raw.split("\n")) {
              if (!line.trim()) continue;
              try {
                const d = JSON.parse(line);
                if (d.type === "session" && d.timestamp) {
                  const ts = new Date(d.timestamp).getTime();
                  if (ts > cutoff) start = ts;
                }
                if (d.type === "message") {
                  const msg = d.message || {};
                  const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : (d.timestamp ? new Date(d.timestamp).getTime() : 0);
                  if (ts > 0) {
                    if (!start || ts < start) start = ts;
                    if (ts > end) end = ts;
                  }
                  messages++;
                  const u = msg.usage;
                  if (u) {
                    inputTokens += u.input || 0;
                    outputTokens += u.output || 0;
                    totalTokens += u.totalTokens || 0;
                    cost += u.cost?.total || 0;
                  }
                  if (msg.model && !model) model = msg.model;
                }
              } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); }
            }
            if (start > cutoff && messages > 0) {
              sessions.push({
                id: file.replace(".jsonl", ""),
                agentId: agentDir,
                start, end: end || start,
                messages, inputTokens, outputTokens, totalTokens, cost, model,
              });
            }
          } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); }
        }
      } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); }
    };

    scanDir(agentPath);
    const subDir = join(agentPath, "SubconsciousSessions");
    if (existsSync(subDir)) scanDir(subDir);
  }

  sessions.sort((a, b) => a.start - b.start);
  return sessions;
}

function findGitRoot(): string | null {
  const candidates = [
    DEV_ROOT,
    join(H, "Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core"),
  ];
  for (const dir of candidates) {
    try {
      const root = execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf8", timeout: 3000 }).trim();
      if (root) return root;
    } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); }
  }
  return null;
}

function collectCommits(daysBack: number = 7): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const gitRoot = findGitRoot();
  if (!gitRoot) return commits;
  try {
    const raw = execSync(
      `git log --format="%H|%ai|%s" --since="${daysBack} days ago"`,
      { cwd: gitRoot, encoding: "utf8", timeout: 5000 }
    );
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      const [hash, dateStr, ...msgParts] = line.split("|");
      const date = new Date(dateStr).getTime();
      commits.push({ hash, date, message: msgParts.join("|") });
    }
  } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); }
  return commits;
}

function collectSleepCycles(daysBack: number = 7): SleepCycle[] {
  const cycles: SleepCycle[] = [];
  try {
    const raw = execSync(
      `pmset -g log | grep -E "(Clamshell Sleep|HID Activity)" | tail -100`,
      { encoding: "utf8", timeout: 10000 }
    );
    const cutoff = Date.now() - daysBack * 86400000;
    const events: { ts: number; type: "sleep" | "wake" }[] = [];
    for (const line of raw.split("\n")) {
      const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
      if (!dateMatch) continue;
      const ts = new Date(dateMatch[1]).getTime();
      if (ts < cutoff) continue;
      if (/Clamshell Sleep/.test(line)) {
        events.push({ ts, type: "sleep" });
      } else if (/HID Activity/.test(line) && /Wake/.test(line)) {
        events.push({ ts, type: "wake" });
      }
    }
    let firstSleep = 0;
    for (const ev of events) {
      if (ev.type === "sleep") {
        if (firstSleep === 0) firstSleep = ev.ts;
      } else if (ev.type === "wake" && firstSleep > 0) {
        const dur = ev.ts - firstSleep;
        if (dur > 1800000) {
          cycles.push({ sleepStart: firstSleep, wakeEnd: ev.ts, duration: dur });
        }
        firstSleep = 0;
      }
    }
  } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); }
  return cycles;
}

function loadAgents(): AgentInfo[] {
  try {
    const raw = JSON.parse(readFileSync(PLIST, "utf8"));
    return raw.map((a: any) => ({
      id: a.id,
      name: a.name,
      kind: a.kind || "coding-agent",
      created: new Date(a.created).getTime(),
      lastSeen: new Date(a.lastSeen || a.created).getTime(),
      archived: !!a.archived,
    }));
  } catch (e) { console.error("[god.frontend.cli/health.ts] " + ((e as any)?.message || e)); return []; }
}

// ── Rendering helpers ──

const SPARKLINE = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const BLOCK_FULL = "█";
const BLOCK_EMPTY = "░";

function sparkline(values: number[], width: number = 24): string {
  if (!values.length) return C.dim + "─".repeat(width) + C.reset;
  const max = Math.max(...values, 1);
  const step = values.length / width;
  const chars: string[] = [];
  for (let i = 0; i < width; i++) {
    const startIdx = Math.floor(i * step);
    const endIdx = Math.floor((i + 1) * step);
    let sum = 0, count = 0;
    for (let j = startIdx; j < endIdx && j < values.length; j++) {
      sum += values[j];
      count++;
    }
    const avg = count > 0 ? sum / count : 0;
    const level = Math.round((avg / max) * 7);
    chars.push(SPARKLINE[Math.min(level, 7)]);
  }
  return C.cyan + chars.join("") + C.reset;
}

function progressBar(value: number, max: number, width: number = 20, color: string = C.green): string {
  const ratio = Math.min(value / Math.max(max, 1), 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return color + BLOCK_FULL.repeat(filled) + C.gray + BLOCK_EMPTY.repeat(empty) + C.reset;
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function trendArrow(current: number, avgBaseline: number): string {
  if (avgBaseline < 0.001) return "";
  const change = (current - avgBaseline) / avgBaseline;
  if (change > 0.1) return C.green + " ↑" + Math.round(change * 100) + "%" + C.reset + C.dim + " vs " + t("周均", "avg") + C.reset;
  if (change < -0.1) return C.red + " ↓" + Math.round(Math.abs(change) * 100) + "%" + C.reset + C.dim + " vs " + t("周均", "avg") + C.reset;
  return C.gray + " →" + C.reset;
}

function card(title: string, lines: string[], width: number = 50, minRows: number = 0): string[] {
  const hr = "─".repeat(width - 2);
  const result: string[] = [];
  result.push(C.dim + "┌" + hr + "┐" + C.reset);
  result.push(C.dim + "│" + C.reset + " " + C.bold + padR(title, width - 4) + C.reset + " " + C.dim + "│" + C.reset);
  result.push(C.dim + "├" + hr + "┤" + C.reset);
  const padded = [...lines];
  while (padded.length < minRows) padded.push("");
  for (const line of padded) {
    const visW = vw(line);
    const pad = Math.max(0, width - 4 - visW);
    result.push(C.dim + "│" + C.reset + " " + line + " ".repeat(pad) + " " + C.dim + "│" + C.reset);
  }
  result.push(C.dim + "└" + hr + "┘" + C.reset);
  return result;
}

function sideBySide(left: string[], right: string[], gap: number = 2): string[] {
  const maxLen = Math.max(left.length, right.length);
  const leftW = Math.max(...left.map(l => vw(l)));
  const result: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const l = left[i] || "";
    const r = right[i] || "";
    result.push(padR(l, leftW) + " ".repeat(gap) + r);
  }
  return result;
}

// ── Dashboard views ──

function renderOverview(sessions: SessionSummary[], commits: CommitInfo[], sleepCycles: SleepCycle[], agents: AgentInfo[]): string {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  const todaySessions = sessions.filter(s => s.start >= todayStart);
  const past7dStart = todayStart - 7 * 86400000;
  const past7dSessions = sessions.filter(s => s.start >= past7dStart && s.start < todayStart);

  const totalCostToday = todaySessions.reduce((s, x) => s + x.cost, 0);
  const totalTokensToday = todaySessions.reduce((s, x) => s + x.totalTokens, 0);
  const totalMessagesToday = todaySessions.reduce((s, x) => s + x.messages, 0);

  const todayCommits = commits.filter(c => c.date >= todayStart);
  const past7dCommits = commits.filter(c => c.date >= past7dStart && c.date < todayStart);

  const activeDays7d = new Set(past7dSessions.map(s => new Date(s.start).toDateString())).size || 1;
  const avgSessions7d = past7dSessions.length / activeDays7d;
  const avgCost7d = past7dSessions.reduce((s, x) => s + x.cost, 0) / activeDays7d;
  const avgCommits7d = past7dCommits.length / activeDays7d;

  const activeAgents = agents.filter(a => !a.archived);
  const recentAgents = activeAgents.filter(a => a.lastSeen >= todayStart);

  // Work hours today
  let workMinutesToday = 0;
  const sortedToday = todaySessions.sort((a, b) => a.start - b.start);
  if (sortedToday.length > 0) {
    let workStart = sortedToday[0].start;
    let workEnd = sortedToday[sortedToday.length - 1].end;
    workMinutesToday = (workEnd - workStart) / 60000;
  }

  // ── 牛马指数 ──
  const niuma = calcNiumaScore(sessions, commits, sleepCycles);

  const W = 52;
  const LBL_W = 12;
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(C.bold + C.cyan + "  " + t("开发者健康", "Developer Health") + C.reset + C.dim + "  ─  " + new Date().toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" }) + C.reset);
  lines.push("");

  // Niuma score card
  const niumaLabel = niuma.total >= 90 ? "MAX" : niuma.total >= 70 ? "HIGH" : niuma.total >= 50 ? "MID" : "LOW";
  const niumaColor = niuma.total >= 80 ? C.red : niuma.total >= 60 ? C.yellow : C.green;
  const niumaBar = progressBar(niuma.total, 100, 20, niumaColor);
  const dimBar = (score: number, max: number) => progressBar(score, max, 10, C.cyan);
  const niumaLines = [
    niumaColor + C.bold + `${niuma.total}` + C.reset + C.dim + "/100" + C.reset + "  " + C.dim + "[" + niumaLabel + "]" + C.reset + "  " + niumaBar,
    "",
    padR(t("工作时长", "Work hrs"), LBL_W) + dimBar(niuma.workHours.score, 25) + C.dim + ` ${niuma.workHours.score}/25` + C.reset + C.dim + `  ${niuma.workHours.raw.toFixed(1)}h` + C.reset,
    padR(t("会话数", "Sessions"), LBL_W) + dimBar(niuma.sessionCount.score, 20) + C.dim + ` ${niuma.sessionCount.score}/20` + C.reset + C.dim + `  ${niuma.sessionCount.raw}` + t("次", "x") + C.reset,
    padR(t("提交数", "Commits"), LBL_W) + dimBar(niuma.commits.score, 15) + C.dim + ` ${niuma.commits.score}/15` + C.reset + C.dim + `  ${niuma.commits.raw}` + t("次", "x") + C.reset,
    padR(t("深夜工作", "Late nite"), LBL_W) + dimBar(niuma.lateNight.score, 20) + C.dim + ` ${niuma.lateNight.score}/20` + C.reset + C.dim + `  ${niuma.lateNight.raw}` + t("次", "x") + C.reset,
    padR(t("连续天数", "Streak"), LBL_W) + dimBar(niuma.streak.score, 20) + C.dim + ` ${niuma.streak.score}/20` + C.reset + C.dim + `  ${niuma.streak.raw}` + t("天", "d") + C.reset,
  ];
  const summaryLines = [
    padR(t("会话", "Sessions"), LBL_W) + C.bold + todaySessions.length + C.reset + trendArrow(todaySessions.length, avgSessions7d),
    padR(t("消息", "Messages"), LBL_W) + C.bold + totalMessagesToday + C.reset,
    padR(t("提交", "Commits"), LBL_W) + C.bold + todayCommits.length + C.reset + trendArrow(todayCommits.length, avgCommits7d),
    padR("Tokens", LBL_W) + C.bold + formatTokens(totalTokensToday) + C.reset,
    padR(t("花费", "Cost"), LBL_W) + C.bold + C.yellow + "¥" + totalCostToday.toFixed(2) + C.reset + trendArrow(totalCostToday, avgCost7d),
    padR(t("工作时长", "Work"), LBL_W) + C.bold + formatDuration(workMinutesToday * 60000) + C.reset,
    padR(t("活跃 Agent", "Active"), LBL_W) + C.bold + recentAgents.length + C.reset + C.dim + "/" + activeAgents.length + C.reset,
  ];
  const contentRows = Math.max(niumaLines.length, summaryLines.length);
  const niumaCard = card(t("牛马指数", "Niuma Index"), niumaLines, W, contentRows);
  const summaryCard = card(t("今日概览", "Today"), summaryLines, W, contentRows);

  const topRow = sideBySide(niumaCard, summaryCard);
  lines.push(...topRow.map(l => "  " + l));
  lines.push("");

  // Activity sparklines
  const activityLines: string[] = [];

  // Sessions per hour (last 24h)
  const hourBuckets = new Array(24).fill(0);
  for (const s of sessions.filter(s => s.start >= now - 86400000)) {
    const h = new Date(s.start).getHours();
    hourBuckets[h]++;
  }
  const TREND_LBL_W = 18;
  activityLines.push(padR(t("会话/小时 (24h)", "Sessions/hr (24h)"), TREND_LBL_W) + sparkline(hourBuckets, 24) + "  " + C.dim + t("每格=1小时", "per bar=1hr") + C.reset);

  const commitHourBuckets = new Array(24).fill(0);
  for (const c of commits.filter(c => c.date >= now - 86400000)) {
    const h = new Date(c.date).getHours();
    commitHourBuckets[h]++;
  }
  activityLines.push(padR(t("提交/小时 (24h)", "Commits/hr (24h)"), TREND_LBL_W) + sparkline(commitHourBuckets, 24) + "  " + C.dim + t("每格=1小时", "per bar=1hr") + C.reset);

  const dayBuckets = new Array(7).fill(0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayStart - i * 86400000);
    const dayStart = d.getTime();
    const dayEnd = dayStart + 86400000;
    for (const s of sessions) {
      if (s.start >= dayStart && s.start < dayEnd) {
        dayBuckets[6 - i] += s.cost;
      }
    }
  }
  activityLines.push(padR(t("花费/天 (7天)", "Cost/day (7d)"), TREND_LBL_W) + sparkline(dayBuckets, 24) + "  " + C.dim + "¥" + dayBuckets.reduce((a, b) => a + b, 0).toFixed(0) + t(" 总计", " total") + C.reset);

  const tokenDayBuckets = new Array(7).fill(0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayStart - i * 86400000);
    const dayStart = d.getTime();
    const dayEnd = dayStart + 86400000;
    for (const s of sessions) {
      if (s.start >= dayStart && s.start < dayEnd) {
        tokenDayBuckets[6 - i] += s.totalTokens;
      }
    }
  }
  activityLines.push(padR(t("Tokens/天 (7天)", "Tokens/day (7d)"), TREND_LBL_W) + sparkline(tokenDayBuckets, 24) + "  " + C.dim + formatTokens(tokenDayBuckets.reduce((a, b) => a + b, 0)) + t(" 总计", " total") + C.reset);

  const activityCard = card(t("活动趋势", "Activity Trends"), activityLines, W * 2 + 4);
  lines.push(...activityCard.map(l => "  " + l));
  lines.push("");

  // Sleep & work pattern
  const sleepLines: string[] = [];
  if (sleepCycles.length > 0) {
    for (const cycle of sleepCycles.slice(-3)) {
      const sleepTime = new Date(cycle.sleepStart);
      const wakeTime = new Date(cycle.wakeEnd);
      const durH = (cycle.duration / 3600000).toFixed(1);
      const sleepStr = `${sleepTime.getMonth() + 1}/${sleepTime.getDate()} ${String(sleepTime.getHours()).padStart(2, "0")}:${String(sleepTime.getMinutes()).padStart(2, "0")}`;
      const wakeStr = `${String(wakeTime.getHours()).padStart(2, "0")}:${String(wakeTime.getMinutes()).padStart(2, "0")}`;
      const quality = cycle.duration >= 7 * 3600000 ? C.green + "●" : cycle.duration >= 5 * 3600000 ? C.yellow + "●" : C.red + "●";
      sleepLines.push(
        quality + C.reset + " " +
        C.dim + sleepStr + " → " + wakeStr + C.reset +
        "  " + C.bold + durH + "h" + C.reset +
        "  " + renderSleepBar(cycle)
      );
    }
    const avgSleep = sleepCycles.reduce((s, c) => s + c.duration, 0) / sleepCycles.length;
    sleepLines.push("");
    sleepLines.push(C.dim + t("平均睡眠: ", "Avg sleep: ") + C.reset + C.bold + (avgSleep / 3600000).toFixed(1) + "h" + C.reset);
  } else {
    sleepLines.push(C.dim + t("(未检测到睡眠周期数据)", "(no sleep data detected)") + C.reset);
  }
  // Work intensity heatmap
  const heatLines: string[] = [];
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const heatData = new Array(24).fill(0);
  for (const s of sessions) {
    const h = new Date(s.start).getHours();
    heatData[h]++;
  }
  const maxHeat = Math.max(...heatData, 1);
  const HEAT_CHARS = [" ", "░", "▒", "▓", "█"];
  let heatRow = "";
  for (const h of hours) {
    const level = Math.round((heatData[h] / maxHeat) * 4);
    const ch = HEAT_CHARS[level];
    const color = level === 0 ? C.dim : level <= 2 ? C.blue : level <= 3 ? C.yellow : C.red;
    heatRow += color + ch + ch + C.reset;
  }
  heatLines.push(heatRow);
  let labels = "";
  for (let h = 0; h < 24; h++) {
    labels += (h % 3 === 0) ? String(h).padEnd(2) + (h < 23 ? " ".repeat(Math.max(0, 4)) : "") : "  " + (h < 23 ? " ".repeat(Math.max(0, 4)) : "");
  }
  // Simpler label row
  const hourLabels = C.dim + "0  3  6  9  12 15 18 21" + C.reset;
  heatLines.push(hourLabels);
  heatLines.push("");
  const peakHour = heatData.indexOf(Math.max(...heatData));
  heatLines.push(C.dim + t(`高峰时段: ${peakHour}:00 (${heatData[peakHour]} 会话)`, `Peak: ${peakHour}:00 (${heatData[peakHour]} sessions)`) + C.reset);

  const bottomRows = Math.max(sleepLines.length, heatLines.length);
  const sleepCard = card(t("睡眠", "Sleep"), sleepLines, W, bottomRows);
  const heatCard = card(t("工作热力图 (7天)", "Heatmap (7d)"), heatLines, W, bottomRows);

  const bottomRow = sideBySide(sleepCard, heatCard);
  lines.push(...bottomRow.map(l => "  " + l));
  lines.push("");

  // Top models
  const modelMap: Record<string, { count: number; tokens: number; cost: number }> = {};
  for (const s of sessions) {
    if (!s.model) continue;
    const key = s.model;
    if (!modelMap[key]) modelMap[key] = { count: 0, tokens: 0, cost: 0 };
    modelMap[key].count++;
    modelMap[key].tokens += s.totalTokens;
    modelMap[key].cost += s.cost;
  }
  const topModels = Object.entries(modelMap).sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);
  const modelLines: string[] = [];
  for (const [model, stats] of topModels) {
    const shortName = model.length > 25 ? model.slice(0, 22) + "..." : model;
    modelLines.push(
      padR(shortName, 26) +
      C.dim + padR(String(stats.count) + t("次", "x"), 8) + C.reset +
      padR(formatTokens(stats.tokens), 8) +
      C.yellow + "¥" + stats.cost.toFixed(2) + C.reset
    );
  }
  if (modelLines.length === 0) modelLines.push(C.dim + t("(无数据)", "(no data)") + C.reset);
  const modelCard = card(t("模型使用排行", "Model Usage"), modelLines, W * 2 + 4);
  lines.push(...modelCard.map(l => "  " + l));
  lines.push("");

  // Weekly contribution graph (GitHub style)
  const weekLines: string[] = [];
  const dayData = new Array(7).fill(0);
  for (let i = 6; i >= 0; i--) {
    const dayStart = todayStart - i * 86400000;
    const dayEnd = dayStart + 86400000;
    dayData[6 - i] = commits.filter(c => c.date >= dayStart && c.date < dayEnd).length;
  }
  const dayNames = ZH
    ? ["一", "二", "三", "四", "五", "六", "日"]
    : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekdayOfToday = (new Date().getDay() + 6) % 7;

  let weekRow = "";
  for (let i = 0; i < 7; i++) {
    const count = dayData[i];
    const dayIdx = (weekdayOfToday - 6 + i + 7) % 7;
    const bg = count === 0 ? C.dim + "·" :
               count < 10 ? C.green + "▪" :
               count < 50 ? C.green + C.bold + "▪" :
               C.yellow + C.bold + "▪";
    weekRow += " " + bg + C.reset;
  }
  weekLines.push(t("近7天提交: ", "7d commits: ") + weekRow + "  " + C.dim + dayData.reduce((a, b) => a + b, 0) + t(" 总计", " total") + C.reset);
  const totalSessions7d = sessions.length;
  const totalCost7d = sessions.reduce((s, x) => s + x.cost, 0);
  const totalTokens7d = sessions.reduce((s, x) => s + x.totalTokens, 0);
  weekLines.push("");
  weekLines.push(
    C.dim + t("7天汇总: ", "7d total: ") + C.reset +
    C.bold + totalSessions7d + C.reset + t(" 会话", " sessions") + "  " +
    C.bold + formatTokens(totalTokens7d) + C.reset + " tokens  " +
    C.yellow + C.bold + "¥" + totalCost7d.toFixed(2) + C.reset
  );

  const weekCard = card(t("周报", "Weekly"), weekLines, W * 2 + 4);
  lines.push(...weekCard.map(l => "  " + l));
  lines.push("");

  lines.push(C.dim + "  " + t(
    "genshin god h <1|sessions|2|agents|3|commits|4|sleep|5|cost>",
    "genshin god h <1|sessions|2|agents|3|commits|4|sleep|5|cost>"
  ) + C.reset);
  lines.push("");

  return lines.join("\n");
}

function renderSleepBar(cycle: SleepCycle): string {
  const totalH = cycle.duration / 3600000;
  const barLen = Math.min(Math.round(totalH * 2), 20);
  const color = totalH >= 7 ? C.blue : totalH >= 5 ? C.yellow : C.red;
  return color + "█".repeat(barLen) + C.reset;
}

function renderSessionsDetail(sessions: SessionSummary[], agents: AgentInfo[]): string {
  const lines: string[] = [];
  const agentMap = new Map(agents.map(a => [a.id, a.name]));

  lines.push("");
  lines.push(C.bold + "  " + t("会话详情 (最近20)", "Sessions (last 20)") + C.reset);
  lines.push("");

  const recent = sessions.slice(-20).reverse();
  if (recent.length === 0) {
    lines.push("  " + C.dim + t("(无数据)", "(no data)") + C.reset);
  } else {
    for (const s of recent) {
      const date = new Date(s.start);
      const timeStr = `${String(date.getMonth() + 1).padStart(2)}/${String(date.getDate()).padStart(2)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      const dur = formatDuration(s.end - s.start);
      const agent = agentMap.get(s.agentId) || s.agentId.slice(0, 8);
      const shortModel = s.model ? s.model.slice(0, 18) : "?";
      lines.push(
        "  " + C.dim + timeStr + C.reset +
        "  " + padR(agent, 28) +
        "  " + C.dim + padR(shortModel, 20) + C.reset +
        "  " + padR(String(s.messages) + t("条", "msg"), 8) +
        "  " + padR(formatTokens(s.totalTokens), 8) +
        "  " + C.yellow + "¥" + s.cost.toFixed(2) + C.reset +
        "  " + C.dim + dur + C.reset
      );
    }
  }
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

function renderAgentsDetail(agents: AgentInfo[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(C.bold + "  " + t("Agent 列表", "Agents") + C.reset);
  lines.push("");

  const active = agents.filter(a => !a.archived).sort((a, b) => b.lastSeen - a.lastSeen);
  const archived = agents.filter(a => a.archived);

  lines.push("  " + C.bold + t(`活跃 (${active.length})`, `Active (${active.length})`) + C.reset);
  for (const a of active.slice(0, 15)) {
    const seen = new Date(a.lastSeen);
    const ago = formatDuration(Date.now() - a.lastSeen);
    lines.push(
      "  " + C.green + "●" + C.reset +
      " " + padR(a.name, 35) +
      " " + C.dim + a.id + C.reset +
      "  " + C.dim + ago + t(" 前", " ago") + C.reset
    );
  }
  if (active.length > 15) lines.push("  " + C.dim + `  ... ${active.length - 15} more` + C.reset);

  lines.push("");
  lines.push("  " + C.dim + t(`归档 (${archived.length})`, `Archived (${archived.length})`) + C.reset);
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

function renderCommitsDetail(commits: CommitInfo[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(C.bold + "  " + t("提交历史 (最近30)", "Commits (last 30)") + C.reset);
  lines.push("");

  const recent = commits.slice(-30).reverse();
  for (const c of recent) {
    const date = new Date(c.date);
    const timeStr = `${String(date.getMonth() + 1).padStart(2)}/${String(date.getDate()).padStart(2)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const shortHash = c.hash.slice(0, 7);
    const msg = c.message.length > 60 ? c.message.slice(0, 57) + "..." : c.message;
    lines.push("  " + C.dim + timeStr + C.reset + "  " + C.yellow + shortHash + C.reset + "  " + msg);
  }
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

function renderSleepDetail(sleepCycles: SleepCycle[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(C.bold + "  " + t("睡眠分析", "Sleep Analysis") + C.reset);
  lines.push("");

  if (sleepCycles.length === 0) {
    lines.push("  " + C.dim + t("(未检测到睡眠周期。需要合盖睡眠记录。)", "(no sleep cycles detected)") + C.reset);
  } else {
    // Timeline
    for (const cycle of sleepCycles) {
      const sleepTime = new Date(cycle.sleepStart);
      const wakeTime = new Date(cycle.wakeEnd);
      const durH = (cycle.duration / 3600000).toFixed(1);
      const quality = cycle.duration >= 7 * 3600000 ? C.green + "充足" :
                      cycle.duration >= 5 * 3600000 ? C.yellow + "一般" : C.red + "不足";

      lines.push("  " + C.bold +
        `${sleepTime.getMonth() + 1}/${sleepTime.getDate()} ` +
        `${String(sleepTime.getHours()).padStart(2, "0")}:${String(sleepTime.getMinutes()).padStart(2, "0")}` +
        C.reset + C.dim + " → " + C.reset +
        `${String(wakeTime.getHours()).padStart(2, "0")}:${String(wakeTime.getMinutes()).padStart(2, "0")}` +
        "  " + C.bold + durH + "h" + C.reset +
        "  " + quality + C.reset +
        "  " + renderSleepBar(cycle)
      );
    }

    lines.push("");
    const avgSleep = sleepCycles.reduce((s, c) => s + c.duration, 0) / sleepCycles.length;
    const avgBed = sleepCycles.reduce((s, c) => s + new Date(c.sleepStart).getHours() + new Date(c.sleepStart).getMinutes() / 60, 0) / sleepCycles.length;
    const avgWake = sleepCycles.reduce((s, c) => s + new Date(c.wakeEnd).getHours() + new Date(c.wakeEnd).getMinutes() / 60, 0) / sleepCycles.length;

    lines.push("  " + t("统计:", "Stats:"));
    lines.push("  " + t("  平均睡眠: ", "  Avg sleep: ") + C.bold + (avgSleep / 3600000).toFixed(1) + "h" + C.reset);
    lines.push("  " + t("  平均入睡: ", "  Avg bedtime: ") + C.bold + Math.floor(avgBed) + ":" + String(Math.round((avgBed % 1) * 60)).padStart(2, "0") + C.reset);
    lines.push("  " + t("  平均起床: ", "  Avg wake: ") + C.bold + Math.floor(avgWake) + ":" + String(Math.round((avgWake % 1) * 60)).padStart(2, "0") + C.reset);
  }
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

function renderCostDetail(sessions: SessionSummary[]): string {
  const lines: string[] = [];
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  lines.push("");
  lines.push(C.bold + "  " + t("成本分析", "Cost Analysis") + C.reset);
  lines.push("");

  // Daily breakdown
  lines.push("  " + C.bold + t("每日花费:", "Daily cost:") + C.reset);
  for (let i = 6; i >= 0; i--) {
    const dayStart = todayStart - i * 86400000;
    const dayEnd = dayStart + 86400000;
    const daySessions = sessions.filter(s => s.start >= dayStart && s.start < dayEnd);
    const dayCost = daySessions.reduce((s, x) => s + x.cost, 0);
    const dayTokens = daySessions.reduce((s, x) => s + x.totalTokens, 0);
    const d = new Date(dayStart);
    const dateStr = `${d.getMonth() + 1}/${String(d.getDate()).padStart(2)}`;
    const isToday = i === 0;
    const prefix = isToday ? C.bold + C.cyan + "▸" : " ";
    lines.push(
      "  " + prefix + " " + dateStr + C.reset +
      "  " + progressBar(dayCost, Math.max(...Array.from({ length: 7 }, (_, j) => {
        const ds = todayStart - (6 - j) * 86400000;
        return sessions.filter(s => s.start >= ds && s.start < ds + 86400000).reduce((s, x) => s + x.cost, 0);
      }), 1), 20, C.yellow) +
      "  " + C.yellow + "¥" + dayCost.toFixed(2) + C.reset +
      "  " + C.dim + formatTokens(dayTokens) + " tokens" + C.reset +
      "  " + C.dim + daySessions.length + t("次", "x") + C.reset
    );
  }

  lines.push("");
  const total7d = sessions.reduce((s, x) => s + x.cost, 0);
  const avgDaily = total7d / 7;
  lines.push("  " + t("7天总计: ", "7d total: ") + C.yellow + C.bold + "¥" + total7d.toFixed(2) + C.reset);
  lines.push("  " + t("日均: ", "Avg/day: ") + C.yellow + "¥" + avgDaily.toFixed(2) + C.reset);
  lines.push("  " + t("月估: ", "Monthly est: ") + C.yellow + "¥" + (avgDaily * 30).toFixed(0) + C.reset);

  lines.push("");
  lines.push("");
  return lines.join("\n");
}

// ── Niuma score calculation ──

interface NiumaBreakdown {
  total: number;
  workHours: { score: number; raw: number };
  sessionCount: { score: number; raw: number };
  commits: { score: number; raw: number };
  lateNight: { score: number; raw: number };
  streak: { score: number; raw: number };
}

function calcNiumaScore(sessions: SessionSummary[], commits: CommitInfo[], sleepCycles: SleepCycle[]): NiumaBreakdown {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  const todaySessions = sessions.filter(s => s.start >= todayStart);

  let workHoursRaw = 0;
  if (todaySessions.length > 0) {
    const sorted = [...todaySessions].sort((a, b) => a.start - b.start);
    workHoursRaw = (sorted[sorted.length - 1].end - sorted[0].start) / 3600000;
  }
  const workHoursScore = Math.min(Math.round(workHoursRaw * 2.5), 25);

  const sessionCountScore = Math.min(todaySessions.length * 2, 20);

  const todayCommits = commits.filter(c => c.date >= todayStart);
  const commitsScore = Math.min(Math.round(todayCommits.length * 0.3), 15);

  const lateNight = todaySessions.filter(s => {
    const h = new Date(s.start).getHours();
    return h >= 0 && h < 6;
  });
  const lateNightScore = Math.min(lateNight.length * 5, 20);

  let streak = 0;
  for (let i = 0; i < 7; i++) {
    const dayStart = todayStart - i * 86400000;
    const dayEnd = dayStart + 86400000;
    if (sessions.some(s => s.start >= dayStart && s.start < dayEnd)) streak++;
    else break;
  }
  const streakScore = Math.min(streak * 3, 20);

  const total = Math.min(workHoursScore + sessionCountScore + commitsScore + lateNightScore + streakScore, 100);

  return {
    total,
    workHours: { score: workHoursScore, raw: workHoursRaw },
    sessionCount: { score: sessionCountScore, raw: todaySessions.length },
    commits: { score: commitsScore, raw: todayCommits.length },
    lateNight: { score: lateNightScore, raw: lateNight.length },
    streak: { score: streakScore, raw: streak },
  };
}

// ── Main loop ──

async function main() {
  const arg = process.argv[2] || "";
  const sessions = collectSessions(7);
  const commits = collectCommits(7);
  const sleepCycles = collectSleepCycles(7);
  const agents = loadAgents();

  const out: string[] = [];
  if (arg === "1" || /^sessions?$/i.test(arg) || arg === "会话") {
    out.push(renderSessionsDetail(sessions, agents));
  } else if (arg === "2" || /^agents?$/i.test(arg)) {
    out.push(renderAgentsDetail(agents));
  } else if (arg === "3" || /^commits?$/i.test(arg) || arg === "提交") {
    out.push(renderCommitsDetail(commits));
  } else if (arg === "4" || /^sleep$/i.test(arg) || arg === "睡眠") {
    out.push(renderSleepDetail(sleepCycles));
  } else if (arg === "5" || /^cost$/i.test(arg) || arg === "花费") {
    out.push(renderCostDetail(sessions));
  } else {
    out.push(renderOverview(sessions, commits, sleepCycles, agents));
    out.push(renderSessionsDetail(sessions, agents));
    out.push(renderCommitsDetail(commits));
    out.push(renderCostDetail(sessions));
  }

  process.stdout.write(out.join("\n"));
}

main().catch(e => { console.error(e); process.exit(1); });
