// Bridge: pi-dist → dist/modes/interactive/components/diff.js
// This file exists because tool-execution.js imports renderDiff from
// "../../../pi-dist/modes/interactive/components/diff.js" but the actual
// diff.js lives in dist/modes/interactive/components/diff.js.
// We re-export it here so the import path resolves correctly.
// 2026-09-16（用户定稿：清洗不对，撤掉）：原 R5 三段式清洗（无脑正则剥 38;5 残渣）已移除——
// 会误伤代码里真实的 `38;5`，且是事后掩盖而非修根因。残渣根因已在 capture 层修复
// （overrides/pi-dist/core/bash-executor.js：carry 不完整 ANSI 序列，不再逐 chunk strip 拆序列）。
// 这里恢复纯 re-export，不碰 diffText。
import { renderDiff as _renderDiff } from "../../../modes/interactive/components/diff.js";
export const renderDiff = _renderDiff;
