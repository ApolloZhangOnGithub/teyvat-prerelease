// 文档: B.docs/Dev.Common/Wiki/Bioclock(Bio Mechanism).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendCustomMessage } from "#kernel_backbone";
import { appendFileSync as _traceAppend, mkdirSync as _traceMkdir } from "node:fs";
import { join as _traceJoin } from "node:path";
import { homedir as _traceHome } from "node:os";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    // 只在 resume/wake 时发日期（不是新 session）
    if (event.reason === "reload" || event.reason === "resume") {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
      sendCustomMessage(pi, "continuous-date", `Current date: ${date}. Timestamps are wall-clock.`);
    }
  });

  function fmt(ts: number): string {
    const d = new Date(ts);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const p3 = (n: number) => String(n).padStart(3, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
  }

  // Only stamp user and toolResult messages (input side).
  // Assistant messages are the model's own output — it knows when it spoke.
  // Return { message } to properly replace, not mutate in place.
  pi.on("message_end" as any, async (event: any, _ctx: any) => {
    const msg = event.message;
    if (!msg) return;

    const role = (msg as any).role;
    if (role !== "user") return;

    const ts = (msg as any).timestamp;
    if (!ts || typeof ts !== "number") return;

    const gauge = (globalThis as any).__genshinContextGauge || "";
    const tag = ` [${fmt(ts)}${gauge ? " | " + gauge : ""}]`;
    const content = (msg as any).content;

    if (typeof content === "string") {
      return { message: { ...msg, content: content.replace(/\s+$/, "") + tag } };
    }

    if (!Array.isArray(content)) return;

    const newContent = content.map((c: any, i: number, arr: any[]) => {
      // Find last text block
      const isLastText =
        c.type === "text" &&
        typeof c.text === "string" &&
        !arr.slice(i + 1).some((x: any) => x.type === "text");
      if (isLastText) {
        return { ...c, text: c.text.replace(/\s+$/, "") + tag };
      }
      return c;
    });

    return { message: { ...msg, content: newContent } };
  });

  // ── Per-tool timing: stamp each tool result with finish time + duration ──
  // write/edit: 从模型开始输出 tool call（tool_call 事件）到结果返回 = 模型写的时间
  // 其他工具: 从 execution_start 到 result = 执行时间
  const toolStart = new Map<string, number>();

  pi.on("tool_call", async (event) => {
    const id = (event as any).toolCallId;
    const name = (event as any).toolName;
    if (id && (name === "write" || name === "edit")) toolStart.set(id, Date.now());
  });

  pi.on("tool_execution_start", async (event) => {
    const id = (event as any).toolCallId;
    if (id && !toolStart.has(id)) toolStart.set(id, Date.now());
  });

  pi.on("tool_result", async (event, _ctx) => {
    const toolName = (event as any).toolName;
    // 元工具（intentions/hibernate/wait）不需要时间戳
    if (toolName === "intentions" || toolName === "hibernate" || toolName === "wait") return;
    const id = (event as any).toolCallId;
    const start = id ? toolStart.get(id) : undefined;
    if (id) toolStart.delete(id);

    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const time = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3,'0')}`;
    const dur = start ? ` +${((Date.now() - start) / 1000).toFixed(1)}s` : "";
    const gauge = (globalThis as any).__genshinContextGauge || "";
    const tag = `\n[${time}${dur}${gauge ? " | " + gauge : ""}]`;

    const content = (event as any).content;
    if (!Array.isArray(content)) return;

    const textBlocks = content.filter((c: any) => c.type === "text" && typeof c.text === "string");
    if (textBlocks.length === 0) return;

    const newContent = content.map((c: any) => {
      if (c === textBlocks[textBlocks.length - 1]) {
        return { ...c, text: c.text.replace(/\s+$/, "") + tag };
      }
      return c;
    });

    return { content: newContent };
  });

  // ── Trace logger: 全事件时间戳记录到 TraceData/<id>/trace.jsonl ──
  // 用于分析 prefill 时间、turn 延迟、tool 执行时间等
  const _traceId = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
  let _traceFile = "";
  if (_traceId) {
    const dir = _traceJoin(_traceHome(), ".teyvat", "TraceData", _traceId);
    try { _traceMkdir(dir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/brain.bioclock/bioclock.ts] " + ((e as any)?.message || e)); }
    _traceFile = _traceJoin(dir, "trace.jsonl");
  }
  function _trace(event: string, data?: any) {
    if (!_traceFile) return;
    try { _traceAppend(_traceFile, JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), event, ...data }) + "\n"); } catch (e) { console.error("[spirit.bio.organs/brain.bioclock/bioclock.ts] " + ((e as any)?.message || e)); }
  }

  _trace("session_start");

  pi.on("agent_start" as any, async () => { _trace("agent_start"); });
  pi.on("agent_end" as any, async () => { _trace("agent_end"); });
  pi.on("message_start" as any, async (event: any) => {
    const role = event?.message?.role;
    _trace("message_start", { role });
  });
  pi.on("message_end" as any, async (event: any) => {
    const msg = event?.message;
    if (!msg) return;
    const role = msg.role;
    const usage = msg.usage;
    _trace("message_end", { role, input: usage?.input, output: usage?.output, cacheRead: usage?.cacheRead, cacheWrite: usage?.cacheWrite });
  });
  pi.on("tool_call" as any, async (event: any) => {
    _trace("tool_call", { toolName: (event as any).toolName, toolCallId: (event as any).toolCallId });
  });
  pi.on("tool_execution_start" as any, async (event: any) => {
    _trace("tool_exec_start", { toolName: (event as any).toolName, toolCallId: (event as any).toolCallId });
  });
  pi.on("tool_result" as any, async (event: any) => {
    _trace("tool_result", { toolName: (event as any).toolName, toolCallId: (event as any).toolCallId });
  });
  pi.on("turn_end" as any, async () => { _trace("turn_end"); });
  pi.on("session_shutdown" as any, async () => { _trace("session_shutdown"); });
}
