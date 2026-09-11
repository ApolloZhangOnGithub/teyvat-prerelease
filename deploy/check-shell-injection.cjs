#!/usr/bin/env node
// check-shell-injection.cjs — 禁止把"外部输入"拼进 shell 字符串
// 2026-09-11 prime-agent
//
// 背景：同一天发现两处真注入面 + 一处脆弱点：
//   ① `universe.infotech/local.mobile/apps/amap/amap.ts`：`execSync(`python3 ${SCRIPT} ${cmd}`)` —— cmd 是 agent 通过
//      mobile 工具传进来的文本，**未加引号**、且这条路径**不经过** validateExecute → 等于绕过了"禁 rm / 禁碰他人数据目录"；
//   ② `god.frontend.cli/cli.ts` 的 `cmdNote`：`execSync(`node <note.cjs> <id> <JSON.stringify(msg)>`)` ——
//      JSON 的双引号挡不住 `$()` 与反引号展开，id 也未加引号；
//   ③ 同文件 spawn dev 的 `execSync(`node ${devCli} ${mode} ${id} ${pname}`)`（此刻 id/pname 受校验，但上游放宽即变注入面）。
// 三处已改为 `execFileSync`/`spawnSync` + **argv 数组**（完全不经 shell）。
//
// 判定：`execSync` / `exec`（会走 shell 的形式）的**模板字符串**里，如果插值的是"外部输入语义"的变量名
//   （params./args./msg/message/input/text/cmd/command/body/payload/name/pname/query/keyword…）→ FAIL。
//   允许：常量/内部变量（path、dir、tn、devCli、SCRIPT…）与"先 JSON.stringify 再拼"以外的写法——
//   判断不了就报出来让人看一眼，比漏过去强。
// 豁免：该行或上一行有 `// shell-ok:` 注释（写明理由）。
//
// 用法: node C.deploy/check-shell-injection.cjs [A.core 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const EXT = new Set([".ts", ".js", ".cjs", ".mjs"]);
const EXT_VAR = /\$\{\s*(?:[A-Za-z_$][\w$]*\.)?(params|args|msg|message|input|text|cmd|command|body|payload|query|keyword|name|pname|userInput|raw)\b/;
const SHELL_EXEC = /\b(execSync|exec)\s*\(/;

const files = [];
const walk = (d) => {
  let items = [];
  try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name === "node_modules" || it.name === ".git") continue;
    const full = path.join(d, it.name);
    if (it.isDirectory()) walk(full);
    else if (EXT.has(path.extname(it.name))) files.push(full);
  }
};
walk(core);

const hits = [];
let scanned = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!SHELL_EXEC.test(line)) return;
    if (/^\s*(\/\/|\*|#)/.test(line)) return;         // 注释行（说明历史写法）不算
    scanned++;
    // 只看 exec/execSync 的**那一个模板字符串**：同一行后面的别的模板串（日志文案）不该算进来
    const m = line.match(/(?:execSync|exec)\s*\(\s*`((?:[^`\\]|\\.)*)`/);
    if (!m) return;
    if (!EXT_VAR.test(m[1])) return;
    if (/shell-ok:/.test(line) || /shell-ok:/.test(lines[i - 1] || "")) return;
    hits.push(`${path.relative(core, f)}:${i + 1}  ${line.trim().slice(0, 120)}`);
  });
}
console.log(`[shell-injection] 扫 ${files.length} 个文件、${scanned} 处 exec/execSync 调用`);
if (hits.length) {
  for (const h of hits) console.error(`  FAIL  ${h}`);
  console.error(`[shell-injection] FAIL: ${hits.length} 处 shell 字符串里插值了外部输入 —— 改用 execFileSync/spawnSync + argv 数组（不经 shell）`);
  console.error("        确属安全的（值已被严格校验/就是常量）在该行加注释 `// shell-ok: 理由`");
  process.exit(1);
}
console.log("[shell-injection] PASS — 没有把外部输入拼进 shell 字符串的调用");
