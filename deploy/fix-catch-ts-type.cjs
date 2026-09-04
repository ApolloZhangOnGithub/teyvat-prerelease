#!/usr/bin/env node
// fix-catch-ts-type.cjs — 修复 fix-empty-catch.cjs 批量加日志引入的 TS2339（catch 参数 e 是 {} 类型）
// 用法: node fix-catch-ts-type.cjs [--apply]
//   默认 dry-run：统计；--apply：把 `(e?.message || e)` → `((e as any)?.message || e)`，自动 .bak 备份
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "A.core");
const APPLY = process.argv.includes("--apply");
const EXCLUDE = ["node_modules", ".bak", ".REMOVED", ".bak-fixcatch", ".bak-fixc"];

// 匹配 catch 日志里的 (e?.message || e)——保留原变量名（e/err/error 等）
const RE = /\((\w+)\?\.message \|\| \1\)/g;

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.some(x => dir.includes(x) || ent.name.includes(x))) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.name.endsWith(".ts")) yield p; // 只修 .ts（JS 无类型检查）
  }
}

let total = 0;
const files = [];
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(RE);
  if (!m) continue;
  total += m.length;
  files.push(path.relative(ROOT, file));
  if (APPLY) {
    const bak = file + ".bak-fixc";
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, src);
    fs.writeFileSync(file, src.replace(RE, (mm, v) => `((${v} as any)?.message || ${v})`));
  }
}

console.log(`(e?.message || e) 模式总数: ${total}${APPLY ? "（已修复，备份 .bak-fixc）" : ""}`);
if (!APPLY) console.log("涉及文件数:", files.length, "\n前 10:", files.slice(0, 10).join(", "));
