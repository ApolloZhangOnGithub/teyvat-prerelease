#!/usr/bin/env node
// check-theme-usage.cjs — 运行时颜色名门禁（prime-agent 2026-09-11 提议）
//
// 为什么需要它：Theme.fg()/bg() 在运行时会 throw `Unknown theme color: X`
// （实现见 pi-coding-agent/dist/modes/interactive/theme/theme.js: `if (!ansi) throw ...`）。
// 历史证据：`Unknown theme color: white` 15034 次（至 2026-07-13）、
//           `Unknown theme color: default` 5 次（2026-09-08）。
// 现有的 check-theme-consistency.cjs 只校验 dark/light 的 vars 键对应与 colors 引用完整，
// 不校验「代码里写的颜色名是否存在」——所以这类笔误只能在运行时炸出来。
//
// 检查项：
//   U001 fg("X") 的 X 必须是 colors 的键（且不是只给 bg 用的键）
//   U002 bg("X") 的 X 必须是 colors 里给 bg 用的键之一
//   U003 同一条里出现 theme-allow 注释可豁免（写明理由）
//
// 用法: node check-theme-usage.cjs <A.core 路径>
// 注意：只认字面量（fg("x") / bg("x")）。写成变量（fg(name)）无法静态检查，跳过。
// 已知的本地同名 helper 要登记在 LOCAL_HELPERS 里，否则会误报（model-selector.js 的 fg 特判了 "plain"）。

const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join, resolve, relative } = require("node:path");

const core = resolve(process.argv[2] || ".");
const themeDir = join(core, "god.frontend.tui/overrides/modes/interactive/theme");
const dark = JSON.parse(readFileSync(join(themeDir, "dark.json"), "utf8"));
const light = JSON.parse(readFileSync(join(themeDir, "light.json"), "utf8"));

const BG_ONLY = new Set(["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);
const fgValid = new Set([...Object.keys(dark.colors), ...Object.keys(light.colors)].filter((k) => !BG_ONLY.has(k)));
const bgValid = new Set([...Object.keys(dark.colors), ...Object.keys(light.colors)].filter((k) => BG_ONLY.has(k)));

// 本地同名 helper（不是 Theme 的方法）——已人工确认，登记豁免
const LOCAL_HELPERS = [
  { file: "model-selector.js", reason: "文件内 `const fg = (color, text) => color === \"plain\" ? text : theme.fg(color, text)` 自己处理了 plain" },
];

const RE_FG = /\bfg\(\s*"([A-Za-z0-9_]+)"/g;
const RE_BG = /\bbg\(\s*"([A-Za-z0-9_]+)"/g;
const issues = [];
let scanned = 0;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|js|cjs|mjs)$/.test(e)) out.push(p);
  }
  return out;
}

for (const file of walk(core)) {
  const rel = relative(core, file);
  const exemptFile = LOCAL_HELPERS.some((h) => file.endsWith(h.file));
  const lines = readFileSync(file, "utf8").split("\n");
  scanned++;
  lines.forEach((line, i) => {
    if (line.includes("theme-allow")) return;
    for (const [re, valid, kind] of [[RE_FG, fgValid, "fg"], [RE_BG, bgValid, "bg"]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const name = m[1];
        if (valid.has(name)) continue;
        if (exemptFile && kind === "fg" && name === "plain") continue;
        issues.push(`U00${kind === "fg" ? 1 : 2} FAIL: ${rel}:${i + 1} ${kind}("${name}") —— colors 里没有这个键${BG_ONLY.has(name) ? "（它是 bg 专用键，fg() 用不了）" : ""}`);
      }
    }
  });
}

if (issues.length) {
  console.error("[theme-usage] FAIL — 运行时会抛 Unknown theme color");
  for (const s of [...new Set(issues)]) console.error("  " + s);
  console.error(`  文件扫描数: ${scanned}`);
  process.exit(1);
}
console.log(`[theme-usage] PASS — ${scanned} 个文件里 fg()/bg() 的颜色名都存在`);
