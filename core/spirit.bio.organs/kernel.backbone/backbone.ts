// blood.runtime/backbone — 统一注册表（消息 + 工具）
// 所有 messageType / tool 必须在此注册，禁止各器官直接调 pi.sendMessage / pi.registerTool。
// 文档: B.docs/Dev.Common/Wiki/Blood(Bio Mechanism).WIKI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logerr, runtimeCacheDir, sessionDirFor, estimateTokens } from "#paths";
import { debug } from "#gene_riboswitch";
const require = createRequire(import.meta.url);

// ══════════════════════════════════════════════════════════════════════════════
// 消息管线
// ══════════════════════════════════════════════════════════════════════════════
//
// 每条消息两个独立维度：
//   feed:   是否/怎么注入给模型
//   render: 是否渲染给用户
//
// 五个语义分类（category）：
//   resume       — 内部续命信号（触发新 turn）
//   notice       — 系统/器官的通知和警告
//   external     — 外部世界来的消息（微信、语音、提醒）
//   async-result — 工具的延迟返回（和同步 tool result 同语义）
//   context      — 上下文注入（模型需要，用户不需要看 raw data）
//
// ── 显示管线（三层控制，2026-08-15 用户要求机制化）────────────────────────
// 问题：任何自定义消息都会走 pi 原生 CustomMessageComponent 渲染成"提醒"样式，
// 若信息已有专门视觉（如 wait 打断的红折线、execute 黄点），消息行就是重复渲染。
// 三层闸门：
//   1. 声明层  MESSAGE_TYPES.render      —— 该 feed 的默认显示策略。
//                                          缺省视为 true（兜底显示），显式 false = 只喂模型。
//   2. 发送层  sendCustomMessage(overrides.isDisplayedInTUI) —— 单次覆盖（例外发送）。
//   3. 渲染层  TUI addMessageToChat 的 if (message.display) —— display=false 直接跳过，
//                                          消息仍参与 API 请求送达模型。
// 约定：信息已有组件级视觉（折线/黄点/状态栏）的 feed，render 必须写 false。

export type MessageCategory =
  | "resume"
  | "notice"
  | "external"
  | "async-result"
  | "context";

export interface MessageTypeDef {
  messageType: string;
  category: MessageCategory;
  source?: string;  // 2026-08-20：改可选——多模块通用通知（如 continuous-cmd-done）无单一 source，去掉后不校验
  label: string;
  feed: boolean;
  feedAs: "followUp" | "steer" | "nextTurn";
  triggerNewTurn: boolean;
  render: boolean;
  description: string;
}

export const MESSAGE_TYPES: Record<string, MessageTypeDef> = {

  // ── resume: 内部续命信号 ──────────────────────────────────────────────────
  "continuous-next": {
    messageType: "continuous-next",
    category: "resume",
    source: "heart",
    label: "Auto-Resume",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: false,
    description: "turn 结束后自动续命",
  },
  "continuous-resume": {
    messageType: "continuous-resume",
    category: "resume",
    source: "heart",
    label: "Resumed From Wait",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: true,
    description: "wait 倒计时结束 / 进程重启回顾",
  },
  "wait-interrupted": {
    messageType: "wait-interrupted",
    category: "notice",
    source: "heart",
    label: "Wait Interrupted",
    feed: true, feedAs: "nextTurn", triggerNewTurn: false,
    // render:false —— 打断已有组件自画的红折线（Waited Xs (interrupted by ...)），
    // 消息只喂模型，不再重复渲染给用户（2026-08-15 用户反馈"没必要再渲染一次"）
    render: false,
    description: "wait 中途被打断（含实际等待秒数，nextTurn 与打断消息同请求一次性送达模型，不渲染）",
  },
  // @UNUSED — 无活跃发送方，保留仅为兼容历史 session 回放
  "continuous-retry": {
    messageType: "continuous-retry",
    category: "resume",
    source: "heart",
    label: "Retrying",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: false,
    description: "意图栈为空时的续命提示",
  },
  // @UNUSED — 无活跃发送方，保留仅为兼容历史 session 回放
  "continuous-timeout": {
    messageType: "continuous-timeout",
    category: "resume",
    source: "heart",
    label: "Alert Of Timeout",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: false,
    description: "超时通知",
  },
  // @UNUSED — 无活跃发送方，保留仅为兼容历史 session 回放
  "sleep-wake-resume": {
    messageType: "sleep-wake-resume",
    category: "resume",
    source: "hippocampus",
    label: "Resumed From Sleep",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: false,
    description: "睡眠唤醒后的恢复",
  },

  // ── notice: 系统/器官通知 ─────────────────────────────────────────────────
  "conscious-aware": {
    messageType: "conscious-aware",
    category: "notice",
    source: "metaconsciousness",
    label: "Notice From Metaconsciousness",
    feed: true, feedAs: "nextTurn", triggerNewTurn: false,
    render: true,
    description: "元意识觉察",
  },
  "memory-capacity": {
    messageType: "memory-capacity",
    category: "notice",
    source: "hippocampus",
    label: "Alert From System: memory",
    feed: false, feedAs: "nextTurn", triggerNewTurn: false,
    render: true,
    description: "上下文容量警告（仅UI显示，不喂模型——模型自主管理，不被系统提醒逼着用）",
  },
  // @UNUSED — 无活跃发送方，保留仅为兼容历史 session 回放
  "budget-trip": {
    messageType: "budget-trip",
    category: "notice",
    source: "budget",
    label: "Alert From System: budget",
    feed: true, feedAs: "nextTurn", triggerNewTurn: true,
    render: true,
    description: "预算超限告警",
  },
  "continuous-error-retry": {
    messageType: "continuous-error-retry",
    category: "notice",
    source: "heart",
    label: "Alert From System: API error",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: true,
    description: "API 错误后自动重试",
  },
  "system-error": {
    messageType: "system-error",
    category: "notice",
    source: "system",
    label: "Alert From System: error",
    feed: true, feedAs: "nextTurn", triggerNewTurn: false,
    render: true,
    description: "系统错误",
  },
  "syntax-error": {
    messageType: "syntax-error",
    category: "notice",
    source: "fileactions",
    label: "Alert From System: syntax error",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: true,
    description: "语法错误",
  },
  // @UNUSED — 无活跃发送方，保留仅为兼容历史 session 回放
  "hippocampus-error": {
    messageType: "hippocampus-error",
    category: "notice",
    source: "hippocampus",
    label: "Alert From System: hippocampus error",
    feed: true, feedAs: "nextTurn", triggerNewTurn: false,
    render: true,
    description: "海马体异常",
  },
  "memory-reminder": {
    messageType: "memory-reminder",
    category: "notice",
    source: "hippocampus",
    label: "Reminder",
    feed: true, feedAs: "nextTurn", triggerNewTurn: false,
    render: true,
    description: "提醒到期",
  },

  // ── external: 外部世界来的消息 ────────────────────────────────────────────
  "mobile-notification": {
    messageType: "mobile-notification",
    category: "external",
    source: "mobile",
    label: "Message From Mobile",
    feed: true, feedAs: "steer", triggerNewTurn: true,
    render: true,
    description: "手机通知/微信消息",
  },
  "ear": {
    messageType: "ear",
    category: "external",
    source: "ears",
    label: "Hear",
    feed: true, feedAs: "steer", triggerNewTurn: true,
    render: true,
    description: "语音转录",
  },
  "social-message": {
    messageType: "social-message",
    category: "external",
    source: "heart",  // 2026-08-20：实际注入在 heart 器官（heart.ts:724 / heart-hibernate.ts:132），原"social"对不上
    label: "Message From Agent",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: true,
    description: "agent 间社交消息（interrupt/queue/deferred）",
  },
  "reminder-check": {
    messageType: "reminder-check",
    category: "external",
    source: "bioclock",
    label: "Reminder",
    feed: true, feedAs: "followUp", triggerNewTurn: false,
    render: true,
    description: "闹钟/提醒检查",
  },

  // ── async-result: 工具的延迟返回 ─────────────────────────────────────────
  "continuous-cmd-done": {
    messageType: "continuous-cmd-done",
    category: "async-result",
    // 2026-08-20：多模块发送（executes/webacts/outbox/heart）的通用通知——去掉 source（单一声明对不上全部调用方）
    label: "Result (Execute)",
    feed: true, feedAs: "steer", triggerNewTurn: true,
    render: true,
    description: "后台命令执行完成",
  },

  // ── context: 上下文注入 ──────────────────────────────────────────────────
  "memory-snapshot": {
    messageType: "memory-snapshot",
    category: "context",
    source: "memory",  // 2026-08-20：发送方是 brain.memory/memory.ts（海马体已重构并入 memory），原"hippocampus"过时
    label: "Context: memory snapshot",
    feed: true, feedAs: "followUp", triggerNewTurn: false,
    render: false,
    description: "记忆快照注入",
  },
  "memory-frozen-delta": {
    messageType: "memory-frozen-delta",
    category: "context",
    source: "memory",  // 2026-08-20：同上，发送方 memory.ts
    label: "Context: memory delta",
    feed: true, feedAs: "followUp", triggerNewTurn: false,
    render: false,
    description: "冻结 delta 注入",
  },
  "sleep-done": {
    messageType: "sleep-done",
    category: "context",
    source: "hippocampus",
    label: "Context: sleep done",
    feed: true, feedAs: "followUp", triggerNewTurn: false,
    render: false,
    description: "睡眠完成信号",
  },
  "continuous-date": {
    messageType: "continuous-date",
    category: "context",
    source: "bioclock",
    label: "Context: date",
    feed: true, feedAs: "nextTurn", triggerNewTurn: false,
    render: true,
    description: "日期变更",
  },
  "display-hidden": {
    messageType: "display-hidden",
    category: "notice",
    source: "heart",
    label: "Hidden",
    feed: true, feedAs: "nextTurn", triggerNewTurn: false,
    render: true,
    description: "显示已隐藏（/h 转后台 headless，2026-08-20）",
  },
  "display-shown": {
    messageType: "display-shown",
    category: "notice",
    source: "heart",
    label: "Shown",
    feed: true, feedAs: "nextTurn", triggerNewTurn: false,
    render: true,
    description: "显示已恢复（attach 回前台 TUI，2026-08-20）",
  },
  "metaconsciousness-heartbeat": {
    messageType: "metaconsciousness-heartbeat",
    category: "context",
    source: "metaconsciousness",
    label: "Context: heartbeat",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: false,
    description: "元意识心跳",
  },
  "tool-result-debug": {
    messageType: "tool-result-debug",
    category: "context",
    source: "debug",
    label: "Context: debug",
    feed: true, feedAs: "followUp", triggerNewTurn: true,
    render: false,
    description: "工具结果调试",
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// 工具管线
// ══════════════════════════════════════════════════════════════════════════════
//
// 所有工具通过 registerPaimonTool() 注册。两个独立维度：
//   renderResult — TUI 怎么渲染结果（必填）
//   feedResult   — execute 返回的 content 是否回传给模型（默认 true）
//
// feedResult: false 时，管线拦截：
//   - 原始 content 存入 details._content 供 renderResult 读取
//   - 发给模型的 content 清空为 []
//   - isError 时不拦截，错误信息始终回传

const TOOL_QUEUE: any[] = [];

// help 库：name → { desc, detail }。注册时自动收集 messageDescription，
// help 工具按需查询（系统提示只给一行摘要，详情走 help，省 token）。
const TOOL_HELP: Record<string, { desc: string; detail: string }> = {};
export function getToolHelp(name: string): { desc: string; detail: string } | undefined {
  return TOOL_HELP[name];
}
export function getAllToolHelp(): Record<string, { desc: string; detail: string }> {
  return TOOL_HELP;
}

let _pi: ExtensionAPI | null = null;

// 调用此函数注册工具后，还必须做三步（NORM-013, LESSON 055）：
// 1) tools.manifest.json 加条目  2) promotor.dna 加 func 声明  3) core.ts REGISTRY 加 import + 登记
// 缺任何一步：make 报错（manifest-tools check）或运行时 K020 炸。Wiki: Func(Bio Mechanism).WIKI
export function registerPaimonTool(toolDef: any): void {
  if (!toolDef?.name) throw new Error(`registerPaimonTool: name required`);
  if (!toolDef.renderCall || !toolDef.renderResult) {
    const missing = [!toolDef.renderCall && "renderCall", !toolDef.renderResult && "renderResult"].filter(Boolean).join(", ");
    const msg = `registerPaimonTool(${toolDef.name}): 缺少 ${missing} — 跳过注册`;
    const logDir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
    try { mkdirSync(logDir, { recursive: true }); appendFileSync(join(logDir, "tool-error.log"), `[${new Date().toISOString()}] ERROR: ${msg}\n`); } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
    console.error(`[ERROR] ${msg}`);
    return;
  }
  toolDef.renderShell = "self";

  // 收集到 help 库（desc 优先取 manifest，注册时先用 messageDescription 精简摘要）
  try {
    const detail = (toolDef.messageDescription || "").trim();
    const desc = (toolDef.promptSnippet || detail.split("\n")[0] || toolDef.name).trim();
    TOOL_HELP[toolDef.name] = { desc: desc.slice(0, 120), detail };
  } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }

  // wrap execute: 给每个工具结果 append context capacity stats
  // 统一管线（2026-08-18 用户定稿）：结果尾部附 [result N tokens, ctx X.Xk]——
  // context 总量在此实时估算（工具结果后即最新值，正是每轮结尾的感知点），
  // 不再由 before_agent_start 每轮注入（旧设计已废弃：memory.ts 现为 80% 阈值告警，feed:false）。
  // 渲染层（renderMessage.output/summary）统一剥离此标注；memory-capacity 告警独立保留。
  if (toolDef.execute && toolDef.feedResult !== false && toolDef.name !== "amem") {
    const _origExecute = toolDef.execute;
    toolDef.execute = async function (...args: any[]) {
      const result = await _origExecute.apply(this, args);
      try {
        if (result?.content?.length) {
          const resultText = result.content.map((c: any) => c.text || "").join("");
          const resTok = estimateTokens(resultText);
          if (resTok > 50) {
            // 实时 context 总量（读 context.md 估算，与 memory.ts 同款算法）
            // 2026-09-07：__genshinPersonDir 未设（重启初始化早期窗口）时跳过——优雅降级（不拼 contexted），非错误不刷日志
            let ctxTok = 0;
            const _personDir = (global as any).__genshinPersonDir;
            if (_personDir) {
              try {
                const ctxPath = join(_personDir, "context.md");
                const ctxStr = readFileSync(ctxPath, "utf8");
                ctxTok = estimateTokens(ctxStr);
              } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
            }
            const fmtTok = (n: number) => n < 1000 ? n + "" : n < 1e6 ? (n / 1000).toFixed(1) + "k" : (n / 1e6).toFixed(1) + "M";
            const ctxPart = ctxTok > 0 ? `, contexted ${fmtTok(ctxTok)}` : "";
            const lastContent = result.content[result.content.length - 1];
            if (lastContent?.type === "text") {
              lastContent.text += `\n[result ${fmtTok(resTok)} tokens${ctxPart}]`;
            }
          }
        }
      } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
      return result;
    };
  }

  if (_pi) {
    _pi.registerTool(toolDef);
  } else {
    TOOL_QUEUE.push(toolDef);
  }
}

export function resultContent(result: any): any[] {
  return result?.details?._content || result?.content || [];
}

/**
 * 消息是否【确定会开新 turn】（LESSON 054）。
 * 状态机的"唤醒"规则只能对它返回 true 的消息生效——trigger=false 的消息是"只显示不开 turn"，
 * 若被当作唤醒信号切状态，会清掉 wait 的 resumeTimer 且无人续命 → 永久卡 working。
 * 未注册类型按 true 处理（兼容旧行为：宁可唤醒，不拦截未知信号）。
 */
export function messageTriggersTurn(messageType: string): boolean {
  const def = MESSAGE_TYPES[messageType];
  return def ? def.triggerNewTurn === true : true;
}

export function flushTools(pi: ExtensionAPI): void {
  _pi = pi;
  for (const def of TOOL_QUEUE) {
    pi.registerTool(def);
  }
  TOOL_QUEUE.length = 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// 统一发送函数
// ══════════════════════════════════════════════════════════════════════════════

export function sendCustomMessage(
  pi: ExtensionAPI,
  messageType: string,
  content: string,
  details?: unknown,
  overrides?: { deliverAs?: string; isTriggerNewTurn?: boolean; isDisplayedInTUI?: boolean },
) {
  const def = MESSAGE_TYPES[messageType];
  if (!def) {
    throw new Error(
      `消息类型 "${messageType}" 未在 MESSAGE_TYPES 注册。` +
      `所有消息必须走 sendCustomMessage()。`
    );
  }
  // PROPOSAL-030: source 校验（WARN，不阻止）
  if (def.source) {
    try {
      const stack = new Error().stack || "";
      const callerLine = stack.split("\n").slice(2).find(l => !l.includes("backbone.ts") && !l.includes("backbone.js"));
      if (callerLine && !callerLine.includes(def.source)) {
        const logDir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
        try { mkdirSync(logDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
        appendFileSync(join(logDir, "boundary-warn.log"),
          `[${new Date().toISOString()}] BOUNDARY: "${messageType}" 声明 source="${def.source}"，但调用方不匹配: ${callerLine.trim()}\n`);
      }
    } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
  }
  // 2026-08-18 解耦 PROPOSAL 034 阶段 2：渲染决策环境化——内核不再拍板"显示给谁"。
  // display 由「UI 环境标志 + 声明」决定：
  //   - TUI 环境（interactive-mode 启动时注册 __genshinUIEnv=true）→ 按声明渲染（render !== false），
  //     overrides.isDisplayedInTUI 保留为发送层单次覆盖（0.3.1 三层闸门）；
  //   - headless（rpc/print 模式，mc/hc 及未来 main）→ 一律 false：消息只投递不渲染，
  //     调用方/声明都覆盖不了——"是否显示给用户"是 UI 环境的事，不是内核/调用方的事。
  // 投递（deliverAs/triggerTurn）与渲染（display）自此解耦：内核只管消息以什么方式送达 agent。
  const _sendResult = pi.sendMessage(
    {
      customType: messageType,
      content,
      display: (globalThis as any).__genshinUIEnv ? (overrides?.isDisplayedInTUI ?? (def.render !== false)) : false,
      details,
    },
    {
      deliverAs: (overrides?.deliverAs ?? def.feedAs) as any,
      triggerTurn: overrides?.isTriggerNewTurn ?? def.triggerNewTurn,
    }
  );
  // pi.sendMessage 可能返回 Promise 也可能返回 void（取决于框架版本）
  (_sendResult as any)?.catch?.((e: unknown) => {
    // 消息投递失败绝不能静默丢：30+ 调用点大多没 await（async reject = unhandledRejection），
    // 后台命令无返回（cmd-done 丢失）等事故都源于此。这里统一兜底记录。
    logerr("K029", e, `sendCustomMessage ${messageType}`);
    // 关键消息（continuous-cmd-done 等）写入 boundary-warn 以便排查
    try {
      const logDir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
      try { mkdirSync(logDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
      appendFileSync(join(logDir, "boundary-warn.log"),
        `[${new Date().toISOString()}] SEND-FAIL "${messageType}": ${(e as any)?.message ?? e}\n`);
    } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// outbox — 后台推送的持久化发件箱（at-least-once）
// 2026-08-20：从独立文件 outbox.ts 合并进 backbone.ts（用户定稿：同器官功能不单独建文件，
// 与 sendCustomMessage 同文件——修复/功能应合并进既有器官文件，不许擅自新建）。
// ⚠️ 问责（2026-08-20 用户责令）：qwen-3-8-27b-infer-test-01 于 08-18 擅自新建独立文件
//   outbox.ts——违反 NORM-001 文件命名（组件文件应为 {主名}-{组件名}，outbox 既非主文件
//   也不符组件命名）+ 未经审批乱放文件到 kernel.backbone。逻辑本体保留（设计 OK），
//   文件组织已责令纠正：合并回 backbone.ts，SPEC 有需要部分合入 Blood WIKI。
// 逻辑本体（qwen-3-8-27b-infer-test-01 于 08-18 实现，ISSUE 119 P1）：
//   agent loop 被 wait/terminate 停掉期间发出的 continuous-cmd-done 推送会被 SDK 吞掉
//   （steer 孤儿 / batch 路径 unhandled rejection），outbox 把"推送产生"与"投递窗口"解耦：
//     1. outboxSend：先落盘 pending.json 再发送（正常路径与旧行为完全一致）
//     2. heart 转 working（wait 恢复/用户消息/hibernate 唤醒）时 outboxFlush：
//        ack 检查（acked.log + 最近 session jsonl）+ 未送达重发 + 超限进 failed.json
//   语义：at-least-once——可能重复送达，不会丢失。

const OUTBOX_MAX_AGE_MS = 30 * 60 * 1000; // 超过 30 分钟的消息不再重发（进 failed.json）
const OUTBOX_GRACE_MS = 5000;              // ISSUE 121：发送后 5 秒内不重发（避开「已投递未落盘 session」的误判窗口）
const OUTBOX_MAX_ATTEMPTS = 5;             // 最多重发次数（含首次）
const OUTBOX_ACK_KEY_LEN = 80;             // matchKey = 消息开头 80 字（重发时稳定不变）
const OUTBOX_ACKED_LOG_CAP = 2000;         // acked.log 行数封顶（只保留最近）

export interface OutboxOverrides {
  deliverAs?: string;
  isTriggerNewTurn?: boolean;
  isDisplayedInTUI?: boolean;
}

interface OutboxEntry {
  id: string;
  type: string;
  content: string;
  details?: unknown;
  overrides?: OutboxOverrides;
  sentAt: number;
  attempts: number;
}

function outboxDlog(msg: string): void {
  // 复用 D0001（Heart 段，PI_DEBUG=D0001）——outbox flush 挂在 heart 状态机上，语义同段
  try { debug.log("D0001", `outbox ${msg}`); } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
}

function outboxPid(): string {
  return process.env.PAIMON_AGENT_ID || String((globalThis as any).__genshinPersonId || "unknown");
}

function outboxDir(): string {
  const d = join(runtimeCacheDir(outboxPid()), "outbox");
  try { mkdirSync(d, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
  return d;
}
function outboxPendingFile(): string { return join(outboxDir(), "pending.json"); }
function outboxAckedFile(): string { return join(outboxDir(), "acked.log"); }
function outboxFailedFile(): string { return join(outboxDir(), "failed.json"); }

function readPending(): OutboxEntry[] {
  try {
    const arr = JSON.parse(readFileSync(outboxPendingFile(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e));
    return [];
  }
}

function writePending(entries: OutboxEntry[]): void {
  const tmp = outboxPendingFile() + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries), "utf8");
  renameSync(tmp, outboxPendingFile());
}

function ackedIds(): Set<string> {
  try {
    const lines = readFileSync(outboxAckedFile(), "utf8").split("\n").filter(Boolean);
    return new Set(lines.map(l => l.split("\t")[0]));
  } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e));
    return new Set();
  }
}

function markAcked(e: OutboxEntry): void {
  try {
    appendFileSync(outboxAckedFile(), `${e.id}\t${e.type}\t${Date.now()}\n`, "utf8");
    const lines = readFileSync(outboxAckedFile(), "utf8").split("\n").filter(Boolean);
    if (lines.length > OUTBOX_ACKED_LOG_CAP) {
      writeFileSync(outboxAckedFile(), lines.slice(lines.length - OUTBOX_ACKED_LOG_CAP).join("\n") + "\n", "utf8");
    }
  } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
}

function matchKey(content: string): string {
  // session jsonl 里的 content 是 JSON 转义字符串——匹配键必须用转义形态
  return JSON.stringify(content.slice(0, OUTBOX_ACK_KEY_LEN)).slice(1, -1);
}

function recentSessionBlobs(): string[] {
  // 最近 2 个 session jsonl（当前 + 重启前上一个）——覆盖"上个 session 已送达但没来得及 ack"的重启场景
  try {
    const dir = sessionDirFor(outboxPid());
    const files = readdirSync(dir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => {
        try { return { f, m: statSync(join(dir, f)).mtimeMs }; } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); return null; }
      })
      .filter((x): x is { f: string; m: number } => x !== null)
      .sort((a, b) => b.m - a.m)
      .slice(0, 2);
    return files.map(({ f }) => {
      try { return readFileSync(join(dir, f), "utf8"); } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); return ""; }
    });
  } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e));
    return [];
  }
}

/**
 * outbox 发送：先落盘再发送。正常路径与旧 sendCustomMessage 行为一致；
 * 若发送被框架吞掉（wait 窗口等），outboxFlush 会在唤醒后重发。
 */
export function outboxSend(
  pi: ExtensionAPI,
  messageType: string,
  content: string,
  details?: unknown,
  overrides?: OutboxOverrides,
): void {
  const entry: OutboxEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: messageType,
    content,
    details,
    overrides,
    sentAt: Date.now(),
    attempts: 1,
  };
  try {
    const entries = readPending();
    entries.push(entry);
    writePending(entries);
  } catch (e: any) {
    // 落盘失败不阻塞发送（降级为旧行为），但记日志——此时若推送被吞将无兜底
    outboxDlog(`outboxSend persist failed (${e?.message ?? e}) — 降级为直接发送`);
  }
  try {
    sendCustomMessage(pi, messageType, content, details, overrides);
  } catch (e: any) {
    // 发送层抛错（类型未注册等）：条目留在 pending，flush 时重试/超限时进 failed
    outboxDlog(`outboxSend send threw: ${e?.message ?? e}`);
  }
}

/**
 * outbox flush：ack 检查 + 未送达重发。
 * 由 heart.ts 的 onHeartStateChange 在状态转 working 时调用。
 * 全程同步（同步 fs + 同步 sendCustomMessage），与 transition 同 tick 完成——
 * 重发消息与唤醒消息（continuous-resume 等）进同一批 batch pipeline，同一个 run 送达。
 */
export function outboxFlush(pi: ExtensionAPI): void {
  const entries = readPending();
  if (entries.length === 0) return;

  const acked = ackedIds();
  const sessionBlobs = recentSessionBlobs();
  const remaining: OutboxEntry[] = [];
  let ackedNow = 0, resent = 0, gaveUp = 0;

  for (const e of entries) {
    if (acked.has(e.id)) { ackedNow++; continue; }
    if (sessionBlobs.some(b => b.includes(matchKey(e.content)))) {
      markAcked(e);
      ackedNow++;
      continue;
    }
    const age = Date.now() - e.sentAt;
    if (age < OUTBOX_GRACE_MS) { remaining.push(e); continue; } // ISSUE 121：保护期，刚发送的保留不重发（避开 batch 缓冲未落盘窗口）
    if (age > OUTBOX_MAX_AGE_MS || e.attempts >= OUTBOX_MAX_ATTEMPTS) {
      try {
        let cur: OutboxEntry[] = [];
        try { cur = JSON.parse(readFileSync(outboxFailedFile(), "utf8")); if (!Array.isArray(cur)) cur = []; } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
        cur.push(e);
        writeFileSync(outboxFailedFile(), JSON.stringify(cur, null, 1), "utf8");
      } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
      outboxDlog(`outbox: give up ${e.id} (${e.type}, age=${Math.round(age / 1000)}s, attempts=${e.attempts}) → failed.json`);
      gaveUp++;
      continue;
    }
    try {
      sendCustomMessage(pi, e.type, e.content, e.details, e.overrides);
      e.attempts++;
      resent++;
    } catch (err: any) {
      outboxDlog(`outbox resend threw: ${err?.message ?? err}`);
    }
    remaining.push(e);
  }

  // BUGFIX（2026-08-18，qwen-3-8-27b-infer-test-01，实测发现）：旧条件
  // `remaining.length !== entries.length` 在"只发生 resend"时（数量不变、仅 attempts++）
  // 不触发写回——attempts 永不持久化，MAX_ATTEMPTS=5 上限失效（只剩 30min 龄期兑底）。
  // 现在只要发生任何状态变化（ack/resend/放弃）就写回。
  if (ackedNow || resent || gaveUp) {
    try { writePending(remaining); } catch (e) { console.error("[spirit.bio.organs/kernel.backbone/backbone.ts] " + ((e as any)?.message || e)); }
  }
  if (ackedNow || resent || gaveUp) {
    outboxDlog(`outbox flush: ${entries.length} pending → acked ${ackedNow}, resent ${resent}, gave up ${gaveUp}, still pending ${remaining.length}`);
  }
}
