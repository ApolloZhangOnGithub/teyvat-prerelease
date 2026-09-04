import { applyBackgroundToLine, extractTailAnsiOsc, visibleWidth, wrapTextWithAnsi } from "../utils.js";
// teyvat 统一块渲染引擎(源:god.frontend.tui/ui_elements/blocks_nongod.js,install.sh 部署到 pi-tui/dist/)
import { hangWrapText } from "../blocks_nongod.js";
/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text {
    text;
    paddingX; // Left/right padding
    paddingY; // Top/bottom padding
    customBgFn;
    // Cache for rendered output
    cachedText;
    cachedWidth;
    cachedLines;
    constructor(text = "", paddingX = 1, paddingY = 1, customBgFn) {
        this.text = text;
        this.paddingX = paddingX;
        this.paddingY = paddingY;
        this.customBgFn = customBgFn;
    }
    setText(text) {
        this.text = text;
        this.cachedText = undefined;
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
    setCustomBgFn(customBgFn) {
        this.customBgFn = customBgFn;
        this.cachedText = undefined;
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
    invalidate() {
        this.cachedText = undefined;
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
    render(width) {
        // Check cache
        if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
            return this.cachedLines;
        }
        // Don't render anything if there's no actual text
        if (!this.text || this.text.trim() === "") {
            const result = [];
            this.cachedText = this.text;
            this.cachedWidth = width;
            this.cachedLines = result;
            return result;
        }
        // Replace tabs with 3 spaces
        const normalizedText = this.text.replace(/\t/g, "   ");
        // Calculate content width (subtract left/right margins)
        const contentWidth = Math.max(1, width - this.paddingX * 2);
        // teyvat: 折行走统一引擎的挂起缩进 —— 行首是 "• "/"◦ " 这类 bullet 时，续行对齐到内容列；
        // 没有 bullet 前缀就退回普通 wrapTextWithAnsi，行为和原来一致（不影响其它 Text 用途）。
        const wrappedLines = hangWrapText(normalizedText, contentWidth, { visibleWidth, wrapTextWithAnsi });
        // Add margins and background to each line
        const leftMargin = " ".repeat(this.paddingX);
        const rightMargin = " ".repeat(this.paddingX);
        const contentLines = [];
        for (const line of wrappedLines) {
            // Add margins
            const lineWithMargins = leftMargin + line + rightMargin;
            // Apply background if specified (this also pads to full width)
            if (this.customBgFn) {
                contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
            }
            else {
                // No background - just pad to width with spaces
                const visibleLen = visibleWidth(lineWithMargins);
                const paddingNeeded = Math.max(0, width - visibleLen);
                if (paddingNeeded <= 0) {
                    contentLines.push(lineWithMargins);
                }
                else {
                    // teyvat: 行尾 ANSI/OSC 不可见序列要留在补位空格之后（超链接下划线伪影修复）
                    const padding = " ".repeat(paddingNeeded);
                    const tailSeq = extractTailAnsiOsc(lineWithMargins);
                    const body = tailSeq ? lineWithMargins.slice(0, lineWithMargins.length - tailSeq.length) : lineWithMargins;
                    contentLines.push(body + padding + (tailSeq || ""));
                }
            }
        }
        // Add top/bottom padding (empty lines)
        const emptyLine = " ".repeat(width);
        const emptyLines = [];
        for (let i = 0; i < this.paddingY; i++) {
            const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
            emptyLines.push(line);
        }
        const result = [...emptyLines, ...contentLines, ...emptyLines];
        // Update cache
        this.cachedText = this.text;
        this.cachedWidth = width;
        this.cachedLines = result;
        return result.length > 0 ? result : [""];
    }
}
//# sourceMappingURL=text.js.map