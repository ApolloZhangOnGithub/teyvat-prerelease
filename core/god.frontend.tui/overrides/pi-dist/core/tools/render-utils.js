import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../utils/ansi.js";
import { resolvePath } from "../../utils/paths.js";
import { sanitizeBinaryOutput } from "../../utils/shell.js";
export function shortenPath(path) {
    if (typeof path !== "string")
        return "";
    const home = os.homedir();
    if (path.startsWith(home)) {
        return `~${path.slice(home.length)}`;
    }
    return path;
}
export function linkPath(styledText, rawPath, cwd) {
    if (!getCapabilities().hyperlinks)
        return styledText;
    const absolutePath = resolvePath(rawPath, cwd);
    return hyperlink(styledText, pathToFileURL(absolutePath).href);
}
export function str(value) {
    if (typeof value === "string")
        return value;
    if (value == null)
        return "";
    return null;
}
export function replaceTabs(text) {
    return text.replace(/\t/g, "   ");
}
export function normalizeDisplayText(text) {
    return text.replace(/\r/g, "");
}
export function getTextOutput(result, showImages) {
    if (!result)
        return "";
    const textBlocks = result.content.filter((c) => c.type === "text");
    const imageBlocks = result.content.filter((c) => c.type === "image");
    let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")
        // 2026-09-15（ISSUE 260）：防御性清洗——上游某环节吞 ESC 后残留的裸 SGR 参数（如 "[38;5;149m"）
        // stripAnsi 正则本身完整（实测 \x1b[38;5;149m 全剥），但 WSL 现场仍有残渣到模型上下文——加一层兜底
        .replace(/\[[0-9;]*[A-Za-z]/g, "")
    ).join("\n");
    const caps = getCapabilities();
    if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
        const imageIndicators = imageBlocks
            .map((img) => {
            const mimeType = img.mimeType ?? "image/unknown";
            const dims = img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
            return imageFallback(mimeType, dims);
        })
            .join("\n");
        output = output ? `${output}\n${imageIndicators}` : imageIndicators;
    }
    return output;
}
export function invalidArgText(theme) {
    return theme.fg("error", "[invalid arg]");
}
export function renderToolPath(rawPath, theme, cwd, options) {
    if (rawPath === null)
        return invalidArgText(theme);
    const value = rawPath || options?.emptyFallback;
    if (!value)
        return theme.fg("toolOutput", "...");
    return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
//# sourceMappingURL=render-utils.js.map