# fix-catch-ts-type.cjs.SPEC

**用途**: 修复 fix-empty-catch.cjs 批量修复引入的 TS 类型错误（419 处 TS2339）。
**背景**: 批量给空 catch 加日志生成 `catch (e) { console.error("[file] " + (e?.message || e)); }`——
TS 里 catch 子句参数类型是 `{}`（unknown 简化），`e?.message` 报
`Property 'message' does not exist on type '{}'`（419 处）。JS 文件无类型检查不受影响，只修 .ts。
**修复**: `(e?.message || e)` → `((e as any)?.message || e)`（保留原变量名，如 err）。
**用法**: `node fix-catch-ts-type.cjs`（dry-run 统计）/ `--apply` 实际修复（自动 .bak 备份）
