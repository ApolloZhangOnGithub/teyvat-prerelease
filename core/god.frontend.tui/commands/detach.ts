// god.frontend.tui/commands/detach.ts
// /h（hide）— 隐藏显示但保持运行（TUI → headless 后台，PROPOSAL 034 阶段 4/5）
// 2026-08-20（用户需求：关闭显示但不关闭运行，闭环「运行+显示 ⇄ 运行+不显示」；用户定稿命令名 /h）
// 2026-08-20 第二次重构：spawn 方案（根治 Ctrl+C 复活前台）——
//   旧实现写 wake-restart nonce 触发 launcher while 循环重启，但运行中的 launcher 读旧快照
//   （不认 DETACHED/headless 分支）→ 重启回前台 TUI + detached 残留（三个 agent 实测复现，用户暴怒）。
//   新实现：直接在当前进程 spawn headless 子进程（node --mode rpc < fifo + 日志，detached:true），
//   不写 nonce → launcher 检测 nonce 未变 → break → 用户回 shell；headless 子进程独立继续跑。
//   机制已在 C.deploy/verify-headless-spawn.cjs 验证（父退出后子进程存活 + fifo 读取正常）。
// ⚠️ 2026-08-20 08:45 修复：spawnHeadlessBg 原先用 require()（ESM 下未定义）→ Ctrl+C 转后台直接炸
//   （无 detached 无 spawn → [O]）。改为顶层静态 import（与项目 TS 风格一致，禁止 require）。
import { writeFileSync, mkdirSync, existsSync, openSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";

export async function detachHandler(_args: any, ctx: any) {
  // 2026-08-20 用户设计：/h 时对 agent 注入一条"已转后台"通知消息（用 Life Restarted 管线渲染，青绿 ✤）——
  // agent 知道自己被转 headless：用户不会看到运行过程，但运行一切不变（照常干活/收消息/回报）。
  try {
    (globalThis as any).__genshinSendCustomMessage?.(
      "display-hidden",
      "用户已把你转换为后台运行模式（/h）。用户不会看到你的运行过程，但你的运行一切不变：照常干活、照常收消息、照常回报。"
    );
  } catch (e) { console.error("[god.frontend.tui/commands/detach.ts] " + ((e as any)?.message || e)); }
  try {
    const pid = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
    if (pid) spawnHeadlessBg(pid, "user-detach");
  } catch (e) { console.error("[god.frontend.tui/commands/detach.ts] " + ((e as any)?.message || e)); }
  (globalThis as any).__genshinDetaching = true;
  ctx.shutdown();
}

// spawn headless 后台子进程（/h 与 Ctrl+C 共用；挂 globalThis 供 interactive-mode.js 调用）
export function spawnHeadlessBg(pid: string, reason: string): void {
  const home = homedir();
  const rcDir = join(home, ".teyvat/RuntimeCache", pid);
  mkdirSync(rcDir, { recursive: true });
  // detached 标记：用户 attach（genshin xxx）时识别 headless → 转回前台 TUI
  writeFileSync(join(rcDir, "detached"), JSON.stringify({ ts: new Date().toISOString(), reason }));

  // spawn headless 子进程：node -ne -e <index.ts> --mode rpc --session-dir <dir>
  // （与 launcher 启动命令一致；--mode rpc = 不实例化 TUI，rpc 常驻 + fifo 输入防 EOF）
  const nodeBin = process.execPath;
  const argvIdx = process.argv.findIndex((a: string) => a.endsWith("index.ts"));
  const indexTs = argvIdx >= 0 ? process.argv[argvIdx] : join(process.env.PAIMON_EXT || join(home, ".local/lib/teyvat/extensions/teyvat"), "index.ts");
  const sessionDir = join(home, ".teyvat/SessionData", pid);
  const fifoDir = join(home, ".teyvat/AgentFileData", pid);
  const logDir = join(home, ".teyvat/LogData", pid);
  mkdirSync(fifoDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const fifo = join(fifoDir, "headless-in");
  if (!existsSync(fifo)) execSync(`mkfifo "${fifo}"`);
  const logFile = join(logDir, "console.log");
  // 2026-09-11（prime-agent）：console.log 之前无上限，历史上单个长到 337MB。超过 32MB 先轮转成 .1（只留一代）。
  // 用 rename 而不是 truncate：正在写的旧进程跟着自己的 fd，不会被写坏。
  try {
    if (existsSync(logFile) && statSync(logFile).size > 32 * 1024 * 1024) renameSync(logFile, logFile + ".1");
  } catch { /* 轮转失败不影响 /h 转后台 */ }
  // fifo O_RDWR 打开（同时读写端，不阻塞 + 防 stdin EOF——launcher exec 3<> 等价物）
  const fdIn = openSync(fifo, "r+");      // → 子进程 stdin
  const fdWrite = openSync(fifo, "r+");   // → 子进程 fd 3（写端保持，防 EOF）
  const fdLog = openSync(logFile, "a");
  // 2026-08-20 09:23 修复：spawn 必须带 cli.js（RUNTIME_CLI）——`-ne -e` 是 pi CLI 的参数，不是 node 的；
  // 直接 `node -ne -e index.ts` → `node: bad option: -ne` → 子进程秒退 → Ctrl+C 转后台变 [O]。
  // 正确命令 = launcher 同款：`node <cli.js> -ne -e <index.ts> --mode rpc --session-dir <dir>`（已验证）。
  const cliJs = join(
    process.env.PAIMON_RUNTIME || join(home, ".local/lib/teyvat/runtime"),
    "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
  );
  const child = spawn(nodeBin, [cliJs, "-ne", "-e", indexTs, "--mode", "rpc", "--session-dir", sessionDir], {
    detached: true,
    stdio: [fdIn, fdLog, fdLog, fdWrite],
    // 2026-09-09（用户报：Ctrl+C 转后台的 agent 60 秒后"自然超时退出"——heart.ts L298 孤儿检测误杀）：
    // 孤儿检测（启动 60s 后 ps TTY="??" → shutdown）只放行 PAIMON_HEADLESS_DAEMON=1 的合法 headless。
    // launcher.sh /h 路径设了此标志，但这里（Ctrl+C 转后台 spawn）漏了——spawn 的 headless 无 TTY →
    // 60 秒后被当孤儿 shutdown（用户实测 1b 状态自然超时退出）。补上 daemon 标志 = 声明合法 headless，不自然退出。
    env: { ...process.env, PI_ALIVE_RESTART_LOOP: "1", PAIMON_HEADLESS_DAEMON: "1" },
  });
  child.unref(); // 父进程（本 TUI）退出后子进程独立存活
  // 2026-09-11（prime-agent）：spawn 失败是异步 error 事件，无监听 → 未处理 'error' → 进程闪退。
  // 这里失败时至少留一条明确日志（否则用户以为"已转后台"，实际什么都没起）。
  child.on("error", (e: any) => {
    console.error("[god.frontend.tui/commands/detach.ts] 后台 headless 启动失败: " + (e?.code || e?.message || e));
  });
  (globalThis as any).__genshinSpawnedHeadless = child.pid; // 记录供 attach 杀残留
}

// 挂全局桥（interactive-mode.js 的 Ctrl+C 用同一实现）
(globalThis as any).__genshinSpawnHeadlessBg = spawnHeadlessBg;
