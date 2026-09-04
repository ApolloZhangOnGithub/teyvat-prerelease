// playleft.js — 极简 CDP 客户端，零依赖，替代 Playwright
// 直接用 Node.js 原生 WebSocket 控制 Chromium

const { spawn } = require("child_process");
const http = require("http");
// Node 22+ 原生 WebSocket，零依赖

let _msgId = 0;

class PlayleftPage {
  constructor(ws, targetId) {
    this._ws = ws;
    this._targetId = targetId;
    this._callbacks = new Map();
    this._eventHandlers = [];
    this._ws.onmessage = (evt) => {
      const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
      const msg = JSON.parse(raw);
      if (msg.id && this._callbacks.has(msg.id)) {
        const cb = this._callbacks.get(msg.id);
        this._callbacks.delete(msg.id);
        if (msg.error) cb.reject(new Error(msg.error.message));
        else cb.resolve(msg.result);
      }
      for (const h of this._eventHandlers) h(msg);
    };
  }

  _send(method, params = {}) {
    const id = ++_msgId;
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this._callbacks.has(id)) {
          this._callbacks.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async goto(url, opts = {}) {
    await this._send("Page.enable");
    const timeout = Number(opts.timeout) || 30000;
    const waitEvent = opts.waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
    const nav = new Promise((resolve) => {
      const handler = (msg) => {
        if (msg.method === waitEvent) {
          this._eventHandlers = this._eventHandlers.filter(h => h !== handler);
          resolve();
        }
      };
      this._eventHandlers.push(handler);
      setTimeout(resolve, timeout);
    });
    await this._send("Page.navigate", { url });
    await nav;
    await new Promise(r => setTimeout(r, 300));
  }

  async title() {
    const r = await this._send("Runtime.evaluate", { expression: "document.title" });
    return r.result?.value || "";
  }

  async url() {
    const r = await this._send("Runtime.evaluate", { expression: "location.href" });
    return r.result?.value || "";
  }

  async text(limit = 5000) {
    const r = await this._send("Runtime.evaluate", {
      expression: `(function(){
        var s=[];
        var walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{
          acceptNode:function(n){
            var p=n.parentElement;
            if(!p)return NodeFilter.FILTER_REJECT;
            var t=p.tagName;
            if(t==='SCRIPT'||t==='STYLE'||t==='NOSCRIPT'||t==='TEMPLATE')return NodeFilter.FILTER_REJECT;
            if(t==='INPUT'||t==='TEXTAREA'||t==='SELECT')return NodeFilter.FILTER_REJECT;
            if(p.offsetWidth===0&&p.offsetHeight===0)return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        var n,len=0;
        while((n=walk.nextNode())&&len<${limit}){
          var v=n.nodeValue;
          if(v){v=v.replace(/[ \\t]+/g,' ');if(v!==' '){s.push(v);len+=v.length;}}
        }
        return s.join('').replace(/\\n{3,}/g,'\\n\\n').slice(0,${limit});
      })()`
    });
    return r.result?.value || "";
  }

  async eval(expression) {
    const r = await this._send("Runtime.evaluate", {
      expression, returnByValue: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval error");
    return r.result?.value;
  }

  async wait(text, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const r = await this._send("Runtime.evaluate", { expression: "document.body?.innerText || ''", returnByValue: true });
        if (r.result?.value?.includes(text)) return true;
      } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[16001] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[universe.infotech/cloud.servers/playleft.cjs] " + (e?.message || e)); } }
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  async links(limit = 30) {
    return await this.eval(`
      JSON.stringify([...document.querySelectorAll("a[href]")].slice(0, ${limit}).map(a => ({
        text: (a.innerText || "").trim().slice(0, 60),
        href: a.href
      })))
    `).then(JSON.parse);
  }

  async search(query) {
    return await this.eval(`
      document.body.innerText.split("\\n").filter(l => l.includes(${JSON.stringify(query)})).slice(0, 20).join("\\n")
    `);
  }

  async click(selector) {
    const r = await this._send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return "not_found";
        el.click();
        return "ok";
      })()`
    });
    if (r.result?.value === "not_found") throw new Error(`未找到: ${selector}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  async type(selector, text) {
    await this._send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("not found");
        el.focus();
        el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event("input", {bubbles: true}));
        el.dispatchEvent(new Event("change", {bubbles: true}));
      })()`
    });
  }

  async scroll(direction = "down", amount = 500) {
    const y = direction === "up" ? -amount : amount;
    await this._send("Runtime.evaluate", {
      expression: `window.scrollBy(0, ${y})`
    });
  }

  async accessibility() {
    try {
      const r = await this._send("Accessibility.getFullAXTree", { max_depth: 4 });
      return r.nodes || [];
    } catch {
      return [];
    }
  }

  async getCookies() {
    await this._send("Network.enable");
    const r = await this._send("Network.getCookies");
    return r.cookies || [];
  }

  async setCookies(cookies) {
    await this._send("Network.enable");
    for (const c of cookies) {
      await this._send("Network.setCookie", {
        name: c.name, value: c.value, domain: c.domain,
        path: c.path || "/", httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
        ...(c.expires ? { expires: c.expires } : {}),
      });
    }
  }

  async close() {
    try { this._ws.close(); } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[16002] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[universe.infotech/cloud.servers/playleft.cjs] " + (e?.message || e)); } }
  }
}

class PlayleftBrowser {
  constructor(process, wsUrl) {
    this._process = process;
    this._wsUrl = wsUrl;
    this._pages = [];
  }

  async newPage() {
    // 获取 targets
    const debugUrl = this._wsUrl.replace("ws://", "http://").replace(/\/devtools.*/, "");
    const targets = await new Promise((resolve, reject) => {
      const req = http.request(`${debugUrl}/json/new`, { method: "PUT" }, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            // Chromium 有时在 JSON 前输出警告，提取第一个 { 开始的部分
            const jsonStart = data.indexOf("{");
            const jsonData = jsonStart >= 0 ? data.slice(jsonStart) : data;
            resolve(JSON.parse(jsonData));
          } catch (e) { reject(new Error(`JSON parse failed: ${data.slice(0, 100)}`)); }
        });
      }).on("error", reject);
      req.end();
    });

    const wsUrl = targets.webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
      setTimeout(() => reject(new Error("ws connect timeout")), 5000);
    });

    const page = new PlayleftPage(ws, targets.id);
    this._pages.push(page);
    return page;
  }

  async close() {
    for (const p of this._pages) await p.close().catch(() => {});
    try { this._process.kill(); } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[16003] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[universe.infotech/cloud.servers/playleft.cjs] " + (e?.message || e)); } }
  }
}

async function launch(options = {}) {
  const defaultChrome = process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "chromium-browser";
  const chromePath = options.executablePath || process.env.CHROMIUM_PATH || defaultChrome;
  const port = options.port || (9000 + Math.floor(Math.random() * 1000));

  const dataDir = options.userDataDir || require("path").join(require("os").tmpdir(), "playleft-chrome-" + port);
  const args = [
    "--headless", `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDir}`,
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--window-size=1280,800",
    ...(options.args || []),
  ];

  const proc = spawn(chromePath, args, { stdio: "ignore" });

  // 等 CDP 端口就绪
  for (let i = 0; i < 30; i++) {
    try {
      const data = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => {
            const jsonStart = d.indexOf("{");
            resolve(JSON.parse(jsonStart >= 0 ? d.slice(jsonStart) : d));
          });
        }).on("error", reject);
      });
      return new PlayleftBrowser(proc, data.webSocketDebuggerUrl);
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  proc.kill();
  throw new Error("Chromium 启动超时");
}

module.exports = { launch, PlayleftBrowser, PlayleftPage };
