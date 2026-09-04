#!/usr/bin/env node
// check-resolve.cjs — 综合解析门禁（镜像 jiti 运行时语义）
// 对扩展器官源码的每个 import/require 字面量验证能否解析到真实文件：
//   #alias     → A.core/package.json imports 表 → 目标文件存在
//   bare 包    → import: exports["."].import 或 main 或 index 存在
//                require: exports["."] 有 require 条件则其目标存在；
//                          有 exports 但无 require 条件 → 必炸（LESSON 056 实证：Node CJS 规则）
//   subpath    → exports 映射目标存在，或包目录下直接文件存在（jiti 宽松语义）
// 跳过：import type（jiti 剥离）、注释、相对路径、node: 内置。
// 用法: node check-resolve.cjs <A.core 路径>
const fs = require("fs");
const path = require("path");

const core = path.resolve(process.argv[2] || ".");
const dirs = ["spirit.bio.organs", "spirit.abio.roles", "spirit.abio.status", "spirit.abio.techniques", "universe.infotech"];
const files = [];
function walk(d) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const fp = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".bak")) walk(fp); }
    else if (/\.(ts|js|cjs|mjs)$/.test(e.name)) files.push(fp);
  }
}
for (const d of dirs) walk(path.join(core, d));

const corePkg = JSON.parse(fs.readFileSync(path.join(core, "package.json"), "utf8"));
const BUILTINS = new Set(require("node:module").builtinModules.map((m) => m.replace(/^node:/, "")));
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
function findPkgDir(fromDir, name) {
  let d = fromDir;
  while (true) {
    const cand = path.join(d, "node_modules", name);
    if (exists(path.join(cand, "package.json"))) return cand;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}
function existsEntry(pkgDir, sub) {
  if (!sub) return false;
  return [
    path.join(pkgDir, sub),
    path.join(pkgDir, sub + ".js"),
    path.join(pkgDir, sub + ".ts"),
    path.join(pkgDir, sub + ".cjs"),
    path.join(pkgDir, sub + ".mjs"),
    path.join(pkgDir, sub, "index.js"),
    path.join(pkgDir, sub, "index.ts"),
  ].some(exists);
}

function resolveSpec(file, spec, style) {
  if (spec.startsWith("#")) {
    const target = corePkg.imports?.[spec];
    if (!target) return false;
    const t = path.isAbsolute(target) ? target : path.join(core, target);
    return exists(t) || exists(t.replace(/\.(ts|js)$/, ""));
  }
  const parts = spec.split("/");
  const pkgName = spec.startsWith("@") ? parts[0] + "/" + parts[1] : parts[0];
  const rest = spec.startsWith("@") ? parts.slice(2) : parts.slice(1);
  const pkgDir = findPkgDir(path.dirname(file), pkgName);
  if (!pkgDir) return false;
  let pkgJson = {};
  try { pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")); } catch {}

  if (rest.length === 0) {
    if (style === "require") {
      // Node CJS 规则（LESSON 056 实证）：有 exports 但 "." 无 require 条件 → 裸 require 必炸
      const dot = pkgJson.exports?.["."];
      if (pkgJson.exports && dot) {
        if (typeof dot === "string") return exists(path.join(pkgDir, dot));
        if (typeof dot.require === "string") return exists(path.join(pkgDir, dot.require));
        return false;
      }
      if (pkgJson.main) return exists(path.join(pkgDir, pkgJson.main));
      return exists(path.join(pkgDir, "index.js"));
    }
    // import：exports["."].import 或 main 或 index
    const dot = pkgJson.exports?.["."];
    if (typeof dot === "string") return exists(path.join(pkgDir, dot));
    if (typeof dot?.import === "string") return exists(path.join(pkgDir, dot.import));
    if (pkgJson.main) return exists(path.join(pkgDir, pkgJson.main));
    return exists(path.join(pkgDir, "index.js")) || exists(path.join(pkgDir, "index.ts"));
  }
  const sub = rest.join("/");
  const ex = pkgJson.exports?.["./" + sub];
  if (typeof ex === "string" && exists(path.join(pkgDir, ex))) return true;
  if (ex && typeof ex === "object") {
    for (const k of ["import", "require", "default"]) {
      if (typeof ex[k] === "string" && exists(path.join(pkgDir, ex[k]))) return true;
    }
  }
  return existsEntry(pkgDir, sub); // jiti 宽松语义：直接文件存在
}

let errors = 0;
const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)|require\(["']([^"']+)["']\)/g;
for (const file of files) {
  let src = fs.readFileSync(file, "utf8");
  src = src.replace(/\/\*[\s\S]*?\*\//g, ""); // 块注释
  src = src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n"); // 行注释
  const seen = new Set();
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] || m[2] || m[3];
    const isRequire = !!m[3];
    if (!spec || seen.has(spec + isRequire)) continue;
    seen.add(spec + isRequire);
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("bun:")) continue;
    if (BUILTINS.has(spec)) continue; // 裸内置名（fs/path/os...）jiti 回退可用
    if (!isRequire && /\.ts$/.test(file)) {
      // import type 剥离：语句级或说明符级 type 标记
      const before = src.slice(0, m.index);
      const stmt = before.split("\n").pop() || "";
      if (/\bimport\s+type\b/.test(stmt)) continue;
    }
    if (!resolveSpec(file, spec, isRequire ? "require" : "import")) {
      console.error(`  UNRESOLVED ${isRequire ? "require" : "import"} ${spec}  ← ${file.replace(core + "/", "")}`);
      errors++;
    }
  }
}
if (errors > 0) { console.error(`  resolve check FAILED: ${errors} 处`); process.exit(1); }
console.log(`  resolve check: clean (${files.length} files)`);
