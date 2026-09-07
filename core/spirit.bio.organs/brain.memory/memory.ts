// 文档: B.docs/Dev.Common/Wiki/Memory(Organ).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { getSessionRole, getPrompt } from "#kernel_ribosome";
import { memoryDir,  personDataDir as _personDataDir, memoryDataDir, sessionDirFor } from "#paths";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { logerr } from "#paths";
import { appendAsync } from "#kernel_nerves";
import { i18n } from "#tui_localizations";

function getPersonDir(sessionFile: string | undefined): string | null {
  const envDir = process.env.PI_PERSON_DIR;
  if (envDir) return envDir;
  const dir = _personDataDir(sessionFile);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readFile(p: string): string {
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

function appendFile(p: string, text: string): void {
  appendAsync(p, text);
}

function writeFile(p: string, text: string): void {
  // 2026-08-20 原子写（tmp + rename）：防重启时新旧进程交替读到半截文件（Unexpected end of JSON input 竞态根因）
  try { const tmp = p + ".tmp-" + process.pid; fs.writeFileSync(tmp, text, "utf-8"); fs.renameSync(tmp, p); } catch (e) { try { const d = path.dirname(_errLogPath(p)); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(_errLogPath(p), `[${new Date().toISOString()}] [memory] writeFile ${p}: ${e}\n`); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); } }
}

// 机密脱敏：把 sshpass 密码、sk- 风格 API key、Bearer token 的【值】盖成 [REDACTED]，只留结构。
// 不是删——保留"这里有个密码"的痕迹，只抹掉值。幂等(已脱敏的再跑结果不变)。
function scrubSecrets(s: string): string {
  if (!s) return s;
  return s
    .replace(/(sshpass\s+-p\s*)(["']?)([^\s"']+)\2/g, "$1$2[REDACTED]$2")
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
        try { raw = JSON.parse(readFile(tokenmaxxedPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); /* 截断/损坏：用默认值，不刷日志 */ }
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
      const prompt = (u.input || 0) + (u.cacheRead || 0);
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
      // ISSUE 106：每轮实时落盘（入账后清零，footer/status 读文件即实时值）
      flushTokenmaxxed();
    }
  });

  // ── session_start: 注入"记忆快照"一次（稳定前缀 = 缓存命中的关键）────────────
  // 醒来时把 DNA + cortex + work_memory + context(按预算切尾部) 揉成一份快照，注入一次。
  // 本会话中绝不再重发（见 before_agent_start）；新内容一律往「后面」append → 前缀不变 → 每轮命中缓存。
  pi.on("session_start", async (_event, ctx) => {
    personDir = getPersonDir(ctx.sessionManager.getSessionFile());
    dnaState = "wake"; // always wake on new session
    if (!personDir) return;

    // ISSUE 109：重启 = 快照重注入上文，上下文空间整体替换——旧 prevPrompt 与新 prompt
    // 无增量关系（跨 session 恢复会把重注入的上文误算为 novel，ISSUE 107 设计错误）。
    // 必须重新基线：null → 首轮 novel=0（重注入不算认知），首轮 prompt 成为新基线。
    _pondSess.prevPrompt = null;
    _pondSess.prevOut = 0;

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

    // ── 工作期【冻结快照】= spec 的增量式：逐字不变的前缀 → 几小时的 deepseek 缓存全程命中。
    // 绝不每次 session 重 build（重 build = 前缀每次都变 = 整份冷 miss = 烧钱根因）。
    // 冻结一份快照存盘，之后每次醒来注入【同一份】(命中)，只把冻结后新增的 work/context 作为尾部增量(小 miss)。
    // 仅在 [首次 / context 增量过大 / 文件被睡眠 consolidate 变短] 时重新冻结。
    const REFREEZE_DELTA = 100000; // 增量超 ~10万字(≈5万 token) 才重冻结，封顶每次增量 miss
    // 不依赖 global.__genshinChannelDir（session_start 时 kernel 可能还没设置），自己推导
    const runtimeCacheDir = global.__genshinChannelDir || (personDir ? path.join(path.dirname(personDir), "..", "RuntimeCache", path.basename(personDir)) : "");
    const frozenPath = runtimeCacheDir + "/snapshot.frozen.txt";
    const metaPath = runtimeCacheDir + "/snapshot.frozen.meta.json";
    const ctxNow = readFile(path.join(personDir, "context.md"));
    const wmNow = readFile(path.join(personDir, "work_memory.md"));
    let frozen = readFile(frozenPath);
    let meta = { ctxLen: 0, wmLen: 0 };
    try { meta = { ...meta, ...JSON.parse(readFile(metaPath) || "{}") }; } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); /* 冻结 meta 竞态截断：默认值不刷（同 .54 快照截断行处理，数据损坏暂时性）*/ }
    const dCtx = ctxNow.length - meta.ctxLen;
    const dWm = wmNow.length - meta.wmLen;
    if (!frozen || dCtx > REFREEZE_DELTA || dCtx < 0 || dWm < 0) {
      frozen = buildSnapshot(); // ← 唯一重 build 的地方（首次/增量超限/睡眠后）
      writeFile(frozenPath, frozen);
      writeFile(metaPath, JSON.stringify({ ctxLen: ctxNow.length, wmLen: wmNow.length }));
      meta = { ctxLen: ctxNow.length, wmLen: wmNow.length };
    }
    if (frozen) {
      sendCustomMessage(pi, "memory-snapshot", frozen);
    }
    // 冻结后新增的 work_memory / context → 尾部增量（小 miss，不破前缀）
    const tail = [
      wmNow.slice(meta.wmLen).trim() || "",
      ctxNow.slice(meta.ctxLen).trim() || ""
    ].filter(Boolean).join("\n\n");
    if (tail) sendCustomMessage(pi, "memory-frozen-delta", tail);
    injectedWorkMemLen = wmNow.length;
  });

  // ── message_end: incremental append to context + file index ─────
  // amem toolCall 与对应 tool 结果在两条消息里，靠这个计数器关联：
  // toolCall 时 +1，tool 结果压缩时 -1。防错误结果（ERR: 开头）漏压缩。
  let _pendingAmemResults = 0;
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

    const entries: { role: string; type: string; content?: string; text?: string; think?: string; tool?: any; ts_start: number; ts_end: number }[] = [];
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
            const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
            appendFile(thinkStream, `\n[${ts}]\n${c.thinking}\n`);
          }
        } else if (c.type === "toolCall") {
          entries.push({ role: "assistant", type: "toolCall", tool: { name: c.name, args: c.arguments }, ts_start: c.ts_start ?? now, ts_end: c.ts_end ?? now });
        }
      }
    }

    if (entries.length === 0 && typeof msg.content === "string" && !msg.content.trim()) return;

    // ── context 自噬去重：连续相同条目不重复写入 ──
    let lastSig = "";
    for (const e of entries) {
      const combinedText = e.content || e.text || e.think || "";

      // 坏帧隔离闸
      if (combinedText.includes("｜DSML｜")) {
        const t = new Date().toISOString();
        appendFile(path.join(personDir, "bad_cases.jsonl"), JSON.stringify({ ts: t, role: e.role, type: e.type, reason: "DSML/tools-template leak", raw: combinedText.slice(0, 20000) }) + "\n");
        appendFile(path.join(personDir, "context.md"), JSON.stringify({ role: e.role, type: "bad_frame", content: i18n("[坏帧已隔离：DSML，没收进记忆；原文见 bad_cases.jsonl]", "[bad frame quarantined: DSML, not stored into memory; original in bad_cases.jsonl]"), ts: Date.now() }) + "\n");
        continue;
      }

      // amem tool calls: compress args for compact context recording
      if (e.type === "toolCall" && (e as any).tool?.name === "amem") {
        // 标记待处理的 amem 结果——后续 tool 结果（无论成功/错误）都要压缩，
        // 否则 ERR 开头的错误结果不被下方正则识别，导致 hash-lock 归一化漏过滤（自递归变体）。
        _pendingAmemResults++;
        const a = (e as any).tool.args || {};
        const act = a.action || "manage";
        if (act === "manage") {
          const bAnc = String(a.anchor_begin || "").slice(0, 50);
          const eAnc = String(a.anchor_end || "").slice(0, 50);
          const revInfo = a.revision != null ? `${String(a.revision).length}c` : "check";
          (e as any).tool = { name: "amem", compact: `manage(${JSON.stringify(bAnc)},${JSON.stringify(eAnc)}),rev(${revInfo})` };
        } else if (act === "fetch") {
          (e as any).tool = { name: "amem", compact: `fetch(${a.id || "index"})` };
        } else if (act === "sweep" || act === "archive") {
          const n = act === "archive" ? "archive" : "sweep";
          (e as any).tool = { name: "amem", compact: `${n}(${(a.types||[]).join(",")},${a.hash_key?"apply":"check"})` };
        } else if (act === "revert") {
          (e as any).tool = { name: "amem", compact: `revert(${a.id},${a.hash_key?"apply":"check"})` };
        } else if (act === "mark_enter") {
          (e as any).tool = { name: "amem", compact: "mark_enter" };
        } else if (act === "mark_exit") {
          (e as any).tool = { name: "amem", compact: `mark_exit(${a.id||""},${(a.info||"").length}c info)` };
        }
      }

      // Deep-sleep / memory-management tool outputs
      // amem 结果：成功以 "amem " 开头，错误以 "ERR: " 开头——后者必须靠 toolCall 标记识别。
      // 有标记（_pendingAmemResults>0）或内容匹配已知前缀 → 压缩成 [memory op: ...]，
      // 保证 hash-lock 归一化（_amemCtxForHash 按 [memory op: 前缀过滤）能识别所有 amem 自身记录。
      // 2026-08-15 修复：实际写入 context.md 的 tool 结果 role 是 "toolResult"（不是 "tool"），
      // 原条件 e.role === "tool" 永远不匹配 → 压缩从未生效，ERR 开头的错误结果漏过滤导致
      // hash-lock 误报 context changed（残留变体）。这里同时匹配 tool / toolResult。
      if ((e.role === "tool" || e.role === "toolResult") && (_pendingAmemResults > 0 || /^(Napped\.|Context edited|"dream|Slept|Deep sleep|Drinkcoffee|Dream sent|amem )/.test(combinedText.trim()))) {
        if (_pendingAmemResults > 0) _pendingAmemResults--;
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

      const jsonl = JSON.stringify(e) + "\n";
      // 连续去重：与上一条签名相同则跳过（防自噬膨胀）
      // toolCall 的内容在 tool 子对象里（tool.name + tool.args），不在 content/text/think 字段，
      // 必须显式取 tool.name 做去重前缀，否则所有 toolCall 的签名都是 "assistant|toolCall|" → 触发误报警。
      const toolName = (e as any).tool?.name || "";
      const sig = e.role + "|" + (e.type || "") + "|" + toolName + "|" + (e.content || e.text || e.think || "").slice(0, 200);
      if (sig === lastSig) continue;
      lastSig = sig;
      // 原始归档（完整历史，不清洗，模型不读）
      appendFile(path.join(personDir, "context.archive.jsonl"), jsonl);
      appendFile(path.join(personDir, "context.md"), scrubSecrets(jsonl));

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

  // ── tool_call: 禁止 main session 直接写记忆文件（海马体领地）─────
  const MEMORY_FILES = ["work_memory.md", "context.md", "neocortex.md", "deep_cortex.md"];
  pi.on("tool_call", async (event) => {
    if (getSessionRole() !== "main") return;
    if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;

    // extract target path: write/edit use path/file_path; bash extracts from command
    let p: string = (event.input as any)?.path ?? (event.input as any)?.file_path ?? "";
    if (event.toolName === "bash") {
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
        return { block: true, reason: i18n(`记忆文件 ${base} 由海马体管理，主 session 不能直接修改。使用 editcontext / nap / sleep 工具。`, `Memory file ${base} is managed by the hippocampus; the main session cannot modify it directly. Use the editcontext / nap / sleep tools.`) };
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
      const costTotalPath = global.__genshinAgentFileDir + "/../MonitorData/" + global.__genshinPersonId + "/cost_total.json";
      const roles = ["main", "hippocampus", "metaconsciousness", "sleep"];
      let sessMain = 0, sessHippo = 0, sessSub = 0, sessSleeping = 0;
      for (const role of roles) {
        try {
          const costPath = path.join(personDir, `cost-${role}.json`);
          if (!fs.existsSync(costPath)) continue; // 该角色无消费记录（新 agent/未启用）——不存在不刷 ENOENT
          let d: any = null;
          try { d = JSON.parse(readFile(costPath)); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); /* 竞态截断：按 0 计不刷（下次写入自动修复）*/ }
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
      try { if (fs.existsSync(costTotalPath)) total = JSON.parse(readFile(costTotalPath)); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); /* 截断用默认值 */ }
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
          try { raw = JSON.parse(readFile(tokenmaxxedPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); /* 截断/损坏：用默认值 */ }
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

  function estimateTokens(text: string): number {
    if (!text) return 0;
    // 不能用 chars/4：中文一个字 ≈ 1.8 token，chars/4 估成 0.25 token，少算约 7 倍。
    // 后果：容量监控永不报警、isOverHalf 保护不触发 → 全量注入撑爆窗口
    // （实测真 1.15M tokens 时只显示 ~38%）。按 CJK 单独计。
    let cjk = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) ||
          (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    }
    return Math.ceil(cjk * 1.8 + (text.length - cjk) / 4);
  }

  // ── 模型窗口 ─────────────────────────────────────────────────────
  const modelMax = parseInt(process.env.PI_MODEL_MAX_TOKENS || "") || 1000000;
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
  function buildSnapshot(): string {
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
    const stateDlc = readFile(path.join(personDir, `dna/${dnaState}.dlc`));
    const cortex = readFile(path.join(personDir, "neocortex.md"));
    const workMem = readFile(path.join(personDir, "work_memory.md"));
    let context = readFile(path.join(personDir, "context.md"));
    // 旧污染兜底：历史里若残留 DSML 乱码行，注入前整段滤掉——不把旧垃圾再喂回模型(否则鬼打墙不停)。
    // 只按 ｜DSML｜ 这个特殊 token 滤（精确，不误伤含 "invoke name=" 之类的正常代码/文档行）。
    if (context.includes("｜DSML｜")) {
      context = context.split("\n").filter((l) => !l.includes("｜DSML｜")).join("\n");
    }

    // 快照去 tool_result：context.md 里混入的 toolResult JSONL 行不进快照——原样重放会被当成假工具结果且自噬膨胀。
    // 非 JSON 行（含空行）原样保留；正常 toolResult 压缩成一行 [tool: 前500字]；bad_frame 整行剔除。
    context = context.split("\n").map((line: string): string | null => {
      const t = line.trim();
      if (!t.startsWith("{")) return line;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.role === "toolResult") {
          if (obj.type === "bad_frame") return null;
          let text: any = obj.text ?? obj.content ?? "";
          if (Array.isArray(text)) text = text.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join(" ");
          text = String(text).trim();
          return text ? `[tool: ${text.slice(0, 500).replace(/\n/g, " ")}]` : null;
        }
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e));
        // context.md 截断行（如 toolResult 被截断成无效 JSON）：数据污染噪音，非代码 bug，无法修复——
        // 保留原文不压缩、不刷日志（2026-08-20：此前每次快照构建都报 Unexpected end of JSON input 刷屏）
      }
      return line;
    }).filter((l): l is string => l !== null).join("\n");

    // 默认【整份注入】(守"不切")；cortex + work_memory 永远全量。
    // 兜底(仅防死锁)：若整份会超过安全上限(窗口 70%)，只把 context 切到「尾部刚好放得下」——
    // 保命优先(它是永不停止的生命，崩死比丢最旧 context 更糟)，并在块标题里提示用 amem 整理。
    // 注意：截断 = 隐性遗忘，最旧记忆模型将完全看不到。平时(没超)绝不切。
    let trimmed = false;
    const SAFE = Math.round(modelMax * 0.70); // 留 30% 给对话+补全
    const ctxBudget = SAFE - estimateTokens(dnaIndex) - estimateTokens(stateDlc) - estimateTokens(cortex) - estimateTokens(workMem);
    if (ctxBudget <= 0) {
      context = "";
      trimmed = true;
    } else if (estimateTokens(context) > ctxBudget) {
      const beforeLen = context.length;
      let lo = 0, hi = context.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (estimateTokens(context.slice(-mid)) <= ctxBudget) lo = mid; else hi = mid - 1; }
      context = context.slice(-lo);
      trimmed = true;
      // 截断可见化：记录丢了多长，避免"静默遗忘"——agent 至少知道最旧记忆没进来。
      try {
        appendFile(global.__genshinPersonDir + "/../MonitorData/" + global.__genshinPersonId + "/growth.jsonl",
          JSON.stringify({ ts: new Date().toISOString(), event: "snapshot_trim", dropped: beforeLen - context.length, kept: context.length }) + "\n");
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    }
    const parts: string[] = [];
    if (dnaIndex) parts.push(dnaIndex);
    if (stateDlc) parts.push(stateDlc);
    // 注入消息类型参考表（从 prompts.json 的 dnA.core.typeRef 读取）
    const typeRef = getPrompt("core.typeRef");
    if (typeRef) parts.push(typeRef);
    if (cortex) parts.push(`[MEMORY — Cortex (long-term)]\n${cortex}`);
    if (workMem) parts.push(`[MEMORY — Work Memory]\n${workMem}`);
    if (context) parts.push(`[MEMORY — Context${trimmed ? "（WARN: 兜底截断：已超窗口，只注入了最近一截，更旧的 context 没进来 → 立即用 amem 整理（sweep/manage），否则这些旧记忆一直读不到）" : ""}]\n${context}`);
    return parts.join("\n\n");
  }

  // ── before_agent_start: 绝不改 systemPrompt(前缀)！只做"增量追加 + 容量提醒 + 后台整理" ──
  // 缓存铁律：前缀每轮一致才命中。记忆快照已在 session_start 注入一次；这里一律往「后面」append 消息。
  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!personDir) return;
    const context = readFile(path.join(personDir, "context.md"));
    const workMem = readFile(path.join(personDir, "work_memory.md"));
    const cortex = readFile(path.join(personDir, "neocortex.md"));

    // 0) 漏意识修复：sleep done后 context 变短 → 重建快照（否则主意识看不到新空间）。
    //    session_start 只在进程启动时执行，sleep-done 不会触发它，所以这里补一刀。
    const ctxNow2 = readFile(path.join(personDir, "context.md"));
    const wmNow2 = readFile(path.join(personDir, "work_memory.md"));
    const metaPath2 = (global.__genshinChannelDir || personDir.replace("MemoryData", "RuntimeCache")) + "/snapshot.frozen.meta.json";
    let meta2 = { ctxLen: 0, wmLen: 0 };
    try { meta2 = { ...meta2, ...JSON.parse(readFile(metaPath2) || "{}") }; } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    if (ctxNow2.length < meta2.ctxLen || wmNow2.length < meta2.wmLen) {
      const frozenPath = (global.__genshinChannelDir || personDir.replace("MemoryData", "RuntimeCache")) + "/snapshot.frozen.txt";
      const fresh = buildSnapshot();
      writeFile(frozenPath, fresh);
      writeFile(metaPath2, JSON.stringify({ ctxLen: ctxNow2.length, wmLen: wmNow2.length }));
    }

    // 1) work_memory 增量 — 只跟踪长度用于 snapshot 重冻结判断，不注入 context。
    //    海马体编码已在 context.md 中，sleep 时自然done；实时注入会造成污染。
    if (workMem.length > injectedWorkMemLen) {
      injectedWorkMemLen = workMem.length;
    }

    // 2) 容量提醒。默认整份注入；超窗口时 buildSnapshot 会兜底切最旧 context（不崩）。
    //    所以高占用 = "最旧记忆正在被丢"，该 sleep 把它编码走（不是会崩，是会丢）。
    const dna = readFile(path.join(personDir, "dna/index.md"));
    const dlc = readFile(path.join(personDir, `dna/${dnaState}.dlc`));
    const memTokens = estimateTokens(dna) + estimateTokens(dlc) + estimateTokens(context) + estimateTokens(workMem) + estimateTokens(cortex);
    const usageRatio = memTokens / modelMax;
    const rawPct = Math.round(usageRatio * 100);
    appendFile(global.__genshinPersonDir + "/../MonitorData/" + global.__genshinPersonId + "/growth.jsonl",
      JSON.stringify({ ts: new Date().toISOString(), bytes: context.length, tokens: memTokens, ratio: +(usageRatio * 100).toFixed(1) }) + "\n");
    // 容量提醒——只在达到 URGE(80%) 真危险时发（用户反馈：这条是垃圾，
    // 1) 清理后屏幕上还留着清理前的旧快照（过期数据） 2) 每次 amem 后用户说话就冒出来。
    // 修：阈值提到 80%；带时间戳（明确是快照不是当前值）；feed:false 不喂模型（模型自主管理）。
    // 2026-08-15 再修：不要每 1% 都发（80/81/82…堆积，queue 里一堆旧消息清理后还显示）——
    // 同一提醒周期（>=80% 连续期间）只发一条，回落 <80% 清除，下次再达 80% 才重新提醒。
    const fmtTok = (n: number) => n < 1000 ? n + "" : n < 1e6 ? (n / 1000).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
    const ctxTok = estimateTokens(context);
    const capTs = _fmtLocalTs(Date.now()).slice(6, 14); // HH:MM:SS（本地时区）
    let capacityLine = `context ${fmtTok(ctxTok)} tokens / ${fmtTok(modelMax)} (快照@${capTs})`;
    if (usageRatio >= CAPACITY.FORCE) capacityLine += i18n(" — 立即用 amem 整理", " — use amem immediately");
    else if (usageRatio >= CAPACITY.URGE) capacityLine += i18n(" — 建议 amem 整理", " — consider amem cleanup");
    if (usageRatio >= CAPACITY.URGE) {
      if (_lastCapacityUrge === 0) {
        _lastCapacityUrge = rawPct;
        sendCustomMessage(pi, "memory-capacity", capacityLine);
      }
    } else {
      _lastCapacityUrge = 0; // 回落 <80% 清除——下次再达 80% 才重新提醒
    }

    // [DISABLED 2026-08-15] 主动强制睡眠已禁用，由 amem 工具替代主动记忆管理。
    // if (usageRatio >= 0.90) triggerSleeping(`记忆 ${rawPct}% ≥ 90%`).catch(() => {});

    // 2.5) nap/sleep 后自动重载：context.md 被睡眠done缩水 → 重建快照、让 live 进程也清爽（不需重启）
    const _rcDir = global.__genshinChannelDir || personDir.replace("MemoryData", "RuntimeCache");
    const frozenMetaPath = _rcDir + "/snapshot.frozen.meta.json";
    let frozenMeta = { ctxLen: 0, wmLen: 0 };
    try { frozenMeta = { ...frozenMeta, ...JSON.parse(readFile(frozenMetaPath) || "{}") }; } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    if (context.length < frozenMeta.ctxLen - 5000) {
      // context 显著缩水（sleep/nap done掉了大量生肉）→ 重建快照 + 重置 work_memory 注入游标
      const freshFrozen = buildSnapshot();
      writeFile(_rcDir + "/snapshot.frozen.txt", freshFrozen);
      writeFile(frozenMetaPath, JSON.stringify({ ctxLen: context.length, wmLen: workMem.length }));
      injectedWorkMemLen = workMem.length;
      sendCustomMessage(pi, "memory-snapshot", freshFrozen);
    }

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
      if (lines.length > 300) writeFile(eventPath, lines.slice(-200).join("\n") + "\n");
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

  // /context command 已迁移到 god.frontend.tui/commands/context.ts

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

      const stats = [
        `context: ${ctxAfter.length} chars (~${estimateTokens(ctxAfter)} tokens)`,
        `work_memory: ${workMem.length} chars (~${estimateTokens(workMem)} tokens)`,
        `cortex: ${cortex.length} chars (~${estimateTokens(cortex)} tokens)`,
        `total: ~${estimateTokens(ctxAfter) + estimateTokens(workMem) + estimateTokens(cortex)} tokens`,
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
  // 四个 action: manage / sweep / fetch / revert
  // 所有修改操作强制两步：check(→hash_key) → apply(hash_key)
  // 最近 100K token 保护区：禁止编辑尾部内容，保护缓存和当前工作相关性

  // ── Hash-lock ──
  const _amemSeed = randomBytes(16).toString("hex");
  const _pendingKeys = new Map<string, { ctxHash: string; data: any; ts: number }>();
  const RECENT_PROTECT_TOKENS = 100000;

  // hash 归一化：check→apply 之间 context.md 必然会被追加 agent 自身产生的记录
  // （amem 的 toolCall 压缩记录、assistant 的 think/text、amem 的 toolResult）。
  // 这些是 agent 自身行为，不应导致 hash 失效（自递归 bug：两步验证永远走不通）。
  // 归一化后 hash 只对「用户消息 / 外部注入」敏感——用户真插话时仍会失效（安全语义保留）。
  function _amemCtxForHash(ctx: string): string {
    const out: string[] = [];
    for (const line of ctx.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) { out.push(line); continue; }
      try {
        const o = JSON.parse(t);
        // 剔除 amem 自身调用记录（压缩成 compact 的 toolCall）
        if (o.type === "toolCall" && o.tool?.name === "amem") continue;
        // 剔除 amem 工具结果记录（amem xxx / [memory op: ...]）
        if (o.role === "tool" || o.role === "toolResult") {
          const txt = o.text || o.content || "";
          if (typeof txt === "string" && (txt.startsWith("amem ") || txt.startsWith("[memory op:"))) continue;
        }
        // 剔除 assistant 自身产生的内容（think / text / toolCall）——不参与 hash 基准
        if (o.role === "assistant") continue;
        out.push(line);
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); out.push(line); }
    }
    return out.join("\n");
  }

  function _amemCreateKey(ctx: string, data: any): string {
    const ctxHash = createHash("sha256").update(_amemCtxForHash(ctx)).digest("hex");
    const key = createHash("sha256")
      .update(ctxHash + JSON.stringify(data) + _amemSeed + String(Date.now()))
      .digest("hex").slice(0, 16);
    _pendingKeys.set(key, { ctxHash, data, ts: Date.now() });
    for (const [k, v] of _pendingKeys) { if (Date.now() - v.ts > 5 * 60 * 1000) _pendingKeys.delete(k); }
    return key;
  }

  function _amemValidateKey(key: string, curCtx: string): { ok: boolean; data: any; reason?: string } {
    const e = _pendingKeys.get(key);
    if (!e) return { ok: false, data: null, reason: "invalid or expired hash_key" };
    if (Date.now() - e.ts > 5 * 60 * 1000) { _pendingKeys.delete(key); return { ok: false, data: null, reason: "hash_key expired (>5min), re-check" }; }
    const h = createHash("sha256").update(_amemCtxForHash(curCtx)).digest("hex");
    if (h !== e.ctxHash) { _pendingKeys.delete(key); return { ok: false, data: null, reason: "context changed since check, re-check required" }; }
    _pendingKeys.delete(key);
    return { ok: true, data: e.data };
  }

  // ── Helpers ──
  // 本地时间格式化：统一用本地时区（不用 UTC），格式 MM-DDTHH:MM:SS（与 anchor_ts/ts_from/ts_to 匹配一致）。
  // 用户明确要求：所有时间处理统一本地时间，避免 UTC/本地混用导致时间段匹配不到。
  function _fmtLocalTs(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // 时间归一化显示：历史归档存 UTC ISO（2026-08-15T05:27:39.998Z），新归档存本地（08-15T13:02:17）。
  // 统一显示为本地时间 MM-DDTHH:MM:SS；不改历史数据文件（revert 完整性保持），只在显示/过滤层归一。
  function _normTs(ts: string | null | undefined): string {
    if (!ts) return "?";
    const s = String(ts);
    // 带时区后缀（Z / +HH:MM）= 历史 UTC ISO → 转本地显示
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return _fmtLocalTs(d.getTime());
    }
    // 已是本地格式（MM-DDTHH:MM:SS）或含年份的本地串 → 幂等
    if (/^\d{2}-\d{2}T/.test(s) || /^\d{4}-/.test(s)) return s.slice(0, 19);
    return s;
  }

  // 时间转绝对毫秒（比较用）：历史 UTC ISO 按 UTC 解析；本地格式（MM-DDTHH:MM:SS）拼当年按本地解析。
  function _tsToMs(ts: string | null | undefined): number {
    if (!ts) return 0;
    const s = String(ts);
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    }
    if (/^\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
      // 2026-08-20 加固：用匹配前缀构造（s 可能带多余后缀如 ':00'，new Date 用整个 s 会 Invalid Date 返回 0）
      const d = new Date(`${new Date().getFullYear()}-${s.slice(0, 14)}`);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function _timeSpan(text: string): { earliest: string | null; latest: string | null } {
    let lo: number | null = null, hi: number | null = null;
    for (const line of text.split("\n")) {
      if (!line.trimStart().startsWith("{")) continue;
      try {
        const o = JSON.parse(line.trim());
        for (const k of ["ts_start", "ts_end", "ts"]) {
          const v = o[k]; if (typeof v === "number" && v > 1e12) { if (!lo || v < lo) lo = v; if (!hi || v > hi) hi = v; }
        }
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    }
    return { earliest: lo ? _fmtLocalTs(lo) : null, latest: hi ? _fmtLocalTs(hi) : null };
  }

  // context 行索引：每行 [start,end) 偏移 + 记录类型标签 + 时间戳。
  // 用途：锚点匹配时标注命中位置属于哪条记录（think/text/user/toolResult），
  // 解决"回复有 think+text 双份，同一锚点匹配 2-4 个位置却无法区分"的定位难题。
  // isToolZone 标记工具区（toolCall 参数/toolResult/压缩 marker）——锚点搜索须排除，
  // 否则任何工具的调用参数（含锚点文本）都被记录进 context，锚点匹配数越用越多（自我污染死循环）。
  // 这是 TTT 提的"salt 切割"的等价实现：以 JSONL 结构作天然边界（toolCall→toolResult 即工具区），
  // 比维护"哪些来源要排除"名单更通用——所有工具的调用区都不参与内容锚点匹配。
  function _ctxRowIndex(ctxContent: string) {
    const rows: { start: number; end: number; label: string; ts: string; isToolZone: boolean }[] = [];
    let pos = 0;
    for (const line of ctxContent.split("\n")) {
      const start = pos;
      const end = start + line.length;
      let label = "nonJson";
      let ts = "";
      let isToolZone = false;
      const t = line.trim();
      if (t.startsWith("{")) {
        try {
          const o = JSON.parse(t);
          const role = o.role || "";
          const type = o.type || "";
          label = role === "assistant" ? (type || "assistant") : (role || type || "?");
          const rawTs = o.ts_start || o.ts || "";
          if (rawTs) {
            const d = new Date(rawTs);
            if (!isNaN(d.getTime())) ts = _fmtLocalTs(d.getTime());
          }
          // 工具区：toolCall（任何工具的调用参数）+ toolResult（工具输出）
          if (type === "toolCall" || role === "toolResult") isToolZone = true;
        } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
      } else if (/^\[amem |^\[memory op:|^\[Napped\./.test(t)) {
        // 压缩 marker / amem 归档标记 / 记忆操作记录 = 工具区产物
        isToolZone = true;
      }
      rows.push({ start, end, label, ts, isToolZone });
      pos = end + 1; // +1 换行符
    }
    return rows;
  }

  // 锚点搜索：排除工具区（isToolZone 行）内的命中——根治自污染。
  // 返回每个匹配附带所属记录类型 + 时间戳（排除后 think/text 双份问题也大幅缓解）。
  function _anchorSearch(text: string, b: string, e: string) {
    const rows = _ctxRowIndex(text);
    const r: { begin_index: number; end_index: number; length: number; type?: string; ts?: string }[] = [];
    let from = 0;
    while (from < text.length && r.length < 200) {
      const bi = text.indexOf(b, from); if (bi < 0) break;
      const ei = text.indexOf(e, bi + b.length); if (ei < 0) break;
      const end = ei + e.length;
      // 命中起点属于哪条记录（按行区间）；若在工具区内则跳过继续搜
      let hit: { label: string; ts: string; isToolZone: boolean; start: number; end: number } | undefined;
      for (const row of rows) {
        if (row.start <= bi && bi < row.end) { hit = row; break; }
      }
      if (hit?.isToolZone) { from = hit.end; continue; }
      r.push({ begin_index: bi, end_index: end, length: end - bi, type: hit?.label, ts: hit?.ts });
      from = end;
    }
    return r;
  }

  function _multiMatch(pfx: string, ms: { begin_index: number; end_index: number; length: number; type?: string; ts?: string }[], cl: number) {
    let r = `${pfx}: ${ms.length} matches — unique required.\n`;
    for (let i = 0; i < Math.min(ms.length, 3); i++) {
      const m = ms[i];
      r += `  match[${i}]: begin_index=${m.begin_index}, end_index=${m.end_index}, length=${m.length}`;
      if (m.type) r += `, type=${m.type}`;
      if (m.ts) r += `, ts=${m.ts}`;
      r += `\n`;
    }
    if (ms.length > 3) r += `  and ${ms.length - 3} more.\n`;
    const hasText = ms.some((m) => m.type === "text");
    if (hasText) r += i18n(`  提示: 有 type=text 的匹配——优先选它（text 是可见输出，think 是内部思考）；或将时间戳(ts)并入锚点使其唯一。\n`, `  Tip: there is a type=text match — prefer it (text is visible output, think is internal reasoning); or merge the timestamp (ts) into the anchor to make it unique.\n`);
    return r + `current_context_length=${cl}`;
  }

  function _findAll(text: string, needle: string): number[] {
    const p: number[] = []; if (!needle) return p;
    let f = 0; while (f < text.length) { const i = text.indexOf(needle, f); if (i < 0) break; p.push(i); f = i + needle.length; }
    return p;
  }

  function _ctxStats(ctxContent: string): string {
    const tok = estimateTokens(ctxContent);
    const ft = (n: number) => n < 1000 ? n + "" : n < 1e6 ? (n / 1000).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
    return `context ${ft(tok)} tokens / ${ft(modelMax)}`;
  }

  // context 概览：JSONL 条目类型分布 + 可编辑范围提示（fetch 无 id 时附上，解决"盲人摸象"）
  function _ctxOverview(ctxContent: string): string {
    const counts: Record<string, number> = {};
    const chars: Record<string, number> = {};
    // 陈旧度分桶：记忆年龄分布（24h 内/1-7d/7-30d/30d+），看出哪些是沉淀、哪些是新鲜事
    const ageBuckets: { label: string; count: number; chars: number }[] = [
      { label: "<24h", count: 0, chars: 0 },
      { label: "1-7d", count: 0, chars: 0 },
      { label: "7-30d", count: 0, chars: 0 },
      { label: ">30d", count: 0, chars: 0 },
    ];
    const now = Date.now();
    let nonJson = 0, noTs = 0;
    for (const line of ctxContent.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) { nonJson++; continue; }
      try {
        const o = JSON.parse(t);
        const k = o.role || o.type || "?";
        counts[k] = (counts[k] || 0) + 1;
        // assistant 细分：think/text/toolCall 分开计（角色型工具豁免 read_conscious 等）
        // 统计内容长度：兼容多种 JSONL 结构（text/content/think 字段，或整个对象兜底）
        const rawTxt = o.text ?? o.content ?? o.think ?? o.tool ?? "";
        const c = typeof rawTxt === "string" ? rawTxt.length : JSON.stringify(rawTxt).length;
        if (o.role === "assistant" && o.type) {
          const sub = `assistant.${o.type}`;
          counts[sub] = (counts[sub] || 0) + 1;
          chars[sub] = (chars[sub] || 0) + c;
        }
        chars[k] = (chars[k] || 0) + c;
        // 年龄分桶：优先 ts_start（JSONL 标准），兼容 ts/ts_end
        const tsRaw = o.ts_start ?? o.ts ?? o.ts_end;
        if (typeof tsRaw === "number" && tsRaw > 0) {
          const age = now - tsRaw;
          const bidx = age < 24 * 3600e3 ? 0 : age < 7 * 24 * 3600e3 ? 1 : age < 30 * 24 * 3600e3 ? 2 : 3;
          ageBuckets[bidx].count++;
          ageBuckets[bidx].chars += c;
        } else noTs++;
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); nonJson++; }
    }
    const parts = Object.entries(counts)
      .filter(([k]) => !k.startsWith("assistant.")) // 细分行单独列
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}(${(chars[k] / 1000).toFixed(1)}k)`);
    const subParts = Object.entries(counts)
      .filter(([k]) => k.startsWith("assistant."))
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k.replace("assistant.", "a.")}=${v}(${(chars[k] / 1000).toFixed(1)}k)`);
    if (nonJson) parts.push(`nonJson=${nonJson}`);
    // 陈旧度：记忆年龄分布（有时间戳的记录按年龄分桶）
    const ageParts = ageBuckets.map((b) => `${b.label}=${b.count}(${(b.chars / 1000).toFixed(1)}k)`).join(", ");
    return i18n(`\ncontext 概览: ${_ctxStats(ctxContent)}\nJSONL 组成: ${parts.join(", ")}${subParts.length ? "\nassistant 细分: " + subParts.join(", ") : ""}\n陈旧度: ${ageParts}${noTs ? `, 无时间戳=${noTs}` : ""}\n可编辑范围: 开头 → 尾部最近 ${RECENT_PROTECT_TOKENS / 1000}K token 之前（archive 可用 exclude_tail=N 免锚点清理）`, `\ncontext overview: ${_ctxStats(ctxContent)}\nJSONL composition: ${parts.join(", ")}${subParts.length ? "\nassistant breakdown: " + subParts.join(", ") : ""}\nstaleness: ${ageParts}${noTs ? `, no-timestamp=${noTs}` : ""}\neditable range: start → before the recent ${RECENT_PROTECT_TOKENS / 1000}K token tail (archive can clean via exclude_tail=N no-anchor mode)`);
  }

  // 清理候选扫描：只统计尾部保护区外的 JSONL 类型（toolResult/toolCall/think/text），
  // 用于容量告警时给出"该清什么"的建议——告警从报数字升级为给方案。
  function _cleanCandidates(ctxContent: string, excludeTok: number): { type: string; count: number; chars: number }[] {
    if (!ctxContent) return [];
    const cut = _tailCutOffset(ctxContent, excludeTok);
    const head = ctxContent.slice(0, cut);
    const stats: Record<string, { count: number; chars: number }> = {};
    for (const line of head.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const o = JSON.parse(t);
        const k = o.role || o.type || "?";
        if (k !== "toolResult" && k !== "toolCall" && k !== "think" && k !== "text") continue;
        if (!stats[k]) stats[k] = { count: 0, chars: 0 };
        stats[k].count++;
        const rawTxt = o.text ?? o.content ?? o.think ?? o.tool ?? "";
        const c = typeof rawTxt === "string" ? rawTxt.length : JSON.stringify(rawTxt).length;
        stats[k].chars += c;
      } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
    }
    return Object.entries(stats).sort((a, b) => b[1].chars - a[1].chars).map(([type, v]) => ({ type, count: v.count, chars: v.chars }));
  }

  // exclude_tail：找到最小的 offset，使 ctx.slice(offset) 的 token ≤ tailTokens（即从该 offset 起为受保护的尾部）
  function _tailCutOffset(text: string, tailTokens: number): number {
    if (!text) return 0;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (estimateTokens(text.slice(mid)) > tailTokens) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 最近保护区检查：match 结束位置不能落在尾部 RECENT_PROTECT_TOKENS 区域内
  // ── mark state（temp zone）──
  let _activeMark: { id: string; offset: number; ts: number } | null = null;

  function _inRecentZone(ctx: string, endIndex: number): boolean {
    const tail = ctx.slice(endIndex);
    return estimateTokens(tail) < RECENT_PROTECT_TOKENS;
  }

  registerPaimonTool({
    name: "amem",
    label: "Active Memory",
    messageDescription:
      "Actively manage context memory. Two-step hash-lock for all mutations:\n" +
      "  1. call without hash_key → check (returns match info + hash_key)\n" +
      "  2. call with hash_key → validates context unchanged, executes\n\n" +
      "Actions: manage (anchor-replace+archive, " + i18n("原位留标题+摘要总结", "summary block stays in place") + "), archive (" + i18n("归档工具区产物，sweep 是旧名别名", "archives tool-zone products; sweep is the legacy alias") + "),\n" +
      "         fetch (query archive + keyword search + context overview), revert (restore by ID)\n" +
      "High-usage tips:\n" +
      i18n("  - manage 四种定位（任一）：①anchor_begin+anchor_end（文本）②anchor_ts='08-15T02:14:55'（记录时间戳，推荐——免疫 think/text 双份与工具区自污染）③ts_from+ts_to='08-15T02:00'/'08-15T05:00'（时间范围——批量清理某时间段）④anchor_begin_index+anchor_end_index（check 返回的位置，hash-lock 保证有效）\n", "  - manage four locators (any one): ①anchor_begin+anchor_end (text) ②anchor_ts='08-15T02:14:55' (record timestamp, recommended — immune to think/text duplication and tool-zone self-pollution) ③ts_from+ts_to='08-15T02:00'/'08-15T05:00' (time range — bulk archive a period) ④anchor_begin_index+anchor_end_index (position from check; hash-lock guarantees validity)\n") +
      i18n("  - 锚点搜索自动排除工具区（toolCall/toolResult/压缩 marker，salt 切割等价）——你越调用 amem，锚点不会越难匹配\n", "  - anchor search auto-excludes the tool zone (toolCall/toolResult/compression markers, salt-split equivalent) — the more you use amem, the easier anchors stay to match\n") +
      i18n("  - manage (revision, title, summary) → 交换记忆段，原位留总结块+归档，可 revert\n", "  - manage (revision, title, summary) → swap a memory segment, leave a summary block in place + archive, revertable\n") +
      i18n("  - archive/sweep 免锚点清工具区（toolResult/toolCall）+ think（思考记录，2026-08-18 定稿：一键批量+必须 exclude_tail 保护 100K+可 revert）→ 归档（不是删除！可 revert）。archive 是推荐名，sweep 是旧名别名。禁止清 user/text（那是对话记忆，用 manage）\n", "  - archive/sweep no-anchor clears tool-zone products (toolResult/toolCall) + think (thought records, 2026-08-18: one-shot batch, must use exclude_tail to protect 100K, revertable) → archives (not deletion! revertable). archive is the recommended name, sweep is the legacy alias. Never clear user/text (that is conversation memory — use manage)\n") +
      "  - fetch (from='2026-08-01', to='2026-08-15', limit=10) → filter index by date range / cap size\n" +
      "  - fetch (q='word') → search archived content (title/summary/excised) — the retrieval layer\n" +
      "  - fetch (review=3[, q='topic']) → randomly recall N archives — the reminiscence layer\n" +
      "  - Recent 100K tokens are protected from editing.",
    promptSnippet: "amem: manage/archive(sweep)/fetch/revert with hash-lock, recent-zone protection, ts-range bulk archive",
    renderCall(args: any, theme: any) {
      // 2026-08-18 用户要求：调用行必须区分 check（预览/测试）与 apply（实际执行）——
      // 两步 hash-lock：无 hash_key = check（黄，预览定位），有 hash_key = apply（绿，真正执行）；fetch/mark 无两阶段概念不标记。
      const a = args?.action || "";
      const phase = args?.hash_key ? theme.fg("success", "apply") : a === "fetch" || a === "mark_enter" || a === "mark_exit" ? "" : theme.fg("warning", "check");
      return renderToolCall.label(theme, "Amem", phase ? `${a} [${phase}]` : a);
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) { return renderMessage.summary(theme, ctx, resultContent(result)?.[0]?.text); },
    parameters: Type.Object({
      action: Type.Union([Type.Literal("manage"), Type.Literal("sweep"), Type.Literal("archive"), Type.Literal("fetch"), Type.Literal("revert"), Type.Literal("mark_enter"), Type.Literal("mark_exit")]),
      anchor_begin: Type.Optional(Type.String({ messageDescription: "[manage/archive] Beginning anchor (text)" })),
      anchor_end: Type.Optional(Type.String({ messageDescription: "[manage/archive] Ending anchor (text)" })),
      anchor_ts: Type.Optional(Type.String({ messageDescription: "[manage/archive] Locate by record timestamp (e.g. '08-15T02:14:55' from check output). The row with matching ts becomes the anchored range. Preferred over text anchors — immune to think/text duplication & amem self-pollution." })),
      ts_from: Type.Optional(Type.String({ messageDescription: "[manage/archive] Time-range start (e.g. '08-15T02:00'). Combined with ts_to to locate an interval by timestamp range — for bulk archiving a time period's records. Same prefix-match semantics as anchor_ts." })),
      ts_to: Type.Optional(Type.String({ messageDescription: "[manage/archive] Time-range end (e.g. '08-15T05:00'). Combined with ts_from to locate an interval by timestamp range." })),
      anchor_begin_index: Type.Optional(Type.Number({ messageDescription: "[manage] Direct position from check output (begin_index). Use together with anchor_end_index. Hash-lock guarantees context unchanged, so position stays valid." })),
      anchor_end_index: Type.Optional(Type.Number({ messageDescription: "[manage] Direct position from check output (end_index)." })),
      revision: Type.Optional(Type.String({ messageDescription: "[manage] Replacement text" })),
      title: Type.Optional(Type.String({ messageDescription: "[manage/archive/mark_exit] Title ≥10c" })),
      summary: Type.Optional(Type.String({ messageDescription: "[manage/archive/mark_exit] Summary ≥50c" })),
      info: Type.Optional(Type.String({ messageDescription: "[mark_exit] Key information to keep from the temp zone" })),
      types: Type.Optional(Type.Array(Type.String(), { messageDescription: "[archive/sweep] JSONL types to remove: toolResult, toolCall (tool-zone products), a.think (thought records, require exclude_tail to protect 100K)" })),
      exclude_tail: Type.Optional(Type.Number({ messageDescription: "[archive/sweep] Token count to exclude from the tail (no-anchor mode). e.g. 100000 keeps recent 100K tokens untouched" })),
      id: Type.Optional(Type.String({ messageDescription: "[fetch/revert/mark_exit] Archive ID or mark_id" })),
      q: Type.Optional(Type.String({ messageDescription: "[fetch] keyword search across archived content (title/summary/excised). e.g. fetch(q=\"硬件\") finds archives containing the term" })),
      review: Type.Optional(Type.Number({ messageDescription: "[fetch] random review of N archives (optionally combined with q= for themed recall). e.g. fetch(review=3) recalls 3 random archives — the reminiscence layer" })),
      from: Type.Optional(Type.String({ messageDescription: "[fetch] list filter: only archives with time_span >= this date (YYYY-MM-DD). keeps the index response small" })),
      to: Type.Optional(Type.String({ messageDescription: "[fetch] list filter: only archives with time_span <= this date (YYYY-MM-DD)" })),
      limit: Type.Optional(Type.Number({ messageDescription: "[fetch] list cap: only show the most recent N entries (default 30). prevents index bloat" })),
      hash_key: Type.Optional(Type.String({ messageDescription: "From check step. Required for manage/archive/revert mutations." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!personDir) return { content: [{ type: "text", text: "ERR: No person directory." }], details: {}, isError: true };
      if (getSessionRole() !== "main") return { content: [{ type: "text", text: "ERR: Only main session." }], details: {}, isError: true };

      const contextPath = path.join(personDir, "context.md");
      const manageDir = path.join(personDir, "ActiveManage");
      const indexPath = path.join(personDir, "ActiveManageMemoryIndex.json");

      // ── fetch (read-only, no hash) ─────────────────────────────────
      if (params.action === "fetch") {
        let idx: any = { total_entries: 0, total_excised_chars: 0, entries: [] };
        try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        const entries: any[] = idx.entries || [];
        // ── 检索层：fetch(q="...") 全文搜索归档内容（title/summary/excised）──
        // 想法来源（2026-08-15 冲浪实测）：amem 只会"切出去"不会"翻回来"，
        // 归档是黑箱。加关键词搜索让归档成为真正可回查的"第二层记忆"。
        if (params.q) {
          const q = params.q.toLowerCase();
          const hits: any[] = [];
          for (const e of entries) {
            let d: any = null; try { d = JSON.parse(readFile(path.join(manageDir, `${e.id}.json`))); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
            if (!d) continue;
            const title = (d.title || "").toLowerCase();
            const summary = (d.summary || "").toLowerCase();
            const excised = (d.excised || "");
            const excL = excised.toLowerCase();
            if (title.includes(q) || summary.includes(q) || excL.includes(q)) {
              // 提取首个命中上下文片段（前后各 ~60 字符）
              let snippet = "";
              const hitIdx = excL.indexOf(q);
              if (hitIdx >= 0) {
                const s = Math.max(0, hitIdx - 60), eI = Math.min(excised.length, hitIdx + q.length + 60);
                snippet = (s > 0 ? "…" : "") + excised.slice(s, eI).replace(/\n/g, " ") + (eI < excised.length ? "…" : "");
              } else if (summary.includes(q)) {
                const si = summary.indexOf(q);
                snippet = (d.summary || "").slice(Math.max(0, si - 40), si + q.length + 60).replace(/\n/g, " ");
              }
              const ts = e.time_span || {};
              hits.push({ id: e.id, title: d.title, snippet, when: _normTs(ts.latest || ts.earliest || e.timestamp), size: e.excised_length || 0 });
            }
          }
          if (hits.length === 0) return { content: [{ type: "text", text: `amem fetch: no archives contain "${params.q}". (searched ${entries.length} entries)` }], details: { hits: [] } };
          // limit 截断：命中过多时避免一次性返回太大（用户反馈：索引/搜索输出膨胀）。默认显示前 10 条，可加大 limit。
          const qCap = params.limit != null ? Math.max(1, params.limit) : 10;
          const shownQ = hits.slice(0, qCap);
          let r = i18n(`amem fetch: ${hits.length} archive(s) contain "${params.q}"${hits.length > shownQ.length ? `（显示前 ${shownQ.length} 条，用 limit=N 查看更多）` : ""}:\n`, `amem fetch: ${hits.length} archive(s) contain "${params.q}"${hits.length > shownQ.length ? ` (showing first ${shownQ.length}, use limit=N for more)` : ""}:\n`);
          for (let i = 0; i < shownQ.length; i++) {
            const h = shownQ[i];
            r += `  [${i}] ${h.id} | ${JSON.stringify(h.title || "")} | ${h.size}c | ${h.when}\n`;
            if (h.snippet) r += `      ↳ ${h.snippet}\n`;
          }
          return { content: [{ type: "text", text: r }], details: { hits: shownQ, total_hits: hits.length } };
        }
        // ── 主动回顾层：fetch(review=N[, q=主题]) 随机重温 N 条归档 ──
        // 想法来源：记忆不该只是被动存储——空闲时回放旧决策（类比大脑睡眠巩固）。
        if (params.review != null) {
          const n = Math.max(1, Math.min(params.review, 10));
          let pool = entries.filter((e: any) => !e.reverted);
          const topic = params.q ? params.q.toLowerCase() : "";
          if (topic) {
            pool = pool.filter((e: any) => {
              let d: any = null; try { d = JSON.parse(readFile(path.join(manageDir, `${e.id}.json`))); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
              if (!d) return false;
              return (d.title || "").toLowerCase().includes(topic) || (d.summary || "").toLowerCase().includes(topic) || ((d.excised || "") as string).toLowerCase().includes(topic);
            });
          }
          if (pool.length === 0) return { content: [{ type: "text", text: topic ? `amem review: no active archives match "${params.q}".` : "amem review: no active archives." }], details: { reviewed: [] } };
          // 加权挑选：manage/revert（含人工决策的替换/还原）权重更高——回放"有决策"的记忆比"批量清理"更有价值
          const weighted = pool.map((e: any) => {
            let d: any = null; try { d = JSON.parse(readFile(path.join(manageDir, `${e.id}.json`))); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
            const action = d?.action || "";
            const w = action === "manage" || action === "revert" ? 3 : 1;
            return { e, d, action, w };
          });
          let totalW = weighted.reduce((s, x) => s + x.w, 0);
          const pickedW: any[] = [];
          for (let i = 0; i < Math.min(n, weighted.length); i++) {
            let roll = Math.random() * totalW;
            let pick = weighted[0];
            for (const x of weighted) { roll -= x.w; if (roll <= 0) { pick = x; break; } }
            weighted.splice(weighted.indexOf(pick), 1);
            totalW -= pick.w;
            pickedW.push(pick);
          }
          let r = i18n(`amem review: ${pickedW.length} of ${pool.length} active archives${topic ? ` (主题: "${params.q}")` : ""} — 回放旧记忆(●manage/◐sweep):\n`, `amem review: ${pickedW.length} of ${pool.length} active archives${topic ? ` (topic: "${params.q}")` : ""} — replaying old memories (●manage/◐sweep):\n`);
          for (const { e, d, action } of pickedW) {
            const ts = e.time_span || {};
            r += `  ${action === "manage" ? "●" : "◐"} ${e.id} | ${JSON.stringify(e.title || "")} | ${e.excised_length || 0}c | ${_normTs(ts.latest || ts.earliest || e.timestamp).slice(0, 10)}\n`;
            const sum = (d?.summary || "").replace(/\n/g, " ");
            if (sum) r += `    ↳ ${sum.slice(0, 140)}${sum.length > 140 ? "…" : ""}\n`;
          }
          r += `(要深入看某条: amem(fetch, id="..."))`;
          return { content: [{ type: "text", text: r }], details: { reviewed: pickedW.map((x: any) => x.e.id) } };
        }
        if (params.id) {
          const e = entries.find((x: any) => x.id === params.id);
          if (!e) return { content: [{ type: "text", text: `amem fetch: ${params.id} not found.` }], details: {} };
          let d: any = null; try { d = JSON.parse(readFile(path.join(manageDir, `${params.id}.json`))); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
          if (!d) return { content: [{ type: "text", text: `amem fetch: file not readable.` }], details: {} };
          const ts = d.time_span || {};
          const tsE = ts.earliest || (ts.latest ? null : d.timestamp);
          const tsL = ts.latest || d.timestamp;
          return { content: [{ type: "text", text:
            `amem fetch ${params.id}:\ntitle: ${JSON.stringify(d.title)}\nsummary: ${JSON.stringify(d.summary)}\n` +
            `excised: ${d.excised?.length || 0}c | revision: ${d.revision?.length || 0}c\n` +
            `time_span: ${_normTs(tsE)} ~ ${_normTs(tsL)}\nreverted: ${!!d.reverted}` }], details: { entry: d } };
        }
        if (entries.length === 0) {
          const ctxContent = readFile(contextPath);
          return { content: [{ type: "text", text: "amem fetch: no entries." + _ctxOverview(ctxContent) }], details: {} };
        }
        // 列表过滤：日期区间（from/to）+ 条数上限（limit），防止索引本身撑大 context
        let list = entries;
        if (params.from || params.to) {
          // 用户传的日期按本地时区解析（用户要求：所有时间统一本地时间）
          const f = params.from ? new Date(params.from + "T00:00:00").getTime() : -Infinity;
          const t = params.to ? new Date(params.to + "T23:59:59").getTime() : Infinity;
          list = entries.filter((e: any) => {
            const ts = e.time_span || {};
            const latest = _tsToMs(ts.latest || ts.earliest || e.timestamp);
            return latest >= f && latest <= t;
          });
        }
        const cap = params.limit != null ? Math.max(1, params.limit) : 30;
        const shown = list.slice(-cap); // 最新在前显示
        // 每条的 token 占比（breakthrough agent 反馈）：归档条目加估算 token，方便决定优先 revert 哪些
        const ctxForTok = readFile(contextPath);
        const totalTok = estimateTokens(ctxForTok);
        let r = `amem fetch: ${list.length}${list.length !== entries.length ? `/${entries.length}` : ""} entries` +
          (params.from || params.to ? ` (${params.from || "…"} ~ ${params.to || "…"})` : "") +
          `${shown.length < list.length ? `, showing latest ${shown.length}` : ""}, ${idx.total_excised_chars || 0}c total excised.\n`;
        for (let i = 0; i < shown.length; i++) {
          const e = shown[i], ts = e.time_span || {}, rv = e.reverted ? " [REVERTED]" : "";
          // token 占比：excised 内容估算 token 相对当前 context 的占比（粗算，实际管理用真实 estimateTokens）
          const estTok = Math.round((e.excised_length || 0) * 0.6);
          const pct = totalTok > 0 ? Math.min(99, Math.round((estTok / totalTok) * 100)) : 0;
          const tsE = ts.earliest || (ts.latest ? null : e.timestamp);
          const tsL = ts.latest || e.timestamp;
          r += `  [${i}] ${e.id} | ${JSON.stringify(e.title || "")} | ${e.excised_length}c(~${estTok} tokens ${pct}%) | ${_normTs(tsE)} ~ ${_normTs(tsL)}${rv}\n`;
        }
        const ctxContent = readFile(contextPath);
        return { content: [{ type: "text", text: r + _ctxOverview(ctxContent) }], details: { index: idx, shown: shown.length } };
      }

      // ── manage ─────────────────────────────────────────────────────
      if (params.action === "manage") {
        // 四种定位方式（任一）：文本锚点（anchor_begin+anchor_end）/ 单条时间戳（anchor_ts）/ 时间范围（ts_from+ts_to）/ 直接位置（anchor_begin_index+anchor_end_index）
        const hasTextAnchor = !!(params.anchor_begin && params.anchor_end);
        const hasTsAnchor = !!params.anchor_ts;
        const hasTsRange = !!(params.ts_from || params.ts_to);
        const hasPosAnchor = params.anchor_begin_index != null && params.anchor_end_index != null;
        if (!hasTextAnchor && !hasTsAnchor && !hasTsRange && !hasPosAnchor)
          return { content: [{ type: "text", text: i18n("ERR: 需提供一种定位：①anchor_begin+anchor_end（文本锚点）②anchor_ts（记录时间戳，推荐——免疫双份/自污染）③ts_from+ts_to（时间范围，批量清理某时间段）④anchor_begin_index+anchor_end_index（check 返回的位置）。", "ERR: provide one locator: ①anchor_begin+anchor_end (text anchors) ②anchor_ts (record timestamp, recommended — immune to duplication/self-pollution) ③ts_from+ts_to (time range, bulk archive a period) ④anchor_begin_index+anchor_end_index (position from check output).") }], details: {}, isError: true };
        const ctx = readFile(contextPath);
        if (!ctx) return { content: [{ type: "text", text: "ERR: context.md empty." }], details: {}, isError: true };
        let m: { begin_index: number; end_index: number; length: number; type?: string; ts?: string };
        if (hasTsAnchor) {
          // 按记录时间戳定位：_ctxRowIndex 的 ts 为 MM-DDTHH:MM:SS，支持前缀/包含匹配（如 '08-15T02:14'）
          const rows = _ctxRowIndex(ctx);
          const tq = params.anchor_ts;
          const hits = rows.filter((r) => r.ts && (r.ts.includes(tq) || tq.includes(r.ts)));
          if (hits.length === 0) return { content: [{ type: "text", text: i18n(`amem manage: 0 matches for anchor_ts="${tq}". ${_ctxStats(ctx)}\n提示: 从 fetch 概览或 check 输出的 ts 字段复制精确时间戳（如 08-15T02:14:55）。`, `amem manage: 0 matches for anchor_ts="${tq}". ${_ctxStats(ctx)}\nTip: copy an exact timestamp from the fetch overview or the ts field of check output (e.g. 08-15T02:14:55).`) }], details: {} };
          if (hits.length > 1) {
            const list = hits.map((h) => `  ts=${h.ts} [${h.start}..${h.end}] type=${h.label}`).join("\n");
            return { content: [{ type: "text", text: i18n(`amem manage: ${hits.length} records match anchor_ts="${tq}". 用更精确的时间戳重试。\n${list}`, `amem manage: ${hits.length} records match anchor_ts="${tq}". Retry with a more precise timestamp.\n${list}`) }], details: {} };
          }
          m = { begin_index: hits[0].start, end_index: hits[0].end, length: hits[0].end - hits[0].start, type: hits[0].label, ts: hits[0].ts };
        } else if (hasTsRange) {
          // 时间范围定位：找出 ts 落在 [ts_from, ts_to] 内的行，区间取首行 start 到尾行 end。
          // 用途：批量归档某时间段的记录（配合 archive 的 types 过滤）。
          const rows = _ctxRowIndex(ctx);
          const fq = params.ts_from || "";
          const tq = params.ts_to || "";
          const inRange = rows.filter((r) => {
            if (!r.ts) return false;
            // 时间比较语义（非字符串包含）：ts 落在 [from, to] 区间内。
            // 前缀补全：'08-15T02:00' → '08-15T02:00:00'；from 取区间起点，to 取区间终点。
            const ms = _tsToMs(r.ts);
            if (!ms) return false;
            if (fq) {
              // 2026-08-20 修复：补全目标应是 14 字符 MM-DDTHH:MM:SS（原 19 会把已含秒的 '08-20T10:18:00' 补成 '08-20T10:18:00:00' → new Date Invalid → 0 条）
              const fBase = fq.length < 14 ? fq + ":00".slice(0, 14 - fq.length) : fq;
              if (ms < _tsToMs(fBase)) return false;
            }
            if (tq) {
              const tBase = tq.length < 14 ? tq + ":59".slice(0, 14 - tq.length) : tq;
              if (ms > _tsToMs(tBase)) return false;
            }
            return true;
          });
          if (inRange.length === 0) return { content: [{ type: "text", text: i18n(`amem manage: 0 records in time range "${fq} ~ ${tq}". ${_ctxStats(ctx)}\n提示: 时间范围按本地时间前缀匹配（如 ts_from='08-15T14:00' ts_to='08-15T15:00'）。从 fetch 概览的 ts 字段确认范围（本地时间）。`, `amem manage: 0 records in time range "${fq} ~ ${tq}". ${_ctxStats(ctx)}\nTip: time range matches by local-time prefix (e.g. ts_from='08-15T14:00' ts_to='08-15T15:00'). Confirm the range from the ts fields in the fetch overview (local time).`) }], details: {} };
          const first = inRange[0], last = inRange[inRange.length - 1];
          const begin = first.start, end = last.end;
          m = { begin_index: begin, end_index: end, length: end - begin, type: `${inRange.length} records` };
          // 时间范围定位的 check 提示（archive 主要场景）
          if (!params.hash_key) {
            const key = _amemCreateKey(ctx, { action: "manage", match: m });
            return { content: [{ type: "text", text:
              `amem manage check: ${inRange.length} records in time range "${fq} ~ ${tq}". hash_key=${key}\n` +
              `matched: begin_index=${begin}, end_index=${end}, length=${end - begin} (${inRange.length} rows)\n` +
              `${_ctxStats(ctx)}\nProvide hash_key + revision + title(≥10c) + summary(≥50c) to apply.` }],
              details: { hash_key: key, match: m } };
          }
        } else if (hasPosAnchor) {
          // 直接位置定位：check 返回的 begin_index/end_index（hash-lock 保证 apply 时 context 未变，位置有效）
          const bi = params.anchor_begin_index, ei = params.anchor_end_index;
          if (bi < 0 || ei > ctx.length || bi >= ei) return { content: [{ type: "text", text: i18n(`ERR: 非法位置 [${bi}..${ei}]，context 长度=${ctx.length}。`, `ERR: invalid position [${bi}..${ei}], context length=${ctx.length}.`) }], details: {}, isError: true };
          const rows = _ctxRowIndex(ctx);
          let hit: any = undefined;
          for (const row of rows) { if (row.start <= bi && bi < row.end) { hit = row; break; } }
          m = { begin_index: bi, end_index: ei, length: ei - bi, type: hit?.label, ts: hit?.ts };
        } else {
          const matches = _anchorSearch(ctx, params.anchor_begin, params.anchor_end);
          if (matches.length === 0) return { content: [{ type: "text", text: i18n(`amem manage: 0 matches. ${_ctxStats(ctx)}\nSystem sections not searchable.\n提示: 锚点不在可搜索区。常见原因: ①文本在 system section（DNA/CHRs 声明区）②锚点过长/含换行 ③文本已被 amem 替换压缩。建议: 用 10-20 字符的短锚点（避免换行），或先 amem(fetch) 查看 context 概览后取精确文本，或用 anchor_ts 按时间戳定位。`, `amem manage: 0 matches. ${_ctxStats(ctx)}\nSystem sections not searchable.\nTip: the anchor is not in a searchable area. Common causes: ①text is in a system section (DNA/CHRs declaration area) ②anchor too long / contains newlines ③text already replaced/compressed by amem. Suggestion: use a short 10-20 char anchor (no newlines), or amem(fetch) to view the context overview and take exact text, or locate by timestamp with anchor_ts.`) }], details: {} };
          if (matches.length > 1) return { content: [{ type: "text", text: _multiMatch("amem manage", matches, ctx.length) + i18n(`\n提示: 锚定不唯一。推荐: 用 anchor_ts 按记录时间戳定位（免疫双份/自污染），或用 check 输出的 anchor_begin_index/anchor_end_index 直接操作。`, `\nTip: the anchor is not unique. Recommended: locate by record timestamp with anchor_ts (immune to duplication/self-pollution), or use the anchor_begin_index/anchor_end_index from check output directly.`) }], details: {} };
          m = matches[0];
        }

        // 最近保护区
        if (_inRecentZone(ctx, m.end_index)) {
          return { content: [{ type: "text", text: `amem manage: match falls in recent ${RECENT_PROTECT_TOKENS/1000}K token protection zone (tail). Only older content can be edited.\n${_ctxStats(ctx)}` }], details: {} };
        }

        // check (no hash_key)
        if (!params.hash_key) {
          const key = _amemCreateKey(ctx, { action: "manage", match: m });
          const typeInfo = m.type ? `, type=${m.type}` : "";
          const tsInfo = m.ts ? `, ts=${m.ts}` : "";
          return { content: [{ type: "text", text:
            `amem manage check: 1 match. hash_key=${key}\n` +
            `matched: begin_index=${m.begin_index}, end_index=${m.end_index}, length=${m.length}${typeInfo}${tsInfo}\n` +
            i18n(`提示: apply 时可用 anchor_begin_index=${m.begin_index} + anchor_end_index=${m.end_index}（直接位置，最稳）或 anchor_ts="${m.ts}"（按时间戳）。\n`,
                 `Tip: when applying, use anchor_begin_index=${m.begin_index} + anchor_end_index=${m.end_index} (direct position, most stable) or anchor_ts="${m.ts}" (by timestamp).\n`) +
            `${_ctxStats(ctx)}\nProvide hash_key + revision + title(≥10c) + summary(≥50c) to apply.` }],
            details: { hash_key: key, match: m } };
        }

        // apply (with hash_key)
        const v = _amemValidateKey(params.hash_key, ctx);
        if (!v.ok) return { content: [{ type: "text", text: `ERR: ${v.reason}` }], details: {}, isError: true };
        if (params.revision === undefined || params.revision === null) return { content: [{ type: "text", text: "ERR: revision required." }], details: {}, isError: true };
        if (!params.title || params.title.length < 10) return { content: [{ type: "text", text: `ERR: title ≥10c required (got ${params.title?.length || 0}).` }], details: {}, isError: true };
        if (!params.summary || params.summary.length < 50) return { content: [{ type: "text", text: `ERR: summary ≥50c required (got ${params.summary?.length || 0}).` }], details: {}, isError: true };

        const excised = ctx.slice(m.begin_index, m.end_index);
        const ts = _timeSpan(excised);
        const amId = `am-${Date.now()}`;
        try { fs.mkdirSync(manageDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }

        const blockBase = `[amem ${amId} | ${params.title}]\n${params.summary}\n${params.revision}`;
        // 交换总结块：标题+摘要+revision+自解释的替换前后元数据（用户设计："除了数字本身，前面也要写上是什么"）。
        // 替换后 length 用 blockBase.length（元数据行自身未计入，context 长度本就是估算，无伤大雅）。
        const metaLine = i18n(`\n（记忆交换: 替换前 begin_index=${m.begin_index}, end_index=${m.end_index}, length=${m.length}, context_length=${ctx.length} → 替换后 begin_index=${m.begin_index}, end_index=${m.begin_index + blockBase.length}, length=${blockBase.length}, context_length=${ctx.length - m.length + blockBase.length}；原文归档 ActiveManage/${amId}.json，amem(fetch, id=\"${amId}\") 查原文，amem(revert, id=\"${amId}\") 还原）`, `\n(memory swap: before begin_index=${m.begin_index}, end_index=${m.end_index}, length=${m.length}, context_length=${ctx.length} → after begin_index=${m.begin_index}, end_index=${m.begin_index + blockBase.length}, length=${blockBase.length}, context_length=${ctx.length - m.length + blockBase.length}; original archived at ActiveManage/${amId}.json, amem(fetch, id=\"${amId}\") to view the original, amem(revert, id=\"${amId}\") to restore)`);
        const block = blockBase + metaLine;
        const newCtx = ctx.slice(0, m.begin_index) + block + ctx.slice(m.end_index);

        const entry = {
          id: amId, title: params.title, summary: params.summary,
          excised, revision: params.revision || null,
          anchors: { begin: params.anchor_begin, end: params.anchor_end, ts: params.anchor_ts, begin_index: params.anchor_begin_index, end_index: params.anchor_end_index },
          before: { begin_index: m.begin_index, end_index: m.end_index, length: m.length, context_length: ctx.length },
          after: { begin_index: m.begin_index, end_index: m.begin_index + block.length, length: block.length, context_length: newCtx.length },
          time_span: ts, timestamp: new Date().toISOString(), reverted: false,
        };
        writeFile(path.join(manageDir, `${amId}.json`), JSON.stringify(entry, null, 2));

        let idx: any = { total_entries: 0, total_excised_chars: 0, entries: [] };
        try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        if (!Array.isArray(idx.entries)) idx.entries = [];
        idx.entries.push({ id: amId, title: params.title, summary: params.summary, path: `ActiveManage/${amId}.json`,
          excised_length: m.length, revision_length: block.length, time_span: ts, timestamp: entry.timestamp, reverted: false });
        idx.total_entries = idx.entries.length;
        idx.total_excised_chars = idx.entries.reduce((s: number, e: any) => s + (e.excised_length || 0), 0);
        idx.last_updated = entry.timestamp;
        writeFile(indexPath, JSON.stringify(idx, null, 2));
        writeFile(contextPath, newCtx);

        const rel = `MemoryData/${path.basename(personDir)}/ActiveManage/${amId}.json`;
        return { content: [{ type: "text", text:
          `amem manage ${JSON.stringify(params.title)} → revision(${block.length}c), archived ${amId}\n` +
          `replaced: begin_index=${m.begin_index}, end_index=${m.end_index}, length=${m.length}, context_length_before=${ctx.length}\n` +
          `after: begin_index=${m.begin_index}, end_index=${m.begin_index + block.length}, length=${block.length}, context_length_after=${newCtx.length}\n` +
          (ts.earliest ? `time_span: ${ts.earliest} ~ ${ts.latest}\n` : "") + `archived: ${rel}` }],
          details: { archived: { id: amId, path: rel }, replaced: entry.before, after: entry.after } };
      }

      // ── archive / sweep（同义：archive 是新名（语义=归档），sweep 是旧名别名）──
      if (params.action === "sweep" || params.action === "archive") {
        const actName = params.action === "archive" ? "archive" : "sweep";
        if (!params.types?.length) return { content: [{ type: "text", text: "ERR: types array required (e.g. [\"toolResult\"])." }], details: {}, isError: true };
        // archive 免锚点允许：工具区产物（toolResult/toolCall）+ think（思考记录——2026-08-18 用户定稿：
        // 一键批量归档，必须排除尾部 100K tokens、必须可 revert；think 是过程性思维，卸载对功能性影响小，原文归档可回查）。
        // 禁止删对话记忆（user/text/assistant/bad_frame）："sweep 只能清除 tool 区之类的结果，不是用来删除自己的记忆的"——记忆交换用 manage（锚定+总结）。
        const MEMORY_TYPES = new Set(["user", "text", "assistant", "bad_frame"]);
        // 记忆类禁止条件按模式区分（用户最初设计原话："比如模型可以选择只清除某一区间的工具调用结果或某一区间的其他或者某区间的思考或其他，这些可能也行"）：
        //  - 免锚点全量扫（exclude_tail）：只允许工具区产物——记忆类拒绝（防止误删自己的记忆）
        //  - 锚定区间（文本/ts/index 任一）：允许记忆类——用户显式指定了范围，安全语义由"原位留总结块+可 revert"保证
        const hasTextAnchor = !!(params.anchor_begin && params.anchor_end);
        const hasTsAnchor = !!params.anchor_ts;
        const hasTsRange = !!(params.ts_from || params.ts_to);
        const hasPosAnchor = params.anchor_begin_index != null && params.anchor_end_index != null;
        const isAnchored = hasTextAnchor || hasTsAnchor || hasTsRange || hasPosAnchor;
        const bad = params.types.filter((t: string) => MEMORY_TYPES.has(t));
        if (bad.length && !isAnchored) {
          return { content: [{ type: "text", text: i18n(`ERR: ${actName} 免锚点模式不能归档记忆类记录（${bad.join(", ")}）。免锚点全量扫允许：工具区产物（toolResult/toolCall）+ think（思考记录，需 exclude_tail 保护尾部）；若要归档对话记忆（user/text），请用锚定区间（anchor_begin+anchor_end 文本 / anchor_ts 时间戳 / ts_from+ts_to 时间范围 / anchor_begin_index+anchor_end_index 位置）显式指定范围——原位留总结块、可 revert。`, `ERR: ${actName} no-anchor mode cannot archive memory-class records (${bad.join(", ")}). No-anchor full sweep allows: tool-zone products (toolResult/toolCall) + think (thought records, requires exclude_tail protection); to archive conversation memory (user/text), explicitly specify an anchored range (anchor_begin+anchor_end text / anchor_ts timestamp / ts_from+ts_to time range / anchor_begin_index+anchor_end_index position) — a summary block stays in place and it is revertable.`) }], details: {}, isError: true };
        }
        const ctx = readFile(contextPath);
        if (!ctx) return { content: [{ type: "text", text: "ERR: context.md empty." }], details: {}, isError: true };

        let rStart = 0, rEnd = ctx.length;
        let modeDesc = "";
        let rangeDesc = ""; // 时间范围模式的描述（块外声明，check 分支安全访问——修复 a is not defined）
        if (isAnchored) {
          // 四种锚定定位（与 manage 一致）：文本锚点 / 单条时间戳 / 时间范围 / 直接位置
          let a: { begin_index: number; end_index: number; length: number };
          if (hasTsAnchor) {
            const rows = _ctxRowIndex(ctx);
            const tq = params.anchor_ts;
            const hits = rows.filter((r) => r.ts && (r.ts.includes(tq) || tq.includes(r.ts)));
            if (hits.length === 0) return { content: [{ type: "text", text: i18n(`amem ${actName}: 0 matches for anchor_ts="${tq}". ${_ctxStats(ctx)}\n提示: 从 fetch 概览或 check 输出的 ts 字段复制精确时间戳（如 08-15T02:14:55）。`, `amem ${actName}: 0 matches for anchor_ts="${tq}". ${_ctxStats(ctx)}\nTip: copy an exact timestamp from the fetch overview or the ts field of check output (e.g. 08-15T02:14:55).`) }], details: {} };
            if (hits.length > 1) {
              const list = hits.map((h) => `  ts=${h.ts} [${h.start}..${h.end}] type=${h.label}`).join("\n");
              return { content: [{ type: "text", text: i18n(`amem ${actName}: ${hits.length} records match anchor_ts="${tq}". 用更精确的时间戳重试。\n${list}`, `amem ${actName}: ${hits.length} records match anchor_ts="${tq}". Retry with a more precise timestamp.\n${list}`) }], details: {} };
            }
            a = { begin_index: hits[0].start, end_index: hits[0].end, length: hits[0].end - hits[0].start };
          } else if (hasTsRange) {
            // 时间范围定位：ts 落在 [ts_from, ts_to] 内的行，区间取首行 start 到尾行 end。
            // 用途：批量归档某时间段的记录（配合 types 过滤，如 ts_from='08-15T02:00' ts_to='08-15T05:00' + types=['think']）。
            const rows = _ctxRowIndex(ctx);
            const fq = params.ts_from || "";
            const tq = params.ts_to || "";
            const inRange = rows.filter((r) => {
              if (!r.ts) return false;
              const ms = _tsToMs(r.ts);
              if (!ms) return false;
              if (fq) {
                const fBase = fq.length < 14 ? fq + ":00".slice(0, 14 - fq.length) : fq;
                if (ms < _tsToMs(fBase)) return false;
              }
              if (tq) {
                const tBase = tq.length < 14 ? tq + ":59".slice(0, 14 - tq.length) : tq;
                if (ms > _tsToMs(tBase)) return false;
              }
              return true;
            });
            if (inRange.length === 0) return { content: [{ type: "text", text: i18n(`amem ${actName}: 0 records in time range "${fq} ~ ${tq}". ${_ctxStats(ctx)}\n提示: 时间范围按前缀匹配（如 ts_from='08-15T02:00' ts_to='08-15T05:00'）。从 fetch 概览的 ts 字段确认范围。`, `amem ${actName}: 0 records in time range "${fq} ~ ${tq}". ${_ctxStats(ctx)}\nTip: time range matches by prefix (e.g. ts_from='08-15T02:00' ts_to='08-15T05:00'). Confirm the range from the ts fields in the fetch overview.`) }], details: {} };
            const first = inRange[0], last = inRange[inRange.length - 1];
            a = { begin_index: first.start, end_index: last.end, length: last.end - first.start };
            // 时间范围模式信息（用于 check 输出的条数提示）
            rangeDesc = `${inRange.length} records in time range "${fq} ~ ${tq}"`;
          } else if (hasPosAnchor) {
            const bi = params.anchor_begin_index, ei = params.anchor_end_index;
            if (bi < 0 || ei > ctx.length || bi >= ei) return { content: [{ type: "text", text: i18n(`ERR: 非法位置 [${bi}..${ei}]，context 长度=${ctx.length}。`, `ERR: invalid position [${bi}..${ei}], context length=${ctx.length}.`) }], details: {}, isError: true };
            a = { begin_index: bi, end_index: ei, length: ei - bi };
          } else {
            const ms = _anchorSearch(ctx, params.anchor_begin, params.anchor_end);
            if (ms.length === 0) return { content: [{ type: "text", text: i18n(`amem ${actName}: 0 anchor matches. ${_ctxStats(ctx)}\n提示: 锚点不在可搜索区（见 manage 提示）。也可改用 exclude_tail=N 免锚点模式。`, `amem ${actName}: 0 anchor matches. ${_ctxStats(ctx)}\nTip: the anchor is not in a searchable area (see manage tips). Alternatively use exclude_tail=N no-anchor mode.`) }], details: {} };
            if (ms.length > 1) return { content: [{ type: "text", text: _multiMatch(`amem ${actName}`, ms, ctx.length) + i18n(`\n提示: 锚定不唯一，用更长唯一片段重试，或改用 exclude_tail=N。`, `\nTip: the anchor is not unique — retry with a longer unique fragment, or switch to exclude_tail=N.`) }], details: {} };
            a = ms[0];
          }
          rStart = a.begin_index; rEnd = a.end_index;
          modeDesc = `anchor [${rStart}..${rEnd}]`;
        } else if (params.exclude_tail != null) {
          // 无锚点 + exclude_tail：扫除尾部 exclude_tail token 外的全部内容。
          // exclude_tail 是用户显式指定的保护线，低于铁律（100K）则拒绝；达到则尊重它，
          // 不再走 _inRecentZone 严格 `<` 判定——否则二分切出的 tail 恰好 ≤100000 时会被误判在保护区（边界 bug）。
          if (params.exclude_tail < RECENT_PROTECT_TOKENS) {
            return { content: [{ type: "text", text: i18n(`amem ${actName}: exclude_tail=${params.exclude_tail} < 铁律 ${RECENT_PROTECT_TOKENS / 1000}K token protection — recent content must stay protected. 请用 exclude_tail=${RECENT_PROTECT_TOKENS} 或更大。\n${_ctxStats(ctx)}`, `amem ${actName}: exclude_tail=${params.exclude_tail} < iron rule ${RECENT_PROTECT_TOKENS / 1000}K token protection — recent content must stay protected. Use exclude_tail=${RECENT_PROTECT_TOKENS} or larger.\n${_ctxStats(ctx)}`) }], details: {} };
          }
          rEnd = _tailCutOffset(ctx, params.exclude_tail);
          modeDesc = `no-anchor, exclude_tail=${params.exclude_tail} tokens → [0..${rEnd}]`;
        }

        // 最近保护区：仅锚点模式/全量模式判定；exclude_tail 模式已在上方显式把关
        if (!(params.exclude_tail != null) && _inRecentZone(ctx, rEnd)) {
          const hint = (rEnd === ctx.length)
            ? `Full-context sweep not allowed — use exclude_tail=N (e.g. 100000) to skip the recent tail, or provide anchor_begin + anchor_end.`
            : `range extends into recent ${RECENT_PROTECT_TOKENS / 1000}K token protection zone — narrow anchors.`;
          return { content: [{ type: "text", text: `amem ${actName}: range extends into recent ${RECENT_PROTECT_TOKENS / 1000}K token protection zone. ${hint}\n${_ctxStats(ctx)}` }], details: {} };
        }

        const rangeText = ctx.slice(rStart, rEnd);
        const lines = rangeText.split("\n");
        // 2026-08-20 修复：概览显示 assistant.think（缩写 a.think），types 直接匹配 o.type 会 0 条——
        // 类型名规范化：a.think / assistant.think → think（同时支持裸名 think/text/toolResult/toolCall）
        const normType = (t: string) => t.replace(/^(a|assistant)\./, "");
        const tSet = new Set(params.types.map(normType));
        const kept: string[] = [], swept: string[] = [];
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("{")) { kept.push(line); continue; }
          try {
            const o = JSON.parse(t);
            // 实际 JSONL 条目：工具结果是 {role:"toolResult", type:"text"}，思考是 {type:"think"} 等。
            // types 同时匹配 role 和 type——sweep(["toolResult"]) 才能命中工具结果记录。
            if (tSet.has(o.role) || tSet.has(o.type)) { swept.push(line); } else { kept.push(line); }
          }
          catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); kept.push(line); }
        }
        const sweptText = swept.join("\n");

        // check
        if (!params.hash_key) {
          // 时间范围模式：check 输出带区间内记录数提示
        const rangeHint = rangeDesc ? ` (${rangeDesc})` : "";
        const key = _amemCreateKey(ctx, { action: "sweep", rStart, rEnd, n: swept.length, c: sweptText.length });
          // 内容预览：前 3 条将被移除记录的文本开头，避免"盲清"
          let preview = "";
          const shown = swept.slice(0, 3);
          if (shown.length) {
            preview = i18n("\n预览(前" + shown.length + "条):\n", "\npreview (first " + shown.length + "):\n");
            for (const ln of shown) {
              let txt = "";
              try {
                const o = JSON.parse(ln);
                const raw = o.text || o.think || o.content || o.tool || "";
                txt = (typeof raw === "string" ? raw : JSON.stringify(raw)).replace(/\n/g, " ");
              } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); txt = ln.slice(0, 80); }
              preview += `  · ${txt.slice(0, 100)}${txt.length > 100 ? "…" : ""}\n`;
            }
          }
          return { content: [{ type: "text", text:
            `amem ${actName} check: ${swept.length} entries (${params.types.join(",")}) in [${rStart}..${rEnd}], ${sweptText.length}c${rangeHint}.\n` +
            `hash_key=${key}${preview}\n${_ctxStats(ctx)}\nProvide hash_key + title(≥10c) + summary(≥50c) to apply.` }],
            details: { hash_key: key, swept_count: swept.length, swept_chars: sweptText.length } };
        }

        // apply
        const v = _amemValidateKey(params.hash_key, ctx);
        if (!v.ok) return { content: [{ type: "text", text: `ERR: ${v.reason}` }], details: {}, isError: true };
        // 复用 check 时锁定的范围——apply 时 ctx 已追加本工具调用记录，重新计算 rEnd 会漂移
        // （保护区判定随之抖动 → check 过 apply 挂）。hash 通过 = context 未变，锁定位置仍然有效。
        if (v.data && typeof v.data.rStart === "number") { rStart = v.data.rStart; rEnd = v.data.rEnd; }
        if (!params.title || params.title.length < 10) return { content: [{ type: "text", text: "ERR: title ≥10c required." }], details: {}, isError: true };
        if (!params.summary || params.summary.length < 50) return { content: [{ type: "text", text: "ERR: summary ≥50c required." }], details: {}, isError: true };
        if (swept.length === 0) return { content: [{ type: "text", text: `amem ${actName}: 0 entries to remove.` }], details: {} };

        // range 锁定后用 apply 时的 ctx 重新切分（位置不变，内容可能含 hash 归一化容忍的自身记录）
        const rangeText2 = ctx.slice(rStart, rEnd);
        const lines2 = rangeText2.split("\n");
        // 2026-08-20 修复：同 archive——类型名规范化（a.think/assistant.think → think），sweep 与 archive 匹配语义一致
        const normType2 = (t: string) => t.replace(/^(a|assistant)\./, "");
        const tSet2 = new Set(params.types.map(normType2));
        const kept2: string[] = [], swept2: string[] = [];
        for (const line of lines2) {
          const t = line.trim();
          if (!t.startsWith("{")) { kept2.push(line); continue; }
          try {
            const o = JSON.parse(t);
            if (tSet2.has(o.role) || tSet2.has(o.type)) { swept2.push(line); } else { kept2.push(line); }
          }
          catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); kept2.push(line); }
        }
        const sweptText2 = swept2.join("\n");
        if (sweptText2.length === 0) return { content: [{ type: "text", text: `amem ${actName}: 0 entries to remove in locked range.` }], details: {} };

        const amId = `am-${Date.now()}`;
        try { fs.mkdirSync(manageDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        const ts = _timeSpan(sweptText2);
        // 交换块：原位留下【总结内容】（标题+摘要+归档指引），不是一行代码 marker——
        // 模型不 revert 也能从总结知道这段记忆讲了什么（用户设计："替换进去的东西应该直接加上这段标题和摘要"）。
        // 附带自解释的替换前后元数据（用户设计："除了数字本身，前面也要写上是什么，否则模型不知道"）。
        const markerBase = `[amem swap ${amId} | ${params.title}]\n${params.summary}`;
        const marker = markerBase + i18n(`\n（记忆交换: 替换前 begin_index=${rStart}, end_index=${rEnd}, length=${rEnd - rStart}, context_length=${ctx.length} → 替换后 begin_index=${rStart}, end_index=${rStart + markerBase.length}, length=${markerBase.length}, context_length=${ctx.length - (rEnd - rStart) + markerBase.length}；交换出 ${swept2.length} 条 ${params.types.join("/")} 记录 ${sweptText2.length}c → ActiveManage/${amId}.json；amem(fetch, id=\"${amId}\") 查原文，amem(revert, id=\"${amId}\") 还原）`, `\n(memory swap: before begin_index=${rStart}, end_index=${rEnd}, length=${rEnd - rStart}, context_length=${ctx.length} → after begin_index=${rStart}, end_index=${rStart + markerBase.length}, length=${markerBase.length}, context_length=${ctx.length - (rEnd - rStart) + markerBase.length}; swapped out ${swept2.length} ${params.types.join("/")} record(s), ${sweptText2.length}c → ActiveManage/${amId}.json; amem(fetch, id=\"${amId}\") to view the original, amem(revert, id=\"${amId}\") to restore)`);
        const modifiedRange = marker + "\n" + kept2.join("\n");
        const newCtx = ctx.slice(0, rStart) + modifiedRange + ctx.slice(rEnd);

        const entry = {
          id: amId, action: actName, title: params.title, summary: params.summary,
          types: params.types, swept_count: swept2.length,
          excised: rangeText2, modified: modifiedRange,
          before: { range_start: rStart, range_end: rEnd, context_length: ctx.length },
          after: { context_length: newCtx.length },
          time_span: ts, timestamp: new Date().toISOString(), reverted: false,
        };
        writeFile(path.join(manageDir, `${amId}.json`), JSON.stringify(entry, null, 2));

        let idx: any = { total_entries: 0, total_excised_chars: 0, entries: [] };
        try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        if (!Array.isArray(idx.entries)) idx.entries = [];
        idx.entries.push({ id: amId, title: params.title, summary: params.summary, path: `ActiveManage/${amId}.json`,
          excised_length: sweptText2.length, revision_length: marker.length, time_span: ts, timestamp: entry.timestamp, reverted: false });
        idx.total_entries = idx.entries.length;
        idx.total_excised_chars = idx.entries.reduce((s: number, e: any) => s + (e.excised_length || 0), 0);
        idx.last_updated = entry.timestamp;
        writeFile(indexPath, JSON.stringify(idx, null, 2));
        writeFile(contextPath, newCtx);

        return { content: [{ type: "text", text:
          `amem ${actName} ${JSON.stringify(params.title)} → removed ${swept2.length} entries (${sweptText2.length}c), archived ${amId}\n` +
          `context_length: ${ctx.length} → ${newCtx.length} (freed ${ctx.length - newCtx.length}c)\n` +
          (ts.earliest ? `time_span: ${ts.earliest} ~ ${ts.latest}\n` : "") + _ctxStats(newCtx) }],
          details: { archived: amId, swept: swept2.length } };
      }

      // ── revert ─────────────────────────────────────────────────────
      if (params.action === "revert") {
        if (!params.id) return { content: [{ type: "text", text: "ERR: id required." }], details: {}, isError: true };
        let d: any = null; try { d = JSON.parse(readFile(path.join(manageDir, `${params.id}.json`))); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        if (!d) return { content: [{ type: "text", text: `ERR: ${params.id} not found.` }], details: {}, isError: true };
        if (d.reverted) return { content: [{ type: "text", text: `ERR: ${params.id} already reverted.` }], details: {}, isError: true };

        const ctx = readFile(contextPath);
        if (!ctx) return { content: [{ type: "text", text: "ERR: context.md empty." }], details: {}, isError: true };

        // 确定搜索文本和还原内容
        let searchText: string, restoreText: string;
        if ((d.action === "sweep" || d.action === "archive" || d.action === "mark") && d.modified) {
          searchText = d.modified; restoreText = d.excised;
        } else {
          searchText = `[amem ${d.id} | ${d.title}]\n${d.summary}\n${d.revision || ""}`;
          restoreText = d.excised;
        }

        let positions = _findAll(ctx, searchText);
        if (positions.length === 0 && d.action !== "sweep" && d.action !== "archive" && d.revision) {
          searchText = d.revision; positions = _findAll(ctx, searchText);
        }
        if (positions.length === 0) return { content: [{ type: "text", text: `amem revert check ${params.id}: 0 matches — text no longer in context.` }], details: {} };
        if (positions.length > 1) return { content: [{ type: "text", text: `amem revert check ${params.id}: ${positions.length} ambiguous matches.` }], details: {} };

        const mIdx = positions[0], mLen = searchText.length;

        // check
        if (!params.hash_key) {
          const key = _amemCreateKey(ctx, { action: "revert", id: params.id, mIdx, mLen });
          return { content: [{ type: "text", text:
            `amem revert check ${params.id}: 1 match, ready. hash_key=${key}\n` +
            `title: ${JSON.stringify(d.title)}\nmatch: index=${mIdx}, length=${mLen}\n` +
            `original: ${restoreText.length}c\nProvide hash_key to apply.` }],
            details: { hash_key: key, matches: 1 } };
        }

        // apply
        const v = _amemValidateKey(params.hash_key, ctx);
        if (!v.ok) return { content: [{ type: "text", text: `ERR: ${v.reason}` }], details: {}, isError: true };

        const newCtx = ctx.slice(0, mIdx) + restoreText + ctx.slice(mIdx + mLen);
        writeFile(contextPath, newCtx);
        d.reverted = true; d.reverted_at = new Date().toISOString();
        writeFile(path.join(manageDir, `${params.id}.json`), JSON.stringify(d, null, 2));

        let idx: any = { entries: [] }; try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        const ie = (idx.entries || []).find((e: any) => e.id === params.id);
        if (ie) { ie.reverted = true; ie.reverted_at = d.reverted_at; }
        idx.total_excised_chars = (idx.entries || []).filter((e: any) => !e.reverted).reduce((s: number, e: any) => s + (e.excised_length || 0), 0);
        idx.last_updated = d.reverted_at;
        writeFile(indexPath, JSON.stringify(idx, null, 2));

        return { content: [{ type: "text", text:
          `amem revert applied ${params.id}: ${JSON.stringify(d.title)}\n` +
          `reverted: index=${mIdx}, ${mLen}c → ${restoreText.length}c\n` +
          `context_length: ${ctx.length} → ${newCtx.length}` }],
          details: { reverted: true } };
      }

      // ── mark_enter ───────────────────────────────────────────────
      if (params.action === "mark_enter") {
        // 持久化：mark 状态写 personDir/active-mark.json，重启后 _activeMark 丢失可从文件恢复（孤儿 temp zone 可清理）
        const markPath = path.join(path.dirname(contextPath), "active-mark.json");
        if (!_activeMark) {
          // 文件不存在是正常（首次 mark）；解析/读取失败才记错
          try { if (fs.existsSync(markPath)) { const m = JSON.parse(fs.readFileSync(markPath, "utf8")); if (m && typeof m.offset === "number" && typeof m.id === "string") _activeMark = m; } } catch (e) { logerr("MEM001", e, markPath); } // mark_enter 读持久化失败
          if (_activeMark) {
            return { content: [{ type: "text", text: i18n(`amem mark_enter: 检测到上次未完成的 mark (${_activeMark.id} @offset ${_activeMark.offset})——进程可能在 mark 期间重启。可用 mark_exit 清理该 temp zone（会清除从 offset 到现在的所有内容，务必先确认），或忽略继续。\n${_ctxStats(readFile(contextPath))}`, `amem mark_enter: detected an unfinished mark from last time (${_activeMark.id} @offset ${_activeMark.offset}) — the process may have restarted mid-mark. Use mark_exit to clean this temp zone (it clears everything from the offset to now — confirm first), or ignore and continue.\n${_ctxStats(readFile(contextPath))}`) }], details: { pending_mark: _activeMark } };
          }
        }
        if (_activeMark) return { content: [{ type: "text", text: `ERR: active mark already exists (${_activeMark.id}). Call mark_exit first.` }], details: {}, isError: true };
        const ctx = readFile(contextPath);
        const offset = ctx.length;
        const markId = `mk-${Date.now()}`;
        _activeMark = { id: markId, offset, ts: Date.now() };
        try { fs.writeFileSync(markPath, JSON.stringify(_activeMark)); } catch (e) { logerr("MEM002", e, markPath); } // mark_enter 写持久化失败
        return { content: [{ type: "text", text:
          `amem mark_enter: ${markId}\n` +
          `Temp zone starts at offset ${offset}. Everything appended after this point can be bulk-removed with mark_exit.\n` +
          `${_ctxStats(ctx)}\n` +
          `Use only when expecting large content (>10% context). Call mark_exit with title + summary + info to exit.` }],
          details: { mark_id: markId, offset } };
      }

      // ── mark_exit ────────────────────────────────────────────────
      if (params.action === "mark_exit") {
        // 从持久化文件恢复（支持重启后清理孤儿 temp zone）
        const markPath = path.join(path.dirname(contextPath), "active-mark.json");
        if (!_activeMark) {
          // 从持久化文件恢复（支持重启后清理孤儿 temp zone）；文件不存在是正常路径
          try { if (fs.existsSync(markPath)) { const m = JSON.parse(fs.readFileSync(markPath, "utf8")); if (m && typeof m.offset === "number" && typeof m.id === "string") _activeMark = m; } } catch (e) { logerr("MEM003", e, markPath); } // mark_exit 读持久化恢复失败
        }
        if (!_activeMark) return { content: [{ type: "text", text: "ERR: no active mark. Call mark_enter first." }], details: {}, isError: true };
        if (params.id && params.id !== _activeMark.id) return { content: [{ type: "text", text: `ERR: mark_id mismatch. Active: ${_activeMark.id}, got: ${params.id}` }], details: {}, isError: true };
        if (!params.title || params.title.length < 10) return { content: [{ type: "text", text: `ERR: title ≥10c required.` }], details: {}, isError: true };
        if (!params.summary || params.summary.length < 50) return { content: [{ type: "text", text: `ERR: summary ≥50c required.` }], details: {}, isError: true };
        if (!params.info) return { content: [{ type: "text", text: "ERR: info required — the key information you want to keep from the temp zone." }], details: {}, isError: true };

        const ctx = readFile(contextPath);
        const mark = _activeMark;
        const tempZone = ctx.slice(mark.offset);
        const tempLen = tempZone.length;

        if (tempLen < 100) {
          _activeMark = null;
          try { fs.unlinkSync(markPath); } catch (e) { logerr("MEM004", e, markPath); } // mark_exit tiny 清理删持久化失败
          return { content: [{ type: "text", text: "amem mark_exit: temp zone is tiny (<100c), nothing to clean. Mark cleared." }], details: {} };
        }

        const amId = `am-${Date.now()}`;
        try { fs.mkdirSync(manageDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        const ts = _timeSpan(tempZone);

        const block = `[amem mark ${amId} | ${params.title}]\n${params.summary}\n${params.info}`;
        const newCtx = ctx.slice(0, mark.offset) + block;

        const entry = {
          id: amId, action: "mark", title: params.title, summary: params.summary,
          info: params.info, mark_id: mark.id,
          excised: tempZone,
          modified: block, // revert 定位所需的替换后文本（之前缺失 → mark 的 revert 报 0 matches）
          before: { offset: mark.offset, temp_length: tempLen, context_length: ctx.length },
          after: { context_length: newCtx.length },
          time_span: ts, timestamp: new Date().toISOString(), reverted: false,
        };
        writeFile(path.join(manageDir, `${amId}.json`), JSON.stringify(entry, null, 2));

        let idx: any = { total_entries: 0, total_excised_chars: 0, entries: [] };
        try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        if (!Array.isArray(idx.entries)) idx.entries = [];
        idx.entries.push({ id: amId, title: params.title, summary: params.summary, path: `ActiveManage/${amId}.json`,
          excised_length: tempLen, revision_length: block.length, time_span: ts, timestamp: entry.timestamp, reverted: false });
        idx.total_entries = idx.entries.length;
        idx.total_excised_chars = idx.entries.reduce((s: number, e: any) => s + (e.excised_length || 0), 0);
        idx.last_updated = entry.timestamp;
        writeFile(indexPath, JSON.stringify(idx, null, 2));
        writeFile(contextPath, newCtx);

        _activeMark = null;
        try { fs.unlinkSync(markPath); } catch (e) { logerr("MEM005", e, markPath); } // mark_exit 删持久化失败

        return { content: [{ type: "text", text:
          `amem mark_exit ${JSON.stringify(params.title)}, archived ${amId}\n` +
          `temp zone: ${tempLen}c removed (offset ${mark.offset})\n` +
          `context_length: ${ctx.length} → ${newCtx.length} (freed ${ctx.length - newCtx.length}c)\n` +
          `${_ctxStats(newCtx)}\n` +
          `─── kept info ───\n${params.info}` }],
          details: { archived: amId, freed: ctx.length - newCtx.length } };
      }

      return { content: [{ type: "text", text: `ERR: unknown action ${params.action}` }], details: {}, isError: true };
    },
  });


  // [2026-08-15] self_reboot 已移入 execute 工具作为特殊命令（execute({command:"self-reboot 原因"})）
  // 不再是独立工具。授权机制：/a self-reboot → RuntimeCache/self-reboot-auth → execute 拦截 → wake-restart → exit

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
        return { content: [{ type: "text", text: "nap 已在运行中。" }], details: {} };
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
      "Enter deep sleep. Launches an INDEPENDENT sleep session (separate pi instance with sleep.dlc) " +
      "that consolidates work_memory into cortex using 1% partial edit. " +
      "The sleep session runs in tmux (sl-<personId>), just like hippocampus (hc) and metaconsciousness (sc). " +
      "You (the main consciousness) should hibernate after calling this — the sleep session does the work.",
    promptSnippet: "Sleeping: launch independent sleep session (separate pi instance, one-shot consolidation)",
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
        content: [{ type: "text", text: i18n("Sleep 不可用。请使用 nap 代替。", "Sleep unavailable. Use nap instead.") }],
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
