#!/usr/bin/env node
// check-install-sources.cjs — install.sh 引用的源文件必须存在（除非注释写明是"有意不在 A.core"）
// 2026-09-11 prime-agent
//
// 背景：`install.sh` 第 6 段（shell completion）引用的 `god.frontend.cli/genshin-completion.zsh`
// **在重构中丢了**，于是每次构建都 warn「completion 源文件缺失」、~/.zshrc 的 source 行指向空气。
// 而同一个脚本里 mobile cli / identity cli 两处缺失**是有意的**（注释写明"已移入 F.experimental"/"已不在 A.core"）。
// 约定：缺失可以，但必须**就近写清为什么**；没写的缺失就是 bug。
//
// 用法: node C.deploy/check-install-sources.cjs [C.deploy 路径] [A.core 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const path = require("node:path");

const deploy = path.resolve(process.argv[2] || __dirname);
const core = path.resolve(process.argv[3] || path.join(deploy, "..", "A.core"));
const sh = path.join(deploy, "install.sh");
if (!fs.existsSync(sh)) { console.error("[install-sources] FAIL: 找不到 install.sh: " + sh); process.exit(1); }

const lines = fs.readFileSync(sh, "utf8").split("\n");
// 有意缺失的说明关键词（必须出现在引用行上下 10 行内的注释里）
const INTENT = /(已移入|已不在\s*A\.core|F\.experimental|已移除|deprecated|历史遗留)/;

let checked = 0, bad = 0, intentional = 0;
const seen = new Set();
lines.forEach((line, i) => {
  const m = line.match(/"?\$\{?IMPL\}?\/([A-Za-z0-9_./\-]+)"?/) || line.match(/"?\$\{?DEPLOY\}?\/([A-Za-z0-9_./\-]+)"?/);
  if (!m) return;
  const rel = m[1];
  if (seen.has(rel)) return;
  seen.add(rel);
  checked++;
  const isImpl = line.includes("IMPL");
  const target = path.join(isImpl ? core : deploy, rel);
  if (fs.existsSync(target)) return;
  const ctx = lines.slice(Math.max(0, i - 10), i + 1).join("\n");
  if (INTENT.test(ctx)) { intentional++; return; }
  console.error(`  FAIL  install.sh:${i + 1} 引用的源文件不存在，且没写"为什么有意缺失": ${isImpl ? "A.core" : "C.deploy"}/${rel}`);
  console.error(`        若确实是有意缺失（如已移入 teyvat-sides/F.experimental），在该行附近加一句注释说明；否则补回文件`);
  bad++;
});
console.log(`[install-sources] 检查 ${checked} 个源路径（其中 ${intentional} 个写明"有意缺失"）`);
if (bad) { console.error(`[install-sources] FAIL: ${bad} 处缺失且未说明`); process.exit(1); }
console.log("[install-sources] PASS — install.sh 引用的源文件都存在，或已注明为何有意缺失");
