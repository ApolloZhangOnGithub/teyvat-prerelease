// kernel.heart/hibernate — 独立 hibernate 工具（从 next.ts 拆出）
// 文档: B.docs/Dev.Common/Wiki/Hibernate(Tool & State).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionRole } from "#kernel_ribosome";
import { runtimeCacheDir } from "#paths";
import { registerPaimonTool, sendCustomMessage } from "#kernel_backbone";
import { backgroundTasksSummary } from "#hands_execute";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { drainPendingSocialWithMeta, hasPendingSocial } from "#social_communicate";
import { debug } from "#gene_riboswitch";
import { i18n } from "#tui_localizations";
import { heartState, setHasUserMessage, transition, dlog, personId, isHibernateDisabled } from "./heart-state.ts";

// ── parseUntil: 解析时间字符串 → 毫秒时间戳，失败返回 null ──
function parseUntil(raw: string): number | null {
  // ISO: YYYY-MM-DDTHH:MM
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (isoMatch) {
    const d = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T${isoMatch[4]}:${isoMatch[5]}:00`);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  // tomorrow HH:MM
  const tomorrowMatch = raw.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/i);
  if (tomorrowMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(parseInt(tomorrowMatch[1]), parseInt(tomorrowMatch[2]), 0, 0);
    return d.getTime();
  }
  // HH:MM
  const hhmmMatch = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    const d = new Date();
    d.setHours(parseInt(hhmmMatch[1]), parseInt(hhmmMatch[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

// 把 until 时间戳格式化为可读标签（供状态栏显示）：
// 今天 → "07:09"，明天 → "明天 07:09"，更远 → "08-13 07:09"
function fmtUntilLabel(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const targetStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((targetStart - todayStart) / 86400000);
  if (dayDiff <= 0) return `${hh}:${mm}`;
  if (dayDiff === 1) return i18n(`明天 ${hh}:${mm}`, `tomorrow ${hh}:${mm}`);
  const mm2 = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm2}-${dd} ${hh}:${mm}`;
}

export function registerHibernateTool(_pi: ExtensionAPI) {
  registerPaimonTool({
    name: "hibernate",
    label: "Hibernate",
    messageDescription:
      "Deep sleep until user returns or specified time. Call when you have nothing left to do.\n" +
      "Summary should describe what you accomplished.\n" +
      "Add until:'HH:MM' to wake at a specific time (e.g. '09:00', 'tomorrow 09:00', or ISO datetime).",
    promptSnippet: "hibernate({summary:'what you did'}) to sleep, hibernate({summary:..., until:'HH:MM'}) for timed wake",
    parameters: Type.Object({
      summary: Type.String({ messageDescription: "Summary of what you accomplished" }),
      until: Type.Optional(Type.String({ messageDescription: "Wake time: 'HH:MM' (today/tomorrow), 'tomorrow HH:MM', or ISO datetime" })),
    }),
    renderCall(args: any, theme: any) {
      // 2026-09-11：Claude Code 风格——灰色 ✻ + 灰色摘要
      const s = (args?.summary ?? "").trim();
      const until = args?.until ? String(args.until).trim() : "";
      const untilStr = until ? theme.fg("dim", ` until ${until}`) : "";
      const { Text: T, Container: C } = require("@earendil-works/pi-tui");
      const c = new C();
      c.addChild(new T(theme.fg("dim", "✻") + " " + theme.fg("dim", s || "hibernating") + untilStr, 0, 0));
      return c;
    },
    renderResult(result, _opts, t, ctx) {
      // ctx.isError 对 Paimon 工具不可靠，直接从 content 文本判断
      const text = (result?.content || [])[0]?.text || "";
      const isErr = ctx?.isError || /^(ERR:|还有|禁止|请先)/.test(text);
      if (isErr) return renderMessage.summary(t, { isError: true }, text);
      return renderMessage.silent();
    },
    async execute(_id, rawParams, _signal, _onUpdate, _ctx) {
      const gbg = (globalThis as any).__genshinBgCount;
      debug.log("D0002", `execute bgCount=${gbg} gb-type=${typeof gbg}`);
      const params = rawParams as { summary: string };
      // _heart 是模块级全局变量——analysis session 的 hibernate 会把它设成 hibernated，
      // 导致主 session 的 hibernate 被下面守卫拦截。现在去掉守卫，始终调 transition，
      // StatusBar.transition 自带防重入 guard。
      if (heartState() !== "working" && heartState() !== "resting" && heartState() !== "hibernated") {
        return { content: [{ type: "text", text: "" }], details: {} };
      }
      if (!params.summary?.trim()) {
        return { content: [{ type: "text", text: i18n("ERR: summary 不能为空。", "ERR: summary cannot be empty.") }], details: {}, isError: true };
      }

      // ── until 时间解析 ──
      let untilTs: number | null = null;
      const untilRaw = (params as any).until?.trim();
      if (untilRaw) {
        untilTs = parseUntil(untilRaw);
        if (untilTs === null) {
          return { content: [{ type: "text", text: i18n(`ERR: until 格式无法识别: "${untilRaw}"。支持 'HH:MM', 'tomorrow HH:MM', 'YYYY-MM-DDTHH:MM'。`, `ERR: unrecognized until format: "${untilRaw}". Supported: 'HH:MM', 'tomorrow HH:MM', 'YYYY-MM-DDTHH:MM'.`) }], details: {}, isError: true };
        }
        if (untilTs <= Date.now() + 30_000) {
          return { content: [{ type: "text", text: i18n("ERR: until 时间必须在 30 秒之后。", "ERR: until time must be at least 30 seconds from now.") }], details: {}, isError: true };
        }
      }
      if (getSessionRole() === "metaconsciousness") {
        return { content: [{ type: "text", text: i18n("ERR: 元意识不能 hibernate。用 wait 代替。", "ERR: Metaconsciousness cannot hibernate. Use wait instead.") }], details: {}, isError: true };
      }
      if (isHibernateDisabled()) {
        return { content: [{ type: "text", text: i18n("ERR: hibernate 已被禁用（/hibernate off）。用 wait 代替。", "ERR: hibernate is disabled (/hibernate off). Use wait instead.") }], details: {}, isError: true };
      }
      // 检查是否有后台 Execute 任务仍在运行
      const bgCount = (globalThis as any).__genshinBgCount || (process as any).__genshinBgCount || 0;
      if (bgCount > 0) {
        const bgList = backgroundTasksSummary();
        return { content: [{ type: "text", text: i18n(`还有 ${bgCount} 个后台 Execute 任务在运行：\n${bgList}\n请使用 Wait 等待任务结束，或 @N kill 终止。`, `${bgCount} background Execute task(s) still running:\n${bgList}\nUse Wait for them to finish, or @N kill to terminate.`) }], details: {}, isError: true };
      }
      // ── Social Tool：inbox 有未处理消息 → 先注入处理，禁止 hibernate ──
      if (hasPendingSocial()) {
        setTimeout(() => {
          const drained = drainPendingSocialWithMeta(10);
          if (drained) sendCustomMessage(_pi, "social-message", drained.text, drained.meta);
        }, 0);
        return { content: [{ type: "text", text: i18n("收到 agent 消息，先处理再休眠。", "Pending agent messages — handle them before hibernating.") }], details: {} };
      }
      // 长时间休眠才卸载 TUI 消息区（默认 10 分钟，PAIMON_HIBERNATE_UNLOAD_MIN 可调；0=不卸载）。
      // 卸载只清 chat 消息组件（Markdown 解析树/渲染行是内存大头），status bar/唤醒计时器独立运行不受影响。
      const unloadMin = Math.max(0, parseInt(process.env.PAIMON_HIBERNATE_UNLOAD_MIN || "10", 10) || 0);
      const unloadTimer = unloadMin > 0
        ? setTimeout(() => {
            if (heartState() !== "hibernated") return; // 已醒，跳过
            dlog(`hibernate unload: 已休眠超 ${unloadMin} 分钟，卸载消息区`);
            try { (globalThis as any).__genshinUnloadChat?.(); } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-hibernate.ts] " + ((e as any)?.message || e)); }
          }, unloadMin * 60_000)
        : undefined;
      transition({ kind: "hibernated", ts: Date.now(), unloadTimer });
      setHasUserMessage(false);
      dlog("hibernate" + (untilTs ? ` until=${untilTs}` : ""));

      // ── until: 写 wake-at 文件，由心跳循环（heart.ts）轮询触发唤醒。
      // 历史：v1 用 `at` 命令排程 touch .ready 文件。macOS 上 /usr/lib/cron 受
      // SIP 保护 + atrun 未启用 → Operation not permitted，且错误被 catch 静默
      // 吞掉（issue 071）。唤醒改由心跳 30s 轮询 Date.now() >= until 完成，
      // 纯进程内，不依赖外部调度器。
      // 文件名 wake-at（存唤醒目标时刻），曾用名 wake-until，见 heart.ts 兼容清理。
      // 方案 E：wake-at 是 hibernate 状态的文件投影——进入 hibernate 先清旧文件，
      // 无 until 时彻底不留（防残留旧 wake 在后续无 until 睡眠中被误触发）。
      try {
        const pid = personId();
        try { require("fs").unlinkSync(join(runtimeCacheDir(pid), "wake-at")); } catch (e) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/kernel.heart/heart-hibernate.ts] " + ((e as any)?.message || e)); } // ENOENT=旧文件本就不存在（正常）静默，同 heart.ts 清理模式
        try { require("fs").unlinkSync(join(runtimeCacheDir(pid), "wake-until")); } catch (e) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/kernel.heart/heart-hibernate.ts] " + ((e as any)?.message || e)); }
        if (untilTs) {
          const wakeFile = join(runtimeCacheDir(pid), "wake-at");
          writeFileSync(wakeFile, JSON.stringify({ until: untilTs, summary: params.summary, ts: Date.now() }), "utf8");
          // 可读时间+时间戳挂到 globalThis，供 statebar 状态栏显示倒计时（issue 071 附带）
          (globalThis as any).__genshinHibernateUntil = fmtUntilLabel(untilTs);
          (globalThis as any).__genshinHibernateUntilTs = untilTs;
          dlog(`hibernate until=${untilTs} wakeFile written`);
        } else {
          // 无 until：确保标签也清掉（上次 hibernate(until) 的残留）
          (globalThis as any).__genshinHibernateUntil = null;
          (globalThis as any).__genshinHibernateUntilTs = null;
        }
      } catch (e: any) {
        dlog(`hibernate wakeFile write failed: ${e?.message}`);
      }
      try {
        const pid = personId();
        const role = getSessionRole();
        const tag = role === "main" ? "main-hibernate" : role === "metaconsciousness" ? "mc-hibernate" : null;
        if (pid && tag) writeFileSync(join(runtimeCacheDir(pid), tag), String(Date.now()), "utf8");
      } catch (e) { console.error("[spirit.bio.organs/kernel.heart/heart-hibernate.ts] " + ((e as any)?.message || e)); }
      // terminate:true is handled by the agent-session.js override (god.frontend.tui/overrides).
      // It calls runner.abortFn() which stops the agent loop before the next turn.
      return { content: [], details: { hibernate: params.summary }, terminate: true };
    },
  });
}
