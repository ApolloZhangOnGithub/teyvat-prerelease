import * as os from "node:os";
import { appendFileSync } from "node:fs";
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
    let output = textBlocks.map((c) => {
        const raw = c.text || "";
        const stripped = stripAnsi(raw);
        // 2026-09-16（用户定稿：清洗不对——不无脑正则剥，改「校验渲染值 vs 原始值」只报告）。
        // stripAnsi 后若仍残有 ANSI（完整 CSI 或裸 SGR 参数 38;5;222m/9m），说明上游某环节剥了一半（ESC/[ 被剥留参数），
        // 这里只写诊断日志定位上游，不硬剥（硬剥会误伤代码里真实的 38;5）。
        const residue = stripped.match(/\x1b\[[0-9;]*[A-Za-z]|\b\d+(?:;\d+)*m\b/g);
        if (residue) {
            try { appendFileSync((process.env.HOME || "") + "/.teyvat/LogData/ansi-residue.log", `[${new Date().toISOString()}] ANSI 残渣(渲染值≠原始值): ${JSON.stringify(residue.slice(0, 3))} 原始前120字: ${raw.slice(0, 120).replace(/\n/g, " ")}\n`); } catch { /* 诊断日志失败静默 */ }
        }
        return sanitizeBinaryOutput(stripped).replace(/\r/g, "");
    }).join("\n")
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