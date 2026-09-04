#!/usr/bin/env node
// verify-headless-spawn.cjs — 验证"转后台 spawn headless 子进程"机制可行性（不启动真实 agent）
// 验证点：① spawn detached 子进程（父退出后存活）② fifo 读端 stdin + fd3 O_RDWR 写端（防 EOF）
//         ③ echo > fifo 子进程能读到 ④ stdout/stderr → 文件
// 规则：不写 /tmp（用户定稿）；测试输出用 ~/.teyvat/LogData/headless-spawn-test/
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const outDir = path.join(os.homedir(), ".teyvat", "LogData", "headless-spawn-test");
fs.mkdirSync(outDir, { recursive: true });
const fifo = path.join(outDir, "headless-in");
const logFile = path.join(outDir, "out.log");
try { fs.unlinkSync(fifo); } catch {}
require("child_process").execSync(`mkfifo "${fifo}"`);

// 子进程：读 stdin（fifo），每 2s 心跳，永驻
const childSrc = `
const fs = require('fs');
const out = '${logFile}';
fs.appendFileSync(out, '[child] started pid=' + process.pid + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => fs.appendFileSync(out, '[child] got: ' + d.trim() + '\\n'));
setInterval(() => fs.appendFileSync(out, '[child] alive ' + Date.now() + '\\n'), 2000);
`;
const fdRead = fs.openSync(fifo, "r+");      // O_RDWR（读+写端同时打开，fifo 不阻塞——单开读端会等写端死锁）→ 子进程 stdin
const fdWrite = fs.openSync(fifo, "r+");    // 另一个 O_RDWR 写端 → 子进程 fd 3（防 stdin EOF）
const fdLog = fs.openSync(logFile, "a");

const child = spawn(process.execPath, ["-e", childSrc], {
  detached: true,
  stdio: [fdRead, fdLog, fdLog, fdWrite],   // fd0=stdin(fifo读), fd1/2=log, fd3=fifo写端
});
child.unref();
console.log("spawned child pid:", child.pid);

setTimeout(() => {
  // 父进程退出（模拟转后台后父退出）——子进程应继续存活
  try { require("child_process").execSync(`printf 'hello-from-parent' > "${fifo}"`); } catch (e) {}
  process.exit(0);
}, 3000);
