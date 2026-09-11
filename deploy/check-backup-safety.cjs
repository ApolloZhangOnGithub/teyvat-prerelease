#!/usr/bin/env node
// check-backup-safety.cjs — 云备份（restic）链路的加固断言
// 2026-09-11 prime-agent 加固三件事，本门禁把这三件事钉住：
//   ① 下载 restic 原来「curl … | bunzip2 > restic && chmod +x」——**拿到什么就执行什么**（用用户的 AK + 仓库密码身份）。
//      现在钉死官方 SHA256SUMS（v0.19.1），用 node:crypto 自己算；不符 → 删文件 + 拒绝执行（fail-closed）。
//      darwin_arm64 那份**实测下载后算过哈希**：7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143（本门禁把它同时钉在断言里）
//   ② Windows 资产是 .zip，原代码拼 .bz2 → **实测 HTTP 404**（Windows 上永远下不动）；且 restic 需要 .exe 后缀
//   ③ 下载与 restic 调用加超时：cmdNow 是 bioclock detached 起的子进程，卡住没人看得见（状态永远停在 running）
//
// 用法: node C.deploy/check-backup-safety.cjs [A.core 路径]（已接 Makefile _integrity）
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));
const f = path.join(core, "god.frontend.cli/backup.ts");
if (!fs.existsSync(f)) { console.error("[backup-safety] FAIL: 找不到 " + f); process.exit(1); }
const raw = fs.readFileSync(f, "utf8");
// 去掉注释再断言"旧写法已消失"——否则注释里提到旧写法会误报（第一版就踩了）
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
let bad = 0;
const need = (name, re, invert = false) => {
  const hit = re.test(src);
  const ok = invert ? !hit : hit;
  if (!ok) bad++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
};
console.log("[backup-safety] static:");
// ① 校验和
need("RESTIC_SHA256 校验和表存在", /const RESTIC_SHA256: Record<string, \{ file: string; sha: string; kind: 'bz2' \| 'zip' \}> = \{/);
const shas = [...src.matchAll(/sha: '([0-9a-f]{64})'/g)].map((m) => m[1]);
{
  const okShas = shas.length >= 5 && shas.every((s) => /^[0-9a-f]{64}$/.test(s));
  if (!okShas) bad++;
  console.log(`  ${okShas ? "OK  " : "FAIL"} 校验和条目 ≥5 且都是 64 位十六进制（实测 ${shas.length} 条）`);
}
need("含 darwin_arm64 的**实测**校验和 7be0a144…", /7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143/);
need("含 darwin_amd64 / linux_amd64 / linux_arm64 / windows_amd64", /c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35[\s\S]*f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c[\s\S]*a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465[\s\S]*da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d/);
need("用 node:crypto 自己算哈希（sha256File）", /function sha256File\(p: string\): string \{/);
need("**顺序断言**：比对校验和在解压之前", /if \(got !== meta\.sha\)[\s\S]{0,1200}?bunzip2 -c/);
need("不符 → 删除下载文件", /if \(got !== meta\.sha\) \{[\s\S]{0,300}?fs\.rmSync\(tmpDl/);
need("不符 → 拒绝执行（return null）", /校验和不符[\s\S]{0,600}?return null;/);
need("旧的「curl | bunzip2 直接落地」已消失", /curl[^\n]*\|\s*bunzip2/, true);
// ② Windows
need("Windows 用 .zip 资产", /restic_\$\{RESTIC_VER\}_windows_amd64\.zip/);
need("Windows 解压走 unzip", /meta\.kind === 'zip'[\s\S]{0,200}?spawnSync\('unzip'/);
need("Windows 二进制带 .exe 后缀", /process\.platform === 'win32' \? 'restic\.exe' : 'restic'/);
// ③ 超时
need("下载带 --max-time", /'--max-time',\s*'300'/);
need("runRestic 带 timeout（防挂死）", /timeout: 30 \* 60_000/);
need("runRestic 带 killSignal", /killSignal: 'SIGTERM'/);
// 密钥纪律
need("密码文件写 600", /writeFileSync\(PASS_FILE, pw, \{ mode: 0o600 \}\)/);
need("凭证文件写 600", /writeFileSync\(CRED_FILE,[\s\S]{0,80}?mode: 0o600/);
need("密钥走 env（resticEnv）而不是 argv", /AWS_SECRET_ACCESS_KEY: cred\.accessKeySecret/);
need("restic 调用参数里不出现 AWS_SECRET（不进 ps 可见区）", /runRestic\([^)]*AWS_SECRET/, true);

// ── 动态：抽真实的 sha256File 验算 ──
let fn = null;
try {
  const i = src.indexOf("function sha256File(");
  let depth = 0, end = -1;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  fn = src.slice(i, end).replace(/: string/g, "").replace(/\(p\)/, "(p)");
} catch (e) { bad++; console.log("  FAIL 抽 sha256File 失败: " + e.message); }
if (fn) {
  const tmpF = path.join(os.tmpdir(), "bk-sha-probe.cjs");
  fs.writeFileSync(tmpF, [
    'const fs = require("node:fs");',
    'const { createHash } = require("node:crypto");',
    fn,
    `const p = ${JSON.stringify(tmpF + ".txt")};`,
    'fs.writeFileSync(p, "abc");',
    'const got = sha256File(p);',
    'const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";',
    'if (got !== want) { console.log("FAIL sha256File(abc)=" + got); process.exit(2); }',
    'fs.unlinkSync(p);',
    'console.log("ok");',
  ].join("\n"));
  const r = cp.spawnSync(process.execPath, [tmpF], { encoding: "utf8" });
  const okDyn = r.status === 0 && /ok/.test(String(r.stdout));
  if (!okDyn) bad++;
  console.log(`  ${okDyn ? "OK  " : "FAIL"} 动态：sha256File("abc") == 官方值 ba7816bf…（证明是按字节算文件哈希）`);
  try { fs.unlinkSync(tmpF); } catch {}
}
if (bad) { console.error(`[backup-safety] FAIL: ${bad} 项`); process.exit(1); }
console.log("[backup-safety] PASS — restic 下载有校验和、Windows 资产正确、外部调用有超时、密钥不进 argv");
