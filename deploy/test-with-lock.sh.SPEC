# test-with-lock.sh.SPEC

用途: `with-lock.sh`（构建串行化锁）的回归用例。改了 with-lock.sh 就跑它。

来历: 2026-09-11 的孤儿锁事故——一次被 kill -9 的 make 在 prerelease 子步骤留下孤儿锁，
三个排队构建按 STALE_AFTER=1800 干等 30 分钟，而现场看起来和"正在构建"一模一样。
详见 `B.docs/Dev.Common/Experiences/011-构建锁卡死30分钟-kill-9孤儿锁与只按时间判死锁.EXPERIENCE`。

用法: `bash C.deploy/test-with-lock.sh`（测的就是同目录的 with-lock.sh；零依赖，全程在 /tmp 沙箱里跑，不碰真实构建）

| 用例 | 期望 |
|---|---|
| T1 三个并发 | 串行执行，START/END 区间零重叠 |
| T2a 持有者被 kill -9 后等待者接管 | STALE=1800 下也要在几秒内接管（旧脚本要 1800s） |
| T2b 等待者启动时持有者已死 | 首轮立刻接管 |
| T3 旧格式锁（只有 started、无 pid）未过期 | 不抢（等满阈值再兜底） |
| T4 锁目录存在但无任何文件 | 按目录 mtime 兜底接管，不许永久死等 |
| T5 pid 被复用（活进程但不是 with-lock.sh） | 判定为 dead，立刻接管 |
| T6 活 owner 构建 20s（STALE=4） | 不抢占，只告警；owner 跑完后等待者才拿到锁 |

失败处理: 用例输出 FAIL/未拿到锁 即回归；先看 `with-lock.sh` 的三态判定（alive/dead/unknown）是否被改坏。
注意: 断言看的是"有没有并发重叠 + 接管理耗时"，时间阈值在用例里用 MAKE_LOCK_STALE 显式给，不受生产默认值影响。
