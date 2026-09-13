#!/usr/bin/env node
// teyvat 构建门禁：execute 渲染管线的结构约束（ISSUE 226，2026-09-13）
// 背景：execute 的显示逻辑曾散在 5 个文件——尾标签剥离正则 5 套不等价、"⎿  " 硬编码 5 处绕过 WSL 回退、
// 耗时格式器 6 个、cmd-done 把结构化数据格式化成文本再用正则反解析、渲染时取 Date.now() 让历史行随心跳重渲染漂移。
// 收口后（blocks_nongod.js 是唯一入口），本门禁防止它们再长回来：
//   R1 尾标签正则（[id:] [remaining:] [background:] [result N tokens] [HH:MM:SS…]）只允许出现在 blocks_nongod.js
//   R2 execute 渲染函数体内禁止 Date.now() / new Date()（时刻必须来自事件数据：details.endTs / createdInfo.ts / message.timestamp）
//   R3 折线符号 "⎿" 字面量只允许出现在 blocks_nongod.js 的 SYM 定义（其余一律 SYM.result）
//   R4 executes.ts 每一处 continuous-cmd-done 发送都必须带 status:（结构化 details，渲染器不再反解析文本）
//   R5 "Done in" / "Created N … process" 摘要行只能由 blocks_nongod.renderExecuteResult 生成
// 用法: node C.deploy/check-execute-render.cjs [A.core 路径]
const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const OWNER = path.join("god.frontend.tui", "ui_elements", "blocks_nongod.js");
const problems = [];
const ok = (msg) => console.log(`  OK    ${msg}`);
const fail = (msg) => { problems.push(msg); console.log(`  FAIL  ${msg}`); };

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name.startsWith(".")) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // pi-tui 上游覆盖层不含 teyvat 的标签/折线逻辑，跳过（其余 overrides 如 tool-execution.js 要查）
      if (p.includes(path.join("overrides", "pi-tui"))) continue;
      walk(p, out);
    } else if (/\.(ts|js)$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(p);
  }
}
const files = [];
walk(core, files);
const rel = (p) => path.relative(core, p);
const stripComment = (line) => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/(?!\/).*$/, "");

// R1 尾标签正则归属
{
  const TAG = /\\\[(?:id|remaining|background|result\\s|\\d\{2\}:)/;
  let hits = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((raw, i) => {
      if (/^\s*(\/\/|\*)/.test(raw) || raw.includes("tag-regex-allow")) return;
      const segs = stripComment(raw).match(/\/(?:[^\/\n\\]|\\.)+\/[gimsuy]*/g) || [];
      for (const s of segs) {
        if (TAG.test(s)) {
          hits++;
          if (rel(f) !== OWNER) fail(`R1 尾标签正则出现在 ${rel(f)}:${i + 1}（只允许 blocks_nongod.js；用 stripResultTokenMark / stripInlineBgTag / extractBioclockTag）`);
        }
      }
    });
  }
  if (hits === 0) fail("R1 零匹配——连 blocks_nongod.js 里都没找到尾标签正则，检查失效");
  else if (!problems.some((p) => p.startsWith("R1"))) ok(`R1 尾标签正则只在 blocks_nongod.js（${hits} 处）`);
}

// R2 渲染函数体内无渲染时刻
{
  const targets = [
    { file: path.join("spirit.bio.organs", "hands.executes", "executes.ts"), start: /^\s*renderResult\(/m },
    { file: path.join("god.frontend.tui", "renderers.ts"), start: /registerMessageRenderer\("continuous-cmd-done"/ },
    { file: OWNER, start: /^export function renderExecuteResult/m },
  ];
  let checked = 0;
  for (const t of targets) {
    const p = path.join(core, t.file);
    if (!fs.existsSync(p)) { fail(`R2 目标文件不存在: ${t.file}`); continue; }
    const src = fs.readFileSync(p, "utf8");
    const m = src.match(t.start);
    if (!m) { fail(`R2 找不到入口: ${t.file} ${t.start}`); continue; }
    // 从入口后的第一个 { 起按花括号配对截出函数体
    let i = src.indexOf("{", m.index);
    let depth = 0, end = -1;
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) { fail(`R2 花括号不配对: ${t.file}`); continue; }
    const body = src.slice(i, end + 1).split("\n").map(stripComment).join("\n");
    checked++;
    if (/Date\.now\(\)|new Date\(\s*\)/.test(body)) fail(`R2 ${t.file} 的 execute 渲染函数体里有 Date.now()/new Date()（时刻必须来自事件数据，LESSON 094）`);
  }
  if (checked === 3 && !problems.some((p) => p.startsWith("R2"))) ok("R2 三个 execute 渲染函数体内无 Date.now()/new Date()");
}

// R3 "⎿" 字面量归属
{
  let bad = 0;
  for (const f of files) {
    if (rel(f) === OWNER) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((raw, i) => {
      if (/^\s*(\/\/|\*)/.test(raw) || raw.includes("sym-allow")) return;
      const code = stripComment(raw);
      if (/["'`][^"'`]*⎿/.test(code)) { bad++; fail(`R3 硬编码 "⎿" 在 ${rel(f)}:${i + 1}（改用 SYM.result，WSL 才有 ASCII 回退）`); }
    });
  }
  if (bad === 0) ok("R3 折线符号只在 blocks_nongod.js 的 SYM 定义");
}

// R4 cmd-done 发送带结构化 status
{
  const p = path.join(core, "spirit.bio.organs", "hands.executes", "executes.ts");
  const lines = fs.readFileSync(p, "utf8").split("\n");
  let n = 0, bad = 0;
  lines.forEach((raw, i) => {
    if (/^\s*\/\//.test(raw)) return;
    if (/(?:outboxSend|sendCustomMessage)\([^\n]*"continuous-cmd-done"/.test(raw)) {
      n++;
      if (!/status:\s*"(?:done|failed|timeout|terminated)"/.test(raw)) { bad++; fail(`R4 executes.ts:${i + 1} 的 cmd-done 发送没带 status:（渲染器要读结构化 details）`); }
    }
  });
  if (n === 0) fail("R4 零匹配——executes.ts 里没找到 cmd-done 发送点，检查失效");
  else if (bad === 0) ok(`R4 executes.ts 的 ${n} 处 cmd-done 发送都带结构化 status`);
}

// R5 摘要行只能由 renderExecuteResult 生成
{
  let bad = 0;
  for (const f of files) {
    if (rel(f) === OWNER) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((raw, i) => {
      if (/^\s*(\/\/|\*)/.test(raw)) return;
      const code = stripComment(raw);
      if (/["'`][^"'`]*\bDone in \$\{|["'`][^"'`]*\bCreated \$\{[^}]*\} (?:bash|terminal|\$\{)/.test(code)) { bad++; fail(`R5 ${rel(f)}:${i + 1} 自己拼 Done in/Created 摘要行（只能走 renderExecuteResult）`); }
    });
  }
  if (bad === 0) ok("R5 Done in / Created 摘要行只由 renderExecuteResult 生成");
}

if (problems.length) {
  console.error(`[execute-render] FAIL — ${problems.length} 项，见 check-execute-render.cjs.SPEC / ISSUE 226`);
  process.exit(1);
}
console.log(`[execute-render] PASS — 扫 ${files.length} 个文件，5 项约束全部满足`);
