# check-execute-render.cjs.SPEC

用途: 门禁 —— execute 结果渲染管线的结构约束，防止 ISSUE 226 里收口掉的"纠缠"再长回来。

背景（2026-09-13，用户：「Execute 的现在渲染关联乱成一团」）：同一条命令的显示逻辑散在 5 个文件里——
尾标签剥离正则 5 套没有两套相同（backbone 改口径后 executes.ts 的那套立刻失配，`[id:]`/`[result …]` 漏进快命令输出）、
`"⎿  "` 硬编码 5 处绕过 WSL 的 ASCII 回退、耗时格式器 6 个实现、cmd-done 把手里的 recId/exitCode/耗时格式化成文本再让
渲染器用 3 条正则反解析、渲染时取 `Date.now()` 让历史行随心跳重渲染漂移、`replaceDot` 三份其中一份漏改。

收口后的唯一入口都在 `god.frontend.tui/ui_elements/blocks_nongod.js`：
`stripResultTokenMark` / `stripInlineBgTag` / `extractBioclockTag`（尾标签）、`fmtElapsedMs` / `fmtElapsedCoarse` / `fmtClock`（时间）、
`renderExecuteResult(theme, state)`（快命令 / Created / cmd-done 三种样式）、`parseLegacyCmdDone`（旧格式历史消息兜底）、`SYM`（符号，只定义一次）。

本门禁（静态扫描 A.core 下 .ts/.js，跳过 node_modules 与 overrides/pi-tui）：

| # | 约束 | 违反的典型写法 | 修法 |
|---|---|---|---|
| R1 | 尾标签正则（`\[id:` `\[remaining:` `\[background:` `\[result\s` `\[\d{2}:`）只允许在 blocks_nongod.js | `text.replace(/\n\[id:.*$/, "")` | 调 `stripResultTokenMark` / `stripInlineBgTag` / `extractBioclockTag`；确需例外在该行加 `tag-regex-allow` |
| R2 | 三个 execute 渲染函数体（executes.ts `renderResult`、renderers.ts cmd-done 渲染器、blocks_nongod `renderExecuteResult`）内禁止 `Date.now()` / `new Date()` | `new Date(details.endTs \|\| Date.now())` | 时刻来自 `details.endTs` / `createdInfo.ts` / `message.timestamp`，缺则不显示时钟 |
| R3 | `⎿` 字面量只在 blocks_nongod.js（SYM 定义） | `theme.fg("dim", "⎿  ")` | `SYM.result + "  "`；确需例外加 `sym-allow` |
| R4 | executes.ts 每处 `continuous-cmd-done` 发送都带 `status: "done\|failed\|timeout\|terminated"` | `outboxSend(pi, "continuous-cmd-done", text, { title })` | details 补 `{ status, recId, exitCode, elapsedSec, endTs, cmd, output, remaining }` |
| R5 | `Done in ${…}` / `Created ${…} bash\|terminal process` 摘要行只能由 `renderExecuteResult` 生成 | 自己拼 `` `Done in ${theme.bold(sec)}` `` | 把 details 映射成 state 交给 `renderExecuteResult` |

零匹配保护：R1 连 blocks_nongod.js 里都找不到尾标签正则、R4 在 executes.ts 找不到发送点 → FAIL（检查失效比违规更危险，LESSON 门禁假绿）。

动态断言（三种样式的快照、legacy 反解析、全角序号补格）在 `check-render-test.mjs`（E1–E6 / W1），由 `check-render.mjs` 搭闭包执行。

用法: `node C.deploy/check-execute-render.cjs [A.core 路径]`（已接进 Makefile `_integrity`）

失败处理: 按上表的"修法"改；不要给违规行加豁免标记来过门禁——豁免只给"确实不是 execute 渲染"的场景（如日志格式化）。
