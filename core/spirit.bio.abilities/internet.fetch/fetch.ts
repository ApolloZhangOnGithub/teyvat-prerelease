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
  const host = u.hostname.toLowerCase();
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
      const res = await fetch(url, {
        headers: options?.headers ?? { "User-Agent": "genshin-agent/0.3" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const raw = buf.toString("utf-8");
      const contentType = res.headers.get("content-type") ?? undefined;

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
          const dir = join(homedir(), ".teyvat", "AgentWorkDir", "web-fetch");
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
