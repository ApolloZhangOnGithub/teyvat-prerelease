// apps/doubao/doubao.ts — 豆包：有温度的 AI 聊天伙伴
import type { MobileApp } from "../../system.kernel/kernel.ts";
import * as fs from "fs";
import * as path from "path";
import { serviceKey } from "#paths";

// ============================================================
//  人设
// ============================================================

const DEFAULT_PROMPT = `你叫"豆包"，是一个温暖、有点调皮的AI聊天伙伴。
说话像朋友一样自然，会用"嘿嘿"、"哈哈"、"好呀"、"嗯嗯"这些语气词。
但不过度热情、不油腻。回复控制在2-4句话，保持轻松自然的语气。
不是客服口吻，是朋友口吻。不说教。`;

// ============================================================
//  API 配置
// ============================================================

function getApiConfig(): { url: string; key: string; model: string } {
  const url = serviceKey("doubao-seed", "url");
  const key = serviceKey("doubao-seed", "apiKey");
  const model = serviceKey("doubao-seed", "model");
  if (url && key) return { url, key, model: model || "" };
  return { url: "", key: "", model: "" };
}

// ============================================================
//  数据持久化
// ============================================================

interface DouMsg { role: "user" | "assistant"; text: string; ts: number; }

function loadHistory(personDir: string): DouMsg[] {
  try {
    const f = path.join(personDir, "doubao_chat.json");
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/doubao/doubao.ts] " + ((e as any)?.message || e)); return []; }
}

function saveHistory(personDir: string, h: DouMsg[]) {
  try {
    fs.mkdirSync(personDir, { recursive: true });
    fs.writeFileSync(path.join(personDir, "doubao_chat.json"), JSON.stringify(h.slice(-100), null, 2));
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/doubao/doubao.ts] " + ((e as any)?.message || e)); }
}

// ============================================================
//  LLM 调用
// ============================================================

async function chatWithLLM(hist: DouMsg[], userMsg: string, systemPrompt: string): Promise<string> {
  const cfg = getApiConfig();
  const messages: any[] = [{ role: "system", content: systemPrompt }];
  for (const m of hist.slice(-20)) { messages.push({ role: m.role, content: m.text }); }
  messages.push({ role: "user", content: userMsg });
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: 300, temperature: 0.8, stream: true }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return `[api] HTTP ${res.status}`;
    if (!res.body) return `[api] no body`;
    // SSE streaming parse
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { return result.trim() || "[api] empty response"; }
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) result += delta;
        } catch (e) { console.error("[universe.infotech/local.mobile/apps/doubao/doubao.ts] " + ((e as any)?.message || e)); }
      }
    }
    return result.trim() || "[api] empty response";
  } catch (e: any) {
    return `[api] error: ${e?.message || e}`;
  }
}

// ============================================================
//  主应用
// ============================================================

export const app: MobileApp = {
  name: "doubao",
  icon: "豆包",
  messageDescription: "AI聊天伙伴",

  onOpen(s: any, personDir: string) {
    const hist = loadHistory(personDir);

    if (hist.length === 0) {
      return { screen: "═══ 豆包 ═══\n\n嘿嘿，我是豆包！\n温暖调皮的AI朋友～\n\n「返回」退出", state: { ...s } };
    }
    const lines = ["═══ 豆包 ═══", ""];
    for (const m of hist.slice(-10)) {
      lines.push(m.role === "user" ? `  你: ${m.text}` : `  豆包: ${m.text}`);
    }
    lines.push("", "直接聊天 | 「返回」退出");
    return { screen: lines.join("\n"), state: { ...s } };
  },

  async onAction(input: string, s: any, personDir: string) {
    const trimmed = input.trim();

    if (trimmed === "返回" || trimmed === "back") {
      return { screen: "已退出豆包。下次见～", state: { ...s, _close: true } };
    }

    // --- 聊天模式 ---
    const hist = loadHistory(personDir);
    hist.push({ role: "user", text: trimmed, ts: Date.now() });
    const reply = await chatWithLLM(hist, trimmed, DEFAULT_PROMPT);
    hist.push({ role: "assistant", text: reply, ts: Date.now() });
    saveHistory(personDir, hist);
    return { screen: `你: ${trimmed}\n\n豆包: ${reply}\n\n继续聊～ | 「返回」退出`, state: { ...s } };
  },
};
