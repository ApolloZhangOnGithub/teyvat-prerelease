# fix-empty-catch.cjs.SPEC

**用途**: 批量修复项目里的空 `catch {}`（静默吞错反模式）。
**为什么需要**: 2026-08-20 用户指出——项目里空 catch 静默吞错是系统性问题（扫描 392 处），
只修单点（tool-execution fallback）是杯水车薪。LESSON 024 早已定义 catch 空块为反模式，
但存量未清理。此脚本做存量修复（批量加 console.error 日志），配合
check-empty-catch.cjs 门禁（新增由 make 拦截）一起根治。
**用户原话**: 「里面的乱catch，乱fallback错误还有100w处以上」——要求系统性处理，不是单点修复。
**使用**: `node fix-empty-catch.cjs`（dry-run 统计）/ `node fix-empty-catch.cjs --apply`（实际修复，自动 .bak 备份）
