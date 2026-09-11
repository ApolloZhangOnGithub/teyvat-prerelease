#!/usr/bin/env node
// check-mobile-apps.cjs — 手机 app 的两条不变量（2026-09-11 prime-agent）
//   ① appstore 的 app 名必须过校验再拼路径（防"下载的代码里写 name: ../../x"造成路径穿越）
//   ② apps.json 里的每个 app 都必须导出 MobileApp 的 5 个必需字段（name/icon/messageDescription/onOpen/onAction）
//
// 背景：
//   - 2026-09-11 实测 appstore 的 `validateAppSource` 只做字符串包含检查 + 正则抠 name，**不校验字符**；
//     导入（写 <dir>/<name>.ts）与卸载（rename <dir> → @removed.<name>）都直接拼这个 name →
//     `../../evil` 能写到 apps 之外、`卸载 ../../AccountData` 能把任意目录改名藏起来。已修（appDirFor 统一收口）。
//   - 同批抽查 18 个 app 的字段齐全性（当时用一次性脚本扫的），这里固化成门禁。
//
// 用法: node C.deploy/check-mobile-apps.cjs [A.core 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const mobile = path.join(core, "universe.infotech/local.mobile");
const appstore = path.join(mobile, "apps/appstore/appstore.ts");
const appsJson = path.join(mobile, "apps.json");

let bad = 0;
// ── ① appstore 名字校验 ──
if (!fs.existsSync(appstore)) { console.error("[mobile-apps] FAIL: 找不到 " + appstore); process.exit(1); }
const asSrc = fs.readFileSync(appstore, "utf8");
const checks = [
  ["APP_NAME_RE 存在（名字白名单）", /const APP_NAME_RE = \/\^\[A-Za-z0-9\]/],
  ["appDirFor() 存在（含目录包含断言）", /function appDirFor\(/],
  ["validateAppSource 里校验 name", /if \(!APP_NAME_RE\.test\(name\)\) return \{ valid: false/],
  ["卸载路径走 appDirFor（防 rename 穿越）", /async function handleUninstall[\s\S]{0,200}appDirFor\(name\)/],
  ["导入路径走 appDirFor（防写出 apps）", /const appDir = appDirFor\(appName\)/],
];
console.log("[mobile-apps] appstore 名字校验：");
for (const [name, re] of checks) {
  const ok = re.test(asSrc);
  if (!ok) bad++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
}
// 残留的裸 join：区分"只读用法"与"写/改名用法"
//   - 只读（statSync/existsSync/readdirSync/readFileSync 上下文）→ 允许（来源是 readdirSync 的目录名）
//   - 写/改名：要求所在函数在拼接之前已经过 appDirFor(name) 校验（2026-09-11 修法：先校验名字再拼路径）
const asLines = asSrc.split("\n");
let bareWrite = 0;
asLines.forEach((line, i) => {
  if (!/path\.join\(PROGRAM_FILES_MOBILE,\s*(?!\s*\))/.test(line)) return;
  const ctx = asLines.slice(Math.max(0, i - 30), i + 1).join("\n");
  const readOnly = /(statSync|existsSync|readdirSync|readFileSync)\(\s*$/.test(asLines.slice(0, i + 1).join("\n").split("\n").filter((l) => /path\.join\(PROGRAM_FILES_MOBILE/.test(l)).pop().split("path.join")[0]);
  if (readOnly) return;
  if (/appDirFor\(name\)/.test(ctx)) return;   // 同一个函数里名字已被校验过
  bareWrite++;
  console.error(`  FAIL  appstore.ts:${i + 1} 写/改名路径仍裸拼 PROGRAM_FILES_MOBILE（应先知校验 name）`);
});
bad += bareWrite;
console.log(`  写/改名的裸拼法: ${bareWrite}（只读用法不计）`);

// ── ② apps.json ↔ app 字段 ──
let listing = null;
try { listing = JSON.parse(fs.readFileSync(appsJson, "utf8")); }
catch (e) { console.error("[mobile-apps] FAIL: 读不到/解析不了 apps.json: " + e.message); process.exit(1); }
const apps = Array.isArray(listing?.apps) ? listing.apps : [];
if (!apps.length) { console.error("[mobile-apps] FAIL: apps.json 里没有 apps（fail-closed）"); process.exit(1); }
const REQUIRED = ["name", "icon", "messageDescription", "onOpen", "onAction"];
let fieldBad = 0;
console.log(`[mobile-apps] apps.json 字段检查（${apps.length} 个 app）：`);
for (const a of apps) {
  const f = path.join(mobile, "apps", a.dir || a.name, a.file || `${a.name}.ts`);
  if (!fs.existsSync(f)) { console.error(`  FAIL  ${a.name}: 文件不存在 ${path.relative(core, f)}`); fieldBad++; continue; }
  const src = fs.readFileSync(f, "utf8");
  const miss = REQUIRED.filter((k) => !new RegExp("\\b" + k + "\\s*[:(]").test(src));
  if (miss.length) { console.error(`  FAIL  ${a.name}: 缺 ${miss.join(", ")}`); fieldBad++; }
}
if (fieldBad) bad += fieldBad; else console.log("  所有 app 的必需字段齐全 ✓");

if (bad) { console.error(`[mobile-apps] FAIL: ${bad} 处不符合不变量`); process.exit(1); }
console.log("[mobile-apps] PASS — appstore 名字校验在位、apps.json 与 app 字段一致");
