// search-brave.ts — internet.search 供应商实现：Brave Search API
// 实现 SearchBackend 接口（search.ts）。轻量查询：快、免费、结构化结果列表。
// 057 教训：用 fetch 自动 gzip/代理；GFW 可能阻断（HTTP 000），失败时给出可诊断错误。

import type { SearchBackend, SearchResult, SearchResultItem } from "./search.ts";
import { serviceKey } from "#paths";

export class BraveSearchBackend implements SearchBackend {
  private apiKey: string;
  constructor() {
    this.apiKey = serviceKey("brave", "apiKey") || "";
  }

  // ISSUE 119（2026-08-18，qwen-3-8-27b-infer-test-01）：支持 timeoutMs（旧版硬编码 10s 且调用方传不进）
  async search(query: string, options?: { count?: number; timeoutMs?: number }): Promise<SearchResult | { error: string }> {
    if (!this.apiKey) {
      return { error: "Brave API key 未配置（~/.teyvat/config/services.json 的 brave.apiKey）" };
    }
    const count = options?.count ?? 8;
    const timeoutMs = options?.timeoutMs ?? 10000;
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      const res = await fetch(url, {
        headers: { "Accept": "application/json", "X-Subscription-Token": this.apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        return { error: `Brave API HTTP ${res.status}: ${res.statusText}` };
      }
      const j = (await res.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const items: SearchResultItem[] = (j.web?.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        description: r.description ?? "",
      }));
      return { query, items, provider: "brave" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout") || msg.includes("abort")) {
        return { error: `Brave 搜索超时（${timeoutMs / 1000}s）: ${query}（若为 GFW 阻断，需配置代理）` };
      }
      return { error: `Brave 搜索失败: ${query} — ${msg}` };
    }
  }
}
