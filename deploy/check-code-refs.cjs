#!/usr/bin/env node
// check-code-refs.cjs — 代码里引用的**相对文件路径**必须存在
// 2026-09-11 prime-agent
//
// 背景（同一天抓到 3 个实例，全是"重构/搬家后路径没跟上"）:
//   ① `local.mobile/apps/arxiv/arxiv.ts` 依赖同目录 `arxiv-search.py` —— 文件不存在 → app 一直返回"搜索失败"
//   ② `local.mobile/apps/safari/safari.ts`：`../../../universe.infotech/cloud.servers/browser_service.cjs`
//      多算了一层（往上三层已经是 universe.infotech）→ 解析到 universe.infotech/universe.infotech/… → 浏览器服务起不来
//   ③ `local.mobile/apps/ipod/ipod.ts`：`../../../spirit.bio.organs/…` 少算一层（需要四层才到 A.core）→ 录音模块路径一直错
// 这类问题不会编译报错（路径是运行时拼的），只能靠"解析后看文件在不在"抓到。
//
// 判定：扫 `join|resolve(... import.meta.dirname|__dirname ..., "相对字面量")` 与 `new URL("相对字面量", import.meta.url)`；
//   解析后的路径必须存在。允许两种例外：
//     - 文件属于"部署进 pi dist"的覆盖层（god.frontend.tui/ui_elements/*、overrides/*）：它们运行时被拷进 pi 的 tree，
//       相对路径在那里有效 → 用"同名后缀在线上 runtime 里存在"放行
//     - 该行有 `// ref-ok:` 注释（写明理由）
//   fail-closed：一个引用都没扫到 → FAIL（规则失效）。
//
// 用法: node C.deploy/check-code-refs.cjs [A.core 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const EXT = new Set([".ts", ".js", ".cjs", ".mjs"]);
// 用**平衡括号**扫描提取调用实参：正则的 [^)]* 会被 dirname(fileURLToPath(import.meta.url)) 这种嵌套括号骗过
// （第一版就漏掉了 safari/ipod 那两个真问题，只剩 3 个简单形式被扫到）。
function extractCalls(text, callee) {
  const out = [];
  const needle = callee + "(";
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    const open = idx + needle.length - 1;
    let depth = 0, end = -1;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) break;
    out.push(text.slice(open + 1, end));
    idx = end + 1;
  }
  return out;
}
const REL_ONLY = /^\.{1,2}\//;   // 只查相对路径（绝对/裸模块名不归本门禁管）

const files = [];
const walk = (d) => {
  let items = [];
  try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name === "node_modules" || it.name === ".git") continue;
    const full = path.join(d, it.name);
    if (it.isDirectory()) walk(full);
    else if (EXT.has(path.extname(it.name))) files.push(full);
  }
};
walk(core);

// 线上 pi dist（用于覆盖层的相对路径判定）
const piDist = path.join(os.homedir(), ".local/lib/teyvat/runtime/node_modules/@earendil-works/pi-coding-agent/dist");
let distFiles = [];
try {
  const w = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) w(full); else distFiles.push(full);
    }
  };
  if (fs.existsSync(piDist)) w(piDist);
} catch { /* 线上 runtime 不在（未部署）：退化为只看仓库 */ }
const isOverrideLayer = (rel) => /^god\.frontend\.tui\/(ui_elements|overrides)\//.test(rel);

let checked = 0, missing = 0, distOk = 0;
const hits = [];
for (const f of files) {
  const rel = path.relative(core, f);
  if (rel.startsWith(".backups")) continue;
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const src = fs.readFileSync(f, "utf8");
  const rawArgs = [
    ...extractCalls(src, "join").filter((a) => /import\.meta\.dirname|import\.meta\.url|__dirname|\.dirname\(/.test(a)).flatMap((a) => [...a.matchAll(/"([^"]*)"/g)].map((m) => m[1])),
    ...extractCalls(src, "resolve").filter((a) => /import\.meta\.dirname|import\.meta\.url|__dirname|\.dirname\(/.test(a)).flatMap((a) => [...a.matchAll(/"([^"]*)"/g)].map((m) => m[1])),
    ...[...src.matchAll(/new URL\s*\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g)].map((m) => m[1]),
    // 动态 import("x") / require("x")（覆盖层里的 ../theme/theme.js 就是这种）
    ...[...src.matchAll(/\bimport\s*\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/\brequire\s*\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
  ];
  {
    for (const target of rawArgs) {
      if (!REL_ONLY.test(target)) continue;
      checked++;
      if (fs.existsSync(path.resolve(path.dirname(f), target))) continue;
      // 覆盖层：同名后缀在线上 pi dist 里存在 → 视为有效（运行时它就在那棵树里）
      if (isOverrideLayer(rel)) {
        const suffix = target.replace(/^(\.\.\/)+/, "");
        if (distFiles.some((d) => d.endsWith(path.sep + suffix))) { distOk++; continue; }
      }
      const lineNo = lines.findIndex((l) => l.includes(`"${target}"`)) + 1;
      if (/ref-ok:/.test(lines[lineNo - 1] || "")) continue;
      missing++;
      hits.push(`${rel}:${lineNo}  → "${target}" 解析为 ${path.relative(core, path.resolve(path.dirname(f), target))}（不存在）`);
    }
  }
}
console.log(`[code-refs] 扫 ${files.length} 个文件、${checked} 个相对引用（覆盖层经线上 runtime 放行 ${distOk} 个）`);
if (checked === 0) { console.error("[code-refs] FAIL: 一个相对引用都没扫到（规则失效，fail-closed）"); process.exit(1); }
for (const h of hits) console.error(`  FAIL  ${h}`);
if (missing) {
  console.error(`[code-refs] FAIL: ${missing} 个代码内相对引用指向不存在的文件（运行时会 no such file）`);
  process.exit(1);
}
console.log("[code-refs] PASS — 代码内相对引用都能解析到真实文件");
