// 文档: B.docs/Dev.Common/Wiki/Execute(Command Tool).WIKI
// 文档: B.docs/Dev.Common/Wiki/Hands(Organ).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { exec } from "node:child_process";
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { outboxSend } from "../kernel.backbone/backbone.ts"; // 2026-08-20:outbox 已合并进 backbone.ts(不再单独文件)
import { renderToolCall, renderMessage, stripResultTokenMark, stripInlineBgTag, renderExecuteResult } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { validateExecute } from "../hands.fileacts/fileacts.ts";
import { personId } from "../kernel.heart/heart-state.ts";
import { writeFileAtomic } from "#paths";

// ── execute 执行记录(ExecuteData)──
// 每次 execute 落盘一条 JSON:命令、耗时、退出码、完整输出。
// agent 需要完整结果时用 read 查看,cmd-done 只发尾部摘要,避免 context 被垃圾填满。
// 目录: ~/.teyvat/ExecuteData/<personId>/
const EXECUTE_DATA_DIR = join(homedir(), ".teyvat", "ExecuteData");

function execPersonDir(): string {
  const pid = personId() || "unknown";
  return join(EXECUTE_DATA_DIR, pid);
}

function execRecordFile(id: string): string {
  return join(execPersonDir(), `${id}.json`);
}

// 短 ID:YYMMDD-HHMMSS-命令哈希8hex(如 260811-095512-a1b2c3d4)。
// 本地时间可读(用户能读出几点跑的)+ 命令哈希(内容指纹/防冲突)。
// 全链路一致:文件、index、显示、沟通都用同一个 id,不缩短不映射(教训:分层 id 导致人机沟通错误)。
function shortRecId(cmd: string): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const hash = require("crypto").createHash("sha256").update(cmd).digest("hex").slice(0, 8);
  return `${yy}${mo}${dd}-${hh}${mm}${ss}-${hash}`;
}

// 记录路径的可读短形式:ExecuteData/<id>.json(省去 ~/.teyvat/<personId>/ 前缀)
function shortRecPath(file: string): string {
  const m = file.match(/ExecuteData\/[^\/]+\/([^\/]+\.json)$/);
  return m ? `ExecuteData/${m[1]}` : file;
}

function recordExecute(data: {
  id: string; command: string; cwd?: string; title?: string;
  start_time: number; end_time: number; exit_code: number;
  stdout: string; stderr: string; truncated?: boolean;
}): string {
  try {
    mkdirSync(execPersonDir(), { recursive: true });
    const file = execRecordFile(data.id);
    const rec: any = { ...data };
    if (!rec.title) delete rec.title; // 无标题不落字段,保持记录干净
    writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
    return file;
  } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); return ""; }
}

// ── 历史记录查询(action:'show' + historical,2026-09-04 test-01 反馈)──
// 任务完成即离开 running 列表,show 立刻查不到刚结束的任务。historical:true 直接读落盘记录。
function findHistoricalFiles(idStr: string): string[] {
  try {
    const files = readdirSync(execPersonDir()).filter((f) => f.endsWith(".json"));
    const exact = files.filter((f) => f === `${idStr}.json`);
    if (exact.length > 0) return exact;
    if (/^\d/.test(idStr)) return files.filter((f) => f.startsWith(idStr)); // 前缀匹配仅限 id 样式(数字开头)
    return [];
  } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); return []; }
}

function formatHistoricalRecord(file: string): string {
  try {
    const rec = JSON.parse(readFileSync(file, "utf8"));
    const id = rec.id || file.replace(/\.json$/, "");
    const elapsed = rec.end_time && rec.start_time ? Math.max(1, Math.round((rec.end_time - rec.start_time) / 1000)) : 0;
    const head = `[历史] ${id}${rec.title ? `  ${rec.title}` : ""}  (elapsed ${elapsed}s, exit ${rec.exit_code ?? "?"})`;
    const cmdLine = `$ ${rec.command || "(unknown command)"}${rec.cwd ? `\n  cwd: ${rec.cwd}` : ""}`;
    const out = typeof rec.stdout === "string" ? rec.stdout : "";
    const lines = out ? out.split("\n") : [];
    const TAIL = 30;
    const tail = lines.slice(-TAIL).join("\n");
    const note = lines.length > TAIL ? `\n... (${lines.length - TAIL} lines earlier omitted - full record: ${shortRecPath(file)})` : "";
    const err = rec.stderr ? `\n--- stderr ---\n${String(rec.stderr).slice(0, 2000)}` : "";
    return `${head}\n${cmdLine}\n--- stdout ---\n${tail || "(empty)"}${note}${err}`;
  } catch (e: any) {
    return `[历史] 记录读取失败: ${shortRecPath(file)} - ${e?.message || e}`;
  }
}

// ── shell 工具函数(terminal.ts 等外部模块也用)──

export function asyncSh(cmd: string, timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf8", timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function asyncShSafe(cmd: string, timeout = 5000): Promise<string> {
  try { return await asyncSh(cmd, timeout); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); return ""; }
}

// ── tmux 助手(原 terminal.ts,整合至此)──
function getAgentScope(): string {
  const m = process.title.match(/genshin:[^(]+\([^,]+,\s*([^,)]+)/);
  return (m?.[1] || "unknown").slice(0, 8);
}
const TMUX_PFX = () => "dev-" + getAgentScope() + "-";
const tmuxClean = (n: string) => TMUX_PFX() + (n || `t${Date.now().toString().slice(-5)}`).replace(/[^a-zA-Z0-9_]/g, "");
const tmuxHas = async (n: string): Promise<boolean> => {
  try { await asyncSh(`tmux has-session -t ${n} 2>/dev/null`); return true; } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); return false; }
};
const tmuxPeek = async (n: string): Promise<string> => {
  return (await asyncShSafe(`tmux capture-pane -pt ${n} -S -200 2>/dev/null`)).split("\n").filter(Boolean).slice(-60).join("\n");
};

// ── execute tool ──

// 后台化阈值:快命令直接返回,慢命令自动后台
const BG_THRESHOLD_MS = 1000;

interface RunningCmd {
  command: string;
  abort: AbortController;
  startTime: number;
  killedByUser: boolean;
  context: string;
  accum: string;
  type: "bg" | "tty";
  tmuxSession?: string;
  /** 执行记录 id(shortRecId(cmd)),供 TUI 黄点判定"该任务是否仍在运行" */
  recId?: string;
  /** 人类可读的任务标题(可选,/b 列表与 @ 列表优先显示) */
  title?: string;
}

// 后台任务注册表(模块级:heart-hibernate 等需要读取摘要)
const running = new Map<number, RunningCmd>();
function updateBgCount() {
  const v = running.size;
  (globalThis as any).__genshinBgCount = v;
  (process as any).__genshinBgCount = v;
  // 所有后台任务的 startTime(升序,供 statebar 显示各自 lasting 时长)
  const starts: number[] = [];
  for (const rc of running.values()) starts.push(rc.startTime);
  starts.sort((a, b) => a - b);
  (globalThis as any).__genshinBgStarts = starts;
  (process as any).__genshinBgStarts = starts;
  // 运行中任务的执行记录 id 集合(TUI 用:对应 execute 调用行在任务完成前显示黄点)
  const recIds = new Set<string>();
  for (const rc of running.values()) if (rc.recId) recIds.add(rc.recId);
  (globalThis as any).__genshinBgRunningRecIds = recIds;
  (process as any).__genshinBgRunningRecIds = recIds;
  // /b 命令用:完整任务快照(id/command/type/startTime/recId/accum 尾部),供 TUI 命令层读取
  // 注意:解构 [id, rc] 必须用 entries()--values() 给的是 RunningCmd 本体,不可迭代
  // (2026-08-15 bun tsc 严格检查报 TS2488,运行时只要有 bg 任务就会抛错)
  const tasks: any[] = [];
  for (const [id, rc] of running.entries()) {
    tasks.push({
      id,
      command: rc.command,
      type: rc.type,
      startTime: rc.startTime,
      recId: rc.recId ?? "",
      tmuxSession: rc.tmuxSession ?? "",
      title: rc.title ?? "",
      tail: rc.accum ? rc.accum.split("\n").slice(-2).join(" | ").slice(-120) : "",
    });
  }
  tasks.sort((a, b) => a.startTime - b.startTime);
  (globalThis as any).__genshinBgTasks = tasks;
  (process as any).__genshinBgTasks = tasks;
  // 后台任务集合变化 → 对应 execute 调用行的黄点需要重渲染(完成变绿/新建变黄)
  try { (globalThis as any).__genshinRefreshUI?.(); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
}

/** 终止第 id 个后台任务(/b kill 与 @N kill 共用同一路径) */
// 2026-09-04(test-01 反馈):字符串任务 ID(recId,如 "260904-154249-9fca9e02")→ running Map 的 number 键。
// action show/kill 的 id 此前只收 number(schema 与解析都是),但任务 ID 实际全是 recId 字符串--支持完整 ID 或前缀匹配。
// 2026-09-11(prime-agent):前缀命中**多条**时不再静默取第一条 -- 与 historical show 的处理对齐(那边会列候选)。
// 否则 `kill id:"2609"` 可能杀掉当天第一个匹配的任务(例如正在跑的训练),而 agent 以为自己杀的是另一个。
function recIdsMatching(s: string): number[] {
  const out: number[] = [];
  for (const [key, rc] of running) {
    if (rc.recId === s || (rc.recId && rc.recId.startsWith(s))) out.push(key);
  }
  return out;
}
function recIdToKey(s: string): number | null {
  const hits = recIdsMatching(s);
  return hits.length === 1 ? hits[0] : null;   // 歧义(>1)返回 null,由调用方报候选
}

export async function killBackgroundTask(id: number): Promise<string> {
  const rc = running.get(id);
  if (!rc) return `@${id}: not found`;
  if (rc.type === "tty" && rc.tmuxSession) {
    await asyncShSafe(`tmux kill-session -t ${rc.tmuxSession} 2>/dev/null`);
  }
  rc.abort.abort();
  rc.killedByUser = true;
  running.delete(id);
  updateBgCount();
  return `@${id} killed`;
}
(globalThis as any).__genshinKillBg = killBackgroundTask;
(process as any).__genshinKillBg = killBackgroundTask;

/** 后台任务摘要(@ 列表同格式),供 hibernate 等拦截消息直接展示 */
export function backgroundTasksSummary(): string {
  if (running.size === 0) return "";
  const lines = [i18n(`${running.size} 个后台 Execute 任务在运行:`, `${running.size} background Execute task(s) running:`) ];
  for (const [id, rc] of running) {
    const elapsed = Math.round((Date.now() - rc.startTime) / 1000);
    const typeTag = rc.type === "tty" ? "tty" : "bg ";
    // 有标题优先显示标题(人类可读),无则截断命令
    const display = rc.title || (rc.command.length > 60 ? rc.command.slice(0, 57) + "..." : rc.command);
    lines.push(`  @${id}  ${elapsed}s  ${typeTag}  ${display}`);
  }
  return lines.join("\n");
}

export default function registerExecute(pi: ExtensionAPI) {
  let nextExecId = 1;
  let _lastCmd = "";
let _lastBgHash = ""; // @ 缓存:避免相同输出重复占用 context


  pi.on("before_agent_start", async () => {
    try {
      const active = pi.getActiveTools();
      if (active.includes("bash")) pi.setActiveTools(active.filter((n: string) => n !== "bash"));
    } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); };
  });

  registerPaimonTool({
    name: "execute",
    label: "Execute",
    messageDescription: "Execute shell command. Fast commands return immediately, while slow commands auto-background. terminal:true for tmux (progress bars, training), completes push a notice unless notify:false. title is REQUIRED: the PURPOSE of this command (why), not the action - the same command can mean different things in different contexts, and title captures the intent (e.g. \"确认模型权重已下载\" not \"ls\"). title shows in @ list / /b / cmd-done Result instead of the raw command. Manage background tasks via 'action' (teyvat convention): execute({action:'list'}) to list, {action:'show', id:3} for task 3 details, {action:'kill', id:33} or id:[33,34] to terminate - framework-native, returns termination result. Finished tasks left the running list: {action:'show', id:'<task-id>', historical:true} reads their ExecuteData record (recId exact or unique prefix). ⚠️ NEVER use shell pkill/kill/tmux kill-server to kill background tasks: the process dies but the background record lingers (blocks hibernate). Every execution is recorded to ~/.teyvat/ExecuteData/<your-person-id>/<id>.json; the result message shows [id: xxx] so you can read the full record via that path.",
    promptSnippet: "Execute shell command. title REQUIRED - purpose (why), not action. terminal:true for tmux; notify:false to skip completion notice. Background tasks via action: {action:'list'} / {action:'show',id:N} / {action:'kill',id:N or [Ns]} - NOT shell pkill/kill (record lingers → blocks hibernate). Finished tasks: {action:'show',id:'<task-id>',historical:true}. Result shows [id: xxx] → full record at ~/.teyvat/ExecuteData/<personId>/<id>.json (use read).",
    parameters: Type.Object({
      command: Type.String({ messageDescription: "Shell command to execute" }),
      title: Type.String({ messageDescription: i18n("REQUIRED. Purpose of this command (why you run it), e.g. '确认权重已下载' - same command can have different intents; title captures the intent. Shows in @ list / /b / cmd-done instead of raw command", "REQUIRED. Purpose of this command (why you run it), e.g. 'verify weights downloaded' - same command can have different intents; title captures the intent. Shows in @ list / /b / cmd-done instead of raw command") }),
      stream: Type.Optional(Type.Boolean({ messageDescription: "Stream output as command runs (long commands only)" })),
      terminal: Type.Optional(Type.Boolean({ messageDescription: "Run in tmux TTY (for progress bars, interactive commands, long training)" })),
      name: Type.Optional(Type.String({ messageDescription: "Terminal short name (e.g. train). Required for peek/close via @N" })),
      cwd: Type.Optional(Type.String({ messageDescription: "Working directory for this command (all modes; avoids hand-writing cd prefixes - explicit per-call, no state kept)" })),
      notify: Type.Optional(Type.Boolean({ messageDescription: "Send a completion message when a background/terminal command finishes (default true; set false to stay quiet)" })),
      action: Type.Optional(Type.String({ messageDescription: "Operation mode (teyvat convention like social/amem): 'list'=list background tasks (alias of '@'), 'show'=view task N detail (alias of '@N', use with id), 'kill'=terminate background task(s) (use with id, e.g. 33 or [33, 34]) - when action present, command is not executed (except list/show which only inspect)" })),
      id: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Array(Type.Union([Type.Number(), Type.String()]))], { messageDescription: "Background task id(s) - for action='show' (single id) or action='kill'; accepts the @N number or the full task-ID string (e.g. 260904-154249-9fca9e02)" })),
      historical: Type.Optional(Type.Boolean({ messageDescription: "For action='show': read the finished-task record from ExecuteData by recId (exact or unique prefix). Completed tasks leave the running list immediately - pass historical:true to read their full record (stdout tail 30 lines + stderr)" })),
    }),
    renderCall(args: any, theme: any) {
      let cmd = args?.command || _lastCmd || "...";
      const title = String(args?.title || "").trim();
      // 2026-09-13（用户定稿）：调用行 = 标题 + 「摘要」显示/隐藏。
      // 摘要隐藏（默认）= 只有标题；摘要显示 = 标题 + 命令前 3 行（+N more）。
      const showSummary = (globalThis as any).__genshinExecuteSummary === true;
      // 2026-09-13（用户）：Execute 调用行的原点默认隐藏（/s「Execute 原点」开关），其他 tool 不影响
      const showDot = (globalThis as any).__genshinExecuteDot === true;
      const dotOpts = showDot ? undefined : { noDot: true };
      const label = args?.terminal === true ? "Execute(T)" : "Execute";
      if (!showSummary) {
        if (title) return renderToolCall.label(theme, label, title, dotOpts);
        // 模型没传 title（虽然 schema required）——fallback 到命令首行截短，灰色表示不是标题
        const cmdShort = cmd.split("\n")[0].slice(0, 60) + (cmd.length > 60 ? "…" : "");
        return renderToolCall.label(theme, label, theme.fg("dim", cmdShort), dotOpts);
      }
      // 命令处理（breakAnd）在模式分支前统一执行
      if ((globalThis as any).__genshinExecuteBreakAnd && cmd.includes(" && ")) {
        cmd = cmd.split(" && ").join(" &&\n");
      }
      const _lines = cmd.split("\n").filter((l: string) => l.trim());
      const brief = _lines.length > 3 ? _lines.slice(0, 3).join("\n") + "\n... +" + (_lines.length - 3) + " more" : cmd;
      return renderToolCall.detail(theme, label, title, brief, dotOpts);
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      // 2026-09-13（ISSUE 226）：三种结果样式（快命令 / Created / cmd-done）统一由 blocks_nongod.renderExecuteResult 画，这里只把 details 映射成 state。
      // 此前快命令与 Created 两个分支各自手拼 Container：硬编码 "⎿  "（绕过 WSL 回退）、各算一遍 HH:MM:SS、各读一遍三态、
      // 算了从未显示的 token 数（timeTok）、还有一整块 if (false) 的旧 compactExecute 逻辑；与 renderers.ts 的 cmd-done 渲染器三套并存。
      // 历史规范仍然有效：⎿ 只出现一次（摘要行）；时间取事件时刻（details.endTs / createdInfo.ts，LESSON 094）；
      // 快命令返回内容 dim；Created 行不重复 title（2026-08-27 用户要求）、id 用 ExecuteData 记录 id 不用 #N、不渲染 renderText。
      const d = result?.details || {};
      const execId = d.execId;
      const createdInfo = d.createdInfo;
      // 快命令：有 execId 但无 createdInfo。renderText 是给用户的干净文本（content 保留 [id]/[background] 给模型，2026-09-08 用户：信息源头分开）
      if (execId && !createdInfo) {
        const rc = d.renderText != null ? [{ type: "text", text: d.renderText }] : resultContent(result);
        const outText = stripResultTokenMark(rc.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n"));
        return renderExecuteResult(theme, { kind: "fast", exitCode: d.exitCode, elapsedMs: d.elapsedMs, endTs: d.endTs, output: outText });
      }
      // 后台 / terminal 创建行
      if (execId && createdInfo) {
        return renderExecuteResult(theme, { kind: "created", created: createdInfo.created, total: createdInfo.total, terminal: d.terminal === true, tname: d.tname, recId: d.recId || execId, endTs: createdInfo.ts });
      }
      // 其余（@ 列表 / kill 结果 / 被拦 / self-reboot 提示等）：通用输出管线，三态同样生效（2026-09-13 用户：有 renderText 的结果也要遵守 hide/summary）
      const resultMode = (globalThis as any).__genshinExecuteResult ?? "full";
      if (resultMode === "hide") return renderMessage.silent();
      const rc0 = d.renderText != null ? [{ type: "text", text: d.renderText }] : resultContent(result);
      // 2026-09-07（用户：running/@N kill 与尾部 [id] 只在 feed 保留——渲染用户显示过滤）：feed content 不动，只对渲染副本剥；
      // [background: …] 可能不在尾部（用户样例夹在中间）→ stripInlineBgTag；尾部标签组 → stripResultTokenMark（均为 blocks_nongod 唯一实现）
      const rc = rc0.map((x: any) => {
        if (x.type !== "text" || typeof x.text !== "string") return x;
        let t = stripResultTokenMark(stripInlineBgTag(x.text));
        if (resultMode === "summary") { const ls = t.split("\n"); if (ls.length > 5) t = ls.slice(0, 5).join("\n"); }
        return t === x.text ? x : { ...x, text: t };
      });
      return renderMessage.output(theme, ctx, rc);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // 2026-08-20 结构化 action 参数(用户定稿:废弃 @N kill 字符串魔法--命令字符串里塞指令靠拦截是垃圾设计):
      // execute({action:'list'}) 列后台任务 / {action:'show', id:3} 看详情 / {action:'kill', id:33} 或 id:[33,34] 终止。
      // list/show 改写 cmd 复用下方 @ 解析;kill 直接走 killBackgroundTask。@/@N 字符串拦截保留兼容(不再教)。
      // 2026-08-20 短命令别名:action 支持 k/l/s(kill/list/show 缩写,teyvat 短命令习惯)
      const ACTION_ALIASES: Record<string, string> = { k: "kill", l: "list", s: "show", sh: "show" };
      let action = (params as any).action;
      if (typeof action === "string" && ACTION_ALIASES[action]) action = ACTION_ALIASES[action];
      const idParam = (params as any).id;
      // 2026-09-04:id 参数统一解析(number=@N 键;字符串=recId 任务 ID/前缀 → 反查 number 键)
      const toTaskKey = (v: any): number | null => {
        if (typeof v === "number") return v;
        const s = String(v).trim();
        if (/^\d+$/.test(s)) return parseInt(s, 10);
        return recIdToKey(s);
      };
      let cmd = params.command;
      if (action === "list") cmd = "@";
      if (action === "show" && idParam != null) {
        // 2026-09-04:historical 参数--任务完成即离开 running 列表,historical:true 直接读 ExecuteData 落盘记录。
        // id 收 recId 全串或唯一前缀;前缀命中多条 → 列候选;查无落盘记录 → 回退 running 查询。
        const wantHistorical = (params as any).historical === true;
        const key = toTaskKey(idParam);
        if (wantHistorical && typeof idParam === "string") {
          const idStr = idParam.trim();
          const hits = findHistoricalFiles(idStr);
          if (hits.length === 1) return { content: [{ type: "text", text: formatHistoricalRecord(join(execPersonDir(), hits[0])) }] };
          if (hits.length > 1) {
            const cands = hits.map((f) => `  ${f.replace(/\.json$/, "")}`).join("\n");
            return { content: [{ type: "text", text: `show (historical): id 前缀 ${JSON.stringify(idStr)} 命中 ${hits.length} 条记录,请用完整 id:\n${cands}` }] };
          }
          if (key == null) return { content: [{ type: "text", text: `show (historical): no record matches id ${JSON.stringify(idStr)} in ExecuteData (use action:'list' for running tasks)` }], isError: true };
          // 查无落盘记录但 running 里有 → 落到下方 running 查询
        } else if (key == null) {
          const hits2 = (typeof idParam === "string" && !/^\d+$/.test(idParam.trim())) ? recIdsMatching(idParam.trim()) : [];
          if (hits2.length > 1) {
            const cands2 = hits2.map((k) => `  @${k}  ${running.get(k)?.recId}  ${String(running.get(k)?.title || running.get(k)?.command || "").slice(0, 60)}`).join("\n");
            return { content: [{ type: "text", text: `show: id 前缀 ${JSON.stringify(idParam)} 命中 ${hits2.length} 个任务,请给完整 id:\n${cands2}` }] };
          }
          return { content: [{ type: "text", text: `show: no task matches id ${JSON.stringify(idParam)} (use action:'list' to see current ids; finished tasks: add historical:true)` }], isError: true };
        }
        cmd = "@" + key;
      }
      if (action === "kill") {
        const rawIds = Array.isArray(idParam) ? idParam : idParam != null ? [idParam] : [];
        if (rawIds.length === 0) return { content: [{ type: "text", text: "kill: missing id - execute({action:'kill', id: 33}) or id:[33, 34] or id:'260904-154249-9fca9e02'" }], isError: true };
        const results: string[] = [];
        for (const raw of rawIds) {
          // 2026-09-11:字符串前缀命中多条 → 报候选(不静默杀第一个)
          const hits = (typeof raw === "string" && !/^\d+$/.test(String(raw).trim())) ? recIdsMatching(String(raw).trim()) : [];
          if (hits.length > 1) {
            const cands = hits.map((k) => `  @${k}  ${running.get(k)?.recId}  ${String(running.get(k)?.title || running.get(k)?.command || "").slice(0, 60)}`).join("\n");
            results.push(`kill: id 前缀 ${JSON.stringify(raw)} 命中 ${hits.length} 个任务,请给完整 id:\n${cands}`);
            continue;
          }
          const kid = toTaskKey(raw);
          results.push(kid == null ? `kill: no task matches id (use action:'list')` : await killBackgroundTask(kid));
        }
        return { content: [{ type: "text", text: results.join("\n") }] };
      }

      // ── self-reboot 特殊命令 ──────────────────────────────────────
      if (/^self[-_]?reboot\b/i.test(cmd.trim())) {
        const pid = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
        if (!pid) return { content: [{ type: "text", text: "ERR: cannot determine agent ID." }], details: {}, isError: true };
        const { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const rcDir = join(homedir(), ".teyvat/RuntimeCache", pid);
        const flagPath = join(rcDir, "self-reboot-auth");
        let authorized = false;
        try { authorized = !!JSON.parse(readFileSync(flagPath, "utf8")).authorized; } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        if (!authorized) {
          return { content: [{ type: "text", text:
            i18n("ERR: self-reboot 需要用户授权。\n请让用户执行: /a self-reboot\n授权后永久生效,不需要每次重新授权。",
                 "ERR: self-reboot requires user authorization.\nAsk the user to run: /a self-reboot\nAuthorization is permanent; no need to re-authorize each time.") }],
            details: {}, isError: true };
        }
        // 授权持久化,不删除 flag
        // 2026-08-20 完整重启(用户指示):self-reboot full <reason> -- launcher 也重启(重新快照+exec),
        // 这样 launcher.sh 的新改动(如 /h 的 headless 分支)在完整重启后生效;普通 self-reboot 不换 launcher。
        const fullRestart = /\bfull\b/i.test(cmd);
        const reason = cmd.replace(/^self[-_]?reboot\s*/i, "").replace(/^full\s*/i, "").trim() || "self-reboot";
        if (fullRestart) {
          try { writeFileAtomic(join(rcDir, "full-restart"), JSON.stringify({ ts: new Date().toISOString(), reason })); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        }
        // 保存当前累积运行时长,重启后接续(不重置计时器)
        const accumulated = (globalThis as any).__genshinSessionElapsed || 0;
        const statusBar = (globalThis as any).__genshinStatusBar;
        const seg = statusBar?._sessionAccumulated || 0;
        const segStart = statusBar?._segmentStartTime;
        const totalElapsed = seg + (segStart ? Date.now() - segStart : 0);
        try { writeFileAtomic(join(rcDir, "self-reboot-reason.json"), JSON.stringify({ reason, ts: new Date().toISOString(), elapsed: totalElapsed })); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        // ISSUE 140:标记即将 reboot,阻止 heart agent_end 续命(否则框架开新 turn 被 process.exit 打断 → abort → paused 循环)
        (globalThis as any).__genshinRebootPending = true;
        const nonce = `reboot-${Date.now()}`;
        // 2026-09-04 渲染保留:记录当前 pi session 文件 → launcher 重启时传 --session 恢复同一 session。
        // 否则 pi 开新 session → entries 空 → _replaySessionHistory() 渲染 0 条 → TUI 上文丢失
        // (记忆连续靠 heart 快照不受影响,纯渲染问题;参考 prime-agent renderSessionContext 思路)
        try {
          const sf = (_ctx as any)?.sessionManager?.getSessionFile?.();
          if (sf) { mkdirSync(rcDir, { recursive: true }); writeFileSync(join(rcDir, "restart-session.json"), JSON.stringify({ sessionFile: sf })); }
        } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        try { mkdirSync(rcDir, { recursive: true }); writeFileSync(join(rcDir, "wake-restart"), nonce); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        // process.exit 前手动写 tokenmaxxed.json(session_shutdown 可能来不及执行)
        try {
          const memDir = join(homedir(), ".teyvat/MemoryData", pid);
          const fp = join(memDir, "tokenmaxxed.json");
          // 2026-08-15 写入规范化(防污染):白名单提取,丢弃外来字段(source/input/output 等)
          let pond: any = { tokenmaxxed: 0, sessions: 0 };
          try {
            const raw = JSON.parse(readFileSync(fp, "utf8"));
            pond = {
              tokenmaxxed: raw?.tokenmaxxed || 0,
              sessions: raw?.sessions || 0,
              since: raw?.since,
              lastUpdated: raw?.lastUpdated,
              // ISSUE 109:白名单必须保留 delta 状态,否则重启后恢复不到基线
              prevPrompt: typeof raw?.prevPrompt === "number" ? raw.prevPrompt : null,
              prevOut: raw?.prevOut || 0,
            };
          } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
          const sess = (globalThis as any).__genshinPondSess;
          if (sess) {
            const delta = sess.tokens || 0;
            if (delta > 0) {
              pond.tokenmaxxed = (pond.tokenmaxxed || 0) + delta;
              pond.sessions = (pond.sessions || 0) + 1;
              pond.lastUpdated = new Date().toISOString();
              writeFileSync(fp, JSON.stringify(pond, null, 2));
            }
          }
        } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        // ISSUE 140 v2:缩短 exit 延迟(500→100ms)减少框架在 exit 前处理 tool result 开新 turn 的窗口
        // __genshinRebootPending 已阻止 agent_end 续命,100ms 够写完磁盘但不够开新 API 请求
        // 2026-09-13（用户拍板“自守护”）:【B】headless detached 进程不在 launcher 守护循环里——
        // self-reboot exit 后无人拉起 = 死亡（21:27 support 自重启后掉线实证）。
        // headless 模式下先 spawn 接续者（同 session-dir/fifo/日志，detached——新进程加载新代码）再退出。
        if (process.env.PAIMON_HEADLESS_DAEMON === "1") {
          try {
            const spawnBg = (globalThis as any).__genshinSpawnHeadlessBg;
            if (typeof spawnBg === "function") {
              spawnBg(pid, "self-reboot-continuity");
              console.error("[self-reboot] headless 自守护：接续者已 spawn（" + pid + "）");
              // headless 无 launcher，wake-restart nonce 无人消费——删掉避免下次前台启动误触发额外重启
              try { unlinkSync(join(rcDir, "wake-restart")); } catch { /* 不存在则跳过 */ }
            } else {
              console.error("[self-reboot] headless 自守护失败：__genshinSpawnHeadlessBg 未挂载（detach.ts 未加载）——进程将退出且无人拉起");
            }
          } catch (e) { console.error("[self-reboot] headless 自守护 spawn 失败: " + ((e as any)?.message || e)); }
        }
        setTimeout(() => { process.exit(0); }, 100);
        return { content: [{ type: "text", text:
          i18n(`self-reboot: 进程将在 0.5s 后退出并由 launcher 自动重启。\nreason: ${reason}\n` +
               `重启后:记忆快照重新冻结、make 后的代码变更生效。`,
               `self-reboot: process will exit in 0.5s and be restarted by the launcher.\nreason: ${reason}\n` +
               `After restart: memory snapshot re-frozen, make-applied code changes take effect.`) }],
          details: { rebooting: true, nonce } };
      }

      // grep auto-color
      const cmdFinal = /^grep/.test(cmd) && !/--color/.test(cmd) ? cmd.replace(/^grep/, 'grep --color=always') : cmd;
      // @ 前缀 = 查询/管理后台任务
      // @        列出所有后台任务
      // @N       查看第 N 个任务详情(支持多个:@3 @4 或 @3; @4)
      // @N kill  终止第 N 个任务(支持多个:@3 kill @4 kill 或 @3 kill; @4 kill)
      const trimmed = cmdFinal.trim();
      // 多查看:@3 @4 或 @3; @4(仅数字和分隔符,无 kill)
      const viewIds = /^@\d+([;\s]+@\d+)*$/.test(trimmed) ? [...trimmed.matchAll(/@(\d+)/g)].map(m => parseInt(m[1])) : [];
      if (/^@\d*$/.test(trimmed) || /^@\s+(-f|--force)$/.test(trimmed) || /^@\d+\s+kill/.test(trimmed) || /^@\d+\s+kill([;\s]|$)/.test(trimmed) || viewIds.length > 0) {
        const force = /-f|--force/.test(trimmed);
        // 多 kill:提取所有 @N kill 的 N
        const killIds = [...trimmed.matchAll(/@(\d+)\s+kill/g)].map(m => parseInt(m[1]));
        if (killIds.length > 0) {
          const results: string[] = [];
          for (const kid of killIds) {
            results.push(await killBackgroundTask(kid));
          }
          return { content: [{ type: "text", text: results.join("\n") }] };
        }
        const targetId = parseInt(trimmed.replace(/-f|--force/,'').match(/\d+/)?.[0] || '0');
        if (trimmed === "@" || trimmed === "@ -f" || trimmed === "@ --force") {
          if (running.size === 0) {
            if (_lastBgHash === "__empty__" && !force) return { content: [{ type: "text", text: "(no change from last @. Use @ -f to force view)" }] };
            _lastBgHash = "__empty__";
            return { content: [{ type: "text", text: "(no background commands)" }] };
          }
          const lines = [`${running.size} background (use @N for details):`];
          for (const [id, rc] of running) {
            const elapsed = Math.round((Date.now() - rc.startTime) / 1000);
            const typeTag = rc.type === "tty" ? "tty" : "bg ";
            const tail = rc.type === "tty" ? "(tmux)" : rc.accum ? rc.accum.split("\n").slice(-2).join(" | ").slice(0,120) : "";
            // 有标题优先显示标题(人类可读),无则截断命令
            const cmdDisplay = rc.title || (rc.command.length > 60 ? rc.command.slice(0,57) + "..." : rc.command);
            lines.push(`  @${id}  ${elapsed}s  ${typeTag}  ${cmdDisplay}${tail ? "  |  "+tail : ""}`);
          }
          const out = lines.join("\n");
          // 和上次一样 → 简短回复节省 context(对比去时间戳的 hash)
          const cmpHash = lines.slice(1).map(l => l.replace(/\s+\d+s\s+/, ' ').replace(/\s*\|\s*.*/, '')).join("\n");
          if (!force && cmpHash === _lastBgHash) {
            return { content: [{ type: "text", text: "(no change from last @. Use @ -f to force view)" }] };
          }
          _lastBgHash = cmpHash;
          return { content: [{ type: "text", text: out }] };
        }
        // 多查看:@3 @4 或 @3; @4
        if (viewIds.length > 1) {
          const views: string[] = [];
          for (const vid of viewIds) {
            const rc = running.get(vid);
            if (!rc) { views.push(`@${vid}: not found`); continue; }
            const elapsed = Math.round((Date.now() - rc.startTime) / 1000);
            const head = rc.title ? `${rc.title}  (command: ${rc.command})` : rc.command;
            if (rc.type === "tty" && rc.tmuxSession) {
              const screen = await tmuxPeek(rc.tmuxSession);
              views.push(`@${vid}  ${elapsed}s  tty  ${head}\n--- tmux ---\n${screen || i18n("(空)", "(empty)")}`);
            } else {
              views.push(`@${vid}  ${elapsed}s  ${head}\n---\n${rc.accum || "(no output yet)"}`);
            }
          }
          return { content: [{ type: "text", text: views.join("\n\n") }] };
        }
        const rc = running.get(targetId);
        if (!rc) return { content: [{ type: "text", text: `@${targetId}: not found` }], details: {}, isError: true };
        // detail view
        const elapsed = Math.round((Date.now() - rc.startTime) / 1000);
        const head = rc.title ? `${rc.title}  (command: ${rc.command})` : rc.command;
        if (rc.type === "tty" && rc.tmuxSession) {
          const screen = await tmuxPeek(rc.tmuxSession);
          return { content: [{ type: "text", text: `@${targetId}  ${elapsed}s  tty  ${head}\n--- tmux ---\n${screen || i18n("(空)", "(empty)")}` }] };
        }
        return { content: [{ type: "text", text: `@${targetId}  ${elapsed}s  ${head}\n---\n${rc.accum || "(no output yet)"}` }] };
      }
      _lastCmd = cmdFinal.split("\n")[0].slice(0, 80);

      // sleep 拦截:只拦"整条命令就是 sleep 干等"(无实际工作)。
      // 复合命令里的 sleep(如 `sleep 0; curl ...`、`x && sleep 1`)是命令分隔,放行。
      if (/^\s*sleep\s+[\d.]+\s*(;\s*)?$/.test(cmd)) {
        return { content: [{ type: "text", text: "Sleep is blocked. Execute is running asyncedly in this framework. please don't use sleep command." }], details: { blocked: true }, isError: true };
      }
      // 2026-09-13：`npm install` + "runtime" 的豁免收进 validateExecute（之前在这里跳过整个校验——`echo runtime; npm i; rm -rf ~` 全部规则失效）；cwd 一并参与路径判定
      const v = validateExecute(cmd, personId(), (params as any).cwd || undefined);
      if (v.blocked) {
        return { content: [{ type: "text", text: v.message! }], details: { blocked: true }, isError: true };
      }
      if (/^ls\s+/.test(cmd)) { (global as any).__ls_dir = cmd.replace(/^ls\s+/, "").trim(); }

      // ── terminal 模式:tmux 会话 ──
      const isTerminal = (params as any).terminal === true;
      if (isTerminal) {
        const recId = shortRecId(cmd);
        const tName = (params as any).name || "";
        const tCwd = (params as any).cwd || "";
        const n = tmuxClean(tName);
        if (await tmuxHas(n)) await asyncShSafe(`tmux kill-session -t ${n} 2>/dev/null`);
        // 2026-09-05:脚本不再写 /tmp(LESSON 064 铁律)--改 RuntimeCache 专属目录(bash 执行前 mkdir)
        const pidD = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "unknown";
        const exeCacheDir = join(homedir(), ".teyvat", "RuntimeCache", pidD);
        mkdirSync(exeCacheDir, { recursive: true });
        const script = join(exeCacheDir, `pi-exec-${n}.sh`);
        writeFileSync(script, `#!/bin/bash\n${tCwd ? `cd ${JSON.stringify(tCwd)} || exit 1\n` : ""}${cmdFinal}\nec=$?\necho\necho "[${n} done exit=$ec]"\nexec bash -i\n`);
        await asyncShSafe(`chmod +x ${script}; tmux new-session -d -s ${n} "bash ${script}"`);
        const ac2 = new AbortController();
        const entry: RunningCmd = { command: cmd, abort: ac2, startTime: Date.now(), killedByUser: false, context: "", accum: "", type: "tty", tmuxSession: n, recId, title: (params as any).title || "" };
        const ttyId = nextExecId++;
        running.set(ttyId, entry);
        updateBgCount();
        // terminal 完成检测:脚本末尾会输出 `[${n} done exit=$ec]` 标记。
        // 每 2s 轮询 tmux pane,发现标记 → 发 continuous-cmd-done(notify≠false)+ 清理条目。
        // (历史:terminal 模式只有 tty 常驻 bash,会话永不消失,只能靠标记判断完成。)
        const notify = (params as any).notify !== false; // 默认 true,notify:false 静默
        const doneMarker = `[${n} done exit=`;
        (async () => {
          try {
            while (running.has(ttyId)) {
              await new Promise(r => setTimeout(r, 2000));
              if (!running.has(ttyId)) break;
              // 2026-08-20 GC 根治(luoguOJ 踩坑 2h+):原本实现只轮询 doneMarker--
              // 命令被外部杀(pkill/kill-server/崩溃)不会输出标记 → 记录永远残留(幽灵任务阻塞 hibernate)。
              // 这是垃圾写法:完全不检测进程/会话存活,把清理责任丢给"命令正常结束"这一个出口。
              // 修复:tmux 会话没了 = 进程死了,自动清理 + 落 ExecuteData(137) + 通知。
              if (!(await tmuxHas(n))) {
                const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
                recordExecute({ id: entry.recId || shortRecId(cmd), command: cmd, cwd: tCwd, title: entry.title, start_time: entry.startTime, end_time: Date.now(), exit_code: 137, stdout: "[terminated externally - session closed]", stderr: "" });
                if (notify) {
                  try {
                    // 2026-09-13（ISSUE 226）：cmd-done 的 details 带结构化字段（status/recId/exitCode/elapsedSec/endTs/cmd/output/remaining），渲染器直接读，不再从文本反解析
                    outboxSend(pi, "continuous-cmd-done", i18n(`Terminal 已终止 (${elapsed}s) - tmux 会话 ${n} 被外部关闭(pkill/kill-server/崩溃),后台记录已自动清理:\n$ ${cmd}`, `Terminal terminated (${elapsed}s) - tmux session ${n} closed externally (pkill/kill-server/crash), background record auto-cleaned:\n$ ${cmd}`), { title: entry.title, status: "terminated", recId: entry.recId || shortRecId(cmd), exitCode: 137, elapsedSec: elapsed, endTs: Date.now(), cmd, output: "" }, { deliverAs: "interrupt" });
                  } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
                }
                running.delete(ttyId);
                updateBgCount();
                break;
              }
              const pane = await asyncShSafe(`tmux capture-pane -pt ${n} -S -200 2>/dev/null`);
              const idx = pane.lastIndexOf(doneMarker);
              if (idx >= 0) {
                const rest = pane.slice(idx + doneMarker.length);
                const code = (rest.match(/^\d+/) || ["?"])[0];
                const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
                // terminal 输出落盘(ExecuteData)
                const recFile = recordExecute({
                  id: recId, command: cmd, cwd: tCwd, title: entry.title,
                  start_time: entry.startTime, end_time: Date.now(), exit_code: parseInt(code) || 0,
                  stdout: pane, stderr: "", truncated: pane.length > 20000,
                });
                if (notify) {
                  try {
                    const recInfo = recFile ? `\n[id: ${recId}]` : "";
                    // 取 doneMarker 之前的输出尾部(去掉命令回显 $ 行与 shell 提示符),
                    // 与 background 完成一致:发尾部摘要而非 "(完整输出见 ExecuteData)"
                    const outPart = idx > 0 ? pane.slice(0, idx) : pane;
                    const outLines = outPart.split("\n").filter((l: string) => l.trim() && !l.trim().startsWith("$ "));
                    const tail = outLines.slice(-25).join("\n");
                    // sendCustomMessage 是 async--必须 await,否则 async reject 成 unhandledRejection 静默丢失(cmd-done 不到达 = 后台命令"无返回")
                    // 2026-08-15 修复"后台命令完成结果丢失":interrupt 保证 30ms 后 flush 注入(run 中则先 abort)。
                    // 此前无 deliverAs(默认 steer)在 streaming 时也是排队,可能丢失。
                    // ISSUE 119 P1(2026-08-18,qwen-3-8-27b-infer-test-01):改走 outbox--先落盘再发,
                    // 落入 wait 窗口被吞时由 heart 唤醒重发(at-least-once)。
                    outboxSend(pi, "continuous-cmd-done", i18n(`Terminal 完成 (${elapsed}s, exit ${code}):\n$ ${cmd}\n${tail || "(no output)"}${recInfo}`, `Terminal done (${elapsed}s, exit ${code}):\n$ ${cmd}\n${tail || "(no output)"}${recInfo}`), { title: entry.title, status: "done", recId, exitCode: parseInt(code) || 0, elapsedSec: elapsed, endTs: Date.now(), cmd, output: tail || "(no output)", terminal: true }, { deliverAs: "interrupt" });
                  } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
                }
                running.delete(ttyId);
                updateBgCount();
                break;
              }
            }
          } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); running.delete(ttyId); updateBgCount(); }
        })();
        return {
          content: [{ type: "text", text: i18n(`Terminal ${tName || n.slice(TMUX_PFX().length)} - 使用 @N 查看画面,@N kill 关闭。`, `Terminal ${tName || n.slice(TMUX_PFX().length)} - use @N to view, @N kill to close.`) }],
          details: {
            execId: `#${ttyId}`,
            recId,
            terminal: true,
            tname: tName || "",
            title: (params as any).title || "",
            createdInfo: { created: 1, ts: Date.now(), total: running.size, elapsed: Math.max(1, Math.round((Date.now() - entry.startTime) / 1000)) },
          },
        };
      }

      const startTime = Date.now();
      const wantStream = params.stream === true;
      const ac = new AbortController();
      const execPromise = pi.exec("bash", ["-c", cmdFinal], { signal: ac.signal, cwd: (params as any).cwd || undefined });

      const race = await Promise.race([
        execPromise.then(r => ({ done: true as const, result: r })),
        new Promise<{ done: false }>(resolve => setTimeout(() => resolve({ done: false }), BG_THRESHOLD_MS)),
      ]);

      if (race.done) {
        const r = race.result;
        const output = [r.stdout, r.stderr].filter(Boolean).join("\n").slice(0, 50000);
        const exitInfo = r.code !== 0 ? `\n(exit ${r.code})` : "";
        // 执行记录落盘
        const recId = shortRecId(cmd);
        const recFile = recordExecute({
          id: recId, command: cmd, cwd: (params as any).cwd || "",
          start_time: startTime, end_time: Date.now(), exit_code: r.code,
          stdout: r.stdout || "", stderr: r.stderr || "",
        });
        // 快命令也提示当前后台任务数(若无后台任务则省略)
        const bgInfo = running.size > 0 ? i18n(`\n[background: ${running.size} running - 用 @ 查看, @N kill]`, `\n[background: ${running.size} running - use @ to view, @N kill]`) : "";
        const recInfo = recFile ? `\n[id: ${recId}]` : "";
        return {
          content: [{ type: "text", text: `${output || "(no output)"}${exitInfo}${bgInfo}${recInfo}` }],
          // 快命令同步执行:execId 用于渲染 Process <id> done in X sec 摘要行;
          // 无 createdInfo(未创建后台进程)
          // 2026-09-08(用户:别用 replace 剥垃圾--信息源头分开):renderText = 用户显示的干净文本(无 bgInfo/recInfo 元信息行)--
          // renderResult 已优先读 details.renderText(L374)--有它就不再走 content 剥除 fallback。content 保留元信息(模型 feed 需要 background/id 状态)。
          details: { exitCode: r.code, execId: recId, elapsedMs: Date.now() - startTime, endTs: Date.now(), renderText: `${output || "(no output)"}${exitInfo}` }, // endTs：渲染层显示 "at HH:MM:SS" 用它，不再取渲染时刻
        };
      }

      const id = nextExecId++;
      let context = "";
      try {
        const msgs = _ctx.sessionManager?.getBranch?.() ?? [];
        const recent = msgs.slice(-5);
        context = recent.map((e: any) => {
          const m = e.message ?? e;
          const role = m.role ?? e.type ?? "?";
          const text = typeof m.content === "string" ? m.content
            : Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ") : "";
          return `[${role}] ${text.slice(0, 100)}`;
        }).filter(Boolean).join("\n");
      } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
      running.set(id, { command: cmd, abort: ac, startTime, killedByUser: false, context, accum: "", type: "bg", recId: shortRecId(cmd), title: (params as any).title || "" });
      updateBgCount();

      // ISSUE 081: bg 任务超时保护(默认 30 分钟,execute 参数可覆盖)
      const bgTimeoutMs = ((params as any).timeout_minutes ?? 30) * 60 * 1000;
      const bgTimer = setTimeout(() => {
        const entry = running.get(id);
        if (entry && !entry.killedByUser) {
          (entry as any).timedOut = true; // 2026-09-13：成功分支据此不再重复发"完成"（之前超时后 execPromise 正常 resolve、code 0 → "超时"+"完成 exit 0" 双通知）
          try { ac.abort(); } catch (e) { console.error("[executes.ts] bg timeout abort: " + ((e as any)?.message || e)); }
          try { outboxSend(pi, "continuous-cmd-done", i18n(`超时 (${Math.round(bgTimeoutMs / 60000)}min):\n$ ${cmd}\n(自动终止)`, `Timeout (${Math.round(bgTimeoutMs / 60000)}min):\n$ ${cmd}\n(auto-killed)`), { title: entry.title, status: "timeout", recId: entry.recId, elapsedSec: Math.round(bgTimeoutMs / 1000), endTs: Date.now(), cmd, output: "" }, { deliverAs: "interrupt" }); } catch (e) { console.error("[executes.ts] bg timeout notify: " + ((e as any)?.message || e)); }
        }
      }, bgTimeoutMs);

      // 后台/流式:复用 execPromise(race 超时后它仍在运行)。
      // 历史:issue 072 - race 超时后曾 spawn 第二个进程重跑同一命令,
      // 造成双执行 + 首次结果(含注册密钥等)静默丢失;且原 execPromise
      // 未 abort 持续运行。现改为直接等待 execPromise 完成并发 cmd-done,
      // 保证同一命令只执行一次、结果不丢失。
      const bgStart = Date.now();
      (async () => {
        let accum = "";
        const onData = (chunk: string) => {
          accum += chunk;
          const entry = running.get(id);
          if (entry) entry.accum = accum;
          if (wantStream) { try { _onUpdate({ content: [{ type: "text", text: chunk }] }); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); } }
        };
        try {
          const r = await execPromise;
          clearTimeout(bgTimer);
          const elapsed = Math.round((Date.now() - bgStart) / 1000);
          const fullOut = [r.stdout, r.stderr].filter(Boolean).join("\n");
          const out = fullOut.slice(0, 50000);
          accum = out;
          const entry = running.get(id);
          if (entry) entry.accum = out;
          if (wantStream) { try { _onUpdate({ content: [{ type: "text", text: out }] }); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); } }
          // 完整执行记录落盘(ExecuteData),cmd-done 只发尾部摘要
          // 0.3.3 修复 H9:recId 复用 running map 中首次计算的值,避免跨秒漂移导致 ID 不一致
          const recId = entry?.recId || shortRecId(cmd);
          const recFile = recordExecute({
            id: recId, command: cmd, cwd: (params as any).cwd || "", title: entry?.title,
            start_time: bgStart, end_time: Date.now(), exit_code: r.code,
            stdout: r.stdout || "", stderr: r.stderr || "",
            truncated: fullOut.length > 20000,
          });
          const tail = fullOut.split("\n").slice(-25).join("\n");
          const recInfo = recFile ? `\n[id: ${recId}]` : "";
          // remaining = 本任务之外还在运行的(发送时本任务仍在 running,需减 1)
          const remNow = Math.max(0, running.size - 1);
          const remInfo = remNow > 0 ? `\n[remaining: ${remNow}]` : "";
          // 2026-09-13：被 kill / 超时终止的进程，pi.exec 也会正常 resolve（code 为 null→0、killed=true）——之前一律报"完成 (exit 0)"，
          // 超时时还与上面的"超时"通知叠成双条。终止的只记录不再发"完成"；用户手动 kill 的由 kill 路径自己通知。
          const wasKilled = !!(r as any).killed || !!entry?.killedByUser || !!(entry as any)?.timedOut;
          if (!wasKilled) try {
            // 2026-08-15 修复"后台命令完成结果丢失"(实测 context 里 continuous-cmd-done 0 条):
            // followUp 在 agent run 进行中到达时走 pi 的 followUp 分支只排队不注入,run 结束后
            // 队列无 flush → 消息永久丢失。改 interrupt:强制 30ms 后 flush 注入,不管 run 状态,
            // 保证后台命令完成一定通知到(打断等待是合理的--用户就在等这个结果)。
            // sendCustomMessage 是 async--必须 await,否则 async reject 成 unhandledRejection 静默丢失
            // ISSUE 119 P1(2026-08-18,qwen-3-8-27b-infer-test-01):改走 outbox--先落盘再发,
            // 落入 wait 窗口被吞时由 heart 唤醒重发(at-least-once)。
            outboxSend(pi, "continuous-cmd-done", i18n(`完成 (${elapsed}s, exit ${r.code}):\n$ ${cmd}\n${tail || "(no output)"}${recInfo}${remInfo}`, `Done (${elapsed}s, exit ${r.code}):\n$ ${cmd}\n${tail || "(no output)"}${recInfo}${remInfo}`), { title: entry?.title, status: "done", recId, exitCode: typeof r.code === "number" ? r.code : 0, elapsedSec: elapsed, endTs: Date.now(), cmd, output: tail || "(no output)", remaining: remNow }, { deliverAs: "interrupt" });
          } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        } catch (err: any) {
          clearTimeout(bgTimer);
          const elapsed = Math.round((Date.now() - bgStart) / 1000);
          // 失败也落盘记录
          const recId = shortRecId(cmd);
          const entry = running.get(id);
          const recFile = recordExecute({
            id: recId, command: cmd, cwd: (params as any).cwd || "", title: entry?.title,
            start_time: bgStart, end_time: Date.now(), exit_code: -1,
            stdout: accum, stderr: err?.message ?? String(err),
          });
          const recInfo = recFile ? `\n[id: ${recId}]` : "";
          try { outboxSend(pi, "continuous-cmd-done", `Command failed (${elapsed}s):\n$ ${cmd}\n${err?.message ?? err}${recInfo}`, { title: entry?.title, status: "failed", recId, exitCode: -1, elapsedSec: elapsed, endTs: Date.now(), cmd, output: String(err?.message ?? err) }, { deliverAs: "followUp" }); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        } finally {
          running.delete(id);
          updateBgCount();
        }
      })();

      return {
        content: [{ type: "text", text: `Running in background (${running.size} running). Keep working.` }],
        details: {
          renderText: `Running in background (${running.size} running).`,
          execId: `#${id}`,
          recId: shortRecId(cmd),
          title: (params as any).title || "",
          createdInfo: { created: 1, ts: Date.now(), total: running.size, elapsed: Math.max(1, Math.round((Date.now() - startTime) / 1000)) },
        },
      };
    },
  });

  // ── shutdown: 清理 tmux 会话 ──
  pi.on("session_shutdown", async () => {
    const scope = TMUX_PFX();
    try {
      const sessions = (await asyncShSafe(`tmux ls 2>/dev/null`)).split("\n").filter((l) => l.startsWith(scope));
      for (const s of sessions) {
        const name = s.split(":")[0];
        if (name) await asyncShSafe(`tmux kill-session -t ${name} 2>/dev/null`);
      }
    } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
  });
  // 2026-09-05(ISSUE 127):重启后恢复 tmux 后台任务(session_start 扫描)
  registerTmuxRestore(pi);
  // 0.3.3 修复 H10:tmux restore 用独立 ID 分配,可能与 nextExecId 碰撞。
  // restore handler 先跑(注册顺序),这里跟一个 handler 把 nextExecId 推到 running 最大 key 之后。
  pi.on("session_start" as any, async () => {
    for (const k of running.keys()) { if (k >= nextExecId) nextExecId = k + 1; }
  });
}

// 2026-09-05(ISSUE 127):重启后恢复 tmux 后台任务--tmux 会话独立于 agent 进程(kill 进程组不清),
// 重启后 running 注册表(内存)清空 → statebar 计数丢失 + @N 无法管理。
// 机制:session_start 时扫描本 agent 前缀的 tmux 会话(dev-<scope>-*)→ 幸存会话重建 running 条目
// + 启动精简轮询(存活检测 + doneMarker 清理 + 通知,与 tty 创建的轮询逻辑一致)。
// 普通 bg(exec bash 子进程)随 agent 进程组被杀,无需恢复。
function registerTmuxRestore(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    try {
      const scope = TMUX_PFX();
      const sessions = (await asyncShSafe(`tmux ls 2>/dev/null`)).split("\n").filter((l) => l.startsWith(scope));
      let recovered = 0;
      for (const s of sessions) {
        const n = s.split(":")[0];
        if (!n) continue;
        // 已注册的跳过(同一会话可能被 tmux ls 重复列出/或已恢复)
        let exists = false;
        for (const [, rc] of running) { if (rc.tmuxSession === n) { exists = true; break; } }
        if (exists) continue;
        // 2026-09-05:恢复条目的 id 自找空闲(不依赖主函数内的 nextExecId--本函数在模块级定义)
        let id = 1; while (running.has(id)) id++;
        const title = n.slice(scope.length);
        const startTime = Date.now();
        const cmdDisp = title || `terminal`;
        const recId = shortRecId(cmdDisp);
        const entry: RunningCmd = {
          command: `(restored) ${cmdDisp}`, abort: new AbortController(), startTime, killedByUser: false,
          context: "", accum: "", type: "tty", tmuxSession: n, recId, title: cmdDisp,
        };
        running.set(id, entry);
        recovered++;
        // 精简轮询(与 tty 创建一致):tmux 会话没了 = 完成/被杀 → 清理;doneMarker → 完成
        const doneMarker = `[${n} done exit=`;
        (async () => {
          try {
            while (running.has(id)) {
              await new Promise((r) => setTimeout(r, 2000));
              if (!running.has(id)) break;
              if (!(await tmuxHas(n))) {
                // 会话关闭(完成或被杀--doneMarker 没抓到说明被杀)
                const pane = await asyncShSafe(`tmux capture-pane -pt ${n} -S -200 2>/dev/null`);
                running.delete(id); updateBgCount();
                try {
                  const doneIdx = pane.lastIndexOf(doneMarker);
                  if (doneIdx >= 0) {
                    const rest = pane.slice(doneIdx + doneMarker.length);
                    const code = (rest.match(/^\d+/) || ["0"])[0];
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    recordExecute({ id: recId, command: cmdDisp, cwd: "", title: cmdDisp, start_time: startTime, end_time: Date.now(), exit_code: parseInt(code) || 0, stdout: pane, stderr: "", truncated: pane.length > 20000 });
                    const outPart = doneIdx > 0 ? pane.slice(0, doneIdx) : pane;
                    const tail = outPart.split("\n").filter((l: string) => l.trim() && !l.trim().startsWith("$ ")).slice(-25).join("\n");
                    outboxSend(pi, "continuous-cmd-done", i18n(`Terminal 完成 (${elapsed}s, exit ${code}):\n$ ${cmdDisp}\n${tail || "(no output)"}\n[id: ${recId}]`, `Terminal done (${elapsed}s, exit ${code}):\n$ ${cmdDisp}\n${tail || "(no output)"}\n[id: ${recId}]`), { title: cmdDisp, status: "done", recId, exitCode: parseInt(code) || 0, elapsedSec: elapsed, endTs: Date.now(), cmd: cmdDisp, output: tail || "(no output)", terminal: true }, { deliverAs: "interrupt" });
                  } else {
                    const termElapsed = Math.max(1, Math.round((Date.now() - startTime) / 1000));
                    outboxSend(pi, "continuous-cmd-done", i18n(`Terminal 已终止 (${termElapsed}s) - tmux 会话 ${n} 关闭(重启前任务,无 doneMarker)`, `Terminal terminated - tmux session ${n} closed (pre-restart task, no done marker)`), { title: cmdDisp, status: "terminated", recId, elapsedSec: termElapsed, endTs: Date.now(), cmd: cmdDisp, output: "" }, { deliverAs: "interrupt" });
                  }
                } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
                break;
              }
            }
          } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); running.delete(id); updateBgCount(); }
        })();
      }
      if (recovered > 0) { updateBgCount(); console.error("[spirit.bio.organs/hands.executes/executes.ts] restoreTmux: recovered " + recovered + " tmux session(s)"); }
    } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] restoreTmux failed: " + ((e as any)?.message ?? e)); }
  });
}
