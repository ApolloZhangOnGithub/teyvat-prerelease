// browser-service.js — headless 浏览器 HTTP API（用 playleft，零外部依赖）
// 本地或云端部署，统一 API。启动: node browser-service.js
// 默认端口 BROWSER_PORT=19222，CHROMIUM_PATH 指定 Chrome 路径

const http = require("http");
const fs = require("fs");
const path = require("path");
const { launch } = require("./playleft.cjs");

const PORT = Number(process.env.BROWSER_PORT) || 0;
const DATA_DIR = process.env.BROWSER_DATA || path.join(require("os").homedir(), ".teyvat", "RuntimeCache", "shared", "browser");
const COOKIE_DIR = path.join(DATA_DIR, "cookies");
fs.mkdirSync(COOKIE_DIR, { recursive: true });
const PORT_FILE = path.join(require("os").homedir(), ".teyvat", "browser-service.port");

let browser = null;
let _launching = null;  // 缓存 launch promise，防止并发重复启动
const pages = new Map();

async function getBrowser() {
  if (browser) return browser;
  if (!_launching) {
    _launching = launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
    }).then(b => { browser = b; return b; });
  }
  return _launching;
}

async function getPage(sessionId) {
  if (pages.has(sessionId)) return pages.get(sessionId);
  const b = await getBrowser();
  const p = await b.newPage();
  await loadCookies(p, sessionId);
  pages.set(sessionId, p);
  return p;
}

// ── cookie 持久化 ──

function cookieFile(sid) { return path.join(COOKIE_DIR, `${sid}.json`); }

async function saveCookies(page, sid) {
  try {
    const cookies = await page.getCookies();
    fs.writeFileSync(cookieFile(sid), JSON.stringify(cookies, null, 2));
  } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[B9001] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[universe.infotech/cloud.servers/browser_service.cjs] " + (e?.message || e)); } }
}

async function loadCookies(page, sid) {
  try {
    const cookies = JSON.parse(fs.readFileSync(cookieFile(sid), "utf8"));
    if (cookies.length) await page.setCookies(cookies);
  } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[B9002] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[universe.infotech/cloud.servers/browser_service.cjs] " + (e?.message || e)); } }
}

// ── 操作处理 ──

async function handleAction(action, params, sessionId) {
  const page = await getPage(sessionId);

  switch (action) {
    case "open": {
      if (!params.url) return { error: "需要 url" };
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: Number(params.timeout) || 30000 });
      await saveCookies(page, sessionId);
      return { text: `已打开: ${await page.title()}\n${await page.url()}` };
    }
    case "text": {
      return { text: await page.text(Number(params.limit) || 5000) };
    }
    case "links": {
      const links = await page.links(Number(params.limit) || 30);
      return { text: links.map((l, i) => `[${i}] ${l.text || "(无)"} → ${l.href}`).join("\n") };
    }
    case "search": {
      if (!params.query) return { error: "需要 query" };
      return { text: await page.search(params.query) };
    }
    case "click": {
      if (!params.selector) return { error: "需要 selector" };
      await page.click(params.selector);
      await saveCookies(page, sessionId);
      return { text: `已点击 ${params.selector}\n当前: ${await page.title()}` };
    }
    case "type": {
      if (!params.selector || !params.text) return { error: "需要 selector 和 text" };
      await page.type(params.selector, params.text);
      return { text: `已输入 "${params.text}"` };
    }
    case "scroll": {
      await page.scroll(params.direction || "down", Number(params.amount) || 500);
      return { text: `已滚动` };
    }
    case "wait": {
      if (!params.text) return { error: "需要 text (等待出现的文本)" };
      const found = await page.wait(params.text, Number(params.timeout) || 8000);
      return { text: found ? `已出现: "${params.text}"` : `超时: "${params.text}" 未出现` };
    }
    case "back": {
      await page.eval("history.back()");
      await new Promise(r => setTimeout(r, 500));
      return { text: `返回: ${await page.title()}` };
    }
    case "url": {
      return { text: await page.url() };
    }
    case "cookie_import": {
      if (!Array.isArray(params.cookies)) return { error: "cookies 必须是数组" };
      await page.setCookies(params.cookies);
      await saveCookies(page, sessionId);
      return { text: `已导入 ${params.cookies.length} 个 cookies` };
    }
    case "cookie_export": {
      const cookies = await page.getCookies();
      return { text: `${cookies.length} 个 cookies`, cookies };
    }
    case "close": {
      await saveCookies(page, sessionId);
      await page.close();
      pages.delete(sessionId);
      return { text: "已关闭" };
    }
    default:
      return { error: `未知: ${action}`, help: "open/text/links/search/click/type/scroll/back/url/cookie_import/cookie_export/close" };
  }
}

// ── HTTP 服务 ──

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, pages: pages.size }));
    return;
  }
  if (req.method !== "POST") { res.writeHead(405); res.end("POST only"); return; }

  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    try {
      const { action, session, ...params } = JSON.parse(body);
      const result = await handleAction(action, params, session || "default");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" ? addr.port : PORT;
  fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
  fs.writeFileSync(PORT_FILE, String(actualPort));
  console.log(`browser-service :${actualPort} | port file: ${PORT_FILE}`);
});

// 清理：退出时杀 Chrome，避免 orphan 进程堆积吞 CPU
let _cleanupDone = false;
const cleanup = async () => {
  if (_cleanupDone) return;
  _cleanupDone = true;
  if (browser) {
    try { await browser.close(); } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[B9003] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[universe.infotech/cloud.servers/browser_service.cjs] " + (e?.message || e)); } }
  }
  server.close();
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup().then(() => process.exit(0)); });
process.on("SIGTERM", () => { cleanup().then(() => process.exit(0)); });
