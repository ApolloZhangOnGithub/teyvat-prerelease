#!/usr/bin/env node
// check-doc-refs.cjs — WIKI/NORM 里引用的仓库文件必须存在（旧路径/错扩展名 = 文档骗人）
// 2026-09-11 prime-agent
//
// 背景：Doctor WIKI 曾写着 `tmux-orphan` 等 8 个不存在的检查（已单独门禁 check-doctor-docs.cjs）；
// 这批扫的是**文件路径引用**：文档说"代码在 X"，而 X 已经被改名/搬家/删了（读者按图索骥找不到东西）。
// 实测抓到：`universe.society/organization/organization.ts`（实际在 `spirit.abio.status/organization.ts`）、
// `god.cli/*`（→ `god.frontend.cli/*`）、`tools.manifest.js`（→ `.json`）等，共修正 15 篇文档。
//
// 判定（只报**高置信**两类，避免散文误伤）：
//   规则1 扩展名不符：引用不存在，但仓库里有唯一"同 stem、不同扩展名"的文件（如 .js ↔ .json）
//   规则2 疑似搬移：引用不存在，但仓库里有唯一"同名文件"在别处（如 god.cli/launcher.sh → god.frontend.cli/launcher.sh）
//   其它（无候选）不判 FAIL，只计数打印——多数是散文/历史/外部路径
// 范围：`B.docs/Dev.Common` 下 `*.WIKI` + `*.NORM`（**不含 Lessons**：那是历史记录，路径过时属正常）
//
// 用法: node C.deploy/check-doc-refs.cjs [A.core 路径] [B.docs 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const docsRoot = path.resolve(process.argv[3] || path.join(core, "..", "B.docs"));
const root = path.dirname(core);                     // teyvat-main
const scanRoots = [core, path.join(root, "C.deploy"), path.join(root, "B.docs")];

// 有意保留的引用（**必须写清为什么**）——都在 WIKI 里有明确语境
const ALLOW = new Map([
  ["src/utils/theme.ts", "Claude Code（外部项目）的源码路径，不是本仓库"],
  ["brain.hippocampus/sleep.ts", "Hippocampus WIKI 的历史变更行（记录 2026-06-15 当时迁到哪），不回改历史"],
  ["brain.hippocampus/hippocampus.sleep/sleep.ts", "同上（历史行里的旧位置）"],
  ["dev-minutely/nightly/prerelease.sh", "散文里用斜杠列举多个 make target，不是路径"],
  ["universe.society/organization/organization.ts", "Organization WIKI 的更正说明段显式标注的旧布局路径"],
]);

const index = [];
for (const base of scanRoots) {
  if (!fs.existsSync(base)) continue;
  for (const p of fs.readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (!p.isFile()) continue;
    const full = path.join(p.parentPath || p.path, p.name);
    if (full.includes("node_modules") || full.includes("/.git/")) continue;
    index.push(path.relative(root, full));
  }
}
const existsRef = (ref) => index.some((x) => x === ref || x.endsWith("/" + ref));

const RE = /(?<![\w~/$.-])((?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)+[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:ts|js|cjs|mjs|sh|json))(?![A-Za-z0-9_.-])/g;
const files = [];
for (const ext of ["WIKI", "NORM"]) {
  for (const p of fs.readdirSync(path.join(docsRoot, "Dev.Common"), { recursive: true, withFileTypes: true })) {
    if (p.isFile() && p.name.endsWith("." + ext)) files.push(path.join(p.parentPath || p.path, p.name));
  }
}
if (!files.length) { console.error("[doc-refs] FAIL: 没扫到任何 WIKI/NORM（路径不对？）"); process.exit(1); }

// ── 环境变量声明核对（2026-09-11 追加）：文档提到的 PI_*/PAIMON_*/TEYVAT_* 开关必须在代码里出现过 ──
// 例外：同一段落里有「提案/未实现/计划/设计/deprecated/历史」说明（表示它只是设计或已废）；
//       形如 PI_DEBUG_XXX 的占位符（连续大写 X）不算真实变量。
const CODE_EXT = new Set([".ts", ".js", ".cjs", ".mjs", ".sh", ".py", ".json"]);
const codeBlob = [];
const { execFileSync } = require("node:child_process");
for (const base of [core, path.join(root, "C.deploy")]) {
  const walk = (dir) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name === "node_modules" || it.name === ".git") continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full);
      else if (CODE_EXT.has(path.extname(it.name))) { try { codeBlob.push(fs.readFileSync(full, "utf8")); } catch { /* 读不到跳过 */ } }
    }
  };
  walk(base);
}
const codeText = codeBlob.join("\n");
const envTokens = new Map();   // var → [文件:行]
const ENV_RE = /\b((?:PI|PAIMON|TEYVAT|GENSHIN)_[A-Z0-9_]{2,})\b/g;
for (const f of files) {
  fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(ENV_RE)) {
      const v = m[1];
      if (/XXX|TODO|_X+$/.test(v)) continue;                     // 占位符
      const ctx = fs.readFileSync(f, "utf8").split("\n").slice(Math.max(0, i - 3), i + 4).join("\n");
      const declared = /提案|未实现|计划|设计中|待实现|deprecated|历史|已废/.test(ctx);
      if (!envTokens.has(v)) envTokens.set(v, { file: path.relative(docsRoot, f), line: i + 1, declared });
    }
  });
}
let envChecked = 0;
const envBad = [];
for (const [v, info] of envTokens) {
  envChecked++;
  if (codeText.includes(v)) continue;
  if (info.declared) continue;
  envBad.push(`${info.file}:${info.line} 提到 ${v}，但代码里从未出现`);
}
console.log(`[doc-refs] 环境变量声明：核对 ${envChecked} 个（${envBad.length} 个可疑）`);

// ── make target 核对（2026-09-11 追加）：文档里的 `make X` 必须是 Makefile 里真实存在的 target ──
// 例外：英语常用语（make sure / make it / make sense …）+ 同一段有「更正/已移除/未实现/提案/历史/不是」标注。
// 为什么只收这一条、不收 `genshin X`：CLI 子命令在文档里大量以散文/示例出现（"genshin agent 平等"、"genshin xxx 启动"），
// 机械化判会大量误报；`make X` 是唯一形态的硬声明，误报率低。
const MK_STOP = new Set(['sure','it','sense','them','this','that','the','a','an','target','sure,','sure.','you','me','him','us','up','out','to','for','from','of','in','on','by','with']);
const mkPath = path.join(root, 'C.deploy', 'Makefile');
const mkTargets = new Set();
try {
  for (const line of fs.readFileSync(mkPath, 'utf8').split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/);
    if (m) mkTargets.add(m[1]);
  }
} catch { console.error('[doc-refs] FAIL: 读不到 Makefile: ' + mkPath); process.exit(1); }
let mkChecked = 0;
const mkBad = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?:^|[`\s])make\s+([a-z][a-z0-9_-]*)/g)) {
      const t = m[1];
      if (MK_STOP.has(t)) continue;
      mkChecked++;
      if (mkTargets.has(t)) continue;
      const ctx = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
      if (/更正|已移除|已删除|未实现|提案|计划|历史|已废|不是公开|没有该/.test(ctx)) continue;
      mkBad.push(`${path.relative(docsRoot, f)}:${i + 1} 的 make ${t}（Makefile 无此 target）`);
    }
  });
}
console.log(`[doc-refs] make target 核对：${mkChecked} 处（${mkBad.length} 处可疑）`);

let checked = 0, allowed = 0, other = 0;
const bad = [];
for (const f of files) {
  const txt = fs.readFileSync(f, "utf8");
  for (const m of txt.matchAll(RE)) {
    const ref = m[1];
    if (ref.startsWith("deploy/") || ref.startsWith("core/")) continue;   // 发行包布局
    checked++;
    if (existsRef(ref)) continue;
    if (ALLOW.has(ref)) { allowed++; continue; }
    const stem = path.basename(ref, path.extname(ref)), base = path.basename(ref);
    const sameStem = index.filter((x) => path.basename(x, path.extname(x)) === stem);
    const sameBase = index.filter((x) => path.basename(x) === base);
    if (sameStem.length === 1 && path.extname(sameStem[0]) !== path.extname(ref)) {
      bad.push([f, ref, sameStem[0], "扩展名不符"]);
    } else if (sameBase.length === 1) {
      bad.push([f, ref, sameBase[0], "疑似搬移"]);
    } else other++;
  }
}
console.log(`[doc-refs] 扫 ${files.length} 篇文档，检查 ${checked} 个路径引用（豁免 ${allowed}，无候选 ${other}）`);
for (const [f, ref, sug, kind] of bad.slice(0, 12)) {
  console.error(`  FAIL  ${path.relative(docsRoot, f)}: 引用的 ${ref} 不存在（${kind}）→ 应该是 ${sug}`);
}
for (const e of mkBad) console.error(`  FAIL  ${e}（读者照抄会得到 No rule to make target）`);
for (const e of envBad) console.error(`  FAIL  ${e}（读者会以为这个开关存在；请实现，或在同段标注「提案/未实现」）`);
if (bad.length || envBad.length || mkBad.length) {
  if (bad.length) {
    console.error(`[doc-refs] FAIL: ${bad.length} 处引用指向不存在的文件（读者按文档找不到东西）`);
    console.error(`        改文档，或把确属"历史/外部"的引用登记进本脚本的 ALLOW（并写明原因）`);
  }
  if (envBad.length) console.error(`[doc-refs] FAIL: ${envBad.length} 处环境变量只存在于文档里`);
  if (mkBad.length) console.error(`[doc-refs] FAIL: ${mkBad.length} 处 make target 不存在`);
  process.exit(1);
}
console.log("[doc-refs] PASS — 文档引用的仓库路径都存在（或已登记为历史/外部）");
