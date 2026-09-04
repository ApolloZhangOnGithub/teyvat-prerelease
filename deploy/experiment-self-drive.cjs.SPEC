# experiment-self-drive.cjs.SPEC

**用途**: ISSUE 073（自动续命 API 级自驱）的**真实 API 实验**——验证模型能否可靠输出"我继续，XXX"标记（这是自驱方案的核心不确定点，静态分析无法回答，必须用真实模型测）。
**方法**: 用项目实际配置（~/.teyvat/agent/models.json 的 deepseek provider——用户指示用 deepseek 和项目一致）+ 项目实际调用方式（openai 兼容 chat completions），模拟 agent 多轮自驱循环：
1. system prompt 模拟 genshin（含续命约定："想继续干活就在回合最后输出『我继续，<短目标>』；不想继续就 wait/hibernate"）
2. 给任务场景 + 模拟意图栈 → 模型回复
3. 解析末尾"我继续，"标记 → 提取 XXX → 下一轮以 XXX 引导（模拟自驱续命）
4. 跑多轮 → 统计：标记输出率、格式稳定性、解析正确率、无标记时的停止行为
**约束**: 不改项目代码、不动真实 agent；apiKey 只从 models.json 读不打印；实验脚本在 C.deploy（不写 /tmp）。
**用法**: node C.deploy/experiment-self-drive.cjs [轮数，默认 6]
