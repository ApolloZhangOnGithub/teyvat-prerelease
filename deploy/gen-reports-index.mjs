#!/usr/bin/env node
// gen-reports-index.mjs — 生成 Reports/Reports.INDEX（2026-09-11 prime-agent 补）
//
// 为什么补：Reports.INDEX 头部一直写着「_自动生成，别手改。_」，但仓库里**没有对应的生成器**
// （全仓 grep 无引用），于是它实际上是手工维护的 —— 声称自动生成却要手改，是典型的"文档-现实不一致"。
// 本脚本按 gen-issues-index.mjs 同款思路：扫目录里的 *.REPORT，分组与摘要**继承旧索引**（人工写的那部分不丢）。
//
// 用法: node C.deploy/gen-reports-index.mjs

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "B.docs", "Dev.Common", "Reports");
const indexPath = join(dir, "Reports.INDEX");

// 旧索引：文件名 → { group, summary }；同时保留"非报告条目"（例如目录链接 📁 testor-raw-docs/）
// —— 那类是人工写的说明行，生成器必须原样带过去，否则每次生成都会丢东西（2026-09-11 实测丢过一次）。
const oldMap = new Map();
const extras = new Map();     // group → [原样保留的行]
const groupOrder = [];
let curGroup = "📋 调查报告";
try {
  for (const line of readFileSync(indexPath, "utf8").split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) { curGroup = h[1].trim(); if (!groupOrder.includes(curGroup)) groupOrder.push(curGroup); continue; }
    const m = line.match(/^-\s*\[(\d+)\]\(([^)]+)\)\s*—\s*(.*)$/);
    if (m && m[2].endsWith(".REPORT")) { oldMap.set(m[2], { group: curGroup, summary: m[3].trim() }); continue; }
    if (/^-\s/.test(line.trim()) && line.trim()) {   // 其它条目（目录链接等）→ 原样保留
      if (!extras.has(curGroup)) extras.set(curGroup, []);
      extras.get(curGroup).push(line.trimEnd());
      if (!groupOrder.includes(curGroup)) groupOrder.push(curGroup);
    }
  }
} catch { /* 首次生成：无旧索引 */ }

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".REPORT"))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

const groups = new Map();
for (const f of files) {
  const num = parseInt(f, 10);
  const prev = oldMap.get(f);
  let summary = prev?.summary || "";
  if (!summary) {
    // 新报告：取第一行 `# 标题` 作为摘要
    try {
      const first = readFileSync(join(dir, f), "utf8").split("\n").find((l) => l.startsWith("# "));
      summary = first ? first.replace(/^#\s*/, "").trim() : f;
    } catch { summary = f; }
  }
  // 新报告可以在首部写 `> group: 🧭 待决策` 自报分组（否则默认「📋 调查报告」）
  let selfGroup = "";
  try {
    const head = readFileSync(join(dir, f), "utf8").split("\n").slice(0, 6).find((l) => /^>?\s*group\s*[:：]/.test(l));
    if (head) selfGroup = head.replace(/^>?\s*group\s*[:：]\s*/, "").trim();
  } catch { /* 读不到就用默认分组 */ }
  const g = prev?.group || selfGroup || "📋 调查报告";
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(`- [${String(num).padStart(3, "0")}](${f}) — ${summary}`);
}

const out = ["# teyvat REPORTS — 索引", "", "_自动生成（C.deploy/gen-reports-index.mjs），别手改。_", "",
             `**共 ${files.length}**`, ""];
for (const g of [...groupOrder, ...[...groups.keys()].filter((k) => !groupOrder.includes(k))]) {
  const lines = groups.get(g) || [];
  const ex = extras.get(g) || [];
  if (!lines.length && !ex.length) continue;
  out.push(`## ${g}`, "", ...lines, ...ex, "");
}
writeFileSync(indexPath, out.join("\n").replace(/\n+$/, "\n"));
console.log(`Reports.INDEX regenerated: ${files.length} 条（${[...groups.keys()].length} 组）`);
