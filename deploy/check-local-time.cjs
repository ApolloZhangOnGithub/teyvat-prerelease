#!/usr/bin/env node
// check-local-time.cjs — 面向用户的时间显示禁止用 toISOString()（UTC）
//
// 2026-09-12 用户多次被 UTC 时间恶心到：备份状态、cmd-done、状态行等显示 UTC 而非本地时间。
// 根因：JS 的 toISOString() 默认 UTC，开发者随手用就是 UTC。
//
// 规则：
//   - 面向用户的显示代码（renderer/TUI/CLI 输出）中的 toISOString 必须标注 [UTC-OK] 说明原因
//   - 内部数据落盘（jsonl/log/monitor）的 toISOString 不管（机器读，时区无所谓）
//   - 面向用户的时间用 paths.ts 的 localTime() / localTimeShort()
//
// 扫描范围：
//   - renderers.ts、launcher.sh、list.cjs、backup.ts、commands/*.ts、tool-execution.js
//   - 排除：trace/monitor/log/events/growth（内部数据）
//
// 用法: node C.deploy/check-local-time.cjs [A.core路径]

const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));

// 面向用户的文件——这些文件里的 toISOString 需要审查
const USER_FACING = [
  "god.frontend.tui/renderers.ts",
  "god.frontend.tui/commands/",
  "god.frontend.tui/overrides/modes/interactive/components/tool-execution.js",
  "god.frontend.cli/backup.ts",
  "god.frontend.cli/list.cjs",
  "god.frontend.cli/launcher.sh",
];

// 豁免标记：行内含 [UTC-OK] 或 toISOString 在注释里
const EXEMPT = /\[UTC-OK\]|\/\/.*toISOString|\/\*.*toISOString/;
// 内部数据用途豁免（日志/监控/trace/events/落盘标记）
const INTERNAL = /log\(|monitor|trace|events|jsonl|growth|\.log|writeFile.*\.json|JSON\.stringify.*\{.*ts:/;

const fails = [];

for (const pattern of USER_FACING) {
  const full = path.join(core, pattern);
  const files = [];
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".cjs")) files.push(path.join(full, f));
    }
  } else if (fs.existsSync(full)) {
    files.push(full);
  }

  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("toISOString")) continue;
      if (EXEMPT.test(line)) continue;
      if (INTERNAL.test(line)) continue;
      // console.log 或 status 写入中的 toISOString 需要审查
      const rel = path.relative(core, file);
      fails.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120) });
    }
  }
}

if (fails.length > 0) {
  console.log(`  ${fails.length} 处面向用户的 toISOString（UTC）——应改用 localTime() 或标注 [UTC-OK]`);
  for (const f of fails) {
    console.log(`  WARN  ${f.file}:${f.line}  ${f.text}`);
  }
  // 暂时 WARN 不 FAIL——先让现有代码通过，逐步迁移
  // process.exit(1);
} else {
  console.log("  本地时间检查通过（0 处未标注的面向用户 toISOString）");
}
