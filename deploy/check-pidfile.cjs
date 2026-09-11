#!/usr/bin/env node
// check-pidfile.cjs — main.pid 完整性门禁（ISSUE 182：0 字节 pid 文件 → 活跃判定失效 → 双实例）
// 2026-09-11 prime-agent
//
// 为什么需要：main.pid 有三类消费者（列表/launcher 的活跃判定、cli.ts 的"已在运行"守卫、heart 心跳），
// 一旦内容损坏（0 字节）就会：读者判"离线"（序号/分组错乱）+ 守卫放行（启动第二个实例）。
// 线上实测过：check-session-01（379e262b）按 2 天、main.pid 0 字节、同 sid 两个实例。
//
// 做法（fail-closed）：从**真实源码**里抽出两段逻辑跑夹具，而不是复述规则：
//   1) cli.ts 的启动守卫：空内容+心跳新鲜 → 必须拒绝启动；空内容+心跳陈旧 → 允许启动（残留文件）；
//      合法且存活的 pid → 拒绝；合法但已死的 pid → 允许
//   2) heart.ts 的心跳"内容自愈"：0 字节 / 缺失 / 旧 pid → 跑一次心跳后内容必须等于当前 pid
// 抽不到片段 → 直接失败（不许静默通过）
//
// 用法: node C.deploy/check-pidfile.cjs [A.core 路径]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const cliTs = path.join(core, "god.frontend.cli/cli.ts");
const heartTs = path.join(core, "spirit.bio.organs/kernel.heart/heart.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pidgate-"));

// ── 1) 抽 cli.ts 的守卫 ──
const cliSrc = fs.readFileSync(cliTs, "utf8");
const gm = cliSrc.match(/const pidFile=path\.join\(dataDir,'main\.pid'\);\n([\s\S]*?)\n  \/\/ 原子写入/);
if (!gm) { console.error("[pidfile] FAIL: 无法从 cli.ts 抽出启动守卫（实现改了？gate 需同步）"); process.exit(1); }
const guardBody = gm[1];

// 抽出来的是 TS 片段（含 `(e as any)`）——运行时需要去掉纯类型语法；去掉后仍跑不起来就 fail-closed
const stripTs = (code) => code.replace(/\s+as\s+any\b/g, "").replace(/:\s*any\b/g, "");

const harness = `
const fs = require("node:fs");
const EXIT = "__EXIT__";
function runGuard(pidFile, pname) {
  let exited = false, logs = [];
  // 影子化 process / console：抽出来的真实代码里会调 process.exit(1)，必须拦成标记而不是真退出
  const _realPid = globalThis.process.pid, _realKill = globalThis.process.kill.bind(globalThis.process);
  const process = { pid: _realPid, kill: (p, s) => _realKill(p, s), exit: (c) => { exited = true; throw new Error(EXIT + c); } };
  const console = { error: (m) => logs.push(String(m)) };
  try {
${stripTs(guardBody).split("\n").map((l) => "    " + l).join("\n")}
  } catch (e) { if (!String(e.message).startsWith(EXIT)) { logs.push("THROW:" + e.message); } }
  return { exited, logs: logs.join(" | ") };
}
module.exports = { runGuard };
`;
const harnessPath = path.join(tmp, "guard-harness.cjs");
fs.writeFileSync(harnessPath, harness);
let runGuard;
try { runGuard = require(harnessPath).runGuard; }
catch (e) { console.error("[pidfile] FAIL: 守卫片段无法执行（语法/命名变了）: " + e.message); process.exit(1); }

const mk = (name, content, ageMs) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, content);
  if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t); }
  return f;
};
const cases = [
  { name: "空内容 + 心跳新鲜（≤90s）", file: mk("empty-fresh.pid", "", 0), expectRefuse: true, why: "很可能已有实例在跑" },
  { name: "空内容 + 心跳陈旧（10 分钟）", file: mk("empty-stale.pid", "", 10 * 60 * 1000), expectRefuse: false, why: "残留文件，允许覆盖启动" },
  { name: "合法存活 pid（自己）", file: mk("live.pid", String(process.pid), 0), expectRefuse: true, why: "已有一个实例在跑" },
  { name: "合法但已死的 pid", file: mk("dead.pid", "999999", 0), expectRefuse: false, why: "旧实例已退出，允许启动" },
];
let failed = 0;
console.log("[pidfile] 启动守卫夹具（cli.ts 真实代码）:");
for (const c of cases) {
  const r = runGuard(c.file, "fx-agent");
  const ok = r.exited === c.expectRefuse;
  if (!ok) failed++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${c.name.padEnd(26)} → ${r.exited ? "拒绝启动" : "允许启动"}（期望 ${c.expectRefuse ? "拒绝" : "允许"}；${c.why}）`);
  if (r.logs) console.log(`        日志: ${r.logs.slice(0, 160)}`);
}

// ── 2) 抽 heart.ts 的心跳自愈片段 ──
const heartSrc = fs.readFileSync(heartTs, "utf8");
const hm = heartSrc.match(/const now = new Date\(\);\s*\n\s*let _cur = "";[\s\S]*?catch \(e\) \{ console\.error\("\[spirit\.bio\.organs\/kernel\.heart\/heart\.ts\] "/);
const hb = heartSrc.match(/const now = new Date\(\);[\s\S]*?\} else \{\n\s*const fd = require\("fs"\)\.openSync\(pidFile, "a"\);[\s\S]*?\n\s*\}/);
if (!hb) { console.error("[pidfile] FAIL: 无法从 heart.ts 抽出心跳自愈片段（实现改了？gate 需同步）"); process.exit(1); }
const hbCode = hb[0] + ";";
const hbHarness = `
const fs = require("node:fs");
const { readFileSync, writeFileSync } = fs;
module.exports = function heartbeatOnce(pidFile) {
  try {
${stripTs(hbCode).split("\n").map((l) => "    " + l).join("\n")}
  } catch (e) { return "THROW:" + e.message; }
  return "ok";
};
`;
const hbPath = path.join(tmp, "hb-harness.cjs");
fs.writeFileSync(hbPath, hbHarness);
let heartbeatOnce;
try { heartbeatOnce = require(hbPath); }
catch (e) { console.error("[pidfile] FAIL: 心跳片段无法执行: " + e.message); process.exit(1); }

console.log("[pidfile] 心跳自愈夹具（heart.ts 真实代码）:");
const hbCases = [
  { name: "0 字节文件（线上实况）", file: mk("hb-empty.pid", "", 0) },
  { name: "文件缺失", file: path.join(tmp, "hb-missing.pid") },
  { name: "旧 pid（不是本进程）", file: mk("hb-stale.pid", "1", 0) },
];
for (const c of hbCases) {
  const err = heartbeatOnce(c.file);
  let got = "<缺失>";
  try { got = fs.readFileSync(c.file, "utf8").trim(); } catch (e) { got = "<缺失>"; }
  const ok = got === String(process.pid) && err === "ok";
  if (!ok) failed++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${c.name.padEnd(26)} → 心跳后内容 = ${got}${err !== "ok" ? " (" + err + ")" : ""}`);
}

if (failed) { console.error(`[pidfile] FAIL: ${failed} 个夹具不符合预期`); process.exit(1); }
console.log("[pidfile] PASS — 空内容不再静默放行，心跳会自愈内容");
