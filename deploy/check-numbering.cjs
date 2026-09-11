#!/usr/bin/env node
// check-numbering.cjs — 「列表显示的序号」与「genshin N 实际解析的序号」一致性门禁
// 2026-09-11 prime-agent（ISSUE 192 第三步）
//
// 为什么需要：序号在**三处**独立计算（list.cjs 的显示编号、launcher ENTRY 的启动解析、
// launcher _resolve_active_arg 的 kill/tmux 解析）。任何一处判据漂移 → `genshin N` 选到错 agent
// （用户 2026-09-11 实测报过；2026-08-15、09-05、09-07 各修过一次同类漂移）。
//
// 做法（fail-closed）：造一个临时 PAIMON_HOME 夹具，覆盖会暴露分歧的状态组合，
//   1) 跑真实 list.cjs，解析它显示的 `序号. 名字`（映射 A）
//   2) 从 launcher.sh 里抽出真实 _resolve_active_arg 片段，按同样的序号问它（映射 B）
//   3) A == B 才算通过；抽不到片段/跑不起来 → 直接失败（不许静默通过）
//
// 夹具覆盖（关键的是第 2 条：active + paused/hibernate 但**没有** detached ——
// 这正是 2026-09-11 发现的分歧点：list.cjs 按状态串归 B 组，旧 launcher 按 detached 归 F 组）
//
// 用法: node C.deploy/check-numbering.cjs [A.core 路径]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const listCjs = path.join(core, "god.frontend.cli/list.cjs");
const launcher = path.join(core, "god.frontend.cli/launcher.sh");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "num-gate-"));
const home = path.join(tmp, "home");
const memDir = path.join(home, "MemoryData");
fs.mkdirSync(memDir, { recursive: true });
fs.mkdirSync(path.join(home, "config"), { recursive: true });
fs.mkdirSync(path.join(home, "RuntimeCache"), { recursive: true });

const agents = [
  { id: "aaaa0001", name: "fx-paused-foreground", kind: "coding-agent", active: true, paused: true, detached: false, hibernate: false },
  { id: "aaaa0002", name: "fx-plain-foreground", kind: "coding-agent", active: true, paused: false, detached: false, hibernate: false },
  { id: "aaaa0003", name: "fx-detached-bg", kind: "coding-agent", active: true, paused: false, detached: true, hibernate: false },
  { id: "aaaa0004", name: "fx-hib-foreground", kind: "coding-agent", active: true, paused: false, detached: false, hibernate: true },
  { id: "aaaa0005", name: "fx-offline", kind: "coding-agent", active: false, paused: false, detached: false, hibernate: false },
];
const nowIso = new Date().toISOString();
const plist = agents.map((a) => ({ id: a.id, name: a.name, kind: a.kind, created: nowIso, lastSeen: nowIso, note: "", model: "", archived: false }));
const plistPath = path.join(memDir, "plist.json");
fs.writeFileSync(plistPath, JSON.stringify(plist, null, 1));

for (const a of agents) {
  const md = path.join(memDir, a.id), rc = path.join(home, "RuntimeCache", a.id);
  fs.mkdirSync(md, { recursive: true });
  fs.mkdirSync(rc, { recursive: true });
  if (a.active) fs.writeFileSync(path.join(md, "main.pid"), String(process.pid)); // 活跃判定用 kill -0，指向自己 = 活着
  if (a.paused) fs.writeFileSync(path.join(md, "paused"), String(Date.now()));
  if (a.hibernate) fs.writeFileSync(path.join(rc, "main-hibernate"), String(Date.now()));
  if (a.detached) fs.writeFileSync(path.join(rc, "detached"), String(Date.now()));
}

// ── 映射 A：真实 list.cjs 的显示编号 ──
let mappingA;
try {
  const out = execFileSync(process.execPath, [listCjs, plistPath, memDir, "en", "list"], {
    env: { ...process.env, PAIMON_HOME: home, PAIMON_CONFIG: path.join(home, "config"), PAIMON_LANG: "en" },
    encoding: "utf8", timeout: 30000,
  });
  const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
  mappingA = [];
  for (const line of plain.split("\n")) {
    const m = line.match(/^\s*(\d+)\.\s+([A-Za-z0-9._-]+)/);
    if (m) mappingA.push({ index: parseInt(m[1], 10), name: m[2], line });
  }
  if (mappingA.length === 0) throw new Error("list.cjs 输出里没解析到任何 `序号. 名字`（输出格式变了？）");
  // 组：从行里的状态串判断（[H]/[P]/[B] → b，其余 active → f，[O] → o）
  mappingA = mappingA.map((r) => ({
    ...r,
    group: /\[[HPB]\]/.test(r.line) ? "b" : (/\[O\]/.test(r.line) ? "o" : "f"),
  }));
} catch (e) {
  console.error("[numbering] FAIL: 跑 list.cjs 失败: " + e.message);
  process.exit(1);
}

// ── 映射 B：真实 launcher 的两个解析片段（ENTRY = 启动路径；_resolve_active_arg = kill/tmux 路径）──
const shText = fs.readFileSync(launcher, "utf8");
const entryM = shText.match(/ENTRY=\$\(node --input-type=commonjs -e "([\s\S]*?)"\s*\)/);
const resolveM = shText.match(/_resolve_active_arg\(\) \{[\s\S]*?node --input-type=commonjs -e "([\s\S]*?)"\s+"\$NAME"/);
if (!entryM || !resolveM) {
  console.error("[numbering] FAIL: 无法从 launcher.sh 提取判据（ENTRY / _resolve_active_arg）—— gate 需与实际实现同步");
  process.exit(1);
}
const subst = (code) => code
  .replace(/\$PLIST/g, plistPath)
  .replace(/\$PAIMON_HOME/g, home)
  .replace(/\$ORDER_FILE/g, path.join(tmp, "order.json"))   // 别写到用户真实 RuntimeCache
  .replace(/\$NAME/g, NAME_PLACEHOLDER);
const NAME_PLACEHOLDER = "__NAME__";

const runEntry = (arg) => {
  const code = subst(entryM[1]).replace(/__NAME__/g, arg);
  try { return execFileSync(process.execPath, ["--input-type=commonjs", "-e", code], { encoding: "utf8", timeout: 15000 }).trim(); }
  catch (e) { return "<ERR " + e.message.split("\n")[0] + ">"; }
};
const runResolve = (arg) => {
  const code = subst(resolveM[1]).replace(/__NAME__/g, arg);
  try { return execFileSync(process.execPath, ["--input-type=commonjs", "-e", code, arg], { encoding: "utf8", timeout: 15000 }).trim(); }
  catch (e) { return "<ERR " + e.message.split("\n")[0] + ">"; }
};

const results = [];
for (const r of mappingA) {
  const arg = `${r.index}${r.group}`;
  const entryOut = runEntry(arg);
  let got = r.name;
  const j = entryOut.match(/^\{/);
  if (j) { try { got = JSON.parse(entryOut).name; } catch (e) { got = "<BAD JSON>"; } }
  else if (entryOut === "") got = "";   // 空 = 没解析到
  else got = entryOut;
  // kill/tmux 路径只支持 f/b/a（offline 本来就不能 kill）
  const resolveGot = r.group === "o" ? "(n/a)" : runResolve(arg);
  results.push({ ...r, arg, resolved: got, resolveGot, ok: got === r.name && (r.group === "o" || resolveGot === r.name) });
}

const bad = results.filter((r) => !r.ok);
console.log("[numbering] 列表显示 vs launcher 解析：");
for (const r of results) {
  console.log(`  ${r.arg.padStart(3)}  列表=${r.name.padEnd(24)} 启动解析=${String(r.resolved).padEnd(24)} kill解析=${String(r.resolveGot).padEnd(24)} ${r.ok ? "OK" : "MISMATCH"}`);
}
if (bad.length) {
  console.error(`[numbering] FAIL: ${bad.length} 处序号解析与列表显示不一致 —— genshin N 会选到错 agent`);
  process.exit(1);
}

// ── 结构化检查：三处判据引用的"状态文件"集合必须一致 ──
try {
  const sh = fs.readFileSync(launcher, "utf8");
  const lc = fs.readFileSync(listCjs, "utf8");
  const entrySnip = (sh.match(/ENTRY=\$\(node --input-type=commonjs -e "([\s\S]*?)"\s*"/) || [])[1] || "";
  const resolveSnip = (sh.match(/_resolve_active_arg\(\) \{[\s\S]*?node --input-type=commonjs -e "([\s\S]*?)"\s+"\$NAME"/) || [])[1] || "";
  if (!entrySnip || !resolveSnip) throw new Error("抽不到 launcher 的 ENTRY / _resolve_active_arg 片段");
  const keysOf = (s) => {
    const out = new Set();
    for (const m of s.matchAll(/\/(detached|paused|main-hibernate)/g)) out.add(m[1]);
    return [...out].sort().join(",");
  };
  const listKeys = "detached,main-hibernate,paused"; // list.cjs:234/236/239 用到的三个标记
  const eK = keysOf(entrySnip), rK = keysOf(resolveSnip);
  console.log(`[numbering] 分组判据引用的状态文件：list.cjs=[${listKeys}] ENTRY=[${eK}] _resolve_active_arg=[${rK}]`);
  if (eK !== listKeys || rK !== listKeys) {
    console.error("[numbering] FAIL: 三处分组判据引用的状态文件不一致（序号必然漂移）");
    process.exit(1);
  }
} catch (e) {
  console.error("[numbering] FAIL: 结构化检查无法完成: " + e.message);
  process.exit(1);
}

console.log("[numbering] PASS — 所有序号解析与列表显示一致（含 active+paused 无 detached 的分歧点用例）");
