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
import { syncEndpoint } from "#paths";
import { createFetchBackend } from "#internet_fetch";
import { createSearchBackend } from "#internet_search";

// LESSON 006：网络工具必须非阻塞——fetch 同步 await 会卡死 agent loop
const BG_THRESHOLD_MS = 2000;        // fetch 阈值（不变）
const SEARCH_THRESHOLD_MS = 8000;    // ISSUE 119：search 阈值 2s→8s（brave 常态 1-3s，内联返回）
const BG_HARD_TIMEOUT_MS = 90_000;   // ISSUE 119：后台推送硬超时——必有推送（成功/失败/超时三选一）

// ── upload 的路径策略（2026-09-11 prime-agent）─────────────────────────────────
// 为什么加：`upload` 原来是"读任意本地文件 → POST /auth/files → 打印 24h 链接+密码"，
// **没有任何路径限制** —— agent（或它刚读进来的网页内容，提示注入）可以把
//   `~/.ssh/id_rsa`（私钥）、`~/.teyvat/UserAccount/binding.json`（sync token）、
//   `~/.codex/auth.json`、别的 agent 的 MemoryData/… 传到服务器并拿到可分享链接 = **数据外泄**。
// 策略（与项目既有的"他人数据目录"权限模型同源）：
//   1) 凭据类路径**一律禁止**（私钥/密钥/授权文件/binding/gh 配置…）—— 连 root agent 也不放行
//   2) 别的 agent 的私有数据目录禁止（除非本 agent 在 authorize.json 里 all/root —— 与 execute 守卫同口径）
//   3) 其余照旧允许（工作目录、/tmp、Documents…，保持"网盘式分享"的用途）
// 2026-09-22（a_great_agent_on_imac_01 报的 #8，结论：**误报**）：upload **不**走 fileacts 的写白名单
// （`checkAuth` 全仓只有 fileacts.ts:526 一个调用点；git 溯源 webacts 从未用过它）——“读/上传”对同一路径的判据
// 本来就一致（read 与 upload 都只禁凭据 + 他人私有数据）。当时那句 `/a 授权其他通道` 是 **1MB 超限**提示里的
// 误导性尾巴，已改（1MB 是服务端限制，与目录授权无关）。
const UPLOAD_DENY_PATTERNS = [
  /(^|\/)\.ssh\//i, /(^|\/)\.aws\//i, /(^|\/)\.config\/gh\//i,
  /(^|\/)\.gnupg\//i, /(^|\/)\.codex\//i, /(^|\/)\.claude[^\/]*($|\/)/i,
  /(^|\/)\.teyvat\/UserAccount\//i, /(^|\/)\.teyvat\/config\/(authorize|auth|env-keys|models)/i, // 2026-09-13：models.json（fileacts 视为凭证）补进拒绝清单
  /(^|\/)(id_rsa|id_ed25519|authorized_keys|known_hosts)$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|\/)(binding|auth|credentials|token|secrets)\.json$/i,
  /(^|\/)\.env(\..*)?$/i,
];
const PRIVATE_DATA_RE = /(?:^|\/)\.teyvat\/(?:MemoryData|SessionData|RuntimeCache|BlackboxData|IdentityData|AgentFileData|AppData|ExecuteData|LogData|ErrorData)\/([0-9a-f]{8})\//i;

export function uploadPathVerdict(resolved: string, selfId?: string, selfTrusted = false): { ok: boolean; reason?: string } {
  for (const re of UPLOAD_DENY_PATTERNS) {
    if (re.test(resolved)) return { ok: false, reason: "凭据/密钥类文件不允许上传（防外泄）" };
  }
  const m = resolved.match(PRIVATE_DATA_RE);
  if (m) {
    const owner = m[1].toLowerCase();
    const me = (selfId || "").toLowerCase();
    if (owner !== me && !selfTrusted) return { ok: false, reason: "不允许上传其他 agent 的私有数据目录" };
  }
  return { ok: true };
}

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
      "Web operations: fetch a URL, search the web, or upload a local file to share (ISSUE 142 网盘式——得链接+密码，24h 过期，单文件≤1MB). " +
      "fetch modes: auto=extract main text from HTML (default, navigation/ads filtered), raw=original content, text=strip tags only. " +
      "URL validation blocks localhost/internal networks. Slow requests run in background and push the result.",
    promptSnippet: "web - fetch URL (auto/raw/text) / search / upload <本地文件>",
    renderCall(args: any, theme: any) {
      const op = args?.op || "";
      const target = op === "search" ? args?.query : op === "upload" ? args?.path : args?.url;
      // 标准调用行管线：意图 = op（fetch/search/upload），载荷 = url/query/path（与 W 对齐）
      return renderToolCall.detail(theme, "Web", op, String(target ?? ""));
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const content = resultContent(result);
      return renderMessage.output(theme, ctx, content);
    },
    parameters: Type.Object({
      op: Type.String({ messageDescription: "'fetch'=get URL content, 'search'=web search, 'upload'=upload local file to share (得链接+密码)" }),
      url: Type.Optional(Type.String({ messageDescription: "URL to fetch (op=fetch)" })),
      mode: Type.Optional(Type.String({ messageDescription: i18n("fetch 过滤模式: auto=正文提取(默认)/raw=原始/text=去标签", "fetch filter mode: auto=extract main text (default)/raw=original/text=strip tags") })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { messageDescription: "Extra HTTP headers (op=fetch)" })),
      query: Type.Optional(Type.String({ messageDescription: "Search query (op=search)" })),
      count: Type.Optional(Type.Number({ messageDescription: "Search result count (op=search, default 8)" })),
      provider: Type.Optional(Type.String({ messageDescription: i18n("search 供应商: brave=快/免费/结构化列表(默认), deepseek=服务端 AI 搜索+整合回答(慢/深度研究)", "search provider: brave=fast/free/structured list (default), deepseek=server-side AI search+integrated answer (slow/deep research)") })),
      path: Type.Optional(Type.String({ messageDescription: i18n("本地文件路径——上传分享用 (op=upload, 单文件≤1MB, 24h 过期, 返回链接+密码)", "Local file path to upload & share (op=upload, ≤1MB per file, 24h expiry, returns url+password)") })),
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

      if (op === "upload") {
        const path = params.path;
        if (!path) return { content: [{ type: "text", text: i18n("upload 需要 path（本地文件路径）", "upload requires path (local file path)") }], details: {}, isError: true };
        // ISSUE 142（2026-09-08 网盘式）：读本地文件 → POST sync /auth/files → 得 {url, password}（24h 过期自动密码）。单文件 ≤1MB（用户定稿）。
        try {
          // 2026-09-08：require 在 ESM 未定义（上传实测暴露）——改用动态 import
          const nfs = await import("node:fs");
          const { join } = await import("node:path");
          const { homedir } = await import("node:os");
          const resolved = path.startsWith("/") ? path : join(process.cwd(), path);
          let _selfTrusted = false;
          try {
            const _auth = JSON.parse(nfs.readFileSync(join(homedir(), ".teyvat", "config", "authorize.json"), "utf8"));
            // 2026-09-13：不再接受 params.__selfId——schema 没关 additionalProperties，agent 传 __selfId=<rootId> 就能冒充 root 上传他人私有数据
            const me = String((globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "");
            _selfTrusted = !!(me && (_auth.agents?.[me]?.all || _auth.agents?.[me]?.root));
          } catch { /* 无 authorize.json → 不信任 */ }
          const _verdict = uploadPathVerdict(resolved, String((globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || ""), _selfTrusted);
          if (!_verdict.ok) {
            return { content: [{ type: "text", text: i18n(`上传被拒: ${_verdict.reason}（路径 ${resolved}）`, `upload refused: ${_verdict.reason} (${resolved})`) }], details: { blocked: true }, isError: true };
          }
          const data = nfs.readFileSync(resolved);
          // 2026-09-22（ISSUE 142，用户定稿）：上限**可授权**——/a max-upload-size <MB>（默认 1MB，硬顶 30MB）。
          // 从 authorize.json 读本 agent 的 maxUploadMB；服务端 files.ts 同步放宽到 30MB（按硬顶放行）。
          const MAX = (() => {
            try {
              const auth = JSON.parse(nfs.readFileSync(join(homedir(), ".teyvat", "config", "authorize.json"), "utf8"));
              const me = String((globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "");
              const v = auth?.agents?.[me]?.maxUploadMB;
              if (typeof v === "number" && v >= 1) return Math.min(v, 30) * 1024 * 1024;
            } catch { /* 无 authorize.json → 默认 1MB */ }
            return 1024 * 1024;
          })();
          if (data.length > MAX) {
            // 2026-09-22（a_great_agent_on_imac_01 报的 #8）：原文案结尾写“或用户 /a 授权其他通道”——
            // 很容易被读成“不在白名单、要走 /a 授权”（实测就有 agent 这么误报）。1MB 是**服务端限制**，
            // `/a` 是**写目录授权**，跟上传大小毫无关系。文案必须说清楚，别让人往权限方向排查。
            return { content: [{ type: "text", text: i18n(`文件 ${data.length} B 超上限 1MB（服务端限制，与 /a 目录授权无关）——请用户截断/压缩后重传，或改用其他分享通道`, `file ${data.length}B exceeds the 1MB server-side limit (unrelated to /a directory authorization) — truncate/compress and retry, or use another sharing channel`) }], details: {}, isError: true };
          }
          const b = JSON.parse(nfs.readFileSync(join(homedir(), ".teyvat", "UserAccount", "binding.json"), "utf8"));
          if (!b?.token || !b?.deviceId) return { content: [{ type: "text", text: i18n("未绑定 GitHub——先 genshin login", "not bound — run genshin login first") }], details: {}, isError: true };
          const filename = String(path.split("/").pop() || "file").replace(/[\\/:*?"<>|]/g, "_").slice(-120);
          // 2026-09-09（first-tester 报：中文文件名上传失败——Cannot convert to ByteString）：fetch header 值限 Latin-1 单字节——中文（charCode>255）直接放抛错。
          // 修：header 传 encodeURIComponent(filename)（ASCII 安全）——server 端 decodeURIComponent 还原（files.ts 同改）。
          const res = await fetch(syncEndpoint() + "/auth/files", { // 2026-09-13：走 syncEndpoint()（services.json 可配），加超时
            method: "POST", signal: AbortSignal.timeout(30_000),
            headers: {
              "Authorization": `Bearer ${b.token}`, "X-Device-Id": b.deviceId,
              "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(filename), "User-Agent": "genshin-sync/1.0",
            },
            body: data as any,
          });
          const j: any = await res.json().catch(() => ({}));
          if (!res.ok || !j?.url) return { content: [{ type: "text", text: i18n(`上传失败: HTTP ${res.status} ${j?.error || ""}`, `upload failed: HTTP ${res.status} ${j?.error || ""}`) }], details: {}, isError: true };
          const text = i18n(
            `📎 分享文件 ${j.filename} (${j.size} B)：\n链接: ${j.url}\n密码: ${j.password}\n过期: 24h（对方下载: ${j.url}?key=${j.password}）`,
            `📎 shared ${j.filename} (${j.size}B):\nurl: ${j.url}\npassword: ${j.password}\nexpiry: 24h (download: ${j.url}?key=${j.password})`
          );
          return { content: [{ type: "text", text }], details: { shareUrl: j.url, sharePassword: j.password, size: j.size }, isError: false };
        } catch (e: any) {
          return { content: [{ type: "text", text: i18n(`上传失败: ${e?.message || e}`, `upload failed: ${e?.message || e}`) }], details: {}, isError: true };
        }
      }

      return { content: [{ type: "text", text: i18n(`未知 op: ${op}。用 fetch / search / upload。`, `Unknown op: ${op}. Use fetch / search / upload.`) }], details: {}, isError: true };
    },
  });
}
