# check-sync-blocking.cjs.SPEC

## 目的
禁止 agent 运行时工具（spirit.bio.organs + spirit.bio.abilities，模型可调、跑在 agent loop 里）
使用同步子进程调用：`execSync` / `execFileSync` / `spawnSync`。
同步子进程每次都会阻塞事件循环，导致 agent 卡住（历史：syntaxCheck 的 bun build ~1s、
OCR 探测 15s、fileacts xattr 2s timeout——都是"快返回假象 + 等 wait 才回"的同一类根源）。

## 检查范围
- 扫描目录：`A.core/spirit.bio.organs` + `A.core/spirit.bio.abilities`（含子目录，.ts/.js）。
- 排除：`@ABANDONED.*` 目录（死代码）、`node_modules`、`.git`。
- CLI（`god.frontend.cli`）不在扫描范围——那些是一次性命令（genshin doctor / archive 等），
  不在 agent loop 里，同步调用是合法且必要的。

## 判定
- 正则 `\b(execSync|execFileSync|spawnSync)\s*\(` 命中即 FAIL。
- 先剥 `//` 行注释 + `/* */` 块注释，避免历史注释（如"原 execSync 阻塞"）误报。

## 修复方式
- 改用异步 `execFile` / `execFileAsync`（如 fileacts.ts 的 `execFileP` helper），
  或 Promise 包装，绝不同步 spawn。

## 关联
- 用户 2026-09-24 定稿："非异步方法全禁，确保没有 agent 可以调用相关方法"。
- 同期修复：webacts.ts backgroundPush 补 `deliverAs:"interrupt"` + `elapsedSec`；
  executes.ts 失败路径 followUp→interrupt；fileacts.ts xattr execFileSync→execFile。
