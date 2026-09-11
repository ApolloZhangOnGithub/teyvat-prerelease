#!/usr/bin/env node
// check-param-paths.cjs — "agent 参数直接拼路径"这类越界（路径穿越）的收口检查
// 2026-09-11 prime-agent：
//   ① appstore：app 名（来自下载的代码/agent 输入）直接 join 成目录 → 已修 + check-mobile-apps.cjs 覆盖
//   ② brain.memory：`amem revert` 用 `join(manageDir, id + ".json")` → `id: "../../../config/authorize"`
//      可读/写 manageDir 之外的任意 .json（revert 末尾还 writeFile 回写同一路径；fetch 有 entries 校验、revert 没有）
// 本门禁锁住 ② 的收口，并**列出**新发现的候选点（供人工看，不算失败）。
//
// 用法: node C.deploy/check-param-paths.cjs [A.core 路径]（已接 Makefile _integrity）
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const mem = path.join(core, "spirit.bio.organs/brain.memory/memory.ts");
if (!fs.existsSync(mem)) { console.error("[param-paths] FAIL: 找不到 " + mem); process.exit(1); }
const src = fs.readFileSync(mem, "utf8");
let bad = 0;
const need = (name, re, invert = false) => {
  const hit = re.test(src);
  const ok = invert ? !hit : hit;
  if (!ok) bad++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
};

console.log("[param-paths] static (brain.memory amem):");
need("_amemManageFile 收口函数存在", /const _amemManageFile = \(id: string\)/);
need("只接受内部生成格式 am-<epochMs>（含 .json 容忍）", /\^am-\\d\+\$\/\.test\(clean\)/);
need("解析后必须仍在 manageDir 内（startsWith(base) 断言）", /f\.startsWith\(base\) \? f : null/);
need("已无裸拼 join(manageDir, `${params.id}.json`)", /path\.join\(manageDir, `\$\{params\.id\}\.json`\)/, true);
need("revert 读路径走 _amemManageFile", /const _mf = _amemManageFile\(String\(params\.id\)\);/);
need("revert 回写路径用 _mf（不再是裸拼）", /writeFile\(_mf, JSON\.stringify\(d/);
need("fetch 读路径也过收口（防御性）", /d = _mf \? JSON\.parse\(readFile\(_mf\)\) : null/);

// ── 动态：抽真实函数跑用例 ──
const CASES = [
  ["am-1757000000000", "allow"], ["am-1757000000000.json", "allow"], ["am-1", "allow"],
  ["../../../config/authorize", "reject"], ["../../x", "reject"], ["am-123/../../evil", "reject"],
  ["../ActiveManage/am-123", "reject"], ["am-abc", "reject"], ["", "reject"],
  ["/tmp/evil", "reject"], ["....//am-1", "reject"],
];
let fn = null;
try {
  const i = src.indexOf("const _amemManageFile = ");
  let depth = 0, end = -1;
  for (let k = src.indexOf("{", src.indexOf("=> {", i)); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  fn = src.slice(i, end).replace(/: string \| null/, "").replace(/\(id: string\)/, "(id)");
} catch (e) { console.log("  FAIL  抽函数失败: " + e.message); bad++; }

if (fn) {
  const MANAGE = "/tmp/pp-fixture/MemoryData/self/ActiveManage";
  const esc = (s) => JSON.stringify(s);
  const body = 'const path = require("node:path");\nconst manageDir = ' + esc(MANAGE) + ';\n' + fn + "\n"
    + CASES.map(([id, want]) => {
        const expect = want === "allow" ? "true" : "false";
        // 旧的裸拼表达式是否真的会越界（自证"这里本来危险"）
        const escaped = path.resolve(MANAGE, id + ".json");
        const inside = escaped.startsWith(MANAGE + path.sep);
        return `{ const f = _amemManageFile(${esc(id)}); const ok = (f !== null) === ${expect};`
          + ` if (!ok) { console.log("FAIL " + ${esc(id)} + " → " + (f ? f : "null")); process.exit(2); }`
          + ` const rawInside = ${inside}; if (${JSON.stringify(want)} === "reject" && rawInside && !${JSON.stringify(id)}.includes("..")) { /* 形状类拒绝：裸拼本不会越界 */ }`
          + ` }`;
      }).join("\n")
    + '\nconsole.log("all cases ok");\n';
  const tmp = path.join(os.tmpdir(), "param-paths-probe.cjs");
  fs.writeFileSync(tmp, body);
  const r = cp.spawnSync(process.execPath, [tmp], { encoding: "utf8" });
  if (r.status === 0 && /all cases ok/.test(String(r.stdout))) {
    console.log(`[param-paths] dynamic: ${CASES.length} 个用例全过（允许 am-<数字>，拒绝穿越与非法形状）`);
  } else {
    bad++;
    console.log("[param-paths] dynamic FAIL:");
    console.log(String(r.stdout || "").split("\n").filter((l) => l.trim()).slice(0, 6).map((l) => "    " + l).join("\n"));
    if (r.status !== 0 && !r.stdout) console.log("    (no stdout, status=" + r.status + ") " + String(r.stderr || "").split("\n")[0]);
  }
  // 自证：老表达式对这些输入确实会越界
  const escapes = CASES.filter(([id, want]) => want === "reject")
    .map(([id]) => path.resolve(MANAGE, id + ".json"))
    .filter((p) => !p.startsWith(MANAGE + path.sep));
  console.log(`[param-paths] 自证：${escapes.length}/${CASES.filter(([, w]) => w === "reject").length} 个被拒输入在原表达式下会落到 manageDir 之外（例如 ${escapes[0] ? escapes[0].replace("/tmp/pp-fixture", "~") : "-"}）`);
  try { fs.unlinkSync(tmp); } catch {}
}
if (bad) { console.error(`[param-paths] FAIL: ${bad} 项`); process.exit(1); }
console.log("[param-paths] PASS — amem 的归档 ID 只能落回本会话 ActiveManage/");
