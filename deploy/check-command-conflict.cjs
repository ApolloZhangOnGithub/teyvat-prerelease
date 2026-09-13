#!/usr/bin/env node
// check-command-conflict.cjs —— 扩展 slash 命令 vs pi 内置命令撞名检查（ISSUE 252 定稿，2026-09-14 dev-01）
// 撞名后果：扩展命令被静默废掉（autocomplete 跳过 + 不可达，诊断只在启动横幅不进日志——/copy 事故）。
// 用法：node check-command-conflict.cjs <A.core路径>
const fs = require("fs");
const path = require("path");

const core = process.argv[2];
if (!core) { console.error("usage: check-command-conflict.cjs <A.core>"); process.exit(1); }

const cmdsDir = path.join(core, "god.frontend.tui/commands");
const manifest = path.join(core, "god.frontend.tui/overrides/pi-dist/core/slash-commands.js");

// 1. 内置命令名清单（override 版 slash-commands.js 的 { name: "xxx" ... }）
const manifestSrc = fs.readFileSync(manifest, "utf8");
const builtinNames = new Set();
for (const m of manifestSrc.matchAll(/\bname:\s*"([^"]+)"/g)) builtinNames.add(m[1]);

// 2. 扫描 commands/*.ts 里所有 registerCommand("name"
const extensionNames = [];
for (const f of fs.readdirSync(cmdsDir)) {
  if (!f.endsWith(".ts")) continue;
  const src = fs.readFileSync(path.join(cmdsDir, f), "utf8");
  for (const m of src.matchAll(/registerCommand\(\s*"([^"]+)"/g)) {
    extensionNames.push({ name: m[1], file: f });
  }
}

// 3. 交集 = 冲突
const conflicts = extensionNames.filter((c) => builtinNames.has(c.name));
if (conflicts.length > 0) {
  console.error("  ERROR: 扩展 slash 命令与 pi 内置命令撞名（会被静默废掉——ISSUE 252）：");
  for (const c of conflicts) {
    console.error(`    '/${c.name}'  (${c.file})`);
  }
  console.error("  解法二选一：");
  console.error("    a) 改用不撞名的短名（如 model→m）");
  console.error("    b) 从 god.frontend.tui/overrides/pi-dist/core/slash-commands.js 移除该内置项（teyvat 已禁用 pi 原生命令，占坑无意义），并同步部署");
  process.exit(1);
}
console.log(`  ✓ slash 命令无内置冲突（${extensionNames.length} 个扩展命令 vs ${builtinNames.size} 个内置名）`);
