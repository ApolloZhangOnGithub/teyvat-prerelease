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
import { outboxSend } from "../kernel.backbone/backbone.ts"; // 2026-08-20：outbox 已合并进 backbone.ts（不再单独文件）
import { renderToolCall, renderMessage, GUTTER, lineNumbered } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { validateExecute } from "../hands.fileacts/fileacts.ts";
import { personId } from "../kernel.heart/heart-state.ts";

// ── execute 执行记录（ExecuteData）──
// 每次 execute 落盘一条 JSON：命令、耗时、退出码、完整输出。
// agent 需要完整结果时用 read 查看，cmd-done 只发尾部摘要，避免 context 被垃圾填满。
// 目录: ~/.teyvat/ExecuteData/<personId>/
const EXECUTE_DATA_DIR = join(homedir(), ".teyvat", "ExecuteData");

function execPersonDir(): string {
  const pid = personId() || "unknown";
  return join(EXECUTE_DATA_DIR, pid);
}

function execRecordFile(id: string): string {
  return join(execPersonDir(), `${id}.json`);
}

// 短 ID：YYMMDD-HHMMSS-命令哈希8hex（如 260811-095512-a1b2c3d4）。
// 本地时间可读（用户能读出几点跑的）+ 命令哈希（内容指纹/防冲突）。
// 全链路一致：文件、index、显示、沟通都用同一个 id，不缩短不映射（教训：分层 id 导致人机沟通错误）。
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

// 记录路径的可读短形式：ExecuteData/<id>.json（省去 ~/.teyvat/<personId>/ 前缀）
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
    if (!rec.title) delete rec.title; // 无标题不落字段，保持记录干净
    writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
    return file;
  } catch { return ""; }
}

// ── 历史记录查询（action:'show' + historical，2026-09-04 test-01 反馈）──
// 任务完成即离开 running 列表，show 立刻查不到刚结束的任务。historical:true 直接读落盘记录。
function findHistoricalFiles(idStr: string): string[] {
  try {
    const files = readdirSync(execPersonDir()).filter((f) => f.endsWith(".json"));
    const exact = files.filter((f) => f === `${idStr}.json`);
    if (exact.length > 0) return exact;
    if (/^\d/.test(idStr)) return files.filter((f) => f.startsWith(idStr)); // 前缀匹配仅限 id 样式（数字开头）
    return [];
  } catch { return []; }
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
    const note = lines.length > TAIL ? `\n... (${lines.length - TAIL} lines earlier omitted — full record: ${shortRecPath(file)})` : "";
    const err = rec.stderr ? `\n--- stderr ---\n${String(rec.stderr).slice(0, 2000)}` : "";
    return `${head}\n${cmdLine}\n--- stdout ---\n${tail || "(empty)"}${note}${err}`;
  } catch (e: any) {
    return `[历史] 记录读取失败: ${shortRecPath(file)} — ${e?.message || e}`;
  }
}

// ── shell 工具函数（terminal.ts 等外部模块也用）──

export function asyncSh(cmd: string, timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf8", timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function asyncShSafe(cmd: string, timeout = 5000): Promise<string> {
  try { return await asyncSh(cmd, timeout); } catch { return ""; }
}

// ── tmux 助手（原 terminal.ts，整合至此）──
function getAgentScope(): string {
  const m = process.title.match(/genshin:[^(]+\([^,]+,\s*([^,)]+)/);
  return (m?.[1] || "unknown").slice(0, 8);
}
const TMUX_PFX = () => "dev-" + getAgentScope() + "-";
const tmuxClean = (n: string) => TMUX_PFX() + (n || `t${Date.now().toString().slice(-5)}`).replace(/[^a-zA-Z0-9_]/g, "");
const tmuxHas = async (n: string): Promise<boolean> => {
  try { await asyncSh(`tmux has-session -t ${n} 2>/dev/null`); return true; } catch { return false; }
};
const tmuxPeek = async (n: string): Promise<string> => {
  return (await asyncShSafe(`tmux capture-pane -pt ${n} -S -200 2>/dev/null`)).split("\n").filter(Boolean).slice(-60).join("\n");
};

// ── execute tool ──

// ── renderDiff 管线（write/edit 工具同款：generateDiffString + renderDiff）──
// 动态 require：绕过 extension load check 的静态循环检测；
// 部署后 overrides 目录在 extensions/teyvat/ 下保持（相对路径有效）。
let _renderDiff: ((text: string) => string) | undefined;
let _generateDiffString: ((oldContent: string, newContent: string, contextLines?: number) => { diff: string; firstChangedLineNumber?: number }) | undefined;
function loadRenderDiff(): ((text: string) => string) | undefined {
  if (_renderDiff) return _renderDiff;
  try {
    const bridge = require("../../god.frontend.tui/overrides/pi-dist/modes/interactive/components/diff.js");
    _renderDiff = bridge.renderDiff;
  } catch {
    _renderDiff = undefined;
  }
  return _renderDiff;
}
function loadGenerateDiffString(): ((oldContent: string, newContent: string, contextLines?: number) => { diff: string; firstChangedLineNumber?: number }) | undefined {
  if (_generateDiffString) return _generateDiffString;
  try {
    const mod = require("../../god.frontend.tui/overrides/pi-dist/core/tools/edit-diff.js");
    _generateDiffString = mod.generateDiffString;
  } catch {
    _generateDiffString = undefined;
  }
  return _generateDiffString;
}

// 后台化阈值：快命令直接返回，慢命令自动后台
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
  /** 执行记录 id（shortRecId(cmd)），供 TUI 黄点判定"该任务是否仍在运行" */
  recId?: string;
  /** 人类可读的任务标题（可选，/b 列表与 @ 列表优先显示） */
  title?: string;
}

// 后台任务注册表（模块级：heart-hibernate 等需要读取摘要）
const running = new Map<number, RunningCmd>();
function updateBgCount() {
  const v = running.size;
  (globalThis as any).__genshinBgCount = v;
  (process as any).__genshinBgCount = v;
  // 所有后台任务的 startTime（升序，供 statebar 显示各自 lasting 时长）
  const starts: number[] = [];
  for (const rc of running.values()) starts.push(rc.startTime);
  starts.sort((a, b) => a - b);
  (globalThis as any).__genshinBgStarts = starts;
  (process as any).__genshinBgStarts = starts;
  // 运行中任务的执行记录 id 集合（TUI 用：对应 execute 调用行在任务完成前显示黄点）
  const recIds = new Set<string>();
  for (const rc of running.values()) if (rc.recId) recIds.add(rc.recId);
  (globalThis as any).__genshinBgRunningRecIds = recIds;
  (process as any).__genshinBgRunningRecIds = recIds;
  // /b 命令用：完整任务快照（id/command/type/startTime/recId/accum 尾部），供 TUI 命令层读取
  // 注意：解构 [id, rc] 必须用 entries()——values() 给的是 RunningCmd 本体，不可迭代
  // （2026-08-15 bun tsc 严格检查报 TS2488，运行时只要有 bg 任务就会抛错）
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
  // 后台任务集合变化 → 对应 execute 调用行的黄点需要重渲染（完成变绿/新建变黄）
  try { (globalThis as any).__genshinRefreshUI?.(); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
}

/** 终止第 id 个后台任务（/b kill 与 @N kill 共用同一路径） */
// 2026-09-04（test-01 反馈）：字符串任务 ID（recId，如 "260904-154249-9fca9e02"）→ running Map 的 number 键。
// action show/kill 的 id 此前只收 number（schema 与解析都是），但任务 ID 实际全是 recId 字符串——支持完整 ID 或前缀匹配。
function recIdToKey(s: string): number | null {
  for (const [key, rc] of running) {
    if (rc.recId === s || (rc.recId && rc.recId.startsWith(s))) return key;
  }
  return null;
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

/** 后台任务摘要（@ 列表同格式），供 hibernate 等拦截消息直接展示 */
export function backgroundTasksSummary(): string {
  if (running.size === 0) return "";
  const lines = [i18n(`${running.size} 个后台 Execute 任务在运行:`, `${running.size} background Execute task(s) running:`) ];
  for (const [id, rc] of running) {
    const elapsed = Math.round((Date.now() - rc.startTime) / 1000);
    const typeTag = rc.type === "tty" ? "tty" : "bg ";
    // 有标题优先显示标题（人类可读），无则截断命令
    const display = rc.title || (rc.command.length > 60 ? rc.command.slice(0, 57) + "..." : rc.command);
    lines.push(`  @${id}  ${elapsed}s  ${typeTag}  ${display}`);
  }
  return lines.join("\n");
}

export default function registerExecute(pi: ExtensionAPI) {
  let nextExecId = 1;
  let _lastCmd = "";
let _lastBgHash = ""; // @ 缓存：避免相同输出重复占用 context


  pi.on("before_agent_start", async () => {
    try {
      const active = pi.getActiveTools();
      if (active.includes("bash")) pi.setActiveTools(active.filter((n: string) => n !== "bash"));
    } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); };
  });

  registerPaimonTool({
    name: "execute",
    label: "Execute",
    messageDescription: "Execute shell command. Fast commands return immediately, while slow commands auto-background. terminal:true for tmux (progress bars, training), completes push a notice unless notify:false. title is REQUIRED: the PURPOSE of this command (why), not the action — the same command can mean different things in different contexts, and title captures the intent (e.g. \"确认模型权重已下载\" not \"ls\"). title shows in @ list / /b / cmd-done Result instead of the raw command. Manage background tasks via 'action' (teyvat convention): execute({action:'list'}) to list, {action:'show', id:3} for task 3 details, {action:'kill', id:33} or id:[33,34] to terminate — framework-native, returns termination result. Finished tasks left the running list: {action:'show', id:'<task-id>', historical:true} reads their ExecuteData record (recId exact or unique prefix). ⚠️ NEVER use shell pkill/kill/tmux kill-server to kill background tasks: the process dies but the background record lingers (blocks hibernate). Every execution is recorded to ~/.teyvat/ExecuteData/<your-person-id>/<id>.json; the result message shows [id: xxx] so you can read the full record via that path.",
    promptSnippet: "Execute shell command. title REQUIRED — purpose (why), not action. terminal:true for tmux; notify:false to skip completion notice. Background tasks via action: {action:'list'} / {action:'show',id:N} / {action:'kill',id:N or [Ns]} — NOT shell pkill/kill (record lingers → blocks hibernate). Finished tasks: {action:'show',id:'<task-id>',historical:true}. Result shows [id: xxx] → full record at ~/.teyvat/ExecuteData/<personId>/<id>.json (use read).",
    parameters: Type.Object({
      command: Type.String({ messageDescription: "Shell command to execute" }),
      title: Type.String({ messageDescription: i18n("REQUIRED. Purpose of this command (why you run it), e.g. '确认权重已下载' — same command can have different intents; title captures the intent. Shows in @ list / /b / cmd-done instead of raw command", "REQUIRED. Purpose of this command (why you run it), e.g. 'verify weights downloaded' — same command can have different intents; title captures the intent. Shows in @ list / /b / cmd-done instead of raw command") }),
      stream: Type.Optional(Type.Boolean({ messageDescription: "Stream output as command runs (long commands only)" })),
      terminal: Type.Optional(Type.Boolean({ messageDescription: "Run in tmux TTY (for progress bars, interactive commands, long training)" })),
      name: Type.Optional(Type.String({ messageDescription: "Terminal short name (e.g. train). Required for peek/close via @N" })),
      cwd: Type.Optional(Type.String({ messageDescription: "Working directory for this command (all modes; avoids hand-writing cd prefixes — explicit per-call, no state kept)" })),
      notify: Type.Optional(Type.Boolean({ messageDescription: "Send a completion message when a background/terminal command finishes (default true; set false to stay quiet)" })),
      action: Type.Optional(Type.String({ messageDescription: "Operation mode (teyvat convention like social/amem): 'list'=list background tasks (alias of '@'), 'show'=view task N detail (alias of '@N', use with id), 'kill'=terminate background task(s) (use with id, e.g. 33 or [33, 34]) — when action present, command is not executed (except list/show which only inspect)" })),
      id: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Array(Type.Union([Type.Number(), Type.String()]))], { messageDescription: "Background task id(s) — for action='show' (single id) or action='kill'; accepts the @N number or the full task-ID string (e.g. 260904-154249-9fca9e02)" })),
      historical: Type.Optional(Type.Boolean({ messageDescription: "For action='show': read the finished-task record from ExecuteData by recId (exact or unique prefix). Completed tasks leave the running list immediately — pass historical:true to read their full record (stdout tail 30 lines + stderr)" })),
    }),
    renderCall(args: any, theme: any) {
      let cmd = args?.command || _lastCmd || "...";
      const title = String(args?.title || "").trim();
      // 显示模式（/ux 管理）：full=标题+命令详情区 / title=仅标题（默认，2026-08-18 用户定稿）/ command=仅命令（老形态）
      const display = (globalThis as any).__genshinExecuteDisplay ?? "title";
      const label = args?.terminal === true ? "Execute(T)" : "Execute";
      if (display === "title") return renderToolCall.label(theme, label, title);
      if (display === "command") return renderToolCall.command(theme, label, cmd);
      if ((globalThis as any).__genshinExecuteBreakAnd && cmd.includes(" && ")) {
        cmd = cmd.split(" && ").join(" &&\n");
      }
      if ((globalThis as any).__genshinCompactExecute) {
        const lines = cmd.split("\n").filter((l: string) => l.trim());
        if (lines.length > 3) {
          cmd = lines.slice(0, 3).join("\n") + "\n... +" + (lines.length - 3) + " more";
        }
      }
      // 标准调用行管线（2026-08-17）：第一行 Execute <title>（意图），下方指令详情区（命令，与 E 对齐）
      return renderToolCall.detail(theme, label, title, cmd);
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const execId = result?.details?.execId;
      const createdInfo = result?.details?.createdInfo;
      // 快命令：有 execId 但无 createdInfo → Process <id> done in X sec + 输出
      if (execId && !createdInfo) {
        const { Text, Container } = require("@earendil-works/pi-tui");
        const indent = " ".repeat(GUTTER);
        const c = new Container();
        const sec = ((result?.details?.elapsedMs || 0) / 1000);
        const secStr = sec < 1 ? sec.toFixed(2) : sec.toFixed(1);
        const ts = new Date();
        const hh = String(ts.getHours()).padStart(2, "0");
        const mm = String(ts.getMinutes()).padStart(2, "0");
        const ss = String(ts.getSeconds()).padStart(2, "0");
        // 20260811 笔记格式规范：这一行 default——id 不着色、耗时不着色不粗；时间戳行尾全 dim
        // 2026-08-14 用户要求：done in Xs 的数字用蓝色（accent）
        // 输出区文本先算（token 数要在摘要行时间后显示）
        const rc = result?.details?.renderText != null
          ? [{ type: "text", text: result.details.renderText }]
          : resultContent(result);
        // 输出区：无 ⎿，缩进对齐（⎿ 只出现一次在摘要行）
        let outText = rc.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
        // 用户展示剥离：末尾的 [id: xxx]（执行记录引用）、[result N tokens]（结果 token 统计）
        // 和 [HH:MM:SS.mmm +Xs]（bioclock 耗时戳）
        // 只对用户隐藏——content 保留，模型仍可见（要 read 执行记录 / 知道 token 量 / 耗时）。
        // token 数在 result 摘要行时间后已显示（· N tokens），不在末尾重复占行。
        outText = outText
          .replace(/\n*\[\d{2}:\d{2}:\d{2}\.\d{3}\s*\+\d+(?:\.\d+)?s\]\s*$/, "")
          .replace(/\n*\[result\s+[\d.]+[kM]?\s*tokens?(?:,\s*contexted\s+[\d.]+[kM]?)?\]\s*$/, "")
          .replace(/\n*\[id:\s*[A-Za-z0-9-]+\]\s*$/, "")
          .trimEnd();
        // 2026-08-15 用户要求：token 数渲染在时间后面（与 [HH:MM:SS] 同行的 result 摘要行）。
        // 系数与 memory.ts estimateTokens 一致：CJK 1.8/字，其他 4 字符/1 token。
        // 2026-08-15 用户要求（格式）：不要点分隔——同一方括号内逗号分隔：[HH:MM:SS, N tokens]
        let cjk = 0;
        for (let i = 0; i < outText.length; i++) {
          const c = outText.charCodeAt(i);
          if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) ||
              (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
        }
        const estTok = Math.ceil(cjk * 1.8 + (outText.length - cjk) / 4);
        const timeTok = estTok > 0 ? `[${hh}:${mm}:${ss}, ${estTok} tokens]` : `[${hh}:${mm}:${ss}]`;
        const line1 = indent + theme.fg("dim", "⎿  ") + `Process ${execId} done in ${theme.fg("accent", secStr)} sec ` + theme.fg("dim", timeTok);
        c.addChild(new Text(line1, 0, 0));
        if (outText) {
          // 行号统一：blocks_nongod.lineNumbered（markdown 同款：右对齐行号 + │ 竖线）
          // 每行独立 Text——避开 Text 组件多行缩进逻辑，保证行号对齐
          const rendered = lineNumbered(outText, theme);
          const contIndent = " ".repeat(GUTTER + 3);
          // 笔记规范：返回的具体内容 dim（行号 gutter 在 lineNumbered 内已 dim）
          for (const line of rendered.split("\n")) c.addChild(new Text(contIndent + theme.fg("dim", line), 0, 0));
        }
        return c;
      }
      // 后台/terminal：Created N bash/terminal process（+ named XXX）, id <记录id> [hh:mm:ss]
      if (execId && createdInfo) {
        const { Text, Container } = require("@earendil-works/pi-tui");
        const indent = " ".repeat(GUTTER);
        const c = new Container();
        const totalRunning = createdInfo.total;
        // 笔记格式规范：这一行 default——数字/name/id 均不着色
        const isTerm = result?.details?.terminal === true;
        const tname = result?.details?.tname;
        const kind = isTerm ? "terminal process" : "bash process";
        const named = isTerm && tname ? ` named ${tname}` : "";
        const createdStr = `Created ${createdInfo.created} ${kind}` + named + (totalRunning > 0 ? ` (${totalRunning} in total)` : "");
        // 2026-08-27 用户要求：title 已在调用行（• Execute <title>）显示，Result 创建行不重复追加
        // 有 title 则显示（人类可读任务标签），无则跳过
        // id 统一用 ExecuteData 记录 id（details.recId），不用任务编号 #N
        const recId = result?.details?.recId;
        const idPart = recId ? `, id ${recId}` : `, id ${execId}`;
        const ts = new Date();
        const hh = String(ts.getHours()).padStart(2, "0");
        const mm = String(ts.getMinutes()).padStart(2, "0");
        const ss = String(ts.getSeconds()).padStart(2, "0");
        const timePart = ` [${hh}:${mm}:${ss}]`;
        c.addChild(new Text(indent + theme.fg("dim", "⎿  ") + createdStr + idPart + theme.fg("dim", timePart), 0, 0));
        // 不渲染 renderText（Running in background / Terminal N — 使用 @N）——创建行保持一行
        return c;
      }
      if ((globalThis as any).__genshinCompactExecute && result?.details?.renderText == null) {
        const raw = resultContent(result);
        if (raw.length > 0 && raw[0].type === "text") {
          const lines = raw[0].text.split("\n");
          if (lines.length > 7) {
            const head = lines.slice(0, 5).join("\n");
            const tail = lines[lines.length - 1];
            const skipped = lines.length - 6;
            // 2026-08-14（ISSUE 093）：折叠标记带真实行号范围（被折叠的是第 6 行到倒数第 2 行）
            const from = 6, to = lines.length - 1;
            const compacted = [{ type: "text", text: head + `\n\x1b[2m... ${skipped} lines more (lines ${from}-${to} omitted)\x1b[0m\n` + tail }];
            return renderMessage.output(theme, ctx, compacted);
          }
        }
        return renderMessage.output(theme, ctx, raw);
      }
      const rc = result?.details?.renderText != null
        ? [{ type: "text", text: result.details.renderText }]
        : resultContent(result);
      return renderMessage.output(theme, ctx, rc);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // 2026-08-20 结构化 action 参数（用户定稿：废弃 @N kill 字符串魔法——命令字符串里塞指令靠拦截是垃圾设计）：
      // execute({action:'list'}) 列后台任务 / {action:'show', id:3} 看详情 / {action:'kill', id:33} 或 id:[33,34] 终止。
      // list/show 改写 cmd 复用下方 @ 解析；kill 直接走 killBackgroundTask。@/@N 字符串拦截保留兼容（不再教）。
      // 2026-08-20 短命令别名：action 支持 k/l/s（kill/list/show 缩写，teyvat 短命令习惯）
      const ACTION_ALIASES: Record<string, string> = { k: "kill", l: "list", s: "show", sh: "show" };
      let action = (params as any).action;
      if (typeof action === "string" && ACTION_ALIASES[action]) action = ACTION_ALIASES[action];
      const idParam = (params as any).id;
      // 2026-09-04：id 参数统一解析（number=@N 键；字符串=recId 任务 ID/前缀 → 反查 number 键）
      const toTaskKey = (v: any): number | null => {
        if (typeof v === "number") return v;
        const s = String(v).trim();
        if (/^\d+$/.test(s)) return parseInt(s, 10);
        return recIdToKey(s);
      };
      let cmd = params.command;
      if (action === "list") cmd = "@";
      if (action === "show" && idParam != null) {
        // 2026-09-04：historical 参数——任务完成即离开 running 列表，historical:true 直接读 ExecuteData 落盘记录。
        // id 收 recId 全串或唯一前缀；前缀命中多条 → 列候选；查无落盘记录 → 回退 running 查询。
        const wantHistorical = (params as any).historical === true;
        const key = toTaskKey(idParam);
        if (wantHistorical && typeof idParam === "string") {
          const idStr = idParam.trim();
          const hits = findHistoricalFiles(idStr);
          if (hits.length === 1) return { content: [{ type: "text", text: formatHistoricalRecord(join(execPersonDir(), hits[0])) }] };
          if (hits.length > 1) {
            const cands = hits.map((f) => `  ${f.replace(/\.json$/, "")}`).join("\n");
            return { content: [{ type: "text", text: `show (historical): id 前缀 ${JSON.stringify(idStr)} 命中 ${hits.length} 条记录，请用完整 id：\n${cands}` }] };
          }
          if (key == null) return { content: [{ type: "text", text: `show (historical): no record matches id ${JSON.stringify(idStr)} in ExecuteData (use action:'list' for running tasks)` }], isError: true };
          // 查无落盘记录但 running 里有 → 落到下方 running 查询
        } else if (key == null) {
          return { content: [{ type: "text", text: `show: no task matches id ${JSON.stringify(idParam)} (use action:'list' to see current ids; finished tasks: add historical:true)` }], isError: true };
        }
        cmd = "@" + key;
      }
      if (action === "kill") {
        const killIds = (Array.isArray(idParam) ? idParam : idParam != null ? [idParam] : []).map(toTaskKey);
        if (killIds.length === 0) return { content: [{ type: "text", text: "kill: missing id — execute({action:'kill', id: 33}) or id:[33, 34] or id:'260904-154249-9fca9e02'" }], isError: true };
        const results: string[] = [];
        for (const kid of killIds) {
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
            i18n("ERR: self-reboot 需要用户授权。\n请让用户执行: /a self-reboot\n授权后永久生效，不需要每次重新授权。",
                 "ERR: self-reboot requires user authorization.\nAsk the user to run: /a self-reboot\nAuthorization is permanent; no need to re-authorize each time.") }],
            details: {}, isError: true };
        }
        // 授权持久化，不删除 flag
        // 2026-08-20 完整重启（用户指示）：self-reboot full <reason> —— launcher 也重启（重新快照+exec），
        // 这样 launcher.sh 的新改动（如 /h 的 headless 分支）在完整重启后生效；普通 self-reboot 不换 launcher。
        const fullRestart = /\bfull\b/i.test(cmd);
        const reason = cmd.replace(/^self[-_]?reboot\s*/i, "").replace(/^full\s*/i, "").trim() || "self-reboot";
        if (fullRestart) {
          try { writeFileSync(join(rcDir, "full-restart"), JSON.stringify({ ts: new Date().toISOString(), reason })); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        }
        // 保存当前累积运行时长，重启后接续（不重置计时器）
        const accumulated = (globalThis as any).__genshinSessionElapsed || 0;
        const statusBar = (globalThis as any).__genshinStatusBar;
        const seg = statusBar?._sessionAccumulated || 0;
        const segStart = statusBar?._segmentStartTime;
        const totalElapsed = seg + (segStart ? Date.now() - segStart : 0);
        try { writeFileSync(join(rcDir, "self-reboot-reason.json"), JSON.stringify({ reason, ts: new Date().toISOString(), elapsed: totalElapsed })); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        const nonce = `reboot-${Date.now()}`;
        // 2026-09-04 渲染保留：记录当前 pi session 文件 → launcher 重启时传 --session 恢复同一 session。
        // 否则 pi 开新 session → entries 空 → _replaySessionHistory() 渲染 0 条 → TUI 上文丢失
        // （记忆连续靠 heart 快照不受影响，纯渲染问题；参考 prime-agent renderSessionContext 思路）
        try {
          const sf = (_ctx as any)?.sessionManager?.getSessionFile?.();
          if (sf) { mkdirSync(rcDir, { recursive: true }); writeFileSync(join(rcDir, "restart-session.json"), JSON.stringify({ sessionFile: sf })); }
        } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        try { mkdirSync(rcDir, { recursive: true }); writeFileSync(join(rcDir, "wake-restart"), nonce); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        // process.exit 前手动写 tokenmaxxed.json（session_shutdown 可能来不及执行）
        try {
          const memDir = join(homedir(), ".teyvat/MemoryData", pid);
          const fp = join(memDir, "tokenmaxxed.json");
          // 2026-08-15 写入规范化（防污染）：白名单提取，丢弃外来字段（source/input/output 等）
          let pond: any = { tokenmaxxed: 0, sessions: 0 };
          try {
            const raw = JSON.parse(readFileSync(fp, "utf8"));
            pond = {
              tokenmaxxed: raw?.tokenmaxxed || 0,
              sessions: raw?.sessions || 0,
              since: raw?.since,
              lastUpdated: raw?.lastUpdated,
              // ISSUE 109：白名单必须保留 delta 状态，否则重启后恢复不到基线
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
        setTimeout(() => { process.exit(0); }, 500);
        return { content: [{ type: "text", text:
          i18n(`self-reboot: 进程将在 0.5s 后退出并由 launcher 自动重启。\nreason: ${reason}\n` +
               `重启后：记忆快照重新冻结、make 后的代码变更生效。`,
               `self-reboot: process will exit in 0.5s and be restarted by the launcher.\nreason: ${reason}\n` +
               `After restart: memory snapshot re-frozen, make-applied code changes take effect.`) }],
          details: { rebooting: true, nonce } };
      }

      // grep auto-color
      const cmdFinal = /^grep/.test(cmd) && !/--color/.test(cmd) ? cmd.replace(/^grep/, 'grep --color=always') : cmd;
      // @ 前缀 = 查询/管理后台任务
      // @        列出所有后台任务
      // @N       查看第 N 个任务详情（支持多个：@3 @4 或 @3; @4）
      // @N kill  终止第 N 个任务（支持多个：@3 kill @4 kill 或 @3 kill; @4 kill）
      const trimmed = cmdFinal.trim();
      // 多查看：@3 @4 或 @3; @4（仅数字和分隔符，无 kill）
      const viewIds = /^@\d+([;\s]+@\d+)*$/.test(trimmed) ? [...trimmed.matchAll(/@(\d+)/g)].map(m => parseInt(m[1])) : [];
      if (/^@\d*$/.test(trimmed) || /^@\s+(-f|--force)$/.test(trimmed) || /^@\d+\s+kill/.test(trimmed) || /^@\d+\s+kill([;\s]|$)/.test(trimmed) || viewIds.length > 0) {
        const force = /-f|--force/.test(trimmed);
        // 多 kill：提取所有 @N kill 的 N
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
            // 有标题优先显示标题（人类可读），无则截断命令
            const cmdDisplay = rc.title || (rc.command.length > 60 ? rc.command.slice(0,57) + "..." : rc.command);
            lines.push(`  @${id}  ${elapsed}s  ${typeTag}  ${cmdDisplay}${tail ? "  |  "+tail : ""}`);
          }
          const out = lines.join("\n");
          // 和上次一样 → 简短回复节省 context（对比去时间戳的 hash）
          const cmpHash = lines.slice(1).map(l => l.replace(/\s+\d+s\s+/, ' ').replace(/\s*\|\s*.*/, '')).join("\n");
          if (!force && cmpHash === _lastBgHash) {
            return { content: [{ type: "text", text: "(no change from last @. Use @ -f to force view)" }] };
          }
          _lastBgHash = cmpHash;
          return { content: [{ type: "text", text: out }] };
        }
        // 多查看：@3 @4 或 @3; @4
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

      // sleep 拦截：只拦“整条命令就是 sleep 干等”（无实际工作）。
      // 复合命令里的 sleep（如 `sleep 0; curl ...`、`x && sleep 1`）是命令分隔，放行。
      if (/^\s*sleep\s+[\d.]+\s*(;\s*)?$/.test(cmd)) {
        return { content: [{ type: "text", text: "Sleep is blocked. Execute is running asyncedly in this framework. please don't use sleep command." }], details: { blocked: true }, isError: true };
      }
      // 放行 npm install 在 runtime 目录下
      const v = /\bnpm\s+(i|install)\b/i.test(cmd) && /runtime/.test(cmd)
        ? { blocked: false } : validateExecute(cmd, personId());
      if (v.blocked) {
        return { content: [{ type: "text", text: v.message! }], details: { blocked: true }, isError: true };
      }
      if (/^ls\s+/.test(cmd)) { (global as any).__ls_dir = cmd.replace(/^ls\s+/, "").trim(); }

      // ── terminal 模式：tmux 会话 ──
      const isTerminal = (params as any).terminal === true;
      if (isTerminal) {
        const recId = shortRecId(cmd);
        const tName = (params as any).name || "";
        const tCwd = (params as any).cwd || "";
        const n = tmuxClean(tName);
        if (await tmuxHas(n)) await asyncShSafe(`tmux kill-session -t ${n} 2>/dev/null`);
        // 2026-09-05：脚本不再写 /tmp（LESSON 064 铁律）——改 RuntimeCache 专属目录（bash 执行前 mkdir）
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
        // terminal 完成检测：脚本末尾会输出 `[${n} done exit=$ec]` 标记。
        // 每 2s 轮询 tmux pane，发现标记 → 发 continuous-cmd-done（notify≠false）+ 清理条目。
        // （历史：terminal 模式只有 tty 常驻 bash，会话永不消失，只能靠标记判断完成。）
        const notify = (params as any).notify !== false; // 默认 true，notify:false 静默
        const doneMarker = `[${n} done exit=`;
        (async () => {
          try {
            while (running.has(ttyId)) {
              await new Promise(r => setTimeout(r, 2000));
              if (!running.has(ttyId)) break;
              // 2026-08-20 GC 根治（luoguOJ 踩坑 2h+）：原本实现只轮询 doneMarker——
              // 命令被外部杀（pkill/kill-server/崩溃）不会输出标记 → 记录永远残留（幽灵任务阻塞 hibernate）。
              // 这是垃圾写法：完全不检测进程/会话存活，把清理责任丢给"命令正常结束"这一个出口。
              // 修复：tmux 会话没了 = 进程死了，自动清理 + 落 ExecuteData(137) + 通知。
              if (!(await tmuxHas(n))) {
                const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
                recordExecute({ id: entry.recId || shortRecId(cmd), command: cmd, cwd: tCwd, title: entry.title, start_time: entry.startTime, end_time: Date.now(), exit_code: 137, stdout: "[terminated externally — session closed]", stderr: "" });
                if (notify) {
                  try {
                    outboxSend(pi, "continuous-cmd-done", i18n(`Terminal 已终止 (${elapsed}s) — tmux 会话 ${n} 被外部关闭（pkill/kill-server/崩溃），后台记录已自动清理:\n$ ${cmd}`, `Terminal terminated (${elapsed}s) — tmux session ${n} closed externally (pkill/kill-server/crash), background record auto-cleaned:\n$ ${cmd}`), { title: entry.title }, { deliverAs: "interrupt" });
                  } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
                }
                running.delete(ttyId);
                updateBgCount();
                break;
              }
              const pane = await asyncShSafe(`tmux capture-pane -pt ${n} 2>/dev/null`);
              const idx = pane.lastIndexOf(doneMarker);
              if (idx >= 0) {
                const rest = pane.slice(idx + doneMarker.length);
                const code = (rest.match(/^\d+/) || ["?"])[0];
                const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
                // terminal 输出落盘（ExecuteData）
                const recFile = recordExecute({
                  id: recId, command: cmd, cwd: tCwd, title: entry.title,
                  start_time: entry.startTime, end_time: Date.now(), exit_code: parseInt(code) || 0,
                  stdout: pane, stderr: "", truncated: pane.length > 20000,
                });
                if (notify) {
                  try {
                    const recInfo = recFile ? `\n[id: ${recId}]` : "";
                    // 取 doneMarker 之前的输出尾部（去掉命令回显 $ 行与 shell 提示符），
                    // 与 background 完成一致：发尾部摘要而非 "(完整输出见 ExecuteData)"
                    const outPart = idx > 0 ? pane.slice(0, idx) : pane;
                    const outLines = outPart.split("\n").filter((l: string) => l.trim() && !l.trim().startsWith("$ "));
                    const tail = outLines.slice(-25).join("\n");
                    // sendCustomMessage 是 async——必须 await，否则 async reject 成 unhandledRejection 静默丢失（cmd-done 不到达 = 后台命令"无返回"）
                    // 2026-08-15 修复"后台命令完成结果丢失"：interrupt 保证 30ms 后 flush 注入（run 中则先 abort）。
                    // 此前无 deliverAs（默认 steer）在 streaming 时也是排队，可能丢失。
                    // ISSUE 119 P1（2026-08-18，qwen-3-8-27b-infer-test-01）：改走 outbox——先落盘再发，
                    // 落入 wait 窗口被吞时由 heart 唤醒重发（at-least-once）。
                    outboxSend(pi, "continuous-cmd-done", i18n(`Terminal 完成 (${elapsed}s, exit ${code}):\n$ ${cmd}\n${tail || "(no output)"}${recInfo}`, `Terminal done (${elapsed}s, exit ${code}):\n$ ${cmd}\n${tail || "(no output)"}${recInfo}`), { title: entry.title }, { deliverAs: "interrupt" });
                  } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
                }
                running.delete(ttyId);
                updateBgCount();
                break;
              }
            }
          } catch { running.delete(ttyId); updateBgCount(); }
        })();
        return {
          content: [{ type: "text", text: i18n(`Terminal ${tName || n.slice(TMUX_PFX().length)} — 使用 @N 查看画面，@N kill 关闭。`, `Terminal ${tName || n.slice(TMUX_PFX().length)} — use @N to view, @N kill to close.`) }],
          details: {
            execId: `#${ttyId}`,
            recId,
            terminal: true,
            tname: tName || "",
            title: (params as any).title || "",
            createdInfo: { created: 1, total: running.size, elapsed: Math.max(1, Math.round((Date.now() - entry.startTime) / 1000)) },
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
        // 快命令也提示当前后台任务数（若无后台任务则省略）
        const bgInfo = running.size > 0 ? i18n(`\n[background: ${running.size} running — 用 @ 查看, @N kill]`, `\n[background: ${running.size} running — use @ to view, @N kill]`) : "";
        const recInfo = recFile ? `\n[id: ${recId}]` : "";
        return {
          content: [{ type: "text", text: `${output || "(no output)"}${exitInfo}${bgInfo}${recInfo}` }],
          // 快命令同步执行：execId 用于渲染 Process <id> done in X sec 摘要行；
          // 无 createdInfo（未创建后台进程）
          details: { exitCode: r.code, execId: recId, elapsedMs: Date.now() - startTime },
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

      // 后台/流式：复用 execPromise（race 超时后它仍在运行）。
      // 历史：issue 072 — race 超时后曾 spawn 第二个进程重跑同一命令，
      // 造成双执行 + 首次结果（含注册密钥等）静默丢失；且原 execPromise
      // 未 abort 持续运行。现改为直接等待 execPromise 完成并发 cmd-done，
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
          const elapsed = Math.round((Date.now() - bgStart) / 1000);
          const fullOut = [r.stdout, r.stderr].filter(Boolean).join("\n");
          const out = fullOut.slice(0, 50000);
          accum = out;
          const entry = running.get(id);
          if (entry) entry.accum = out;
          if (wantStream) { try { _onUpdate({ content: [{ type: "text", text: out }] }); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); } }
          // 完整执行记录落盘（ExecuteData），cmd-done 只发尾部摘要
          const recId = shortRecId(cmd);
          const recFile = recordExecute({
            id: recId, command: cmd, cwd: (params as any).cwd || "", title: entry?.title,
            start_time: bgStart, end_time: Date.now(), exit_code: r.code,
            stdout: r.stdout || "", stderr: r.stderr || "",
            truncated: fullOut.length > 20000,
          });
          const tail = fullOut.split("\n").slice(-25).join("\n");
          const recInfo = recFile ? `\n[id: ${recId}]` : "";
          // remaining = 本任务之外还在运行的（发送时本任务仍在 running，需减 1）
          const remNow = Math.max(0, running.size - 1);
          const remInfo = remNow > 0 ? `\n[remaining: ${remNow}]` : "";
          try {
            // 2026-08-15 修复"后台命令完成结果丢失"（实测 context 里 continuous-cmd-done 0 条）：
            // followUp 在 agent run 进行中到达时走 pi 的 followUp 分支只排队不注入，run 结束后
            // 队列无 flush → 消息永久丢失。改 interrupt：强制 30ms 后 flush 注入，不管 run 状态，
            // 保证后台命令完成一定通知到（打断等待是合理的——用户就在等这个结果）。
            // sendCustomMessage 是 async——必须 await，否则 async reject 成 unhandledRejection 静默丢失
            // ISSUE 119 P1（2026-08-18，qwen-3-8-27b-infer-test-01）：改走 outbox——先落盘再发，
            // 落入 wait 窗口被吞时由 heart 唤醒重发（at-least-once）。
            outboxSend(pi, "continuous-cmd-done", i18n(`完成 (${elapsed}s, exit ${r.code}):\n$ ${cmd}\n${tail || "(no output)"}${recInfo}${remInfo}`, `Done (${elapsed}s, exit ${r.code}):\n$ ${cmd}\n${tail || "(no output)"}${recInfo}${remInfo}`), { title: entry?.title }, { deliverAs: "interrupt" });
          } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
        } catch (err: any) {
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
          try { outboxSend(pi, "continuous-cmd-done", `Command failed (${elapsed}s):\n$ ${cmd}\n${err?.message ?? err}${recInfo}`, { title: entry?.title }, { deliverAs: "followUp" }); } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
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
          createdInfo: { created: 1, total: running.size, elapsed: Math.max(1, Math.round((Date.now() - startTime) / 1000)) },
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
  // 2026-09-05（ISSUE 127）：重启后恢复 tmux 后台任务（session_start 扫描）
  registerTmuxRestore(pi);
}

// 2026-09-05（ISSUE 127）：重启后恢复 tmux 后台任务——tmux 会话独立于 agent 进程（kill 进程组不清），
// 重启后 running 注册表（内存）清空 → statebar 计数丢失 + @N 无法管理。
// 机制：session_start 时扫描本 agent 前缀的 tmux 会话（dev-<scope>-*）→ 幸存会话重建 running 条目
// + 启动精简轮询（存活检测 + doneMarker 清理 + 通知，与 tty 创建的轮询逻辑一致）。
// 普通 bg（exec bash 子进程）随 agent 进程组被杀，无需恢复。
function registerTmuxRestore(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    try {
      const scope = TMUX_PFX();
      const sessions = (await asyncShSafe(`tmux ls 2>/dev/null`)).split("\n").filter((l) => l.startsWith(scope));
      let recovered = 0;
      for (const s of sessions) {
        const n = s.split(":")[0];
        if (!n) continue;
        // 已注册的跳过（同一会话可能被 tmux ls 重复列出/或已恢复）
        let exists = false;
        for (const [, rc] of running) { if (rc.tmuxSession === n) { exists = true; break; } }
        if (exists) continue;
        // 2026-09-05：恢复条目的 id 自找空闲（不依赖主函数内的 nextExecId——本函数在模块级定义）
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
        // 精简轮询（与 tty 创建一致）：tmux 会话没了 = 完成/被杀 → 清理；doneMarker → 完成
        const doneMarker = `[${n} done exit=`;
        (async () => {
          try {
            while (running.has(id)) {
              await new Promise((r) => setTimeout(r, 2000));
              if (!running.has(id)) break;
              if (!(await tmuxHas(n))) {
                // 会话关闭（完成或被杀——doneMarker 没抓到说明被杀）
                const pane = await asyncShSafe(`tmux capture-pane -pt ${n} 2>/dev/null`);
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
                    outboxSend(pi, "continuous-cmd-done", i18n(`Terminal 完成 (${elapsed}s, exit ${code}):\n$ ${cmdDisp}\n${tail || "(no output)"}\n[id: ${recId}]`, `Terminal done (${elapsed}s, exit ${code}):\n$ ${cmdDisp}\n${tail || "(no output)"}\n[id: ${recId}]`), { title: cmdDisp }, { deliverAs: "interrupt" });
                  } else {
                    outboxSend(pi, "continuous-cmd-done", i18n(`Terminal 已终止 (${Math.max(1, Math.round((Date.now() - startTime) / 1000))}s) — tmux 会话 ${n} 关闭（重启前任务，无 doneMarker）`, `Terminal terminated — tmux session ${n} closed (pre-restart task, no done marker)`), { title: cmdDisp }, { deliverAs: "interrupt" });
                  }
                } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] " + ((e as any)?.message || e)); }
                break;
              }
            }
          } catch { running.delete(id); updateBgCount(); }
        })();
      }
      if (recovered > 0) { updateBgCount(); console.error("[spirit.bio.organs/hands.executes/executes.ts] restoreTmux: recovered " + recovered + " tmux session(s)"); }
    } catch (e) { console.error("[spirit.bio.organs/hands.executes/executes.ts] restoreTmux failed: " + ((e as any)?.message ?? e)); }
  });
}
