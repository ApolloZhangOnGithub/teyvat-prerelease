# check-atomic-writes.cjs.SPEC

用途: 门禁 —— 「内容被别处解析/展示的状态文件」必须原子写（tmp + rename），防"读到 0 字节/半截内容"。

来历: 2026-09-11 ISSUE 182。线上实例：`main.pid` 0 字节 → `parseInt("")=NaN` → 活跃判定失效（判离线）
+ 启动守卫放行（`process.kill(NaN,0)` 抛错被吞）→ 同 sid **双实例**。根因之一就是 `writeFileSync`
是「open('w') 截断 → write」两步，读者可能落在窗口里。

用法: `node C.deploy/check-atomic-writes.cjs [A.core 路径]`（已接进 Makefile `_integrity`，约 0.06s）

检查口径（两条都查）:
1. **负向**：任何 `writeFileSync(...)` 命中 CRITICAL 列表里的目标 → 该行必须已经用 `writeFileAtomic(` 或附近 3 行内有 `renameSync`；
   否则 FAIL 并打印行号 + 建议改法
2. **正向**：每个 CRITICAL 目标必须**存在**原子写调用；如果实现换了写法导致找不到 → FAIL
   （防"把原子写删了但没人发现"—— 门禁必须能失败，已用负向夹具验证过会 exit 1）

CRITICAL（内容型，必须原子）: `main.pid`（cli.ts / heart.ts）、`last-orgs`、`full-restart`、
`self-reboot-reason.json`、手机态 `phone-state`（cli/mobile.ts 与 mobile system.kernel）、`scFlag`

EXEMPT（**只判存在性**的标志文件，允许非原子写，登记在脚本里说明原因）:
`paused`、`main-resting`、`detached`、`wake-at`、`wake-until`、`wake-restart`、`pauseFile`、hibernate tag、reboot nonce

公共实现: `A.core/paths.ts` 的 `writeFileAtomic(file, data)`（同目录 tmp + rename；同盘 rename 原子）。
新增"被并发读"的状态文件时：优先用它，并把目标登记进 CRITICAL。
