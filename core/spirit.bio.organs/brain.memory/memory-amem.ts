// memory-amem.ts — amem 工具（Active Memory）从 memory.ts 分离。
// 本文件由 memory.ts 的 amem 段（原 L938-2110）**整段搬移**而来，逻辑未改写；只做了三件事：
//  1) 外层局部符号改为 deps 注入（personDir/modelMax/_pondSess/refreshModelMax/refreshGauge）
//  2) _amemSeed（原 L938，只 amem 用）随段一起搬入
//  3) _fmtLocalTs（原 amem 段内，但 memory.ts L777 也用）导出供 memory.ts 导入
//
// 文档: B.docs/Dev.Common/Wiki/Amem(Brain Tool).WIKI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { getSessionRole, getPrompt } from "#kernel_ribosome";
import { memoryDir, personDataDir as _personDataDir, memoryDataDir, sessionDirFor, estimateTokens, monitorDataFile, runtimeCacheDir as _runtimeCacheDir, readGrowthLast } from "#paths";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage, SYM } from "#tui_blockrender";
import { createHash, randomBytes } from "node:crypto";
import { logerr } from "#paths";
import { appendAsync } from "#kernel_nerves";
import { i18n } from "#tui_localizations";
import { readFile, writeFile } from "./memory.ts";

export interface AmemDeps {
  personDir: () => string | null;
  modelMax: () => number;
  pondSess: { tokens: number; prevPrompt: number | null; prevOut: number };
  refreshModelMax: () => void;
  refreshGauge: (ctx: string) => void;
}

export function registerAmemTool(pi: ExtensionAPI, deps: AmemDeps): void {
  const _amemSeed = randomBytes(16).toString("hex");
  const _pendingKeys = new Map<string, { ctxHash: string; data: any; ts: number }>();
  // 尾部保护区（ISSUE 147）：从硬编码 100K 改成「窗口的 10%，下限 20K」——
  // 对 1M 模型结果仍是 100K（行为不变），对 256K 本地模型则是 25.6K（原来是 100K = 真实窗口的 39%，等于砍掉一半可用 context）。
  let RECENT_PROTECT_TOKENS = 100000;
  function _refreshAmemLimits(): void {
    deps.refreshModelMax();
    RECENT_PROTECT_TOKENS = Math.max(20000, Math.floor(deps.modelMax() * 0.1));
  }
  _refreshAmemLimits();

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
      } catch { /* 坏行（截断/历史格式）：原样计入 hash（只需稳定），不刷日志——每次 check/apply 都会全文跑一遍 */ out.push(line); }
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
      // 2026-09-13（M6）：本地格式没有年份——先按当年解析，若落到"明天之后"则按去年
      //（否则跨年后 12 月的记录/区间全被算成明年，anchor_ts / ts_from~ts_to 全部失配）
      const y = new Date().getFullYear();
      let d = new Date(`${y}-${s.slice(0, 14)}`);
      if (isNaN(d.getTime())) return 0;
      if (d.getTime() > Date.now() + 86400e3) d = new Date(`${y - 1}-${s.slice(0, 14)}`);
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
      } catch { /* 坏行：无时间戳可取，跳过不刷日志 */ }
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
    const rows: { start: number; end: number; label: string; ts: string; tsMs: number; isToolZone: boolean }[] = [];
    let pos = 0;
    for (const line of ctxContent.split("\n")) {
      const start = pos;
      const end = start + line.length;
      let label = "nonJson";
      let ts = "";
      let tsMs = 0; // 2026-09-13（M6）：保留原始毫秒（含年份）——时间范围比较直接用它，不再从无年份的字符串反推
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
            if (!isNaN(d.getTime())) { tsMs = d.getTime(); ts = _fmtLocalTs(tsMs); }
          }
          // 工具区：toolCall（任何工具的调用参数）+ toolResult（工具输出）
          if (type === "toolCall" || role === "toolResult") isToolZone = true;
        } catch { /* 坏行：按 nonJson 处理，不刷日志（每次 check/apply/fetch 都会全文跑一遍） */ }
      } else if (/^\[amem |^\[memory op:|^\[Napped\.|^（记忆交换: |^\(memory swap: /.test(t)) {
        // 压缩 marker / amem 归档块头 / 记忆操作记录 / 交换元数据行 = 工具区产物（块内的 summary/revision 是记忆本体，仍可被锚点命中）
        isToolZone = true;
      }
      rows.push({ start, end, label, ts, tsMs, isToolZone });
      pos = end + 1; // +1 换行符
    }
    return rows;
  }
  type CtxRow = ReturnType<typeof _ctxRowIndex>[number];
  // 二分找 pos 所在行（行区间 [start, end]，end 处是换行符本身，归属该行；行首尾相接，任意 pos 恰落一行）
  function _rowAt(rows: CtxRow[], pos: number): CtxRow | undefined {
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const r = rows[mid]; if (pos < r.start) hi = mid - 1; else if (pos > r.end) lo = mid + 1; else return r; }
    return undefined;
  }
  // 把 [bi, ei) 对齐到整行：begin → 所在行行首，end → (ei-1) 所在行行尾（不含换行符）
  function _snapToRows(rows: CtxRow[], bi: number, ei: number): { begin: number; end: number } {
    const rb = _rowAt(rows, bi), re = _rowAt(rows, Math.max(bi, ei - 1));
    return { begin: rb ? rb.start : bi, end: re ? re.end : ei };
  }

  // 锚点搜索：排除工具区（isToolZone 行）内的命中——根治自污染。
  // 返回每个匹配附带所属记录类型 + 时间戳（排除后 think/text 双份问题也大幅缓解）。
  // 2026-09-13（H1）：命中范围对齐到整条 JSONL 记录——begin 扩到所在行行首、end 扩到所在行行尾。
  // 之前按字符偏移原样切：[amem …] 块被插进某行 "text":"…" 字符串中间（实测 9760c70f 10 处、4d3c397c 5 处），
  // 那一行从此不是 JSON——失去 type/ts 标签、工具区排除失效、快照不压缩、每次解析刷错。ts/index 定位本来就是整行，这里对齐。
  function _anchorSearch(text: string, b: string, e: string) {
    const rows = _ctxRowIndex(text);
    const r: { begin_index: number; end_index: number; length: number; type?: string; ts?: string }[] = [];
    const seen = new Set<string>();
    let from = 0;
    while (from < text.length && r.length < 200) {
      const bi = text.indexOf(b, from); if (bi < 0) break;
      // 命中起点属于哪条记录；若在工具区内则跳到下一行继续搜
      const hit = _rowAt(rows, bi);
      if (hit?.isToolZone) { from = hit.end + 1; continue; }
      // 结束锚点同样跳过工具区行（toolResult/toolCall 里出现的锚点文字不算结束点——否则范围会在工具输出中间截止）
      let ei = text.indexOf(e, bi + b.length);
      while (ei >= 0) { const er = _rowAt(rows, ei); if (er?.isToolZone) { ei = text.indexOf(e, er.end + 1); continue; } break; }
      if (ei < 0) break;
      const end = ei + e.length;
      const snapped = _snapToRows(rows, bi, end);
      const sig = `${snapped.begin}:${snapped.end}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        r.push({ begin_index: snapped.begin, end_index: snapped.end, length: snapped.end - snapped.begin, type: hit?.label, ts: hit?.ts });
      }
      from = Math.max(end, snapped.end);
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

  // 2026-09-16（用户定稿）：max_tokens=1 探针——prevPrompt 是上一轮过时值，发一条最小请求拿当前真实 prompt_tokens。
  // 复用 pi 的 getApiKeyAndHeaders（auth 解析） + model.baseUrl/id；失败静默 fallback prevPrompt。
  // 全局缓存 __genshinProbeTokens 供 footer/gauge/infos/amem 所有显示点读取（当前真实值，不再用过时值/est）。
  if ((globalThis as any).__genshinProbeTokens === undefined) (globalThis as any).__genshinProbeTokens = null;
  async function _probeContextTokens(): Promise<void> {
    try {
      const model = (globalThis as any).__genshinGetModel?.();
      const reg = (globalThis as any).__genshinModelRegistry?.();
      if (!model || !reg?.getApiKeyAndHeaders) return;
      const auth = await reg.getApiKeyAndHeaders(model);
      const apiKey = auth?.apiKey;
      const baseUrl = model?.baseUrl;
      const modelId = model?.id || model?.modelId;
      if (!apiKey || !baseUrl || !modelId) return;
      // 2026-09-16（用户定稿）：探针必须带完整 context（system+messages+tools）——否则 API 返回的 prompt_tokens
      // 是探针请求自身的小 token 数，不是 context 占用（之前只发 "hi" 导致 footer 显示 0.0%）。缓存命中，成本低。
      const session = (globalThis as any).__genshinGetSession?.();
      const st = session?.agent?.state;
      const msgs: any[] = [];
      if (st?.systemPrompt) msgs.push({ role: "system", content: st.systemPrompt });
      for (const m of (st?.messages || [])) {
        if (!m || !m.role) continue;
        // 完整保留 provider 消息字段（tool_calls/tool_call_id/name）——只取 role+content 会丢工具调用，
        // OpenAI 兼容 API 对 tool 消息缺 tool_call_id / assistant 有 tool_calls 无 tool 结果会 400 → 探针失败。
        const msg: any = { role: m.role, content: m.content };
        if (m.tool_calls !== undefined) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id !== undefined) msg.tool_call_id = m.tool_call_id;
        if (m.name !== undefined) msg.name = m.name;
        msgs.push(msg);
      }
      const reqBody: any = { model: modelId, messages: msgs, max_tokens: 1, stream: false };
      if (Array.isArray(st?.tools) && st.tools.length) reqBody.tools = st.tools;
      const resp = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, ...(auth?.headers || {}) },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return;
      const j: any = await resp.json();
      if (typeof j?.usage?.prompt_tokens === "number") {
        // 2026-09-16（windows agent 实测：headless 探针报 0%/1.2k，真实 444k——payload 几乎是空的）：
        // 自检：prompt_tokens 太小说明拿到的 messages/tools 是空的（headless 拿不到完整 context），
        // 不写探针（保持 null → fallback prevPrompt 真实值），避免把假 0% 当真显示误导注入裁剪/footer。
        if (j.usage.prompt_tokens >= 5000) (globalThis as any).__genshinProbeTokens = j.usage.prompt_tokens;
      }
    } catch { /* 探针失败静默——fallback prevPrompt */ }
  }
  (globalThis as any).__genshinProbeContextTokens = _probeContextTokens;

  function _ctxStats(_ctxContent: string): string {
    const ft = (n: number) => n < 1000 ? n + "" : n < 1e6 ? (n / 1000).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
    const pct = (n: number) => deps.modelMax() > 0 ? Math.round((n / deps.modelMax()) * 100) : 0;
    // 2026-09-16（用户定稿）：est（estimateTokens 文件体量估算，CJK×1.8 经验式）是垃圾——比真实 API 值高 30%+，
    // 且 amem 后文件缩水但活窗口不降（ISSUE 204）误导。全部清理，改用**真实值**：优先探针（max_tokens=1 请求拿当前
    // prompt_tokens，见 _probeContextTokens），探针未完成时 fallback prevPrompt（上一轮 API 真实值，同 gauge/footer 源）。
    const api = (globalThis as any).__genshinProbeTokens ?? deps.pondSess.prevPrompt;
    return api ? `api window ${ft(api)} tok (${pct(api)}%, ${(globalThis as any).__genshinProbeTokens ? "probe" : "last turn"})` : "api window 待首轮请求";
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
      } catch { /* 坏行按 nonJson 计，不刷日志 */ nonJson++; }
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
      } catch { /* 坏行：跳过不刷日志 */ }
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

  // JSONL 行分类（archive 的 types 匹配用；名字与 fetch 概览一致）：
  //   toolResult（工具结果，实际行是 {role:"toolResult",type:"text"}）/ toolCall / user / think / text（仅 assistant 可见输出）/ bad_frame / 其他按 role
  // 2026-09-13（H2）：之前 `tSet.has(o.role) || tSet.has(o.type)` 让 "text" 同时命中 user 消息与 toolResult 行——语义混淆，也是守卫绕过面。
  function _rowKind(o: any): string {
    if (!o) return "?";
    if (o.type === "bad_frame") return "bad_frame";
    if (o.role === "toolResult" || o.role === "tool") return "toolResult:" + (o.toolName || o.tool?.name || "?");
    // 2026-09-17（用户）：toolCall 细分到工具名——`types:["toolCall:execute"]` 可单独归档某一类
    // （execute/edit/write/read/wait/... 各算一类）。通用 `toolCall` 仍匹配全部（matchRow 前缀）。
    if (o.type === "toolCall") return "toolCall:" + (o.tool?.name || "?");
    if (o.role === "user") return "user";
    if (o.role === "assistant") return o.type || "assistant";
    return o.role || o.type || "?";
  }
  const _normType = (t: string) => String(t).replace(/^(a|assistant)\./, "");
  // 归档索引重算（口径统一：total_excised_chars 只算未 revert 的条目——之前新增时算全部、revert 时只算未 revert，两边打架）
  function _recalcIdx(idx: any): void {
    if (!Array.isArray(idx.entries)) idx.entries = [];
    idx.total_entries = idx.entries.length;
    idx.total_excised_chars = idx.entries.filter((e: any) => !e.reverted).reduce((s: number, e: any) => s + (e.excised_length || 0), 0);
  }
  // 软错误（定位失败/保护区/多匹配等）：isError:true → 红点与红字统一走 result.isError
  //（此前 renderResult 靠自己的正则判红，把 fetch/review 的正常输出也染红了）
  const _soft = (text: string, details: any = {}) => ({ content: [{ type: "text" as const, text }], details, isError: true });

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
      "  - Text anchors snap to whole JSONL rows (begin→row start, end→row end); the recent tail (10% of the window, min 20K; 100K on 1M) is protected from editing.\n" +
      "  - apply reuses the range locked by check (no re-search); types must match the check.",
    promptSnippet: "amem: manage/archive(sweep)/fetch/revert/memory-reboot with hash-lock, recent-zone protection, ts-range bulk archive",
    renderCall(args: any, theme: any) {
      const a = args?.action || "";
      const phase = args?.hash_key ? theme.fg("success", "apply") : a === "fetch" || a === "mark_enter" || a === "mark_exit" || a === "memory-reboot" ? "" : theme.fg("warning", "check");
      // 调用行带归档名字：◦ Amem archive [apply] 上游同步与官方文档挖掘归档
      const title = args?.title || args?.summary || "";
      const phaseStr = phase ? `${a} [${phase}]` : a;
      const detail = title ? `${phaseStr} ${title}` : phaseStr;
      return renderToolCall.label(theme, "Amem", detail);
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const raw = resultContent(result)?.[0]?.text || "";
      // 2026-09-13（L1）：之前 /amem\s+\w+:\s/ 把 "amem fetch: N entries"、"amem review:"、"amem mark_enter:" 的正常输出也判成错误（整段红字），
      // 与 isToolError 的红点判定（只认 ERR:）不一致（绿点+红字）。软错误现在统一带 isError:true，这里只看 isError / ERR: 前缀。
      const isErr = !!(ctx?.isError || result?.isError) || /^ERR:/.test(raw);
      if (!raw || isErr) {
        const cleaned = raw.replace(/^amem\s+\w+:\s*/, "");
        return renderMessage.summary(theme, { ...ctx, isError: true }, cleaned);
      }
      // 2026-09-13（用户）：Amem 输出三态——隐藏 / 折叠（默认，只显一行摘要）/ 显示（完整含参数表格）
      const amemDisplay = (globalThis as any).__genshinAmemDisplay ?? "fold";
      if (amemDisplay === "hide") return renderMessage.silent();
      // 2026-09-13（修复）：这里之前用裸 require——memory.ts 是 ESM（顶部无 createRequire），require 未定义
      // → renderResult 抛 ReferenceError 被 pi 的 catch 静默吞掉 → 走通用 fallback（⎿+原文）——amem 三态从未生效的根因。
      // 改用顶部 import 的组件（L3）。
      const Txt = Text;
      const C = Container;
      const GUTTER = 2;
      const indent = " ".repeat(GUTTER);
      const c = new C();
      const lines = raw.split("\n").filter((l: string) => l.trim());
      const firstLine = lines[0] || "";
      // 2026-09-22（用户：结果行要 "Archived 38.0K tokens" 而不是 "removed 94 entries"）：
      // 这条 9/17 定稿过，但在 amem 分离（memory.ts → memory-amem.ts）时**丢了** → 这里重新收口。
      // 规则：①动词跟命令走（archive/sweep→Archived、manage→Managed、revert→Reverted、fetch→Fetched、mark_*→Marked）
      //       ②体量用 **token**（从原始输出的 `~N tok` 取，≥1000 转成 X.XK tokens），不用字符数/条目数。
      //       ③拿不到 tok（fetch/mark 这类）→ 回退原有摘要，不动。
      const _verb = (() => {
        const a = (firstLine.match(/^amem\s+([a-z_]+)/i)?.[1] || "").toLowerCase();
        if (a === "archive" || a === "sweep") return "Archived";
        if (a === "manage") return "Managed";
        if (a === "revert") return "Reverted";
        if (a === "fetch") return "Fetched";
        if (a === "mark_enter" || a === "mark_exit") return "Marked";
        return "";
      })();
      const _tok = (() => {
        const m = raw.match(/~\s*(\d+)\s*tok/);
        const n = m ? Number(m[1]) : 0;
        if (!Number.isFinite(n) || n <= 0) return "";
        return n >= 1000 ? `${(n / 1000).toFixed(1)}K tokens` : `${n} tokens`;
      })();
      const summary = (_verb && _tok) ? `${_verb} ${_tok}` : firstLine
        .replace(/^amem\s+\w+\s*/, "")
        .replace(/^"[^"]*"\s*→\s*/, "")
        .replace(/\s*\([^)]*\)/, "")
        .replace(/,\s*archived\s+\S+/, "")
        .trim();
      c.addChild(new Txt(indent + theme.fg("dim", SYM.result + "  ") + theme.fg("toolOutput", summary || firstLine), 0, 0));
      // 2026-09-13（用户）：折叠模式 = 只显示上面的摘要行，不显示参数表格
      if (amemDisplay === "fold") return c;
      // 参数表格：找出所有 key: value 行，key 列对齐
      const kvPairs: [string, string][] = [];
      const plainLines: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const ln = lines[i].trim();
        const kv = ln.match(/^([\w_]+)\s*[:：]\s*(.+)/);
        if (kv) kvPairs.push([kv[1], kv[2]]);
        else plainLines.push(ln);
      }
      if (kvPairs.length > 0) {
        const maxKeyLen = Math.max(...kvPairs.map(([k]) => k.length));
        for (const [k, v] of kvPairs) {
          c.addChild(new Txt(indent + "   " + theme.fg("dim", k.padEnd(maxKeyLen)) + "  " + v, 0, 0));
        }
      }
      for (const ln of plainLines) {
        c.addChild(new Txt(indent + "   " + theme.fg("dim", ln), 0, 0));
      }
      return c;
    },
    parameters: Type.Object({
      action: Type.Union([Type.Literal("manage"), Type.Literal("sweep"), Type.Literal("archive"), Type.Literal("fetch"), Type.Literal("revert"), Type.Literal("mark_enter"), Type.Literal("mark_exit"), Type.Literal("memory-reboot")]),
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
      if (!deps.personDir()) return { content: [{ type: "text", text: "ERR: No person directory." }], details: {}, isError: true };
      if (getSessionRole() !== "main") return { content: [{ type: "text", text: "ERR: Only main session." }], details: {}, isError: true };
      _refreshAmemLimits(); // ISSUE 147：按当前模型窗口刷新保护区/容量阈值（切模型后也能跟上）
      // await _probeContextTokens(); // 2026-09-16 用户：禁用垃圾管线（探针 headless 假 0%/1.2k 误导），逐行注释不删；amem 状态行 fallback prevPrompt 真实值

      const contextPath = path.join(deps.personDir()!, "context.md");
      const manageDir = path.join(deps.personDir()!, "ActiveManage");
      const indexPath = path.join(deps.personDir()!, "ActiveManageMemoryIndex.json");
      // 2026-09-11（prime-agent）：`id` 来自 agent 参数，之前**直接拼进路径**（join(manageDir, id + ".json")）——
      // `id: "../../../config/authorize"` 就能读/写 manageDir 之外的**任意 .json**（revert 末尾还会 writeFile 回写同一路径；
      // fetch 有 entries 命中校验、revert 没有）。收口：①只接受内部生成格式 am-<epochMs> ②解析后必须仍在 manageDir 内。
      const _amemManageFile = (id: string): string | null => {
        const clean = String(id).trim().replace(/\.json$/, "");   // 容忍 agent 从索引里抄来的 "am-….json" 写法
        if (!/^am-\d+$/.test(clean)) return null;
        const base = path.resolve(manageDir) + path.sep;
        const f = path.resolve(manageDir, `${clean}.json`);
        return f.startsWith(base) ? f : null;
      };

      // ── memory-reboot（2026-09-22 用户定稿：只重载记忆/上下文，不退出进程、不改代码）──
      // 重新读 context.md → 重建快照并设 _snapshotOverride + 裁剪活对话里的 toolResult/toolCall（复用 archive 的热实现）。
      // 下一轮 LLM 调用就用刷新后的记忆快照，无需重启。直接允许、无需用户授权（与 full-reboot 不同）。
      if (params.action === "memory-reboot") {
        const ctx = readFile(contextPath);
        deps.refreshGauge(ctx);
        return { content: [{ type: "text", text: `amem memory-reboot: 记忆已重新载入（快照下轮替换 + 活对话工具产物已裁剪，不重启进程）。\n${_ctxStats(ctx)}` }] };
      }

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
            const action = d?.action || "manage"; // 历史 manage 归档没写 action 字段（2026-09-13 起写入）——缺省即 manage，否则权重/●◐ 标记都错
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
          if (!e) return { content: [{ type: "text", text: `amem fetch: ${params.id} not found.` }], details: {}, isError: true };
          let d: any = null; { const _mf = _amemManageFile(String(params.id)); try { d = _mf ? JSON.parse(readFile(_mf)) : null; } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); } }
          if (!d) return { content: [{ type: "text", text: `amem fetch: file not readable.` }], details: {}, isError: true };
          const ts = d.time_span || {};
          const tsE = ts.earliest || (ts.latest ? null : d.timestamp);
          const tsL = ts.latest || d.timestamp;
          return { content: [{ type: "text", text:
            `amem fetch ${params.id}:\ntitle: ${JSON.stringify(d.title)}\nsummary: ${JSON.stringify(d.summary)}\n` +
            `excised: ${d.excised?.length || 0}c | ${d.action && d.action !== "manage" ? `modified: ${d.modified?.length || 0}c` : `revision: ${d.revision?.length || 0}c`}\n` +
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
        let r = `amem fetch: ${list.length}${list.length !== entries.length ? `/${entries.length}` : ""} entries` +
          (params.from || params.to ? ` (${params.from || "…"} ~ ${params.to || "…"})` : "") +
          `${shown.length < list.length ? `, showing latest ${shown.length}` : ""}, ${idx.total_excised_chars || 0}c total excised.\n`;
        for (let i = 0; i < shown.length; i++) {
          const e = shown[i], ts = e.time_span || {}, rv = e.reverted ? " [REVERTED]" : "";
          const tsE = ts.earliest || (ts.latest ? null : e.timestamp);
          const tsL = ts.latest || e.timestamp;
          r += `  [${i}] ${e.id} | ${JSON.stringify(e.title || "")} | ${e.excised_length}c | ${_normTs(tsE)} ~ ${_normTs(tsL)}${rv}\n`;
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
        if (!params.hash_key) {
        // ── check：定位（四种任一）→ 保护区 → 发 hash_key（match 随 key 锁定，apply 复用）──
        if (hasTsAnchor) {
          // 按记录时间戳定位：_ctxRowIndex 的 ts 为 MM-DDTHH:MM:SS，支持前缀/包含匹配（如 '08-15T02:14'）
          const rows = _ctxRowIndex(ctx);
          const tq = params.anchor_ts;
          const hits = rows.filter((r) => r.ts && (r.ts.includes(tq) || tq.includes(r.ts)));
          if (hits.length === 0) return { content: [{ type: "text", text: i18n(`amem manage: 0 matches for anchor_ts="${tq}". ${_ctxStats(ctx)}\n提示: 从 fetch 概览或 check 输出的 ts 字段复制精确时间戳（如 08-15T02:14:55）。`, `amem manage: 0 matches for anchor_ts="${tq}". ${_ctxStats(ctx)}\nTip: copy an exact timestamp from the fetch overview or the ts field of check output (e.g. 08-15T02:14:55).`) }], details: {}, isError: true };
          if (hits.length > 1) {
            const list = hits.map((h) => `  ts=${h.ts} [${h.start}..${h.end}] type=${h.label}`).join("\n");
            return { content: [{ type: "text", text: i18n(`amem manage: ${hits.length} records match anchor_ts="${tq}". 用更精确的时间戳重试。\n${list}`, `amem manage: ${hits.length} records match anchor_ts="${tq}". Retry with a more precise timestamp.\n${list}`) }], details: {}, isError: true };
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
            const ms = r.tsMs; // 2026-09-13（M6）：用行自带的原始毫秒（含年份），不再从无年份字符串反推
            if (!ms) return false;
            if (fq) {
              // 2026-08-20 修复：补全目标应是 14 字符 MM-DDTHH:MM:SS（原 19 会把已含秒的 '08-20T10:18:00' 补成 '08-20T10:18:00:00' → new Date Invalid → 0 条）
              const fBase = fq.length < 14 ? fq + ":00".slice(0, 14 - fq.length) : fq;
              if (ms < _tsToMs(fBase)) return false;
            }
            if (tq) {
              const tBase = tq.length < 14 ? tq + ":59".slice(0, 14 - tq.length) : tq;
              if (ms > _tsToMs(tBase) + 999) return false; // 2026-09-13：到秒精度的 ts_to 含整秒（check/概览输出的 ts 就是到秒，agent 照抄不能把最后一条排除掉）
            }
            return true;
          });
          if (inRange.length === 0) return { content: [{ type: "text", text: i18n(`amem manage: 0 records in time range "${fq} ~ ${tq}". ${_ctxStats(ctx)}\n提示: 时间范围按本地时间前缀匹配（如 ts_from='08-15T14:00' ts_to='08-15T15:00'）。从 fetch 概览的 ts 字段确认范围（本地时间）。`, `amem manage: 0 records in time range "${fq} ~ ${tq}". ${_ctxStats(ctx)}\nTip: time range matches by local-time prefix (e.g. ts_from='08-15T14:00' ts_to='08-15T15:00'). Confirm the range from the ts fields in the fetch overview (local time).`) }], details: {}, isError: true };
          const first = inRange[0], last = inRange[inRange.length - 1];
          const begin = first.start, end = last.end;
          // 2026-09-13（M4）：不再在这里提前 return——之前绕过了下方的保护区判定（check 发了 key，apply 才被保护区拒）
          m = { begin_index: begin, end_index: end, length: end - begin, type: `${inRange.length} records in "${fq} ~ ${tq}"`, ts: first.ts };
        } else if (hasPosAnchor) {
          // 直接位置定位：check 返回的 begin_index/end_index（hash-lock 保证 apply 时 context 未变，位置有效）
          const bi = params.anchor_begin_index, ei = params.anchor_end_index;
          if (bi < 0 || ei > ctx.length || bi >= ei) return { content: [{ type: "text", text: i18n(`ERR: 非法位置 [${bi}..${ei}]，context 长度=${ctx.length}。`, `ERR: invalid position [${bi}..${ei}], context length=${ctx.length}.`) }], details: {}, isError: true };
          const rows = _ctxRowIndex(ctx);
          const sn = _snapToRows(rows, bi, ei); // 对齐整行（agent 传来的任意位置也不会切坏 JSONL）
          const hit = _rowAt(rows, sn.begin);
          m = { begin_index: sn.begin, end_index: sn.end, length: sn.end - sn.begin, type: hit?.label, ts: hit?.ts };
        } else {
          const matches = _anchorSearch(ctx, params.anchor_begin, params.anchor_end);
          if (matches.length === 0) return { content: [{ type: "text", text: i18n(`amem manage: 0 matches. ${_ctxStats(ctx)}\nSystem sections not searchable.\n提示: 锚点不在可搜索区。常见原因: ①文本在 system section（DNA/CHRs 声明区）②锚点过长/含换行 ③文本已被 amem 替换压缩。建议: 用 10-20 字符的短锚点（避免换行），或先 amem(fetch) 查看 context 概览后取精确文本，或用 anchor_ts 按时间戳定位。`, `amem manage: 0 matches. ${_ctxStats(ctx)}\nSystem sections not searchable.\nTip: the anchor is not in a searchable area. Common causes: ①text is in a system section (DNA/CHRs declaration area) ②anchor too long / contains newlines ③text already replaced/compressed by amem. Suggestion: use a short 10-20 char anchor (no newlines), or amem(fetch) to view the context overview and take exact text, or locate by timestamp with anchor_ts.`) }], details: {}, isError: true };
          if (matches.length > 1) return { content: [{ type: "text", text: _multiMatch("amem manage", matches, ctx.length) + i18n(`\n提示: 锚定不唯一。推荐: 用 anchor_ts 按记录时间戳定位（免疫双份/自污染），或用 check 输出的 anchor_begin_index/anchor_end_index 直接操作。`, `\nTip: the anchor is not unique. Recommended: locate by record timestamp with anchor_ts (immune to duplication/self-pollution), or use the anchor_begin_index/anchor_end_index from check output directly.`) }], details: {}, isError: true };
          m = matches[0];
        }

        // 最近保护区
        if (_inRecentZone(ctx, m.end_index)) {
          return _soft(`amem manage: match falls in recent ${RECENT_PROTECT_TOKENS/1000}K token protection zone (tail). Only older content can be edited.\n${_ctxStats(ctx)}`);
        }

        // check → 发 hash_key（match 随 key 锁定，apply 复用）
        {
          const key = _amemCreateKey(ctx, { action: "manage", match: m });
          const typeInfo = m.type ? `, type=${m.type}` : "";
          const tsInfo = m.ts ? `, ts=${m.ts}` : "";
          return { content: [{ type: "text", text:
            `amem manage check: 1 match. hash_key=${key}\n` +
            `matched: begin_index=${m.begin_index}, end_index=${m.end_index}, length=${m.length}${typeInfo}${tsInfo}\n` +
            i18n(`提示: 范围已对齐到整条 JSONL 记录。apply 时带 hash_key + 任一定位参数即可——apply 复用本次锁定的范围，不再重新搜索。\n`,
                 `Tip: the range is aligned to whole JSONL records. To apply, pass hash_key plus any locator — apply reuses the range locked by this check, no re-search.\n`) +
            `${_ctxStats(ctx)}\nProvide hash_key + revision + title(≥10c) + summary(≥50c) to apply.` }],
            details: { hash_key: key, match: m } };
        }
        } // end check（!hash_key）

        // ── apply（带 hash_key）──
        // 2026-09-13 重排（M3/M5）：①先校验参数（title/summary/revision）②再核 hash_key（一次性——参数错不白白消费）
        // ③复用 check 锁定的 match，不再重新搜锚点（check→apply 之间 assistant 若在 text 里复述了锚点文字，重搜会变 2 matches；
        //   archive 早在 ISSUE 098 就改成复用锁定范围，manage 一直漏了）
        if (params.revision === undefined || params.revision === null) return { content: [{ type: "text", text: "ERR: revision required." }], details: {}, isError: true };
        if (!params.title || params.title.length < 10) return { content: [{ type: "text", text: `ERR: title ≥10c required (got ${params.title?.length || 0}).` }], details: {}, isError: true };
        if (!params.summary || params.summary.length < 50) return { content: [{ type: "text", text: `ERR: summary ≥50c required (got ${params.summary?.length || 0}).` }], details: {}, isError: true };
        const v = _amemValidateKey(params.hash_key, ctx);
        if (!v.ok) return { content: [{ type: "text", text: `ERR: ${v.reason}` }], details: {}, isError: true };
        if (v.data?.action !== "manage" || !v.data.match) return { content: [{ type: "text", text: "ERR: hash_key was issued for a different action — re-check with action=manage." }], details: {}, isError: true };
        m = v.data.match;
        if (m.begin_index < 0 || m.end_index > ctx.length || m.begin_index >= m.end_index) return { content: [{ type: "text", text: "ERR: locked range no longer valid — re-check." }], details: {}, isError: true };

        const excised = ctx.slice(m.begin_index, m.end_index);
        const ts = _timeSpan(excised);
        const amId = `am-${Date.now()}`;
        try { fs.mkdirSync(manageDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }

        const blockBase = `[amem ${amId} | ${params.title}]\n${params.summary}\n${params.revision}`;
        // 交换总结块：标题+摘要+revision+自解释的替换前后元数据（用户设计："除了数字本身，前面也要写上是什么"）。
        // 2026-09-13：替换后 end_index/length/context_length 必须是【含元数据行自身】的真实值（之前写 blockBase.length，与真实值差一整行）。
        // 元数据行长度依赖其中数字的位数 → 定点迭代（位数稳定即收敛，≤4 轮）。
        const mkMeta = (blockLen: number) => i18n(`\n（记忆交换: 替换前 begin_index=${m.begin_index}, end_index=${m.end_index}, length=${m.length}, context_length=${ctx.length} → 替换后 begin_index=${m.begin_index}, end_index=${m.begin_index + blockLen}, length=${blockLen}, context_length=${ctx.length - m.length + blockLen}；原文归档 ActiveManage/${amId}.json，amem(fetch, id=\"${amId}\") 查原文，amem(revert, id=\"${amId}\") 还原）`, `\n(memory swap: before begin_index=${m.begin_index}, end_index=${m.end_index}, length=${m.length}, context_length=${ctx.length} → after begin_index=${m.begin_index}, end_index=${m.begin_index + blockLen}, length=${blockLen}, context_length=${ctx.length - m.length + blockLen}; original archived at ActiveManage/${amId}.json, amem(fetch, id=\"${amId}\") to view the original, amem(revert, id=\"${amId}\") to restore)`);
        let block = blockBase + mkMeta(blockBase.length);
        for (let i = 0; i < 4; i++) { const next = blockBase + mkMeta(block.length); const done = next.length === block.length; block = next; if (done) break; }
        // 范围已对齐整行：块落在行首，ctx.slice(end) 以换行开头 → 块尾不会与下一条 JSONL 粘连
        const newCtx = ctx.slice(0, m.begin_index) + block + ctx.slice(m.end_index);

        const entry = {
          id: amId, action: "manage", title: params.title, summary: params.summary,
          excised, revision: params.revision || null,
          modified: block, // 2026-09-13（M1）：revert 用它整块定位——之前只按块头+summary+revision 搜，元数据行 revert 后孤儿残留
          anchors: { begin: params.anchor_begin, end: params.anchor_end, ts: params.anchor_ts, ts_from: params.ts_from, ts_to: params.ts_to, begin_index: params.anchor_begin_index, end_index: params.anchor_end_index },
          before: { begin_index: m.begin_index, end_index: m.end_index, length: m.length, context_length: ctx.length },
          after: { begin_index: m.begin_index, end_index: m.begin_index + block.length, length: block.length, context_length: newCtx.length },
          time_span: ts, excised_tokens: estimateTokens(excised), timestamp: new Date().toISOString(), reverted: false,
        };
        writeFile(path.join(manageDir, `${amId}.json`), JSON.stringify(entry, null, 2));

        let idx: any = { total_entries: 0, total_excised_chars: 0, entries: [] };
        try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        if (!Array.isArray(idx.entries)) idx.entries = [];
        idx.entries.push({ id: amId, title: params.title, summary: params.summary, path: `ActiveManage/${amId}.json`,
          excised_length: m.length, excised_tokens: entry.excised_tokens, revision_length: block.length, time_span: ts, timestamp: entry.timestamp, reverted: false });
        _recalcIdx(idx);
        idx.last_updated = entry.timestamp;
        writeFile(indexPath, JSON.stringify(idx, null, 2));
        writeFile(contextPath, newCtx);
        deps.refreshGauge(newCtx);

        const rel = `MemoryData/${path.basename(deps.personDir()!)}/ActiveManage/${amId}.json`;
        return { content: [{ type: "text", text:
          `amem manage ${JSON.stringify(params.title)} → replaced ~${entry.excised_tokens} tok (revision ${block.length}c), archived ${amId}\n` +
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
        // 2026-09-13（H2）：类型名先归一化（a.think / assistant.text → think / text）再查记忆类守卫。
        // 之前守卫查原名、匹配用归一名：`types:["a.text"]`（fetch 概览正是这么显示的）能绕过守卫，免锚点一次把 user/assistant text 全归档。
        // user 消息的 type 可能是 "user_msg"（字符串型消息），也补进名单。
        const normTypes: string[] = Array.from(new Set(params.types.map(_normType)));
        const MEMORY_TYPES = new Set(["user", "user_msg", "text", "assistant", "bad_frame"]);
        // 记忆类禁止条件按模式区分（用户最初设计原话："比如模型可以选择只清除某一区间的工具调用结果或某一区间的其他或者某区间的思考或其他，这些可能也行"）：
        //  - 免锚点全量扫（exclude_tail）：只允许工具区产物——记忆类拒绝（防止误删自己的记忆）
        //  - 锚定区间（文本/ts/index 任一）：允许记忆类——用户显式指定了范围，安全语义由"原位留总结块+可 revert"保证
        const hasTextAnchor = !!(params.anchor_begin && params.anchor_end);
        const hasTsAnchor = !!params.anchor_ts;
        const hasTsRange = !!(params.ts_from || params.ts_to);
        const hasPosAnchor = params.anchor_begin_index != null && params.anchor_end_index != null;
        const isAnchored = hasTextAnchor || hasTsAnchor || hasTsRange || hasPosAnchor;
        const bad = normTypes.filter((t) => MEMORY_TYPES.has(t));
        if (bad.length && !isAnchored) {
          return { content: [{ type: "text", text: i18n(`ERR: ${actName} 免锚点模式不能归档记忆类记录（${bad.join(", ")}）。免锚点全量扫允许：工具区产物（toolResult/toolCall）+ think（思考记录，需 exclude_tail 保护尾部）；若要归档对话记忆（user/text），请用锚定区间（anchor_begin+anchor_end 文本 / anchor_ts 时间戳 / ts_from+ts_to 时间范围 / anchor_begin_index+anchor_end_index 位置）显式指定范围——原位留总结块、可 revert。`, `ERR: ${actName} no-anchor mode cannot archive memory-class records (${bad.join(", ")}). No-anchor full sweep allows: tool-zone products (toolResult/toolCall) + think (thought records, requires exclude_tail protection); to archive conversation memory (user/text), explicitly specify an anchored range (anchor_begin+anchor_end text / anchor_ts timestamp / ts_from+ts_to time range / anchor_begin_index+anchor_end_index position) — a summary block stays in place and it is revertable.`) }], details: {}, isError: true };
        }
        const ctx = readFile(contextPath);
        if (!ctx) return { content: [{ type: "text", text: "ERR: context.md empty." }], details: {}, isError: true };
        // 行匹配：按 _rowKind 分类（toolResult/toolCall/user/think/text/bad_frame），或整 role（"assistant" = 全部 assistant 行）。
        // 之前 `tSet.has(o.role) || tSet.has(o.type)` 让 "text" 同时命中 user 消息和 toolResult 行（后者 type 也是 "text"）。
        const tSet = new Set(normTypes);
        const matchRow = (o: any) => {
          const k = _rowKind(o);
          // 2026-09-17：`toolCall`/`toolResult` 前缀匹配 `toolCall:<工具名>`/`toolResult:<工具名>`（通用选中全部）；
          // `toolCall:execute` / `toolResult:execute` 精确命中一类。
          const _prefixMatch = (k.startsWith("toolCall:") && tSet.has("toolCall")) || (k.startsWith("toolResult:") && tSet.has("toolResult"));
          return tSet.has(k) || _prefixMatch || tSet.has(String(o.role || ""));
        };
        const splitRange = (rs: number, re: number) => {
          const kept: string[] = [], swept: string[] = [];
          for (const line of ctx.slice(rs, re).split("\n")) {
            const t = line.trim();
            if (!t.startsWith("{")) { kept.push(line); continue; }
            let o: any = null; try { o = JSON.parse(t); } catch { /* 坏行：保留原样，不刷日志 */ }
            if (o && matchRow(o)) swept.push(line); else kept.push(line);
          }
          return { kept, swept };
        };

        if (params.hash_key) {
          // ── apply ──（2026-09-13 重排：①参数 ②hash_key ③复用 check 锁定的 rStart/rEnd/types——不重新定位、不重跑保护区判定）
          if (!params.title || params.title.length < 10) return { content: [{ type: "text", text: "ERR: title ≥10c required." }], details: {}, isError: true };
          if (!params.summary || params.summary.length < 50) return { content: [{ type: "text", text: "ERR: summary ≥50c required." }], details: {}, isError: true };
          const v = _amemValidateKey(params.hash_key, ctx);
          if (!v.ok) return { content: [{ type: "text", text: `ERR: ${v.reason}` }], details: {}, isError: true };
          if (v.data?.action !== "sweep" || typeof v.data.rStart !== "number" || typeof v.data.rEnd !== "number") return { content: [{ type: "text", text: `ERR: hash_key was issued for a different action — re-check with action=${actName}.` }], details: {}, isError: true };
          const rStart: number = v.data.rStart, rEnd: number = v.data.rEnd;
          if (rStart < 0 || rEnd > ctx.length || rStart >= rEnd) return { content: [{ type: "text", text: "ERR: locked range no longer valid — re-check." }], details: {}, isError: true };
          // types 必须与 check 一致——否则 check 看到的条数/预览与实际归档不符
          const lockedTypes: string[] = Array.isArray(v.data.types) ? v.data.types : [];
          if (lockedTypes.join(",") !== normTypes.join(",")) return { content: [{ type: "text", text: `ERR: types changed since check (checked: ${lockedTypes.join(",")}; now: ${normTypes.join(",")}) — re-check.` }], details: {}, isError: true };
          const { kept: kept2, swept: swept2 } = splitRange(rStart, rEnd);
          const sweptText2 = swept2.join("\n");
          if (swept2.length === 0) return _soft(`amem ${actName}: 0 entries to remove in locked range.`);
          const rangeText2 = ctx.slice(rStart, rEnd);

          const amId = `am-${Date.now()}`;
          try { fs.mkdirSync(manageDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
          const ts = _timeSpan(sweptText2);
          const keptText = kept2.join("\n");
          // 交换块：原位留下【总结内容】（标题+摘要+归档指引），不是一行代码 marker——
          // 模型不 revert 也能从总结知道这段记忆讲了什么（用户设计："替换进去的东西应该直接加上这段标题和摘要"）。
          // 附带自解释的替换前后元数据（用户设计："除了数字本身，前面也要写上是什么，否则模型不知道"）。
          const markerBase = `[amem swap ${amId} | ${params.title}]\n${params.summary}`;
          const mkMarker = (rangeLen: number) => markerBase + i18n(`\n（记忆交换: 替换前 begin_index=${rStart}, end_index=${rEnd}, length=${rEnd - rStart}, context_length=${ctx.length} → 替换后 begin_index=${rStart}, end_index=${rStart + rangeLen}, length=${rangeLen}, context_length=${ctx.length - (rEnd - rStart) + rangeLen}；交换出 ${swept2.length} 条 ${normTypes.join("/")} 记录 ${sweptText2.length}c → ActiveManage/${amId}.json；amem(fetch, id=\"${amId}\") 查原文，amem(revert, id=\"${amId}\") 还原）`, `\n(memory swap: before begin_index=${rStart}, end_index=${rEnd}, length=${rEnd - rStart}, context_length=${ctx.length} → after begin_index=${rStart}, end_index=${rStart + rangeLen}, length=${rangeLen}, context_length=${ctx.length - (rEnd - rStart) + rangeLen}; swapped out ${swept2.length} ${normTypes.join("/")} record(s), ${sweptText2.length}c → ActiveManage/${amId}.json; amem(fetch, id=\"${amId}\") to view the original, amem(revert, id=\"${amId}\") to restore)`);
          // 2026-09-13：替换后范围 = 总结块 + 保留行（之前只报 markerBase.length，与真实值差一整段）→ 定点迭代；
          // 范围首尾都已对齐整行，块后接保留行或下一条记录之间必有换行（不会粘连）
          const build = (len: number) => { const mk = mkMarker(len); return keptText ? mk + "\n" + keptText : mk; };
          let modifiedRange = build(0);
          for (let i = 0; i < 4; i++) { const next = build(modifiedRange.length); const done = next.length === modifiedRange.length; modifiedRange = next; if (done) break; }
          const newCtx = ctx.slice(0, rStart) + modifiedRange + ctx.slice(rEnd);

          const entry = {
            id: amId, action: actName, title: params.title, summary: params.summary,
            types: normTypes, swept_count: swept2.length,
            excised: rangeText2, modified: modifiedRange,
            before: { range_start: rStart, range_end: rEnd, context_length: ctx.length },
            after: { range_end: rStart + modifiedRange.length, length: modifiedRange.length, context_length: newCtx.length },
            time_span: ts, excised_tokens: estimateTokens(sweptText2), timestamp: new Date().toISOString(), reverted: false,
          };
          writeFile(path.join(manageDir, `${amId}.json`), JSON.stringify(entry, null, 2));

          let idx: any = { total_entries: 0, total_excised_chars: 0, entries: [] };
          try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
          if (!Array.isArray(idx.entries)) idx.entries = [];
          idx.entries.push({ id: amId, title: params.title, summary: params.summary, path: `ActiveManage/${amId}.json`,
            excised_length: sweptText2.length, excised_tokens: entry.excised_tokens, revision_length: modifiedRange.length, time_span: ts, timestamp: entry.timestamp, reverted: false });
          _recalcIdx(idx);
          idx.last_updated = entry.timestamp;
          writeFile(indexPath, JSON.stringify(idx, null, 2));
          writeFile(contextPath, newCtx);
          deps.refreshGauge(newCtx);

          return { content: [{ type: "text", text:
            `amem ${actName} ${JSON.stringify(params.title)} → removed ${swept2.length} entries (${sweptText2.length}c, ~${entry.excised_tokens} tok), archived ${amId}\n` +
            `context_length: ${ctx.length} → ${newCtx.length} (freed ${ctx.length - newCtx.length}c)\n` +
            (ts.earliest ? `time_span: ${ts.earliest} ~ ${ts.latest}\n` : "") + _ctxStats(newCtx) }],
            details: { archived: amId, swept: swept2.length } };
        }

        // ── check ──：定位 → 保护区 → 统计 → 发 hash_key（范围/types 随 key 锁定）
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
            if (hits.length === 0) return { content: [{ type: "text", text: i18n(`amem ${actName}: 0 matches for anchor_ts="${tq}". ${_ctxStats(ctx)}\n提示: 从 fetch 概览或 check 输出的 ts 字段复制精确时间戳（如 08-15T02:14:55）。`, `amem ${actName}: 0 matches for anchor_ts="${tq}". ${_ctxStats(ctx)}\nTip: copy an exact timestamp from the fetch overview or the ts field of check output (e.g. 08-15T02:14:55).`) }], details: {}, isError: true };
            if (hits.length > 1) {
              const list = hits.map((h) => `  ts=${h.ts} [${h.start}..${h.end}] type=${h.label}`).join("\n");
              return { content: [{ type: "text", text: i18n(`amem ${actName}: ${hits.length} records match anchor_ts="${tq}". 用更精确的时间戳重试。\n${list}`, `amem ${actName}: ${hits.length} records match anchor_ts="${tq}". Retry with a more precise timestamp.\n${list}`) }], details: {}, isError: true };
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
              const ms = r.tsMs; // 2026-09-13（M6）：行自带原始毫秒（含年份）
              if (!ms) return false;
              if (fq) {
                const fBase = fq.length < 14 ? fq + ":00".slice(0, 14 - fq.length) : fq;
                if (ms < _tsToMs(fBase)) return false;
              }
              if (tq) {
                const tBase = tq.length < 14 ? tq + ":59".slice(0, 14 - tq.length) : tq;
                if (ms > _tsToMs(tBase) + 999) return false; // 2026-09-13：到秒精度的 ts_to 含整秒（check/概览输出的 ts 就是到秒，agent 照抄不能把最后一条排除掉）
              }
              return true;
            });
            if (inRange.length === 0) return { content: [{ type: "text", text: i18n(`amem ${actName}: 0 records in time range "${fq} ~ ${tq}". ${_ctxStats(ctx)}\n提示: 时间范围按前缀匹配（如 ts_from='08-15T02:00' ts_to='08-15T05:00'）。从 fetch 概览的 ts 字段确认范围。`, `amem ${actName}: 0 records in time range "${fq} ~ ${tq}". ${_ctxStats(ctx)}\nTip: time range matches by prefix (e.g. ts_from='08-15T02:00' ts_to='08-15T05:00'). Confirm the range from the ts fields in the fetch overview.`) }], details: {}, isError: true };
            const first = inRange[0], last = inRange[inRange.length - 1];
            a = { begin_index: first.start, end_index: last.end, length: last.end - first.start };
            // 时间范围模式信息（用于 check 输出的条数提示）
            rangeDesc = `${inRange.length} records in time range "${fq} ~ ${tq}"`;
          } else if (hasPosAnchor) {
            const bi = params.anchor_begin_index, ei = params.anchor_end_index;
            if (bi < 0 || ei > ctx.length || bi >= ei) return { content: [{ type: "text", text: i18n(`ERR: 非法位置 [${bi}..${ei}]，context 长度=${ctx.length}。`, `ERR: invalid position [${bi}..${ei}], context length=${ctx.length}.`) }], details: {}, isError: true };
            const sn = _snapToRows(_ctxRowIndex(ctx), bi, ei); // 对齐整行
            a = { begin_index: sn.begin, end_index: sn.end, length: sn.end - sn.begin };
          } else {
            const ms = _anchorSearch(ctx, params.anchor_begin, params.anchor_end);
            if (ms.length === 0) return { content: [{ type: "text", text: i18n(`amem ${actName}: 0 anchor matches. ${_ctxStats(ctx)}\n提示: 锚点不在可搜索区（见 manage 提示）。也可改用 exclude_tail=N 免锚点模式。`, `amem ${actName}: 0 anchor matches. ${_ctxStats(ctx)}\nTip: the anchor is not in a searchable area (see manage tips). Alternatively use exclude_tail=N no-anchor mode.`) }], details: {}, isError: true };
            if (ms.length > 1) return { content: [{ type: "text", text: _multiMatch(`amem ${actName}`, ms, ctx.length) + i18n(`\n提示: 锚定不唯一，用更长唯一片段重试，或改用 exclude_tail=N。`, `\nTip: the anchor is not unique — retry with a longer unique fragment, or switch to exclude_tail=N.`) }], details: {}, isError: true };
            a = ms[0];
          }
          rStart = a.begin_index; rEnd = a.end_index;
          modeDesc = `anchor [${rStart}..${rEnd}]`;
        } else if (params.exclude_tail != null) {
          // 无锚点 + exclude_tail：扫除尾部 exclude_tail token 外的全部内容。
          // exclude_tail 是用户显式指定的保护线，低于铁律（100K）则拒绝；达到则尊重它，
          // 不再走 _inRecentZone 严格 `<` 判定——否则二分切出的 tail 恰好 ≤100000 时会被误判在保护区（边界 bug）。
          if (params.exclude_tail < RECENT_PROTECT_TOKENS) {
            return { content: [{ type: "text", text: i18n(`amem ${actName}: exclude_tail=${params.exclude_tail} < 铁律 ${RECENT_PROTECT_TOKENS / 1000}K token protection — recent content must stay protected. 请用 exclude_tail=${RECENT_PROTECT_TOKENS} 或更大。\n${_ctxStats(ctx)}`, `amem ${actName}: exclude_tail=${params.exclude_tail} < iron rule ${RECENT_PROTECT_TOKENS / 1000}K token protection — recent content must stay protected. Use exclude_tail=${RECENT_PROTECT_TOKENS} or larger.\n${_ctxStats(ctx)}`) }], details: {}, isError: true };
          }
          rEnd = _tailCutOffset(ctx, params.exclude_tail);
          // 2026-09-13：二分切点可能落在某行中间 → 回退到上一整行行尾（范围只含整条 JSONL 记录；替换后块与下一条之间必有换行）
          if (rEnd >= ctx.length) rEnd = ctx.endsWith("\n") ? ctx.length - 1 : ctx.length;
          else if (ctx[rEnd] !== "\n") { const nl = ctx.lastIndexOf("\n", rEnd - 1); rEnd = nl >= 0 ? nl : 0; }
          modeDesc = `no-anchor, exclude_tail=${params.exclude_tail} tokens → [0..${rEnd}]`;
        }

        // 最近保护区：仅锚点模式/全量模式判定；exclude_tail 模式已在上方显式把关
        if (!(params.exclude_tail != null) && _inRecentZone(ctx, rEnd)) {
          const hint = (rEnd === ctx.length)
            ? `Full-context sweep not allowed — use exclude_tail=N (e.g. 100000) to skip the recent tail, or provide anchor_begin + anchor_end.`
            : `range extends into recent ${RECENT_PROTECT_TOKENS / 1000}K token protection zone — narrow anchors.`;
          return { content: [{ type: "text", text: `amem ${actName}: range extends into recent ${RECENT_PROTECT_TOKENS / 1000}K token protection zone. ${hint}\n${_ctxStats(ctx)}` }], details: {}, isError: true };
        }

        const { swept } = splitRange(rStart, rEnd);
        const sweptText = swept.join("\n");
        // 2026-09-13（L4）：0 条时不发 hash_key（之前发了 key、apply 时才说 0 entries）
        if (swept.length === 0) return _soft(`amem ${actName}: 0 entries of (${normTypes.join(",")}) in ${modeDesc || `[${rStart}..${rEnd}]`} — nothing to archive.\n${_ctxStats(ctx)}`);
        // 时间范围模式：check 输出带区间内记录数提示
        const rangeHint = rangeDesc ? ` (${rangeDesc})` : "";
        const key = _amemCreateKey(ctx, { action: "sweep", rStart, rEnd, n: swept.length, c: sweptText.length, types: normTypes });
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
            } catch { /* 坏行：直接截原文 */ txt = ln.slice(0, 80); }
            preview += `  · ${txt.slice(0, 100)}${txt.length > 100 ? "…" : ""}\n`;
          }
        }
        return { content: [{ type: "text", text:
          `amem ${actName} check: ${swept.length} entries (${normTypes.join(",")}) in [${rStart}..${rEnd}], ${sweptText.length}c${rangeHint}.\n` +
          `hash_key=${key}${preview}\n${_ctxStats(ctx)}\nProvide hash_key + title(≥10c) + summary(≥50c) to apply (same types; the range is locked to this check).` }],
          details: { hash_key: key, swept_count: swept.length, swept_chars: sweptText.length } };
      }

      // ── revert ─────────────────────────────────────────────────────
      if (params.action === "revert") {
        if (!params.id) return { content: [{ type: "text", text: "ERR: id required." }], details: {}, isError: true };
        const _mf = _amemManageFile(String(params.id));
        if (!_mf) return { content: [{ type: "text", text: `ERR: invalid id ${JSON.stringify(params.id)}（只接受本会话 am-<数字> 归档 ID）` }], details: {}, isError: true };
        let d: any = null; try { d = JSON.parse(readFile(_mf)); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        if (!d) return { content: [{ type: "text", text: `ERR: ${params.id} not found.` }], details: {}, isError: true };
        if (d.reverted) return { content: [{ type: "text", text: `ERR: ${params.id} already reverted.` }], details: {}, isError: true };

        const ctx = readFile(contextPath);
        if (!ctx) return { content: [{ type: "text", text: "ERR: context.md empty." }], details: {}, isError: true };

        // 搜索文本 = 归档时写进 context 的替换后文本（modified，manage/archive/mark 现在都存）。
        // 历史 manage 归档没存 modified → 用块头+summary+revision 拼，并把紧随其后的元数据行（（记忆交换: … / (memory swap: …）
        // 一并纳入——否则 revert 后这一行孤儿残留（2026-09-13 M1，实测 7 条活跃 manage 归档都会留）
        const restoreText: string = typeof d.excised === "string" ? d.excised : "";
        let searchText: string = (typeof d.modified === "string" && d.modified) ? d.modified : `[amem ${d.id} | ${d.title}]\n${d.summary}\n${d.revision || ""}`;
        let positions = _findAll(ctx, searchText);
        if (positions.length === 0 && !d.modified && d.revision) { searchText = d.revision; positions = _findAll(ctx, searchText); }
        if (positions.length === 0) return _soft(`amem revert check ${params.id}: 0 matches — text no longer in context (already reverted, or rewritten by a later amem op: revert the newer op first).`);
        if (positions.length > 1) return _soft(`amem revert check ${params.id}: ${positions.length} ambiguous matches.`);
        const mIdx = positions[0]; let mLen = searchText.length;
        if (!d.modified) {
          // 元数据行以 "还原）" / "to restore)" 结尾截止——旧代码（文本锚点未对齐整行时）会把 B 行的剩余部分直接接在元数据行后面，
          // 用 [^\n]* 会连 B 行剩余一起吞掉，revert 后 B 行残缺（2026-09-13 实测 9760c70f am-1786785989398）
          const trail = ctx.slice(mIdx + mLen).match(/^\n(?:（记忆交换: [^\n]*?还原）|\(memory swap: [^\n]*?to restore\))/);
          if (trail) mLen += trail[0].length;
        }

        // check
        if (!params.hash_key) {
          const key = _amemCreateKey(ctx, { action: "revert", id: params.id, mIdx, mLen });
          return { content: [{ type: "text", text:
            `amem revert check ${params.id}: 1 match, ready. hash_key=${key}\n` +
            `title: ${JSON.stringify(d.title)}\nmatch: index=${mIdx}, length=${mLen}\n` +
            `original: ${restoreText.length}c\nProvide hash_key to apply.` }],
            details: { hash_key: key, matches: 1 } };
        }

        // apply：复用 check 锁定的位置（hash 保证 context 未变；位置若对不上则要求重 check）
        const v = _amemValidateKey(params.hash_key, ctx);
        if (!v.ok) return { content: [{ type: "text", text: `ERR: ${v.reason}` }], details: {}, isError: true };
        if (v.data?.action !== "revert" || v.data.id !== params.id) return { content: [{ type: "text", text: "ERR: hash_key was issued for a different action/id — re-check." }], details: {}, isError: true };
        if (v.data.mIdx !== mIdx || v.data.mLen !== mLen) return { content: [{ type: "text", text: "ERR: locked position no longer matches — re-check." }], details: {}, isError: true };

        const newCtx = ctx.slice(0, mIdx) + restoreText + ctx.slice(mIdx + mLen);
        writeFile(contextPath, newCtx);
        deps.refreshGauge(newCtx);
        d.reverted = true; d.reverted_at = new Date().toISOString();
        writeFile(_mf, JSON.stringify(d, null, 2));   // 回写同一路径（_mf 已确认在 manageDir 内）

        let idx: any = { entries: [] }; try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        const ie = (idx.entries || []).find((e: any) => e.id === params.id);
        if (ie) { ie.reverted = true; ie.reverted_at = d.reverted_at; }
        _recalcIdx(idx);
        idx.last_updated = d.reverted_at;
        writeFile(indexPath, JSON.stringify(idx, null, 2));

        return { content: [{ type: "text", text:
          `amem revert applied ${params.id}: ${JSON.stringify(d.title)}\n` +
          `reverted: index=${mIdx}, ${mLen}c → ${restoreText.length}c\n` +
          `context_length: ${ctx.length} → ${newCtx.length}\n${_ctxStats(newCtx)}` }],
          details: { reverted: true } };
      }

      // ── mark_enter ───────────────────────────────────────────────
      if (params.action === "mark_enter") {
        // 持久化：mark 状态写 deps.personDir()/active-mark.json，重启后 _activeMark 丢失可从文件恢复（孤儿 temp zone 可清理）
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

        const block = `[amem mark ${amId} | ${params.title}]\n${params.summary}\n${params.info}\n`;
        // 2026-09-13（M2）：块尾必须换行——之前没有，下一条 JSONL 直接粘在 info 行后（实测 9760c70f 3 处），那条记录从此不是合法 JSON
        const newCtx = ctx.slice(0, mark.offset) + block;

        const entry = {
          id: amId, action: "mark", title: params.title, summary: params.summary,
          info: params.info, mark_id: mark.id,
          excised: tempZone,
          modified: block, // revert 定位所需的替换后文本（之前缺失 → mark 的 revert 报 0 matches）
          before: { offset: mark.offset, temp_length: tempLen, context_length: ctx.length },
          after: { context_length: newCtx.length },
          time_span: ts, excised_tokens: estimateTokens(tempZone), timestamp: new Date().toISOString(), reverted: false,
        };
        writeFile(path.join(manageDir, `${amId}.json`), JSON.stringify(entry, null, 2));

        let idx: any = { total_entries: 0, total_excised_chars: 0, entries: [] };
        try { idx = JSON.parse(readFile(indexPath) || "{}"); } catch (e) { console.error("[spirit.bio.organs/brain.memory/memory.ts] " + ((e as any)?.message || e)); }
        if (!Array.isArray(idx.entries)) idx.entries = [];
        idx.entries.push({ id: amId, title: params.title, summary: params.summary, path: `ActiveManage/${amId}.json`,
          excised_length: tempLen, excised_tokens: entry.excised_tokens, revision_length: block.length, time_span: ts, timestamp: entry.timestamp, reverted: false });
        _recalcIdx(idx);
        idx.last_updated = entry.timestamp;
        writeFile(indexPath, JSON.stringify(idx, null, 2));
        writeFile(contextPath, newCtx);
        deps.refreshGauge(newCtx);

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

}

// ── Helpers ──
// 本地时间格式化：统一用本地时区（不用 UTC），格式 MM-DDTHH:MM:SS（与 anchor_ts/ts_from/ts_to 匹配一致）。
// 用户明确要求：所有时间处理统一本地时间，避免 UTC/本地混用导致时间段匹配不到。
export function _fmtLocalTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

