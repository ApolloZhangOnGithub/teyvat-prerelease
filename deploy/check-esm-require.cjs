#!/usr/bin/env node
// check-esm-require.cjs — ESM 文件里的裸 require 检查（2026-09-14 dev-01 从 Makefile 内联段抽出成独立脚本，
// 原内联版的多行续行 + 行尾注释在 make/bash 两层转义下极度脆弱——今晚连续三次 Error 127/零匹配的根源）。
// 规则：扫描 god.tui/{overrides,ui_elements,commands} 的 .js/.ts：
//   含 require( 且无 createRequire → 统计非注释 require 行 → >0 判 FAIL。
// 例外：overrides/pi-dist/** 是 pi 原文件镜像（require 是 pi 自身形态），不检查。
const fs = require("fs");
const path = require("path");

const core = process.argv[2];
if (!core) { console.error("usage: check-esm-require.cjs <A.core>"); process.exit(1); }
const tui = path.join(core, "god.tui");
const dirs = ["overrides", "ui_elements", "commands"].map((d) => path.join(tui, d));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p.includes("pi-dist")) continue; // pi 原文件镜像——require 是 pi 自身形态，不检查
      yield* walk(p);
    } else if (/\.(js|ts)$/.test(e.name)) yield p;
  }
}

let n = 0, fail = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    n++;
    const s = fs.readFileSync(f, "utf8");
    if (s.includes("createRequire")) continue;
    const bad = s.split("\n").filter((l) => /require\(/.test(l) && !/^\s*\/\//.test(l)).length;
    if (bad > 0) { console.log(`  BARE require in ESM (${bad}): ${path.relative(core, f)}`); fail++; }
  }
}
if (n === 0) { console.error("  ERROR: ESM check 零匹配 —— 目录结构已变，检查未生效"); process.exit(1); }
console.log(`  checked ${n} files`);
process.exit(fail > 0 ? 1 : 0);
