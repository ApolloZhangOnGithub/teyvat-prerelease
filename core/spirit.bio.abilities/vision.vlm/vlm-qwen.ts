// vlm-qwen.ts — vision.vlm 供应商实现：qwen VL
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 实现 VlmBackend 接口（vlm.ts）。原 head.eyes 内联 lookAtImage 抽象而来。

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { VlmBackend, VlmResult } from "./vlm.ts";

interface QwenConfig {
  apiKey: string;
  baseUrl: string;
}

function getQwenConfig(): QwenConfig | null {
  try {
    // 先读 UserAccount (config 命令写入)，再回退到 config
    for (const dir of ["UserAccount", "config"]) {
      const servicesPath = join(homedir(), `.teyvat/${dir}/services.json`);
      if (!existsSync(servicesPath)) continue;
      const services = JSON.parse(readFileSync(servicesPath, "utf8"));
      if (services.qwen?.apiKey && services.qwen?.baseUrl) {
        return { apiKey: services.qwen.apiKey, baseUrl: services.qwen.baseUrl };
      }
    }
  } catch (e) { console.error("[spirit.bio.abilities/vision.vlm/vlm-qwen.ts] " + ((e as any)?.message || e)); }
  return null;
}

export class QwenVlmBackend implements VlmBackend {
  async describeImage(
    imagePath: string,
    prompt: string,
    model: string,
  ): Promise<VlmResult | { error: string }> {
    const config = getQwenConfig();
    if (!config) return { error: "未配置 qwen API key。请在 ~/.teyvat/config/services.json 中添加 qwen.apiKey 和 qwen.baseUrl" };

    if (!existsSync(imagePath)) return { error: `文件不存在: ${imagePath}` };

    const ext = imagePath.split(".").pop()?.toLowerCase() || "png";
    const mime = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp" }[ext] || "png";
    const imgBuf = readFileSync(imagePath);
    const imgB64 = imgBuf.toString("base64");
    const dataUrl = `data:image/${mime};base64,${imgB64}`;

    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: prompt }
      ]}],
      max_tokens: 500,
    });

    try {
      const resp = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const data = await resp.json();
      if (data.error) return { error: `API 错误: ${data.error.message || JSON.stringify(data.error)}` };

      const content = data.choices?.[0]?.message?.content || "(无内容)";
      // 日志 → ~/.teyvat/LogData/<agentId>/eyes.log
      try {
        const logDir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, "eyes.log"), JSON.stringify({
          ts: new Date().toISOString(), path: imagePath, model, prompt: prompt.slice(0, 200),
          tokens: data.usage?.total_tokens, ok: true
        }) + "\n");
      } catch (e) { console.error("[spirit.bio.abilities/vision.vlm/vlm-qwen.ts] " + ((e as any)?.message || e)); }
      return { text: content, usage: data.usage };
    } catch (e: any) {
      // 日志 → ~/.teyvat/LogData/<agentId>/eyes.log
      try {
        const logDir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, "eyes.log"), JSON.stringify({
          ts: new Date().toISOString(), path: imagePath, model, prompt: prompt.slice(0, 200),
          error: e.message, ok: false
        }) + "\n");
      } catch (e) { console.error("[spirit.bio.abilities/vision.vlm/vlm-qwen.ts] " + ((e as any)?.message || e)); }
      return { error: `请求失败: ${e.message}` };
    }
  }
}
