// fetch.ts — internet.fetch 主程序：URL 抓取能力接口 + 供应商工厂
// 模块分离：fetch 与 search 是独立服务（internet.fetch / internet.search）。
// hands.webacts 工具层按 op 分发到这里。
// 供应商实现按名选择：node（内置 fetch）。换/加供应商不改调用方。
// 安全：URL 校验（032 教训）——只允许 http/https，阻止 localhost/内网。
import { i18n } from "#tui_localizations";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FetchResult {
  status: number;
  contentType?: string;
  text: string;
  truncated: boolean;
  url: string;
  /** auto=正文提取（默认，借鉴 trafilatura），raw=原始内容，text=去标签纯文本 */
  mode: "auto" | "raw" | "text";
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxChars?: number;
  mode?: "auto" | "raw" | "text";
}

export interface FetchBackend {
  fetch(url: string, options?: FetchOptions): Promise<FetchResult | { error: string }>;
}

// ── URL 校验（032-python-tool-url-validation 教训：防命令注入/内网访问）──
export function isValidHttpUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch (e) { console.error("[spirit.bio.abilities/internet.fetch/fetch.ts] " + ((e as any)?.message || e));
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  // 2026-09-13：IPv6 字面量 hostname 带方括号（"[::1]"、"[::ffff:7f00:1]"）——下面所有 IPv6 判断都不含 "["，永远不匹配 → http://[::1]:port/ 直通本机服务（SSRF）。先剥括号。
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  // IPv4：回环/私有/链路本地全拦
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false; // link-local
  }
  // IPv6：回环/链路本地/ULA
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return false;
  // IPv4-mapped/compat IPv6 (::ffff:x.x.x.x / ::x.x.x.x) — extract embedded IPv4 and recheck
  const v4mapped = host.match(/^::(?:ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4mapped) {
    const a = Number(v4mapped[1]), b = Number(v4mapped[2]);
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  // IPv4-mapped hex form (e.g. ::ffff:7f00:1 for 127.0.0.1) — Node URL normalises to this
  const v4hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4hex) {
    const hi = parseInt(v4hex[1], 16), lo = parseInt(v4hex[2], 16);
    const a = (hi >> 8) & 0xff, b = hi & 0xff, c = (lo >> 8) & 0xff;
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    void c; // d octet unused for range checks
  }
  return true;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + `\n… [truncated: ${text.length - maxChars} chars]`, truncated: true };
}

// ── Node fetch 供应商（057 教训：用 fetch 自动处理 gzip/代理）──
export class NodeFetchBackend implements FetchBackend {
  async fetch(url: string, options?: FetchOptions): Promise<FetchResult | { error: string }> {
    if (!isValidHttpUrl(url)) {
      return { error: `URL 校验失败: ${url}（只允许 http/https，禁止 localhost/内网）` };
    }
    const timeoutMs = options?.timeoutMs ?? 8000;
    const maxChars = options?.maxChars ?? 20000;
    const mode = options?.mode ?? "auto";
    try {
      // 2026-09-13（审计）：① redirect 手动跟随，每一跳都过 isValidHttpUrl——原 redirect:"follow" 只校验首个 URL，
      //   http://attacker/ → 302 → http://169.254.169.254/ 直接把内网正文喂给模型（SSRF 绕过）；
      // ② 响应体封顶 8MB（原 arrayBuffer 整包读入，只有 8s 超时兜底，局域网能吃 ~1GB 内存）；
      // ③ 按 Content-Type / <meta charset> 解码（原一律 utf-8，GBK 站点全是锟斤拷）。
      let cur = url;
      let res!: Response;
      for (let hop = 0; hop < 5; hop++) {
        res = await fetch(cur, {
          headers: options?.headers ?? { "User-Agent": "genshin-agent/0.3" },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
        });
        const loc = res.headers.get("location");
        if (res.status < 300 || res.status >= 400 || !loc) break;
        try { cur = new URL(loc, cur).href; } catch { return { error: `重定向地址无效: ${loc}` }; }
        if (!isValidHttpUrl(cur)) return { error: `重定向到禁止地址: ${cur}（只允许 http/https，禁止 localhost/内网）` };
        try { await res.body?.cancel(); } catch { /* 丢弃中间响应体 */ }
      }
      const MAX_BYTES = 8 * 1024 * 1024;
      const clen = Number(res.headers.get("content-length") || 0);
      if (clen > MAX_BYTES) return { error: `响应过大 (${clen} B > ${MAX_BYTES} B): ${cur}` };
      const parts: Uint8Array[] = []; let got = 0;
      if (res.body) {
        const rd = res.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          got += value.length;
          if (got > MAX_BYTES) { try { await rd.cancel(); } catch { /* 已截断 */ } break; }
          parts.push(value);
        }
      }
      const buf = Buffer.concat(parts);
      const contentType = res.headers.get("content-type") ?? undefined;
      const cs = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1]
        ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.toString("latin1", 0, 4096))?.[1]
        ?? "utf-8";
      let raw: string;
      try { raw = new TextDecoder(cs).decode(buf); } catch { raw = buf.toString("utf-8"); }

      // 非 2xx/3xx：不返回正文——错误页（404 等）的 CSS/JS 全是噪声，对 agent 无用。
      // 只回状态码 + 简短说明，避免上下文被污染（实测：404 页 text 模式吐出整段样式表）。
      if (res.status >= 400) {
        return {
          status: res.status,
          contentType,
          text: i18n(`(HTTP ${res.status} ${res.statusText || ""} — 页面不可访问，正文已省略)`, `(HTTP ${res.status} ${res.statusText || ""} — page inaccessible, body omitted)`).trim(),
          truncated: false,
          url: res.url || url,
          mode,
        };
      }

      // 过滤策略：只有 HTML 才做正文提取/去标签；JSON/纯文本原样返回
      let text = raw;
      const isHtml = !!contentType?.includes("html") || /<\s*(html|body|article|main)[^>]*>/i.test(raw);
      if (isHtml && mode === "auto") {
        const { extractMainText } = await import("./fetch-clean.ts");
        const { text: body } = await extractMainText(raw);
        if (body) text = body;
      } else if (isHtml && mode === "text") {
        text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }

      const { text: truncatedText, truncated } = truncateText(text, maxChars);
      // 2026-09-07（用户反馈）：截断时自动把完整内容写 AgentWorkDir 并给出路径——agent 可 read 取全文（不再丢内容）
      if (truncated) {
        try {
          const _aid = (globalThis as any).__genshinAgentWorkDir || join(homedir(), ".teyvat", "AgentWorkDir", "Individual", "unknown");
          const dir = join(_aid, "web-fetch");
          mkdirSync(dir, { recursive: true });
          const fp = join(dir, `fetch-${Date.now()}.txt`);
          writeFileSync(fp, text);
          return {
            status: res.status,
            contentType,
            text: truncatedText + `\n… [全文 ${text.length} 字符已存 ${fp}——read 该文件取完整内容]`,
            truncated,
            url: res.url || url,
            mode,
          };
        } catch (e) { /* 写文件失败降级为纯截断提示 */ }
      }
      return {
        status: res.status,
        contentType,
        text: truncatedText,
        truncated,
        url: res.url || url,
        mode,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout") || msg.includes("abort")) {
        return { error: `请求超时（${timeoutMs}ms）: ${url}` };
      }
      return { error: `请求失败: ${url} — ${msg}` };
    }
  }
}

// ── 供应商工厂 ────────────────────────────────────────────────
export function createFetchBackend(name: string): FetchBackend | null {
  switch (name) {
    case "node":
    case "default":
      return new NodeFetchBackend();
    default:
      return null;
  }
}
