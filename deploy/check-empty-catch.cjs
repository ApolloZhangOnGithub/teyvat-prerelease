#!/usr/bin/env node
// check-empty-catch.cjs — 构建门禁：任何文件出现空 catch{}（静默吞错）→ make 失败（无法构建部署）
// 背景（2026-08-20 用户定稿）：空 catch 静默吞错是系统性问题（曾扫出 526 处）。
//   用户要求「任何地方调用空的 catch 都无法运行通过，任何文件」——落实为构建期强制：
//   make 时扫描全部源文件，发现空 catch{} 直接 exit 1（构建不过 = 无法部署 = 无法运行）。
//   存量已由 fix-empty-catch.cjs --apply 批量修复（加 console.error 日志）。
// 用法: node check-empty-catch.cjs   （exit 0=通过，exit 1=发现空 catch）
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "A.core");
const EXCLUDE = ["node_modules", ".bak", ".REMOVED", ".bak-fixcatch"];

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.some(x => dir.includes(x) || ent.name.includes(x))) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (/\.(js|ts|cjs|mjs)$/.test(ent.name)) yield p;
  }
}

// 空 catch 块：catch {} / catch { } / catch (e) { }（块内仅空白）
const RE_EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

let bad = 0;
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, "utf8");
  const m = src.match(RE_EMPTY_CATCH);
  if (m) {
    bad += m.length;
    const line = src.slice(0, m.index).split("\n").length;
    console.error(`❌ 空 catch{}（静默吞错，LESSON 024 反模式）: ${path.relative(ROOT, file)}:${line}`);
  }
}

if (bad > 0) {
  console.error(`\n共 ${bad} 处空 catch{}——构建失败。请用 fix-empty-catch.cjs 修复（node C.deploy/fix-empty-catch.cjs --apply）后再构建。`);
  process.exit(1);
}
console.log("✅ 空 catch{} 检查通过（0 处）");
