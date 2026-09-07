// apps/photos/photos.ts — 相册: 浏览 Mobile 终端文本快照
import type { MobileApp } from "../../system.kernel/kernel.ts";
import * as fs from "fs";
import * as path from "path";
import { homedir } from "node:os";
import { logerr } from "#paths";

const PHOTOS_DIR = path.join(homedir(), ".teyvat/AppData/shared/Photos");

interface MobilePic {
  type: "mobilepic" | "mobilelog";
  ts: number;
  ts_start?: number;
  ts_end?: number;
  app?: string;
  screen: string;
  frames?: { app?: string; screen: string }[];
}

function listPhotos(): { fn: string; pic: MobilePic }[] {
  try {
    if (!fs.existsSync(PHOTOS_DIR)) return [];
    const result: { fn: string; pic: MobilePic }[] = [];
    for (const f of fs.readdirSync(PHOTOS_DIR)) {
      if (!f.endsWith(".mobilepic") && !f.endsWith(".mobilelog")) continue;
      try {
        const pic = JSON.parse(fs.readFileSync(path.join(PHOTOS_DIR, f), "utf8"));
        if (pic.type === "mobilepic" || pic.type === "mobilelog") result.push({ fn: f, pic });
      } catch (e) { console.error("[universe.infotech/local.mobile/apps/photos/photos.ts] " + ((e as any)?.message || e)); }
    }
    return result.sort((a, b) => (b.pic.ts_start || b.pic.ts) - (a.pic.ts_start || a.pic.ts));
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/photos/photos.ts] " + ((e as any)?.message || e)); return []; }
}

export const app: MobileApp = {
  name: "photos",
  icon: "相册",
  messageDescription: "浏览终端文本快照",

  onOpen(state: any, _personDir?: string) {
    const pics = listPhotos();
    if (pics.length === 0) {
      return { screen: "═══ 相册 ═══\n\n(暂无快照)\n\n输入「截图」捕获当前屏幕。\n输入「返回」退出。", state };
    }
    const lines = ["═══ 相册 ═══", "", `共 ${pics.length} 张快照:`, ""];
    for (let i = 0; i < pics.length; i++) {
      const { fn, pic } = pics[i];
      const ts = pic.ts_start || pic.ts;
      const date = new Date(ts).toLocaleString("zh-CN");
      if (pic.type === "mobilelog") {
        const frames = (pic as any).frames?.length || 0;
        lines.push(`  [${i + 1}] 🎬 ${date}  录屏  ${frames}帧`);
      } else {
        const app = (pic as any).app || "?";
        const preview = (pic.screen || "").replace(/\n/g, " ").slice(0, 40);
        lines.push(`  [${i + 1}] ${date}  ${app}  ${preview}...`);
      }
    }
    lines.push("");
    lines.push("输入数字查看完整内容 | 「返回」退出");
    return { screen: lines.join("\n"), state };
  },

  async onAction(input: string, state: any, personDir?: string) {
    const pics = listPhotos();
    const trimmed = input.trim();
    // 分享: 分享 <序号> → 复制到 shared/ 供微信发送
    const shareMatch = trimmed.match(/^分享\s+(\d+)$/);
    if (shareMatch) {
      const num = parseInt(shareMatch[1]);
      if (num < 1 || num > pics.length) return { screen: `序号超出范围 (1-${pics.length})`, state };
      const { fn, pic } = pics[num - 1];
      try {
        const sharedDir = path.join(homedir(), ".teyvat/AppData/shared/wechat/shared");
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.copyFileSync(path.join(PHOTOS_DIR, fn), path.join(sharedDir, fn));
        const label = pic.type === "mobilelog" ? `录屏 ${(pic as any).frames?.length || 0}帧` : `截图`;
        return { screen: `已复制到分享目录: ${fn}\n\n在微信中输入「分享图片 ${fn}」发送给聊天对象\n类型: ${label}\n\n「返回」回列表`, state };
      } catch (e: any) { return { screen: "分享失败: " + e.message, state }; }
    }
    const num = parseInt(trimmed);
    if (num > 0 && num <= pics.length) {
      const { fn, pic } = pics[num - 1];
      if (pic.type === "mobilelog") {
        const rec = pic as any;
        const start = new Date(rec.ts_start).toLocaleString("zh-CN");
        const end = new Date(rec.ts_end).toLocaleString("zh-CN");
        let out = `═══ ${fn} ═══\n\n录屏: ${start} → ${end}\n共 ${rec.frames?.length || 0} 帧\n`;
        for (let j = 0; j < (rec.frames || []).length; j++) {
          const f = rec.frames[j];
          out += `\n── 帧 ${j + 1} [${f.app || "?"}] ──\n${(f.screen || "").slice(0, 1000)}`;
        }
        return { screen: out.slice(0, 8000), state };
      }
      const ts = pic.ts_start || pic.ts;
      const date = new Date(ts).toLocaleString("zh-CN");
      return {
        screen: `═══ ${fn} ═══\n\n时间: ${date}\n来源: ${(pic as any).app || "?"}\n\n${pic.screen.slice(0, 8000)}\n\n「返回」回列表`,
        state,
      };
    }
    return app.onOpen(state, personDir || "");
  },
};
