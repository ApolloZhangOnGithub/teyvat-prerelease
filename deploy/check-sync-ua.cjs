#!/usr/bin/env node
// check-sync-ua.cjs — 打到 sync 服务（Cloudflare 后面）的请求必须带 User-Agent
// 2026-09-11 prime-agent
//
// 背景：sync.paimon.beer 在 Cloudflare 后面，**无 UA 的请求会被 Bot Management 拒**：
//   实测 `GET /auth/devices`：不带 UA → 403 "error code: 1010"；带 UA → 200。
// 2026-09-07 修过一次（TS 侧 client.ts / communicate.ts），但 2026-09-11 又发现三处漏网：
//   `devices.cjs`（所有调用经 H()）、`upload-state.cjs`、`cli.ts` 的 device-flow 登录两处 ——
//   其中 `genshin d`（设备管理）与 `genshin login` 的策略2 在线上都是 403 坏的。
// 结论：这条纪律必须机械化，否则每加一个 CLI 就要重踩一次。
//
// 判定：扫源码里的 fetch()/curl，若该调用上下文涉及 sync 端点（sync.paimon.beer / syncEndpoint /
//   /auth/ / /sync/ / /messages/ 等），则同一调用上下文里必须出现 User-Agent / SYNC_UA / -A / --user-agent。
//   走 apiFetch(...) 包装的调用视为安全（paths.ts 里已统一注入 SYNC_UA）。
// 豁免：localhost / 127.0.0.1（本地隧道，不过 Cloudflare）；第三方用户配置后端（webacts 的 fetchBackend）。
// fail-closed：一个候选都没扫到 → FAIL（防止重构后门禁静默失效）。
//
// 用法: node C.deploy/check-sync-ua.cjs [A.core 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const CODE_EXT = new Set([".ts", ".js", ".cjs", ".mjs", ".sh"]);
const files = [];
const walk = (dir) => {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name === "node_modules" || it.name === ".git" || it.name.startsWith(".backups")) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full);
    else if (CODE_EXT.has(path.extname(it.name))) files.push(full);
  }
};
walk(core);

const SYNC_MARK = /sync\.paimon\.beer|syncEndpoint\(|SYNC_ENDPOINT|\/auth\/|\/sync\/|\/messages\//;
const UA_MARK = /User-Agent|user-agent|SYNC_UA|-A "|--user-agent/;
const LOCAL_MARK = /localhost|127\.0\.0\.1/;
const SAFE_WRAPPER = /apiFetch\(|fetchBackend\.fetch\(/;

const bad = [];
let candidates = 0, safe = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  // 本文件里"自带 User-Agent 的 headers helper"（如 devices.cjs 的 `const H = (extra) => ({ ..., "User-Agent": SYNC_UA, ...extra })`）：
  // 用了这些 helper 的调用视为安全 —— 否则会把"间接带 UA"误判成漏网（第一版就这样误报过一次）。
  const uaHelpers = new Set();
  for (const l of lines) {
    const m = l.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (m && UA_MARK.test(l)) uaHelpers.add(m[1]);
  }
  lines.forEach((line, i) => {
    const isFetch = /fetch\(/.test(line) && !SAFE_WRAPPER.test(line);
    const isCurl = /\bcurl\b/.test(line) && /sync\.paimon\.beer/.test(line);
    if (!isFetch && !isCurl) return;
    // 调用上下文：本行 ±10 行（多行对象字面量/多行 curl 续行都覆盖）
    const ctx = lines.slice(Math.max(0, i - 10), i + 11).join("\n");
    if (!SYNC_MARK.test(ctx)) return;     // 不是打 sync 的请求（第三方后端/其它服务）
    if (LOCAL_MARK.test(ctx) && !SYNC_MARK.test(line)) return;  // 本地隧道
    candidates++;
    if (UA_MARK.test(ctx)) { safe++; return; }
    if ([...uaHelpers].some((h) => new RegExp("\\b" + h + "\\s*\\(").test(line))) { safe++; return; }   // 间接带 UA 的 helper
    bad.push(`${path.relative(core, f)}:${i + 1}  ${line.trim().slice(0, 110)}`);
  });
}

console.log(`[sync-ua] 扫 ${files.length} 个文件：sync 请求 ${candidates} 处（${safe} 处带 UA）`);
if (candidates === 0) {
  console.error("[sync-ua] FAIL: 一处 sync 请求都没扫到 —— 判定规则可能已失效（fail-closed）");
  process.exit(1);
}
for (const b of bad) console.error(`  FAIL  ${b}`);
if (bad.length) {
  console.error(`[sync-ua] FAIL: ${bad.length} 处 sync 请求没带 User-Agent —— Cloudflare 会返回 403 error 1010`);
  console.error("        加 headers 里的 User-Agent（值用 paths.ts 的 SYNC_UA 常量的等价物 \"genshin-sync/1.0\"），或改走 apiFetch()");
  process.exit(1);
}
console.log("[sync-ua] PASS — 所有 sync 请求都带 User-Agent（或走 apiFetch 统一注入）");
