import { Box, Container, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
/**
 * Component that renders a user message
 * teyvat override:
 *   - paddingY=0 去掉上下有底色的空行
 *   - paddingX=2 让内容从 col 2 开始与 bullet 内容对齐
 *   - 首行加 dim ❯ 标记，与 bullet(•) 对齐
 */
export class UserMessageComponent extends Container {
    text;
    markdownTheme;
    outputPad;
    constructor(text, markdownTheme = getMarkdownTheme(), outputPad = 1) {
        super();
        this.text = text;
        this.markdownTheme = markdownTheme;
        this.outputPad = outputPad;
        this.rebuild();
    }
    setOutputPad(padding) {
        this.outputPad = padding;
        this.rebuild();
    }
    rebuild() {
        this.clear();
        // 内容盒：paddingX=2，让内容从 col 2 开始；❯ 在 render() 里替换首行前两个空格
        const contentBox = new Box(2, 0, (content) => theme.bg("userMessageBg", content));
        contentBox.addChild(new Markdown(this.text, 0, 0, this.markdownTheme, {
            color: (content) => theme.fg("userMessageText", content),
        }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true }));
        this.addChild(contentBox);
    }
    render(width) {
        const lines = super.render(width);
        if (lines.length === 0) {
            return lines;
        }
        // 将首行前 2 个空格（Box paddingX=2）替换为 dim ❯ ，使 ❯ 与 • 对齐 (col 0-1)，内容仍在 col 2
        lines[0] = lines[0].replace(/^((?:\x1b\[[^m]*m)*)  /, (_, ansi) => ansi + theme.fg("dim", "❯ "));
        return lines;
    }
}
