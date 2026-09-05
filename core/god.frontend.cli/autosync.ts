// autosync.ts — 自动同步入口，launcher 在启动前/退出后调用
// 用法: bun autosync.ts pull|push|lock|unlock|presence|devices|status [--quiet] [agentId]
// ===== [云同步统一开关管理 2026-09-05] =====
// 多电脑暂时不需要同步 agent（原禁用 2026-08-18 云端机制无法正常工作）。
// 全部 sync 代码保留（不删除），由 ~/.teyvat/config/settings.json 的 syncEnabled 统一开关控制：
//   false（默认）= 禁用（本入口提示后退出）；true = 恢复完整同步逻辑。
// launcher.sh 的调用点（genshin sync 命令 + 启动钩子 push/pull/heartbeat）同样读此开关。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getBinding } from "../god.backend.services/binding.ts";
import { pull, push, scanSyncFiles, acquireLock, releaseLock, getPresence, subscribePresence } from "../god.backend.services/client.ts";

const cmd = process.argv[2];
const quiet = process.argv.includes("--quiet");
const agentId = process.argv.find(a => !a.startsWith("--") && a !== cmd && a !== process.argv[1]) || "";

function log(msg: string) { if (!quiet) console.error(`  [sync] ${msg}`); }

// 统一开关：~/.teyvat/config/settings.json 的 syncEnabled（true 才启用云同步）
function cloudSyncEnabled(): boolean {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".teyvat/config/settings.json"), "utf8"));
    return s.syncEnabled === true;
  } catch { return false; }
}

async function main() {
  if (!cloudSyncEnabled()) {
    console.error("  [sync] Cloud sync disabled (settings.json syncEnabled=false). 恢复: ~/.teyvat/config/settings.json 设 \"syncEnabled\": true");
    process.exit(0);
  }
  const binding = getBinding();
  if (!binding?.token) {
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
