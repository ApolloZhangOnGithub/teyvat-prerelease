// tts-bytedance.ts — voice.tts 供应商实现：豆包 TTS（vivi 2.0 voice）
// 文档: B.docs/Dev.Common/Wiki/Dependents(Bio Service Support).WIKI
// 实现 TtsBackend 接口（tts.ts）。原 head.mouth 内联 doTTSRequest 抽象而来。

import * as https from "node:https";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { serviceKey } from "#paths";
import type { TtsBackend } from "./tts.ts";

export class BytedanceTtsBackend implements TtsBackend {
  async synthesize(text: string): Promise<{ mp3: Buffer } | { error: string }> {
    const appId = serviceKey("doubao-voicengine", "appId") || "";
    const token = serviceKey("doubao-voicengine", "token") || "";
    if (!appId || !token) return { error: "缺少 doubao-voicengine 凭证（services.json）" };

    return new Promise((resolve) => {
      const body = JSON.stringify({
        app: { appid: appId, token, cluster: "volcano_tts" },
        user: { uid: "pi-mouth" },
        audio: { voice_type: "zh_female_vv_uranus_bigtts", encoding: "mp3", rate: 24000 },
        request: { reqid: `${Date.now()}`, text, text_type: "plain", operation: "query", cluster: "volcano_tts" },
      });
      const req = https.request({
        hostname: "openspeech.bytedance.com",
        path: "/api/v1/tts",
        method: "POST",
        headers: { Authorization: `Bearer;${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 15000,
      }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => data += chunk.toString());
        res.on("end", () => {
          try {
            const resp = JSON.parse(data);
            if (resp.code === 3000 && resp.data) {
              resolve({ mp3: Buffer.from(resp.data, "base64") });
            } else {
              const errMsg = `TTS error code=${resp.code} msg=${resp.message}`;
              try {
                const pid = (globalThis as any).__genshinPersonId || "unknown";
                const ed = `${homedir()}/.teyvat/ErrorData/${pid}`;
                mkdirSync(ed, { recursive: true });
                appendFileSync(`${ed}/mouth_err.log`, `${new Date().toISOString()} ${errMsg}\n`);
              } catch (e) { console.error("[spirit.bio.abilities/voice.tts/tts-bytedance.ts] " + ((e as any)?.message || e)); }
              resolve({ error: errMsg });
            }
          } catch (e) { console.error("[spirit.bio.abilities/voice.tts/tts-bytedance.ts] " + ((e as any)?.message || e)); resolve({ error: "TTS response parse error" }); }
        });
      });
      req.on("error", (err) => resolve({ error: `TTS request error: ${err.message}` }));
      req.on("timeout", () => { try { req.destroy(); } catch (e) { console.error("[spirit.bio.abilities/voice.tts/tts-bytedance.ts] " + ((e as any)?.message || e)); } resolve({ error: "TTS timeout" }); });
      req.write(body);
      req.end();
    });
  }
}
