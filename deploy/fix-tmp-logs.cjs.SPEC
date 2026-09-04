# fix-tmp-logs.cjs.SPEC

**用途**: 批量迁移 catch 兜底错误日志（/tmp/genshin-catch-errors.log → ~/.teyvat/LogData/genshin-catch-errors.log）
**背景**: 用户定稿"永远不要使用 tmp 目录处理数据（不安全/易冲突/无好处）"——全局扫描发现 7 处写 /tmp 的兜底日志：
  interactive-mode.js（638/3228/3232/3236 行）、package-manager.js（128 行）、extensions/loader.js（284/554 行）
  都是 `appendFileSync("/tmp/genshin-catch-errors.log", ...)`（主日志写失败时的最后兜底）——统一迁到 LogData。
**规则**: 不写 /tmp；替换前备份（.bak-fix-tmp）；只替换该字符串字面量。
**用法**: node C.deploy/fix-tmp-logs.cjs
