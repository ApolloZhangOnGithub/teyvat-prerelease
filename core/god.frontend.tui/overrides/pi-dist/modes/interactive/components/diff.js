// Bridge: pi-dist → dist/modes/interactive/components/diff.js
// This file exists because tool-execution.js imports renderDiff from
// "../../../pi-dist/modes/interactive/components/diff.js" but the actual
// diff.js lives in dist/modes/interactive/components/diff.js.
// We re-export it here so the import path resolves correctly.
// 2026-09-16（ISSUE 260 回归/windows agent 排查）：renderDiff 显示不洗 ANSI 残渣——
// 上游吞 ESC 后残留的裸 SGR 参数（如 38;5;183m）会显示在 Edit 的 diff 里（存量脏）。
// 这里只清洗显示用的 diffText（R5 三段式，同 render-utils.js），不动磁盘原字节。
import { renderDiff as _renderDiff } from "../../../modes/interactive/components/diff.js";
export function renderDiff(diffText, options) {
  const clean = String(diffText ?? "")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")   // ① 带 ESC 的真序列整段剥
    .replace(/\[[0-9;]+m/g, "")                 // ② SGR 残渣（至少一个参数+m）
    .replace(/(\S)\[m(?![A-Za-z])/g, "$1");      // ③ 裸 reset [m（边界断言避开 [m]/[merge]）
  return _renderDiff(clean, options);
}
