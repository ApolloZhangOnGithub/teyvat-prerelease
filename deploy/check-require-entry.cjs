#!/usr/bin/env node
// check-require-entry.cjs — 机械闸门：扩展代码禁止裸引用 @earendil-works/pi-coding-agent
// 历史：该 CLI 包无 main/exports 主入口，require 必抛 "No exports main defined"（LESSON 056：
// wait 中断消息因此从未发出；同类加载路径问题在 LESSON 007/009/010/011/013 反复出现）。
// 需要 ExtensionAPI：从注册入口参数传递；需要内部模块：#alias import。
// 用法: node check-require-entry.cjs <A.core 路径>（由 Makefile _integrity 调用）
const fs = require("fs");
const path = require("path");

const core = path.resolve(process.argv[2] || ".");
const dirs = [
  "spirit.bio.organs", "god.frontend.tui/overrides", "god.frontend.tui/ui_elements",
  "universe.infotech", "spirit.abio.roles", "spirit.abio.status", "spirit.abio.techniques",
];
// 只拦"裸根引用"（require("...pi-coding-agent") 或 from "...pi-coding-agent"）；
// /dist/... 子路径引用不拦（有 exports 映射）。
// 两个已知必炸的写法：
// 1) 裸根 require("...pi-coding-agent") —— 无 require 入口，实测必抛（LESSON 056）
// 2) 字符串拼接变体 require(".../" + "pi-coding-agent") —— 解析结果同样是裸根
// 子路径 require(".../dist/...") 不拦（intentions.ts 等在用且实测可用）。
const bad = [
  /require\(["']@earendil-works\/pi-coding-agent["']\)/,
  /require\(["']@earendil-works\/["']\s*\+\s*["']pi-coding-agent/,
];
let errors = 0;

function walk(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".bak")) continue;
      walk(fp);
    } else if (/\.(ts|js|cjs|mjs)$/.test(e.name)) {
      const lines = fs.readFileSync(fp, "utf8").split("\n");
      lines.forEach((line, i) => {
        const stripped = line.trim();
        if (stripped.startsWith("//") || stripped.startsWith("*")) return;
        if (bad.some((re) => re.test(line))) {
          console.error(`  FORBIDDEN ${fp}:${i + 1}: ${line.trim().slice(0, 90)}`);
          console.error(`    @earendil-works/pi-coding-agent 无 require/import 根入口（No exports main）。`);
          console.error(`    需要 ExtensionAPI：注册入口参数传递（LESSON 056）；内部模块：#alias import。`);
          errors++;
        }
      });
    }
  }
}
for (const d of dirs) walk(path.join(core, d));

if (errors > 0) {
  console.error(`  require-entry check FAILED: ${errors} 处`);
  process.exit(1);
}
console.log("  require-entry check: clean");
