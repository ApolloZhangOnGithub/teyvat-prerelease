import { isAbsolute, relative, resolve, sep } from "node:path";
import { readFileSync, appendFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";   // teyvat: sc/hc 状态检测
import { homedir } from "node:os";               // teyvat
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

// ── Codeforces 风格履历段位（CF 官方 rating 颜色，2015 改革后）── tokenmaxxed 映射 CF 段位色
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
function getCfRank(tok) { let r = CF_RANKS[0]; for (const c of CF_RANKS) if (tok >= c.min) r = c; return r; }
function cfPaint(hex, text) { return `\x1b[38;2;${parseInt(hex.slice(1,3),16)};${parseInt(hex.slice(3,5),16)};${parseInt(hex.slice(5,7),16)}m${text}\x1b[39m`; }
// teyvat: 版本号启动时读一次，不要每帧读盘
let _cachedDevVer = null;
try {
  if (existsSync(`${homedir()}/.teyvat/agent/version.json`)) {
    const ver = JSON.parse(readFileSync(`${homedir()}/.teyvat/agent/version.json`, "utf8"));
    if (ver.genshin) _cachedDevVer = ver.genshin;
  }
} catch(e) { if (e?.code !== "ENOENT") { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[footer:ver] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } } }
// teyvat: footer.render() 流式时每帧都被调用；下面这些文件(work_memory/cortex/cost-*/balance)变化很慢，
// 不该每帧同步读盘(原来每帧 ~6 次 readFileSync = 渲染路径里的磁盘 I/O，拖慢每帧、加重弱终端的渲染压力)。
// 1 秒缓存：把每帧的多次读盘降到至多每秒一轮。读不到返回 ""(行为同原来的 try/catch 兜底)。
// teyvat: sc/hc tmux session 状态（2秒缓存，不每帧 execSync）
let __scHcCache = { ts: 0, sc: false, hc: false, pid: "" };
function getScHcStatus(personId) {
    const now = Date.now();
    if (now - __scHcCache.ts < 2000 && __scHcCache.pid === personId) return __scHcCache;
    let sc = "dead", hc = "dead";
    if (personId) {
        const pd = `${homedir()}/.teyvat/MemoryData/${personId}`;
        let scDisabled = false, hcDisabled = false;
        try { if (existsSync(pd + "/metaconsciousness.json")) scDisabled = !!JSON.parse(readFileSync(pd + "/metaconsciousness.json", "utf8")).disabled; } catch(e) { if (e?.code !== "ENOENT") { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[footer:sc] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } } }
        try { if (existsSync(pd + "/hc-disabled.json")) hcDisabled = !!JSON.parse(readFileSync(pd + "/hc-disabled.json", "utf8")).disabled; } catch(e) { if (e?.code !== "ENOENT") { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[footer:hc] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } } }
        if (scDisabled) { sc = "disabled"; } else { try { execSync(`tmux has-session -t mc-${personId} 2>/dev/null`); sc = "running"; } catch(e) { /* expected when session not running */ } }
        if (hcDisabled) { hc = "disabled"; } else { try { execSync(`tmux has-session -t hc-${personId} 2>/dev/null`); hc = "running"; } catch(e) { /* expected when session not running */ } }
        // 检查 hibernate 标记（mc 通过 hibernate() 写 mc-hibernate，hc 通过相应机制）
        const rcd = `${homedir()}/.teyvat/RuntimeCache/${personId}`;
        if (sc === "running") { try { if (existsSync(`${rcd}/mc-hibernate`)) sc = "hibernated"; } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } } }
        if (hc === "running") { try { if (existsSync(`${rcd}/hc-hibernate`)) hc = "hibernated"; } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } } }
    }
    __scHcCache = { ts: now, sc, hc, pid: personId };
    return __scHcCache;
}
const __rcCache = new Map(); // path -> { ts, data }
function cachedReadFile(p) {
    const now = Date.now();
    const hit = __rcCache.get(p);
    if (hit && now - hit.ts < 1000)
        return hit.data;
    let data = "";
    try { data = readFileSync(p, "utf8"); } catch { data = ""; }
    __rcCache.set(p, { ts: now, data });
    return data;
}
// ── agent 辈分（wall age）── RSI-001
const _birthCache = new Map();
function getBirthTs(personId) {
    if (!personId) return null;
    if (_birthCache.has(personId)) return _birthCache.get(personId);
    const dir = `${homedir()}/.teyvat/MemoryData/${personId}`;
    const birthPath = `${dir}/birth.json`;
    try {
        const d = JSON.parse(readFileSync(birthPath, "utf8"));
        _birthCache.set(personId, d.birth_ts);
        return d.birth_ts;
    } catch {
        let ts = Date.now();
        try { const s = statSync(dir); ts = s.birthtimeMs || s.ctimeMs || ts; } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); }
        try { writeFileSync(birthPath, JSON.stringify({ birth_ts: ts, created: new Date(ts).toISOString(), source: ts < Date.now() - 60000 ? "dir_birthtime" : "first_run" })); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); }
        _birthCache.set(personId, ts);
        return ts;
    }
}
// RSI-001 年龄格式：单个单位 + 一位小数，如 2.4h / 1.2d / 2.4w / 3.5mo / 1.2y
function formatAge(birthTs) {
    if (!birthTs) return "";
    const ms = Date.now() - birthTs;
    const h = ms / 3600000, d = ms / 86400000, w = d / 7, mo = d / 30.44, y = d / 365.25;
    if (h < 1) return `${Math.floor(ms / 60000)}m`;
    if (d < 1) return `${h.toFixed(1)}h`;
    if (d < 7) return `${d.toFixed(1)}d`;
    if (d < 30) return `${w.toFixed(1)}w`;
    if (d < 365) return `${mo.toFixed(1)}mo`;
    return `${y.toFixed(1)}y`;
}
/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text) {
    // Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}
/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count) {
    if (count < 1000)
        return count.toString();
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    if (count < 10000000)
        return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}
export function formatCwdForFooter(cwd, home) {
    if (!home)
        return cwd;
    const resolvedCwd = resolve(cwd);
    const resolvedHome = resolve(home);
    const relativeToHome = relative(resolvedHome, resolvedCwd);
    const isInsideHome = relativeToHome === "" ||
        (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
    if (!isInsideHome)
        return cwd;
    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent {
    autoCompactEnabled = true;
    session;
    footerData;
    _requestRender = null;
    _spinnerText = null;
    _spinnerColor = "border";
    // teyvat: 滚动跟随提示条 —— 非空时 footer 第 1 行（元意识/海马体行）中间显示提示（2026-08-14 用户定稿）
    _followHint = false;
    _followCount = 0;
    _followTimer = null;
    constructor(session, footerData) {
        this.session = session;
        this.footerData = footerData;
    }
    setSession(session) {
        this.session = session;
    }
    setAutoCompactEnabled(enabled) {
        this.autoCompactEnabled = enabled;
    }
    invalidate() {
    }
    dispose() {
        this.clearSpinner();
    }
    setRequestRender(fn) {
        this._requestRender = fn;
    }
    setSpinner(text, colorName) {
        this._spinnerText = text;
        this._spinnerColor = colorName || "border";
    }
    updateSpinnerText(text) {
        if (this._spinnerText === text) return;
        this._spinnerText = text;
        this._requestRender?.();
    }
    clearSpinner() {
        this._spinnerText = null;
    }
    /** teyvat: 滚动跟随提示条 —— footer 第 1 行中间显示（claude 风格：主题背景 pill + dim 文字 + ↓）
     *  行为（2026-08-14 简化）：滚出底部显示、回到底部消失；新消息计数显示。
     *  注：曾加 scrollbar 式自动隐藏（_followTimer + onScrollActivity 重置），用户反馈底部黑屏疑似
     *  该机制在滚动时双渲染/状态抖动导致，已去掉。
     *  @param active 是否显示
     *  @param count  未读新消息数（>0 显示 "N new messages ↓"，0 显示 "↓ jump to bottom"） */
    setFollowHint(active, count = 0) {
        const on = !!active;
        this._followCount = on ? count : 0;
        if (this._followHint !== on) { this._followHint = on; }
        this._requestRender?.();
    }
    render(width) {
        try {
        const state = this.session.state;
        const fullId = process.env.PAIMON_AGENT_ID || "";
        // Calculate cumulative usage from ALL session entries (not just post-compaction messages)
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;
        let latestCacheHitRate;
        for (const entry of this.session.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
                totalInput += entry.message.usage.input;
                totalOutput += entry.message.usage.output;
                totalCacheRead += entry.message.usage.cacheRead;
                totalCacheWrite += entry.message.usage.cacheWrite;
                totalCost += entry.message.usage.cost.total;
                const latestPromptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
                latestCacheHitRate =
                    latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
            }
        }
        // Calculate context usage from session (handles compaction correctly).
        // After compaction, tokens are unknown until the next LLM response.
        // 从磁盘读 context/work_memory/cortex，统一 CJK 估算法（同 memory.ts 容量警告一致）
        let diskTokens = { ctx: 0, work: 0, cx: 0 };
        try {
          const base = `${homedir()}/.teyvat/MemoryData/${fullId}`;
            const ctxTxt = cachedReadFile(`${base}/context.md`);
            const wmTxt = cachedReadFile(`${base}/work_memory.md`);
            const cxTxt = cachedReadFile(`${base}/neocortex.md`);
            const est = (t) => { let cjk=0; for(let i=0;i<t.length;i++){const c=t.charCodeAt(i);if((c>=0x3400&&c<=0x9fff)||(c>=0xf900&&c<=0xfaff)||(c>=0x3000&&c<=0x30ff)||(c>=0xff00&&c<=0xffef))cjk++} return Math.round(cjk*1.8+(t.length-cjk)*0.25); };
            diskTokens = { ctx: est(ctxTxt), work: est(wmTxt), cx: est(cxTxt) };
        } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } }
        const contextWindow = state.model?.contextWindow ?? 200000;
        const totalTokens = diskTokens.ctx + diskTokens.work + diskTokens.cx;
        const totalPercent = contextWindow > 0 ? Math.min(100, (totalTokens / contextWindow) * 100) : 0;
        const ctxPct = contextWindow > 0 ? ((diskTokens.ctx / contextWindow) * 100).toFixed(1) : "0";
        const workPct = contextWindow > 0 && diskTokens.work > 0 ? ((diskTokens.work / contextWindow) * 100).toFixed(1) : "0";
        const cxPct = contextWindow > 0 && diskTokens.cx > 0 ? ((diskTokens.cx / contextWindow) * 100).toFixed(1) : "0";
        // Replace home directory with ~
        let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
        // Add git branch if available
        const branch = this.footerData.getGitBranch();
        if (branch) {
            pwd = `${pwd} (${branch})`;
        }
        // Add session name if set
        const sessionName = this.session.sessionManager.getSessionName();
        if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
        }
        // ── teyvat footer: 身份 │ 钱 │ 记忆 ──
        // 从环境变量读身份（launcher 已设）
        let personName = process.env.PAIMON_AGENT_NAME || "";
        const statsParts = [];

        // 区域1: 身份（agent名 #personId @sessionHash）
        let sessionHash = "";
        try { const m = process.title.match(/genshin:[^(]+\([^,]+,[^,]+,\s*([^)]+)/); if (m) sessionHash = m[1]; } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } }
        if (personName) {
            const idParts = [];
            if (fullId) idParts.push(`#${fullId}`);
            if (sessionHash) idParts.push(`@${sessionHash}`);
            statsParts.push(personName + (idParts.length ? " " + idParts.join(" ") : ""));
        } else {
            const fallback = [];
            if (fullId) fallback.push(`#${fullId}`);
            if (sessionHash) fallback.push(`@${sessionHash}`);
            if (fallback.length) statsParts.push(fallback.join(" "));
        }

        // 区域2: 钱（PI_SHOW_WALLET=1 启用，默认关）
        if (process.env.PI_SHOW_WALLET === "1") {
            try {
                // dollar 经济系统已冷冻至 @FUTURE.(society.world/@FUTURE.dollar.*),wallet 显示禁用。
                // balance.json/cost-*.json 是真实 API 费用记账,与 dollar 模块无关,保留。
                let agentDollar = "";
                // if (fullId) {
                //     const walletData = cachedReadFile(`${homedir()}/.teyvat/AgentFileData/${fullId}/wallet.json`);
                //     if (walletData) {
                //         const w = JSON.parse(walletData);
                //         if (typeof w.balance === "number") agentDollar = `AGENT¥${Math.round(w.balance)}`;
                //     }
                // }
                const rc = (role) => { try { return JSON.parse(cachedReadFile(`${homedir()}/.teyvat/RuntimeCache/${fullId}/cost-${role}.json`) || "{}").cost || 0; } catch { return 0; } };
                const bal = JSON.parse(cachedReadFile(`${homedir()}/.teyvat/RuntimeCache/${fullId}/balance.json`) || "{}");
                const balStr = typeof bal.balance === "number" ? `¥${bal.balance.toFixed(2)}` : "";
                let sessionCost = "";
                if (fullId) {
                    const main = totalCost || 0, hc = rc("hippocampus"), sc = rc("metaconsciousness"), sl = rc("sleep");
                    const total = main + hc + sc + sl;
                    if (total > 0) sessionCost = ` (-¥${total.toFixed(2)})`;
                }
                const walletParts = [agentDollar, balStr + sessionCost].filter(Boolean).join(" ");
                if (walletParts) statsParts.push(walletParts);
            } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } }
        }

        // 区域3: 记忆占比
        const ctxWindowStr = `${formatTokens(contextWindow)}`;
        let memStr;
        if (ctxPct !== "?") {
          const tp = totalPercent.toFixed(1);
          // [DISABLED 2026-08-15] 括号内分项暂时不显示，由 amem 工具提供细粒度感知
          // memStr = `记忆${tp}% [对话${ctxPct} 工作${workPct} 新皮层${cxPct}]/${ctxWindowStr}`;
          memStr = `contexted ${tp}%/${ctxWindowStr}`;
        } else {
          memStr = `contexted ?/${ctxWindowStr}`;
        }
        if (totalPercent > 90) {
          memStr = theme.fg("error", memStr);
        } else if (totalPercent > 70) {
          memStr = theme.fg("warning", memStr);
        } else {
          memStr = theme.fg("dim", memStr);
        }
        statsParts.push(memStr);
        let statsLeft = statsParts.join(" ");
        // Add model name on the right side, plus thinking level if model supports it
        const modelName = state.model?.id || "no-model";
        let statsLeftWidth = visibleWidth(statsLeft);
        // If statsLeft is too wide, truncate it
        if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
        }
        // Calculate available space for padding (minimum 2 spaces between stats and model)
        const minPadding = 2;
        // Show thinking level only when multiple levels are available
        let rightSideWithoutProvider = modelName;
        if (state.model?.reasoning) {
            const thinkingLevel = state.thinkingLevel || "off";
            const levels = state.availableThinkingLevels;
            const showLevel = levels && levels.length > 1;
            if (showLevel) {
                rightSideWithoutProvider =
                    thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
            }
        }
        // Prepend the provider in parentheses if there are multiple providers and there's enough room
        // ISSUE 129：新 Footer 供应商功能开（默认）时 line1 已显示 hosting 托管商，此处冗余的通道名括号停用；
        // 仅当用户在 /u 关闭 Footer 供应商（__genshinFooterProvider === false）时保留旧行为。
        let rightSide = rightSideWithoutProvider;
        if (globalThis.__genshinFooterProvider === false && this.footerData.getAvailableProviderCount() > 1 && state.model) {
            rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;
            if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
                // Too wide, fall back
                rightSide = rightSideWithoutProvider;
            }
        }
        const rightSideWidth = visibleWidth(rightSide);
        const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
        let statsLine;
        if (totalNeeded <= width) {
            // Both fit - add padding to right-align model
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
        }
        else {
            // Need to truncate right side
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 0) {
                const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
                const truncatedRightWidth = visibleWidth(truncatedRight);
                const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
                statsLine = statsLeft + padding + truncatedRight;
            }
            else {
                // Not enough space for right side at all
                statsLine = statsLeft;
            }
        }
        // [DISABLED 2026-08-15] 元意识/海马体状态灯行暂时禁用
        // const scHc = getScHcStatus(fullId);
        // const dotColor = (s) => s === "running" ? "success" : s === "hibernated" ? "warning" : s === "disabled" ? "dim" : "error";
        // const dotIcon = (s) => s === "running" ? "•" : s === "hibernated" ? "~" : s === "disabled" ? "○" : "✗";
        // const scLabel = scHc.sc === "disabled" ? "" : theme.fg(dotColor(scHc.sc), dotIcon(scHc.sc)) + " " + theme.fg("dim", "元意识");
        // const hcLabel = theme.fg(dotColor(scHc.hc), dotIcon(scHc.hc)) + " " + theme.fg("dim", "海马体");

        // line1: name(左) + 模型+版本号(右)，followHint 居中
        const modelStr = state.model?.id || "no-model";
        // 2026-09-05 ISSUE 129：模型 id 去掉开发商命名空间（anthropic/claude-opus-4.6 → claude-opus-4.6），
        // 避免开发商名（anthropic 等）在显示里抢眼误导。
        const shortModelId = modelStr.includes("/") ? modelStr.slice(modelStr.indexOf("/") + 1) : modelStr;
        let modelDisplay = shortModelId;
        // 2026-09-04/05 用户需求：模型名左侧显示 hosting 托管商（/u 的 Footer 供应商开关，默认开）。
        // 直连模型（bigmodel/deepseek 等）的 model.provider 即托管平台；openrouter 显示 pi-ai 从
        // openrouter_metadata 捕获的当次实际路由托管商（如 Claude Platform on AWS / Azure），且仅当捕获
        // 属于当前模型（__genshinRoutedProviderModel === model.id，防跨模型残留）；未知时不加前缀（宁缺毋滥）。
        if (globalThis.__genshinFooterProvider !== false && state.model) {
            const isOpenRouter = state.model.provider === "openrouter";
            const capturedOk = globalThis.__genshinRoutedProviderModel === state.model.id;
            const prov = isOpenRouter
                ? (capturedOk ? globalThis.__genshinRoutedProvider : "")
                : (state.model.provider || "");
            if (prov) modelDisplay = `${prov}:${modelDisplay}`;
        }
        if (_cachedDevVer) {
          modelDisplay = `${modelDisplay}  ${theme.fg("muted", _cachedDevVer)}`;
        }
        const modelDisplayW = visibleWidth(modelDisplay);
        const nameRaw = personName || "genshin";
        const nameStr = theme.fg("dim", nameRaw);
        const nameW = visibleWidth(nameStr);
        let line1;
        if (nameW + 4 + modelDisplayW <= width) {
            line1 = nameStr + " ".repeat(width - nameW - modelDisplayW) + theme.fg("dim", modelDisplay);
        } else {
            line1 = theme.fg("dim", truncateToWidth(nameRaw, width - modelDisplayW - 2, "...")) + " ".repeat(2) + theme.fg("dim", modelDisplay);
        }

        // followHint 叠加在 line1 中间
        if (this._followHint) {
            const text = this._followCount > 0 ? `${this._followCount} new message${this._followCount === 1 ? "" : "s"} ↓` : "ctrl+shift+down to follow ↓";
            const hint = ` ${text} `;
            const hintW = visibleWidth(hint);
            if (width - nameW - modelDisplayW >= hintW + 6) {
                const midStart = Math.max(nameW + 2, nameW + Math.floor((width - nameW - modelDisplayW - hintW) / 2));
                const pill = theme.bg("userMessageBg", theme.fg("dim", hint));
                line1 = nameStr + " ".repeat(midStart - nameW) + pill + " ".repeat(Math.max(0, width - midStart - hintW - modelDisplayW)) + theme.fg("dim", modelDisplay);
            }
        }

        // line2: #id @session(左) + age · tokenmaxxed · 记忆(右)
        const idParts = [];
        if (fullId) idParts.push(`#${fullId}`);
        if (sessionHash) idParts.push(`@${sessionHash}`);
        const idStr = theme.fg("dim", idParts.join(" "));
        const idW = visibleWidth(idStr);
        // 2026-09-04 用户需求：footer 年龄/tokenmaxxed 可在 /u 分别关闭（默认显示；持久化 settingsManager.globalSettings.footerAge/footerTokenmaxxed）
        const showAge = globalThis.__genshinFooterAge !== false;
        const ageStr = showAge ? formatAge(getBirthTs(fullId)) : "";
        // tokenmaxxed tokens（RSI-001 社会资历）
        // ISSUE 106：tokenmaxxed.json 已由 memory.ts 每轮 message_end 实时落盘，直接读文件即实时值
        // （不再需要 ISSUE 104 的 __genshinPondSess 叠加 hack）。
        let tokenmaxxedStr = "";
        if (fullId && globalThis.__genshinFooterTokenmaxxed !== false) {
            try {
                const val = JSON.parse(cachedReadFile(`${homedir()}/.teyvat/MemoryData/${fullId}/tokenmaxxed.json`) || "{}").tokenmaxxed || 0;
                if (val > 0) {
                    // ISSUE 105：履历多彩开关（/ux 管理，默认关）。关=普通色无称呼；开=CF段位色+称呼
                    const colorful = globalThis.__genshinTokenmaxxedColorful === true;
                    tokenmaxxedStr = colorful
                        ? `tokenmaxxed ${cfPaint(getCfRank(val).hex, `${getCfRank(val).name} ${formatTokens(val)}`)}`
                        : `tokenmaxxed ${formatTokens(val)}`;
                }
            } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); }
        }
        const rightParts = [ageStr, tokenmaxxedStr, memStr].filter(Boolean);
        const rightLine2 = rightParts.map((s, i) => i < rightParts.length - 1 ? theme.fg("dim", s) : s).join(" · ");
        const rightLine2W = visibleWidth(rightLine2);
        let line2;
        if (idW + 4 + rightLine2W <= width) {
            line2 = idStr + " ".repeat(width - idW - rightLine2W) + rightLine2;
        } else if (rightLine2W + 4 <= width) {
            const maxId = width - rightLine2W - 4;
            const truncId = truncateToWidth(idParts.join(" "), maxId, "...");
            line2 = theme.fg("dim", truncId) + " ".repeat(width - visibleWidth(truncId) - rightLine2W) + rightLine2;
        } else {
            line2 = " ".repeat(Math.max(0, width - rightLine2W)) + rightLine2;
        }

        // line3: spinner / extension statuses
        let line3 = " ".repeat(width);
        if (this._spinnerText) {
            line3 = truncateToWidth(this._spinnerText, width, theme.fg("dim", "..."));
        } else {
            const extensionStatuses = this.footerData.getExtensionStatuses();
            if (extensionStatuses.size > 0) {
                const sortedStatuses = Array.from(extensionStatuses.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([, text]) => sanitizeStatusText(text));
                line3 = truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "..."));
            }
        }
        // FOOTER01=name行 FOOTER02=#id+记忆行 FOOTER03=spinner/status行
        // 设 FOOTERXX=0 关闭对应行，默认全开
        // ── 窗口标题：仅变化时设，避免每帧刷 OSC 码 ──
        try {
            const title = statsParts.length > 0 ? `genshin: ${statsParts.join(" · ")}` : "genshin";
            const cleanTitle = title.replace(/\x1b\[[0-9;]*m/g, "");
            if (cleanTitle !== FooterComponent._lastTitle) {
                process.stdout.write(`\x1b]0;${cleanTitle}\x07`);
                FooterComponent._lastTitle = cleanTitle;
            }
        } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[title] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } }

        const lines = [];
        if (process.env.FOOTER01 !== "0") lines.push(line1);
        if (process.env.FOOTER02 !== "0") lines.push(line2);
        if (process.env.FOOTER03 !== "0") lines.push(line3);
        return lines;
        } catch(e) {
            try { appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-footer-error.log", `[${new Date().toISOString()}] ${e?.stack||e}\n`); } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/ui_elements/footer.js] " + (e?.message || e)); } }
            return [" ".repeat(width || 80), " ".repeat(width || 80), " ".repeat(width || 80)];
        }
    }
}
//# sourceMappingURL=footer.js.map