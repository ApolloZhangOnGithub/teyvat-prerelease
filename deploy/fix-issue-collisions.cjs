#!/usr/bin/env node
// fix-issue-collisions.cjs — Issues/Lessons 编号撞号的检测与自动改号（2026-09-11 prime-agent）
//
// 为什么需要它：多个 agent 并行写 ISSUE 时都按「现有最大号 +1」取号，同一分钟就会撞号。
// 项目规范（Wiki/Knowledge-Docs 写作规范）定的规矩是「撞号后到者改号」，但手工改号要动
// 文件名 + 文件头 + INDEX，容易漏——2026-09-11 一天内就撞了 8 组（手工修了 3 组，随后又新增 5 组）。
//
// 用法:
//   node fix-issue-collisions.cjs [--apply] [--next] [--regen] [--kinds=issues,lessons]
//     (无参数)     只打印检测结果和改号计划（dry-run，不动文件）
//     --apply      按计划改号（文件头一并更新，插入改号说明）
//     --next       只打印"下一个可用编号"（新写文档前用它取号，别再手算 max+1）
//     --regen      改号后调用 gen-issues-index.mjs / 更新 *.INDEX（默认不做，避免误改大文件）
//
// 规则（与项目规范一致）：同号文件里**修改时间最早**的保留原号，其余后到者改到下一个空闲号；
// 配套文件（.SPEC / .REMOVED / *.NAMETRACE.REMOVED）不参与撞号判定，改号时跟随主文件一起改。

const fs = require("node:fs");
const path = require("node:path");

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes("--apply");
const NEXT_ONLY = ARGS.includes("--next");
const REGEN = ARGS.includes("--regen");
const KINDS_ARG = (ARGS.find(a => a.startsWith("--kinds=")) || "--kinds=issues").split("=")[1];

const ROOT = path.resolve(__dirname, "..", "B.docs", "Dev.Common");
const TARGETS = {
  issues: { dir: path.join(ROOT, "Issues", "Top-Level"), ext: ".ISSUE", indexGen: true },
  lessons: { dir: path.join(ROOT, "Lessons"), ext: ".LESSON", indexGen: false },
};

const isCompanion = (name) => /\.(SPEC|REMOVED)$/.test(name) || /NAMETRACE\.REMOVED$/.test(name);
const numOf = (name) => {
  const m = name.match(/^(\d+)-/);
  return m && !isCompanion(name) ? parseInt(m[1], 10) : null;
};

for (const kind of KINDS_ARG.split(",")) {
  const t = TARGETS[kind.trim()];
  if (!t || !fs.existsSync(t.dir)) { console.error(`跳过 ${kind}: 目录不存在 ${t && t.dir}`); continue; }
  const all = fs.readdirSync(t.dir).filter((f) => f.endsWith(t.ext) || f.includes(t.ext + "."));
  const mains = all.filter((f) => !isCompanion(f));
  const used = new Set(mains.map(numOf).filter(Boolean));
  let nextFree = (used.size ? Math.max(...used) : 0) + 1;

  if (NEXT_ONLY) {
    console.log(`${kind}: 下一个可用编号 = ${String(nextFree).padStart(3, "0")}（文件名请写成 ${String(nextFree).padStart(3, "0")}-<短标题>${t.ext}）`);
    continue;
  }

  const byNum = new Map();
  for (const f of mains) {
    const n = numOf(f);
    if (!n) continue;
    if (!byNum.has(n)) byNum.set(n, []);
    byNum.get(n).push(f);
  }

  const plan = [];
  for (const [n, files] of [...byNum.entries()].sort((a, b) => a[0] - b[0])) {
    if (files.length < 2) continue;
    const withTime = files.map((f) => ({ f, m: fs.statSync(path.join(t.dir, f)).mtimeMs }))
                          .sort((a, b) => a.m - b.m);   // 最早 = 保留
    for (const { f, m } of withTime.slice(1)) {
      while (used.has(nextFree)) nextFree++;
      plan.push({ from: f, oldNum: n, newNum: nextFree, mtime: new Date(m).toISOString() });
      used.add(nextFree);
      nextFree++;
    }
  }

  if (!plan.length) { console.log(`${kind}: 无撞号 ✅`); continue; }
  console.log(`${kind}: 发现 ${plan.length} 处撞号，改号计划：`);
  for (const p of plan) console.log(`  [${p.oldNum}] → [${p.newNum}]  ${p.from.substring(0, 78)}`);
  if (!APPLY) { console.log("（dry-run，未改动文件；加 --apply 执行）"); continue; }

  for (const p of plan) {
    const src = path.join(t.dir, p.from);
    const newBase = p.from.replace(new RegExp(`^${p.oldNum}-`), `${p.newNum}-`);
    const dst = path.join(t.dir, newBase);
    // 1) 文件头编号
    let txt = fs.readFileSync(src, "utf8");
    txt = txt.replace(new RegExp(`^#\\s*${p.oldNum}\\s*[—:-]`), `# ${p.newNum} —`)
             .replace(new RegExp(`^#\\s*ISSUE\\s*[:：]?\\s*${p.oldNum}\\b`), `# ISSUE ${p.newNum}`);
    // 2) 插入改号说明（紧跟标题行后的第一个空行前）
    const note = `> 改号：原 ${p.oldNum} 撞号（同号多个文件），按"撞号后到者改号"改为 ${p.newNum}（${new Date().toISOString().slice(0, 10)} fix-issue-collisions）`;
    if (!txt.includes("改号：原")) {
      const idx = txt.indexOf("\n\n");
      txt = idx >= 0 ? txt.slice(0, idx + 1) + note + "\n" + txt.slice(idx + 1) : txt + "\n" + note + "\n";
    }
    fs.writeFileSync(dst, txt);
    fs.unlinkSync(src);
    // 3) 配套文件跟着改号
    for (const c of all.filter((x) => x.startsWith(`${p.oldNum}-`) && isCompanion(x) && x !== p.from)) {
      const newC = c.replace(new RegExp(`^${p.oldNum}-`), `${p.newNum}-`);
      fs.renameSync(path.join(t.dir, c), path.join(t.dir, newC));
      console.log(`   配套文件同步: ${c} → ${newC}`);
    }
    console.log(`  已改号: ${p.from.substring(0, 60)} → ${newBase.substring(0, 60)}`);
  }

  if (REGEN && t.indexGen) {
    try {
      // 用 execFileSync 传数组参数：路径里有空格（"Agent Intelligence"），拼 shell 字符串会 MODULE_NOT_FOUND
      // （2026-09-11 实测，正是我在别处扫的那类坑，自己写工具时也踩了一次）
      require("node:child_process").execFileSync(process.execPath, [path.join(__dirname, "gen-issues-index.mjs")], { stdio: "inherit" });
    } catch (e) { console.error("gen-issues-index.mjs 失败: " + e.message); }
  } else if (t.indexGen) {
    console.log("提醒: INDEX 未更新，跑 `node C.deploy/gen-issues-index.mjs` 重新生成（或加 --regen）");
  }
}
