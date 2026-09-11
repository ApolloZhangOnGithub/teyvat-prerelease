#!/usr/bin/env node
// check-rename-identity.cjs — 「改名必须同步 identity.json」门禁（ISSUE 195）
// 2026-09-11 prime-agent
//
// 背景：`genshin rename <old> <new>` 原来只改 plist 的 name + 追加 renameHistory，**忘了改 identity.json 的 name**
// → doctor 的 plist-identity 永久报不一致。线上实例：60ba86e9（plist=genshin-v0.3-system-01，
// identity.json=genshin-ecosystem-01，而 renameHistory 里明明记着这次改名）。
// 同一文件的"创建同名孤儿"路径（约 300 行）写对了 idData.name —— 改名路径漏了。
//
// 两条检查：
//   静态（始终执行，fail-closed）：从 cli.ts 抽出 cmdRename 主体，断言它同时有
//     `idData.name = <新名>` 与原子写（writeFileAtomic / renameSync）
//   动态（best-effort）：在临时 PAIMON_HOME 里跑真实 rename，断言 identity.json.name 变成新名；
//     若本机 node 不支持 --experimental-strip-types 则明确 SKIP（不 FAIL，避免老 node 上误红）
//
// 用法: node C.deploy/check-rename-identity.cjs [A.core 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const cliTs = path.join(core, "god.frontend.cli/cli.ts");
const src = fs.readFileSync(cliTs, "utf8");

// ── 静态检查 ──
const m = src.match(/function cmdRename\([\s\S]*?\n\}/);
if (!m) { console.error("[rename-identity] FAIL: 抽不到 cmdRename（实现改了？gate 需同步）"); process.exit(1); }
const body = m[0];
const hasNameWrite = /idData\.name\s*=\s*newName/.test(body);
const hasAtomic = /writeFileAtomic\(|renameSync\(/.test(body);
console.log("[rename-identity] 静态检查 cmdRename：");
console.log(`  ${hasNameWrite ? "OK  " : "FAIL"} 写 idData.name = newName（否则 identity.json 名字永久过期）`);
console.log(`  ${hasAtomic ? "OK  " : "FAIL"} identity.json 用原子写（被 doctor/infos/sync 读取，半截 JSON 会 parse 失败）`);
if (!hasNameWrite || !hasAtomic) { console.error("[rename-identity] FAIL: 静态检查未通过"); process.exit(1); }

// ── 动态检查（best-effort）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rename-check-"));
const home = path.join(tmp, "home");
const mem = path.join(home, "MemoryData");
const idDir = path.join(home, "IdentityData", "abcd1234");
fs.mkdirSync(mem, { recursive: true });
fs.mkdirSync(idDir, { recursive: true });
fs.mkdirSync(path.join(home, "config"), { recursive: true });
fs.writeFileSync(path.join(mem, "plist.json"), JSON.stringify([
  { id: "abcd1234", name: "fx-old-name", kind: "coding-agent", deployment: "local",
    created: "2026-09-11T00:00:00.000Z", lastSeen: "2026-09-11T00:00:00.000Z", note: "", model: "", archived: false },
], null, 1));
fs.writeFileSync(path.join(idDir, "identity.json"), JSON.stringify({ id: "abcd1234", name: "fx-old-name", kind: "coding-agent" }, null, 2));

let skip = false, runErr = "";
try {
  execFileSync(process.execPath, ["--experimental-strip-types", cliTs, "rename", "fx-old-name", "fx-new-name"], {
    env: { ...process.env, PAIMON_HOME: home }, encoding: "utf8", timeout: 60000, stdio: "pipe",
  });
} catch (e) {
  const msg = String(e.stderr || e.message);
  if (/strip-types|Unknown option|bad option/i.test(msg)) skip = true;
  else runErr = msg.split("\n").slice(0, 3).join(" / ");
}
if (skip) {
  console.log("[rename-identity] SKIP 动态检查：本机 node 不支持 --experimental-strip-types（静态检查已通过）");
} else if (runErr) {
  console.error("[rename-identity] FAIL: 动态检查里 rename 命令执行失败: " + runErr);
  process.exit(1);
} else {
  const plistAfter = JSON.parse(fs.readFileSync(path.join(mem, "plist.json"), "utf8"));
  const idAfter = JSON.parse(fs.readFileSync(path.join(idDir, "identity.json"), "utf8"));
  const okPlist = plistAfter[0].name === "fx-new-name";
  const okId = idAfter.name === "fx-new-name";
  const okHist = Array.isArray(idAfter.renameHistory) && idAfter.renameHistory.some((h) => h.to === "fx-new-name");
  console.log("[rename-identity] 动态检查（临时 PAIMON_HOME 里跑真实 rename）：");
  console.log(`  ${okPlist ? "OK  " : "FAIL"} plist.name → fx-new-name`);
  console.log(`  ${okId ? "OK  " : "FAIL"} identity.json.name → fx-new-name（这就是 ISSUE 195 的漏改点）`);
  console.log(`  ${okHist ? "OK  " : "FAIL"} renameHistory 追加了记录`);
  if (!okPlist || !okId || !okHist) { console.error("[rename-identity] FAIL: 动态检查未通过"); process.exit(1); }
}
console.log("[rename-identity] PASS — 改名会同步 plist 与 identity.json（含原子写）");
