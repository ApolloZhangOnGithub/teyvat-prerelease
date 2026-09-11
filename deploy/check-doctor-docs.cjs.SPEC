# check-doctor-docs.cjs.SPEC

用途: 门禁 —— `Wiki/Doctor(Paimon Integrity).WIKI` 的「检查项」表与 `doctor.ts` 实际实现的检查**必须一致**（双向）。

来历: 2026-09-11 prime-agent。WIKI 里写着 `tmux-orphan` 等 8 个检查，代码里**一个都没有**
（`dir-legacy`/`dir-agentfile`/`dir-config-dup`/`sync-lock`/`sync-manifest`/`sync-tamper`/`sync-excluded`/`tmux-orphan`）；
反向也有 7 个实现了但没写（`config`/`disk`/`org`/`plist-agents`/`process`/`scrollback`/`sync-status`）。
读文档的人会以为体检覆盖了某些方面，其实没有 —— 与 `Experiences/012`（假绿）同族。

处理:
- `tmux-orphan` **已实现**（按 WIKI 原语义：hc-/sc-/sl- 会话必须对应活跃 agent，含 5 分钟启动宽限）
- 其余 7 个移入 WIKI 新增的「### 历史 / 未实现」段，并注明"代码里没有、勿据此判断；要恢复先建 ISSUE"
- 补齐了 7 个实现的检查 + 新增「环境 / 其它」小节

用法: `node C.deploy/check-doctor-docs.cjs [A.core 路径] [B.docs 路径]`（已接进 Makefile `_integrity`；默认路径推导：`A.core/../B.docs`）

判定:
1. 取 WIKI「## 检查项」起、「### 历史 / 未实现」前的**表格行首反引号名** = 声称已实现
   （历史段里的名字**不参与**比较——那段本来就是"代码已无"的登记簿）
2. 取 `doctor.ts` 里 `ok|fail|warn|skip('名字'` 的字符串 = 实际实现
3. 两个集合必须相等：`WIKI 有代码无` → FAIL（要么实现、要么挪进历史段）；`代码有 WIKI 无` → FAIL（补一行）
4. 任一侧解析为空 / 找不到锚点 → FAIL（结构变了就得同步 gate，不许静默通过）

已验证门禁会失败：假 core 树 + WIKI 里塞一个 `fake-check-xyz` → 输出点名该项并 exit 1。
