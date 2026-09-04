import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
// teyvat 统一块渲染引擎(源:god.frontend.tui/ui_elements/blocks_nongod.js,install.sh 部署到此目录)
import { markdownBullet, GUTTER } from "./blocks_nongod.js";
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
    contentContainer;
    hideThinkingBlock;
    markdownTheme;
    hiddenThinkingLabel;
    lastMessage;
    hasToolCalls = false;
    errorShown = false;
    // teyvat ISSUE 077：流式进行中为 true——此时不发 OSC133 A/B/C shell-integration
    // 区域标记。kitty 会跟踪 C（output start）标记所在行做滚动/区域处理，标记挂在
    // 每帧都在变长的流式末行上反复重发，会触发 kitty 对"上一个输出区"的清理/移位，
    // 症状即 think 末行偶发被吃、新行到来后恢复。消息结束后再补发标记。
    isStreaming = false;
    constructor(message, hideThinkingBlock = false, markdownTheme = getMarkdownTheme(), hiddenThinkingLabel = "Thinking...") {
        super();
        this.hideThinkingBlock = hideThinkingBlock;
        this.markdownTheme = markdownTheme;
        this.hiddenThinkingLabel = hiddenThinkingLabel;
        // Container for text/thinking content
        this.contentContainer = new Container();
        this.addChild(this.contentContainer);
        if (message) {
            this.updateContent(message);
        }
    }
    invalidate() {
        super.invalidate();
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    setHideThinkingBlock(hide) {
        this.hideThinkingBlock = hide;
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    setHiddenThinkingLabel(label) {
        this.hiddenThinkingLabel = label;
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
    render(width) {
        const lines = super.render(width);
        if (this.hasToolCalls || lines.length === 0 || this.isStreaming) {
            return lines;
        }
        lines[0] = OSC133_ZONE_START + lines[0];
        lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
        return lines;
    }
    updateContent(message) {
        // ISSUE 078 修复（安全部分）：内容签名未变时跳过全量重建。
        // invalidate 风暴（refreshUI 等 root invalidate 级联）会反复触发本方法，
        // 长会话下每次重建全部消息块 = O(n) 卡顿。签名 = 各块 (type, 长度/toolCall id)。
        // 签名包含 viewMode/hideThinkingBlock：视图模式或折叠开关变化时即使内容没变也必须重建
        // （2026-08-14 修复：此前漏掉这两个维度，切 /u 折叠/隐藏 thinking 时早退导致视图不刷新）
        const sig = `${globalThis.__piViewMode || "full"}|${this.hideThinkingBlock ? 1 : 0}|` + (message?.content || []).map((c) => {
            if (c.type === "text") return `t:${(c.text || "").length}`;
            if (c.type === "thinking") return `h:${(c.thinking || "").length}`;
            if (c.type === "toolCall") return `c:${c.id}:${c.name}`;
            return c.type;
        }).join("|");
        if (this._lastSig !== undefined && this._lastSig === sig) {
            return; // 内容与视图模式均未变：保持现有渲染（避免 O(n) 重建）
        }
        this._lastSig = sig;
        this.lastMessage = message;
        // Clear content container
        this.contentContainer.clear();
        this.errorShown = false;
        const viewMode = globalThis.__piViewMode || "full";
        const isFoldOrHidden = viewMode === "fold" || this.hideThinkingBlock;
        const hasVisibleContent = message.content.some((c) => (c.type === "text" && c.text?.trim()) || (c.type === "thinking" && (c.thinking || "").trim() && !isFoldOrHidden));
        if (hasVisibleContent) {
            this.contentContainer.addChild(new Spacer(1));
        }
        // Render content in order
        for (let i = 0; i < message.content.length; i++) {
            const content = message.content[i];
            if (content.type === "text" && content.text.trim()) {
                // Strip leaked XML tags (model hallucination) and standalone --- (model uses as section separator → ugly hr in TUI)
                const cleaned = content.text.trim().replace(/<\/?(?:parameter|function_calls|antml:[a-z_]+)[^>]*>/g, "").replace(/(?:^|\n)\s*---\s*(?=\n|$)/g, "\n").trim();
                if (!cleaned) continue;
                const md = new Markdown(cleaned, GUTTER, 0, this.markdownTheme);
                this.contentContainer.addChild({
                    render: (w) => markdownBullet(md, theme.fg("text", "•"), w),
                    invalidate: () => { if (md.invalidate) md.invalidate(); },
                });
            }
            else if (content.type === "thinking" && (content.thinking || "").trim()) {
                const viewMode = globalThis.__piViewMode || "full";
                if (viewMode === "clean") continue;
                // Add spacing only when another visible assistant content block follows.
                // This avoids a superfluous blank line before separately-rendered tool execution blocks.
                const hasVisibleContentAfter = message.content
                    .slice(i + 1)
                    .some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));
                if (viewMode === "fold" || this.hideThinkingBlock) {
                    // Fold/hidden: skip thinking entirely, no spacer needed
                }
                else {
                    // Thinking traces — 灰点 + 思考内容，同样走 blockrender 统一对齐。
                    const md = new Markdown((content.thinking || "").trim(), GUTTER, 0, this.markdownTheme, {
                        color: (text) => theme.fg("thinkingText", text),
                    });
                    this.contentContainer.addChild({
                        render: (w) => markdownBullet(md, theme.fg("thinkingText", "•"), w),
                        invalidate: () => { if (md.invalidate) md.invalidate(); },
                    });
                    if (hasVisibleContentAfter) {
                        this.contentContainer.addChild(new Spacer(1));
                    }
                }
            }
        }
        // Check if aborted - show after partial content
        // But only if there are no tool calls (tool execution components will show the error)
        const hasToolCalls = message.content.some((c) => c.type === "toolCall");
        this.hasToolCalls = hasToolCalls;
        if (!hasToolCalls) {
            // teyvat: suppress "Operation Interrupted" display. Steer/voice-driven aborts are normal in continuous agent mode.
            if (false && message.stopReason === "aborted") {
                const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted"
                    ? message.errorMessage
                    : "Operation Interrupted";
                if (hasVisibleContent) {
                    this.contentContainer.addChild(new Spacer(1));
                }
                else {
                    this.contentContainer.addChild(new Spacer(1));
                }
                this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
            }
            else if (message.stopReason === "error") {
                if (!this.errorShown) {
                    this.errorShown = true;
                    const errorMsg = message.errorMessage || "Unknown error";
                    this.contentContainer.addChild(new Spacer(1));
                    this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
                }
            }
        }
    }
}
//# sourceMappingURL=assistant-message.js.map