#!/usr/bin/env node
// check-command-registered.cjs —— 命令注册完整性门禁
// 2026-09-22 dev-01（ISSUE 262）：由 check-copy-command.cjs 泛化——不再只盯 copy/m，而是守住**整个用户命令面**。
//
// 为什么需要：teyvat 禁用了 pi 的原生命令分派（overrides/modes/interactive/interactive-mode.js:2468），
// 所有 /command 必须经 god.frontend.tui/commands/register.ts 的 pi.registerCommand 注册。
// 未注册的 /xxx 不会被报错，而是被 onSubmit 当**普通用户消息发给 agent** —— 静默失效（ISSUE 252 的 /copy、
// ISSUE 262 的 /login；`/c` 更是漏注册了很久没人发现）。
//
// 三类检查：
//   ① 命令注册：REQUIRED 里每个命令都要有 registerCommand("<name>"
//   ② handler 来源：命令的 handler 必须真的从对应文件 import（防"注册了个不存在的名字"）
//   ③ 桥：handler 要回调 TUI 实例方法的命令，桥必须同时在 interactive-mode 暴露 + 在 handler 文件里引用
//
// 新增命令请登记进 REQUIRED / IMPORTS / BRIDGES —— 这就是本门禁存在的意义。
const fs = require("fs");
const path = require("path");

const core = process.argv[2];
if (!core) { console.error("usage: check-command-registered.cjs <A.core>"); process.exit(1); }

const read = (rel) => fs.readFileSync(path.join(core, rel), "utf8");
const register = read("god.frontend.tui/commands/register.ts");
const imode = read("god.frontend.tui/overrides/modes/interactive/interactive-mode.js");

// ① 必须注册的命令（用户可见命令面 = register.ts 的 registerCommand 调用）
const REQUIRED = ["s", "a", "q", "h", "p", "copy", "m", "login", "logout", "c"];
// ② 命令 → 其 handler 的 import 语句（必须出现在 register.ts）
const IMPORTS = {
  s: 'from "./settings.ts"', a: 'from "./authdir.ts"', q: 'from "./exit.ts"',
  h: 'from "./detach.ts"', p: 'from "./pause.ts"', copy: 'from "./copy.ts"',
  m: 'from "./model.ts"', login: 'from "./login.ts"', logout: 'from "./login.ts"',
  c: 'from "./config.ts"',
};
// ③ 需要 globalThis 桥的命令（上游 handler 是 InteractiveMode 实例方法，扩展命令拿不到实例）
const BRIDGES = [
  { cmd: "copy", bridge: "__genshinHandleCopyCommand", file: "god.frontend.tui/commands/copy.ts" },
  { cmd: "m", bridge: "__genshinHandleModelCommand", file: "god.frontend.tui/commands/model.ts" },
  { cmd: "login", bridge: "__genshinHandleLoginCommand", file: "god.frontend.tui/commands/login.ts" },
  { cmd: "logout", bridge: "__genshinHandleLogoutCommand", file: "god.frontend.tui/commands/login.ts" },
];

const missing = [];
for (const name of REQUIRED) {
  if (!register.includes(`registerCommand("${name}"`)) missing.push(`/${name} 注册`);
  const imp = IMPORTS[name];
  if (imp && !register.includes(imp)) missing.push(`${name} 的 import（${imp}）`);
}
for (const { bridge, file } of BRIDGES) {
  if (!imode.includes(bridge)) missing.push(`${bridge} 未在 interactive-mode 暴露`);
  let cf = "";
  try { cf = read(file); } catch { /* 文件缺失下面单独报 */ }
  if (!cf.includes(bridge)) missing.push(`${bridge} 未在 ${file} 引用`);
}

if (missing.length > 0) {
  console.error(`  ERROR: 命令注册缺失（经典坑回归，命令会静默失效）: ${missing.join("、")}`);
  console.error("  恢复见 register.ts 注释 + ISSUE 262 / ISSUE 252；WIKI: Slash&Tools(Concept).WIKI");
  process.exit(1);
}
console.log(`  ✓ ${REQUIRED.length} 个命令注册完整（含 ${BRIDGES.length} 个桥）`);
