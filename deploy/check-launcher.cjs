#!/usr/bin/env node
// check-launcher.cjs — launcher 终端隔离门禁（LESSON 037 第十节机制化）
// 规则：launcher.sh 中任何以 "&" 结尾的后台构造（"&&" 续行除外、含引号的 node -e
// 内嵌脚本行除外）必须带 </dev/null 重定向——后台子壳持控制终端是 kitty 序列
// 泄漏（ISSUE 088）的根因，第三次复发后改为构建期强制。
// 用法: node check-launcher.cjs <launcher.sh 路径>
const fs = require("fs");
const file = process.argv[2];
const lines = fs.readFileSync(file, "utf8").split("\n");
let errors = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trimEnd();
  if (!/&\s*$/.test(trimmed)) continue;            // 非后台构造
  if (/&&\s*$/.test(trimmed)) continue;             // && 续行
  if (trimmed.includes("'") || trimmed.includes('"')) continue; // 引号内（node -e 脚本）跳过
  if (trimmed.includes("</dev/null")) continue;      // 已隔离
  console.error(`  UNGUARDED background at line ${i + 1}: ${trimmed.slice(0, 90)}`);
  console.error(`    launcher 后台子壳必须 </dev/null >/dev/null 2>&1（LESSON 037 / ISSUE 088）`);
  errors++;
}
if (errors > 0) { console.error(`  launcher check FAILED: ${errors} 处`); process.exit(1); }
console.log("  launcher check: clean");
