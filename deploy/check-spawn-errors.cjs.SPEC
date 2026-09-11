# check-spawn-errors.cjs.SPEC

用途: 门禁 —— 凡是 `child_process.spawn()` 都必须挂 `'error'` 监听。

## 为什么（2026-09-11 prime-agent）

Node 里 spawn 失败（ENOENT：二进制不存在）走的是**异步 `'error'` 事件**，不是 try/catch 能抓的同步异常。
没有监听 → `Unhandled 'error' event` → 未捕获异常。**本机实测**：

```
$ node /tmp/spawn-err-test.cjs          # spawn("definitely-not-a-real-binary-xyz") 无监听
node:events:505 throw er;  Error: spawn … ENOENT
exit=1                                   ← 进程直接死

$ node /tmp/spawn-err-test2.cjs         # 同一个 spawn，加了 .on("error", …)
handled error: ENOENT
still alive after 200ms   exit=0         ← 活着
```

本仓自己的注释已经记过这条链：`uncaughtException → SDK uncaughtCrash → process.exit(1) → 进程闪退`
（`spirit.bio.abilities/internet.fetch/fetch-clean.ts:92`）。

真实触发场景（修前 4 处裸 spawn）：
- **`brain.bioclock/bioclock.ts:183`** `spawn("bun", …)`：每日云备份。**每次 agent 启动**就会跑一次（L193）→
  没装 bun 的机器**一启动就闪退**；而且"先落状态后动作"的设计会让备份整天不再重试（静默跳过）。
- **`head.ears/ears.ts:79`** `spawn(BUN, …)`：录音。`BUN` 在 `which bun` 失败时**回落成字面量 `"bun"`**（L23）→ 同 ENOENT。
- `god.frontend.tui/commands/detach.ts:71`、`universe.infotech/local.mobile/apps/safari/safari.ts:101`：风险低（node 一定在），
  但失败时用户会以为"已转后台/浏览器服务在起"，实际什么都没起。

## 修法

四处都加 `.on("error", …)`：
- ears：日志写 `ear_debug.log` + `state.listening = false` + 清 `recorderProc`
- bioclock：日志 + **把 `backup-daily.json` 的 `last` 清空**（下一个 tick 重试，不再静默跳过一整天）
- detach / safari：明确日志（safari 还写 `_svcError` 供上层回显）

## 本门禁做什么

- 扫描所有 import 了 `node:child_process` 的 `.ts`，凡 `spawn(`/`_spawn(`（排除 `spawnSync`、`this.spawn(`、`#spawn(`）
  调用点后 **30 行内**必须出现 `.on("error"` / `.once("error"` → 否则 FAIL（fail-closed：新增调用点必须显式处理）
- 额外断言三处关键语义：ears 的"bun 缺失"文案、bioclock 的重试状态重置与失败日志
- 当前：**7 个调用点全部覆盖**

## 验证

- 正向：7 个调用点全过 + 3 项语义断言全过
- 负向（夹具）：把三处的 `on("error")` 行与文案行删掉 → 3 条扫描 FAIL + 3 条语义 FAIL → exit 1
- 局限：门禁是**行窗口**启发式（30 行），不是数据流分析 → 把一个真的 handler 挪到 40 行外会误报（可接受：宁可误报）
