# check-shell-injection.cjs.SPEC

用途: 门禁 —— 禁止把"**外部输入**"（agent 通过工具传进来的文本）拼进 **shell 字符串**（`execSync`/`exec` 的模板串）。

背景（2026-09-11 prime-agent 同日发现两处真注入面 + 一处脆弱点）:

| # | 位置 | 问题 |
|---|---|---|
| ① | `universe.infotech/local.mobile/apps/amap/amap.ts` | `execSync(`python3 ${SCRIPT} ${cmd}`)` —— `cmd` 是 agent 经 mobile 工具传的文本，**未加引号**；且这条路径**不经过** `validateExecute` → 等于绕过"禁 rm / 禁碰他人数据目录" |
| ② | `universe.infotech/local.mobile/apps/arxiv/arxiv.ts` | `execSync(`python3 "${TOOL}" "${query}" -n ${n}`)` —— `query` 是 agent 输入；双引号挡不住 `$()`/反引号展开，`query` 里带 `"` 还能破引号逃逸 |
| ③ | `god.frontend.cli/cli.ts` 的 `cmdNote` / spawn dev | `execSync(`node <脚本> <id> <JSON.stringify(msg)>`)`（JSON 引号挡不住 `$()`；`id` 未加引号）；spawn dev 虽当前 id/pname 受校验，上游放宽即变注入面 |

三处（含 `head.mouth` 的 `which ${c.cmd}`）已全部改为 **`execFileSync`/`spawnSync` + argv 数组**（完全不经 shell）✓。

判定: `execSync(`/`exec(` 的**那一个模板字符串**里若插值了"外部输入语义"的变量
（`params.*` / `args.*` / `msg` / `message` / `input` / `text` / `cmd` / `command` / `body` / `payload` / `query` / `keyword` / `name` / `pname` / `userInput` / `raw`）→ FAIL。
- 只看 exec 后面的第一个模板串（同一行别的模板串、注释行都不算）—— 第一版按整行匹配曾误报两处
- 认为安全时，在该行或上一行加注释 `// shell-ok: 理由`

实测：238 文件、108 处 exec/execSync 调用 → 0 命中（修完后）。

配套（同批修复）:
- `arxiv` app 依赖的 `arxiv-search.py` 在目录重构中丢了（全仓与 git 近 400 commit 都找不到）→ app 一直返回"搜索失败"；
  已按 app 调用约定重写最小可用版本（只用标准库 urllib + xml.etree，输出标题/作者/日期/链接），并把调用改成 argv 数组。
- `fileacts` 的权限守卫另有三个绕过（绝对路径 / 自己+他人混条 / 夹带 AppData-shared）→ 已修 + 独立门禁 `check-fileacts-guard.cjs`。
