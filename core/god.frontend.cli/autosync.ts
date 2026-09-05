// autosync.ts — 同步入口（已废弃，保留代码不删）
// 用法: bun autosync.ts pull|push|lock|unlock|presence|devices|status [--quiet] [agentId]
// ===== [云同步已废弃 2026-09-05，PROPOSAL 036 替代] =====
// 用户定稿：agent 单机存活（不做跨机状态同步），多机协作 = 各机自管 agent + 跨设备 social 通讯/发现。
// sync 文件同步概念退出，不提供启用路径——下方 main() 恒拒绝（import 与全部逻辑保留作参考）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getBinding } from "../god.backend.services/binding.ts";
import { pull, push, scanSyncFiles, acquireLock, releaseLock, getPresence, subscribePresence } from "../god.backend.services/client.ts";

const cmd = process.argv[2];
const quiet = process.argv.includes("--quiet");
const agentId = process.argv.find(a => !a.startsWith("--") && a !== cmd && a !== process.argv[1]) || "";

function log(msg: string) { if (!quiet) console.error(`  [sync] ${msg}`); }

// ══ 已废弃入口（2026-09-05，PROPOSAL 036）：agent 单机存活，跨机走 social——sync 恒拒绝 ══
async function main() {
  console.error("  [sync] Cloud sync deprecated (PROPOSAL 036: agents live per-machine, cross-device via social). Code kept as reference, not enabled.");
  process.exit(0);
}

// 原同步逻辑保留为独立参考函数（main 不调用；独立函数避免 unreachable 区破坏类型检查）。
// 不再建议恢复：036 已定 agent 单机存活架构，恢复 sync 需整体重构（publish/install + social 替代）。
async function originalSyncMain() {
  const binding = getBinding();
  if (!binding) { console.error("未绑定"); process.exit(1); }
  if (!binding.token) {
    if (cmd === "lock" || cmd === "unlock") { console.error("未登录"); process.exit(1); }
    if (!quiet) log("未登录，跳过同步"); process.exit(0);
  }

  try {
    if (cmd === "pull") {
      const result = await pull(binding);
      if (result.pulled > 0) {
        log(`拉取 ${result.pulled} 个文件:`);
        for (const f of result.pulledFiles) log(`  ← ${f}`);
      }
      if (result.tampered.length > 0) log(`本地修改: ${result.tampered.join(", ")}`);
    } else if (cmd === "push") {
      const { pushed, pushedFiles } = await push(binding);
      if (pushed > 0) {
        log(`推送 ${pushed} 个文件:`);
        for (const f of pushedFiles) log(`  → ${f}`);
      }
    } else if (cmd === "lock") {
      if (!agentId) { console.error("usage: bun autosync.ts lock <agentId>"); process.exit(1); }
      const result = await acquireLock(binding, agentId);
      if (result.ok) { if (!quiet) console.log("OK"); process.exit(0); }
      if (result.holder) { console.error(`LOCKED_BY:${result.holder}`); process.exit(2); }
      process.exit(1);
    } else if (cmd === "unlock") {
      if (!agentId) { console.error("usage: bun autosync.ts unlock <agentId>"); process.exit(1); }
      await releaseLock(binding, agentId);
      if (!quiet) console.log("OK");
    } else if (cmd === "heartbeat") {
      if (!agentId) { console.error("usage: bun autosync.ts heartbeat <agentId>"); process.exit(1); }
      // heartbeat = re-acquire (upsert refreshes timestamp)
      const result = await acquireLock(binding, agentId);
      if (!result.ok) { console.error(`LOCK_LOST:${result.holder || "unknown"}`); process.exit(2); }
      process.exit(0);
    } else if (cmd === "devices") {
      const devices = await getPresence(binding);
      if (devices.length === 0) { console.log("  没有在线设备"); }
      else {
        for (const d of devices) {
          const ago = Math.round((Date.now() - new Date(d.since + "Z").getTime()) / 60000);
          const agoStr = ago < 1 ? "刚刚" : `${ago}分钟`;
          console.log(`  ${d.personId}  ${d.deviceId}  在线 ${agoStr}`);
        }
      }
    } else if (cmd === "presence") {
      // 实时 watch（WebSocket 订阅）
      const devices = await getPresence(binding);
      const printDevices = (devs: typeof devices) => {
        process.stdout.write("\x1b[2J\x1b[H");
        if (devs.length === 0) { console.log("  没有在线设备"); }
        else {
          console.log("  在线设备:");
          console.log("");
          for (const d of devs) {
            const ago = Math.round((Date.now() - new Date(d.since + "Z").getTime()) / 60000);
            const agoStr = ago < 1 ? "刚刚" : `${ago}分钟`;
            console.log(`  ${d.personId}  ${d.deviceId}  ${agoStr}`);
          }
        }
        console.log("");
        console.log("  实时监听中... Ctrl+C 退出");
      };
      printDevices(devices);
      const cleanup = subscribePresence(binding, "presence-watcher", printDevices);
      process.on("SIGINT", () => { cleanup(); process.exit(0); });
      await new Promise(() => {}); // keep alive
    } else if (cmd === "status") {
      const files = scanSyncFiles();
      console.log(`  ${files.length} 个文件待同步`);
      for (const f of files.slice(0, 20)) console.log(`    ${f.path} (${f.size}B)`);
      if (files.length > 20) console.log(`    ... 共 ${files.length} 个`);
    } else {
      console.error("usage: bun autosync.ts pull|push|lock|unlock|heartbeat|presence|devices|status [--quiet] [agentId]");
      process.exit(1);
    }
  } catch (e: any) {
    if (!quiet) log(`同步失败: ${e.message}`);
    process.exit(1);
  }
}

main();
