// spirit.abio.status/status.ts — Status 查询入口
// agent 调用 Status @identity 查询身份(plist) + 运行时版本号(startup.log)
// 文档: B.docs/Dev.Common/Wiki/Status(Tool & Concept).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerPaimonTool } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
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

export function registerStatusTool(_pi: ExtensionAPI) {
  registerPaimonTool({
    name: "status",
    label: "Status",
    messageDescription: "Query yourself. Usage: status @identity | status @history [N] | status @nickname <name>",
    promptSnippet: "status @identity — query identity | status @history [N] — session 存续时期 | status @nickname <name> — set nickname",
    parameters: Type.Object({
      instruction: Type.String({ messageDescription: i18n("指令：@identity | @history [N 最近几个 session] | @nickname <名字>", "Instruction: @identity | @history [N recent sessions] | @nickname <name>") }),
    }),
    renderCall(args: any, theme: any) {
      return renderToolCall.label(theme, "status", args?.instruction || "");
    },
    renderResult(result: any, _opts: any, t: any, ctx: any) {
      if (ctx?.isError) return renderMessage.summary(t, { isError: true }, (result?.content || [])[0]?.text);
      const text = (result?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      return renderMessage.output(t, ctx, [{ type: "text", text }]);
    },
    async execute(_id: any, params: any) {
      const pid = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID;
      if (!pid) return { content: [{ type: "text", text: T("无法确定 agent ID", "Cannot determine agent ID") }], isError: true };
      if (!params?.instruction) return { content: [{ type: "text", text: T("用法: status @identity | status @nickname <名字>", "Usage: status @identity | status @nickname <name>") }], isError: true };
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
          const evts = readFileSync(slog, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const starts = evts.filter((e: any) => e.type === "start");
          const ends = evts.filter((e: any) => e.type === "end");
          const now = Date.now();
          const fmt = (ts: string) => { const d = new Date(ts); if (isNaN(d.getTime())) return "?"; const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
          const dur = (a: number, b: number) => { const s = Math.round(Math.max(0, b - a) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
          const reasonLabel: Record<string, string> = {
            "startup": T("正常启动", "normal start"), "self-reboot": T("自重启", "self-reboot"), "user-ctrl-c": T("Ctrl+C 退出", "Ctrl+C exit"),
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
              const srecs = raw2.map((l) => { try { const o = JSON.parse(l); return { ts: o.ts || "", v: (o.genshin || "").match(/20260815\.(\d+)/)?.[1] || o.genshin || "?" }; } catch { return null; } }).filter((r) => r && r.ts);
              // 只取早于 sessions 记录开始的历史启动
              const pre = srecs.filter((r: any) => !firstSessTs || new Date(r.ts).getTime() < firstSessTs);
              if (pre.length) {
                histNote = pre.length > 0 ? T(`（含 ${pre.length} 条旧记录：管线启用前，无真实结束/原因）`, ` (incl. ${pre.length} legacy records: before the pipeline, no real end/reason)`) : "";
                for (let i = 0; i < pre.length; i++) {
                  const r = pre[i];
                  const startTs = new Date(r.ts).getTime();
                  const endTs = i + 1 < pre.length ? new Date(pre[i + 1].ts).getTime() : (firstSessTs || now);
                  hist.push({ startTs, endTs, endReason: "unknown", ver: r.v });
                }
              }
            }
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
          const sess = starts.map((s: any, i: number) => {
            const end = ends[i];
            const startTs = new Date(s.ts).getTime();
            const endTs = end ? new Date(end.ts).getTime() : now;
            const ver = (s.genshin || "").match(/20260815\.(\d+)/)?.[1] || s.genshin || "?";
            return { startTs, endTs, endReason: end?.reason || "running", ver };
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
          // Model: 只取活 session
          let model = "";
          try {
            const live = (globalThis as any).__genshinGetModel?.();
            if (live?.id) model = live.id;
          } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
          if (model) lines.push(`Model: ${model}`);

          // Organization(s): show name alongside ID
          if (rec.orgs?.length) {
            let orgMap: Record<string, string> = {};
            try {
              const orgsFile = join(homedir(), ".teyvat/AgentWorkDir/Organizational/orgs.json");
              const orgs = JSON.parse(readFileSync(orgsFile, "utf8"));
              for (const o of orgs) orgMap[o.id] = o.name;
            } catch (e) { console.error("[spirit.abio.status/status.ts] " + ((e as any)?.message || e)); }
            const orgDisplay = rec.orgs.map((oid: string) => {
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
          } catch { 
            try { const d = new Date(last.ts || ""); if (!isNaN(d.getTime())) { const p = (n: number) => String(n).padStart(2, "0"); lines.push(`Started: ${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`); } else lines.push(`Started: ${(last.ts || "").slice(0, 19).replace("T", " ")}`); }
            catch { lines.push(`Started: ${(last.ts || "").slice(0, 19).replace("T", " ")}`); }
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
      } catch { return { content: [{ type: "text", text: T("读取失败", "Read failed") }], isError: true }; }
    },
  });
}
