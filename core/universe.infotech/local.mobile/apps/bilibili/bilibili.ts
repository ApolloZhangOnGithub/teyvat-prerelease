// apps/bilibili/bilibili.ts — B站视频能力（纯 TypeScript，零外部依赖）
// AI字幕提取 / 视频信息 / 搜索 — 全部通过 B站公开 API

// 字幕分页缓存：完整字幕存内存，agent 用 more 翻页
import * as fs from "node:fs";
import * as os from "node:os";
import { logerr } from "#paths";
function subsCache(): Record<string, { full: string; offset: number }> {
  const key = '_biliSubsCache';
  if (!(globalThis as any)[key]) (globalThis as any)[key] = {};
  return (globalThis as any)[key];
}
const PAGE_SIZE = 8000;

const BILI_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.bilibili.com/",
};

/** 首次访问 B站首页拿真实 buvid3 cookie，缓存复用 */
let _realCookie = "";
async function getBiliCookie(): Promise<string> {
  if (_realCookie) return _realCookie;
  try {
    const res = await fetch("https://www.bilibili.com/", {
      headers: BILI_HEADERS,
      signal: AbortSignal.timeout(10000),
      redirect: "manual",
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const cookies = setCookie.split(",").map(c => c.split(";")[0]!.trim()).join("; ");
      if (cookies.includes("buvid3")) _realCookie = cookies;
    }
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/bilibili/bilibili.ts] " + ((e as any)?.message || e)); }
  return _realCookie;
}

/** 统一 duration 格式化：number(秒) | string("mm:ss") → "mm:ss" */
function fmtDuration(d: any): string {
  if (typeof d === "number") {
    const m = Math.floor(d / 60), s = Math.floor(d % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  if (typeof d === "string") return d;
  return "?";
}

async function biliGet(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { ...BILI_HEADERS, Cookie: await getBiliCookie() },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!text.trim()) throw new Error(`HTTP ${res.status}: 空响应(疑似IP限流)`);
  try {
    const json = JSON.parse(text);
    if ('code' in json && json.code !== 0) throw new Error(`API code=${json.code}: ${json.message || '未知错误'}`);
    return json;
  } catch (e: any) {
    if (e.message?.startsWith?.('API code=')) throw e; // 已经是格式化的错误
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
}

async function getVideoInfo(bvid: string) {
  const viewRes = await biliGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (viewRes.code !== 0) throw new Error(`B站 view API 错误: ${viewRes.message}`);
  const data = viewRes.data;
  if (!data?.cid) throw new Error(`视频数据异常: 缺少 cid (bvid=${bvid})`);
  // Check for AI subtitles
  const subRes = await biliGet(`https://api.bilibili.com/x/v2/dm/view?type=1&oid=${data.cid}&pid=${data.aid}`);
  const subtitles = subRes?.data?.subtitle?.subtitles || [];
  return { ...data, subtitles, cid: data.cid, aid: data.aid };
}

async function fetchSubtitles(bvid: string): Promise<string> {
  const info = await getVideoInfo(bvid);
  if (!info.subtitles.length) return `视频 "${info.title}" 无 AI 字幕。可尝试 whisper 语音转录。`;

  const results: string[] = [`## ${info.title}\n时长: ${Math.floor(info.duration/60)}:${String(info.duration%60).padStart(2,'0')} | 播放: ${info.stat.view} | 弹幕: ${info.stat.danmaku}\n`];

  for (const sub of info.subtitles) {
    let url: string = sub.subtitle_url;
    if (url.startsWith("//")) url = "https:" + url;
    const subRes = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!subRes.ok) { results.push(`### ${sub.lan_doc} (HTTP ${subRes.status})`); results.push(""); continue; }
    const subJson = await subRes.json();
    const body = subJson.body || [];
    results.push(`### ${sub.lan_doc} (${body.length} 条)`);
    for (const t of body) {
      const ts = `${Math.floor(t.from/60)}:${String(Math.floor(t.from%60)).padStart(2,'0')}`;
      results.push(`[${ts}] ${t.content}`);
    }
    results.push("");
  }
  return results.join("\n");
}

const _pendingSearches = new Map<string, { promise: Promise<string>; ts: number; q: string }>();

function pendingSearchesList(): string {
  if (_pendingSearches.size === 0) return "没有进行中的搜索";
  const now = Date.now();
  const lines = [`${_pendingSearches.size} 个搜索进行中:`, ""];
  for (const [, v] of _pendingSearches) {
    const elapsed = Math.round((now - v.ts) / 1000);
    lines.push(`  @${elapsed}s — ${v.q.slice(0, 60)}`);
  }
  return lines.join("\n");
}

async function guardedSearch(kw: string): Promise<string> {
  try {
    const r = await bilibiliCmd({ action: "search", keyword: kw }, {}, "");
    return r.content[0].text;
  } catch (e: any) {
    return `搜索失败: ${e.message}`;
  }
}

// ── 浏览器搜索 fallback（绕过 API 412 风控）──
let _browserPort = 0;
function getBrowserPort(): number {
  if (_browserPort) return _browserPort;
  try { _browserPort = Number(fs.readFileSync(os.homedir()+"/.teyvat/browser-service.port","utf8").trim()) || 19222; } catch (e) { console.error("[universe.infotech/local.mobile/apps/bilibili/bilibili.ts] " + ((e as any)?.message || e)); _browserPort = 19222; }
  return _browserPort;
}
async function browserSearch(kw: string): Promise<string> {
  const port = getBrowserPort();
  const url = `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}`;
  await fetch(`http://127.0.0.1:${port}`, { method:"POST", body:JSON.stringify({action:"open",url,session:"bilisearch"}), signal:AbortSignal.timeout(15000) });
  await new Promise(r=>setTimeout(r,3000));
  await fetch(`http://127.0.0.1:${port}`, { method:"POST", body:JSON.stringify({action:"wait",text:"搜索",timeout:8000,session:"bilisearch"}), signal:AbortSignal.timeout(10000) });
  const tr = await fetch(`http://127.0.0.1:${port}`, { method:"POST", body:JSON.stringify({action:"text",limit:5000,session:"bilisearch"}), signal:AbortSignal.timeout(5000) });
  const tj: any = await tr.json();
  return `搜索: ${kw} (浏览器)\n\n${(tj.text||"").slice(0,3000)}`;
}

export async function bilibiliCmd(args: any, _ctx: any, _personDir: string): Promise<{ content: any[]; details: any }> {
  const a = args.action || "";

  if (a === "subs" || a === "fetch_subs") {
    const bvid = args.bvid;
    if (!bvid) return { content: [{ type: "text", text: "需要 bvid 参数（如 BV1Wzjg65EM6）" }], details: {} };
    try {
      const text = await fetchSubtitles(bvid);
      subsCache()[bvid] = { full: text, offset: PAGE_SIZE };
      const page = text.slice(0, PAGE_SIZE);
      const hasMore = text.length > PAGE_SIZE;
      const footer = hasMore ? `\n\n--- ${Math.ceil(text.length / PAGE_SIZE)} 页，输入「more」看下一页 ---` : "";
      return { content: [{ type: "text", text: page + footer }], details: { bvid } };
    } catch (e: any) {
      return { content: [{ type: "text", text: i18n(`字幕提取失败: ${e.message}`, `Subtitle extraction failed: ${e.message}`) }], details: {} };
    }
  }

  if (a === "more") {
    const bvid = args.bvid || Object.keys(subsCache()).pop();
    if (!bvid || !subsCache()[bvid]) return { content: [{ type: "text", text: "没有可翻页的字幕。先用 BV号 看字幕。" }], details: {} };
    const cache = subsCache()[bvid];
    const page = cache.full.slice(cache.offset, cache.offset + PAGE_SIZE);
    cache.offset += PAGE_SIZE;
    const hasMore = cache.offset < cache.full.length;
    const footer = hasMore ? `\n\n--- 输入「more」继续 | 输入「full」看全部 ---` : "\n\n--- 全部字幕结束 ---";
    return { content: [{ type: "text", text: page + footer }], details: { bvid } };
  }

  if (a === "full") {
    const bvid = args.bvid || Object.keys(subsCache()).pop();
    if (!bvid || !subsCache()[bvid]) return { content: [{ type: "text", text: "没有缓存的字幕。先用 BV号 看字幕。" }], details: {} };
    const cache = subsCache()[bvid];
    cache.offset = cache.full.length;
    return { content: [{ type: "text", text: cache.full }], details: { bvid } };
  }

  if (a === "info") {
    const bvid = args.bvid;
    if (!bvid) return { content: [{ type: "text", text: "需要 bvid 参数" }], details: {} };
    try {
      const info = await getVideoInfo(bvid);
      const subs = info.subtitles.map((s: any) => s.lan_doc).join(", ") || "无";
      const text = [
        `标题: ${info.title}`,
        `BV: ${bvid} | 时长: ${fmtDuration(info.duration)}`,
        `播放: ${info.stat.view} | 弹幕: ${info.stat.danmaku} | 评论: ${info.stat.reply}`,
        `UP: ${info.owner.name} | 粉丝: ${info.owner.follower || "?"}`,
        `AI字幕: ${subs}`,
        `简介: ${info.desc.slice(0, 300)}`,
      ].join("\n");
      return { content: [{ type: "text", text }], details: { bvid, cid: info.cid } };
    } catch (e: any) {
      return { content: [{ type: "text", text: i18n(`获取失败: ${e.message}`, `Fetch failed: ${e.message}`) }], details: {} };
    }
  }

  if (a === "search") {
    const kw = args.keyword || args.query;
    if (!kw) return { content: [{ type: "text", text: "需要 keyword 参数" }], details: {} };
    try {
      const searchRes = await biliGet(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}`
      );
      const videos = (searchRes?.data?.result || []).slice(0, 10);
      if (!videos.length) return { content: [{ type: "text", text: `"${kw}" 无结果。` }], details: {} };
      const text = videos.map((v: any, i: number) => {
        const title = (v.title || "").replace(/<em class="keyword">|<\/em>/g, "");
        const dur = fmtDuration(v.duration);
        return `${i+1}. ${title}\n   BV${v.bvid} | ${v.play || v.play_count || "?"} | ${dur}`;
      }).join("\n");
      return { content: [{ type: "text", text }], details: {} };
    } catch (e: any) {
      return { content: [{ type: "text", text: i18n(`搜索失败: ${e.message}`, `Search failed: ${e.message}`) }], details: {} };
    }
  }

  if (a === "popular") {
    try {
      const data = (await biliGet("https://api.bilibili.com/x/web-interface/popular?ps=10")).data;
      const text = (data?.list || []).map((v: any, i: number) => {
        const dur = fmtDuration(v.duration);
        return `${i+1}. ${v.title}\n   BV${v.bvid} | ${v.stat.view} | ${v.stat.danmaku} | ${dur}`;
      }).join("\n");
      return { content: [{ type: "text", text }], details: {} };
    } catch (e: any) {
      return { content: [{ type: "text", text: `获取失败: ${e.message}` }], details: {} };
    }
  }

  if (a === "whisper") {
    return { content: [{ type: "text", text: "Whisper 语音转录暂不可用——需安装 faster-whisper 模型。\n\n用 `subs` 先拿 AI 字幕，大部分 B站视频都有。" }], details: {} };
  }

  if (a === "hardsub") {
    return { content: [{ type: "text", text: "OCR 硬字幕提取暂不可用——需安装 pyobjc-framework-Vision + PaddleOCR。\n\n用 `subs` 先拿 AI 字幕。" }], details: {} };
  }

  return {
    content: [{
      type: "text",
      text: [
        "Bilibili — 视频能力",
        "  subs <bvid>         AI 字幕（弹幕 API，免登录）",
        "  info <bvid>         视频信息 + 字幕列表",
        "  search <keyword>    搜索视频",
        "  popular             热门榜 TOP10",
        "  whisper <bvid>      语音转文字（待装模型）",
        "  hardsub <bvid>      OCR 硬字幕（待装模型）",
      ].join("\n"),
    }],
    details: {},
  };
}

// ── MobileApp 包装 ──
import type { MobileApp } from "../../system.kernel/kernel.ts";
import { i18n } from "#tui_localizations";

export const app: MobileApp = {
  name: "bilibili",
  icon: "B站",
  messageDescription: "视频字幕/搜索/热门",
  onOpen(state: any) {
    const pending = _pendingSearches.size > 0 ? `\n  ${_pendingSearches.size}个搜索进行中 → 用「搜索 @」查看\n` : "";
    return { screen: [
      "B站",
      pending,
      "  BV1xxxxx        看这个视频的字幕",
      "  搜索 关键词      搜视频 | 搜索 @ 查进行中",
      "  热门            排行榜",
      "  下一页           字幕翻下一页",
      "  全文            字幕一次全部显示",
      "  返回            回主屏幕",
      "",
      "  在任何 app 里直接输入其他 app 名字可切换",
    ].join("\n"), state };
  },
  async onAction(input: string, state: any) {
    const cmd = input.trim();
    try {
      if (cmd === "热门" || cmd === "popular") {
        const r = await bilibiliCmd({ action: "popular" }, {}, "");
        return { screen: r.content[0].text, state };
      }
      if (cmd.startsWith("搜索 ") || cmd.startsWith("search ")) {
        const kw = cmd.replace(/^(搜索 |search )/, "");
        if (kw === "@" || kw === "搜索中") return { screen: pendingSearchesList(), state };
        const screen = await guardedSearch(kw);
        return { screen, state };
      }
      if (cmd === "more" || cmd === "继续") {
        const r = await bilibiliCmd({ action: "more" }, {}, "");
        return { screen: r.content[0].text, state };
      }
      if (cmd === "full" || cmd === "全部") {
        const r = await bilibiliCmd({ action: "full" }, {}, "");
        return { screen: r.content[0].text, state };
      }
      if (cmd === "@" || cmd === "搜索中") {
        return { screen: pendingSearchesList(), state };
      }
      if (cmd.match(/^BV/i)) {
        const r = await bilibiliCmd({ action: "subs", bvid: cmd }, {}, "");
        return { screen: r.content[0].text, state };
      }
      return { screen: "B站\n\n  无法识别输入。用法:\n  BV号 | 搜索 xxx | 热门 | more | full | 返回", state };
    } catch (e: any) {
      return { screen: `Error: ${e.message}`, state };
    }
  },
};
