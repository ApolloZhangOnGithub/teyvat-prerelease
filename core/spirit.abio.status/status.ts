// spirit.abio.status/status.ts — Status 查询入口
// agent 调用 Status @identity 查询身份(plist) + 运行时版本号(startup.log)
// 文档: B.docs/Dev.Common/Wiki/Status(Tool & Concept).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url); // 2026-09-13：@model 里 require(pi-ai models.generated.js) 在 ESM 下 ReferenceError 被 catch 吞掉 → 官方 catalog 从未合并进列表
import { registerPaimonTool } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { readGrowthLast } from "#paths";
const T = (zh: string, en: string) => i18n(zh, en);

// ── Codeforces 风格履历段位（CF 官方 rating 颜色，2015 "Second Revolution of Colors" 改革后至今）──
// tokenmaxxed（RSI-001 社会资历）映射为 CF 段位：灰→绿→青→蓝→紫→橙→红，精确 hex 与 CF 一致。
const CF_RANKS = [
  { min: 0,            name: "Newbie",                 hex: "#808080" },
  { min: 100_000,      name: "Pupil",                  hex: "#008000" },
  { min: 1_000_000,    name: "Specialist",             hex: "#03A89E" },
  { min: 5_000_000,    name: "Expert",                 hex: "#0000FF" },
  { min: 20_000_000,   name: "Candidate Master",       hex: "#AA00AA" },
  { min: 80_000_000,   name: "Master",                 hex: "#FF8C00" },
  { min: 300_000_000,  name: "International Master",   hex: "#FF8C00" },
  { min: 1_000_000_000, name: "Grandmaster",           hex: "#FF0000" },
  { min: 3_000_000_000, name: "International Grandmaster", hex: "#FF0000" },
  { min: 10_000_000_000, name: "Legendary Grandmaster", hex: "#FF0000" },
];
export function getCfRank(tok: number) {
  let r = CF_RANKS[0];
  for (const c of CF_RANKS) if (tok >= c.min) r = c;
  return r;
}
export function cfAnsi(hex: string) {
  return `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
}
export function cfPaint(hex: string, text: string) {
  return `${cfAnsi(hex)}${text}\x1b[39m`;
}

// ── DeepSeek 余额查询（2026-09-23 用户：余额预警；footer + status @balance 共用）──
async function checkDeepseekBalance(): Promise<any> {
  const g = globalThis as any;
  const model = g.__genshinGetModel?.();
  const provider = model?.provider || "";
  const modelId = model?.id || model?.model || "unknown";
  if (provider !== "deepseek") {
    return { unavailable: true, provider, model: modelId, last_updated: Date.now() };
  }
  try {
    const reg = g.__genshinModelRegistry?.();
    const auth = (await reg?.getApiKeyAndHeaders?.(model)) || {};
    const key = (auth?.headers?.Authorization || "").replace(/^Bearer\s+/i, "") || auth?.apiKey || "";
    if (!key) return { unavailable: true, provider, model: modelId, reason: "no key", last_updated: Date.now() };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return { unavailable: true, provider, model: modelId, http: res.status, last_updated: Date.now() };
    const data = (await res.json()) as any;
    const info = data?.balance_infos?.[0] || {};
    const r = {
      provider, model: modelId,
      is_available: !!data?.is_available,
      currency: info.currency || "",
      total_balance: info.total_balance || "0",
      granted_balance: info.granted_balance || "0",
      topped_up_balance: info.topped_up_balance || "0",
      last_updated: Date.now(),
    };
    g.__genshinBalanceCache = r;
    return r;
  } catch (e: any) {
    return { unavailable: true, provider, model: modelId, error: String(e?.message || e), last_updated: Date.now() };
  }
}
(globalThis as any).__genshinCheckBalance = checkDeepseekBalance;

export function registerStatusTool(_pi: ExtensionAPI) {
  registerPaimonTool({
    name: "status",
    label: "Status",
    messageDescription: "Query yourself. Usage: status @identity | status @history [N] | status @nickname <name> | status @model | status @balance | status @permissions | status switch-model <id>",
    promptSnippet: "status @identity — query identity | status @history [N] — session 存续时期 | status @nickname <name> — set nickname | status @model — list models | status @balance — 查余额（deepseek 实时/非 deepseek unavailable）| status @permissions — 授权状态 | status switch-model <id> — switch model (needs /a model auth)",
    parameters: Type.Object({
      instruction: Type.String({ messageDescription: i18n("指令：@identity | @history [N 最近几个 session] | @nickname <名字> | @model（可用模型列表）| @balance（查余额）| @permissions（授权状态）| switch-model <模型id>（切换模型，需 /a model 授权）", "Instruction: @identity | @history [N recent sessions] | @nickname <name> | @model (available models) | @balance (query balance) | @permissions (authorization status) | switch-model <id> (switch model, needs /a model auth)") }),
    }),
    renderCall(args: any, theme: any) {
      return renderToolCall.label(theme, "status", args?.instruction || "");
    },
    renderResult(result: any, _opts: any, t: any, ctx: any) {
      if (ctx?.isError) return renderMessage.summary(t, { isError: true }, (result?.content || [])[0]?.text);
      const text = (result?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      // 2026-09-23：@permissions/@model 等表格结果走 markdown 渲染（含表格），其余走 output（纯文本）
      if (result?.details?.markdown) return renderMessage.markdown(t, ctx, [{ type: "text", text }]);
      return renderMessage.output(t, ctx, [{ type: "text", text }]);
    },
    async execute(_id: any, params: any) {
      const pid = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID;
      if (!pid) return { content: [{ type: "text", text: T("无法确定 agent ID", "Cannot determine agent ID") }], isError: true };
      if (!params?.instruction) return { content: [{ type: "text", text: T("用法: status @identity | status @nickname <名字> | status @permissions", "Usage: status @identity | status @nickname <name> | status @permissions") }], isError: true };
      // @balance：查询当前 provider 的余额（deepseek 走 /user/balance；非 deepseek → unavailable）
      if (params.instruction === "@balance" || params.instruction.startsWith("@balance")) {
        const r = await checkDeepseekBalance();
        (globalThis as any).__genshinBalanceCache = r;
        if (r.unavailable) {
          return { content: [{ type: "text", text: T(
            `余额查询: unavailable（provider=${r.provider}, model=${r.model}）${r.http ? " HTTP " + r.http : ""}${r.reason ? " (" + r.reason + ")" : ""}${r.error ? " " + r.error : ""}`,
            `Balance: unavailable (provider=${r.provider}, model=${r.model})${r.http ? " HTTP " + r.http : ""}`) }] };
        }
        const dt = new Date(r.last_updated).toLocaleTimeString();
        return { content: [{ type: "text", text: T(
          `DeepSeek 余额: ${r.total_balance} ${r.currency}${r.is_available ? "" : "（不可用）"}\n  赠送 ${r.granted_balance} + 充值 ${r.topped_up_balance}\n  ${r.provider}:${r.model}\n  last updated: ${dt}`,
          `DeepSeek balance: ${r.total_balance} ${r.currency}${r.is_available ? "" : " (unavailable)"}\n  granted ${r.granted_balance} + topped up ${r.topped_up_balance}\n  ${r.provider}:${r.model}\n  last updated: ${dt}`) }] };
      }
      // @history：列出自己的所有存续时期（session 生命周期，来自 sessions.log：start/end 事件配对）
      // status @history → 全部；status @history N → 最近 N 个 session
      if (params.instruction.startsWith("@history")) {
        try {
          const logDir = join(homedir(), ".teyvat", "LogData", pid);
          const slog = join(logDir, "sessions.log");
          if (!existsSync(slog)) {
            // 兼容旧数据：无 sessions.log 时退回 startup.log（只有启动时间，无真实结束/原因）
            const sl2 = join(logDir, "startup.log");
            if (!existsSync(sl2)) return { content: [{ type: "text", text: T("无会话记录", "No session records") }] };
            const raw2 = readFileSync(sl2, "utf8").trim().split("\n").filter(Boolean);
            const now = Date.now();
            const fmt2 = (ts: string) => { const d = new Date(ts); if (isNaN(d.getTime())) return "?"; const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
            const dur2 = (a: number, b: number) => { const s = Math.round(Math.max(0, b - a) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
            const recs = raw2.map((l, i) => { const o = JSON.parse(l); return { i: i + 1, ts: o.ts || "", v: (o.genshin || "?").match(/20260815\.(\d+)/)?.[1] || o.genshin || "?" }; }).filter((r) => r.ts);
            let n2 = recs.length;
            const m2 = params.instruction.match(/@history\s+(\d+)/);
            if (m2) n2 = Math.max(1, Math.min(recs.length, parseInt(m2[1], 10)));
            const from2 = recs.length - n2;
            const lines2 = [T(`Session 存续时期 (共 ${recs.length} 次启动${n2 < recs.length ? `，显示最近 ${n2} 个` : ""}) — 旧数据（无真实结束/原因）:`, `Session periods (${recs.length} startups${n2 < recs.length ? `, showing last ${n2}` : ""}) — legacy data (no real end/reason):`)];
            for (let i = from2; i < recs.length; i++) {
              const r = recs[i];
              const start = new Date(r.ts).getTime();
              const end = i + 1 < recs.length ? new Date(recs[i + 1].ts).getTime() : now;
              lines2.push(`  #${String(r.i).padStart(2, " ")}  ${fmt2(r.ts)} → ${i + 1 < recs.length ? fmt2(recs[i + 1].ts) : "now"}  (${dur2(start, end)})  .${r.v}`);
            }
            return { content: [{ type: "text", text: lines2.join("\n") }] };
          }
          // 新数据：sessions.log 配对 start/end，合并 startup.log 历史（管线启用前的启动，无真实结束/原因，用下次启动近似）
          const evts = readFileSync(slog, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); return null; } }).filter(Boolean);
          const starts = evts.filter((e: any) => e.type === "start");
          const ends = evts.filter((e: any) => e.type === "end");
          const now = Date.now();
          const fmt = (ts: string) => { const d = new Date(ts); if (isNaN(d.getTime())) return "?"; const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
          const dur = (a: number, b: number) => { const s = Math.round(Math.max(0, b - a) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
          const reasonLabel: Record<string, string> = {
            "startup": T("正常启动", "normal start"), "full-reboot": T("自重启", "full-reboot"), "user-ctrl-c": T("Ctrl+C 退出", "Ctrl+C exit"),
            "crash": T("错误闪退", "crash"), "shutdown": T("正常退出", "normal exit"), "hibernate": T("休眠", "hibernate"), "unknown": T("未知", "unknown"),
          };
          // 历史段：startup.log 中早于 sessions.log 第一条 start 的启动（管线启用前，无真实结束/原因）
          const hist: any[] = [];
          let histNote = "";
          const firstSessTs = starts.length ? new Date(starts[0].ts).getTime() : 0;
          try {
            const sl2 = join(logDir, "startup.log");
            if (existsSync(sl2)) {
              const raw2 = readFileSync(sl2, "utf8").trim().split("\n").filter(Boolean);
              const srecs = raw2.map((l) => { try { const o = JSON.parse(l); return { ts: o.ts || "", v: (o.genshin || "").match(/20260815\.(\d+)/)?.[1] || o.genshin || "?" }; } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); return null; } }).filter((r) => r && r.ts);
              // 只取早于 sessions 记录开始的历史启动
              const pre = srecs.filter((r: any) => !firstSessTs || new Date(r.ts).getTime() < firstSessTs);
              if (pre.length) {
                histNote = pre.length > 0 ? T(`（含 ${pre.length} 条旧记录：管线启用前，无真实结束/原因）`, ` (incl. ${pre.length} legacy records: before the pipeline, no real end/reason)`) : "";
                for (let i = 0; i < pre.length; i++) {
                  const r = pre[i]!;
                  const startTs = new Date(r.ts).getTime();
                  const endTs = i + 1 < pre.length ? new Date(pre[i + 1]!.ts).getTime() : (firstSessTs || now);
                  hist.push({ startTs, endTs, endReason: "unknown", ver: r.v });
                }
              }
            }
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
          // 2026-09-13：start/end 原按下标配对（starts[i] ↔ ends[i]）——只要中间有一次没写 end（kill -9 / 断电 / 崩在 exit 钩子前），
          // 后面每个 session 都配到上一个的 end，时长与结束原因整体错一位。改为按时间窗配对：某次 start 的 end 必须落在 [该 start, 下一次 start) 里；
          // 找不到 → 非最后一个记 unknown（结束时刻近似为下一次 start），最后一个记 running。
          const sess = starts.map((s: any, i: number) => {
            const startTs = new Date(s.ts).getTime();
            const nextStartTs = i + 1 < starts.length ? new Date(starts[i + 1].ts).getTime() : Infinity;
            const end = ends.find((e: any) => { const t = new Date(e.ts).getTime(); return t >= startTs && t < nextStartTs; });
            const endTs = end ? new Date(end.ts).getTime() : (nextStartTs === Infinity ? now : nextStartTs);
            const endReason = end ? (end.reason || "unknown") : (nextStartTs === Infinity ? "running" : "unknown");
            const ver = (s.genshin || "").match(/20260815\.(\d+)/)?.[1] || s.genshin || "?";
            return { startTs, endTs, endReason, ver };
          });
          const all = [...hist, ...sess]; // 历史在前（旧），精确在后（新）
          if (!all.length) return { content: [{ type: "text", text: T("无会话记录", "No session records") }] };
          let n = all.length;
          const m = params.instruction.match(/@history\s+(\d+)/);
          if (m) n = Math.max(1, Math.min(all.length, parseInt(m[1], 10)));
          const from = all.length - n;
          const lines: string[] = [];
          lines.push(T(`Session 存续时期 (共 ${all.length} 个${hist.length ? `，其中 ${hist.length} 个为旧记录(近似)` : ""}${n < all.length ? `，显示最近 ${n} 个` : ""}):`, `Session periods (${all.length} total${hist.length ? `, ${hist.length} legacy (approx)` : ""}${n < all.length ? `, showing last ${n}` : ""}):`));
          lines.push(T("  #  开始 → 结束 (时长)  .版本  结束原因", "  #  start → end (duration)  .ver  end reason"));
          for (let i = from; i < all.length; i++) {
            const s = all[i];
            const running = s.endReason === "running";
            const isHist = i < hist.length;
            const reason = isHist ? T("旧数据(近似)", "legacy (approx)") : (running ? T("运行中", "running") : reasonLabel[s.endReason] || s.endReason);
            lines.push(`  #${String(i + 1).padStart(2, " ")}  ${fmt(new Date(s.startTs).toISOString())} → ${running ? "now" : fmt(new Date(s.endTs).toISOString())}  (${dur(s.startTs, s.endTs)})  .${s.ver}  ${reason}`);
          }
          const cur = all[all.length - 1];
          const curIsHist = all.length - 1 < hist.length;
          lines.push("", T(`当前 session: #${all.length}（${fmt(new Date(cur.startTs).toISOString())} 启动${curIsHist ? "，旧记录(近似)" : cur.endReason !== "running" ? `，已结束: ${reasonLabel[cur.endReason] || cur.endReason}` : "，运行中"}）`, `Current session: #${all.length} (started ${fmt(new Date(cur.startTs).toISOString())}${curIsHist ? ", legacy (approx)" : cur.endReason !== "running" ? `, ended: ${reasonLabel[cur.endReason] || cur.endReason}` : ", running"})`));
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e: any) { return { content: [{ type: "text", text: T(`读取会话记录失败: ${e?.message}`, `Failed to read session records: ${e?.message}`) }], isError: true }; }
      }
      // @nickname：给自己取昵称（存 identity.json，不污染 plist.name）
      if (params.instruction.startsWith("@nickname")) {
        const nick = params.instruction.replace(/^@nickname\s*/, "").trim();
        if (!nick) return { content: [{ type: "text", text: T("用法: status @nickname <名字>", "Usage: status @nickname <name>") }], isError: true };
        try {
          const idDir = join(homedir(), ".teyvat/IdentityData", pid);
          const idPath = join(idDir, "identity.json");
          let idData: any = {};
          try { idData = JSON.parse(readFileSync(idPath, "utf8")); } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
          idData.nickname = nick;
          mkdirSync(idDir, { recursive: true });
          writeFileSync(idPath, JSON.stringify(idData, null, 2));
          return { content: [{ type: "text", text: T(`昵称已设为: ${nick}`, `Nickname set to: ${nick}`) }] };
        } catch (e: any) { return { content: [{ type: "text", text: T(`设置昵称失败: ${e?.message}`, `Failed to set nickname: ${e?.message}`) }], isError: true }; }
      }
      if (params.instruction !== "@identity") {
        // 2026-09-07 用户定稿：status @model — 列出可用模型，标注视觉模型 + 当前模型 ★。
        // 2026-09-07 teyvat：模型清单官方化——built-in catalog（官方 DEEPSEEK_MODELS 等）+ models.json custom 合并，
        // 不只见models.json（否则 vision-exp 需手改 models.json才出现）。deepseek 的 vision-exp 来自官方 catalog。
        if (params.instruction.startsWith("@model")) {
          try {
            const models = JSON.parse(readFileSync(join(homedir(), ".teyvat/config/models.json"), "utf8"));
            const cur = (globalThis as any).__genshinGetModel?.();
            const curId = cur?.id ?? cur?.model ?? "";
            // built-in catalog（官方）：MODELS[provider] 是 { modelId: {...} }，取 Object.values 成数组，与 models.json custom 合并
            let merged: any[] = [];
            try {
              const piAi = require(join(process.env.PAIMON_RUNTIME || "", "node_modules/@earendil-works/pi-ai/dist/models.generated.js")) as any;
              const catalog = piAi?.MODELS || {};
              for (const [prov, mods] of Object.entries(catalog)) {
                if (mods && typeof mods === "object" && !Array.isArray(mods)) {
                  for (const mm of Object.values(mods as any) as any[]) merged.push({ provider: prov, ...mm });
                }
              }
            } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); /* catalog 加载失败则仅用 models.json */ }
            const seen = new Set<string>();
            const rows: string[] = [];
            const push = (m: any, prov: string) => {
              const key = prov + "::" + (m.id || m);
              if (seen.has(key)) return; seen.add(key);
              const isVision = Array.isArray(m.input) && m.input.includes("image");
              const star = (m.id === curId) ? "★" : "";
              const vis = isVision ? "✓" : "";
              rows.push(`| ${m.id} | ${prov} | ${vis} | ${star} |`);
            };
            // 先 built-in catalog（官方，含 vision）
            for (const it of merged) push(it, it.provider);
            // 再 models.json custom（覆盖/补充）
            for (const [prov, p] of Object.entries(models.providers || {})) {
              for (const mm of ((p as any).models || [])) push(mm, String(prov));
            }
            // 2026-09-23 用户：直接用原生 markdown 表格
            const table = [`${T("可用模型", "Available models")} (${T("★=当前", "★=current")}, ✓=${T("视觉", "vision")}):`, "", "| 模型 | provider | 视觉 | 当前 |", "|---|---|---|---|", ...rows].join("\n");
            return { content: [{ type: "text", text: table }], details: { markdown: true } };
          } catch (e: any) {
            return { content: [{ type: "text", text: T(`读取模型失败: ${e?.message || e}`, `Failed to load models: ${e?.message || e}`) }], isError: true };
          }
        }
      }
      // 2026-09-07 用户定稿：Status switch-model -- 切换模型（默认禁止，需用户 /a model <id>|all 授权）
      if (params.instruction.startsWith("switch-model ")) {
        const target = params.instruction.replace(/^switch-model\s*/, "").trim();
        if (!target) return { content: [{ type: "text", text: T("用法: status switch-model <模型id>", "Usage: status switch-model <model id>") }], isError: true };
        try {
          // 读授权
          const authPath = join(homedir(), ".teyvat/RuntimeCache", pid, "model-switch-auth.json");
          let allowed = false;
          try {
            const auth = JSON.parse(readFileSync(authPath, "utf8"));
            allowed = auth?.authorized && (auth?.all === true || (auth?.models || []).includes(target));
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); /* 无授权文件 => 默认禁止 */ }
          if (!allowed) return { content: [{ type: "text", text: T(`切换模型 ${target} 未授权。请用户执行 /a model ${target}（或 /a model all 授权任意）后重试。`, `Switching to ${target} not authorized. Ask the user to run /a model ${target} (or /a model all to authorize any), then retry.`) }], isError: true };
          // 从 models.json 构造 model 对象（setModel 需要 {provider, id, ...}）
          const models = JSON.parse(readFileSync(join(homedir(), ".teyvat/config/models.json"), "utf8"));
          let sel: any = null;
          for (const [prov, p] of Object.entries(models.providers || {})) {
            const found = ((p as any).models || []).find((m: any) => m.id === target);
            if (found) { sel = { ...found, provider: prov }; break; }
          }
          if (!sel) return { content: [{ type: "text", text: T(`模型 ${target} 未在 models.json 中找到`, `Model ${target} not found in models.json`) }], isError: true };
          const setModel = (globalThis as any).__genshinSetModel;
          if (typeof setModel !== "function") return { content: [{ type: "text", text: T("当前环境不支持模型切换", "Model switching not supported in this context") }], isError: true };
          await setModel(sel);
          return { content: [{ type: "text", text: T(`已切换模型: ${target}`, `Switched to model: ${target}`) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: T(`切换失败: ${e?.message || e}`, `Switch failed: ${e?.message || e}`) }], isError: true };
        }
      }
      // 2026-09-23 用户：status @permissions — 列出所有授权 + 授权时间（时间读文件内 ts 字段，不靠 mtime）
      if (params.instruction === "@permissions") {
        try {
          const rcDir = join(homedir(), ".teyvat/RuntimeCache", pid);
          const fmtTs = (ms: number) => {
            try { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0");
              return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
            catch { return "?"; }
          };
          const readAuth = (f: string): any => {
            try { return JSON.parse(readFileSync(join(rcDir, f), "utf8")); } catch { return null; }
          };
          const on = T("开", "on"), off = T("关", "off"), yes = T("已授权", "authorized"), no = T("未授权", "not authorized");
          const grReboot = T("重启", "reboot"), grModel = T("模型", "model"), grDir = T("目录", "dirs"), grTool = T("工具", "tools");
          const rows: [string, string, string, string][] = []; // [授权项, 组, 状态, 详情]
          const fr = readAuth("full-reboot-auth");
          rows.push(["full-reboot", grReboot, fr?.authorized ? yes : no, fr?.ts ? fmtTs(fr.ts) : ""]);
          const sr = readAuth("self-reboot-auth");
          if (sr?.authorized) rows.push(["self-reboot", grReboot, yes, `${fmtTs(sr.ts)} [legacy]`]); // 未授权不显示（legacy）
          const ms = readAuth("model-switch-auth.json");
          const msDesc = ms?.authorized ? (ms?.all ? T("任意", "any") : ((ms?.models || []).join(",") || "?")) : "";
          rows.push(["model-switch", grModel, ms?.authorized ? yes : no, ms?.authorized ? (msDesc + (ms?.ts ? ` · ${fmtTs(ms.ts)}` : "")) : ""]);
          let e: any = {};
          try { e = JSON.parse(readFileSync(join(homedir(), ".teyvat/config/authorize.json"), "utf8"))?.agents?.[pid] || {}; } catch (err) { console.error("[spirit.abio.status/status.ts] " + ((err as any)?.message || err)); }
          rows.push([T("全量白名单", "full whitelist") + "(all)", grDir, e.all ? on : off, ""]);
          rows.push([T("root 授权", "root auth"), grDir, e.root ? on : off, ""]);
          const dirs = (e.trusted || []).filter((t: any) => !t.until || t.until > Date.now());
          if (dirs.length) {
            rows.push([T("信任目录", "trusted dirs"), grDir, String(dirs.length), `${dirs[0].path}${dirs[0].until ? ` (${Math.ceil((dirs[0].until - Date.now()) / 60000)}min)` : ""}`]);
            for (let i = 1; i < dirs.length; i++) rows.push(["", "", "", `${dirs[i].path}${dirs[i].until ? ` (${Math.ceil((dirs[i].until - Date.now()) / 60000)}min)` : ""}`]);
          } else {
            rows.push([T("信任目录", "trusted dirs"), grDir, T("(无)", "(none)"), ""]);
          }
          let ta: any = null;
          try { ta = JSON.parse(readFileSync(join(homedir(), ".teyvat/config/tools-auth", pid, "tools-auth.json"), "utf8")); } catch (err) { console.error("[spirit.abio.status/status.ts] " + ((err as any)?.message || err)); }
          rows.push([T("持久授权", "persistent"), grTool, "", ta ? `enable[${(ta.enabled || []).join(",") || T("无", "none")}] disable[${(ta.disabled || []).join(",") || T("无", "none")}]` : T("(无)", "(none)")]);
          // 直接输出原生 markdown 表格（TUI 自动渲染，2026-09-23 用户定稿）
          const header = [T("授权项", "item"), T("组", "group"), T("状态", "status"), T("详情", "detail")];
          const md = [header, ...rows].map((r) => "| " + r.join(" | ") + " |");
          md.splice(1, 0, "|" + header.map(() => "---").join("|") + "|");
          return { content: [{ type: "text", text: T("授权状态（时间=授权时刻）", "Permissions (time = authorized at)") + ":\n\n" + md.join("\n") }], details: { markdown: true } };
        } catch (e: any) {
          return { content: [{ type: "text", text: T(`读取权限失败: ${e?.message || e}`, `Failed to read permissions: ${e?.message || e}`) }], isError: true };
        }
      }
      if (params.instruction !== "@identity") return { content: [{ type: "text", text: T(`未知指令: ${params.instruction}`, `Unknown instruction: ${params.instruction}`) }], isError: true };

      try {
        const plist = JSON.parse(readFileSync(join(homedir(), ".teyvat/MemoryData/plist.json"), "utf8"));
        const rec = plist.find((a: any) => a.id === pid);
        const lines: string[] = [];
        if (rec) {
          lines.push(`ID:   ${rec.id}`, `Name: ${rec.name}`);
          // Nickname（agent 自取，存 identity.json，与用户定的 name 分离）
          try {
            const idPath = join(homedir(), ".teyvat/IdentityData", pid, "identity.json");
            const idData = JSON.parse(readFileSync(idPath, "utf8"));
            if (idData?.nickname) lines.push(`Nickname: ${idData.nickname}`);
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
          if (rec.kind) lines.push(`Kind: ${rec.kind}`);
          // Session ID (from process.title: genshin:name(role,id,sid))
          try {
            const m = process.title.match(/genshin:[^(]+\([^,]+,[^,]+,\s*([^)]+)/);
            if (m?.[1]) lines.push(`Session: ${m[1]}`);
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
          // Model + Context
          let model = "";
          let contextWindow = 0;
          try {
            const live = (globalThis as any).__genshinGetModel?.();
            if (live?.id) model = live.id;
            if (live?.contextWindow) contextWindow = live.contextWindow;
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
          if (model) lines.push(`Model: ${model}`);
          // Context usage: 读 growth.jsonl 最后一行拿最新快照
          try {
            // 2026-09-13：读 growth.jsonl 走 readGrowthLast（路径唯一真相源 + 跳过非 ratio 行）；两个口径分开显示——
            // api = 上一轮真实 prompt（活窗口，与 footer 同源）；est = 记忆文件体量估算（之前只显示 est 却叫 "Context"，与 footer 对不上）
            const g = readGrowthLast(pid);
            if (g) {
              const cap = contextWindow || parseInt(process.env.PI_MODEL_MAX_TOKENS || "") || 0;
              const fmtT = (n: number) => n < 1000 ? n + "" : n < 1e6 ? (n / 1000).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
              const pctOf = (n: number) => cap > 0 ? ` (${Math.round((n / cap) * 100)}%)` : "";
              const capStr = cap > 0 ? ` / ${fmtT(cap)}` : "";
              // 2026-09-16（用户：status 的 api 显示过时——之前只读 growth.jsonl 最后一行，滞后一轮）：
              // 优先读实时值（与工具行 backbone.ts 同源）：__genshinProbeTokens（探针）→ __genshinPondSess.prevPrompt（当前轮）→ growth.jsonl（文件兼底）。
              const api = (globalThis as any).__genshinProbeTokens || (globalThis as any).__genshinPondSess?.prevPrompt || (typeof g.api_tokens === "number" ? g.api_tokens : 0);
              // 2026-09-16（用户定稿）：去掉 est——只显示 api（活对话窗口 = 记忆，唯一口径）
              if (api > 0) lines.push(`Context (api): ${fmtT(api)}${capStr} tokens${pctOf(api)}`);
            }
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }

          // Organization(s): show name alongside ID
          // organization.ts writes rec.org (singular string ID); legacy data may have rec.orgs (array). Normalize.
          const orgIds: string[] = Array.isArray((rec as any).orgs) ? (rec as any).orgs : ((rec as any).org ? [(rec as any).org] : []);
          if (orgIds.length) {
            let orgMap: Record<string, string> = {};
            try {
              const orgsFile = join(homedir(), ".teyvat/AgentWorkDir/Organizational/orgs.json");
              const orgs = JSON.parse(readFileSync(orgsFile, "utf8"));
              for (const o of orgs) orgMap[o.id] = o.name;
            } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
            const orgDisplay = orgIds.map((oid: string) => {
              const name = orgMap[oid];
              return name ? `${name} (${oid})` : oid;
            }).join(", ");
            lines.push(`Organization(s): ${orgDisplay}`);
          }
        } else { lines.push(`ID: ${pid} ${T("(未注册)", "(unregistered)")}`); }
        // RSI-001: 年龄 + 履历
        try {
          const memDir = join(homedir(), ".teyvat/MemoryData", pid);
          const bp = join(memDir, "birth.json");
          let bts = 0;
          if (existsSync(bp)) { bts = JSON.parse(readFileSync(bp, "utf8")).birth_ts || 0; }
          else { try { bts = statSync(memDir).birthtimeMs || 0; } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); } }
          if (bts) {
            const ms = Date.now() - bts, h = ms / 3600000, d = ms / 86400000;
            const age = h < 1 ? Math.floor(ms / 60000) + "m" : d < 1 ? h.toFixed(1) + "h" : d < 7 ? d.toFixed(1) + "d" : d < 30 ? (d / 7).toFixed(1) + "w" : d < 365 ? (d / 30.44).toFixed(1) + "mo" : (d / 365.25).toFixed(1) + "y";
            lines.push(`Age: ${age}`);
          }
          const fp = join(memDir, "tokenmaxxed.json");
          if (existsSync(fp)) {
            const fd = JSON.parse(readFileSync(fp, "utf8"));
            const fmt = (n: number) => n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
            // 2026-08-15：teyvat 只累积 tokenmaxxed 总量（input+output 之和，排除缓存重读），
            // 不存 input/output/think 字段（曾出现外来污染字段被显示）——只显示总量 + sessions。
            // 2026-08-15 晚：CF 风格颜色段位（getCfRank）——段位名 + 数值染 CF 官方色。
            const tok = fd.tokenmaxxed || 0;
            const rank = getCfRank(tok);
            lines.push(`Tokenmaxxed: ${cfPaint(rank.hex, `${rank.name} · ${fmt(tok)}`)} tokens (${fd.sessions || 0} sessions)`);
            if (fd.inherited) {
              lines.push(`  inherited from ${fd.inherited.from_name || fd.inherited.from}: ${fmt(fd.inherited.tokenmaxxed || 0)} tokens`);
            }
          }
        } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }

        try {
          const slog = join(homedir(), ".teyvat", "LogData", pid, "startup.log");
          const slines = readFileSync(slog, "utf8").trim().split("\n");
          const last = JSON.parse(slines[slines.length - 1]);
          lines.push("", `Runtime: ${last.genshin || "?"} (pi v${last.pi || "?"}, ${last.channel || "?"})`);
          // Convert ISO timestamp to local time string
          try {
            const ts = last.ts || "";
            let started = ts;
            if (ts) {
              const d = new Date(ts);
              if (!isNaN(d.getTime())) {
                const pad = (n: number) => String(n).padStart(2, "0");
                started = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
              }
            }
            lines.push(`Started: ${started}`);
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); 
            try { const d = new Date(last.ts || ""); if (!isNaN(d.getTime())) { const p = (n: number) => String(n).padStart(2, "0"); lines.push(`Started: ${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`); } else lines.push(`Started: ${(last.ts || "").slice(0, 19).replace("T", " ")}`); }
            catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); lines.push(`Started: ${(last.ts || "").slice(0, 19).replace("T", " ")}`); }
          }
        } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
        // Pending wake（hibernate until 挂着的定时唤醒，issue 071 附带）
        try {
          const cacheDir = join(homedir(), ".teyvat", "RuntimeCache", pid);
          const wakeFile = join(cacheDir, "wake-at");
          const legacyFile = join(cacheDir, "wake-until");
          let wakeData: any = null;
          try { wakeData = JSON.parse(readFileSync(wakeFile, "utf8")); } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
          if (!wakeData?.until) { try { wakeData = JSON.parse(readFileSync(legacyFile, "utf8")); } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); } }
          if (wakeData?.until) {
            const d = new Date(wakeData.until);
            const pad = (n: number) => String(n).padStart(2, "0");
            const target = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            const left = Math.max(0, Math.round((wakeData.until - Date.now()) / 60000));
            const leftStr = left >= 60 ? `${Math.floor(left/60)}h ${left%60}m` : `${left}m`;
            lines.push(T(`Wake: ${target} (${leftStr} 后)`, `Wake: ${target} (in ${leftStr})`));
          } else {
            lines.push(T("Wake: 无", "Wake: none"));
          }
        } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); return { content: [{ type: "text", text: T("读取失败", "Read failed") }], isError: true }; }
    },
  });
}
