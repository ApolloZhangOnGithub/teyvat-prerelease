#!/usr/bin/env node
// check-func-load.mjs — func 加载结构性冒烟门禁（ISSUE 112，2026-08-18）
// 用户多次强调：func 加载失败必须 fail-fast + make 时阻止，不能静默 WARN。
//
// v2（2026-08-18，静态检查）：v1 真实 import 模块会触发副作用挂起（实测 345s+，
// mobile/ears/mouth 等器官模块加载时初始化长耗时）——make 门禁必须快且无副作用。
// 改为静态结构性检查（不 import）：
//   1. func 入口文件存在（严格用 rna.json 的 path —— EXP004 将修正 path 根因，不做容错）
//   2. 入口含 export default（2026-08-18 dev-01 统一：全项目 func 入口 default 导出）
//   3. 含 registerPaimonTool / registerMessageRenderer 调用（注册存在）
//   4. 含 renderCall / renderResult 定义（缺 → registerPaimonTool 静默跳过注册 → 工具未注入）
// 真正的运行期 func 加载失败由运行时 fail-fast（core.ts K002 throw + logerr）兜底。
//
// 教训（2026-08-18）：core.ts 曾 catch 吞 entry(pi) 抛错只发 WARN → social 静默未注入
// → K020 运行时才暴露 → K020 throw 在 process.title 设置前 → personId() 失效 → root 授权连锁失效。
// SPEC: check-func-load.mjs.SPEC
//
// 用法: node check-func-load.mjs <A.core 路径>（由 Makefile _integrity 调用）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const core = resolve(process.argv[2] || ".");
const rnaPath = join(core, "spirit.bio.gene/rna.json");
if (!existsSync(rnaPath)) { console.error("rna.json 不存在:", rnaPath); process.exit(1); }
const rna = JSON.parse(readFileSync(rnaPath, "utf8"));

// ── func 名末段 → 目录内入口文件（与 core.ts REGISTRY 的 #alias 指向一致）──
function findEntry(dir, short) {
  for (const cand of [join(dir, short + ".ts"), join(dir, short + ".js")]) {
    if (existsSync(cand)) return cand;
  }
  // 目录递归（优先 kernel/index，否则第一个 .ts）
  const found = [];
  if (existsSync(dir)) {
    const walk = (dd) => {
      for (const f of readdirSync(dd, { withFileTypes: true })) {
        const p = join(dd, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith(".ts") || f.name.endsWith(".js")) found.push(p);
      }
    };
    walk(dir);
  }
  return found.find((p) => /kernel\.(ts|js)$/.test(p)) || found.find((p) => /index\.(ts|js)$/.test(p)) || found[0] || null;
}

let checked = 0, failed = 0;
for (const [name, f] of Object.entries(rna.funcs)) {
  if (f.future || !f.path) continue;
  const short = name.split(".").pop();
  const entry = findEntry(join(core, f.path), short);
  if (!entry) { console.error(`  [check-func-load] ❌ func ${name}: 入口文件不存在（path=${f.path}）`); failed++; continue; }
  const src = readFileSync(entry, "utf8");
  const problems = [];
  // 1) 导出形态：export default（函数）或 export { default } from（re-export，如 mobile index.ts）
  if (!/\bexport\s+default\b/.test(src) && !/\bexport\s*\{[^}]*\bdefault\b/.test(src)) problems.push("无 export default 导出（core REGISTRY 无法调用）");
  const hasReg = /\bregisterPaimonTool\s*\(/.test(src) || /\bregisterMessageRenderer\s*\(/.test(src);
  // 2) 有注册的 func 必须检查渲染；无注册的内核/后台 func（kernel.heart 工具在子文件、bioclock 无工具）
  //    不报错——"manifest 声明了工具但入口无注册"由 check-manifest-tools.cjs 覆盖
  // 3) 有注册时才要求 renderCall / renderResult（缺 → registerPaimonTool 静默跳过注册 → 工具未注入）
  //    兼容方法简写 renderCall(...) 与属性赋值 renderCall: (...) 两种形态（可选冒号）
  if (hasReg) {
    if (!/\brenderCall\s*[:]?\s*\(/.test(src)) problems.push("缺 renderCall 定义（会被 registerPaimonTool 跳过注册）");
    if (!/\brenderResult\s*[:]?\s*\(/.test(src)) problems.push("缺 renderResult 定义（会被 registerPaimonTool 跳过注册）");
  }
  if (problems.length) {
    failed++;
    console.error(`  [check-func-load] ❌ func ${name} (${entry.replace(core + "/", "")}): ${problems.join("；")}`);
  } else {
    checked++;
  }
}

if (failed > 0) {
  console.error(`\nfunc load check: FAILED (${failed} 个 func 结构异常，已通过 ${checked} 个) — fail-fast（ISSUE 112），禁止部署。`);
  process.exit(1);
}
console.log(`func load check: clean (${checked} funcs, static)`);
