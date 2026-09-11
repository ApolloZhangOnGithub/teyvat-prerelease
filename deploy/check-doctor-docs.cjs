#!/usr/bin/env node
// check-doctor-docs.cjs — Doctor 文档 ↔ 代码一致性门禁
// 2026-09-11 prime-agent
//
// 背景：`Wiki/Doctor(Paimon Integrity).WIKI` 的"检查项"表里曾写着 `tmux-orphan`（以及 dir-legacy /
// sync-manifest / sync-lock / sync-tamper / sync-excluded / dir-config-dup / dir-agentfile），
// 但 `doctor.ts` 里**根本没有这些检查** —— 文档说有的体检项其实不存在，读文档的人会被骗。
// 反向也有：`config` / `disk` / `org` / `plist-agents` / `process` / `scrollback` / `sync-status`
// 实现了但文档没写。两类都算漂移。
//
// 做法：解析 WIKI「## 检查项」到「### 历史 / 未实现」之前的表格里的反引号标识 = 声称已实现的检查；
//   解析 doctor.ts 里 ok/fail/warn/skip 的第一个字符串参数 = 实际实现的检查；两边集合必须相等。
//   历史段里列的名字**不参与**比较（那段本来就说明"代码已无"）。
//   WIKI 或 doctor.ts 解析不到 → FAIL（不许静默通过）。
//
// 用法: node C.deploy/check-doctor-docs.cjs [A.core 路径] [B.docs 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const docsRoot = path.resolve(process.argv[3] || path.join(core, "..", "B.docs"));
const wikiPath = path.join(docsRoot, "Dev.Common/Wiki/Doctor(Paimon Integrity).WIKI");
const doctorTs = path.join(core, "god.frontend.cli/doctor.ts");

if (!fs.existsSync(wikiPath)) { console.error("[doctor-docs] FAIL: 找不到 WIKI: " + wikiPath); process.exit(1); }
if (!fs.existsSync(doctorTs)) { console.error("[doctor-docs] FAIL: 找不到 doctor.ts: " + doctorTs); process.exit(1); }

const wiki = fs.readFileSync(wikiPath, "utf8");
const src = fs.readFileSync(doctorTs, "utf8");

const start = wiki.indexOf("## 检查项");
const end = wiki.indexOf("### 历史 / 未实现");
if (start < 0 || end < 0 || end <= start) {
  console.error("[doctor-docs] FAIL: WIKI 结构变了（找不到「## 检查项」或「### 历史 / 未实现」）—— gate 需同步");
  process.exit(1);
}
const claimed = new Set();
for (const line of wiki.slice(start, end).split("\n")) {
  const m = line.match(/^\|\s*`([a-z][a-z0-9-]+)`/);   // 表格行首列的检查名
  if (m) claimed.add(m[1]);
}
const implemented = new Set();
for (const m of src.matchAll(/(?:ok|fail|warn|skip)\(\s*'([a-z][a-z0-9-]+)'/g)) implemented.add(m[1]);

if (claimed.size === 0 || implemented.size === 0) {
  console.error(`[doctor-docs] FAIL: 解析结果异常（WIKI 声称 ${claimed.size} 项 / 代码实现 ${implemented.size} 项）`);
  process.exit(1);
}
const missingImpl = [...claimed].filter((x) => !implemented.has(x)).sort();
const missingDoc = [...implemented].filter((x) => !claimed.has(x)).sort();

console.log(`[doctor-docs] WIKI 声称 ${claimed.size} 项 / doctor.ts 实现 ${implemented.size} 项`);
let bad = 0;
if (missingImpl.length) {
  console.error(`  FAIL  WIKI 写了但代码里没有: ${missingImpl.join(", ")}`);
  console.error(`        → 要么实现它，要么从「检查项」表挪到「历史 / 未实现」段（别只写文档）`);
  bad++;
}
if (missingDoc.length) {
  console.error(`  FAIL  代码实现了但 WIKI 没写: ${missingDoc.join(", ")}`);
  console.error(`        → 在「## 检查项」对应小节补一行（表格格式：| \`名字\` | 说明 |）`);
  bad++;
}
if (bad) { console.error("[doctor-docs] FAIL: Doctor 文档与代码漂移"); process.exit(1); }
console.log("[doctor-docs] PASS — WIKI 的检查项表与 doctor.ts 完全一致");
