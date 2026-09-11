# check-doc-refs.cjs.SPEC

用途: 门禁 —— `B.docs/Dev.Common` 下 `*.WIKI` + `*.NORM` 里引用的**仓库文件路径**必须存在。

来历: 2026-09-11 prime-agent。同一天已发现两类"文档骗人"：
- `Doctor WIKI` 写了 8 个不存在的检查（已由 `check-doctor-docs.cjs` 单独看守）
- 本篇管的：**文档说"代码在 X"，而 X 已被改名/搬家/删掉**，实测抓到并修正 15 篇文档：
  `universe.society/organization/organization.ts`（实际 `spirit.abio.status/organization.ts`）、
  `god.cli/*` → `god.frontend.cli/*`、`mods.cli/*` → `god.frontend.cli/*`、`commands.X/X.ts` → `god.frontend.tui/commands/X.ts`、
  `god.tui/*` → `god.frontend.tui/*`、`spirit.bio.gene/tools.manifest.js`/`rna.js` → `.json`、
  `god.cli/completion.zsh` → `god.frontend.cli/genshin-completion.zsh`（该文件本就丢了，见 ISSUE 196）

判定（只报高置信两类，避免散文误伤）:
1. **扩展名不符**：引用不存在，但仓库里有唯一"同 stem、不同扩展名"的文件 → FAIL 并给建议路径
2. **疑似搬移**：引用不存在，但仓库里有唯一"同名文件"在别处 → FAIL 并给建议路径
3. 无候选的引用**不 FAIL**（只计数）——多为散文、外部项目路径、历史叙述

范围: 只扫 `*.WIKI` + `*.NORM`。**不含 `*.LESSON`**：教训是带日期的历史记录，其中的过时路径属正常。

豁免: 脚本内 `ALLOW` 表（**每条都写明原因**）：Claude Code 外部源码路径、WIKI 的历史变更行、
散文里的斜杠列举、以及"已显式标注为旧布局路径"的更正说明。新增豁免必须写理由。

用法: `node C.deploy/check-doc-refs.cjs [A.core 路径] [B.docs 路径]`（已接进 Makefile `_integrity`，约 0.2s）

已验证门禁会失败：夹具 WIKI 里写 `god.frontend.cli/doctor.js` → 输出「扩展名不符 → 应该是 …/doctor.ts」并 exit 1。

注意（作者自省）: 第一版扫描正则**没有锚定词尾**，把 `tools.manifest.json` 里的 `.js` 当成了引用，
还据此"修正"了 14 篇文档 → 造出 `tools.manifest.jsonon`。发现后立刻全量修回（`jsonon`→`json`，8 个文件）。
现行正则已加 `(?![A-Za-z0-9_.-])` 锚定；改动本脚本时务必保留锚定。

## 追加规则（2026-09-11 第二轮）：文档承诺的**环境变量**必须在代码里存在

同类问题换了个载体：文档写「设 `PAIMON_SLOT=feature-phone genshin` 就能用独立 runtime」，
但全仓 `grep SLOT` **没有任何实现** → 用户照着做，命令照常作用在 main 的 live 环境上（正好是该文档自己警告的事故）。

判定：扫 `*.WIKI`/`*.NORM` 里的 `PI_*` / `PAIMON_*` / `TEYVAT_*` / `GENSHIN_*` 变量名，
- 代码里出现过 → OK
- 代码里没有，但**同一段上下文（±3 行）**有「提案/未实现/计划/设计中/待实现/deprecated/历史/已废」→ 视为"已声明是设计"→ OK
- 形如 `PI_DEBUG_XXX` 的占位符（`XXX`/`TODO`/连续 X 结尾）→ 跳过
- 其余 → **FAIL**，提示"实现它，或在同段标注「提案/未实现」"

实测：核对 17 个文档提到的变量，0 个可疑（`PAIMON_SLOT` 本轮已在 Worktree WIKI 标注「提案（未实现）」）。
负向验证：夹具 WIKI 里写 `PAIMON_TOTALLY_FAKE_SWITCH=1` 且不标注 → exit 1 并点名该文件行。

### 同批修正的另两处"文档承诺"漂移

| 文档 | 问题 | 处理 |
|---|---|---|
| `Worktree(Collabration Mechanism).WIKI` | 「多版本并行的正确方案」把未实现的 `PAIMON_SLOT` 写成可用命令 | 加 banner：**提案（未实现）**，并警告照做会作用于 main 的 live 环境 |
| `Laptop(Tech Device).WIKI` | 写「状态持久化到 `laptop-state.json`」，但代码里没有 `maxZ`/`focusWin`/`laptop-state.json`；现在的 `laptop.cjs` 只读写 `laptop-screen.txt` | 加标注：设计/未实现 |
| `Fucked(Agent Metric).WIKI` | 度量已更名为 **tokenmaxxed**（`memory.ts` 写 `tokenmaxxed.json`），全仓无 `fucked.json` | 加标注：已更名（保留为历史命名记录） |

（另：`theme-schema.json` 的"找不到"是**误报** —— 该文件在 `@earendil-works/pi-coding-agent` 包内，属外部依赖，不在本仓库核对范围。）

## 追加规则（2026-09-11 第三轮）：文档里的 `make X` 必须是真实 target

实测抓到：`make dev`（009-debug-pipeline.NORM，实际是 `make dev-minutely`）、`make integrity`（实际是内部 `_integrity` 阶段）、
`make release-latest`（Versioning WIKI 里出现 3 次，Makefile 根本没有该 target —— 用户照抄会得到 `No rule to make target`）。
三处已全部更正。

判定：扫 `*.WIKI`/`*.NORM` 里的 `make <word>`：
- `<word>` 在 `C.deploy/Makefile` 的 target 集合里 → OK
- 英语常用语（make sure / it / sense / target …）→ 跳过
- 同一段（±3 行）有「更正/已移除/已删除/未实现/提案/计划/历史/已废/不是公开/没有该」→ 视为已声明 → OK
- 其余 → FAIL

**为什么不一起收 `genshin X`**：CLI 子命令在文档里大量以散文/示例形式出现（"所有 genshin agent 平等"、"`genshin xxx` 启动 agent"、
"genshin hex" 是表格列名），机械化判定会大量误报；`make X` 是唯一形态的硬声明，误报率低。
（`genshin` 侧本轮只做了人工抽检：修掉 `genshin list`/`genshin laptop` 两处误用，并给 `laptop` 加保留字防止误建 agent。）

实测：58 处 make 提及，0 可疑。负向验证：夹具写 `make totally-fake-target` → exit 1。
