# real-session-drive-test.cjs.SPEC

**用途**: ISSUE 073（自动续命 API 级自驱）**真实数据 + 真实 API 实验**（用户定稿：不用模拟，用真实历史 session + 项目一致 deepseek）。
**方法**: 取真实 session（~/.teyvat/SessionData/af5c5269）每个 continuous-next 注入点**之前**的真实回合消息（最后 3 条），转 API 格式 + 续命约定，重放给 deepseek（models.json 配置），检查模型在真实场景回合结束时是否输出"我继续，"标记、能否解析出目标。
**约束**: 不改项目代码、不动真实 agent；apiKey 只读不打印；脚本在 C.deploy（不写 /tmp）；最多测 5 个真实场景控制成本。
**用法**: node C.deploy/real-session-drive-test.cjs [模型，默认 deepseek-v4-flash]
