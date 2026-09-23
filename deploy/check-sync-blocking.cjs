#!/usr/bin/env node
// check-sync-blocking.cjs — agent 运行时工具里禁止同步子进程调用（execSync / execFileSync / spawnSync）
// 2026-09-24（用户定稿）：非异步方法全禁——同步子进程调用会阻塞事件循环（每次 spawn 都卡住 agent loop）。
//   历史踩坑：syntaxCheck 曾用 execSync（bun build ~1s 卡死每次 edit/write）、OCR 探测曾用 execFileSync（15s）、
//   fileacts xattr 曾用 execFileSync（2s timeout）。这些是"快返回假象 + 等 wait 才回"的同一类根源。
//
// 范围：spirit.bio.organs + spirit.bio.abilities（agent 的工具/能力，模型可调，跑在 agent loop 里）。
// 排除：@ABANDONED.* 目录（死代码）、node_modules、CLI（god.frontend.cli，一次性命令不在 agent loop）。
//
// 用法: node C.deploy/check-sync-blocking.cjs [A.core 路径]（已接 Makefile _integrity）
const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const ROOTS = ["spirit.bio.organs", "spirit.bio.abilities"];
const CALL = /\b(execSync|execFileSync|spawnSync)\s*\(/;

// 去掉 // 行注释 + /* */ 块注释（只剥注释，保留代码；块注释里的历史 execSync 不算）
function stripComments(src) {
  let out = "";
  let i = 0, inBlock = false;
  while (i < src.length) {
    if (inBlock) {
      if (src[i] === "*" && src[i + 1] === "/") { inBlock = false; i += 2; }
      else i++;
    } else {
      if (src[i] === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; }
      else if (src[i] === "/" && src[i + 1] === "*") { inBlock = true; i += 2; }
      else { out += src[i]; i++; }
    }
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    if (e.isDirectory()) {
      if (e.name.startsWith("@ABANDONED")) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".js")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

let bad = 0;
const files = [];
for (const r of ROOTS) {
  const d = path.join(core, r);
  if (fs.existsSync(d)) walk(d, files);
}
console.log("[sync-blocking] 扫描 agent 工具里的同步子进程调用（execSync/execFileSync/spawnSync）：");
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const stripped = stripComments(src);
  stripped.split("\n").forEach((l) => {
    if (CALL.test(l)) {
      bad++;
      console.error(`  FAIL  ${path.relative(core, f)} — ${l.trim().slice(0, 100)}`);
    }
  });
}
if (bad) {
  console.error(`[sync-blocking] FAIL: ${bad} 处同步子进程调用 — 改成异步 execFile/execFileAsync（不阻塞事件循环）`);
  process.exit(1);
}
console.log("[sync-blocking] PASS — agent 工具无同步子进程调用");
