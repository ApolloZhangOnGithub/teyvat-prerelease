# check-theme-usage.cjs.SPEC

用途: 静态校验代码里写的主题颜色名都存在，防止运行时 `Theme.fg()/bg()` 抛
      `Unknown theme color: X`（该异常会让消息渲染失败/红点）。

检查项:
- U001 `fg("X")`：X 必须是 dark/light `colors` 的键，且不能是 bg 专用键（selectedBg / userMessageBg /
  customMessageBg / toolPendingBg / toolSuccessBg / toolErrorBg——它们只在 bgColors 里，fg() 用会抛）。
- U002 `bg("X")`：X 必须是上面那六个 bg 专用键之一。
- U003 同一行写 `theme-allow` 注释即豁免（写明理由）。
- 只认字面量；`fg(name)` 这种变量入参静态查不了，跳过。
- 本地同名 helper（如 model-selector.js 里自己特判了 "plain" 的 `fg`）登记在 LOCAL_HELPERS。

用法: `node check-theme-usage.cjs <A.core 路径>`（零依赖，扫 237 个文件约 50ms）
建议接线: `_integrity` 里加一行
      @echo "[$$(date +%H:%M:%S)] theme-usage check..." && node "$(DEPLOY)/check-theme-usage.cjs" "$(CORE)"

来历（2026-09-11 prime-agent）:
- 历史日志实证：`Unknown theme color: white` 15034 次（至 2026-07-13）、
  `Unknown theme color: default` 5 次（2026-09-08）。
- 现有 check-theme-consistency.cjs 只查 dark/light 的 vars 键对应与 colors 引用完整，
  查不出"代码里写的名字根本不在 colors 里"。
- 首次运行即抓到真违规：`god.frontend.tui/renderers.ts:126 fg("yellow")`（memory-reminder 渲染器）。
  已改为 `fg("warning")`（`colors.warning` → `vars.yellow` #FFC107，同色），改后本检查 PASS。
