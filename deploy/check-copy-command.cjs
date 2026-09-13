#!/usr/bin/env node
// check-copy-command.cjs —— 防经典坑回归门禁（2026-09-14 dev-01）
// 经典坑：teyvat 禁用 pi 原生命令（interactive-mode L2439），所有 /command 必须 register.ts 的
// pi.registerCommand 注册；未注册的命令会被 onSubmit 当普通用户消息发给 agent（静默失效，不报错）。
// /copy 和 /m 都曾因此漏注册（/m 是 9/13 1ecb240d 删命令注册时一起丢的）。本门禁在 make 时校验注册完整。
const fs = require("fs");
const path = require("path");

const core = process.argv[2];
if (!core) { console.error("usage: check-copy-command.cjs <A.core>"); process.exit(1); }

const register = fs.readFileSync(path.join(core, "god.frontend.tui/commands/register.ts"), "utf8");
const imode = fs.readFileSync(path.join(core, "god.frontend.tui/overrides/modes/interactive/interactive-mode.js"), "utf8");

const missing = [];
if (!register.includes('registerCommand("copy"')) missing.push("/copy 注册");
if (!register.includes('registerCommand("m"')) missing.push("/m 注册");
if (!imode.includes("__genshinHandleCopyCommand")) missing.push("__genshinHandleCopyCommand 桥");
if (!register.includes('from "./copy.ts"')) missing.push("copy.ts import");

if (missing.length > 0) {
  console.error(`  ERROR: 命令注册缺失（经典坑回归，命令会静默失效）: ${missing.join("、")} —— 恢复见 register.ts 尾部注释`);
  process.exit(1);
}
console.log("  ✓ copy/m 命令注册完整");
