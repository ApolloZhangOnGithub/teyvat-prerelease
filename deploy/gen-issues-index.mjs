#!/usr/bin/env node
// gen-issues-index.mjs — 生成 Issues/Top-Level/Issues.INDEX
// 用法: node gen-issues-index.mjs
// 规则: 每个 .ISSUE 文件尾部 "status: xxx" 决定分区（open/deferred/partially-complete/resolved/closed）；
//       无 status 行的旧文件继承现有索引中的分区；摘要沿用现有索引（若有），否则取标题。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "B.docs", "Dev.Common", "Issues", "Top-Level");
const indexPath = join(dir, "Issues.INDEX");

const SECTION = {
  open: ["打开", "## 打开"],
  deferred: ["待触发", "## 待触发"],
  "partially-complete": ["部分完成", "## 部分完成"],
  resolved: ["已解决", "## 已解决"],
  closed: ["关闭", "## 关闭"],
  unconfirmed: ["待确认", "## 待确认"], // 仅继承旧索引，无对应 status 值
};

// 读取现有索引：number → { section, summary }
const oldMap = new Map();
try {
  const old = readFileSync(indexPath, "utf8");
  let cur = "open";
  for (const line of old.split("\n")) {
    const h = line.match(/^## .+$/);
    if (h) {
      const name = h[0].replace("## ", "").replace(/ \(.*$/, "");
      for (const [k, [label]] of Object.entries(SECTION)) {
        if (name.includes(label)) cur = k;
      }
      continue;
    }
    const m = line.match(/^- \[(\d{3})\]\(([^)]+)\.ISSUE\)(.*)$/);
    if (m) oldMap.set(parseInt(m[1]), { section: cur, summary: m[3].replace(/^ — /, "") });
  }
} catch {}

const entries = [];
for (const f of readdirSync(dir)) {
  const m = basename(f).match(/^(\d{3})-(.+)\.ISSUE$/);
  if (!m) continue;
  const num = parseInt(m[1]);
  const text = readFileSync(join(dir, f), "utf8");
  const st = text.match(/^status:\s*(\S+)/m);
  let status = null;
  if (st) {
    const s = st[1].trim();
    status = s === "部分完成" ? "partially-complete" : s;
    if (!SECTION[status]) status = "open";
  }
  const titleLine = text.split("\n").find((l) => l.startsWith("#")) || f;
  const title = titleLine
    .replace(/^#\s*(ISSUE:\s*)?/, "")
    .replace(/^\[\d{3}\]\s*/, "")
    .replace(/^\d{3}\s*[—-]\s*/, "")
    .replace(/\.ISSUE$/, "")
    .slice(0, 80);
  const old = oldMap.get(num);
  entries.push({ num, file: f, status: status || old?.section || "open", summary: old?.summary || title });
}
entries.sort((a, b) => a.num - b.num);

const bySection = {};
for (const [k, [label]] of Object.entries(SECTION)) bySection[k] = { label, items: [] };
for (const e of entries) bySection[e.status].items.push(e);
// 打开区数字降序（最新的在最上面），其余升序
for (const [k, v] of Object.entries(bySection)) {
  v.items.sort((a, b) => (k === "open" ? b.num - a.num : a.num - b.num));
}

const counts = Object.fromEntries(Object.entries(bySection).map(([k, v]) => [k, v.items.length]));
const total = entries.length;
const stats = `**打开 ${counts.open} · 已解决 ${counts.resolved} · 关闭 ${counts.closed} · 部分完成 ${counts["partially-complete"]} · 待确认 ${counts.unconfirmed} · 待触发 ${counts.deferred} · 共 ${total}**`;

const lines = [];
lines.push("# teyvat ISSUES — 索引");
lines.push("");
lines.push("_自动生成（C.deploy/gen-issues-index.mjs），别手改。_");
lines.push("");
lines.push(stats);
lines.push("");
for (const [k, v] of Object.entries(bySection)) {
  if (v.items.length === 0) continue;
  lines.push(`## ${v.label} (${v.items.length})`);
  for (const e of v.items) {
    lines.push(`- [${String(e.num).padStart(3, "0")}](${e.file}) — ${e.summary}`);
  }
  lines.push("");
}
writeFileSync(indexPath, lines.join("\n"));
console.log(`Issues.INDEX regenerated: ${total} 条（打开 ${counts.open} / 部分完成 ${counts["partially-complete"]} / 已解决 ${counts.resolved} / 关闭 ${counts.closed} / 待确认 ${counts.unconfirmed} / 待触发 ${counts.deferred}）`);
