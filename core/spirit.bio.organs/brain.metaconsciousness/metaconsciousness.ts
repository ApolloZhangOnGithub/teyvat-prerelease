// 文档: B.docs/Dev.Common/Wiki/Metaconscious(Bio Mechanism).WIKI
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { watch, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { appendAsync } from "#kernel_nerves";
import { i18n } from "#tui_localizations";
let _errorLogPath = join(homedir(), ".teyvat/LogData/unknown/error.log");
const _log = (code: string, e: unknown) => { try { const d = _errorLogPath.replace(/\/[^/]+$/, ""); if (!existsSync(d)) mkdirSync(d, { recursive: true }); appendFileSync(_errorLogPath, `[${new Date().toISOString()}] [metaconsciousness][${code}] ${e}\n`); } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); } };
function setErrorLog(personDir: string) { _errorLogPath = personDir.replace("/MemoryData/", "/ErrorData/") + "/error.log"; }
import { createmetaconsciousness, type metaconsciousnessHandle } from "./metaconsciousness-spawner.ts";
import { createReadConscious } from "./metaconsciousness-tools.ts";
import { GUTTER } from "#tui_blockrender"; // 统一块渲染引擎:内容列常量
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
import { personDir as getPersonDir, writeFileAtomic } from "#paths";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage, diamond } from "#tui_blockrender";

// 元意识开关：每人持久化(JSON 布尔，不删文件、避开删除禁令)。off=不再启动元意识；记忆不受影响。
function scFlag(personDir: string): string { return `${personDir}/metaconsciousness.json`; }
function scDisabled(personDir: string): boolean {
  try { return !!JSON.parse(readFileSync(scFlag(personDir), "utf8")).disabled; } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); return true; }
}
function setScDisabled(personDir: string, disabled: boolean): void {
  try { writeFileAtomic(scFlag(personDir), JSON.stringify({ disabled, ts: new Date().toISOString() })); } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); _log("setScDisabled", e); }
}

function ismetaconsciousnessSession(sessionFile: string | undefined): boolean {
  return !!sessionFile?.includes("metaconsciousnessSessions");
}

export default function (pi: ExtensionAPI) {
  let lastError = "";
  let sub: metaconsciousnessHandle | null = null;
  let feedFile = "";
  let awareFile = "";
  let awareWatcher: ReturnType<typeof setInterval> | null = null;
  let awareOffset = 0;
  let ismetaconsciousness = false;
  let curPersonDir: string | null = null;

  // ── aware renderer: header line + content below ───────────────────
  pi.registerMessageRenderer("conscious-aware", (message, _opts, theme) => {
    const { Container, Text, Markdown } = _require("@earendil-works/pi-tui");
    // content 可能是 string 或 [{type:"text",text:"..."}]
    let raw: string;
    const c = message.content;
    if (typeof c === "string") {
      raw = c;
    } else if (Array.isArray(c)) {
      raw = c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    } else {
      raw = String(c ?? "");
    }
    let title = "元意识";
    let body = raw;
    const wrapped = raw.match(/^---\[metaconsciousness(?:::([^\]]*))?\]---\r?\n?([\s\S]*?)\r?\n?---\[\/metaconsciousness\]---\s*$/);
    if (wrapped) {
      title = (wrapped[1] || "元意识").trim();
      body = wrapped[2].trim();
    } else {
      const m = raw.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
      if (m) { title = m[1]; body = m[2].trim() || raw; }
    }
    if (!body?.trim()) body = raw;
    // 去空行: 连续空行压缩为单个换行
    body = body.replace(/\n{3,}/g, "\n\n").trim();
    const head = theme.fg("accent", "◆") + " " + theme.bold("metaconsciousness")
      + (title && title !== "元意识" ? "  " + theme.fg("accent", title) : "");
    const cc = new Container();
    cc.addChild(new Text(head, 0, 0));
    cc.addChild(new Markdown(body, GUTTER, 0, getMarkdownTheme()));
    return cc;
  });

// ── feed writer — conscious-feed.jsonl 统一格式见 feed-format.SPEC ──
  // role: user|assistant|system  type: 见 SPEC
  const _lastFeedHash = new Map<string, number>();
  function feedEntry(entry: Record<string, any>) {
    if (!feedFile || ismetaconsciousness) return;
    // 去重：用除 ts 外的完整内容做 key，5 秒内不重复写入
    const { ts: _ts, ...content } = entry;
    const hash = JSON.stringify(content);
    const last = _lastFeedHash.get(hash);
    const now = Date.now();
    if (last && (now - last) < 5000) return;
    _lastFeedHash.set(hash, now);
    // 定期清理过期条目
    if (_lastFeedHash.size > 100) { for (const [k, t] of _lastFeedHash) { if (now - t > 5000) _lastFeedHash.delete(k); } }
    const json = JSON.stringify({ ...content, ts: now });
    try { appendAsync(feedFile, json + "\n"); } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); _log("feedEntry", e); }
  }

  pi.on("message_end", async (event) => {
    const msg = event.message as any;
    if (!msg) return;
    const ct = msg.messageType;
    // 系统包裹消息 → type=start_msg
    if (ct === "continuous-date") { feedEntry({ role: "system", type: "start_msg", content: msg.content }); return; }
    if (ct === "memory-snapshot" || ct === "memory-capacity" || ct === "sleep-done") return;  // 不写 feed
    if (ct) return;  // 其他 messageType 跳过

    // message_end: content 是数组 [{type:"thinking",thinking:"..."}, {type:"text",text:"..."}, ...]
    const parts = Array.isArray(msg.content) ? msg.content : [];
    for (const p of parts) {
      if (p.type === "thinking" && p.thinking) {
        feedEntry({ role: "assistant", type: "think", think: p.thinking });
      } else if (p.type === "text" && p.text?.trim()) {
        feedEntry({ role: "assistant", type: "text", text: p.text.trim() });
      } else if (p.type === "toolCall") {
        feedEntry({ role: "assistant", type: "toolCall", tool: { name: p.name, args: p.arguments } });
      }
    }
  });

  pi.on("tool_execution_end", async (event) => {
    feedEntry({ role: "system", type: "toolResult", content: (event as any).result?.content?.[0]?.text || "" });
  });

  pi.on("input", async (event) => {
    feedEntry({ role: "user", type: "user_msg", content: (event as any).text });
  });

  // ── lifecycle ────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();

    // 海马体 / 睡眠小号也加载了本扩展，但它们既不是主意识也不是元意识——什么都别做：
    // 不喂 feed、不 spawn 元意识、不监听 aware。否则它们会把自己的活动写进共享的 conscious-feed.jsonl，
    // 污染真元意识读的那份历史（feed 里混入海马体工具调用，正是之前的污染源之一）。
    if (sessionFile && (sessionFile.includes("HippocampusSessions") || sessionFile.includes("SleepSessions"))) {
      ismetaconsciousness = false;
      feedFile = "";
      return;
    }

    ismetaconsciousness = ismetaconsciousnessSession(sessionFile);

    if (ismetaconsciousness) {
      // ── I AM the metaconsciousness. Register read_conscious + aware, don't spawn. ──
      // globals 来自 kernel 注入（主进程），但元意识在独立 tmux 进程里没有这些 globals。
      // 回退读 spawner 传的环境变量。
      const personId = (global as any).__genshinPersonId || process.env.PAIMON_PERSON_ID || "unknown";
      const channelDir = (global as any).__genshinChannelDir || process.env.PAIMON_CHANNEL_DIR || "";
      const feedPath = channelDir + "/conscious-feed.jsonl";
      awareFile = channelDir + "/conscious-aware.jsonl";

      // read_conscious: read the main session's history
      const rc = createReadConscious(pi, () => feedPath);
      registerPaimonTool({
        name: rc.name,
        label: rc.label,
        messageDescription: rc.messageDescription,
        promptSnippet: "Read main session history (recent/search/range)",
        parameters: rc.parameters,
        renderCall(_args: any, theme: any) {
          return renderToolCall.label(theme, "Read Conscious", "reading main session...");
        },
        renderResult(result: any, _options: any, theme: any, ctx: any) {
          const content = resultContent(result);
          return renderMessage.summary(theme, ctx, content?.[0]?.text);
        },
        async execute(id: string, params: any) { return rc.execute(id, params); },
      });

      registerPaimonTool({
        name: "aware",
        label: "Aware",
        feedResult: false,
        messageDescription: "Send a structured event to the main consciousness. Each event has title, preview, strength, and can interrupt streaming.",
        promptSnippet: "Send a thought to the main session",
        renderCall(args: any, theme: any) {
          return renderToolCall.label(theme, "Aware", args?.title);
        },
        parameters: Type.Object({
          title: Type.String({ messageDescription: "Short event title (≤50 chars)" }),
          preview: Type.Optional(Type.String({ messageDescription: "One-line summary (≤100 chars, optional)" })),
          thought: Type.String({ messageDescription: "Full observation or reminder" }),
          strength: Type.Optional(Type.Number({ messageDescription: "0.0–1.0: low (0.1), normal (0.5), high (0.8), critical (1.0). High+ interrupts streaming.", minimum: 0, maximum: 1 })),
        }),
        renderResult() {
          return renderMessage.silent();
        },
        async execute(_id, params) {
          if (!params.thought?.trim()) {
            return { content: [{ type: "text", text: i18n("ERR: thought 不能为空。aware 格式: aware({title:'简短标题', thought:'你的完整观察和反思'})", "ERR: thought cannot be empty. aware format: aware({title:'short title', thought:'your full observation and reflection'})") }], details: {}, isError: true };
          }
          const event = {
            type: "metaconsciousness",
            title: params.title,
            preview: params.preview,
            thought: params.thought,
            strength: params.strength ?? 0.5,
            ts: Date.now(),
          };
          await appendFile(awareFile, JSON.stringify(event) + "\n");
          return { content: [{ type: "text", text: `Event sent: [${event.title}] (strength=${event.strength})` }], details: {} };
        },
      });

      // ── 限制元意识工具：read_conscious + aware + read（next 已并入 wait/hibernate，从白名单移除）──
      try {
        const allowed = new Set(["read_conscious", "aware", "read"]);
        const current = pi.getActiveTools();
        const filtered = current.filter(t => allowed.has(t));
        pi.setActiveTools(filtered);
      } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); _log("setActiveTools", e); }

      return;
    }

    // ── I am the MAIN session. Spawn metaconsciousness + watch aware. ──
    sub?.stop();
    if (awareWatcher) { clearInterval(awareWatcher); awareWatcher = null; }

    // 不依赖 global.__genshinPersonDir（handler 注册顺序不保证 kernel 先设置 globals）
    const personDir = getPersonDir(sessionFile);
    if (!personDir) { feedFile = ""; return; }
    curPersonDir = personDir;
    setErrorLog(personDir);
    const channelDir = personDir.replace("/MemoryData/", "/RuntimeCache/");
    const sessionDir = personDir.replace("/MemoryData/", "/SessionData/");
    const personId = personDir.split("/").pop() ?? "unknown";
    // 同步设置 globals（后续 spawner.ts 的 start() 会读这些全局变量）
    try {
      (global as any).__genshinPersonDir = personDir;
      (global as any).__genshinPersonId = personId;
      (global as any).__genshinChannelDir = channelDir;
      (global as any).__genshinSessionDir = sessionDir;
    } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); _log("setGlobals", e); }

    feedFile = channelDir + "/conscious-feed.jsonl";
    awareFile = channelDir + "/conscious-aware.jsonl";

    try { await appendFile(awareFile, "", { flag: "a" }); } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); _log("appendAware", e); }

    // Track current offset so we only inject NEW thoughts
    try { awareOffset = (await readFile(awareFile, "utf8")).length; } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); awareOffset = 0; }

    // Poll aware file → inject new thoughts into main session (fs.watch unreliable on macOS)
    const eventStore = `${personDir}/events.jsonl`;
    let awareProcessing = false;
    awareWatcher = setInterval(async () => {
      if (awareProcessing) return;
      awareProcessing = true;
      try {
        const content = await readFile(awareFile, "utf8");
        if (content.length <= awareOffset) return;
        const newPart = content.slice(awareOffset);
        // 只消费"完整行"(以 \n 结尾)；末尾写了一半的行留到下次事件，
        // 否则半截 JSON 会 parse 失败被跳过、offset 又推过去 → 那条 aware 彻底丢失。
        const lastNL = newPart.lastIndexOf("\n");
        if (lastNL < 0) return;
        const complete = newPart.slice(0, lastNL + 1);
        awareOffset += complete.length;

        for (const line of complete.split("\n").filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            // 兼容三种格式: {type:"metaconsciousness",thought:"..."} / {type:"aware",content:"..."} / 旧格式 {description:"..."}
            const title = entry.title || "元意识";
            const thought = entry.thought || entry.content || entry.description || "";
            if (!thought.trim()) continue; // 跳过空内容（旧格式 post_slice_reflection 等）
            const preview = entry.preview || thought.slice(0, 80);
            const strength = entry.strength ?? (entry.urgency === "high" ? 0.8 : entry.urgency === "low" ? 0.2 : 0.5);
            const interrupt = strength >= 0.8; // high+ strength interrupts streaming

            // Also write to event store for event list
            const ev = JSON.stringify({
              type: "aware", title, preview, strength,
              ts: new Date().toISOString()
            }) + "\n";
            try { appendAsync(eventStore, ev); } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); _log("eventStore", e); }
            // 送达策略：
            //   working  → 全送达，steer/followUp 按 strength 决定
            //   hibernated → 送达但不唤醒（isTriggerNewTurn=false），等用户消息时一并处理。
            //     否则 aware 唤醒 → agent 无事可做 → 立即 re-hibernate → 计时器归零 → "0s 卡死"循环
            //   resting  → followUp 排队，高 strength 打断
            const isHibernated = (globalThis as any).__genshinHeartState === "hibernated";
            sendCustomMessage(pi, "conscious-aware", `${title}：${thought}`, undefined, {
              deliverAs: interrupt && !isHibernated ? "steer" : "followUp",
              isTriggerNewTurn: !isHibernated,
              isDisplayedInTUI: true,
            });
          } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); _log("awareSend", e); }
        }
      } catch (e) { console.error("[spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts] " + ((e as any)?.message || e)); _log("awareWatcher", e); } finally { awareProcessing = false; }
    }, 1000);

    sub = createmetaconsciousness(
      pi,
      () => feedFile,
      (msg: string) => { lastError = msg; },
      () => {},
      personDir,
    );
    // 默认关闭：文件不存在时写入 disabled:true
    if (!existsSync(scFlag(personDir))) {
      setScDisabled(personDir, true);
    }
    if (scDisabled(personDir)) {
      // 元意识已禁用，静默
    } else {
      sub.start().catch((e: any) => { lastError = String(e?.message ?? e); });
      (globalThis as any).__genshinMetaconsciousnessHandle = sub;
    }
  });

  pi.on("session_shutdown", async () => {
    sub?.stop();
    if (awareWatcher) { clearInterval(awareWatcher); awareWatcher = null; }
  });

}
