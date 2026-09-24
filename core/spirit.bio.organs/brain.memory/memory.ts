// 文档: B.docs/Dev.Common/Wiki/Memory(Organ).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { getSessionRole, getPrompt } from "#kernel_ribosome";
import { memoryDir,  personDataDir as _personDataDir, memoryDataDir, sessionDirFor, estimateTokens, monitorDataFile, runtimeCacheDir as _runtimeCacheDir, readGrowthLast } from "#paths";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage, SYM } from "#tui_blockrender";
import { createHash, randomBytes } from "node:crypto";
import { logerr } from "#paths";
import { appendAsync } from "#kernel_nerves";
import { i18n } from "#tui_localizations";
import { registerAmemTool, _fmtLocalTs } from "./memory-amem.ts";
import { trackBlock } from "#blocktrace";

function getPersonDir(sessionFile: string | undefined): string | null {
  const envDir = process.env.PI_PERSON_DIR;
  if (envDir) return envDir;
  const dir = _personDataDir(sessionFile);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readFile(p: string): string {
  try { return fs.readFileSync(p, "utf-8"); } catch (e: any) {
    // 2026-09-08：ENOENT（文件不存在）是预期可缺（work_memory/context/neocortex 等首次未建/可选文件）——静默返回空不打日志（启动早期曾刷屏）；真错误（权限/IO）才打。
    if (e?.code === "ENOENT") return "";
    console.error("[spirit.bio.organs/brain.memory/memory.ts] " + (e?.message || e));
    return "";
  }
}

function _errLogPath(p: string): string {
  const m = p.match(/MemoryData\/([a-f0-9]+)/);
  if (!m) return path.join(homedir(), ".teyvat/LogData/unknown/error.log");
  // 2026-08-20：HOME fallback 不用 /tmp（用户定稿：永远不用 tmp）——homedir() 恒有值
  return `${process.env.HOME || homedir()}/.teyvat/ErrorData/${m[1]}/error.log`;
}

// @deprecated — 同步版保留给极少数必须保证写入顺序的场景（如 writeFile）
function appendFileSync(p: string, text: string): void {
  try { fs.appendFileSync(p, text, "utf-8"); } catch (e) { try { const d = path.dirname(_errLogPath(p)); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(_errLogPath(p), `[${new Date().toISOString()}] [memory] appendFile ${p}: ${e}\n`); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); } }
}

function appendFile(p: string, text: string, maxBytes?: number): void {
  appendAsync(p, text, maxBytes);
}

// 2026-09-09（用户报 bug：homedir 下被拉出 MonitorData/undefined + undefined 空目录）：
// __genshinPersonDir/__genshinAgentFileDir/__genshinPersonId 未设时（启动早期/特定进程/session_shutdown 晚段）
// 字符串拼接出 undefined 相对路径 → 在 cwd(~) 下 mkdir 垃圾。统一走本 helper：全局无效静默跳过（监控数据非核心，丢记录可接受）。
// 2026-09-13（H3）：路径唯一真相源改 #paths.monitorDataFile（AgentFileData/MonitorData/<pid>/<file>）。
// 之前这里用 __genshinAgentFileDir + "/../MonitorData" 拼出同一位置，但 heart.ts / status.ts / 本文件 tool_call 门禁
// 三处读取全读 MemoryData/<pid>/monitor/growth.jsonl（磁盘上从未存在）→ ISSUE 188 的「95% 强制 amem」与 status 的 Context 行一直是死代码。
function monitorDataPath(file: string): string | null {
  const pid = global.__genshinPersonId;
  if (!pid || !/^[a-f0-9]{8}$/.test(pid)) return null;
  return monitorDataFile(pid, file);
}
function monitorAppend(file: string, json: string): void {
  const p = monitorDataPath(file);
  if (!p) return;
  try { appendFile(p, json); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
}

export function writeFile(p: string, text: string): void {
  // 2026-08-20 原子写（tmp + rename）：防重启时新旧进程交替读到半截文件（Unexpected end of JSON input 竞态根因）
  try { const tmp = p + ".tmp-" + process.pid; fs.writeFileSync(tmp, text, "utf-8"); fs.renameSync(tmp, p); } catch (e) { try { const d = path.dirname(_errLogPath(p)); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(_errLogPath(p), `[${new Date().toISOString()}] [memory] writeFile ${p}: ${e}\n`); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); } }
}

// 机密脱敏：把 sshpass 密码、sk- 风格 API key、Bearer token 的【值】盖成 [REDACTED]，只留结构。
// 不是删——保留"这里有个密码"的痕迹，只抹掉值。幂等(已脱敏的再跑结果不变)。
function scrubSecrets(s: string): string {
  if (!s) return s;
  // 2026-09-13：引号组要认得 JSON 转义（\" / \\\"）——它是跑在 JSONL 行上的。旧写法 (["']?)([^\s"']+) 遇到 `-p \"pw\"` 时
  // 引号组匹配空、值组把反斜杠串当密码吃掉 → 转义被破坏，整行 JSON 失效（实测 02ea5bf8 2 行、f1ab6f60 1 行，原文其实是 grep "sshpass -p" 这种没密码的命令）。
  // 现在：引号组 = 若干反斜杠 + 可选引号；值不含反斜杠/引号/空白；闭合用同一引号组。
  return s
    .replace(/(sshpass\s+-p\s*)((?:\\+)?["']?)([^\s"'\\]+)\2/g, "$1$2[REDACTED]$2")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]")
    .replace(/\b(Bearer[;:\s]+)[A-Za-z0-9._-]{12,}/g, "$1[REDACTED]");
}

let _memoryRegistered = false;
export default function registerMemory(pi: ExtensionAPI) {
  if (_memoryRegistered) {  return; }
  _memoryRegistered = true;
  let personDir: string | null = null;

  // ── tokenmaxxed session 累积器（ISSUE 107 delta 方案）──
  // 语义（用户 2026-08-18 定义）：认知履历（社会资历，RSI-001），不是用量/成本统计。
  // 不变式：无 amem 时增长 = context 增长；amem 裁剪时 novel clamp 到 0（不降）。
  // 公式（Fable delta 设计，ISSUE-098）：
  //   prompt = input + cacheRead（完整 prompt，与缓存状态无关）
  //   novel  = max(0, prompt - prevPrompt - prevOut)  // 真正新增外部输入；重读/收缩归零
  //   tokens += novel + output；prevOut = output - reasoning（reasoning 不回显）
  // prevPrompt/prevOut 持久化到 tokenmaxxed.json，跨 session 连续（重启/快照重冻结自动正确）。
  const _pondSess: { tokens: number; prevPrompt: number | null; prevOut: number } = { tokens: 0, prevPrompt: null, prevOut: 0 };
  (globalThis as any).__genshinPondSess = _pondSess;
  // 本 session 累计 API 成本（pi 每条 assistant 消息报 usage.cost.total）。
  // 2026-09-13：RuntimeCache/<id>/cost-<role>.json 原来的写入方早已下线（磁盘最新一份 7 月 9 日），
  // 而 footer 钱包 / session_shutdown 的 cost_total 累计 / mobile 设置页三处读者仍在读 → 成本永远 0。现在由 message_end 写。
  let _costSess = 0;
  let _costDirReady = false;
  function flushCost(): void {
    if (!personDir) return;
    try {
      const pid = path.basename(personDir);
      const dir = _runtimeCacheDir(pid);
      if (!_costDirReady) { fs.mkdirSync(dir, { recursive: true }); _costDirReady = true; }
      const role = getSessionRole() || "main";
      writeFile(path.join(dir, `cost-${role}.json`), JSON.stringify({ role, cost: +_costSess.toFixed(6), ts: Date.now() }));
    } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] flushCost: " + ((e as any)?.message || e)); }
  }

  // ISSUE 106：实时落盘 —— 文件.tokenmaxxed += pond 增量后清零（已入账）。
  // footer/status 直接读文件即实时值，不再等 session_shutdown、无需 pond 叠加 hack。
  // 白名单字段规范化同 session_shutdown（防污染）；sessions 语义 = 完整 session 数，由 shutdown 维护。
  // ISSUE 107：prevPrompt/prevOut 一并落盘（delta 跨 session 连续的关键，每轮都更新）。
  function flushTokenmaxxed() {
    if (!personDir) return;
    try {
      const tokenmaxxedPath = path.join(personDir!, "tokenmaxxed.json");
      let pond: any = { tokenmaxxed: 0, sessions: 0 };
      try {
        // 2026-08-20 修复：空/截断文件安全解析（竞态截断是暂时性的，下次写入自动修复——用默认值不刷日志）
        let raw: any = null;
        try { raw = JSON.parse(readFile(tokenmaxxedPath) || "{}"); } catch {  /* 截断/损坏：用默认值，不刷日志 */ }
        pond = {
          tokenmaxxed: raw?.tokenmaxxed || 0,
          sessions: raw?.sessions || 0,
          since: raw?.since,
          lastUpdated: raw?.lastUpdated,
          prevPrompt: typeof raw?.prevPrompt === "number" ? raw.prevPrompt : null,
          prevOut: raw?.prevOut || 0,
        };
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
      pond.tokenmaxxed = (pond.tokenmaxxed || 0) + _pondSess.tokens;
      if (!pond.since) pond.since = new Date().toISOString();
      pond.lastUpdated = new Date().toISOString();
      pond.prevPrompt = _pondSess.prevPrompt ?? null;
      pond.prevOut = _pondSess.prevOut || 0;
      writeFile(tokenmaxxedPath, JSON.stringify(pond, null, 2));
      _pondSess.tokens = 0;
    } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
  }

  let _lastCapacityUrge = 0; // 2026-08-15 容量提醒去重：同一提醒周期（>=80%）只发一条，回落 <80% 清除
  pi.on("message_end", async (event) => {
    const msg = event.message as any;
    if (!msg || msg.role !== "assistant") return;
    // ISSUE 109：aborted/error 消息没有真实 usage（prompt=0），参与 delta 会把 prevPrompt
    // 清零，导致下一轮正常消息 novel = 整个 prompt 暴涨（每次用户打断 +~210k）。
    // 被打断的消息不产生新认知，直接跳过（不更新基线、不累积）。
    if (msg.stopReason === "aborted" || msg.stopReason === "error") return;
    const u = msg.usage;
    if (u) {
      // ISSUE 107 delta：只计"真正新增"（prompt 相对上轮的增长 - 上轮 output 回显）
      // 2026-09-12（ISSUE 203 nit，debug-01 复核指出）：prompt 总量含 cacheWrite 才完整
      // （与 footer.js 的 latestPromptTokens 同公式——否则换到有 cacheWrite 的 provider 又会出现两个 API 值不等）；
      // deepseek 实测 cacheWrite=0，行为不变。
      const prompt = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      const out = u.output || 0;
      const reasoning = u.reasoning || 0;
      const prevPrompt = _pondSess.prevPrompt;
      let novel = 0;
      if (prevPrompt !== null) {
        novel = Math.max(0, prompt - prevPrompt - _pondSess.prevOut);
      }
      _pondSess.tokens += novel + out;
      _pondSess.prevPrompt = prompt;
      _pondSess.prevOut = Math.max(0, out - reasoning);
      // 实时更新 context gauge（纯想/聊天时 bioclock 注入 ground truth，对抗 off-policy bias）
      _refreshModelMax();
      const promptPct = Math.round((prompt / modelMax) * 100);
      (globalThis as any).__genshinContextGauge = `ctx ${promptPct}%`;
      // ISSUE 106：每轮实时落盘（入账后清零，footer/status 读文件即实时值）
      flushTokenmaxxed();
      // 成本累计（见 flushCost 注释）
      _costSess += u.cost?.total || 0;
      flushCost();
    }
  });

  // 2026-09-12：gauge 唯一写入者是 message_end（L158，API prompt 真值）。
  // amem 后 gauge 暂时过期（到下一个 model response 才更新），但不再用另一个口径覆盖——
  // 之前用 memTokens 估算覆盖导致 gauge 在两个口径之间来回跳（30% vs 65%）。
  // amem 改完 context.md 后：算出"本 turn 起点"（context.md 最后一条 user 行的 ts）——
  // 快照只装本 turn 之前的记忆，本 turn 的行留在活对话里（同一批内容不重复注入）。
  function _lastUserRowTsInContext(): number {
    if (!personDir) return 0;
    try {
      const lines = readFile(path.join(personDir, "context.md")).split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (!t.startsWith("{")) continue;
        try {
          const o = JSON.parse(t);
          const isUser = o?.role === "user" || o?.type === "user_msg";
          if (!isUser) continue;
          const ts = typeof o?.ts_start === "number" ? o.ts_start : (typeof o?.ts === "number" ? o.ts : 0);
          if (ts > 0) return ts;
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 无 context.md → 0（调用方据此放弃本轮热重建） */ }
    return 0;
  }

  function _refreshGaugeAfterContextChange(_newCtx: string): void {
    // 2026-09-16（用户暴怒：amem 不生效——archive 只改磁盘不改内存）：amem 改了 context.md 必须下一轮就生效，不重启。
    // 2026-09-24（用户：amem 后卡住 30 秒）：buildSnapshot 串行同步慢 → 异步预构建，不阻塞 amem 返回。
    // 2026-09-25（用户："什么垃圾？重启才能 amem 生效"）—— 根因：原实现直接写 __genshinGetSession().agent.state.messages，
    //   而 heart.ts 的 __genshinGetSession 每次返回**新对象**（ctx.sessionManager.buildSessionContext() 重建），
    //   赋值只落在临时对象上 → 从未生效（实测：amem 后 api 纹丝不动，只有重启重注入快照才降）。
    //   现改为：置位 _pendingWindowCompact，交给 pi 的 context 事件（唯一正式改写入口，每次 LLM 调用前）重建**请求视图**：
    //   记忆 = context.md（本 turn 之前，用重建快照注入）＋ 活对话 = 本 turn（最后一条 user 消息起）。
    //   session 存储一字不改（TUI 照常显示全史），只是发给模型的那份视图与 context.md 对齐。
    if (getSessionRole() !== "main" || !_snapshotInjected) return;
    const _t0 = _lastUserRowTsInContext();
    if (_t0 <= 0) return; // context.md 里没有 user 行 → 切不出"本 turn"，本轮不重建（下轮再说）
    _pendingWindowCompact = true;
    setTimeout(() => {
      try { _snapshotOverride = buildSnapshot({ excludeRowsSince: _t0 }); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    }, 0);
  }

  // ── session_start: 注入"记忆快照"一次（稳定前缀 = 缓存命中的关键）────────────
  // 醒来时把 DNA + cortex + work_memory + context(按预算切尾部) 揉成一份快照，注入一次。
  // 本会话中绝不再重发（见 before_agent_start）；新内容一律往「后面」append → 前缀不变 → 每轮命中缓存。
  // ── 快照替换（ISSUE 204 根因修复，2026-09-13）──
  // amem 归档后 context.md 缩水，磁盘上的冻结快照会重建，但活对话窗口里那条 memory-snapshot 消息还是旧的：
  // 旧代码想"原地改 pi.agent.state.messages"——ExtensionAPI 根本没有 agent 属性，永远走不到；fallback 追加一份新快照又会让窗口不降反增。
  // 正确入口：pi 的 context 事件（每次 LLM 调用前把 messages 克隆交给扩展，返回 {messages} 即替换）。
  // 替换用的快照剔除本 session 产生的行（ts ≥ 本次 session_start）——这些行已经在活对话里，重复注入只会白白占窗口。
  // 代价：前缀缓存失效一次（这是把窗口真正降下来的唯一方式，ISSUE 204 方案 a 的无重启版）。
  let _snapshotOverride: string | null = null;
  let _snapshotInjected = false;
  let _pendingWindowCompact = false; // amem 改 context.md 后置位：下一轮 LLM 调用前重建请求视图（见 _refreshGaugeAfterContextChange）
  // amem 后的活对话裁剪边界（持久）：pi 每次调用都从 session 重建消息数组，一次性裁剪下轮就弹回——
  // 必须固定"amem 那一刻的本 turn 起点"，之后每轮按同一位置重放（边界之前的行已在重建快照里）。
  let _compactBoundary: { index: number; ts: number | null } | null = null;
  let _sessionStartTs = Date.now();
  pi.on("context", async (event) => {
    const msgs: any[] = (event as any).messages || [];
    const snapIdx = msgs.findIndex((m) => m && m.role === "custom" && m.customType === "memory-snapshot");
    let next: any[] | null = null;

    // (a) 快照替换：amem 改了 context.md → 用重建的快照换掉活窗口里那条 memory-snapshot
    if (_snapshotOverride && snapIdx >= 0 && msgs[snapIdx].content !== _snapshotOverride) {
      next = msgs.slice();
      next[snapIdx] = { ...msgs[snapIdx], content: _snapshotOverride };
    }

    // (b) amem 后的窗口重建（视图层）：记忆 = context.md（本 turn 之前，已在重建的快照里）
    //     → 请求视图只留 system/custom + 本 turn（最后一条 user 消息起）。session 存储不动。
    //     保险：只有「记忆快照确实在这份请求里」时才裁——否则会把记忆整个裁掉。
    if (_pendingWindowCompact && _snapshotOverride && snapIdx >= 0) {
      _pendingWindowCompact = false;
      const base = next || msgs;
      let lastUser = -1;
      for (let i = base.length - 1; i >= 0; i--) {
        if (base[i]?.role === "user") { lastUser = i; break; }
      }
      if (lastUser > 0) {
        const um: any = base[lastUser];
        const ts = typeof um?.ts_start === "number" ? um.ts_start : (typeof um?.time?.created === "number" ? um.time.created : null);
        _compactBoundary = { index: lastUser, ts };
      }
    }

    // (b2) 重放边界（每轮）：边界之前的历史已在重建快照里 → 从请求视图里去掉（不重复注入、窗口才真降）
    if (_compactBoundary) {
      const base = next || msgs;
      let cut = -1;
      if (_compactBoundary.ts !== null) {
        for (let i = base.length - 1; i >= 0; i--) {
          const m: any = base[i];
          const mts = typeof m?.ts_start === "number" ? m.ts_start : (typeof m?.time?.created === "number" ? m.time.created : null);
          if (m?.role === "user" && mts === _compactBoundary.ts) { cut = i; break; }
        }
      }
      if (cut < 0 && base[_compactBoundary.index]?.role === "user") cut = _compactBoundary.index;
      if (cut > 0) {
        const head = base.slice(0, cut).filter((m: any) => m?.role === "system" || m?.role === "custom");
        next = [...head, ...base.slice(cut)];
      } else if (cut < 0) {
        _compactBoundary = null; // 边界失效（会话结构变了/重启过）→ 放弃裁剪（宁可不裁，也不误裁）
      }
    }

    if (next) return { messages: next };
    return;
  });

  // 切模型：上一轮 prompt 是旧模型算的，分子分母不再同源（1M→200k 会显示 245% 被钳成 100%，反向骤降）——清掉，等下一次回复再建
  pi.on("model_select", async () => {
    _pondSess.prevPrompt = null; _pondSess.prevOut = 0;
    (globalThis as any).__genshinContextGauge = "";
    _refreshModelMax();
  });

  pi.on("session_start", async (_event, ctx) => {
    personDir = getPersonDir(ctx.sessionManager.getSessionFile());
    dnaState = "wake"; // always wake on new session
    if (!personDir) return;
    _sessionStartTs = Date.now();
    _snapshotInjected = false;
    _snapshotOverride = null;

    // ISSUE 109：重启 = 快照重注入上文，上下文空间整体替换——旧 prevPrompt 与新 prompt
    // 无增量关系（跨 session 恢复会把重注入的上文误算为 novel，ISSUE 107 设计错误）。
    // 必须重新基线：null → 首轮 novel=0（重注入不算认知），首轮 prompt 成为新基线。
    _pondSess.prevPrompt = null;
    _pondSess.prevOut = 0;
    _costSess = 0; // 新 session 成本从 0 起算（cost-<role>.json 语义 = 本 session）

    // 只有主意识注入记忆快照。hc/sc/sl 小号有各自的活(读 context/feed/work_mem 编码)，
    // 绝不能把主意识那 ~90万 token 快照灌给它们 —— 会白白膨胀、甚至把小号撑挂(海马体死亡循环的元凶之一)。
    const sf0 = ctx.sessionManager.getSessionFile() || "";
    if (/metaconsciousnessSessions|HippocampusSessions|SleepSessions/.test(sf0)) {
      injectedWorkMemLen = readFile(path.join(personDir, "work_memory.md")).length;
      return;
    }

    // 机密脱敏(清历史)：把已混进 context/work_memory 的密码/key 值盖掉(只盖值不删，幂等，只在有变化时写回)。
    // 写入时也会脱敏(见 message_end)，这里清掉之前已经混进去的(如 sshpass 密码已散落 49 处)。
    for (const f of ["context.md", "work_memory.md"]) {
      try {
        const fp = path.join(personDir, f);
        const raw = readFile(fp);
        const cleaned = scrubSecrets(raw);
        if (cleaned !== raw) writeFile(fp, cleaned);
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    }

    // 2026-09-23（用户：砍掉 frozen 增量冻结机制——snapshot.frozen.txt/meta.json/memory-frozen-delta 全是过度设计）
    // 每次醒来直接 buildSnapshot() 注入一次；后续新内容往后面 append（见 message_end），前缀不变。
    const fresh = buildSnapshot();
    if (fresh) {
      sendCustomMessage(pi, "memory-snapshot", fresh);
      _snapshotInjected = true;
    }
  });

  // ── message_end: incremental append to context + file index ─────
  // 2026-09-13（L3）：amem 结果识别改用 pi ToolResultMessage.toolName（与 toolCall 一一对应），
  // 不再用 _pendingAmemResults 顺序计数器——同一条 assistant 消息并行发 [read, amem] 时，计数器会把 read 的结果
  // 压成 [memory op: …]、amem 的 ERR 结果反而漏压缩（hash 归一化漏过滤的残留变体）。
  pi.on("message_end", async (event) => {
    if (!personDir) return;
    // 只主意识写 context.md。hc/sc/sl 小号不写——它们的 tool output 会自噬膨胀。
    if (getSessionRole() !== "main") return;
    const msg = event.message as any;
    if (!msg) return;

    // custom 消息不写 context.md（记忆快照/系统通知/心跳等）—— 写进来就自引用膨胀。
    // 字段是 customType（不是 messageType，genshin 框架映射过）。
    const role = msg.role ?? "?";
    if (role === "custom") return;
    const ct = msg.customType ?? msg.messageType;
    if (typeof ct === "string" && ct.startsWith("memory-")) return;

    const entries: { role: string; type: string; content?: string; text?: string; think?: string; tool?: any; toolName?: string; toolCallId?: string; blockId?: string; ts_start: number; ts_end: number }[] = [];
    const now = Date.now();
    if (typeof msg.content === "string") {
      const msgType = msg.customType ?? msg.messageType;
      const entryType = typeof msgType === "string" ? msgType : (role === "user" ? "user_msg" : role === "tool" ? "toolResult" : "text");
      entries.push({ role, type: entryType, content: msg.content, ts_start: now, ts_end: now });
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "text" && c.text?.trim()) {
          entries.push({ role, type: "text", text: c.text.trim(), ts_start: c.ts_start ?? now, ts_end: c.ts_end ?? now });
        } else if (c.type === "thinking" && c.thinking) {
          entries.push({ role: "assistant", type: "think", think: c.thinking, ts_start: c.ts_start ?? now, ts_end: c.ts_end ?? now });
          if (personDir) {
            const thinkStream = path.join(personDir, "thinking.stream");
            const ts = new Date().toLocaleString("zh-CN", { hour12: false }); // 2026-09-13：本地时区（原硬编码 Asia/Shanghai，与 paths.localTime 的"本地时间唯一真相"冲突）
            appendFile(thinkStream, `\n[${ts}]\n${c.thinking}\n`);
          }
        } else if (c.type === "toolCall") {
          // 2026-09-22（trajectory 元数据）：toolCall 写时就带上 toolCallId，供 amem 把调用与其结果配对
          const tc: any = { role: "assistant", type: "toolCall", tool: { name: c.name, args: c.arguments }, ts_start: c.ts_start ?? now, ts_end: c.ts_end ?? now };
          if ((c as any).id) tc.toolCallId = (c as any).id;
          entries.push(tc);
        }
      }
    }

    // 2026-09-22（trajectory 元数据）：tool 结果条目统一补 toolName/toolCallId——不管内容走 string 还是 array 分支
    // （实测 toolResult 实际走 array 分支：content 是 block 数组；字符串分支只在旧格式命中）
    if (role === "toolResult" || role === "tool") {
      for (const e of entries) {
        if ((msg as any).toolName) e.toolName = (msg as any).toolName;
        if ((msg as any).toolCallId) e.toolCallId = (msg as any).toolCallId;
      }
    }

    if (entries.length === 0 && typeof msg.content === "string" && !msg.content.trim()) return;
    // amem 自身的工具结果（成功 "amem …" / 失败 "ERR: …" 都算）→ 下方压缩成 [memory op: …]，供 hash-lock 归一化识别
    const isAmemResult = (role === "toolResult" || role === "tool") && msg.toolName === "amem";

    // ── context 自噬去重：连续相同条目不重复写入 ──
    let lastSig = "";
    for (const e of entries) {
      const combinedText = e.content || e.text || e.think || "";

      // 坏帧隔离闸
      if (combinedText.includes("｜DSML｜")) {
        const t = new Date().toISOString();
        appendFile(path.join(personDir, "bad_cases.jsonl"), JSON.stringify({ ts: t, role: e.role, type: e.type, reason: "DSML/tools-template leak", raw: combinedText.slice(0, 20000) }) + "\n");
        // 2026-09-09 同步写（同 L325——context.md 记忆核心，归档 rename/强杀不丢）
        appendFileSync(path.join(personDir, "context.md"), JSON.stringify({ role: e.role, type: "bad_frame", content: i18n("[坏帧已隔离：DSML，没收进记忆；原文见 bad_cases.jsonl]", "[bad frame quarantined: DSML, not stored into memory; original in bad_cases.jsonl]"), ts: Date.now() }) + "\n");
        continue;
      }

      // amem tool calls: compress args for compact context recording
      if (e.type === "toolCall" && (e as any).tool?.name === "amem") {
        const a = (e as any).tool.args || {};
        const act = a.action || "manage";
        const phase = a.hash_key ? "apply" : "check";
        // 定位方式摘要（2026-09-13 L5：之前只记文本锚点，ts/时间范围/位置模式全记成 manage("","")，回看 context 不知道当时定位了什么）
        const loc = a.anchor_ts ? `ts=${a.anchor_ts}`
          : (a.ts_from || a.ts_to) ? `ts_range=${a.ts_from || ""}~${a.ts_to || ""}`
          : (a.anchor_begin_index != null) ? `idx=${a.anchor_begin_index}..${a.anchor_end_index}`
          : (a.anchor_begin || a.anchor_end) ? `${JSON.stringify(String(a.anchor_begin || "").slice(0, 50))},${JSON.stringify(String(a.anchor_end || "").slice(0, 50))}`
          : (a.exclude_tail != null) ? `exclude_tail=${a.exclude_tail}` : "";
        if (act === "manage") {
          const revInfo = a.revision != null ? `${String(a.revision).length}c` : phase;
          (e as any).tool = { name: "amem", compact: `manage(${loc}),rev(${revInfo})` };
        } else if (act === "fetch") {
          const f = a.id ? `id=${a.id}`
            : a.q ? `q=${JSON.stringify(String(a.q).slice(0, 30))}${a.review != null ? `,review=${a.review}` : ""}`
            : a.review != null ? `review=${a.review}` : "index";
          (e as any).tool = { name: "amem", compact: `fetch(${f})` };
        } else if (act === "sweep" || act === "archive") {
          const n = act === "archive" ? "archive" : "sweep";
          (e as any).tool = { name: "amem", compact: `${n}(${(a.types||[]).join(",")};${loc};${phase})` };
        } else if (act === "revert") {
          (e as any).tool = { name: "amem", compact: `revert(${a.id},${phase})` };
        } else if (act === "mark_enter") {
          (e as any).tool = { name: "amem", compact: "mark_enter" };
        } else if (act === "mark_exit") {
          (e as any).tool = { name: "amem", compact: `mark_exit(${a.id||""},${(a.info||"").length}c info)` };
        }
      }

      // Deep-sleep / memory-management tool outputs
      // amem 结果（按 toolName 识别，成功/ERR 都算）或旧记忆工具的已知前缀 → 压缩成 [memory op: ...]，
      // 保证 hash-lock 归一化（_amemCtxForHash 按 [memory op: 前缀过滤）能识别所有 amem 自身记录。
      // 2026-08-15 修复：实际写入 context.md 的 tool 结果 role 是 "toolResult"（不是 "tool"），
      // 原条件 e.role === "tool" 永远不匹配 → 压缩从未生效。这里同时匹配 tool / toolResult。
      if ((e.role === "tool" || e.role === "toolResult") && (isAmemResult || /^(Napped\.|Context edited|"dream|Slept|Deep sleep|Drinkcoffee|Dream sent|amem )/.test(combinedText.trim()))) {
        e.content = `[memory op: ${combinedText.slice(0, 80).replace(/\n/g, " ")}...]`;
        delete (e as any).text;
        delete (e as any).think;
      }

      // 单条上限 20KB — 超了截断保留首尾，避免 ls/工具输出撑爆 context.md
      const MAX_ENTRY = 20000;
      const raw = e.content || e.text || e.think || "";
      if (raw.length > MAX_ENTRY) {
        const truncated = raw.slice(0, MAX_ENTRY * 0.7) + "\n...[truncated " + raw.length + " → " + MAX_ENTRY + "]...\n" + raw.slice(-MAX_ENTRY * 0.2);
        if (e.content) e.content = truncated;
        else if (e.text) e.text = truncated;
        else if (e.think) e.think = truncated;
      }
      // 2026-09-13：toolCall 参数同样受单条上限约束——write/edit 大文件时 content 整份进 context.md，快照又不压缩 toolCall 行（实测单行最大 43KB）。
      // 注意 args 与 pi 消息里的 arguments 是同一个对象引用，必须浅拷贝后再截断，否则会改掉模型/会话里的真实参数。
      if (e.type === "toolCall" && (e as any).tool?.args && typeof (e as any).tool.args === "object") {
        const src = (e as any).tool.args; let changed = false; const args: any = { ...src };
        for (const k of Object.keys(args)) {
          const v = args[k];
          if (typeof v === "string" && v.length > MAX_ENTRY) { args[k] = v.slice(0, MAX_ENTRY * 0.7) + "\n...[truncated " + v.length + " → " + MAX_ENTRY + "]...\n" + v.slice(-MAX_ENTRY * 0.2); changed = true; }
        }
        if (changed) (e as any).tool = { ...(e as any).tool, args };
      }

      // 2026-09-23（blocktrace）：给每条 entry 打统一块 id——工具块复用 toolCallId，消息块自生成
      {
        const btKind: any = e.type === "toolCall" ? "toolCall"
          : (e.role === "toolResult" || e.role === "tool") ? "toolResult"
          : e.type === "think" ? "think"
          : e.role === "user" ? "user"
          : "assistant";
        const btTool = e.type === "toolCall" ? (e as any).tool?.name : (e.role === "toolResult" || e.role === "tool") ? (e as any).toolName : undefined;
        const tr = trackBlock({ kind: btKind, tool: btTool, toolCallId: (e as any).toolCallId, ts: (e as any).ts_start });
        (e as any).blockId = tr.id;
      }
      const jsonl = JSON.stringify(e) + "\n";
      // 连续去重：与上一条签名相同则跳过（防自噬膨胀）
      // toolCall 的内容在 tool 子对象里（tool.name + tool.args），不在 content/text/think 字段，
      // 必须显式取 tool.name 做去重前缀，否则所有 toolCall 的签名都是 "assistant|toolCall|" → 触发误报警。
      const toolName = (e as any).tool?.name || "";
      const sig = e.role + "|" + (e.type || "") + "|" + toolName + "|" + (e.content || e.text || e.think || "").slice(0, 200);
      if (sig === lastSig) continue;
      lastSig = sig;
      // 原始归档（完整历史，不清洗，模型不读）
        // 2026-09-13（审计 HIGH）：完整历史不能走 8MB 轮转——nerves 轮转会覆盖上一代，磁盘上已有 5 个 agent 的 .1 等着被下一次轮转销毁；这里传"永不轮转"
        appendFile(path.join(personDir, "context.archive.jsonl"), jsonl, Number.MAX_SAFE_INTEGER);
        // 2026-09-09（用户在意 bug：归档 rewrite context.md 后 nerves stream 池指向旧 inode → 后续 append 落孤儿文件 + 强杀不冲刷——11 分钟对话丢失实证）：context.md 必须同步写当前路径（appendFileSync 每次 open）——归档 rename 后不丢、被 SIGKILL 最多丢正在写的一行
        appendFileSync(path.join(personDir, "context.md"), scrubSecrets(jsonl));

      // ── Record structured event for event list ──
      if (e.role === "tool" || e.role === "assistant" || e.role === "user") {
        const eventPath = path.join(personDir, "events.jsonl");
        let evType = e.role === "user" ? "user_input" : e.role === "tool" ? "tool_result" : "assistant";
        let evTitle = "";
        let evPreview = combinedText.slice(0, 80).replace(/\n/g, " ");
        let evStrength = 0.3;
        if (e.role === "user") { evTitle = i18n("用户输入", "user input"); evStrength = 0.8; }
        else if (e.role === "tool") { evTitle = i18n("工具返回", "tool result"); evStrength = 0.5; }
        else if (e.type === "think") { evTitle = i18n("思考", "thinking"); evStrength = 0.1; }
        else { evTitle = i18n("助理输出", "assistant output"); evStrength = 0.2; }
        if (evTitle) {
          appendFile(eventPath, JSON.stringify({ type: evType, title: evTitle, preview: evPreview, strength: evStrength, ts: new Date().toISOString() }) + "\n");
        }
      }
    }
  });

  // ── tool_call: context 95%+ 强制 amem + 禁止直接写记忆文件 ─────
  const MEMORY_FILES = ["context.md"]; // 2026-09-23（用户：work_memory/neocortex/deep_cortex 已禁用）
  const AMEM_EXEMPT_TOOLS = new Set(["amem", "status", "wait", "hibernate", "intentions", "help"]); // 2026-09-13：core.CHR 教模型先 help amem 再用——95% 门禁里 help 也得放行
  pi.on("tool_call", async (event) => {
    if (getSessionRole() !== "main") return;

    // context >= 95% 时只允许 amem/status/wait/hibernate/intentions——其他工具一律拦截
    if (!AMEM_EXEMPT_TOOLS.has(event.toolName)) {
      try {
        // 2026-09-16（用户定稿）：去掉 est，只保留 api（活对话窗口 prompt_tokens）——活对话就是记忆，
        // 记忆文件体量估算（est）是垃圾（CJK×1.8 虚高且与实注入对不上），一律不用。
        const pid = personDir ? path.basename(personDir) : "";
        _refreshModelMax();
        const api = _pondSess.prevPrompt ? (_pondSess.prevPrompt / modelMax) * 100 : null;
        if (api !== null && api >= 95) {
          return { block: true, reason: i18n(
            `context 使用已达 ${api.toFixed(1)}%，必须先执行 amem archive 清理记忆再做其他操作。`,
            `Context usage at ${api.toFixed(1)}%, you must run amem archive to free memory before any other action.`
          ) };
        }
      } catch (e) { /* growth.jsonl 读取失败不阻塞 */ }
    }

    // 2026-09-13：bash 工具早已被 execute 取代（executes.ts 每轮剔除 bash）——记忆文件/基因目录的 shell 侧保护对 execute 从未生效
    if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash" && event.toolName !== "execute") return;

    // extract target path: write/edit use path/file_path; bash extracts from command
    let p: string = (event.input as any)?.path ?? (event.input as any)?.file_path ?? "";
    if (event.toolName === "bash" || event.toolName === "execute") {
      const cmd: string = (event.input as any)?.command ?? "";
      // match write redirections and destructive ops targeting memory files
      const m = cmd.match(/(?:>>?|>\||\bcat\s+>|\btee\s|\bcp\s+\S+\s+|\bmv\s+\S+\s+|\brm\s+(?:-f\s+)?|\btruncate\s+(?:-s\s+\S+\s+)?)['"]?([^\s'"&|;]+)/);
      if (m) p = m[1]!;
      else if (/\brm\b/.test(cmd)) {
        return { block: true, reason: i18n(`bash 含 rm 操作但无法确定目标路径。内存文件删除操作禁止。`, `bash contains rm but the target path cannot be determined. Deleting memory files is forbidden.`) };
      }
    }
    if (!p) return;

    // Gene file protection: spirit.bio.gene/ 禁止 agent 直接修改「基因内容」，必须通过 make 重建。
    // 基因内容 = promotor.dna / CHRs/*.CHR / rna.json / tools.manifest.json（被装配、被消费的声明与内容）。
    // polymerase.ts 是转录器代码（构建工具），不属于基因内容，允许编辑——改后必须跑转录验证 + make 部署。
    const resolved = path.resolve(p);
    const isInGene = resolved.includes("/spirit.bio.gene/") || resolved.endsWith("/spirit.bio.gene");
    const isTranspilerCode = resolved.endsWith("/spirit.bio.gene/polymerase.ts");
    if (isInGene && !isTranspilerCode) {
      return { block: true, reason: `Gene files (spirit.bio.gene/) are protected. Changes go through make, not direct edit.` };
    }

    if (!personDir) return;
    const base = p.split("/").pop() || "";
    if (MEMORY_FILES.includes(base)) {
      const abs = path.resolve(p);
      const pd = path.resolve(personDir);
      if (abs.startsWith(pd)) {
        return { block: true, reason: i18n(`记忆文件 ${base} 不允许直接修改。`, `Memory file ${base} cannot be modified directly.`) };
      }
    }
  });

  // ── session_shutdown: full context save + cost accumulate ──────────
  pi.on("session_shutdown", async () => {
    // Already covered by message_end incremental saves.
    // context.md already has full history.
    // Accumulate session costs into cost_total.json
    if (!personDir) return;
    try {
      const costTotalPath = monitorDataPath("cost_total.json");
      if (!costTotalPath) return; // 2026-09-09：全局未设（启动早期/小号）→ 不拼 undefined 路径（曾拉出 homedir 垃圾目录）
      const roles = ["main", "hippocampus", "metaconsciousness", "sleep"];
      let sessMain = 0, sessHippo = 0, sessSub = 0, sessSleeping = 0;
      for (const role of roles) {
        try {
          // 2026-09-13：cost-<role>.json 在 RuntimeCache/<id>/（footer 与 flushCost 同址），之前读 MemoryData/<id>/（从未有过这个文件）→ 累计永远 0
          const costPath = path.join(_runtimeCacheDir(path.basename(personDir)), `cost-${role}.json`);
          if (!fs.existsSync(costPath)) continue; // 该角色无消费记录（新 agent/未启用）——不存在不刷 ENOENT
          let d: any = null;
          try { d = JSON.parse(readFile(costPath)); } catch {  /* 竞态截断：按 0 计不刷（下次写入自动修复）*/ }
          if (role === "main") sessMain = d?.cost || 0;
          else if (role === "hippocampus") sessHippo = d?.cost || 0;
          else if (role === "metaconsciousness") sessSub = d?.cost || 0;
          else if (role === "sleep") sessSleeping = d?.cost || 0;
        } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
      }
      const sessTotal = sessMain + sessHippo + sessSub + sessSleeping;
      let total: any = { main: 0, hippocampus: 0, metaconsciousness: 0, sleep: 0, total: 0, sessions: 0 };
      // 2026-08-20 修复：costTotalPath（AgentFileData/../MonitorData/<id>/cost_total.json）目录通常不存在——
      // readFile 返回空串 → JSON.parse("") 每次 flush 报 Unexpected end（Unexpected end 刷屏的真正来源）——
      // 不存在跳过（与 cost-role 的 existsSync 同模式），截断用默认值
      try { if (fs.existsSync(costTotalPath)) total = JSON.parse(readFile(costTotalPath)); } catch {  /* 截断用默认值 */ }
      total.main = (total.main || 0) + sessMain;
      total.hippocampus = (total.hippocampus || 0) + sessHippo;
      total.metaconsciousness = (total.metaconsciousness || 0) + sessSub;
      total.sleep = (total.sleep || 0) + sessSleeping;
      total.total = (total.total || 0) + sessTotal;
      total.sessions = (total.sessions || 0) + 1;
      total.lastUpdated = new Date().toISOString();
      writeFile(costTotalPath, JSON.stringify(total, null, 2));

      // ── tokenmaxxed 累积（RSI-001，ISSUE 106 实时落盘版）──
      // 增量已在每轮 message_end 实时写入（flushTokenmaxxed），这里兜底 flush + sessions+1。
      // tokenmaxxed = Σ(usage.input + usage.output) 缓外 append-only（Fable 设计，ISSUE-098）
      try {
        flushTokenmaxxed(); // 兜底：正常情况 pond 已为 0（每轮已入账）
        const tokenmaxxedPath = path.join(personDir!, "tokenmaxxed.json");
        // 2026-08-15 写入规范化（防污染）：读时只提取白名单字段（tokenmaxxed/sessions/since/lastUpdated）
        let pond: any = { tokenmaxxed: 0, sessions: 0 };
        try {
          // 2026-08-20 修复：空/截断文件安全解析（同 flushTokenmaxxed——竞态截断用默认值不刷日志）
          let raw: any = null;
          try { raw = JSON.parse(readFile(tokenmaxxedPath) || "{}"); } catch {  /* 截断/损坏：用默认值 */ }
          pond = {
            tokenmaxxed: raw?.tokenmaxxed || 0,
            sessions: raw?.sessions || 0,
            since: raw?.since,
            lastUpdated: raw?.lastUpdated,
            prevPrompt: typeof raw?.prevPrompt === "number" ? raw.prevPrompt : null,
            prevOut: raw?.prevOut || 0,
          };
        } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        pond.sessions = (pond.sessions || 0) + 1;
        pond.lastUpdated = new Date().toISOString();
        writeFile(tokenmaxxedPath, JSON.stringify(pond, null, 2));
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
  });

  // ── Capacity thresholds ──────────────────────────────────────────
  const CAPACITY = {
    WARN: 0.60,  // 60% → internal feeling: 建议 nap
    URGE: 0.80,  // 80% → 强烈建议 sleep
    FORCE: 0.90, // 90% → 几乎强制
  };
  let drinkCoffeeTurns = 0; // remaining turns to suppress capacity warnings
  let dnaState: "wake" | "sleep" = "wake"; // current DNA state
  let lastContextSize = 0; // for growth rate tracking

  // estimateTokens 已提取到 paths.ts（唯一真相源），通过 #paths 导入

  // ── 模型窗口 ─────────────────────────────────────────────────────
  // 2026-09-11（prime-agent，ISSUE 147 顺带修）：原来只读 PI_MODEL_MAX_TOKENS —— 但全仓没有任何地方
  // 设置它，于是 modelMax 实际永远是兜底 1M：256K 本地模型也被当成 1M（保护区/容量阈值全按 1M 算）。
  // 现在优先用 live 模型的 contextWindow（与 status.ts 同源：__genshinGetModel()，TUI 注册），
  // 其次环境变量，最后 1M 兜底；并允许在每次调用时刷新（TUI 在扩展加载之后才注册该全局，加载时读不到）。
  let modelMax = 1000000;
  function _refreshModelMax(): void {
    let win = 0;
    try {
      const w = (globalThis as any).__genshinGetModel?.()?.contextWindow;
      if (typeof w === "number" && w > 0) win = w;
    } catch (e) { /* 取不到就用环境变量/兜底 */ }
    if (!win) win = parseInt(process.env.PI_MODEL_MAX_TOKENS || "") || 0;
    modelMax = win > 0 ? win : 1000000;
  }
  _refreshModelMax();
  let injectedWorkMemLen = 0; // 已注入对话的 work_memory 长度，之后只追加增量
  // 注：铁律【禁止 slice】——没有注入预算、没有切片函数。整份注入，容量靠 sleep/nap 控。

  // [DISABLED 2026-08-15] 主动裁切已禁用，由 amem 工具替代主动记忆管理。
  // function forceArchiveOldestContext(): string | null {
  //   if (!personDir || getSessionRole() !== "main") return null;
  //   const ctxPath = path.join(personDir, "context.md");
  //   const ctx = readFile(ctxPath);
  //   if (ctx.length < 4000) return null;
  //   let cut = Math.floor(ctx.length * 0.3);
  //   const nl = ctx.indexOf("\n", cut);
  //   if (nl > 0) cut = nl + 1;
  //   const oldest = ctx.slice(0, cut);
  //   writeFile(ctxPath, ctx.slice(cut));
  //   appendFile(path.join(personDir, "deep_cortex.md"), `\n\n--- 强制归档(超容量) ${new Date().toISOString()} ---\n${oldest}`);
  //   return `-${Math.round(oldest.length / 1024)}KB`;
  // }

  // 构建"记忆快照" = 稳定前缀。只在 session_start(醒来) 注入一次。
  // DNA + cortex + work_memory + context，【整份】，不切。
  // opts.excludeRowsSince：剔除 ts ≥ 该时刻的 JSONL 行（用于 context 事件里替换活窗口快照——本 session 的行已在对话里）
  function buildSnapshot(opts?: { excludeRowsSince?: number }): string {
    if (!personDir) return "";
    let dnaIndex = readFile(path.join(personDir, "dna/index.md"));
    if (!dnaIndex) {
      const personId = personDir.split("/").pop() ?? "unknown";
      let personName = personId;
      try {
        const plist = JSON.parse(readFile(path.join(memoryDataDir(), "plist.json")) || "[]");
        const entry = plist.find((p: any) => p.id === personId);
        if (entry?.name) personName = entry.name;
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
      dnaIndex = `# ${personName}\n\n你是 ${personName}，跑在 teyvat 持续运行框架里。\n你的记忆在 ${personDir}/，由系统自动注入上下文，不要手动去找或读这些文件。\n~/.pi_memory/ 是旧项目遗留，跟你无关，不要碰。`;
    }
    // 2026-09-23（用户：禁用垃圾——cortex/work_memory/dlc 文件不存在，全是空读；注入只认 DNA + context）
    // const stateDlc = readFile(path.join(personDir, `dna/${dnaState}.dlc`));
    // const cortex = readFile(path.join(personDir, "neocortex.md"));
    // const workMem = readFile(path.join(personDir, "work_memory.md"));
    let context = readFile(path.join(personDir, "context.md"));
    // 2026-09-24（用户定稿：context.md 就是 agent 全部当前上下文，amem 实时管理，不该有第二套快照压缩层）——
    // 原样注入，不再 toolResult 500字截断 / DSML 过滤 / 元数据剥离。
    // 2026-09-25：excludeRowsSince 恢复——它**不是**第二套压缩：只跳过"还留在活对话里的本 turn 行"，
    // 避免同一批内容既进快照又留在活窗口（重复注入 = 白烧 token + 模型看到重影）。除 ts 判定外不改写任何内容。
    if (opts?.excludeRowsSince) {
      const _cut = opts.excludeRowsSince;
      context = context.split("\n").filter((line: string) => {
        const t = line.trim();
        if (!t.startsWith("{")) return true;
        try {
          const o = JSON.parse(t);
          const ts = typeof o?.ts_start === "number" ? o.ts_start : (typeof o?.ts === "number" ? o.ts : 0);
          return !(ts >= _cut);
        } catch { return true; }
      }).join("\n");
    }

    // 默认【整份注入】(守"不切")；context 原样全量。
    // 2026-09-16（用户：禁用垃圾管线——静默 70% 截断切最旧记忆 = 隐性遗忘，且 snapshot_trim.jsonl 从不存在即从未触发。逐行注释禁用，不是删除）
    // let trimmed = false;
    // const SAFE = Math.round(modelMax * 0.70); // 留 30% 给对话+补全
    // const ctxBudget = SAFE - estimateTokens(dnaIndex) - estimateTokens(stateDlc) - estimateTokens(cortex) - estimateTokens(workMem);
    // if (ctxBudget <= 0) {
    //   context = "";
    //   trimmed = true;
    // } else if (estimateTokens(context) > ctxBudget) {
    //   const beforeLen = context.length;
    //   let lo = 0, hi = context.length;
    //   while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (estimateTokens(context.slice(-mid)) <= ctxBudget) lo = mid; else hi = mid - 1; }
    //   context = context.slice(-lo);
    //   trimmed = true;
    //   try {
    //     monitorAppend("snapshot_trim.jsonl",
    //       JSON.stringify({ ts: new Date().toISOString(), event: "snapshot_trim", dropped: beforeLen - context.length, kept: context.length }) + "\n");
    //   } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    // }
    const parts: string[] = [];
    if (dnaIndex) parts.push(dnaIndex);
    // if (stateDlc) parts.push(stateDlc);
    // 注入消息类型参考表（从 prompts.json 的 dnA.core.typeRef 读取）
    const typeRef = getPrompt("core.typeRef");
    if (typeRef) parts.push(typeRef);
    // if (cortex) parts.push(`[MEMORY — Cortex (long-term)]\n${cortex}`);
    // if (workMem) parts.push(`[MEMORY — Work Memory]\n${workMem}`);
    if (context) parts.push(`[MEMORY — Context]\n${context}`);
    return parts.join("\n\n");
  }

  // ── before_agent_start: 绝不改 systemPrompt(前缀)！只做"增量追加 + 容量提醒 + 后台整理" ──
  // 缓存铁律：前缀每轮一致才命中。记忆快照已在 session_start 注入一次；这里一律往「后面」append 消息。
  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!personDir) return;
    _refreshModelMax(); // 2026-09-13：扩展加载时 __genshinGetModel 尚未注册，modelMax 是 1M 兜底——首轮/切模型后不刷新会把 200k 模型按 1M 算（ratio 偏小 5 倍）
    // 2026-09-24（用户：余额预警 + 自动恢复，复用共享缓存不垃圾轮询）——
    // 60s 节流，用 __genshinCheckBalanceShared（本机共享缓存，谁过期谁 fetch），
    // 余额 < 阈值 → 预警（只对 working，不打扰 wait/hibernate）；恢复 → 告知。
    const _nowB = Date.now();
    if (_nowB - ((globalThis as any).__genshinLastBalanceCheck || 0) > 60000) {
      (globalThis as any).__genshinLastBalanceCheck = _nowB;
      if ((globalThis as any).__genshinGetModel?.()?.provider === "deepseek") {
        void (globalThis as any).__genshinCheckBalanceShared?.().then((r: any) => {
          try {
            if (!r || r.unavailable) return;
            const warnCny = Number(process.env.GENSHIN_BALANCE_WARN_CNY || (globalThis as any).__genshinBalanceWarnCny || 10);
            const low = !r.is_available || Number(r.total_balance) < warnCny;
            const wasLow = !!(globalThis as any).__genshinBalanceLow;
            (globalThis as any).__genshinBalanceLow = low;
            // 只对 working 状态打扰（wait/hibernate 不打扰——用户 2026-09-24 定稿）
            if ((globalThis as any).__genshinHeartState !== "working") return;
            if (low && !wasLow) {
              sendCustomMessage(pi, "memory-reminder", i18n(`⚠️ 余额不足：DeepSeek 余额 ${r.total_balance} ${r.currency}（< ${warnCny} 元），建议暂停或充值，避免撞 402。`, `⚠️ Low balance: DeepSeek ${r.total_balance} ${r.currency} (< ${warnCny} CNY), suggest pausing or topping up to avoid 402.`));
            } else if (!low && wasLow) {
              sendCustomMessage(pi, "memory-reminder", i18n(`✅ 余额已恢复：DeepSeek 余额 ${r.total_balance} ${r.currency}，继续。`, `✅ Balance restored: DeepSeek ${r.total_balance} ${r.currency}, continuing.`));
            }
          } catch (e) { /* 预警失败静默 */ }
        }).catch(() => {});
      }
    }
    // 2026-09-24（用户：电量预警 <10%，只支持 macbook/win）——60s 节流探测，< 阈值且不充电 → 预警（只对 working）。
    if (_nowB - ((globalThis as any).__genshinLastBatteryCheck || 0) > 60000) {
      (globalThis as any).__genshinLastBatteryCheck = _nowB;
      void (globalThis as any).__genshinCheckBattery?.().then((b: any) => {
        try {
          if (!b?.available || b.percent == null) return;
          const warnPct = Number(process.env.GENSHIN_BATTERY_WARN_PCT || 10);
          const low = b.percent < warnPct && !b.charging;
          const wasLow = !!(globalThis as any).__genshinBatteryLow;
          (globalThis as any).__genshinBatteryLow = low;
          if ((globalThis as any).__genshinHeartState !== "working") return;
          if (low && !wasLow) {
            sendCustomMessage(pi, "memory-reminder", i18n(`⚠️ 电量不足：${b.percent}%（< ${warnPct}%），建议充电。`, `⚠️ Low battery: ${b.percent}% (< ${warnPct}%), suggest charging.`));
          } else if (!low && wasLow) {
            sendCustomMessage(pi, "memory-reminder", i18n(`✅ 电量已恢复：${b.percent}%，继续。`, `✅ Battery restored: ${b.percent}%, continuing.`));
          }
        } catch (e) { /* 预警失败静默 */ }
      }).catch(() => {});
    }
    const context = readFile(path.join(personDir, "context.md"));
    // const workMem = readFile(path.join(personDir, "work_memory.md"));
    // const cortex = readFile(path.join(personDir, "neocortex.md"));

    // 0) 漏意识修复 —— 2026-09-23 禁用（sleep 机制已废 + frozen 机制已砍，整段死代码）
    // const ctxNow2 = readFile(path.join(personDir, "context.md"));
    // const metaPath2 = (global.__genshinChannelDir || personDir.replace("MemoryData", "RuntimeCache")) + "/snapshot.frozen.meta.json";
    // let meta2 = { ctxLen: 0, wmLen: 0 };
    // try { meta2 = { ...meta2, ...JSON.parse(readFile(metaPath2) || "{}") }; } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + (e?.message || e)); }
    // if (ctxNow2.length < meta2.ctxLen) {
    //   const frozenPath = (global.__genshinChannelDir || personDir.replace("MemoryData", "RuntimeCache")) + "/snapshot.frozen.txt";
    //   const fresh = buildSnapshot();
    //   writeFile(frozenPath, fresh);
    //   writeFile(metaPath2, JSON.stringify({ ctxLen: ctxNow2.length, wmLen: 0 }));
    //   if (getSessionRole() === "main") {
    //     if (_snapshotInjected) _snapshotOverride = buildSnapshot({ excludeRowsSince: _sessionStartTs });
    //     else { sendCustomMessage(pi, "memory-snapshot", fresh); _snapshotInjected = true; _snapshotOverride = null; }
    //   }
    // }

    // 1) work_memory 增量 — 只跟踪长度用于 snapshot 重冻结判断，不注入 context。
    //    海马体编码已在 context.md 中，sleep 时自然done；实时注入会造成污染。
    // 1) work_memory 增量 —— 2026-09-23 禁用（work_memory.md 不存在，空文件）
    // if (workMem.length > injectedWorkMemLen) {
    //   injectedWorkMemLen = workMem.length;
    // }

    // 2) 容量提醒。默认整份注入；**teyvat 侧无任何静默兜底**——原「超窗口切最旧」2026-09-16 已按定稿禁用（见下方 736-751 行，静默截断 = 隐性遗忘）。
    //    2026-09-25 去掉 toolResult 500 字压缩后，注入体积 = context.md 实际体积（此前 toolResult 被隐式压缩、意外充当了体积阀门）。
    //    ⚠️ 待决：context.md 体积真超窗口时无自动降级，靠 URGE/FORCE 容量提醒驱动 amem 主动整理；是否要加「显式可见的救命降级」待用户定夺。
    //    所以高占用 = "最旧记忆正在被丢"，该 sleep 把它编码走（不是会崩，是会丢）。
    // 2026-09-25（用户定稿：est 是垃圾——全部清理，只保留 api 真实值；ctx 口径 2026-09-24 已删）：
    // 原 est 残留（dna 空读 + estimateTokens 估算 + usageRatio/rawPct）已删——全仓无消费者，growth.jsonl 只写 api 口径。
    const _apiTokNow = _pondSess.prevPrompt ?? 0;
    monitorAppend("growth.jsonl",
      JSON.stringify({ ts: new Date().toISOString(), bytes: context.length, api_tokens: _apiTokNow, api_ratio: _apiTokNow ? +((_apiTokNow / modelMax) * 100).toFixed(1) : null }) + "\n");
    // 2026-09-12：gauge 唯一写入者是 message_end（API prompt 真值）。
    // before_agent_start 和 _refreshGaugeAfterContextChange 都不写——避免多写入者口径打架导致跳变。
    // 容量提醒——只在达到 URGE(80%) 真危险时发（用户反馈：这条是垃圾，
    // 1) 清理后屏幕上还留着清理前的旧快照（过期数据） 2) 每次 amem 后用户说话就冒出来。
    // 修：阈值提到 80%；带时间戳（明确是快照不是当前值）；feed:false 不喂模型（模型自主管理）。
    // 2026-08-15 再修：不要每 1% 都发（80/81/82…堆积，queue 里一堆旧消息清理后还显示）——
    // 同一提醒周期（>=80% 连续期间）只发一条，回落 <80% 清除，下次再达 80% 才重新提醒。
    const fmtTok = (n: number) => n < 1000 ? n + "" : n < 1e6 ? (n / 1000).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
    const capTs = _fmtLocalTs(Date.now()).slice(6, 14); // HH:MM:SS（本地时区）
    // 2026-09-12（ISSUE 203）：显示改用 API 真实值（_pondSess.prevPrompt = input+cacheRead，与 gauge/footer 同源）。
    const _apiTok = _pondSess.prevPrompt ?? 0;
    // 2026-09-16 + 2026-09-25（用户定稿）：est 是垃圾——全部清理，只保留 api 真实值（唯一口径）。
    let capacityLine = _apiTok > 0
      ? `context ${fmtTok(_apiTok)} tokens / ${fmtTok(modelMax)} (api@${capTs})`
      : "context 待首轮请求";
    // 2026-09-16（用户定稿）：去掉 est——记忆/amem 判断也只用 api（活对话窗口 = 记忆，唯一口径）
    const _apiRatio = _apiTok > 0 ? _apiTok / modelMax : 0;
    if (_apiRatio >= CAPACITY.FORCE) capacityLine += i18n(" — 立即用 amem 整理", " — use amem immediately");
    else if (_apiRatio >= CAPACITY.URGE) capacityLine += i18n(" — 建议 amem 整理", " — consider amem cleanup");
    if (_apiRatio >= CAPACITY.URGE) {
      if (_lastCapacityUrge === 0) {
        _lastCapacityUrge = 1; // 2026-09-25：est 已删——去重标记不再借用 rawPct（只需一个非零值表示「本周期已提醒」）
        sendCustomMessage(pi, "memory-capacity", capacityLine);
      }
    } else {
      _lastCapacityUrge = 0; // 回落 <80% 清除——下次再达 80% 才重新提醒
    }

    // [DISABLED 2026-08-15] 主动强制睡眠已禁用，由 amem 工具替代主动记忆管理。
    // if (usageRatio >= 0.90) triggerSleeping(`记忆 ${rawPct}% ≥ 90%`).catch(() => {});

    // 2.5) [2026-09-13 移除] 原"context 缩水 → 重建快照 + 原地改 __genshinAgentSession 的 messages / fallback 追加"段：
    //   上面第 0 段已把 meta 更新，本段条件永远不成立（死代码）；且原地改私有 state 是未文档化路径，headless 模式下没有 TUI 设的全局。
    //   快照替换现在统一由第 0 段 + pi 的 context 事件（_snapshotOverride）完成——这是 pi 提供的正式改写入口。

    // [DISABLED 2026-08-15] cortex 自动沉降已禁用，由 amem 工具替代主动记忆管理。
    // if (estimateTokens(cortex) > Math.round(modelMax * 0.20)) {
    //   const cut = Math.floor(cortex.length * 0.3);
    //   writeFile(path.join(personDir, "neocortex.md"), cortex.slice(cut));
    //   appendFile(path.join(personDir, "deep_cortex.md"), `\n\n--- Sedimented ${new Date().toISOString()} ---\n${cortex.slice(0, cut)}`);
    // }

    // 4) events 自动修剪（防无限增长；不再每轮把事件列表注入前缀）
    const eventPath = path.join(personDir, "events.jsonl");
    const eventRaw = readFile(eventPath);
    if (eventRaw) {
      const lines = eventRaw.trim().split("\n");
      // 2026-09-13：修剪必须原地写（同 inode）。之前用 writeFile（tmp+rename）——而追加走 nerves 流池（进程启动时 open 的 WriteStream），
      // rename 后流仍指向旧 inode → 第一次修剪之后所有事件都写进孤儿文件，文件里再也不会有新事件（ISSUE 152 同类根因，当时只修了 context.md）。
      if (lines.length > 300) { try { fs.writeFileSync(eventPath, lines.slice(-200).join("\n") + "\n", "utf-8"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] events trim: " + ((e as any)?.message || e)); } }
    }

    // 5) 到期提醒 → 追加一条消息（时间敏感，append 不破缓存）
    try {
      const remindersRaw = readFile(path.join(personDir, "reminders.json"));
      if (remindersRaw) {
        const reminders = JSON.parse(remindersRaw) as any[];
        const now = Date.now();
        const overdue = reminders.filter((r: any) => !r.completed && r.dueAt && r.dueAt <= now).slice(0, 3);
        if (overdue.length) sendCustomMessage(pi, "memory-reminder", i18n(`到期: ${overdue.map((r: any) => r.title).join("; ")}`, `Due: ${overdue.map((r: any) => r.title).join("; ")}`));
      }
    } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }

    // 没有 return → 不碰 systemPrompt → 前缀稳定 → KV 缓存每轮命中。
  });

  // /context command 已迁移到 god.tui/commands/context.ts

  /* [2026-08-15 DISABLED] editcontext 临时注释（用户指示：先不用了），保留代码以便恢复
  // ── editcontext tool (dev only) ──────────────────────────
  if (process.env.PI_DEV) {
  // ── editcontext tool ─────────────────────────────────────────────
  registerPaimonTool({
    name: "editcontext",
    label: "Edit Context",
    messageDescription:
      "Edit your own context and simultaneously add to long-term cortex memory. " +
      "DUAL operation — BOTH context_edit AND cortex_entry are REQUIRED (cortex_entry must be non-empty). " +
      "One cannot happen without the other. After editing, the updated context is re-sent to the API.",
    promptSnippet: "Edit context + add to cortex (dual op — both required)",
    renderCall(_args: any, theme: any) {
      return renderToolCall.label(theme, "Edit Context");
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const content = resultContent(result);
      return renderMessage.summary(theme, ctx, content?.[0]?.text);
    },
    parameters: Type.Object({
      context_edit: Type.Object({
        oldText: Type.String({ messageDescription: "Exact text to replace in context" }),
        newText: Type.String({ messageDescription: "Replacement text" }),
      }),
      cortex_entry: Type.String({ messageDescription: "Text to append to cortex memory (MUST be non-empty — this is a dual operation)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!personDir) {
        return {
          content: [{ type: "text", text: i18n("ERR: 未找到 person 目录。记忆需要基于 person 的 session。", "ERR: No person directory found. Memory requires a person-based session.") }],
          details: {},
          isError: true,
        };
      }

      // DUAL OPERATION: both required
      if (!params.cortex_entry || !params.cortex_entry.trim()) {
        return {
          content: [{ type: "text", text: i18n("ERR: 双重操作: cortex_entry 不能为空。editcontext 需要同时提供 context 编辑和 cortex 条目。", "ERR: DUAL OPERATION: cortex_entry must be non-empty. editcontext requires BOTH a context edit AND a cortex entry. Cannot proceed.") }],
          details: {},
          isError: true,
        };
      }

      const contextPath = path.join(personDir, "context.md");
      const cortexPath = path.join(personDir, "neocortex.md");
      const workPath = path.join(personDir, "work_memory.md");

      // 1. Edit context
      const oldCtx = readFile(contextPath);
      if (!oldCtx.includes(params.context_edit.oldText)) {
        return {
          content: [{ type: "text", text: i18n("ERR: 在 context 中未找到 oldText。Context 未变更。", "ERR: oldText not found in context. Context unchanged.") }],
          details: {},
          isError: true,
        };
      }
      const newCtx = oldCtx.replace(params.context_edit.oldText, params.context_edit.newText);
      writeFile(contextPath, newCtx);

      // 2. Append to cortex (dual: always runs — validated non-empty above)
      const ts = new Date().toISOString();
      const cortexEntry = `\n\n[${ts}]\n${params.cortex_entry.trim()}\n`;
      appendFile(cortexPath, cortexEntry);

      // 3. Gather all blocks for return
      const ctxAfter = readFile(contextPath);
      const workMem = readFile(workPath);
      const cortex = readFile(cortexPath);

      // 2026-09-16（用户定稿）：est 是垃圾——只留 chars（准确），不显示 ~estimateTokens 估算
      const stats = [
        `context: ${ctxAfter.length} chars`,
        `work_memory: ${workMem.length} chars`,
        `cortex: ${cortex.length} chars`,
      ].join("\n");

      return {
        content: [{
          type: "text",
          text: `Context edited + cortex appended (dual operation complete).\n\n${stats}\n\nUpdated context:\n${ctxAfter.slice(-5000)}`,
        }],
        details: {
          contextLength: ctxAfter.length,
          cortexLength: readFile(cortexPath).length,
          stats,
        },
      };
    },
  });
  } // end PI_DEV
  */

  // ── amem tool（主动记忆管理）─────────────────────────────────────
  // 文档: B.docs/Dev.Common/Wiki/Amem(Brain Tool).WIKI
  // action: manage / archive（sweep 旧名）/ fetch / revert / mark_enter / mark_exit
  // 所有修改操作强制两步：check(→hash_key) → apply(hash_key)
  // 最近 100K token 保护区：禁止编辑尾部内容，保护缓存和当前工作相关性

  // ── Hash-lock ──
  // 2026-09-16（用户）：amem 工具已分离到 ./memory-amem.ts（原 L938-2110 整段搬移 + 依赖注入）——
  registerAmemTool(pi, {
    personDir: () => personDir,
    modelMax: () => modelMax,
    pondSess: _pondSess,
    refreshModelMax: _refreshModelMax,
    refreshGauge: _refreshGaugeAfterContextChange,
  });


  // [2026-08-15] full_reboot 已移入 execute 工具作为特殊命令（execute({command:"full-reboot 原因"})）
  // 不再是独立工具。授权机制：/a full-reboot → RuntimeCache/full-reboot-auth → execute 拦截 → wake-restart → exit

  /* [2026-08-15 DISABLED] nap 临时注释（用户指示：目前没用了），保留代码以便恢复
  // ── nap tool ─────────────────────────────────────────────────────
  // 午睡十分钟：启动独立 genshin 实例，把过量 context 编码进 work_memory，然后裁剪。
  let napHandle: { stop: () => void; isRunning: () => boolean } | null = null;

  registerPaimonTool({
    name: "nap",
    label: "Nap",
    feedResult: false,
    messageDescription:
      "Launch a quick nap session to encode overflowing context into work_memory and trim. " +
      "Like a 10-minute power nap — lightweight, fast.",
    promptSnippet: "Nap: trim context up to hippocampus offset",
    renderCall(_args: any, theme: any) {
      return renderToolCall.label(theme, "Nap");
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const content = resultContent(result);
      const text = content?.[0]?.text || "";
      return renderMessage.summary(theme, ctx, text);
    },
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!personDir || getSessionRole() !== "main") {
        return { content: [{ type: "text", text: i18n("ERR: 只有主 session 可以 nap。", "ERR: Only the main session can nap.") }], details: {}, isError: true };
      }
      if (napHandle?.isRunning?.()) {
        return { content: [{ type: "text", text: "nap 已在运行中。" }], details: {}, isError: true };
      }

      const personId = path.basename(personDir);
      const tmuxName = `nav-${personId}`;
      const sessionDir = path.join(sessionDirFor(personId), "NapSessions");

      // Build nap prompt
      await fs.promises.mkdir(sessionDir, { recursive: true });
      const napPrompt = `你是海马体的午睡实例。主意识的原始对话堆积了（43%+），海马体后台编码跟不上。你需要快速做两件事。

【文件目录】${personDir}

【第一步：context → work_memory】
1. 读 context.md，从 hc-offset 往前找还没编码的最旧 300~500 行
2. 编码进 work_memory.md：结构化、按主题分段、保留关键对话和决策
3. 这是最大的瓶颈——海马体后台太慢，你要帮它追赶

【第二步：work_memory → neocortex】
4. 读 work_memory.md，把已定论的内容巩固进 neocortex.md
5. 按主题合并、保留具体事实和时间线
6. 清空 work_memory 里已迁移的部分

【第三步：裁剪】
7. 把已编码的 context 头部删掉，更新 hc-offset
8. hibernate

【编码要求】
- 不要 copy-paste。消化、合并、重组。
- 保留具体内容：文件名、决策、时间线。不要抽象成"教训"。
- 同一个主题的多次对话合并为一条。

做完一段就 hibernate，别贪多。`;

      const promptFile = path.join(personDir, "nap-prompt.md");
      writeFile(promptFile, napPrompt);

      const launchScript = path.join(personDir, "nap-launch.sh");
      writeFile(launchScript, `#!/bin/bash
set -e
export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--no-inspect --experimental-transform-types"
PERSON_DIR=${JSON.stringify(personDir)}
SESSION_DIR=${JSON.stringify(sessionDir)}
PROMPT_FILE=${JSON.stringify(promptFile)}

# 读 hc-offset，只编码海马体已经处理过的部分
mkdir -p "$SESSION_DIR"

# Write conv.json for pi to read the nap prompt
NODE_SCRIPT="
const fs = require('fs');
const h = require('os').homedir();
const conv = JSON.stringify([{role:'user',content:fs.readFileSync(\"$PROMPT_FILE\",'utf8')}]);
fs.writeFileSync(\"$SESSION_DIR/conv.json\", conv);
// 清空 hc-offset，nap 自己从头编码
fs.writeFileSync(\"$PERSON_DIR/hc-offset\", '0');
console.log('nap ready');
"
node -e "$NODE_SCRIPT"

# 启动 nap pi
cd "$PERSON_DIR/../.."
while true; do
  START=\$(date +%s)
  
  LOCKDIR="$PERSON_DIR/memory-lock"
  LOCK_WAIT=0
  while [ "$LOCK_WAIT" -lt 120 ]; do
    if mkdir "$LOCKDIR" 2>/dev/null; then
      echo "{\"owner\":\"nav\",\"ts\":\$(date +%s)000}" > "$LOCKDIR/stamp" 2>/dev/null
      break
    fi
    LOCK_WAIT=\$((LOCK_WAIT + 2))
    sleep 2
  done

  timeout 120 pi -s "$SESSION_DIR" -k coding-agent --name "nap-\$(date +%H%M)" --append-system-prompt "$(cat $PROMPT_FILE)" 2>/dev/null || echo "[nap] pi launch failed (non-fatal)" >&2

  rm -rf "$LOCKDIR" 2>/dev/null
  
  ELAPSED=\$(( \$(date +%s) - START ))
  [ "$ELAPSED" -lt 10 ] && sleep 5
  
  # Check if context is small enough
  CTX_SIZE=\$(wc -c < "$PERSON_DIR/context.md" 2>/dev/null || echo 0)
  [ "$CTX_SIZE" -lt 5000 ] && break
  
  # Or check if work_memory is big enough
  WM_SIZE=\$(wc -c < "$PERSON_DIR/work_memory.md" 2>/dev/null || echo 0)
  CTX_SIZE=\$(wc -c < "$PERSON_DIR/context.md" 2>/dev/null || echo 0)
  [ "$WM_SIZE" -gt 10240 ] && break
  [ "$CTX_SIZE" -lt 5120 ] && break
  
  sleep 2
done
# Trim context: only keep what hippocampus has encoded
CTX=\$(cat "$PERSON_DIR/context.md" 2>/dev/null || echo "")
OFFSET=0
try { OFFSET = parseInt(require('fs').readFileSync('$PERSON_DIR/hc-offset','utf8').trim()) || 0; } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
if [ "$OFFSET" -gt 100 ] && [ \${#CTX} -gt 500 ]; then
  CUT=\$(( OFFSET < \${#CTX} - 500 ? OFFSET : \${#CTX} - 500 ))
  echo "\${CTX:\$CUT}" > "$PERSON_DIR/context.md"
  echo "0" > "$PERSON_DIR/hc-offset"
fi
echo "[nav] done"
`);

      try { execSync(`chmod +x ${launchScript}`); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }

      // Kill old nap if exists
      try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }

      // Launch in tmux
      execSync(`tmux new-session -d -s ${tmuxName} bash ${launchScript}`);

      napHandle = {
        stop: () => { try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); } },
        isRunning: () => { try { execSync(`tmux has-session -t ${tmuxName} 2>/dev/null`); return true; } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); return false; } },
      };

      return {
        content: [{ type: "text", text: `nap session 已启动 (tmux ${tmuxName})。正在编码 context → work_memory，完成后自动裁剪。` }],
        details: {},
      };
    },
  });
  */


  // ── sleep tool (独立睡眠实例) ──────────────────────────────────
  // ARCHITECTURE IRON LAW (DNA): sleep 必须是独立 genshin 实例, 不是主循环工具
  // 主意识调用 sleep → 启动 sl-<personId> tmux 实例 (sleep.dlc) → 主意识 hibernate
  // 睡眠实例对标海马体(hc)和元意识(sc), 是第三个对等的独立意识
  let sleepHandle: { stop: () => void; isRunning: () => boolean } | null = null;

  // ── 启动一次深度睡眠（统一入口）──────────────────────────────────────────────
  // 可复用：sleep 工具、记忆≥90%、API 返回 400 都调它。这就是"太困强制睡着"。
  // 安全：已经在睡就不重复启；只主进程睡。睡完发 sleep-done 唤醒主意识(心脏会重新点亮 continuous)。
  async function triggerSleeping(reason: string): Promise<boolean> {
    // sleep 暂时禁用
    return false;
  }

  // [DISABLED 2026-08-15] API 400 强制睡眠已禁用，由 amem 工具替代。
  // pi.on("after_provider_response", async (event: any) => {
  //   if (event?.status !== 400 || !personDir || getSessionRole() !== "main") return;
  //   const ctxTok = estimateTokens(readFile(path.join(personDir, "context.md")));
  //   if (ctxTok < modelMax * 0.6) return;
  //   triggerSleeping(`API 400 + context ~${ctxTok}tok → 溢出，太困强制睡着`).catch(() => {});
  // });

  registerPaimonTool({
    name: "sleep",
    label: "Sleeping (Deep)",
    messageDescription:
      "DEPRECATED — always returns an error. Memory consolidation is done with amem archive.",
    promptSnippet: "Sleep (deprecated, returns error) — use amem archive",
    renderCall(_args: any, theme: any) {
      return renderToolCall.label(theme, "Sleep");
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const content = resultContent(result);
      return renderMessage.summary(theme, ctx, content?.[0]?.text);
    },
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: i18n("Sleep 不可用（已废弃）。记忆整理请用 amem archive。", "Sleep is deprecated. Use amem archive for memory consolidation.") }],
        details: {},
        isError: true,
      };
    },
  });

  // [abandon] dream + drinkcoffee 已废弃
  /*
  // ── dream tool (浅睡: 做梦 — 元意识对 cortex 做创造性反思) ────
  // Dreaming: the model selects a cortex snippet for the metaconsciousness to reflect on.
  // The metaconsciousness reads it, does creative association, and sends aware messages back.
  // Results are written to cortex by the main session (via editcontext).
  pi.registerTool({
    name: "dream",
    label: "Dream (Shallow Sleeping)",
    messageDescription:
      "Trigger shallow sleep dreaming. Pick a snippet from cortex for the metaconsciousness to creatively reflect on. " +
      "The metaconsciousness will do free association, find hidden connections, generate scenarios. " +
      "Results arrive as aware messages — write good insights to cortex via editcontext.",
    promptSnippet: "Dream: send cortex snippet to metaconsciousness for creative reflection",
    parameters: Type.Object({
      cortex_snippet: Type.String({ messageDescription: "A chunk from cortex (.md) to reflect on. Can span multiple topics for cross-domain connection." }),
      dream_prompt: Type.Optional(Type.String({ messageDescription: "Optional guidance for the dream (e.g., 'connect this to code architecture', 'generate a metaphor')" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!personDir) {
        return {
          content: [{ type: "text", text: "Error: No person directory found." }],
          details: {},
          isError: true,
        };
      }

      const feedPath = path.join(personDir, "conscious-feed.jsonl");
      const dreamEntry = JSON.stringify({
        type: "dream",
        ts: Date.now(),
        snippet: params.cortex_snippet.slice(0, 5000),
        prompt: params.dream_prompt ?? "",
      }) + "\n";

      try {
        fs.appendFile(feedPath, dreamEntry, "utf-8", () => {});
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: Failed to write dream to feed: ${err.message}` }],
          details: {},
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: `Dream sent to metaconsciousness.\n` +
                `Snippet length: ${params.cortex_snippet.length} chars.\n` +
                `Prompt: ${params.dream_prompt || "(free association)"}\n\n` +
                `The metaconsciousness will reflect and may send aware messages with insights. ` +
                `Good insights can be written to cortex via editcontext.`,
        }],
        details: { snippetLen: params.cortex_snippet.length },
      };
    },
  });
  pi.registerTool({
    name: "drinkcoffee",
    label: "Drink Coffee",
    messageDescription:
      "Temporarily suppress capacity warnings (the 'tired' feeling). " +
      "Like caffeine — does NOT increase memory capacity, just lets you push through. " +
      "Turns: how many turns to suppress (default 5). Use when you're near capacity but need to finish something critical.",
    promptSnippet: "Drinkcoffee: suppress capacity warnings for N turns",
    parameters: Type.Object({
      turns: Type.Optional(Type.Number({ messageDescription: "How many turns to suppress warnings (default 5, max 20)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const t = Math.min(Math.max(params.turns ?? 5, 1), 20);
      drinkCoffeeTurns += t;
      return {
        content: [{
          type: "text",
          text: `Drinkcoffee! Capacity warnings suppressed for ${t} turns (total remaining: ${drinkCoffeeTurns}). This does NOT increase memory — just delays the warning.`,
        }],
        details: { remainingTurns: drinkCoffeeTurns },
      };
    },
  });
  */

}
