# fix-issue-collisions.cjs.SPEC

用途: 检测并自动修复 `Issues` / `Lessons` 的**编号撞号**（多个 agent 并行写文档时都按「最大号 +1」取号 → 同一分钟撞号）。

来历: 2026-09-11 prime-agent。当天文档里一共撞了 8 组（先手工修了 3 组，随后并行写作又新增 5 组），
说明手工改号治不了根，需要工具 + 取号约定。项目规范（`Wiki/Knowledge-Docs(经验与教训文档规范).WIKI`）原本就定了
「撞号后到者改号」，本工具把它自动化。

用法:
```
node C.deploy/fix-issue-collisions.cjs                      # dry-run：只打印撞号与改号计划
node C.deploy/fix-issue-collisions.cjs --apply              # 执行改号（文件头一并更新 + 插入改号说明）
node C.deploy/fix-issue-collisions.cjs --apply --regen      # 改完顺带重新生成 Issues.INDEX
node C.deploy/fix-issue-collisions.cjs --next               # 新写文档前取号用（别再手算 max+1）
node C.deploy/fix-issue-collisions.cjs --kinds=issues,lessons
```
**新写文档取号请用 `--next`**（它按现有最大号给下一个，能显著降低撞号概率；并行时仍可能撞，撞了就再跑一次 `--apply`）。

规则:
- 同号组里**修改时间最早**的保留原号，其余后到者改到下一个空闲号（与项目规范一致）
- 配套文件（`.SPEC` / `.REMOVED` / `*.NAMETRACE.REMOVED`）不参与撞号判定，改号时跟随主文件一起改名
- 改号时更新文件头（`# NNN —` / `# ISSUE NNN`）并插入一行改号说明（可追溯）
- INDEX 不自动改（默认），需要时加 `--regen`

失败处理: 报错即停止，不会留下半改状态（每个文件先写新文件再删旧的）。若 INDEX 未更新，跑 `node C.deploy/gen-issues-index.mjs`。

注意: 路径含空格，本脚本内部用 `execFileSync(process.execPath, [file])` 而不是拼 shell 字符串
（2026-09-11 实测：拼字符串会 MODULE_NOT_FOUND——正是这个仓库里反复出现的那类"路径/引号失配"坑）。
