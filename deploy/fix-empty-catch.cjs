#!/usr/bin/env node
// fix-empty-catch.cjs — 批量修复空 catch {}（静默吞错反模式，LESSON 024）
// 用法: node fix-empty-catch.cjs [--apply]
//   默认 dry-run：统计空 catch{} 位置（不修改）
//   --apply：实际给空 catch{} 加日志，自动 .bak 备份
// 背景（2026-08-20）：用户指出空 catch 静默吞错是系统性问题（392 处）。
//   配合启动检查器（check-empty-catch 集成 core.ts 启动，任何文件空 catch 拒绝启动）一起根治。
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "A.core");
const APPLY = process.argv.includes("--apply");

const DIRS = ["god.frontend.tui", "spirit.bio.organs", "god.frontend.cli"];
const EXCLUDE = ["node_modules", ".bak", ".REMOVED"];

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.some(x => dir.includes(x) || ent.name.includes(x))) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (/\.(js|ts|cjs|mjs)$/.test(ent.name)) yield p;
  }
}

// 匹配空 catch 块：catch {} / catch { } / catch (e) { }（块内仅空白）
const RE_EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

let total = 0;
const reports = [];
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, "utf8");
  const matches = [...src.matchAll(RE_EMPTY_CATCH)];
  if (matches.length === 0) continue;
  total += matches.length;
  reports.push({ file, count: matches.length, lines: matches.map(m => {
    const upTo = src.slice(0, m.index);
    return upTo.split("\n").length;
  }) });

  if (APPLY) {
    const bak = file + ".bak-fixcatch";
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, src);
    const fixed = src.replace(RE_EMPTY_CATCH, (m) => {
      const varMatch = /^catch\s*\(\s*(\w+)\s*\)/.exec(m);
      const v = varMatch ? varMatch[1] : "e";
      const rel = path.relative(ROOT, file);
      return `catch (${v}) { console.error("[${rel}] " + (${v}?.message || ${v})); }`;
    });
    fs.writeFileSync(file, fixed);
  }
}

console.log(`空 catch{} 总数: ${total}${APPLY ? "（已修复，备份 .bak-fixcatch）" : ""}`);
if (!APPLY) {
  console.log("分布（前 15 个文件）:");
  reports.slice(0, 15).forEach(r => console.log(`  ${r.file.replace(ROOT + "/", "")}: ${r.count} 处（行 ${r.lines.join(",")}）`));
} else {
  console.log("已处理文件数:", reports.length);
}
