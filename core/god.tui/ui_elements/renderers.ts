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
import { GUTTER, renderMessage, lineNumbered, SYM, renderExecuteResult, parseLegacyCmdDone } from "#tui_blockrender";
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

// cmd-done 合并判定：紧挨着的前一个非空组件就是同 recId 的 execute Created 行 → 结果直接接在它下面（⎿），否则独立 ▸ 行。
// "是否相邻"只有聊天容器知道，所以留在渲染侧；但只比较结构化 recId，不再从格式化文本里用正则抠 id（ISSUE 226）。
function _cmdDoneMergesWithCreated(recId: string | undefined): boolean {
  const chatContainer = (globalThis as any).__genshinChatContainer;
  if (!chatContainer || !recId) return false;
  const kids = chatContainer.children || [];
  // 从末尾往回找最近的非空组件（跳过 Spacer 等空行），最多回看 5 个
  for (let i = kids.length - 1; i >= Math.max(0, kids.length - 5); i--) {
    const kid = kids[i];
    if (!kid || !kid.result) continue;
    if (kid.result?.details?.recId === recId) return true;
    if (kid.toolName || kid.role) return false; // 中间有其他内容组件就不合并
  }
  return false;
}

export function registerMessageRenderers(pi: ExtensionAPI) {
  // R002 校验要"真的注册了什么"：包一层记录实际注册的 type（之前函数末尾把 RENDER_PARTS 全部标成已注册，R002 永远不会 FAIL，校验形同虚设）
  const _origRegister = pi.registerMessageRenderer.bind(pi);
  const _actuallyRegistered = new Set<string>();
  (pi as any).registerMessageRenderer = (type: string, renderer: any) => { _actuallyRegistered.add(type); return _origRegister(type, renderer); };
  pi.registerMessageRenderer("continuous-resume", (message: any, _opts: any, theme: any) => {
    const raw = (message.content ?? "").toString();
    const clean = raw.replace(/^\[系统\]\s*/, "");
    // 用 details.resumeType 区分（不靠字符串匹配）
    const resumeType = (message.details as any)?.resumeType;
    if (resumeType === "wait" || resumeType === "hibernate") {
      // 2026-09-11：wait/hibernate 结果已在 tool-execution.js 的 call 行追加渲染（→ Waited Xs），
      // continuous-resume 消息不再独立渲染折线——否则 Waited 显示两遍。
      // （2026-09-13 ISSUE 226：原先这里还算了 match/interrupted/reasonLabel/secs 一堆再返回空容器，删掉死计算）
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
        return renderMessage.notice(theme, "Life Restarted", clean, "lifeRestart", restartSubtitle, SYM.star); // 2026-08-18 用户定稿：事件 ✤ / 消息 ➤ / Result ●
      default: {
        // 兼容旧格式（无 resumeType 时尝试从内容推断）
        const waitMatch = clean.match(/\[wait\s+(\d+)s/);
        if (waitMatch) {
          const indent = " ".repeat(GUTTER);
          const { Text } = require("@earendil-works/pi-tui");
          return new Text(indent + SYM.result + "  " + theme.fg("success", `${waitMatch[1]}s`), 0, 0);
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
  // 系统消息：arrow 在 col 0（和 dot ⏺ 对齐），内容从 col GUTTER(2) 开始
  const _sysMsg = (theme: any, text: string, color?: string) => {
    const { Text: T } = require("@earendil-works/pi-tui");
    const arrow = color ? theme.fg(color, SYM.arrow) : theme.fg("dim", SYM.arrow);
    const body = color ? theme.fg(color, text) : theme.fg("dim", text);
    return new T(arrow + " " + body, 0, 0);
  };

  // memory-capacity：2026-09-13 恢复渲染——之前注册的是空 Container（"garbage"反馈后），而 backbone 里该类型又是 feed:false，
  // 结果 80% 容量提醒既不显示也不喂模型，整条链路（memory.ts 每轮估算 5 个文件 → 发消息）是死的。现在只给人看一行（不喂模型，去重已在 memory.ts）。
  pi.registerMessageRenderer("memory-capacity", (message: any, _opts: any, theme: any) => _sysMsg(theme, (message.content ?? "").toString()));
  pi.registerMessageRenderer("memory-reminder", (message: any, _opts: any, theme: any) => {
    return _sysMsg(theme, (message.content ?? "").toString());
  });
  // 2026-08-20 /h 转后台通知：Life Restarted 同管线（notice 青绿 ✤）——agent 知道自己被转 headless
  pi.registerMessageRenderer("display-hidden", (message: any, _opts: any, theme: any) => {
    return renderMessage.notice(theme, "Hidden", (message.content ?? "").toString(), "lifeRestart", undefined, SYM.star);
  });
  // 2026-08-20 attach 回前台通知：用户已以前台模式进入（display-shown，青绿同款 ✤）
  pi.registerMessageRenderer("display-shown", (message: any, _opts: any, theme: any) => {
    return renderMessage.notice(theme, "Shown", (message.content ?? "").toString(), "lifeRestart", undefined, SYM.star);
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
  // 2026-09-14（用户多次要求）：syntax-error 用黄色 system 提示块（同 warning 样式），不再走通用 fallback 菱形块
  pi.registerMessageRenderer("syntax-error", (message: any, _opts: any, theme: any) => {
    return _sysMsg(theme, (message.content ?? "").toString(), "warning");
  });
  // 2026-09-13（ISSUE 226）：cmd-done 渲染只做"details → state"映射，画法在 blocks_nongod.renderExecuteResult（与快命令/Created 同一入口）。
  // executes.ts 发送时随 details 带 { status, recId, exitCode, elapsedSec, endTs, cmd, output, remaining }；
  // 没有 details.status 的是旧格式历史消息（重启回放）→ parseLegacyCmdDone 从文本反解析兜底。
  pi.registerMessageRenderer("continuous-cmd-done", (message: any, _opts: any, theme: any) => {
    const { Text } = require("@earendil-works/pi-tui");
    const raw = (message.content ?? "").toString();
    const d = (message.details ?? {}) as any;
    const legacy = d.status ? null : parseLegacyCmdDone(raw);
    // 格式4 (hibernate/wait): "hibernate 完成 (50s)" 或 "wait 完成 (35s)\nnext steps"
    // 渲染为简洁的折线结果：⎿ Xs（绿色），无标题。单 Text 避免多余空行
    if (legacy && legacy.kind === "hw") {
      const indent = " ".repeat(GUTTER);
      const prefix = indent + SYM.result + "  ";
      // 数字统一白色粗体，单位 s 保持 success 色（与 Result 行 in Xs 一致）
      let text = legacy.elapsedSec === 0
        ? prefix + theme.fg("success", "Instantly")
        : prefix + String(legacy.elapsedSec) + theme.fg("success", "s"); // 数字 default（与 Result 行一致）
      if (legacy.nextSteps) text += "\n" + indent + "  " + theme.fg("dim", legacy.nextSteps);
      return new Text(text, 0, 0);
    }
    const msgTs = typeof message?.timestamp === "number" ? message.timestamp : undefined; // 事件时刻，不取渲染时刻（LESSON 094）
    const st: any = d.status
      ? { kind: "done", status: d.status, title: d.title, recId: d.recId || "", exitCode: d.exitCode, elapsedMs: (d.elapsedSec ?? 0) * 1000, endTs: d.endTs ?? msgTs, output: d.output ?? "", remaining: d.remaining ?? 0 }
      : { kind: "done", status: legacy!.status, title: d.title, recId: legacy!.recId, exitCode: legacy!.exitCode, elapsedMs: legacy!.elapsedSec * 1000, endTs: msgTs, output: legacy!.output, remaining: legacy!.remaining };
    // merged 只在首次渲染时判定并缓存到 message.details——CustomMessageComponent 每次 invalidate 都重跑渲染器，
    // 那时聊天容器末尾已经追加了别的组件，再算一次就从 ⎿ 翻成 ▸（历史行随心跳重渲染来回跳，ISSUE 226 遗留项）
    if (typeof d._merged === "boolean") st.merged = d._merged;
    else {
      st.merged = _cmdDoneMergesWithCreated(st.recId);
      try { if (message.details && typeof message.details === "object") (message.details as any)._merged = st.merged; } catch { /* details 只读时放弃缓存 */ }
    }
    return renderExecuteResult(theme, st);
  });
  // 全部渲染器注册完成 → 只把实际注册过的 type 标记就位（R002 校验用），并恢复原方法
  (pi as any).registerMessageRenderer = _origRegister;
  for (const t of _actuallyRegistered) _registeredParts.add(t);
}

// ── 表格元素渲染（2026-09-23 用户：两种表格——对齐文本表 + markdown 风格表）──
// 供 status / footer / 任意工具 renderResult 复用。列宽按 CJK 显示宽度对齐（中文=2，ASCII=1）。

/** CJK 显示宽度（中文/全角=2，ASCII=1） */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 补空格到目标显示宽度 */
export function padTo(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - dispWidth(s)));
}

/**
 * 对齐文本表格（无竖线，用 ─ 分隔线）：表头 + ─ + 数据行，列按 CJK 宽度对齐。
 * rows[0] = 表头。返回已拼好的行数组（供 .join("\n")）。
 */
export function renderAlignedTable(rows: string[][], opts?: { indent?: string }): string[] {
  const indent = opts?.indent ?? "";
  const cols = rows[0]?.length ?? 0;
  const widths = new Array(cols).fill(0);
  for (const r of rows) for (let i = 0; i < cols; i++) widths[i] = Math.max(widths[i], dispWidth(r[i] ?? ""));
  const line = (r: string[]) => indent + r.map((c, i) => padTo(c ?? "", widths[i])).join("  ").trimEnd();
  const out: string[] = [line(rows[0] ?? [])];
  out.push(indent + "─".repeat(widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2));
  for (let i = 1; i < rows.length; i++) out.push(line(rows[i] ?? []));
  return out;
}

/**
 * Markdown 风格表格（| 竖线 + |---| 分隔行）：
 *   | col1  | col2  |
 *   |-------|-------|
 *   | val   | val   |
 * rows[0] = 表头。返回已拼好的行数组。
 */
export function renderMarkdownTable(rows: string[][], opts?: { indent?: string }): string[] {
  const indent = opts?.indent ?? "";
  const cols = rows[0]?.length ?? 0;
  const widths = new Array(cols).fill(0);
  for (const r of rows) for (let i = 0; i < cols; i++) widths[i] = Math.max(widths[i], dispWidth(r[i] ?? ""));
  const line = (r: string[]) => indent + "| " + r.map((c, i) => padTo(c ?? "", widths[i])).join(" | ") + " |";
  const out: string[] = [line(rows[0] ?? [])];
  out.push(indent + "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  for (let i = 1; i < rows.length; i++) out.push(line(rows[i] ?? []));
  return out;
}
