// safari.ts — Safari (多标签页)
import type { MobileApp } from "../../system.kernel/kernel.ts";
import * as fs from "fs";
import * as path from "path";
import { debug } from '#gene_riboswitch';
import { homedir } from "os";
import * as https from "node:https";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { logerr } from "#paths";
const safariLog = (msg: string) => { debug.log('D0200', msg); };

let _proxyAgent: any;
function getProxyAgent(): any {
  if (_proxyAgent !== undefined) return _proxyAgent;
  let proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!proxyUrl && process.platform === "darwin") {
    try {
      const out = execSync("scutil --proxy", { timeout: 2000 }).toString();
      const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (host && port && /HTTPSEnable\s*:\s*1/.test(out)) proxyUrl = `http://${host}:${port}`;
    } catch (e) { console.error("[universe.infotech/local.mobile/apps/safari/safari.ts] " + ((e as any)?.message || e)); }
  }
  if (proxyUrl) {
    try {
      const runtimeRequire = createRequire(path.join(homedir(), ".local/lib/teyvat/runtime/package.json"));
      const { HttpsProxyAgent } = runtimeRequire("https-proxy-agent");
      _proxyAgent = new HttpsProxyAgent(proxyUrl);
      return _proxyAgent;
    } catch (e: any) { safariLog("proxy agent load failed: " + e.message); }
  }
  _proxyAgent = null;
  return null;
}

function getBrowserUrl(): string {
  if (process.env.PI_BROWSER) return process.env.PI_BROWSER;
  try { const port = fs.readFileSync(`${homedir()}/.teyvat/browser-service.port`, "utf8").trim(); if (port) return `http://127.0.0.1:${port}`; } catch (e: any) { safariLog("getBrowserUrl failed: " + e.message); }
  return "http://127.0.0.1:19222";
}

interface Tab { url: string; title: string; pageText: string; pageLinks: string[]; history: string[]; histIdx: number; currentUrl?: string; }
function newTab(): Tab { return { url: "", title: "", pageText: "", pageLinks: [], history: [], histIdx: -1 }; }
function tab(s: any): Tab {
  if (!s._tabs) { s._tabs = [newTab()]; s._activeTab = 0; }
  return s._tabs[s._activeTab];
}

function loadJson(p: string): any[] { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { console.error("[universe.infotech/local.mobile/apps/safari/safari.ts] " + ((e as any)?.message || e)); return []; } }
function saveJson(p: string, data: any[]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

function recordHistory(personDir: string, entry: string) {
  if (!personDir) return;
  try {
    const histFile = path.join(personDir, "safari_history.json");
    const hist = loadJson(histFile);
    hist.push({ url: entry, ts: new Date().toISOString() });
    saveJson(histFile, hist.slice(-500));
  } catch (e: any) { safariLog("recordHistory failed: " + e.message); }
}

let _svcStarting = false;
let _svcError = "";

function findChromium(): string | null {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"];
  for (const bin of candidates) {
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch (e) { console.error("[universe.infotech/local.mobile/apps/safari/safari.ts] " + ((e as any)?.message || e)); }
  }
  return null;
}

async function ensureSvc(): Promise<boolean> {
  _svcError = "";
  try { const r = await fetch(getBrowserUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ping" }), signal: AbortSignal.timeout(500) }); return r.ok; } catch (e: any) { safariLog("ensureSvc ping failed: " + e.message); }
  if (_svcStarting) return false;
  _svcStarting = true;
  try {
    const chromium = findChromium();
    if (!chromium) {
      const hint = process.platform === "darwin"
        ? "请安装 Google Chrome 到 /Applications，或设置 CHROMIUM_PATH 环境变量"
        : "请安装 Chrome/Chromium (apt install chromium-browser 或 dnf install chromium)，或设置 CHROMIUM_PATH 环境变量";
      _svcError = `未找到 Chrome/Chromium。${hint}`;
      safariLog(_svcError);
      return false;
    }
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const svc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../universe.infotech/cloud.servers/browser_service.cjs");
    const env: Record<string, string> = { ...process.env as Record<string, string>, PORT: "0", CHROMIUM_PATH: chromium };
    env.BROWSER_PORT = env.BROWSER_PORT || "0";
    const child = spawn("node", [svc], { stdio: "ignore", detached: true, env });
    child.unref();
    for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 500)); try { const url = getBrowserUrl(); const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ping" }), signal: AbortSignal.timeout(500) }); if (r.ok) return true; } catch (e: any) { if (i === 9) safariLog("ensureSvc failed after 10 retries: " + e.message); } }
    _svcError = "browser-service 启动超时（10 次重试均失败）";
  } catch (e: any) { _svcError = `browser-service 启动失败: ${e.message}`; safariLog("ensureSvc spawn failed: " + e.message); } finally { _svcStarting = false; }
  return false;
}

async function bc(action: string, params: Record<string, any> = {}, session = "safari"): Promise<any> {
  const url = getBrowserUrl();
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, session, ...params }), signal: AbortSignal.timeout(30000) });
    return await res.json();
  } catch {
    if (await ensureSvc()) {
      try {
        const newUrl = getBrowserUrl();
        const res = await fetch(newUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, session, ...params }), signal: AbortSignal.timeout(30000) });
        return await res.json();
      } catch (e: any) { return { error: `browser: ${e.message}` }; }
    }
    return { error: _svcError || "browser-service 启动失败" };
  }
}

function displayUrl(url: string): string {
  try { return decodeURIComponent(url); } catch (e) { console.error("[universe.infotech/local.mobile/apps/safari/safari.ts] " + ((e as any)?.message || e)); return url; }
}

function htmlToText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s{2,}/g, " ").trim();
}

async function fetchUrl(url: string, limit = 30000): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }, signal: AbortSignal.timeout(limit) });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return JSON.stringify(await res.json(), null, 2).slice(0, limit);
  const raw = await res.text();
  const text = htmlToText(raw);
  return text.length > 50 ? text.slice(0, limit) : raw.slice(0, limit);
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

async function searchWeb(q: string): Promise<string> {
  const cacheKey = q.trim().toLowerCase();
  if (_pendingSearches.has(cacheKey)) {
    return `[搜索中…] ${q}`;
  }
  const { serviceKey } = await import("#paths");
  const key = serviceKey("brave");
  if (!key) { return "搜索失败: brave 未配置，使用 /config 编辑"; }
  let resolveSearch!: (s: string) => void;
  const promise = new Promise<string>(r => { resolveSearch = r; });
  _pendingSearches.set(cacheKey, { promise, ts: Date.now(), q });
  (async () => {
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const opts: https.RequestOptions = {
        hostname: "api.search.brave.com", port: 443,
        path: `/res/v1/llm/context?q=${encodeURIComponent(q)}&count=10&maximum_number_of_tokens=4096`,
        method: "GET",
        headers: { "Accept": "application/json", "X-Subscription-Token": key },
        signal: AbortSignal.timeout(8000),
      };
      const proxy = getProxyAgent();
      if (proxy) opts.agent = proxy;
      const req = https.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      });
      req.on("error", (e: Error) => reject(e));
      req.end();
    });
    const j = JSON.parse(text) as any;
    const sources: Record<string, { title: string; snippet: string; age?: string[] }> = j.sources || {};
    const entries = Object.entries(sources);
    _pendingSearches.delete(cacheKey);
    if (entries.length) return "搜索: " + q + "\n\n" + entries.map(([url, info]: [string, any], n: number) => `[${n+1}] ${info.title || url}\n    ${info.snippet || ""}\n    ${info.age ? "📅 " + info.age.join(", ") + "\n    " : ""}→ ${displayUrl(url)}`).join("\n\n");
    return "搜索: " + q + "\n\n  无结果";
  } catch (e: any) { _pendingSearches.delete(cacheKey); safariLog("brave search failed: " + e.message); return "搜索失败: " + e.message; }
  })();
  _pendingSearches.set(cacheKey, { promise, ts: Date.now(), q });
  return promise;
}

export const app: MobileApp = {
  name: "safari",
  icon: "浏览器",
  messageDescription: "打开网页、搜索、读取内容",
  quickActions: [
    { action: "搜索", description: "网页搜索" },
    { action: "打开", description: "打开网址" },
  ],
  onOpen(s: any) {
    if (!s._tabs) { s._tabs = [newTab()]; s._activeTab = 0; }
    const n = (s._activeTab || 0) + 1;
    const total = s._tabs.length;
    return { screen: `Safari [标签 ${n}/${total}]\n${_pendingSearches.size > 0 ? `@${_pendingSearches.size}个搜索进行中\n` : ""}\n  URL | 搜索 xxx  | 点击 xxx | @ | 新标签 | 标签 <N> | 关闭标签 | 标签列表 | 返回`, state: s };
  },
  async onAction(input: string, s: any, personDir: string) {
    let cmd = input.trim();
    try {
      if (/^(新标签|new tab)$/i.test(cmd)) {
        if (!s._tabs) { s._tabs = [newTab()]; s._activeTab = 0; }
        s._tabs.push(newTab());
        s._activeTab = s._tabs.length - 1;
        return { screen: `新标签 ${s._activeTab + 1}/${s._tabs.length}\n\nURL | 搜索 xxx  | 点击 xxx`, state: s };
      }
      if (/^(关闭标签|close tab)$/i.test(cmd)) {
        if (!s._tabs || s._tabs.length <= 1) return { screen: "无法关闭最后一个标签", state: s };
        s._tabs.splice(s._activeTab || 0, 1);
        if ((s._activeTab || 0) >= s._tabs.length) s._activeTab = s._tabs.length - 1;
        return { screen: `标签已关闭。当前: 标签 ${(s._activeTab || 0) + 1}/${s._tabs.length}`, state: s };
      }
      const tabMatch = cmd.match(/^(标签|tab)\s+(\d+)$/i);
      if (tabMatch) {
        if (!s._tabs) { s._tabs = [newTab()]; s._activeTab = 0; }
        const n = parseInt(tabMatch[2]);
        if (n < 1 || n > s._tabs.length) return { screen: `标签序号 1-${s._tabs.length}`, state: s };
        s._activeTab = n - 1;
        const t = tab(s);
        return { screen: `切换到标签 ${n}/${s._tabs.length}\n${t.url ? `URL: ${displayUrl(t.url)}\n` : ""}${t.pageText.slice(0, 3000) || "(空白标签)"}`, state: s };
      }
      if (/^(标签|tab)\s+/i.test(cmd)) return { screen: "用法: 标签 <序号>  如「标签 2」", state: s };
      if (/^(标签列表|tabs)$/i.test(cmd)) {
        if (!s._tabs) { s._tabs = [newTab()]; s._activeTab = 0; }
        const lines = [`═══ ${s._tabs.length} 个标签 ═══`, ""];
        for (let i = 0; i < s._tabs.length; i++) {
          const tb = s._tabs[i];
          const mark = i === (s._activeTab || 0) ? " ◀ 当前" : "";
          lines.push(`  [${i + 1}] ${tb.title || tb.url || "(空白)"}${mark}`);
        }
        return { screen: lines.join("\n"), state: s };
      }
      if (cmd.startsWith("点击 ") || cmd.startsWith("click ")) {
        let selector = cmd.replace(/^(点击 |click )/, "").trim();
        if (!selector) return { screen: "用法: 点击 \"按钮文字\"  或  点击 CSS选择器", state: s };
        if ((selector.startsWith('"') && selector.endsWith('"')) || (selector.startsWith("'") && selector.endsWith("'"))) selector = selector.slice(1, -1);
        const t = tab(s);
        const isText = !/[.#\[\]>:+,~]/.test(selector);
        if (isText) {
          const linksR = await bc("links", { limit: 100 });
          const links = (linksR?.text || "").split("\n").filter(Boolean);
          const found = links.find((l: string) => l.includes(selector));
          if (found) {
            const url = found.split(" → ").pop()?.trim();
            if (url && url.startsWith("http")) {
              const openR = await bc("open", { url, timeout: 15000 });
              if (!openR.error) { t.currentUrl = url; await new Promise(r => setTimeout(r, 2000)); const [tr] = await Promise.all([bc("text", { limit: 10000 })]); t.pageText = tr?.text || ""; return { screen: `已点击: ${selector}\n→ ${url}\n\n${t.pageText.slice(0, 5000)}`, state: s }; }
            }
          }
          const r = await bc("click", { selector: `text=${selector}` });
          if (!r.error) { await new Promise(r => setTimeout(r, 3000)); const [tr] = await Promise.all([bc("text", { limit: 10000 })]); t.pageText = tr?.text || ""; return { screen: `已点击: ${selector}\n\n${t.pageText.slice(0, 5000)}`, state: s }; }
          return { screen: `点击失败: 未找到 "${selector}"`, state: s };
        }
        const r = await bc("click", { selector });
        if (r.error) return { screen: `点击失败: ${r.error}`, state: s };
        await new Promise(r => setTimeout(r, 3000)); const [tr] = await Promise.all([bc("text", { limit: 10000 })]); t.pageText = tr?.text || "";
        return { screen: `已点击: ${selector}\n\n${t.pageText.slice(0, 5000)}`, state: s };
      }
      if (cmd === "返回" || cmd === "back") return { screen: "已返回", state: { ...s, _close: true } };
      const t = tab(s);
      if (cmd === "@" || cmd === "搜索中" || cmd === "搜索状态") {
        return { screen: pendingSearchesList(), state: s };
      }
      if (cmd === "读" || cmd === "read") {
        if (t.pageText) return { screen: t.pageText.slice(0, 5000), state: s };
        if (t.currentUrl) { const [tr] = await Promise.all([bc("text", { limit: 10000 })]); t.pageText = tr?.text || ""; return { screen: t.pageText.slice(0, 5000) || "(页面无文字)", state: s }; }
        return { screen: "未打开页面。输入 URL。", state: s };
      }
      if (cmd.startsWith("搜索 ") || cmd.startsWith("search ")) { const q = cmd.replace(/^(搜索 |search )/, ""); const result = await searchWeb(q); recordHistory(personDir, `search: ${q}`); return { screen: result.slice(0, 5000), state: s }; }
      if (cmd === "URL" || cmd === "url") return { screen: "请输入 URL。", state: s }; 
      if (cmd.startsWith("URL ") || cmd.startsWith("url ")) { const urlCmd = cmd.slice(4).trim(); if (urlCmd) { cmd = urlCmd; } else { return { screen: "请输入 URL。", state: s }; } }
      if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(cmd) && !cmd.startsWith("http")) cmd = "https://" + cmd;
      if (cmd.startsWith("http://") || cmd.startsWith("https://")) {
        const urlObj = new URL(cmd);
        const h = urlObj.hostname;
        if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" ||
            h.match(/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/)) {
          return { screen: `拒绝访问: ${h} 是内网地址`, state: s };
        }
        const t0 = Date.now();
        const r = await bc("open", { url: cmd, timeout: 30000 });
        if (r.error) return { screen: `打开失败: ${r.error}`, state: s };
        const title = (r.text || "").replace(/^已打开: /, "").split("\n")[0] || cmd;
        t.currentUrl = cmd; t.title = title;
        await bc("wait", { text: title, timeout: 8000 });
        const [tr] = await Promise.all([bc("text", { limit: 10000 })]); t.pageText = tr?.text || "";
        recordHistory(personDir, cmd);
        return { screen: `已打开: ${title}\n${displayUrl(cmd)}\n\n${t.pageText.slice(0, 5000) || "(页面无文字)"}\n\n[${((Date.now() - t0) / 1000).toFixed(1)}s]`, state: s };
      }
      if (cmd) { const result = await searchWeb(cmd); recordHistory(personDir, `search: ${cmd}`); return { screen: result.slice(0, 5000), state: s }; }
      return { screen: "Safari\n  URL | 搜索 xxx  | 返回", state: s };
    } catch (e: any) { return { screen: "错误: " + e.message, state: s }; }
  },
};
