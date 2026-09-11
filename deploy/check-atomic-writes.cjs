#!/usr/bin/env node
// check-atomic-writes.cjs — 「被并发读的状态文件」必须原子写（tmp + rename）门禁
// 2026-09-11 prime-agent（ISSUE 182 附录"非原子写审计"的固化）
//
// 为什么：writeFileSync 是「open('w') 截断 → write」两步。读者落在窗口里会读到 **0 字节/半截内容**：
//   线上实例：main.pid 0 字节 → parseInt("")=NaN → 活跃判定失效 + 启动守卫放行 → 同 sid 双实例。
// 规则：凡「内容被别处解析/展示」的状态文件，一律用 `writeFileAtomic()`（paths.ts 提供，tmp+rename），
//   或在本行附近手写 tmp+rename。纯"存在性标志文件"（paused / detached / main-resting / wake-at …）不强制——
//   它们只看存在与否，读到空文件不影响语义（在下面 EXEMPT 里登记）。
//
// 用法: node C.deploy/check-atomic-writes.cjs [A.core 路径]（已接进 Makefile _integrity）

const fs = require("node:fs");
const path = require("node:path");

const core = path.resolve(process.argv[2] || path.join(__dirname, "..", "A.core"));

// 必须原子写的状态文件（源里出现的标识；匹配"写这些文件的 writeFileSync 调用"）
const CRITICAL = [
  { id: "main.pid", files: ["god.frontend.cli/cli.ts", "spirit.bio.organs/kernel.heart/heart.ts"],
    match: /writeFileSync\(\s*(_pfTmp|_pidTmp|_hbTmp|pidFile)/, why: "活跃判定 + 启动守卫（ISSUE 182）", atomicOk: /(writeFileAtomic\(|renameSync\(\s*(_pfTmp|_pidTmp|_hbTmp))/ },
  { id: "last-orgs", files: ["spirit.bio.organs/kernel.heart/heart.ts"],
    match: /writeFileSync\(\s*orgStateFile/, why: "被 TUI/launcher 读取", atomicOk: /writeFileAtomic\(\s*orgStateFile/ },
  { id: "full-restart", files: ["spirit.bio.organs/hands.executes/executes.ts"],
    match: /writeFileSync\(\s*join\(rcDir, "full-restart"\)/, why: "重启后 launcher 读取", atomicOk: /writeFileAtomic\(\s*join\(rcDir, "full-restart"\)/ },
  { id: "self-reboot-reason.json", files: ["spirit.bio.organs/hands.executes/executes.ts"],
    match: /writeFileSync\(\s*join\(rcDir, "self-reboot-reason\.json"\)/, why: "重启后 heart JSON.parse 读取", atomicOk: /writeFileAtomic\(\s*join\(rcDir, "self-reboot-reason\.json"\)/ },
  { id: "phone-state", files: ["god.frontend.cli/mobile.ts"],
    match: /writeFileSync\(\s*(PHONE_STATE_FILE|PHONE_SCREEN_FILE)/, why: "手机态被 TUI/手机读取", atomicOk: /writeFileAtomic\(\s*PHONE_(STATE|SCREEN)_FILE/ },
  { id: "phone-state(kernel)", files: ["universe.infotech/local.mobile/system.kernel/kernel.ts"],
    match: /writeFileSync\(\s*(_stateFile|_stateFile\.replace)/, why: "手机态 JSON（同族文件）", atomicOk: /writeFileAtomic\(\s*_stateFile/ },
  { id: "scFlag", files: ["spirit.bio.organs/brain.metaconsciousness/metaconsciousness.ts"],
    match: /writeFileSync\(\s*scFlag\(/, why: "scDisabled 用 JSON.parse 读它", atomicOk: /writeFileAtomic\(\s*scFlag\(/ },
];
// 存在性标志文件（只看存在与否，允许非原子写）——登记在此以说明"为什么豁免"
const EXEMPT = ["pauseFile", "wake-restart", "RuntimeCache/paused", "main-resting", "hibernate tag", "detached", "wake-at", "wake-until", "nonce"];

let bad = 0, checked = 0;
console.log("[atomic-writes] 被并发读的状态文件写入检查:");
for (const c of CRITICAL) {
  for (const rel of c.files) {
    const p = path.join(core, rel);
    if (!fs.existsSync(p)) { console.error(`  FAIL  找不到文件 ${rel}`); bad++; continue; }
    const lines = fs.readFileSync(p, "utf8").split("\n");
    if (c.atomicOk && !lines.some((l) => c.atomicOk.test(l))) {
      console.error(`  FAIL  ${rel} 找不到 ${c.id} 的原子写调用（writeFileAtomic / tmp+rename）—— 被并发读的文件必须原子写（${c.why}）`);
      bad++;
    }
    lines.forEach((line, i) => {
      if (!c.match.test(line)) return;
      checked++;
      const ctx = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
      const atomic = line.includes("writeFileAtomic(") || /renameSync|rename\(/.test(ctx);
      if (!atomic) {
        console.error(`  FAIL  ${rel}:${i + 1} 写 ${c.id} 用的是非原子 writeFileSync（${c.why}）→ 改用 writeFileAtomic()（paths.ts）`);
        console.error(`         ${line.trim().slice(0, 140)}`);
        bad++;
      } else {
        console.log(`  OK    ${rel}:${i + 1} ${c.id} → 原子写`);
      }
    });
  }
}
console.log(`[atomic-writes] 检查了 ${checked} 处写入（豁免的存在性标志文件: ${EXEMPT.length} 类）`);
if (bad) { console.error(`[atomic-writes] FAIL: ${bad} 处需要改原子写（读者可能读到 0 字节/半截内容）`); process.exit(1); }
console.log("[atomic-writes] PASS — 内容型状态文件都是原子写");
