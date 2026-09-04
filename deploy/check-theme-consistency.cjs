#!/usr/bin/env node
// check-theme-consistency.cjs — dark/light 配色一致性门禁（2026-08-18 用户要求）
// 用户：以后 make 要检查 dark 和 light 的数值一一对应，不能没有（否则 light 模式渲染丢色/回退）。
// 检查项：
//   T001 vars 键一一对应：dark 的每个 vars 键 light 必须有（反之亦然），缺失 → FAIL exit 1
//   T002 vars 值非空：每个键的值不能为空/null
//   T003 colors 引用完整：colors 段引用的 vars 键必须存在（#hex 字面量除外）
// 豁免：`*Original` 后缀键（历史原色记录字段，如 socialMessageOriginal——仅改动方保留即可，不要求双向）
// SPEC: check-theme-consistency.cjs.SPEC
// 用法: node check-theme-consistency.cjs <A.core 路径>（由 Makefile _integrity 调用）

const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const core = resolve(process.argv[2] || ".");
const themeDir = join(core, "god.frontend.tui/overrides/modes/interactive/theme");
const darkPath = join(themeDir, "dark.json");
const lightPath = join(themeDir, "light.json");

function load(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`T000 FAIL: 无法解析 ${p}: ${e.message}`);
    process.exit(1);
  }
}

const dark = load(darkPath);
const light = load(lightPath);
const issues = [];
const originalKey = (k) => /Original$/.test(k); // 历史原色记录字段豁免

// T001 vars 键一一对应（豁免 *Original）
const dk = Object.keys(dark.vars || {}).filter((k) => !originalKey(k));
const lk = Object.keys(light.vars || {}).filter((k) => !originalKey(k));
const missL = dk.filter((k) => !lk.includes(k));
const missD = lk.filter((k) => !dk.includes(k));
if (missL.length) issues.push(`T001 FAIL: light 缺失 dark 的 vars 键: ${missL.join(", ")}`);
if (missD.length) issues.push(`T001 FAIL: dark 缺失 light 的 vars 键: ${missD.join(", ")}`);

// T002 vars 值非空
for (const [name, th] of [["dark", dark], ["light", light]]) {
  for (const [k, v] of Object.entries(th.vars || {})) {
    if (!v) issues.push(`T002 FAIL: ${name}.vars.${k} 值为空`);
  }
}

// T003 colors 引用完整（引用的键必须是 vars 键或 #hex 字面量）
for (const [name, th] of [["dark", dark], ["light", light]]) {
  const vk = new Set(Object.keys(th.vars || {}));
  for (const [k, ref] of Object.entries(th.colors || {})) {
    if (typeof ref === "string" && !ref.startsWith("#") && !vk.has(ref)) {
      issues.push(`T003 FAIL: ${name}.colors.${k} 引用了不存在的 vars 键 "${ref}"`);
    }
  }
}

if (issues.length) {
  for (const it of issues) console.error(`[theme-consistency] ${it}`);
  process.exit(1);
}
console.log(`[theme-consistency] PASS — dark ${dk.length} / light ${lk.length} vars 键一一对应`);
