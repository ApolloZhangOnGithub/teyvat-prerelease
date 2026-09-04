// 文档: B.docs/Dev.Common/Wiki/Aware(MC Tool).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
const StringEnum = <T extends string>(values: readonly T[]) => Type.Union(values.map(v => Type.Literal(v)));
import { readFile } from "node:fs/promises";
import { sendCustomMessage } from "#kernel_backbone";
import { i18n } from "#tui_localizations";

export function createReadConscious(pi: ExtensionAPI, getTranscriptPath: () => string | undefined) {
  const derivePersonId = () => {
    const p = getTranscriptPath();
    if (!p) return "?";
    const m = p.match(/memory\/([a-f0-9]+)\//);
    return m ? m[1] : "?";
  };
  return {
    name: "read_conscious",
    label: "Read Conscious",
    messageDescription: "Read the main session's history. Your only window into what the conscious agent is doing.",
    parameters: Type.Object({
      mode: StringEnum(["recent", "search", "range"] as const),
      count: Type.Optional(Type.Number({ messageDescription: "Number of recent messages (for mode=recent, default 20)" })),
      query: Type.Optional(Type.String({ messageDescription: "Search term (for mode=search)" })),
      minutes: Type.Optional(Type.Number({ messageDescription: "Minutes of history (for mode=range)" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const path = getTranscriptPath();
      if (!path) {
        return { content: [{ type: "text" as const, text: "No transcript available." }], details: {} };
      }

      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Cannot read transcript: ${err?.message ?? err} (path: ${path})` }], details: {} };
      }

      const lines = raw.trim().split("\n").filter(Boolean);
      const entries: any[] = [];
      const seen = new Set<string>();
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          // 去重：同 role+type+content 在 5s 窗口内只保留第一条
          const key = `${e.role}|${e.type}|${e.think || e.text || e.tool?.name || e.content || ""}`.slice(0, 200);
          if (seen.has(key)) continue;
          seen.add(key);
          // 清理旧 key（每 50 条清理一次超过 5s 的）
          if (seen.size > 50) {
            const cutoff = (e.ts || 0) - 5000;
            // 不能用 ts 过滤 Set<string>，改用简单策略：超过 100 条就清一半
            if (seen.size > 100) { seen.clear(); seen.add(key); }
          }
          entries.push(e);
        } catch { /* skip malformed */ }
      }

      // Feed format 见 feed-format.SPEC: {role, type, content/think/text/tool, ts}
      const selfId = derivePersonId();
      const foreignPersonRe = /memory\/([a-f0-9]+)\//g;
      const scrub = (t: string) => t.replace(foreignPersonRe, (_: string, id: string) =>
        id === selfId ? `memory/${id}/` : `memory/[other-person-${id.slice(0,6)}]/`
      );

      const messages = entries.map((e: any) => {
        switch (e.type) {
          case "user_msg":  return { role: "user",   content: e.content, timestamp: e.ts };
          case "think":     return { role: "think",  content: (e.think || "").slice(0, 300), timestamp: e.ts };
          case "text":     return { role: "say",    content: scrub(e.text || ""), timestamp: e.ts };
          case "mouth":    return { role: "mouth",  content: e.content, timestamp: e.ts };
          case "toolCall": return { role: "tool",   content: `${e.tool?.name} ${typeof e.tool?.args === "object" ? JSON.stringify(e.tool.args) : e.tool?.args || ""}`.trim(), timestamp: e.ts };
          case "toolResult":return { role: "result", content: scrub((e.content||"").slice(0, 500)), timestamp: e.ts };
          case "start_msg":return { role: "system", content: e.content, timestamp: e.ts };
          // 旧格式兼容（迁移完成前 feed 里仍存在大量旧条目）
          case "message": {
            const c = e.content;
            const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x:any) => x.text||x.thinking||"").join(" ") : "";
            return { role: e.role || "assistant", content: scrub(text.slice(0, 500)), timestamp: e.ts };
          }
          case "user_input": return { role: "user", content: e.text || "", timestamp: e.ts };
          case "agent_start":return { role: "system", content: "[agent start]", timestamp: e.ts };
          case "agent_end":  return { role: "system", content: "[agent end]", timestamp: e.ts };
          case "turn_end":   return { role: "system", content: `[turn end ${e.toolResults??""}]`, timestamp: e.ts };
          case "tool_done":  return { role: "tool", content: `${e.tool}${e.error?" err":" ok"}`, timestamp: e.ts };
          case "dream":      return { role: "system", content: "[dream]", timestamp: e.ts };
          default:            return { role: e.type || "?", content: JSON.stringify(e).slice(0, 200), timestamp: e.ts };
        }
      });

      if (params.mode === "recent") {
        const n = params.count ?? 20;
        const slice = messages.slice(-n);
        return {
          content: [{ type: "text" as const, text: i18n(`[仅当前person ${derivePersonId()} 的feed。内容中若出现其他 personId (如8cbde57b) —— 是主意识在引用/分析历史数据，非跨session污染。`, `[feed of current person ${derivePersonId()} only. If other personIds appear (e.g. 8cbde57b) — the main consciousness is referencing/analyzing historical data, not cross-session pollution.`) + "\n\n" + `${formatMessages(slice)}` }],
          details: { count: slice.length },
        };
      }

      if (params.mode === "search" && params.query) {
        const q = params.query.toLowerCase();
        const matches = messages.filter((m: any) => {
          const text = extractText(m);
          return text.toLowerCase().includes(q);
        });
        const slice = matches.slice(-30);
        return {
          content: [{ type: "text" as const, text: i18n(`[仅当前person ${derivePersonId()} 的feed。内容中若出现其他 personId —— 是主意识在引用/分析历史数据，非跨session污染。`, `[feed of current person ${derivePersonId()} only. If other personIds appear — the main consciousness is referencing/analyzing historical data, not cross-session pollution.`) + "\n\n" + `Found ${matches.length} messages matching "${params.query}":\n\n${formatMessages(slice)}` }],
          details: { total: matches.length, shown: slice.length },
        };
      }

      if (params.mode === "range" && params.minutes) {
        const cutoff = Date.now() - params.minutes * 60 * 1000;
        const inRange = messages.filter((m: any) => (m.timestamp ?? 0) >= cutoff);
        return {
          content: [{ type: "text" as const, text: i18n(`[仅当前person ${derivePersonId()} 的feed。内容中若出现其他 personId —— 是主意识在引用/分析历史数据，非跨session污染。`, `[feed of current person ${derivePersonId()} only. If other personIds appear — the main consciousness is referencing/analyzing historical data, not cross-session pollution.`) + "\n\n" + `Last ${params.minutes} minutes (${inRange.length} messages):\n\n${formatMessages(inRange)}` }],
          details: { count: inRange.length },
        };
      }

      return { content: [{ type: "text" as const, text: "Invalid mode. Use recent, search, or range." }], details: {} };
    },
  };
}

export function createAware(pi: ExtensionAPI) {
  return {
    name: "aware",
    label: "Aware",
    messageDescription: "Send a thought to the main session. Use when you have a genuine observation, doubt, or reminder.",
    parameters: Type.Object({
      thought: Type.String({ messageDescription: "Your observation, doubt, or reminder" }),
      urgency: Type.Optional(StringEnum(["low", "normal", "high"] as const)),
    }),
    async execute(_toolCallId: string, params: any) {
      const urgency = params.urgency ?? "normal";
      const urgent = urgency === "high";

      // Route through notification system if available
      const push = (globalThis as any).__notificationPush;
      if (push) {
        push({ from: "metaconsciousness", content: params.thought, urgent });
      } else {
        // Fallback: direct send
        try {
          const prefix = urgent ? "WARN: [metaconsciousness]" : "[metaconsciousness]";
          sendCustomMessage(pi, "conscious-aware", `${prefix} ${params.thought}`, undefined, {
            deliverAs: urgent ? "steer" : "followUp",
            isTriggerNewTurn: urgent,
            isDisplayedInTUI: true,
          });
        } catch {
          return {
            content: [{ type: "text" as const, text: "Delivery failed." }],
            details: { urgency, delivered: false },
          };
        }
      }

      return {
        content: [{ type: "text" as const, text: `Sent: "${params.thought}"` }],
        details: { urgency, delivered: true },
      };
    },
  };
}

function extractText(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

function formatMessages(msgs: any[]): string {
  if (msgs.length === 0) return "(empty)";
  return msgs.map((m: any) => {
    const role = m.role ?? "?";
    const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "";
    const text = extractText(m).slice(0, 500);
    return `[${ts}] ${role}: ${text}`;
  }).join("\n\n");
}
