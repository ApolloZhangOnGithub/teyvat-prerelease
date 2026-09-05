// fetch-clean.ts — HTML 正文提取器
// 优先使用 trafilatura（Python 库，成熟正文提取），不可用/失败时 fallback 到内置启发式
// （噪声标签过滤 → 块级切分 → 文本密度/标点评分 → 链接密度惩罚）。
// fetch 的 mode:"auto"（默认）用它提取正文；mode:"raw"/"text" 不过滤。

import { spawn } from "node:child_process";

export interface ExtractResult {
  title?: string;
  text: string;
}

// ── 噪声标签：整块删除（script 内容、导航、页脚、广告等）──
const NOISE_TAGS = new Set([
  "script", "style", "nav", "footer", "header", "aside", "form", "iframe",
  "noscript", "svg", "canvas", "template", "select", "button", "input",
  "textarea", "dialog", "video", "audio", "figure",
]);

// 块级标签：正文候选块的分割点
const BLOCK_TAGS = new Set([
  "p", "li", "blockquote", "pre", "td", "h1", "h2", "h3", "h4", "h5", "h6",
  "div", "section", "article", "main", "tr",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** 从 HTML 中提取 <title> */
function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  return cleanText(m[1]);
}

/** 去标签 + 实体解码 + 压缩空白 */
function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** 统计一段文本的标点数（中文句号/逗号 + 西文句点/逗号） */
function punctuationCount(text: string): number {
  const m = text.match(/[。！？，；：、,.!?;:]/g);
  return m ? m.length : 0;
}

/** 块内链接占比（<a> 标签字符数 / 块总字符数）——链接密度高 = 导航/目录 */
function linkDensity(block: string): number {
  const total = block.length;
  if (total === 0) return 1;
  const links = block.match(/<a\b[\s\S]*?<\/a>/gi) ?? [];
  const linkChars = links.reduce((s, a) => s + a.length, 0);
  return linkChars / total;
}

/**
 * 提取主正文（async）。
 * 优先 trafilatura（Python 库，质量更高）；不可用/失败/结果为空 → fallback 内置启发式。
 */
export async function extractMainText(html: string): Promise<ExtractResult> {
  try {
    const trafText = await extractWithTrafilatura(html);
    if (trafText) return { title: extractTitle(html), text: trafText };
  } catch {
    // trafilatura 不可用/超时 → fallback
  }
  return extractMainTextFallback(html);
}

/** 用 trafilatura（Python）提取正文；不可用/超时/空结果返回 null */
function extractWithTrafilatura(html: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    let py: ReturnType<typeof spawn>;
    try {
      py = spawn("python3", ["-c", "import sys,trafilatura;r=trafilatura.extract(sys.stdin.read(),include_comments=False);print(r or '')"]);
    } catch {
      resolve(null);
      return;
    }
    // EPIPE 防线（2026-09-05，cross-device-communication-testor-01 定位 web fetch 闪退根因）：
    // 本机无 trafilatura 时 python3 秒退（import 失败 exit 1），随后向已关闭的 stdin 管道
    // 写入 html → 异步 write EPIPE。若 stdin 无 'error' 监听，stream 错误会抛成
    // uncaughtException → SDK uncaughtCrash → process.exit(1) → 进程闪退（web fetch 必现）。
    // 全管道挂 error 吞 EPIPE——让 close 分支正常走 finish(null) → fallback 内置提取。
    for (const s of [py.stdin, py.stdout, py.stderr]) {
      s?.on("error", () => { /* 吞：管道对端已关，静默走 close 兜底即可 */ });
    }
    let out = "";
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { py.kill(); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    py.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    py.on("error", () => finish(null));
    py.on("close", () => {
      const text = out.trim();
      finish(text.length > 0 ? text : null);
    });
    try {
      py.stdin!.write(html);
      py.stdin!.end();
    } catch {
      finish(null);
    }
  });
}

/** 内置启发式提取（fallback）——trafilatura 不可用时的保底 */
export function extractMainTextFallback(html: string): ExtractResult {
  const title = extractTitle(html);

  // 1. 删除噪声标签整块（栈匹配，处理嵌套）
  let cleaned = html;
  const noiseRe = new RegExp(`<(${[...NOISE_TAGS].join("|")})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, "gi");
  for (let i = 0; i < 10; i++) {
    const next = cleaned.replace(noiseRe, " ");
    if (next === cleaned) break;
    cleaned = next;
  }
  // 兜底：未闭合的噪声标签开标签也去掉
  cleaned = cleaned.replace(/<(script|style|nav|footer|header|aside|form)\b[^>]*>[\s\S]*$/gi, " ");

  // 2. 块级切分（保留块标签，逐块取文本）
  const blockRe = /<(p|li|blockquote|pre|td|h[1-6]|div|section|article|main|tr)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const blocks: { text: string; heading: boolean; score: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(cleaned)) !== null) {
    const tag = m[1].toLowerCase();
    const inner = m[2];
    const linkDens = linkDensity(inner);
    const text = cleanText(inner);
    if (!text) continue;
    const len = text.length;
    const punct = punctuationCount(text);
    // 评分：长度 × (1 + 标点密度) − 链接密度惩罚
    const score = len * (1 + punct / Math.max(len, 1) * 10) * (1 - linkDens * 0.8);
    blocks.push({ text, heading: HEADING_TAGS.has(tag), score });
  }

  // 3. 高分块判定（正文块 vs 导航/碎块）
  const MIN_SCORE = 40;
  const scored = blocks.filter((b) => b.score >= MIN_SCORE);

  // 4. 拼接：取评分最高的连续区段（贪心：从最高分块向两边扩展连续的高分块）
  let body: string;
  if (scored.length === 0) {
    // 提取失败：fallback 全部块文本（去重）
    body = dedupe(blocks.map((b) => b.text)).join("\n");
  } else {
    // 标记原始位置
    const flagged = blocks.map((b) => ({ ...b, good: b.score >= MIN_SCORE }));
    const goodIdx = flagged.map((b, i) => (b.good ? i : -1)).filter((i) => i >= 0);
    // 从最高分块开始，找包含它的最长连续 good 段
    const bestStart = flagged.findIndex((b) => b.good);
    let start = bestStart;
    let end = bestStart;
    for (let i = bestStart; i < flagged.length; i++) {
      if (flagged[i].good) end = i;
      else break;
    }
    // 标题块（h1-h6）总是保留在最前
    const headings = blocks.filter((b) => b.heading).map((b) => b.text);
    const bodyBlocks = flagged.slice(start, end + 1).filter((b) => b.good).map((b) => b.text);
    const parts = [...new Set([...headings, ...bodyBlocks])];
    body = parts.join("\n");
  }

  // 5. 结果过短（<80 字符）→ 可能没提取到正文，fallback 全文本
  if (body.length < 80) {
    body = cleanText(cleaned);
  }

  return { title, text: body };
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}
