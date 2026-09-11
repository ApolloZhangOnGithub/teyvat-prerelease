# check-fileacts-guard.cjs.SPEC

用途: 门禁 —— `hands.fileacts` 的 `validateExecute()` 对「**其他人**的数据目录」的权限守卫，做对抗性回归测试。

背景（2026-09-11 prime-agent）：用**真实函数**跑对抗用例，对非 root agent 实测出三个绕过：

| # | 绕过 | 例子 | 当时结果 |
|---|---|---|---|
| A | **绝对路径**：守卫只认 `~/` 与 `$HOME/` 写法 | `cat /Users/<user>/.teyvat/MemoryData/<other>/context.md` | ALLOWED（应为 BLOCKED） |
| B | **自己+他人混在同一条命令**：命中自己 id 就整条放行 | `cat ~/.teyvat/MemoryData/<self>/x; cat ~/.teyvat/MemoryData/<other>/context.md` | ALLOWED |
| C | **夹带 `AppData/shared`**：命中 shared 就整条放行 | `ls ~/.teyvat/AppData/shared/; cat ~/.teyvat/MemoryData/<other>/context.md` | ALLOWED |

（基线用例本身是对的：纯他人目录 BLOCKED、纯自己目录 ALLOWED、`$HOME` 写法 BLOCKED、`cd` 进他人目录后相对读 BLOCKED。）
**注意 root:true 的 agent 本来就全放行（设计如此）**——测试必须用非 root 的 selfId，否则测不出守卫（我第一版就踩了这个坑）。

修复（同日在 `fileacts.ts`）：① 先把字面 home 路径归一化成 `~` 再匹配；② 先抽出命令里**所有** agent id，
只有"没有任何外来 id"时才允许"自己的目录 / `AppData/shared`"放行；③ 括号边界复核过（曾差点写成"普通命令也拦"）。

本门禁：
1. **静态**：三处防绕过特征必须存在于源码（被回退/删掉 → FAIL）
2. **动态**：真实 `validateExecute()` 跑 **14 个用例** —— 既有"必须拦"的（3 类绕过 + 3 个他人目录变体），
   也有"必须放行"的（普通命令、源码读取、`make` 豁免、自己的目录含绝对路径、`AppData/shared`）
   → **既防绕过复活，也防"一律拦截"把正常用法打死**
3. node 不支持 `--experimental-strip-types` 时动态部分 SKIP（静态仍拦截）；探针执行异常则 FAIL

用法: `node C.deploy/check-fileacts-guard.cjs [A.core 路径]`（已接进 Makefile `_integrity`）

失败处理: 输出逐行 `OK/FAIL + BLOCKED/ALLOWED + 用例名`，按上表核对是"绕过复活"还是"误拦正常用法"。
