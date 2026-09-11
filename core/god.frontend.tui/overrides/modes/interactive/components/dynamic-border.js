import { theme } from "../theme/theme.js";
import { visibleWidth } from "@earendil-works/pi-tui";

export class DynamicBorder {
    color;
    rightText;
    constructor(color = (str) => theme.fg("border", str), rightText) {
        this.color = color;
        this.rightText = rightText;
    }
    invalidate() {}
    render(width) {
        const w = Math.max(1, width);
        if (this.rightText) {
            const rt = typeof this.rightText === "function" ? this.rightText() : this.rightText;
            const rtW = visibleWidth(rt);
            const leftLen = Math.max(1, w - rtW - 2);
            const rightLen = Math.max(0, w - leftLen - rtW);
            return [this.color("─".repeat(leftLen)) + theme.fg("dim", rt) + this.color("─".repeat(rightLen))];
        }
        return [this.color("─".repeat(w))];
    }
}
