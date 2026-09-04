#!/bin/bash
# 审计：cli.ts SUBCOMMANDS 里每个规范命令，都必须在 list.cjs 的 help 里有用法说明。
# 不硬编码命令列表——从 cli.ts 动态提取 SUBCOMMANDS，新加子命令漏写 help 会在 make 时报错。
# 豁免（launcher 处理或未实现，不进 help）：tmux sync update uninstall sessions web note
CLI="${1:-}"
if [ -z "$CLI" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ -f "$PKG_ROOT/A.core/package.json" ]; then
    CLI="$PKG_ROOT/A.core/god.frontend.cli/cli.ts"
  else
    echo "ERROR: cannot find cli.ts"; exit 1
  fi
fi
LIST="$(dirname "$CLI")/list.cjs"

CLI="$CLI" LIST="$LIST" node - <<'NODE'
const fs = require("fs");
const src = fs.readFileSync(process.env.CLI, "utf8");
const lst = fs.readFileSync(process.env.LIST, "utf8");

// 1) 提取 cli.ts SUBCOMMANDS 的 value（规范命令名，去重）
const m = src.match(/const SUBCOMMANDS[^=]*=\s*\{([\s\S]*?)\n\};/);
if (!m) { console.error("SUBCOMMANDS not found in cli.ts"); process.exit(1); }
const subs = new Set();
for (const mm of m[1].matchAll(/:\s*'([a-z0-9]+)'/g)) subs.add(mm[1]);

// 2) 提取 list.cjs help 的 row() 命令名（含别名：逗号分隔、去掉 < 参数）
const helpNames = new Set();
for (const r of lst.matchAll(/row\('([^']*)'/g)) {
  const first = r[1].split("<")[0];
  for (const part of first.split(",")) {
    const w = part.trim().split(/\s+/)[0];
    if (w) helpNames.add(w);
  }
}

// 3) 豁免：launcher 处理或未实现，不进 help
const exempt = new Set(["tmux", "sync", "update", "uninstall", "sessions", "web", "note"]);

// 4) 比对
let errs = 0;
for (const cmd of subs) {
  if (exempt.has(cmd)) continue;
  if (!helpNames.has(cmd)) { console.log(`  MISSING help: 命令 '${cmd}' 在 SUBCOMMANDS 里，但 list.cjs help 没写用法`); errs = 1; }
}
if (errs) console.log("  请更新 list.cjs 的 help（中英文都要加用法）");
process.exit(errs);
NODE
