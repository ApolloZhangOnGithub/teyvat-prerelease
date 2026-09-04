import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { MESSAGE_TYPES } from "../../../spirit.bio.organs/kernel.backbone/backbone.ts";

// blockType → 渲染规则（颜色 + 标签格式）
// 语义分类来自 backbone，这里只管怎么画
const BLOCK_STYLE = {
    "alert":        { color: "warning", label: (s) => `[alert] ${s}` },
    "error":        { color: "error",   label: (s) => `[error] ${s}` },
    "async-result": { color: "muted",   label: (s) => `[result] ${s}` },
    "notification": { color: "accent",  label: (s) => `[${s}]` },
    "system":       { color: "dim",     label: (s) => `[${s}]` },
    "internal":     { color: "dim",     label: (s) => `[${s}]` },
};

function getBlockStyle(customType) {
    const def = MESSAGE_TYPES[customType];
    if (!def) return BLOCK_STYLE["internal"];
    return BLOCK_STYLE[def.blockType] || BLOCK_STYLE["internal"];
}

function getSource(customType) {
    const def = MESSAGE_TYPES[customType];
    return def?.source || customType || "system";
}

export class CustomMessageComponent extends Container {
    message;
    customRenderer;
    box;
    customComponent;
    markdownTheme;
    _expanded = false;
    constructor(message, customRenderer, markdownTheme = getMarkdownTheme()) {
        super();
        this.message = message;
        this.customRenderer = customRenderer;
        this.markdownTheme = markdownTheme;
        this.addChild(new Spacer(1));
        this.box = new Box(0, 0, (t) => t);
        this.rebuild();
    }
    setExpanded(expanded) {
        if (this._expanded !== expanded) {
            this._expanded = expanded;
            this.rebuild();
        }
    }
    invalidate() {
        super.invalidate();
        this.rebuild();
    }
    rebuild() {
        if (this.customComponent) {
            this.removeChild(this.customComponent);
            this.customComponent = undefined;
        }
        this.removeChild(this.box);
        if (this.customRenderer) {
            try {
                const component = this.customRenderer(this.message, { expanded: this._expanded }, theme);
                if (component) {
                    this.customComponent = component;
                    this.addChild(component);
                    return;
                }
            }
            catch (e) { console.error("[god.frontend.tui/overrides/pi-tui/custom-message.js] " + (e?.message || e)); }
        }
        this.addChild(this.box);
        this.box.clear();
        let text;
        if (typeof this.message.content === "string") {
            text = this.message.content;
        }
        else {
            text = this.message.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
        }
        if (!text.trim()) return;

        const style = getBlockStyle(this.message.customType);
        const source = getSource(this.message.customType);
        const label = style.label(source);
        this.box.addChild(new Text(theme.fg(style.color, label), 0, 0));
        this.box.addChild(new Text(theme.fg(style.color === "dim" ? "dim" : "toolOutput", text.trim()), 4, 0));
    }
}
//# sourceMappingURL=custom-message.js.map
