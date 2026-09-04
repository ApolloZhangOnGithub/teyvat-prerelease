// Bridge: pi-dist → dist/modes/interactive/components/diff.js
// This file exists because tool-execution.js imports renderDiff from
// "../../../pi-dist/modes/interactive/components/diff.js" but the actual
// diff.js lives in dist/modes/interactive/components/diff.js.
// We re-export it here so the import path resolves correctly.
export { renderDiff } from "../../../modes/interactive/components/diff.js";
