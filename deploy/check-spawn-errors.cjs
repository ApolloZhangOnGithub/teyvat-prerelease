#!/usr/bin/env node
// check-spawn-errors.cjs — 凡是 child_process.spawn() 都必须挂 'error' 监听
// 2026-09-11 prime-agent：
//   Node 的 spawn 失败（ENOENT 等）走的是**异步 'error' 事件**；没有监听 → "Unhandled 'error' event"
//   → 未捕获异常（实测 exit=1）。本仓自己的注释记过这条链：
//     「uncaughtException → SDK uncaughtCrash → process.exit(1) → 进程闪退」
//   实测到的真实场景：bun 未安装时 `spawn("bun", …)`。ears.ts 的 BUN 在 `which bun` 失败时**回落成字面量 "bun"**，
//   bioclock 的每日备份更是**每次 agent 启动**就 spawn("bun") → 没装 bun 的机器一启动就闪退。
//
// 用法: node C.deploy/check-spawn-errors.cjs [A.core 路径]（已接 Makefile _integrity）
const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const SP_IMPORT = /from\s+["']node:child_process["']|require\(["']node:child_process["']\)/;
const CALL = /(?<![\w.#])(_?spawn)\s*\(/;         // 排除 this.spawn( / #spawn( / spawnSync(
const HAS_ERR = /\.(on|once)\(\s*["']error["']/;
const WINDOW = 30;                                 // 调用点后 30 行内出现 error 监听即算覆盖
const EXTRA = [
  // [文件相对路径, 必须存在的字符串, 说明]
  ["spirit.bio.organs/head.ears/ears.ts", "录音进程启动失败", "bun 缺失时给出可读原因"],
  ["spirit.bio.organs/brain.bioclock/bioclock.ts", 'last: ""', "备份 spawn 失败要把\"今天已处理\"清掉，否则整天不再重试"],
  ["spirit.bio.organs/brain.bioclock/bioclock.ts", "每日备份 spawn 失败", "备份 spawn 失败要留日志"],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

let bad = 0, checked = 0;
const files = walk(core);
console.log("[spawn-errors] 扫描 child_process.spawn 调用点：");
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  if (!SP_IMPORT.test(src)) continue;
  const lines = src.split("\n");
  lines.forEach((l, i) => {
    if (!CALL.test(l) || /spawnSync/.test(l)) return;
    checked++;
    const ctx = lines.slice(i, i + WINDOW).join("\n");
    if (!HAS_ERR.test(ctx)) {
      bad++;
      console.error(`  FAIL  ${path.relative(core, f)}:${i + 1} — spawn 后 ${WINDOW} 行内没有 .on("error") 监听`);
      console.error(`        ${l.trim().slice(0, 110)}`);
    }
  });
}
console.log(`  调用点 ${checked} 个，全部挂了 error 监听（或已登记）`);
for (const [rel, needle, why] of EXTRA) {
  const p = path.join(core, rel);
  const ok = fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(needle);
  if (!ok) bad++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${rel} 含 ${JSON.stringify(needle)}（${why}）`);
}
if (bad) { console.error(`[spawn-errors] FAIL: ${bad} 项`); process.exit(1); }
console.log("[spawn-errors] PASS — spawn 失败不会再以未捕获 'error' 把 agent 打闪退");
