#!/usr/bin/env node
// teyvat 构建门禁：pi-tui 渲染器回归冒烟测试
// 目标：防止 rebase pi-tui override 时静默丢失 teyvat 的渲染保护/定制（历史教训：
// 0.84.1 替换丢了 null 保护 → 代码块渲染 uncaughtException 杀掉整个 TUI；
// 丢了标题去黄/无前缀定制 → ##/### 显示回归）。
// 用法：node check-render.mjs <A.core 路径>（由 Makefile _integrity 调用）
// 实际断言在 check-render-test.mjs，本文件只负责搭最小模块闭包并执行。
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fail = (msg) => {
  console.error(`  render smoke check FAILED: ${msg}`);
  process.exit(1);
};

const here = dirname(fileURLToPath(import.meta.url));
const core = resolve(process.argv[2] ?? ".");
const srcPiTui = join(core, "god.frontend.tui", "overrides", "pi-tui");
const testSrc = join(here, "check-render-test.mjs");
if (!existsSync(join(srcPiTui, "components", "markdown.js"))) fail(`override 缺失: ${srcPiTui}`);
if (!existsSync(testSrc)) fail(`测试脚本缺失: ${testSrc}`);

// 从 A.core 的 pi-tui 包（可能是 symlink 到 runtime）真实路径向上找 node_modules 里的包
function findPkgDir(baseDir, name) {
  let d = baseDir;
  while (true) {
    const cand = join(d, "node_modules", name);
    if (existsSync(join(cand, "package.json"))) return cand;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}
const piTuiPkg = join(core, "node_modules", "@earendil-works", "pi-tui");
if (!existsSync(piTuiPkg)) fail(`A.core 缺少 ${piTuiPkg}（先在 A.core 跑 npm install）`);
const piTuiBase = realpathSync(piTuiPkg);
const markedDir = findPkgDir(piTuiBase, "marked");
const gaewDir = findPkgDir(piTuiBase, "get-east-asian-width");
if (!markedDir) fail("解析不到 marked（pi-tui 依赖缺失，先在 A.core 跑 npm install）");
if (!gaewDir) fail("解析不到 get-east-asian-width（0.84.1 utils.js 需要它）");

// 搭最小模块闭包（复制 + 符号链接，不改动源码树）
const tmp = mkdtempSync(join(tmpdir(), "teyvat-render-check-"));
try {
  const pkg = join(tmp, "pi-tui");
  mkdirSync(join(pkg, "components"), { recursive: true });
  mkdirSync(join(pkg, "node_modules"), { recursive: true });
  cpSync(join(srcPiTui, "components", "markdown.js"), join(pkg, "components", "markdown.js"));
  cpSync(join(srcPiTui, "components", "text.js"), join(pkg, "components", "text.js"));
  for (const f of ["latex.js", "terminal-image.js", "utils.js"]) cpSync(join(srcPiTui, f), join(pkg, f));
  const blocksSrc = join(core, "god.frontend.tui", "ui_elements", "blocks_nongod.js");
  if (!existsSync(blocksSrc)) fail(`blocks_nongod.js 缺失: ${blocksSrc}`);
  cpSync(blocksSrc, join(pkg, "blocks_nongod.js"));
  cpSync(join(srcPiTui, "keybindings.js"), join(pkg, "keybindings.js"));
  cpSync(join(srcPiTui, "keys.js"), join(pkg, "keys.js"));
  symlinkSync(markedDir, join(pkg, "node_modules", "marked"), "dir");
  symlinkSync(gaewDir, join(pkg, "node_modules", "get-east-asian-width"), "dir");
  cpSync(testSrc, join(tmp, "test.mjs"));
  execFileSync(process.execPath, [join(tmp, "test.mjs")], { stdio: "inherit" });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
