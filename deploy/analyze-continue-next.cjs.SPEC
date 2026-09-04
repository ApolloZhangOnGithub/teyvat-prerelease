# analyze-continue-next.cjs.SPEC

**用途**: ISSUE 073（自动续命 API 级自驱）研究的量化分析——统计历史 session 里 continuous-next 消息的实际数量与 context 占用。
**数据源**: ~/.teyvat/SessionData/<agent-id>/*.jsonl（pi 会话记录，custom_message customType=continuous-next）
**统计项**:
1. 每 agent 的 session 数、continuous-next 总条数
2. 每条 continuous-next 的内容字符数（意图栈全文长度）→ 总浪费字符（注入式成本）
3. 对比"我继续，XXX"自驱式成本（估算：每条 ~20-40 字符）
4. 一个 session 内连续续命的最大次数（context 刷屏峰值）
**约束**: 只读历史数据，不改代码、不动 agent（researcher 转交约束）
**用法**: node C.deploy/analyze-continue-next.cjs
