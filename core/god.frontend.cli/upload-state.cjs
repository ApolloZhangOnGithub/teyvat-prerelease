#!/usr/bin/env node
// upload-state.cjs — 设备 genshin 结果上传（独立进程，genshin d spawn detached 调用；2026-09-05）
// 跑本机 genshin（无参 agent 列表输出）→ POST /auth/device-state → 本地同步日志
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const h = os.homedir();

let b;
try { b = JSON.parse(fs.readFileSync(h + "/.teyvat/UserAccount/binding.json", "utf8")); } catch { process.exit(0); /* 未绑定直接退出 */ }
if (!b?.token || !b?.deviceId) process.exit(0);

let ep = "https://sync.paimon.beer";
try { const s = JSON.parse(fs.readFileSync(h + "/.teyvat/UserAccount/services.json", "utf8")); if (s.services && s.services["genshin-sync"] && s.services["genshin-sync"].endpoint) ep = s.services["genshin-sync"].endpoint; } catch { /* 缺失/损坏 → 默认 */ }

const gbin = process.env.GENSHIN_BIN || h + "/.local/bin/genshin";
execFile(gbin, [], { encoding: "utf8", timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, async (err, stdout) => {
  if (err || !stdout || !stdout.trim()) process.exit(0);
  const out = stdout.trim();
  try {
    await fetch(ep + "/auth/device-state", {
      method: "POST",
      headers: { Authorization: "Bearer " + b.token, "X-Device-Id": b.deviceId, "X-Device-Name": os.hostname(), "Content-Type": "application/json" },
      body: JSON.stringify({ agents: out }),
    });
    // 本地同步日志（保留最近 30 个活跃日）
    const logF = h + "/.teyvat/LogData/sync-device.jsonl";
    fs.mkdirSync(h + "/.teyvat/LogData", { recursive: true });
    fs.appendFileSync(logF, new Date().toISOString() + " " + os.hostname() + "\n");
    const lines = fs.readFileSync(logF, "utf8").split("\n").filter(Boolean);
    const seen = new Set(); const keep = [];
    for (let i = lines.length - 1; i >= 0 && seen.size < 30; i--) {
      const d = String(lines[i]).slice(0, 10);
      if (!seen.has(d)) { seen.add(d); keep.unshift(lines[i]); }
    }
    if (keep.length < lines.length) fs.writeFileSync(logF, keep.join("\n") + "\n");
  } catch { /* 上传/日志失败静默（下次活跃再试） */ }
  process.exit(0);
});
setTimeout(() => process.exit(0), 25000); // 兜底退出
