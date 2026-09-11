# check-numbering.cjs.SPEC

用途: 门禁 —— 保证「`genshin` 列表显示的序号」与「`genshin N` 实际解析到的 agent」永远一致。

为什么需要（ISSUE 192）: 序号在三处**独立**实现：
1. `god.frontend.cli/list.cjs`（显示编号）
2. `god.frontend.cli/launcher.sh` 的 `ENTRY=` 片段（启动解析：`genshin N`）
3. 同文件的 `_resolve_active_arg()`（kill/tmux/mc/hc 解析）
任何一处判据漂移 → **选错 agent**（用户 2026-09-11 实测报过；2026-08-15 / 09-05 / 09-07 各修过一次同类漂移）。

用法: `node C.deploy/check-numbering.cjs [A.core 路径]`（已接进 Makefile `_integrity`）

怎么做（fail-closed，测真实实现而不是复述规则）:
1. 造临时 `PAIMON_HOME` 夹具：5 个 agent 覆盖会暴露分歧的状态组合，关键是
   **active + paused/hibernate 但没有 detached**（2026-09-11 发现的分歧点：
   list.cjs 按状态串把 `[H]/[P]/[B]` 都归 B 组，旧 launcher 只按 detached 判 → 归 F 组 → 序号错位）
2. 跑**真实** `list.cjs`，从它的输出解析 `序号. 名字`（映射 A）
3. 从 `launcher.sh` 抽**真实**的 `ENTRY` / `_resolve_active_arg` 代码片段，按同样序号问它们（映射 B）
4. A == B 才算通过；**抽不到片段 / 跑不起来 → 直接失败**（不许静默通过 —— 静默假绿比报错更坏，见 Experiences/012）
5. 额外结构化检查：三处引用的"状态文件集合"必须一致（`detached` / `paused` / `main-hibernate`）

判据口径（改任何一处前先看这里）:
- **分组**（决定组内序号）: active && (detached || paused || main-hibernate) → B 组；否则 active → F 组；非 active → O 组
- **排序**（决定组内先后）: active 优先 → `_fb`（**只**看 detached）升序 → `_ago`（`lastEnded||lastSeen`）升序
  ⚠️ 排序键与分组键是**两个不同的东西**：2026-09-11 我第一次修就是只用了一个 `_b`，被本门禁的夹具抓出
  「hib-foreground 与 detached-bg 的 2b/3b 互换」

失败处理: 输出会逐行列 `列表=... 启动解析=... kill解析=...` 并标 MISMATCH，按上面的口径对齐三处实现。
