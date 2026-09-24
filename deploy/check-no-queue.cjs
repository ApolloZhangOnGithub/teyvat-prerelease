#!/usr/bin/env node
// check-no-queue.cjs — 「除 social queue 外，任何地方用 queue 都 make error」门禁
// 2026-09-25（用户：直接在 make 中检查，除了 social queue，其他任何多使用了 queue 都 make 时直接 error）
//
// 为什么：system 提示一律 interrupt（立即打断，同用户输入优先级）。queue（轮后送达）只允许
// 在 social 消息投递（接收方 focus 降级 / mode=queue）里出现；其他任何 sendCustomMessage 的
// deliverAs 或消息类型 feedAs 用 queue 都是错的（会让通知延迟、跟着用户消息才出来）。
//
// 用法: node C.deploy/check-no-queue.cjs [A.core 路径]

const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));

// 允许 queue 的文件（social 投递层）
const ALLOW_FILES = [
  /social\.communicate[\\/]communicate\.ts$/,
  /kernel\.backbone[\\/]backbone\.ts$/,
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|cjs|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const RE = /(?:deliverAs|feedAs)\s*:\s*["'`]queue["'`]/;
const hits = [];
for (const f of walk(core)) {
  if (ALLOW_FILES.some((r) => r.test(f))) continue;
  let txt;
  try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
  txt.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (RE.test(line)) hits.push(`${path.relative(core, f)}:${i + 1}  ${t.slice(0, 100)}`);
  });
}

if (hits.length) {
  console.error("[no-queue] FAIL: 除 social queue 外不允许用 queue（system 提示须 interrupt）：");
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log("[no-queue] PASS — 除 social queue 外无 queue 用法（system 提示一律 interrupt）");
