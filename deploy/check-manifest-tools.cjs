#!/usr/bin/env node
// check-manifest-tools.cjs — 机械闸门：注册了但不在 manifest 清单的工具 → make 报错
// 背景（LESSON 待补）：amem 在 memory.ts 已 registerPaimonTool，但 tools.manifest.json
// 未声明，kernel session_start 按 manifest default:true 过滤 activeTools 时被静默剔除。
// 现有 K020 只查"manifest 有但未注入"的单向断线，不查"已注册但 manifest 没有"的反向断线。
// 本闸门补齐反向：任何 registerPaimonTool 注册的工具必须出现在 tools.manifest.json tools 键中。
// 用法: node check-manifest-tools.cjs <A.core 路径>（由 Makefile _integrity 调用）
const fs = require("fs");
const path = require("path");

const core = path.resolve(process.argv[2] || ".");
const manifestPath = path.join(core, "spirit.bio.gene/tools.manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`  manifest not found: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const tools = manifest.tools || {};
const roles = manifest.roles || {};

// 角色专用工具豁免（read_conscious/aware 等只给角色 session，不属于 main 清单）
const roleTools = new Set();
for (const list of Object.values(roles)) for (const t of list || []) roleTools.add(t);

const registered = []; // { name, file, line }
const SKIP_DIRS = new Set(["node_modules", ".git", ".github", ".vscode", "dist", ".bak"]);

function walk(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = path.join(d, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(fp);
    } else if (/\.(ts|js|cjs|mjs)$/.test(e.name)) {
      const lines = fs.readFileSync(fp, "utf8").split("\n");
      let inBlock = false; // 跨行 /* ... */ 块注释状态
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 块注释状态机：进入/退出 /* */，块内所有行视为注释
        const trim = line.trim();
        if (inBlock) {
          if (trim.includes("*/")) inBlock = false;
          continue;
        }
        if (trim.startsWith("/*")) {
          if (!trim.includes("*/")) inBlock = true;
          continue;
        }
        if (!line.includes("registerPaimonTool({")) continue;
        if (trim.startsWith("//") || trim.startsWith("*")) continue;
        // 找 name: "xxx" 字面量（registerPaimonTool 调用块内前几行）
        let name = null;
        for (let j = i; j < Math.min(i + 8, lines.length); j++) {
          const m = lines[j].match(/name:\s*"([^"]+)"/);
          if (m) { name = m[1]; break; }
          if (lines[j].includes("})") || lines[j].includes("});")) break;
        }
        if (!name) continue; // 动态 name（rc.name 等）静态扫描解析不了，跳过
        registered.push({ name, file: path.relative(core, fp), line: i + 1 });
      }
    }
  }
}

walk(core);

const errors = [];
const seen = new Set();
for (const r of registered) {
  if (seen.has(r.name)) continue;
  seen.add(r.name);
  if (roleTools.has(r.name)) continue; // 角色工具豁免
  if (!(r.name in tools)) {
    errors.push(`  ${r.name} (${r.file}:${r.line}) 已注册但不在 tools.manifest.json tools 键中`);
  }
}

// 反向检查：manifest 声明了但代码无注册（死条目）。
// pi 原生工具（read/bash/write/edit 等由平台提供、不经 registerPaimonTool）豁免。
const PI_NATIVE = new Set(["read", "bash", "write", "edit"]);
const dead = [];
for (const [k, v] of Object.entries(tools)) {
  if (PI_NATIVE.has(k)) continue; // pi 平台原生工具，不经 registerPaimonTool
  if (roleTools.has(k)) continue; // 角色工具豁免
  const hasReg = [...seen].some((r) => r.toLowerCase() === k.toLowerCase());
  if (!hasReg && !v.abandoned) {
    dead.push(`  "${k}" (default:${v.default}) 在清单中但代码无对应注册（死条目，可考虑删除或补注册）`);
  }
}

// 严格检查：manifest default:true 的工具必须在 promotor.dna 某个 func 的 tools 行声明
// promotor.dna 格式：func xxx → tools a,b,c（声明该 func 注册了哪些工具）
const dnaPath = path.join(core, "spirit.bio.gene/promotor.dna");
const dnaTools = new Set(); // promotor.dna 中所有 func 声明的 tools 名集合
try {
  const dna = fs.readFileSync(dnaPath, "utf8");
  let inActiveFunc = false;
  for (const line of dna.split("\n")) {
    const trimmed = line.trim();
    if (/^(?:@FUTURE|@ABANDONED)/.test(trimmed)) { inActiveFunc = false; continue; }
    if (/^func\s/.test(trimmed)) { inActiveFunc = true; continue; }
    if (inActiveFunc && trimmed.startsWith("tools ")) {
      for (const t of trimmed.slice(6).split(",")) {
        const name = t.trim();
        if (name) dnaTools.add(name);
      }
    }
    if (trimmed && !trimmed.startsWith("//") && !/^\s/.test(line) && !trimmed.startsWith("vir") && !trimmed.startsWith("session") && !trimmed.startsWith("mode") && !trimmed.startsWith("tag") && !trimmed.startsWith("promotor") && !trimmed.startsWith("CHRs")) {
      // 非缩进的非 func 行 = 离开当前 func
      if (!/^func\s/.test(trimmed)) inActiveFunc = false;
    }
  }
} catch {}

const dnaErrors = [];
for (const [k, v] of Object.entries(tools)) {
  if (!v.default || v.abandoned) continue;
  if (PI_NATIVE.has(k)) continue;
  if (roleTools.has(k)) continue;
  if (!dnaTools.has(k)) {
    dnaErrors.push(`  "${k}" (default:true) 不在任何 promotor.dna func 的 tools 声明中 → make 报错`);
  }
}
if (dnaErrors.length > 0) {
  console.error(`  manifest-tools check FAILED: ${dnaErrors.length} 个工具缺 promotor.dna tools 声明:`);
  for (const e of dnaErrors) console.error(e);
  console.error(`  修复: 在 promotor.dna 对应 func 下加 'tools <name>' 行（NORM-013, LESSON 055）`);
  process.exit(1);
}

if (errors.length > 0 || dead.length > 0) {
  if (errors.length > 0) {
    console.error(`  manifest-tools check FAILED: ${errors.length} 个工具注册了但未进清单 —— 会被 session_start 工具过滤静默剔除:`);
    for (const e of errors) console.error(e);
    console.error(`  修复: 在 tools.manifest.json 的 tools 键中添加条目（default:true 启用 / default:false 需 /tools 会话级开启）`);
  }
  if (dead.length > 0) {
    console.error(`  manifest-tools check FAILED: ${dead.length} 个死条目 —— manifest 声明但代码无注册:`);
    for (const d of dead) console.error(d);
    console.error(`  修复: 删除清单死条目，或在代码中补注册`);
  }
  process.exit(1);
}

console.log(`  manifest-tools check: OK (${registered.length} 个注册工具，全部在清单中)`);
