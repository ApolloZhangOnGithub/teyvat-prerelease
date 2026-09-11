#!/usr/bin/env node
// check-upload-policy.cjs — web({op:'upload'}) 的路径策略（防"任意本地文件被上传外泄"）
// 2026-09-11 prime-agent 发现：upload 原来是"读任意本地文件 → POST /auth/files → 打印 24h 链接+密码"，
//   没有任何路径限制 → ~/.ssh/id_rsa、~/.teyvat/UserAccount/binding.json、别的 agent 的 MemoryData
//   都能被上传并获得可分享链接（提示注入可直接利用）。本门禁确保策略在位且仍然有效。
//
// 用法: node C.deploy/check-upload-policy.cjs [A.core 路径]（已接 Makefile _integrity）
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const f = path.join(core, "spirit.bio.organs/hands.webacts/webacts.ts");
if (!fs.existsSync(f)) { console.error("[upload-policy] FAIL: 找不到 " + f); process.exit(1); }
const src = fs.readFileSync(f, "utf8");
let bad = 0;
const need = (name, re) => { const ok = re.test(src); if (!ok) bad++; console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`); };

console.log("[upload-policy] 静态：");
need("策略函数 uploadPathVerdict 存在", /function uploadPathVerdict\(/);
need("凭据类拒绝模式表存在", /const UPLOAD_DENY_PATTERNS = \[/);
need("他人数据目录正则存在（捕获 8 位 hex agent id）", /PRIVATE_DATA_RE = [^\n]*\/\(\[0-9a-f\]\{8\}\)\\\//i);
need("策略在 readFileSync(resolved) 之前执行（顺序断言）",
  new RegExp("uploadPathVerdict\\(resolved[\\s\\S]{0,600}?readFileSync\\(resolved\\)"));
need("被拒 → isError 且不发起上传（在此之前无 fetch）",
  /upload refused[\s\S]{0,200}?isError: true/);
// 注意：源码里的正则字面量带转义（如 \.config\/gh\/）——所以按"字面量"匹配，不按正则匹配
for (const [label, marker] of [
  ["覆盖 ~/.ssh", "\\.ssh\\/"], ["覆盖 ~/.aws", "\\.aws\\/"], ["覆盖 gh 配置", "config\\/gh\\/"],
  ["覆盖 ~/.gnupg", "\\.gnupg\\/"], ["覆盖 ~/.codex", "\\.codex\\/"], ["覆盖 ~/.claude*", "\\.claude"],
  ["覆盖 ~/.teyvat/UserAccount", "UserAccount\\/"], ["覆盖私钥/证书后缀", "(pem|key|p12|pfx|keystore)"],
  ["覆盖 *.json 凭据名", "(binding|auth|credentials|token|secrets)"],
  ["覆盖 .env*", "\\.env"], ["覆盖 authorize.json 等授权文件", "authorize|auth|env-keys"],
]) need(label, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

// ── 动态：把真实策略块抽出来跑用例 ──
let policy = null;
try {
  const s = src.indexOf("const UPLOAD_DENY_PATTERNS");
  const fnStart = src.indexOf("function uploadPathVerdict", s);
  let depth = 0, end = -1;
  // 注意：签名行尾是 `): { ok: boolean; reason?: string } {` —— 第一个 `{` 是**返回类型**的括号，
  // 真正的函数体括号是这一行的**最后一个** `{`（第一版抽错导致动态用例全挂）
  const sigLineEnd = src.indexOf("\n", fnStart);
  const bodyBrace = src.lastIndexOf("{", sigLineEnd);
  for (let k = bodyBrace; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  policy = src.slice(s, end).replace(/^export /m, "");
} catch (e) { console.log("  FAIL  抽取策略块失败: " + e.message); bad++; }

const CASES = [
  ["~/.ssh/id_rsa", false, "deny"], ["~/.teyvat/UserAccount/binding.json", false, "deny"],
  ["~/.codex/auth.json", false, "deny"], ["~/.teyvat/config/authorize.json", false, "deny"],
  ["~/Proj/.env", false, "deny"], ["~/work/server.pem", false, "deny"], ["~/.claude.json", false, "deny"],
  ["~/.teyvat/MemoryData/SELF/ctx.md", false, "allow"], ["~/.teyvat/MemoryData/OTHER/ctx.md", false, "deny"],
  ["~/.teyvat/MemoryData/OTHER/ctx.md", true, "allow"], ["/tmp/report.pdf", false, "allow"],
  ["~/Documents/photo.png", false, "allow"], ["~/notes.md", false, "allow"],
];
if (policy) {
  const H = "/Users/tester", SELF = "af5c5269";
  const body = policy + "\n" + CASES.map(([p, tr]) =>
    `console.log(uploadPathVerdict(${JSON.stringify(p.replace(/^~/, H).replace("SELF", SELF).replace("OTHER", "60ba86e9"))}, SELF_ID, ${tr}).ok ? "allow" : "deny");`
  ).join("\n").replace(/SELF_ID/g, `"${SELF}"`);
  const tmp = path.join(os.tmpdir(), "upload-policy-probe.ts");
  fs.writeFileSync(tmp, body);
  let r = cp.spawnSync(process.execPath, [tmp], { encoding: "utf8" });
  if (r.status !== 0) r = cp.spawnSync(process.execPath, ["--experimental-strip-types", tmp], { encoding: "utf8" });
  const lines = String(r.stdout || "").trim().split("\n");
  if (r.status !== 0 || lines.length !== CASES.length) {
    console.log(`  SKIP  动态用例未跑（运行时 ${process.version} 不支持 --experimental-strip-types？status=${r.status}）`);
  } else {
    console.log("[upload-policy] 动态用例（真实策略块）：");
    CASES.forEach(([p, tr, want], i) => {
      const ok = lines[i].trim() === want;
      if (!ok) bad++;
      console.log(`  ${ok ? "OK  " : "FAIL"} ${want === "deny" ? "拒" : "放行"} ${p}${tr ? "（trusted）" : ""}`);
    });
  }
  try { fs.unlinkSync(tmp); } catch {}
}
if (bad) { console.error(`[upload-policy] FAIL: ${bad} 项`); process.exit(1); }
console.log("[upload-policy] PASS — 凭据类一律拒、他人数据目录默认拒、正常文件放行");
