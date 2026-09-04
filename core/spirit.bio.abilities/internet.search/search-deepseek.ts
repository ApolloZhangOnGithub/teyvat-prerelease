// search-deepseek.ts — internet.search 供应商实现：DeepSeek 官方
// 实现 SearchBackend 接口（search.ts）。深度研究：Responses API + 服务端 web_search 工具，
// 服务端自动搜索+开页+模型整合回答。优势：国内直连不被 GFW 阻断；代价：慢（10-30s）、耗 token。

import type { SearchBackend, SearchResult, SearchResultItem } from "./search.ts";
import { serviceKey } from "#paths";

export class DeepSeekSearchBackend implements SearchBackend {
  private apiKey: string;
  constructor() {
    this.apiKey = serviceKey("deepseek", "apiKey") || "";
  }

  // ISSUE 119（2026-08-18，qwen-3-8-27b-infer-test-01）：支持 timeoutMs（旧版硬编码 60s 且调用方传不进；webacts 层对 deepseek 强制最小 60s）
  async search(query: string, options?: { count?: number; timeoutMs?: number }): Promise<SearchResult | { error: string }> {
    if (!this.apiKey) {
      return { error: "DeepSeek API key 未配置（~/.teyvat/config/services.json 的 deepseek.apiKey）" };
    }
    const timeoutMs = options?.timeoutMs ?? 60000;
    try {
      const res = await fetch("https://api.deepseek.com/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          input: query,
          tools: [{ type: "web_search" }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { error: `DeepSeek API HTTP ${res.status}: ${res.statusText} ${body.slice(0, 300)}` };
      }
      const j = (await res.json()) as {
        output?: Array<{
          type?: string;
          content?: Array<{ type?: string; text?: string }>;
          action?: { type?: string; queries?: string[]; url?: string };
        }>;
      };
      const output = j.output ?? [];
      // 模型整合的回答（message 里的 output_text 拼接）
      const answer = output
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text" && c.text)
        .map((c) => c.text)
        .join("\n");
      // 轨迹链接（web_search_call 的 open_page）+ 回答里的 URL
      const visitedUrls = output
        .filter((o) => o.type === "web_search_call" && o.action?.type === "open_page" && o.action.url)
        .map((o) => o.action!.url!);
      const answerUrls = (answer.match(/https?:\/\/[^\s)】\]]+/g) ?? []).slice(0, 5);
      const urls = [...new Set([...visitedUrls, ...answerUrls])];
      const items: SearchResultItem[] = urls.map((url, i) => ({
        title: `参考 ${i + 1}`,
        url,
        description: "",
      }));
      return { query, items, answer: answer || undefined, provider: "deepseek" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout") || msg.includes("abort")) {
        return { error: `DeepSeek 搜索超时（${timeoutMs / 1000}s）: ${query}` };
      }
      return { error: `DeepSeek 搜索失败: ${query} — ${msg}` };
    }
  }
}
