// highlight-color.ts — 高亮颜色表 + 校验（block.highlight 组件，2026-09-23）
// 受控颜色表：不接受任意值，避免注入任意 ANSI/hex。

export const HIGHLIGHT_COLORS: Record<string, string> = {
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#8be9fd",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  orange: "#ffb86c",
  white: "#f8f8f2",
};

export type HighlightColor = keyof typeof HIGHLIGHT_COLORS;

export function isValidColor(c: string): c is HighlightColor {
  return Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, c);
}

export function colorList(): string {
  return Object.entries(HIGHLIGHT_COLORS)
    .map(([name, code]) => `${name}(${code})`)
    .join(", ");
}
