// search.ts — internet.search 主程序：网络搜索能力接口 + 供应商工厂
// 模块分离：search 与 fetch 是独立服务（internet.search / internet.fetch）。
// 供应商按名选择（ts 模式，参考 voice.tts）：
//   search-brave.ts（Brave，轻量查询：快/免费/结构化）
//   search-deepseek.ts（DeepSeek 官方，深度研究：AI 搜索+整合回答）
// 换/加供应商不改调用方：新增供应商文件 + 工厂加分支。

import { BraveSearchBackend } from "./search-brave.ts";
import { DeepSeekSearchBackend } from "./search-deepseek.ts";

export interface SearchResultItem {
  title: string;
  url: string;
  description: string;
}

export interface SearchResult {
  query: string;
  items: SearchResultItem[];
  /** 模型整合的回答（DeepSeek web_search 供应商有；Brave 无） */
  answer?: string;
  provider: string;
}

export interface SearchBackend {
  /**
   * @param options.timeoutMs — ISSUE 119（2026-08-18，qwen-3-8-27b-infer-test-01）：请求超时，各供应商自带默认值（brave 10s / deepseek 60s）
   */
  search(query: string, options?: { count?: number; timeoutMs?: number }): Promise<SearchResult | { error: string }>;
}

// ── 供应商工厂 ────────────────────────────────────────────────
export function createSearchBackend(name: string): SearchBackend | null {
  switch (name) {
    case "brave":
      return new BraveSearchBackend();
    case "deepseek":
      return new DeepSeekSearchBackend();
    case "default":
      return new BraveSearchBackend();
    default:
      return null;
  }
}
