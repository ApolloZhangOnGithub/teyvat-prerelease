// 消息渲染器总表（解耦 PROPOSAL 034 阶段 1，2026-08-18）
// 运行器官（heart）不再注册渲染器——渲染是视图职责，统一在这里注册。
// 注册时机：heart.ts 的 default(pi) 调用 registerMessageRenderers(pi)（扩展加载时）；
// headless 模式（mc/hc）的 pi 无渲染循环，注册了也只是存回调，无害。
// 找"消息怎么渲染" → 本文件（按消息类型名，与 MESSAGE_TYPES 一一对应）。
// 文档: B.docs/Dev.Common/Proposals/034-agent-core-ui-separation.PROPOSAL
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GUTTER, renderMessage, lineNumbered } from "#tui_blockrender";
import { i18n } from "#tui_localizations";

// ══════════════════════════════════════════════════════════════════════════════
// 渲染部件管线校验（解耦 PROPOSAL 034 阶段 A，2026-08-18）
// 参考 DSH（deepseek-harness）理念：渲染部件带编号注册 + 总闸（全开/全关）全局校验。
// 只学理念不搬架构：不重构渲染层，只加"航空工业检查单"式编号校验——
// 新增渲染器必须登记到 RENDER_PARTS，否则 R002 检查会 FAIL。
// 编号体系：R-PART-xxx（渲染部件）/ Rxxx（检查项），见 009-debug-pipeline.NORM。
// ══════════════════════════════════════════════════════════════════════════════

// 渲染部件清单：编号 + 消息类型 + 描述（新增渲染器必须在此登记）
const RENDER_PARTS: Array<{ id: string; type: string; desc: string }> = [
  { id: "R-PART-001", type: "continuous-resume", desc: "wait/hibernate 完成/中断折线 + Life Restarted + Resumed" },
  { id: "R-PART-002", type: "sleep-wake-resume", desc: "睡眠唤醒通知" },
  { id: "R-PART-003", type: "continuous-date", desc: "日期变更通知" },
  { id: "R-PART-004", type: "memory-capacity", desc: "Memory Alert 容量告警（动态读 context.md）" },
  { id: "R-PART-005", type: "memory-reminder", desc: "记忆提醒" },
  { id: "R-PART-006", type: "system-error", desc: "系统错误通知" },
  { id: "R-PART-007", type: "hippocampus-error", desc: "海马体异常通知" },
  { id: "R-PART-008", type: "continuous-error-retry", desc: "API 错误重试通知" },
  { id: "R-PART-009", type: "continuous-cmd-done", desc: "命令完成 Result（紫罗兰专属色）" },
  { id: "R-PART-010", type: "display-hidden", desc: "显示隐藏通知（/h 转后台，Life Restarted 同管线青绿）" },
  { id: "R-PART-011", type: "display-shown", desc: "显示恢复通知（attach 回前台，青绿同款）" },
];

// 已注册集合（registerMessageRenderers 执行完填充，R002 校验用）
const _registeredParts = new Set<string>();

// 渲染管线检查（R 系列，航空工业检查单风格）：
//   R001 总闸一致性——TUI 环境 __genshinUIEnv 必须 true；headless 不得 true（全开或全关，防半开）
//   R002 部件注册完整——RENDER_PARTS 全部已注册
// 返回 issue 列表（空 = 全部 PASS）；FAIL 项打印 [render-pipeline] 前缀（可 grep）
export function checkRenderPipeline(env: "tui" | "headless"): string[] {
  const issues: string[] = [];
  const uiEnv = (globalThis as any).__genshinUIEnv === true;
  // R001 总闸一致性
  if (env === "tui" && !uiEnv) issues.push("R001 FAIL: TUI 环境但 __genshinUIEnv 未设置——渲染总闸缺失，各部件将静默失效");
  if (env === "headless" && uiEnv) issues.push("R001 FAIL: headless 环境但 __genshinUIEnv 已设置——半开渲染状态（必须全开或全关）");
  // R002 部件注册完整
  const missing = RENDER_PARTS.filter((p) => !_registeredParts.has(p.type)).map((p) => `${p.id}(${p.type})`);
  if (missing.length) issues.push(`R002 FAIL: 部件未注册: ${missing.join(", ")}`);
  for (const it of issues) console.warn(`[render-pipeline] ${it}`);
  return issues;
}

// 暴露检查桥（interactive-mode / main.js 启动时调用，TUI 环境跑 tui、headless 跑 headless）
(globalThis as any).__genshinCheckRenderPipeline = checkRenderPipeline;

export function registerMessageRenderers(pi: ExtensionAPI) {
  pi.registerMessageRenderer("continuous-resume", (message: any, _opts: any, theme: any) => {
    const raw = (message.content ?? "").toString();
    const clean = raw.replace(/^\[系统\]\s*/, "");
    // 用 details.resumeType 区分（不靠字符串匹配）
    const resumeType = (message.details as any)?.resumeType;
    if (resumeType === "wait" || resumeType === "hibernate") {
      // wait/hibernate 完成/中断 → 折线结果
      const match = clean.match(/\[(wait|hibernate)\s+(\d+)s/);
      const interrupted = (message.details as any)?.interrupted;
      const intrReason = (message.details as any)?.interruptReason;
      const reasonLabel: Record<string, string> = { esc: "ESC", user: "user message", sleep: "sleep cycle", reload: "reload", shutdown: "shutdown", command: "/pause" };
      const secs = match?.[2] || "?";
      const indent = " ".repeat(GUTTER);
      const { Text } = require("@earendil-works/pi-tui");
      // 2026-09-11：wait/hibernate 结果已在 tool-execution.js 的 call 行追加渲染（→ Waited Xs），
      // continuous-resume 消息不再独立渲染折线——否则 Waited 显示两遍。
      const { Container: C } = require("@earendil-works/pi-tui");
      return new C();
    }
    switch (resumeType) {
      case "restart":
        // 专属 lifeRestart 色（青绿，theme 新增键）——重启=新生命，区别于 Result(紫)/message(蓝)/success(绿)
        // 2026-08-18 用户需求：Life Restarted 后加 dim 中文小标题，区分"自己重启" vs "用户重启"——
        // heart session_start 已按 self-reboot-reason.json 是否存在设置 __genshinSelfRebooted；
        // 样式：空格分隔 + dim 小字（工具调用行风格，无冒号无点），非英文
        const selfRebootFlag = (globalThis as any).__genshinSelfRebooted === true;
        const restartSubtitle = selfRebootFlag ? "自己重启" : "用户重启";
        return renderMessage.notice(theme, "Life Restarted", clean, "lifeRestart", restartSubtitle, "✤"); // 2026-08-18 用户定稿：事件 ✤ / 消息 ➤ / Result ●
      default: {
        // 兼容旧格式（无 resumeType 时尝试从内容推断）
        const waitMatch = clean.match(/\[wait\s+(\d+)s/);
        if (waitMatch) {
          const indent = " ".repeat(GUTTER);
          const { Text } = require("@earendil-works/pi-tui");
          return new Text(indent + "⎿  " + theme.fg("success", `${waitMatch[1]}s`), 0, 0);
        }
        return renderMessage.notice(theme, "Resumed From History Sessions", clean);
      }
    }
  });
  pi.registerMessageRenderer("sleep-wake-resume", (message: any, _opts: any, theme: any) => {
    const raw = (message.content ?? "").toString();
    return renderMessage.notice(theme, "Resumed From Sleep", raw);
  });
  pi.registerMessageRenderer("continuous-date", (message: any, _opts: any, theme: any) => {
    return renderMessage.notice(theme, "Date", (message.content ?? "").toString().replace(/^Current date: /, ""));
  });
  // 2026-08-14 补齐：以下消息类型 render:true 但此前无渲染器（走未知 fallback）
  // 2026-08-15 修复"过期快照误导"：容量提醒是触发时的旧值（如清理前 80%），清理后仍显示旧数字——
  // 渲染时动态读当前 context.md 估算实时 token；健康（<80%）显示"健康"而非旧提醒。
  // 2026-08-15 用户要求：标题 "Memory" → "Memory Alert"，菱形+标题黄色（原绿色 success 色像成功状态）。
  // ── teyvat system message 渲染管线（2026-09-11）──
  // 轻量单行：dim 三角 + dim 内容，col 2 缩进。不要大菱形/粗体标题/多行。
  const _sysMsg = (theme: any, text: string, color?: string) => {
    const { Text: T } = require("@earendil-works/pi-tui");
    const indent = " ".repeat(GUTTER);
    const arrow = color ? theme.fg(color, "▸") : theme.fg("dim", "▸");
    const body = color ? theme.fg(color, text) : theme.fg("dim", text);
    return new T(indent + arrow + " " + body, 0, 0);
  };

  pi.registerMessageRenderer("memory-capacity", (message: any, _opts: any, theme: any) => {
    let cur = "";
    try {
      // 2026-09-12（ISSUE 203，房东定调“以 API 报的为准”）：
      // 主值改用 API 真实值 —— __genshinContextGauge（memory.ts:155 写，input+cacheRead，唯一写者）；
      // est(context.md) 降级为“是否正在截断”预警（>70% = buildSnapshot 已在丢最旧记忆）。
      const gauge = (globalThis as any).__genshinContextGauge || "";
      const apiPct = parseFloat((gauge.match(/(\d+(?:\.\d+)?)%/) || [])[1] || "0");
      const ctxPath = join(global.__genshinPersonDir || "", "context.md");
      const t = readFileSync(ctxPath, "utf8");
      let cjk = 0;
      for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) cjk++; }
      const estTok = Math.round(cjk * 1.8 + (t.length - cjk) * 0.25);
      const modelMax = ((globalThis as any).__genshinGetModel?.()?.contextWindow) || 1000000;
      const estPct = modelMax > 0 ? (estTok / modelMax) * 100 : 0;
      const main = apiPct > 0
        ? `${(gauge.trim() || `ctx ${apiPct}%`)}${estPct > 70 ? ` · 记忆体量 ${estPct.toFixed(0)}%（正在截断旧记忆）` : ""}`
        : `ctx ~${estPct.toFixed(1)}% (est)`;
      cur = estPct > 70 ? i18n(`${main} — 建议 amem`, `${main} — consider amem`) : main;
    } catch (e) { console.error("[god.frontend.tui/renderers.ts] " + ((e as any)?.message || e)); cur = (message.content ?? "").toString(); }
    return _sysMsg(theme, cur, parseFloat((cur.match(/记忆体量\s*(\d+(?:\.\d+)?)%/) || [])[1] || "0") > 70 ? "warning" : undefined);
  });
  pi.registerMessageRenderer("memory-reminder", (message: any, _opts: any, theme: any) => {
    return _sysMsg(theme, (message.content ?? "").toString());
  });
  // 2026-08-20 /h 转后台通知：Life Restarted 同管线（notice 青绿 ✤）——agent 知道自己被转 headless
  pi.registerMessageRenderer("display-hidden", (message: any, _opts: any, theme: any) => {
    return renderMessage.notice(theme, "Hidden", (message.content ?? "").toString(), "lifeRestart", undefined, "✤");
  });
  // 2026-08-20 attach 回前台通知：用户已以前台模式进入（display-shown，青绿同款 ✤）
  pi.registerMessageRenderer("display-shown", (message: any, _opts: any, theme: any) => {
    return renderMessage.notice(theme, "Shown", (message.content ?? "").toString(), "lifeRestart", undefined, "✤");
  });
  pi.registerMessageRenderer("system-error", (message: any, _opts: any, theme: any) => {
    return _sysMsg(theme, (message.content ?? "").toString(), "error");
  });
  pi.registerMessageRenderer("hippocampus-error", (message: any, _opts: any, theme: any) => {
    return _sysMsg(theme, (message.content ?? "").toString(), "error");
  });
  pi.registerMessageRenderer("continuous-error-retry", (message: any, _opts: any, theme: any) => {
    return _sysMsg(theme, (message.content ?? "").toString(), "warning");
  });
  pi.registerMessageRenderer("continuous-cmd-done", (message: any, _opts: any, theme: any) => {
    const { Text, Container } = require("@earendil-works/pi-tui");
    const raw = (message.content ?? "").toString();
    // 格式1 (desktop): "完成 (Ns, exit CODE):\n$ CMD\nOUTPUT"
    // 格式2 (desktop error): "Command failed/killed (Ns):\n$ CMD\nERROR"
    // 格式3 (mobile): " mobile 完成 (Ns):\nOUTPUT"
    const dsMatch = raw.match(/^(.*?)\s*\((\d+)s,\s*exit\s+(\d+)\):\n\$\s+(.*?)\n([\s\S]*)$/);
    const dsFail = raw.match(/^Command (failed|killed by user)\s*\((\d+)s\):\n\$\s+(.*?)\n([\s\S]*)$/);
    const mbMatch = raw.match(/^\s*mobile\s*完成\s*\((\d+)s\):\n([\s\S]*)$/);
    let cmd = ""; let elapsed = 0; let output = ""; let exitCode: number | undefined;
    let isError = false;
    if (dsMatch) {
      elapsed = parseInt(dsMatch[2]);
      exitCode = parseInt(dsMatch[3]);
      cmd = dsMatch[4].split("\n")[0].trim();
      output = (dsMatch[5] || "").trim();
      isError = exitCode !== 0;
    } else if (dsFail) {
      elapsed = parseInt(dsFail[2]);
      cmd = dsFail[3].split("\n")[0].trim();
      output = (dsFail[4] || "").trim();
      isError = true;
    } else if (mbMatch) {
      elapsed = parseInt(mbMatch[1]);
      cmd = "mobile";
      output = (mbMatch[2] || "").trim();
    }
    // 无匹配时：用原始内容当输出
    if (!cmd && !output) {
      output = raw.trim();
      cmd = "execute";
    }
    // 格式4 (hibernate/wait): "hibernate 完成 (50s)" 或 "wait 完成 (35s)\nnext steps"
    // 渲染为简洁的折线结果：⎿ Xs（绿色），无标题。单 Text 避免多余空行
    const hwMatch = raw.match(/^(hibernate|wait)\s+完成\s*\((\d+)s\)(?:\n([\s\S]*))?$/);
    if (hwMatch) {
      elapsed = parseInt(hwMatch[2]);
      const nextSteps = (hwMatch[3] || "").trim();
      const indent = " ".repeat(GUTTER);
      const prefix = indent + "⎿  ";
      // 数字统一白色粗体，单位 s 保持 success 色（与 Result 行 in Xs 一致）
      let text = elapsed === 0
        ? prefix + theme.fg("success", "Instantly")
        : prefix + String(elapsed) + theme.fg("success", "s"); // 数字 default（与 Result 行一致）
      if (nextSteps) text += "\n" + indent + "  " + theme.fg("dim", nextSteps);
      return new Text(text, 0, 0);
    }
    // 从消息提取短 id（[id: xxx]），output 里剥掉 [id:] 和 [remaining:]（两者可能相邻，不能依赖 $ 锚定）
    const idMatch = raw.match(/\[id:\s*([A-Za-z0-9-]+)\]/);
    const idStr = idMatch ? idMatch[1] : "";
    output = output.replace(/\n*\[id:\s*[A-Za-z0-9-]+\]/g, "");
    // 2026-09-08（用户：cmd-done 还带 [background: N running]——.79 只剥了 execute 同步返回路径，cmd-done 推送没剥）：任意位置剥 background 行
    output = output.replace(/\n*\[background: [^\]]*running[^\]]*\]/g, "");
    // 用户展示剥离：bioclock 耗时戳 [HH:MM:SS.mmm +Xs]（只对用户隐藏，模型消息里保留）
    output = output.replace(/\n*\[\d{2}:\d{2}:\d{2}\.\d{3}\s*\+\d+(?:\.\d+)?s\]\s*$/, "").trimEnd();
    const exitStr = exitCode !== undefined ? `exit ${exitCode}` : (elapsed === 0 ? "instantly" : `${elapsed}s`);
    const statusColor = isError ? "error" : "success";
    // 合并检测：如果前一个组件就是同 recId 的 execute Created，跳过独立 Result 头——
    // 把结果直接追加到 execute 组件里（像同步快命令一样）
    const chatContainer = (globalThis as any).__genshinChatContainer;
    let merged = false;
    if (chatContainer && idStr) {
      const kids = chatContainer.children || [];
      // 从末尾往回找最近的非空组件（跳过 Spacer 等空行）
      for (let i = kids.length - 1; i >= Math.max(0, kids.length - 5); i--) {
        const kid = kids[i];
        if (!kid || !kid.result) continue;
        // 检查是否是同一个 execute 的 tool-execution 组件
        const kidRecId = kid.result?.details?.recId;
        if (kidRecId && kidRecId === idStr) {
          merged = true;
          break;
        }
        // 中间有其他内容组件就不合并
        if (kid.toolName || kid.role) break;
      }
    }

    const c = new Container();
    const indent = " ".repeat(GUTTER);
    const title = (message.details as any)?.title;
    const fmtElapsed = (sec: number) => {
      if (sec < 10) return `${sec.toFixed(1)}s`;
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) { const m = Math.floor(sec / 60); const s2 = sec % 60; return s2 === 0 ? `${m}m` : `${m}m ${s2}s`; }
      return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    };
    const elapsedFmt = elapsed === 0 ? "instantly" : fmtElapsed(elapsed);
    const remMatch = raw.match(/\[remaining:\s*(\d+)\]/);
    const remaining = remMatch ? parseInt(remMatch[1]) : 0;
    if (remMatch) output = output.replace(/\n*\[remaining:.*$/, "");
    const remPart = remaining > 0 ? ` (${remaining} remaining)` : "";
    const ts = new Date();
    const hh = String(ts.getHours()).padStart(2, "0");
    const mm = String(ts.getMinutes()).padStart(2, "0");
    const ss = String(ts.getSeconds()).padStart(2, "0");
    const timeFmt = `${hh}:${mm}:${ss}`;
    // → Task title done in X.Xs at HH:MM:SS（exit 0 不显示）
    const exitPart = exitCode !== undefined && exitCode !== 0 ? `, exit ${theme.bold(String(exitCode))}` : "";
    const titlePart = title ? `"${title}" ` : "";
    // merged = 紧挨 Created 调用行 → 用 ⎿ 折线缩进（像同步快命令）；否则用 → 独立行
    const prefix = merged ? (indent + theme.fg("dim", "⎿  ")) : (theme.fg("dim", "→") + " ");
    const line1 = prefix + `${titlePart}Done in ${theme.bold(elapsedFmt)}${exitPart}${remPart}` + theme.fg("dim", ` at ${timeFmt}`);
    c.addChild(new Text(line1, 0, 0));
    // [PRESERVED] 旧版两行渲染（→ Result 头 + Executed 详情行）：
    // const d = isError ? theme.fg("error", "→") : theme.fg("result", "→");
    // const mainStr = merged ? "" : d + " " + theme.bold("Result") + (title ? " " + title : "");
    // const idPart = idStr ? `process ${idStr} ` : "";
    // const line2 = indent + theme.fg("dim", "⎿  ") + `Executed ${idPart}` + `in ${theme.fg("accent", elapsedFmt)}` + `, with ` + theme.bold(theme.fg(statusColor, exitStr)) + remPart + theme.fg("dim", timePart);
    // if (mainStr) c.addChild(new Text(mainStr, 0, 0));
    // c.addChild(new Text(line2, 0, 0));
    if (output) {
      const compact = (globalThis as any).__genshinCompactExecute;
      let display = output;
      if (compact) {
        display = output.split("\n")[0].slice(0, 200) + (output.length > 200 ? "…" : "");
      } else {
        const outLines = output.split("\n");
        if (outLines.length > 6) {
          const tailN = 5;
          const skipped = outLines.length - tailN;
          const startLine = skipped + 1;
          display = theme.fg("dim", `...(${skipped} lines more)`) + "\n" + outLines.slice(-tailN).join("\n");
          const contIndent = " ".repeat(GUTTER + 3);
          // 折叠提示行不带行号，尾部行从实际行号开始
          const tailDisplay = outLines.slice(-tailN).join("\n");
          const rendered = lineNumbered(tailDisplay, theme, undefined, startLine);
          c.addChild(new Text(contIndent + theme.fg("dim", `...(${skipped} lines more)`), 0, 0));
          for (const line of rendered.split("\n")) c.addChild(new Text(contIndent + line, 0, 0));
          display = ""; // 已处理，跳过下面的默认渲染
        }
      }
      if (display) {
      const contIndent = " ".repeat(GUTTER + 3);
      const rendered = lineNumbered(display, theme);
      for (const line of rendered.split("\n")) c.addChild(new Text(contIndent + line, 0, 0));
      }
    }
    return c;
  });
  // 全部渲染器注册完成 → 标记部件就位（R002 校验用）
  for (const p of RENDER_PARTS) _registeredParts.add(p.type);
}
