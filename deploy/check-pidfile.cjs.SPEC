# check-pidfile.cjs.SPEC

用途: 门禁 —— 保证 `main.pid` 的三类消费者不会因为"内容损坏"而做出错判（ISSUE 182）。

背景（线上实录）: `check-session-01`（379e262b）按设计跑了 2 天，但它的 `MemoryData/379e262b/main.pid`
是 **0 字节**（心跳每 30s 只 `futimes` 摸 mtime、`openSync(pf,"a")` 在文件缺失时还会**创建**空文件），于是：
1. `list.cjs` / `launcher` / `pad.cjs` 的活跃判定：`parseInt("")=NaN` → 判"离线" → 序号/分组错乱、agent 显示成离线
2. `cli.ts` 的"已在运行"守卫：`process.kill(NaN,0)` 抛错被 catch 吞掉 → **放行 → 启动第二个实例**（同 sid 双实例）

用法: `node C.deploy/check-pidfile.cjs [A.core 路径]`（已接进 `Makefile` `_integrity`，约 0.5s）

做什么（fail-closed，跑**真实源码片段**而不是复述规则）:
1. 从 `god.frontend.cli/cli.ts` 抽出启动守卫，夹具四例：
   - 空内容 + 心跳新鲜（≤90s）→ **必须拒绝启动**
   - 空内容 + 心跳陈旧（10 分钟）→ 允许启动（按残留文件覆盖）
   - 合法且存活的 pid → 拒绝启动
   - 合法但已死的 pid → 允许启动
2. 从 `spirit.bio.organs/kernel.heart/heart.ts` 抽出心跳片段，夹具三例（0 字节 / 缺失 / 旧 pid）→
   跑一次心跳后内容必须等于当前 pid（自愈）
3. 抽不到片段 / 片段跑不起来 → **直接失败**（实现改了就得同步 gate，不许静默通过）

注意: 抽出来的是 TS 片段，运行时用最小变换去掉纯类型语法（` as any` / `: any`）；变换后仍解析失败即 fail-closed。
判据口径: "心跳新鲜"= mtime ≤ 90s（与 list.cjs/launcher 的活跃窗口一致）；写入必须原子（tmp + rename）。

配套修复（同一提交）:
- `cli.ts`：守卫不再静默放行损坏内容（新鲜 → 拒绝并提示 `rm -f` 清理）；写入改原子（tmp+rename）
- `heart.ts`：心跳内容不等于自己的 pid 时原子补写（自愈历史遗留的 0 字节/旧 pid 文件）
