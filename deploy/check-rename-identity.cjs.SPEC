# check-rename-identity.cjs.SPEC

用途: 门禁 —— `genshin rename <old> <new>` 必须**同时**改 plist 的 `name` 和 `identity.json` 的 `name`。

来历: 2026-09-11 ISSUE 195。`cli.ts` 的 `cmdRename` 原来只改 plist + 追加 `renameHistory`，**漏了 `idData.name`**
→ doctor 的 `plist-identity` 永久报不一致。线上实例 `60ba86e9`：
`plist=genshin-v0.3-system-01` vs `identity.json=genshin-ecosystem-01`（而 renameHistory 里明明记着这次改名）。
同一文件的"创建同名孤儿"路径写对了 `idData.name` —— 改名路径漏了，属典型"兄弟分支漏同步"。

用法: `node C.deploy/check-rename-identity.cjs [A.core 路径]`（已接进 Makefile `_integrity`）

两条检查:
1. **静态（始终执行，fail-closed）**：从 `cli.ts` 抽 `cmdRename` 主体，断言
   - 有 `idData.name = newName`
   - identity.json 用原子写（`writeFileAtomic` / `renameSync`）——它被 doctor / infos / sync 读取，半截 JSON 会 parse 失败
   抽不到 `cmdRename` → FAIL（实现改了就得同步 gate）
2. **动态（best-effort）**：在临时 `PAIMON_HOME` 里跑**真实** `cli.ts rename`，断言 plist.name、identity.json.name、
   renameHistory 三处都更新了。
   若本机 node 不支持 `--experimental-strip-types` → 明确打 `SKIP`（不 FAIL，避免老 node 上误红）；静态检查仍然拦截。

依赖前置：`cli.ts` 必须支持 `PAIMON_HOME`（2026-09-11 同一批加；launcher 始终 export 默认值，正常使用行为不变）。
