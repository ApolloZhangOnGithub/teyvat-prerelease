// browser-service.js — headless 浏览器 HTTP API（用 playleft，零外部依赖）
// 本地或云端部署，统一 API。启动: node browser-service.js
// 默认端口 BROWSER_PORT=19222，CHROMIUM_PATH 指定 Chrome 路径

const http = require("http");
const fs = require("fs");
const path = require("path");
const { launch } = require("./playleft.cjs");
const crypto = require("crypto");

const PORT = Number(process.env.BROWSER_PORT) || 0;
const DATA_DIR = process.env.BROWSER_DATA || path.join(require("os").homedir(), ".teyvat", "RuntimeCache", "shared", "browser");
const COOKIE_DIR = path.join(DATA_DIR, "cookies");
fs.mkdirSync(COOKIE_DIR, { recursive: true });
const PAIMON_HOME = process.env.PAIMON_HOME || path.join(require("os").homedir(), ".teyvat");
const PORT_FILE = path.join(PAIMON_HOME, "browser-service.port");
// 2026-09-13（审计 HIGH）：原来无任何鉴权且带 Access-Control-Allow-Origin: *——用户浏览器里任意网页扫到本地端口即可
// open file:///…/binding.json + text 读走 GitHub token、cookie_export 导出登录 cookie。现在每次启动生成随机 token 写在
// port 文件旁（0600），调用方（kernel.ts / safari.ts）带 Authorization: Bearer；不再发 CORS 头。
const TOKEN_FILE = path.join(PAIMON_HOME, "browser-service.token");
const TOKEN = crypto.randomBytes(24).toString("hex");
const MAX_BODY = 1 << 20;
const ACTIONS = new Set(["open", "text", "links", "search", "click", "type", "scroll", "wait", "back", "url", "cookie_import", "cookie_export", "close", "ping"]);
const SESSION_RE = /^[\w.-]{1,64}$/;

let browser = null;
let _launching = null;  // 缓存 launch promise，防止并发重复启动
const pages = new Map();

async function getBrowser() {
  if (browser) return browser;
  if (!_launching) {
    _launching = launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // 2026-09-13：Chrome 自己死了要把句柄清掉，否则之后每个请求都等 30s 超时直到服务重启
      onExit: () => { browser = null; _launching = null; pages.clear(); },
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
  if (!ACTIONS.has(action)) return { error: `未知: ${action}`, help: "open/text/links/search/click/type/scroll/back/url/cookie_import/cookie_export/close" };
  if (!SESSION_RE.test(String(sessionId))) return { error: "bad session（只允许 [A-Za-z0-9_.-]{1,64}）" }; // 2026-09-13：原来 session 直接拼进 cookies/<sid>.json 路径 → ../../ 穿越写任意 .json
  if (action === "ping") return { ok: true }; // 探活不开标签页（原来先 getPage 再 switch，ping 也会新开一个 Chrome tab）
  const page = await getPage(sessionId);

  switch (action) {
    case "open": {
      if (!params.url) return { error: "需要 url" };
      if (!/^https?:\/\//i.test(String(params.url))) return { error: "只允许 http/https URL" }; // 2026-09-13：file:// / javascript: 一律拒绝
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
  // 不再设置任何 CORS 头：调用方只有本机 Node 进程；带 * 等于把本机浏览器开放给任意网页
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== "POST") { res.writeHead(405); res.end("POST only"); return; }
  const auth = String(req.headers["authorization"] || "");
  if (auth !== "Bearer " + TOKEN) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized（需要 browser-service.token）" })); return; }

  let body = "";
  let tooBig = false;
  req.on("data", c => { if (tooBig) return; body += c; if (body.length > MAX_BODY) { tooBig = true; res.writeHead(413); res.end("body too large"); req.destroy(); } });
  req.on("end", async () => {
    if (tooBig) return;
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

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" ? addr.port : PORT;
  fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) { /* 已存在时补权限失败不致命 */ }
  fs.writeFileSync(PORT_FILE, String(actualPort));
  console.log(`browser-service :${actualPort} | port file: ${PORT_FILE}`);
});

// 清理：退出时杀 Chrome，避免 orphan 进程堆积吞 CPU
let _cleanupDone = false;
const cleanup = async () => {
  if (_cleanupDone) return;
  _cleanupDone = true;
  // 2026-09-13：exit 钩子里第一个 await 之后的代码不会再跑——先同步杀 Chrome，再做异步收尾（原来有页面打开时 Chrome 必成孤儿）
  try { if (browser && browser._process) browser._process.kill(); } catch (e) { /* 已退出 */ }
  if (browser) {
    try { await browser.close(); } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[B9003] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[universe.infotech/cloud.servers/browser_service.cjs] " + (e?.message || e)); } }
  }
  server.close();
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup().then(() => process.exit(0)); });
process.on("SIGTERM", () => { cleanup().then(() => process.exit(0)); });
process.on("SIGHUP", () => { cleanup().then(() => process.exit(0)); }); // 2026-09-13：终端关闭走 SIGHUP，原来不处理 → Chrome 孤儿
