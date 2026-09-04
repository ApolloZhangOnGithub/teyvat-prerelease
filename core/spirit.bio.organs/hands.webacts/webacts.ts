// webacts.ts — hands.webacts 工具层：web 工具（fetch / search）
// 调用服务层：internet.fetch（抓取，mode 过滤）+ internet.search（Brave 搜索）
// 非阻塞（LESSON 006）：阈值 Promise.race，慢的进后台 + 完成推送
//
// ISSUE 119（2026-08-18，qwen-3-8-27b-infer-test-01）修 4 项：
//   A. 双重调用：旧 raceFast(task) 内部调 task() 一次、后台 IIFE 又调一次 → 同一请求并发两次、首结果丢弃
//   B. 后台无兑底：await task() 无 try/catch → backend reject 时静默死掉（不推送不报错）
//   C. search 忽略 timeout 参数
//   D. 2s 阈值对 search 太低（brave GFW 下 2-10s、deepseek 10-60s）→ search 几乎必然进后台
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { outboxSend } from "../kernel.backbone/backbone.ts"; // 2026-08-20：outbox 已合并进 backbone.ts（不再单独文件）
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { i18n } from "#tui_localizations";
import { createFetchBackend } from "#internet_fetch";
import { createSearchBackend } from "#internet_search";

// LESSON 006：网络工具必须非阻塞——fetch 同步 await 会卡死 agent loop
const BG_THRESHOLD_MS = 2000;        // fetch 阈值（不变）
const SEARCH_THRESHOLD_MS = 8000;    // ISSUE 119：search 阈值 2s→8s（brave 常态 1-3s，内联返回）
const BG_HARD_TIMEOUT_MS = 90_000;   // ISSUE 119：后台推送硬超时——必有推送（成功/失败/超时三选一）

export default function (pi: ExtensionAPI) {
  const fetchBackend = createFetchBackend("node")!;
  const searchBackend = createSearchBackend("brave")!;
  const searchBackendDeepseek = createSearchBackend("deepseek")!;

  // ISSUE 119：调用方只建一次 promise（p），race 与后台共享同一请求，不再双发。
  // 旧版 raceFast(task) 内部调 task()，慢路径 IIFE 又调 task() → 同一请求并发两次、
  // 首个结果丢弃（brave 免费额度有限速，双发易撞 429，白烧配额）。
  // p reject 时转成 {error} 正常值走格式化——不在 race 里裸抛。
  function raceFast<T>(p: Promise<T>, thresholdMs: number): Promise<{ done: true; value: T } | { done: false }> {
    return Promise.race([
      p.then(
        (value) => ({ done: true as const, value }),
        (err: any) => ({ done: true as const, value: { error: err?.message ?? String(err) } as T }),
      ),
      new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), thresholdMs)),
    ]);
  }

  // ISSUE 119：后台推送兑底——绝不静默死掉：
  // - try/catch：旧版 backend reject 时 IIFE 静默死掉（不推送不报错，用户永远等不到）
  // - BG_HARD_TIMEOUT_MS 硬超时：backend 挂死（无内部超时）时出超时推送
  // 格式化复用 formatFetch/formatSearch（它们已处理 r.error 分支）
  function backgroundPush(p: Promise<any>, label: string, format: (r: any) => { content: any[]; details: any; isError: boolean }): void {
    (async () => {
      let r: any;
      try {
        r = await Promise.race([
          p,
          new Promise<any>((resolve) =>
            setTimeout(() => resolve({ error: `后台任务超时（${BG_HARD_TIMEOUT_MS / 1000}s）无服务端响应` }), BG_HARD_TIMEOUT_MS),
          ),
        ]);
      } catch (e: any) {
        r = { error: e?.message ?? String(e) };
      }
      const formatted = format(r);
      const text = formatted.content?.[0]?.text ?? "";
      // ISSUE 119 P1：走 outbox——先落盘再发；若落入 wait 窗口被 SDK 吞掉，
      // heart 唤醒时 outboxFlush 会 ack 检查后重发（at-least-once）
      try {
        outboxSend(pi, "continuous-cmd-done", i18n(`Web ${label} 完成:\n${text}`, `Web ${label} done:\n${text}`));
      } catch (e) { console.error("[spirit.bio.organs/hands.webacts/webacts.ts] " + ((e as any)?.message || e)); }
    })();
  }

  function formatFetch(r: any, label: string): { content: any[]; details: any; isError: boolean } {
    if (r?.error) {
      return { content: [{ type: "text", text: `Web ${label} 失败: ${r.error}` }], details: {}, isError: true };
    }
    const modeTag = r.mode && r.mode !== "auto" ? ` (mode:${r.mode})` : "";
    const head = `[HTTP ${r.status}] ${r.url}${modeTag}`;
    const body = r.text ? `\n${r.text}` : "";
    return { content: [{ type: "text", text: head + body }], details: { status: r.status, truncated: r.truncated, url: r.url }, isError: r.status >= 400 };
  }

  function formatSearch(r: any, label: string): { content: any[]; details: any; isError: boolean } {
    if (r?.error) {
      return { content: [{ type: "text", text: `Web ${label} 失败: ${r.error}` }], details: {}, isError: true };
    }
    const lines: string[] = [];
    // DeepSeek 供应商：模型整合的回答在前
    if (r?.answer) {
      lines.push(`[${r.provider || "deepseek"} 回答] ${r.answer}`);
    }
    if (r.items && r.items.length > 0) {
      lines.push(...r.items.map((it: any, i: number) => `${i + 1}. ${it.title}\n   ${it.url}${it.description ? "\n   " + it.description : ""}`));
    }
    if (lines.length === 0) {
      return { content: [{ type: "text", text: `Web ${label}: 无结果` }], details: { count: 0 }, isError: false };
    }
    return { content: [{ type: "text", text: `Web ${label}（${r.provider || "brave"}）:\n${lines.join("\n")}` }], details: { count: r.items?.length ?? 0, provider: r.provider }, isError: false };
  }

  registerPaimonTool({
    name: "web",
    label: "Web",
    messageDescription:
      "Web operations: fetch a URL or search the web. " +
      "fetch modes: auto=extract main text from HTML (default, navigation/ads filtered), raw=original content, text=strip tags only. " +
      "URL validation blocks localhost/internal networks. Slow requests run in background and push the result.",
    promptSnippet: "web - fetch URL (auto/raw/text) or web search",
    renderCall(args: any, theme: any) {
      const op = args?.op || "";
      const target = op === "search" ? args?.query : args?.url;
      // 标准调用行管线：意图 = op（fetch/search），载荷 = url/query（与 W 对齐）
      return renderToolCall.detail(theme, "Web", op, String(target ?? ""));
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const content = resultContent(result);
      return renderMessage.output(theme, ctx, content);
    },
    parameters: Type.Object({
      op: Type.String({ messageDescription: "'fetch'=get URL content, 'search'=web search" }),
      url: Type.Optional(Type.String({ messageDescription: "URL to fetch (op=fetch)" })),
      mode: Type.Optional(Type.String({ messageDescription: i18n("fetch 过滤模式: auto=正文提取(默认)/raw=原始/text=去标签", "fetch filter mode: auto=extract main text (default)/raw=original/text=strip tags") })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { messageDescription: "Extra HTTP headers (op=fetch)" })),
      query: Type.Optional(Type.String({ messageDescription: "Search query (op=search)" })),
      count: Type.Optional(Type.Number({ messageDescription: "Search result count (op=search, default 8)" })),
      provider: Type.Optional(Type.String({ messageDescription: i18n("search 供应商: brave=快/免费/结构化列表(默认), deepseek=服务端 AI 搜索+整合回答(慢/深度研究)", "search provider: brave=fast/free/structured list (default), deepseek=server-side AI search+integrated answer (slow/deep research)") })),
      timeout: Type.Optional(Type.Number({ messageDescription: "Timeout in seconds (default 8)" })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const op = params.op;
      const timeoutSec = params.timeout || 8;

      if (op === "fetch") {
        const url = params.url;
        if (!url) return { content: [{ type: "text", text: i18n("fetch 需要 url", "fetch requires url") }], details: {}, isError: true };
        const label = `fetch ${url}`;
        // ISSUE 119：单一 promise——race 与后台共享同一请求，不双发
        const p = fetchBackend.fetch(url, {
          mode: params.mode ?? "auto",
          headers: params.headers,
          timeoutMs: timeoutSec * 1000,
        });
        const fast = await raceFast(p, BG_THRESHOLD_MS);
        if (fast.done) return formatFetch(fast.value, label);
        // 慢：进后台，完成推送（LESSON 006 非阻塞；ISSUE 119 兑底：必有推送）
        backgroundPush(p, label, (r) => formatFetch(r, label));
        return { content: [{ type: "text", text: i18n(`Web ${label} 进行中…（完成后推送）`, `Web ${label} in progress… (result pushed when done)`) }], details: { background: true } };
      }

      if (op === "search") {
        const query = params.query;
        if (!query) return { content: [{ type: "text", text: i18n("search 需要 query", "search requires query") }], details: {}, isError: true };
        const label = `search ${query}`;
        const provider = params.provider ?? "brave";
        const backend = provider === "deepseek" ? searchBackendDeepseek : searchBackend;
        // ISSUE 119：search 传 timeout（旧版忽略）。deepseek 天生慢（10-60s），最小 60s 防误杀
        const timeoutMs = (provider === "deepseek" ? Math.max(params.timeout ?? 60, 60) : timeoutSec) * 1000;
        // ISSUE 119：单一 promise，不双发
        const p = backend!.search(query, { count: params.count ?? 8, timeoutMs });
        if (provider === "deepseek") {
          // ISSUE 119：deepseek 10-60s，race 必然超阈值且白卡 loop 8s——恒后台
          backgroundPush(p, label, (r) => formatSearch(r, label));
          return { content: [{ type: "text", text: i18n(`Web ${label} 进行中…（deepseek 深度搜索需 10-60s，完成后推送）`, `Web ${label} in progress… (deepseek takes 10-60s, result pushed when done)`) }], details: { background: true } };
        }
        const fast = await raceFast(p, SEARCH_THRESHOLD_MS);
        if (fast.done) return formatSearch(fast.value, label);
        backgroundPush(p, label, (r) => formatSearch(r, label));
        return { content: [{ type: "text", text: i18n(`Web ${label} 进行中…（完成后推送）`, `Web ${label} in progress… (result pushed when done)`) }], details: { background: true } };
      }

      return { content: [{ type: "text", text: i18n(`未知 op: ${op}。用 fetch / search。`, `Unknown op: ${op}. Use fetch / search.`) }], details: {}, isError: true };
    },
  });
}
