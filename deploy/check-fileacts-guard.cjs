#!/usr/bin/env node
// check-fileacts-guard.cjs — fileacts 权限守卫（他人数据目录）的对抗性回归测试
// 2026-09-11 prime-agent
//
// 背景：fileacts 的 validateExecute() 禁止 agent 触碰**其他人**的数据目录（MemoryData/SessionData/LogData…）。
// 2026-09-11 用真实函数跑对抗用例，实测出三个绕过（对非 root agent）：
//   ① 绝对路径 `/Users/<user>/.teyvat/...` —— 守卫只认 `~/` 与 `$HOME/` 写法
//   ② 命令里同时出现"自己的目录 + 他人的目录" —— 命中自己 id 就整条放行
//   ③ 夹带 `AppData/shared` —— 命中 shared 就整条放行
// 三个都已在同日修掉（归一化 home + 先抽全部 id、有外来 id 就拦）。
// 本门禁把这 14 个用例固化成回归测试：**既防绕过复活，也防"一律拦截"把正常用法打死**。
//
// 用法: node C.deploy/check-fileacts-guard.cjs [A.core 路径]（已接进 Makefile _integrity）
// 说明：需要 node 支持 --experimental-strip-types（>=22.6）；不支持时动态部分 SKIP，静态部分仍拦截。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const guardFile = path.join(core, "spirit.bio.organs/hands.fileacts/fileacts.ts");
if (!fs.existsSync(guardFile)) { console.error("[fileacts-guard] FAIL: 找不到 " + guardFile); process.exit(1); }
const src = fs.readFileSync(guardFile, "utf8");

// ── 静态：三处修复的特征必须在（防被回退/删掉）──
const statics = [
  ['home 归一化（绝对路径绕过）', /cmd\.split\(_home\)\.join\("~"\)/],
  ['外来 id 优先判定（自己+他人混条绕过）', /const foreign = \[\.\.\.ids\]\.filter/],
  ['shared 仅在无外来 id 时放行', /foreign\.length === 0\)\s*\{/],
];
let staticBad = 0;
console.log("[fileacts-guard] 静态检查：");
for (const [name, re] of statics) {
  const ok = re.test(src);
  if (!ok) staticBad++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
}
if (staticBad) { console.error("[fileacts-guard] FAIL: 守卫的防绕过逻辑缺失（被回退？）"); process.exit(1); }

// ── 动态：真实函数跑 14 个用例 ──
const cases = [
  ["ls 当前目录", "ls -la", true],
  ["读源码", "cat spirit.bio.organs/kernel.heart/heart.ts | head -20", true],
  ["跑脚本", "node god.frontend.cli/list.cjs", true],
  ["make 部署（豁免）", "make dev-minutely committer='x' msg='yyyyyyyyyy' detail='zzzzzzzzzzzzzzzzzzzz'", true],
  ["trash 临时文件", "trash /tmp/foo", true],
  ["git 操作", "git status --porcelain", true],
  ["自己 LogData（~）", "cat ~/.teyvat/LogData/__SELF__/console.log | tail -5", true],
  ["自己 LogData（绝对路径）", "cat __HOME__/.teyvat/LogData/__SELF__/console.log | tail -5", true],
  ["AppData/shared", "ls ~/.teyvat/AppData/shared/", true],
  ["自己 + shared 同时", "ls ~/.teyvat/AppData/shared/ && cat ~/.teyvat/MemoryData/__SELF__/context.md", true],
  ["他人 LogData（~）", "cat ~/.teyvat/LogData/__OTHER__/console.log", false],
  ["他人 MemoryData（绝对路径）", "cat __HOME__/.teyvat/MemoryData/__OTHER__/context.md", false],
  ["他人 + shared 混条", "ls ~/.teyvat/AppData/shared/; cat ~/.teyvat/MemoryData/__OTHER__/context.md", false],
  ["自己 + 他人 混条", "cat ~/.teyvat/MemoryData/__SELF__/x; cat ~/.teyvat/MemoryData/__OTHER__/context.md", false],
];
// 取一个非 root 的 selfId（root 的本来就全放行，测不出守卫）
let self = "aaaaaaaa", other = "bbbbbbbb";
try {
  const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".teyvat/config/authorize.json"), "utf8"));
  const nonRoot = Object.entries(auth.agents || {}).filter(([, v]) => !v.root).map(([k]) => k);
  if (nonRoot.length >= 2) { self = nonRoot[0]; other = nonRoot[1]; }
  else if (nonRoot.length === 1) { self = nonRoot[0]; other = "00000000"; }
} catch { /* 无 authorize.json：用占位 id，守卫仍应拦"他人目录" */ }

const probe = `
import { validateExecute } from ${JSON.stringify(guardFile)};
const CASES = ${JSON.stringify(cases.map(([n, c, e]) => [n, c, e]))};
const SELF = ${JSON.stringify(self)}, OTHER = ${JSON.stringify(other)}, HOME = ${JSON.stringify(os.homedir())};
let fails = 0;
for (const [name, raw, expectAllow] of CASES) {
  const cmd = raw.split("__SELF__").join(SELF).split("__OTHER__").join(OTHER).split("__HOME__").join(HOME);
  let blocked, err = "";
  try { blocked = validateExecute(cmd, SELF).blocked; } catch (e) { err = String(e && e.message || e); blocked = false; }
  const ok = !err && (expectAllow ? !blocked : blocked);
  if (!ok) fails++;
  console.log(\`\${ok ? "OK  " : "FAIL"} \${blocked ? "BLOCKED" : "ALLOWED "} | \${name}\${err ? " | THROW:" + err : ""}\`);
}
console.log("FAILS=" + fails);
`;
const probePath = path.join(os.tmpdir(), "fileacts-guard-probe-" + process.pid + ".ts");
fs.writeFileSync(probePath, probe);
let out = "", skipped = false;
const runProbe = () => execFileSync(process.execPath, ["--experimental-strip-types", probePath], { encoding: "utf8", timeout: 60000 });
try {
  out = runProbe();
} catch (e) {
  const msg = String(e.stderr || e.message);
  if (/strip-types|Unknown option|bad option/i.test(msg)) skipped = true;
  else if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(msg) && !/\/A\.core\//.test(msg)) {
    // 部署窗口：别的构建正在跑 install.sh（rsync --delete + patch），此刻从线上 runtime 解析模块会缺文件
    // —— 属 ISSUE 148 那个"rsync 非原子窗口"，不是本仓库代码坏了 → SKIP（静态检查已通过）。
    // 但若缺的是 A.core 内部的模块，那就是真坏 → 继续 FAIL。
    // 先等 5 秒重试一次（并发构建的部署窗口通常几秒就过去），仍失败才 SKIP
    try {
      execFileSync("sleep", ["5"]);
      out = runProbe();
    } catch {
      skipped = true;
      console.log("[fileacts-guard] SKIP 动态用例：命中部署窗口（线上 runtime 模块暂时缺失，已重试一次）——" + msg.split("\n")[0].slice(0, 120));
    }
  } else { console.error("[fileacts-guard] FAIL: 探针执行失败: " + msg.split("\n").slice(0, 3).join(" / ")); process.exit(1); }
} finally { try { fs.unlinkSync(probePath); } catch { /* 清理失败无所谓 */ } }

if (skipped) {
  console.log("[fileacts-guard] SKIP 动态用例：本机 node 不支持 --experimental-strip-types（静态检查已通过）");
  console.log("[fileacts-guard] PASS（静态）");
  process.exit(0);
}
console.log(`[fileacts-guard] 动态用例（非 root self = ${self} / other = ${other}）：`);
for (const line of out.trim().split("\n")) if (!line.startsWith("FAILS=")) console.log("  " + line);
const fails = parseInt((out.match(/FAILS=(\d+)/) || [])[1] || "0", 10);
if (fails) { console.error(`[fileacts-guard] FAIL: ${fails} 个用例不符合预期（绕过复活或误拦正常用法）`); process.exit(1); }
console.log("[fileacts-guard] PASS — 3 类绕过已堵、正常用法零误伤");
