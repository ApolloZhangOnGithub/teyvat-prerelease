#!/usr/bin/env node
// check-symbol-ascii.cjs —— Windows 系终端符号 ASCII 门禁（2026-09-16 dev-01）
// 根因族：Windows 系终端（原生 win32/WSL/Windows Terminal）+ CJK 字体下，East Asian Ambiguous 字符（→ ✳ 等
// U+2190-21FF/U+23xx/U+25xx）实际渲染 2 格，但 visibleWidth 按 1 格算 → 行溢出 → 终端硬折 → 续行 col 0 顶头。
// 用户就同一根因报过两次：✳ 变 emoji、→ 折行顶头。靠人眼看代码抓不住，本门禁在 make 时校验：
// blocks_nongod.js 的 SYM 定义 Windows 系分支（三元第一分支，_needsAsciiSym）所有字符串值必须全可打印 ASCII（U+0020-7E）。
// Mac 分支（⏺◆◇⎿ 等在 Mac 终端 1 格）不拦（否则误伤 Mac 正常符号）。
const fs = require("fs");
const path = require("path");

const core = process.argv[2];
if (!core) { console.error("usage: check-symbol-ascii.cjs <A.core>"); process.exit(1); }

const file = path.join(core, "god.tui/ui_elements/blocks_nongod.js");
const content = fs.readFileSync(file, "utf8");

// 提取 SYM 定义的 Windows 系分支（不绑定变量名，按结构 export const SYM = <cond> ? { ... } : {...} 定位，跨行）
const m = content.match(/export const SYM\s*=\s*[^?]*\?\s*(\{[^}]*\})/);
if (!m) {
  console.error("  ERROR: 找不到 blocks_nongod.js 的 SYM 定义（结构变了？）");
  process.exit(1);
}

const asciiBranch = m[1];
// 提取所有字符串值 key: "value"
const vals = [...asciiBranch.matchAll(/:\s*"([^"]*)"/g)].map((x) => x[1]);

// fail-closed：解析偏了（键数不对）必须报错，绝不静默通过
if (vals.length !== 8) {
  console.error(`  ERROR: SYM 定义解析异常（期望 8 个符号 dot/diamond/diamondOpen/result/star/snow/prompt/arrow，实际 ${vals.length} 个——结构变了？）`);
  process.exit(1);
}

const bad = [];
for (const v of vals) {
  // 禁转义："\u2192" 文本层是 ASCII 但运行时是 →，能绕过上面的 ASCII 检查
  if (v.includes("\\")) {
    bad.push(`"${v}" 用了转义写法（可绕过 ASCII 检查，运行时可能是宽字符）`);
    continue;
  }
  for (const ch of v) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code > 0x7e) {
      bad.push(`"${v}" 含非 ASCII 字符 U+${code.toString(16).toUpperCase()}（${ch}）`);
      break;
    }
  }
}

if (bad.length > 0) {
  console.error(`  ERROR: SYM Windows 系分支含非 ASCII 符号（ambiguous/emoji 在 Windows Terminal+CJK 下渲染 2 格但 visibleWidth 算 1 格 → 行溢出终端硬折续行顶头）: ${bad.join("、")}`);
  console.error(`         改法：换成真 ASCII（如 result ">" 而非 "→"）。见 blocks_nongod.js SYM 定义注释。`);
  process.exit(1);
}
console.log(`  ✓ SYM Windows 系分支 ${vals.length} 个符号全 ASCII`);
