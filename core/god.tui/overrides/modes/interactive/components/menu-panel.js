// menu-panel.js — 移植自 prime-agent MenuPanel 组件（2026-09-11）
// 提供带浅底色背景的菜单面板，用于 /s /c 等斜杠命令的选择器
import { Container, Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

const PANEL_PADDING_X = 2;
const PANEL_PADDING_Y = 1;
const FIELD_PADDING_X = 2;
const ROW_PADDING_X = 2;
const ROW_PADDING_Y = 1;
const ANSI_RESET = "\x1b[0m";

export function getMenuPanelInnerWidth(width) {
    const safeWidth = Math.max(PANEL_PADDING_X * 2 + 1, width);
    return Math.max(1, safeWidth - PANEL_PADDING_X * 2);
}

function fillsMenuPanel(component) {
    return component?.fillsMenuPanel === true;
}

function getViewportRows(getRows) {
    const rows = getRows?.();
    if (rows === undefined || !Number.isFinite(rows) || rows <= 0) return undefined;
    return Math.floor(rows);
}

function visibleItemCount(rows, options) {
    const capacityRows = Math.max(0, rows - options.reservedRows - options.listPaddingRows - options.extraRows);
    const itemCapacity = Math.floor(capacityRows / options.itemRows);
    return Math.max(options.minVisibleItems, Math.min(options.preferredVisibleItems, itemCapacity));
}

function listRowsUsed(options) {
    return options.reservedRows + options.listPaddingRows + options.extraRows + options.visibleItems * options.itemRows;
}

function scrollIndicatorRows(options) {
    if (options.totalItems === undefined || options.scrollIndicatorRows <= 0) return 0;
    return options.totalItems > options.visibleItems ? options.scrollIndicatorRows : 0;
}

function getLayoutCandidate(rows, options, itemRows, listPaddingRows, compact) {
    const minVisibleItems = options.minVisibleItems ?? 1;
    const preferredVisibleItems = Math.max(minVisibleItems, options.preferredVisibleItems);
    const visibleItemsWithoutScroll = visibleItemCount(rows, {
        preferredVisibleItems, minVisibleItems,
        reservedRows: options.reservedRows, itemRows, listPaddingRows, extraRows: 0,
    });
    const extraRows = scrollIndicatorRows({
        totalItems: options.totalItems,
        visibleItems: visibleItemsWithoutScroll,
        scrollIndicatorRows: options.scrollIndicatorRows ?? 0,
    });
    const vis = extraRows > 0
        ? visibleItemCount(rows, { preferredVisibleItems, minVisibleItems, reservedRows: options.reservedRows, itemRows, listPaddingRows, extraRows })
        : visibleItemsWithoutScroll;
    const rowsUsed = listRowsUsed({ reservedRows: options.reservedRows, listPaddingRows, visibleItems: vis, itemRows, extraRows });
    return { compact, visibleItems: vis, rowsUsed, fits: rowsUsed <= rows };
}

export function getMenuListLayout(options) {
    const minVisibleItems = options.minVisibleItems ?? 1;
    const preferredVisibleItems = Math.max(minVisibleItems, options.preferredVisibleItems);
    const rows = getViewportRows(options.getRows);
    if (rows === undefined) return { compact: false, visibleItems: preferredVisibleItems };

    const comfortableLayout = getLayoutCandidate(rows, options, Math.max(1, options.comfortableItemRows), options.comfortableListPaddingRows ?? 1, false);
    if (options.compactItemRows === undefined) return { compact: false, visibleItems: comfortableLayout.visibleItems };

    const compactLayout = getLayoutCandidate(rows, options, Math.max(1, options.compactItemRows), options.compactListPaddingRows ?? 0, true);
    if (compactLayout.fits && (!comfortableLayout.fits || compactLayout.visibleItems > comfortableLayout.visibleItems)) {
        return { compact: true, visibleItems: compactLayout.visibleItems };
    }
    if (comfortableLayout.fits) return { compact: false, visibleItems: comfortableLayout.visibleItems };
    return compactLayout.rowsUsed <= comfortableLayout.rowsUsed
        ? { compact: true, visibleItems: compactLayout.visibleItems }
        : { compact: false, visibleItems: comfortableLayout.visibleItems };
}

function paddedBackgroundLine(text, width, paddingX, background) {
    const innerWidth = Math.max(1, width - paddingX * 2);
    const content = truncateToWidth(text, innerWidth, "");
    const rightPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
    const contentSpan = " ".repeat(paddingX) + content;
    const trailingSpan = rightPadding + " ".repeat(paddingX);
    if (!background) return contentSpan + trailingSpan;
    return applyBackground(contentSpan, background) + background(trailingSpan);
}

function applyBackground(text, background) {
    return text.split(ANSI_RESET).map((segment) => background(segment)).join(ANSI_RESET);
}

// 面板背景色（浅灰，区分于终端默认黑色但不刺眼）
const editorBg = (text) => `\x1b[48;2;38;38;38m${text}\x1b[49m`;
const selectionBg = (text) => `\x1b[48;2;58;58;58m${text}\x1b[49m`;

export function getEditorBackgroundColor() { return editorBg; }
export function getSelectionBackgroundColor() { return selectionBg; }

function surfaceLine(text, width, paddingX = PANEL_PADDING_X) {
    return paddedBackgroundLine(text, width, paddingX, editorBg);
}

function surfaceWrappedLines(text, width, paddingX = PANEL_PADDING_X) {
    const innerWidth = Math.max(1, width - paddingX * 2);
    return wrapTextWithAnsi(text, innerWidth).map((content) => surfaceLine(content, width, paddingX));
}

export class MenuPanel extends Container {
    _title;
    _subtitle;

    constructor(options) {
        super();
        this._title = options.title;
        this._subtitle = options.subtitle;
    }

    setTitle(title) { this._title = title; }

    render(width) {
        const safeWidth = Math.max(PANEL_PADDING_X * 2 + 1, width);
        const innerWidth = getMenuPanelInnerWidth(width);
        const lines = [];

        for (let i = 0; i < PANEL_PADDING_Y; i++) lines.push(surfaceLine("", safeWidth));

        const hasTitle = this._title && this._title.trim().length > 0;
        const subtitle = this._subtitle?.trim();
        const hasSubtitle = subtitle !== undefined && subtitle.length > 0;
        if (hasTitle) lines.push(surfaceLine(theme.bold(theme.fg("text", this._title)), safeWidth));
        if (hasSubtitle) lines.push(...surfaceWrappedLines(theme.fg("muted", subtitle), safeWidth));
        if (hasTitle || hasSubtitle) lines.push(surfaceLine("", safeWidth));

        for (const child of this.children) {
            const childLines = fillsMenuPanel(child) ? child.render(safeWidth) : child.render(innerWidth);
            for (const line of childLines) {
                lines.push(fillsMenuPanel(child) ? line : surfaceLine(line, safeWidth));
            }
        }

        for (let i = 0; i < PANEL_PADDING_Y; i++) lines.push(surfaceLine("", safeWidth));
        return lines;
    }
}

export class MenuSearchInput {
    fillsMenuPanel = true;
    _input = new Input();
    _placeholder;

    constructor(placeholder) { this._placeholder = placeholder; }

    get focused() { return this._input.focused; }
    set focused(value) { this._input.focused = value; }
    set onSubmit(handler) { this._input.onSubmit = handler; }
    getValue() { return this._input.getValue(); }
    getCursor() { return this._input.getCursor(); }
    setValue(value) { this._input.setValue(value); }
    handleInput(data) { this._input.handleInput(data); }
    invalidate() { this._input.invalidate(); }

    render(width) {
        const safeWidth = Math.max(FIELD_PADDING_X * 2 + 1, width);
        const innerWidth = Math.max(1, safeWidth - FIELD_PADDING_X * 2);
        const content = this.getValue() === "" && !this.focused
            ? theme.fg("dim", this._placeholder)
            : this._stripInputPrompt(this._input.render(innerWidth + 2)[0] ?? "");
        return [paddedBackgroundLine(content, safeWidth, FIELD_PADDING_X, editorBg)];
    }

    _stripInputPrompt(line) { return line.startsWith("> ") ? line.slice(2) : line; }
}

export class MenuRow {
    fillsMenuPanel = true;
    _primary;
    _secondary;
    _meta;
    _selected;

    constructor(options) {
        this._primary = options.primary;
        this._secondary = options.secondary;
        this._meta = options.meta;
        this._selected = options.selected;
    }

    get selected() { return this._selected; }
    invalidate() {}

    render(width) {
        const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
        return [
            ...this.renderPadding(safeWidth, this._selected),
            ...this.renderContent(safeWidth),
            ...this.renderPadding(safeWidth, this._selected),
        ];
    }

    renderContent(width) {
        const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
        const meta = this._meta ? theme.fg("muted", this._meta) : "";
        const secondary = this._secondary ? theme.fg("muted", this._secondary) : "";
        const primary = this._selected
            ? theme.bold(theme.fg("text", this._primary))
            : theme.fg("text", this._primary);
        const innerWidth = Math.max(1, safeWidth - ROW_PADDING_X * 2);
        const metaWidth = visibleWidth(meta);
        const gap = meta ? 2 : 0;
        const primaryWidth = Math.max(1, innerWidth - metaWidth - gap);
        const primaryText = truncateToWidth(primary, primaryWidth, "", true);
        const primaryLine = meta ? primaryText + " ".repeat(gap) + meta : primaryText;
        const lines = [];
        lines.push(this._rowLine(primaryLine, safeWidth, this._selected));
        if (secondary) lines.push(this._rowLine(truncateToWidth(secondary, innerWidth, "", true), safeWidth, this._selected));
        return lines;
    }

    renderPadding(width, selected) {
        const safeWidth = Math.max(ROW_PADDING_X * 2 + 1, width);
        const lines = [];
        for (let i = 0; i < ROW_PADDING_Y; i++) lines.push(this._rowLine("", safeWidth, selected));
        return lines;
    }

    _rowLine(text, width, selected) {
        const background = selected ? selectionBg : editorBg;
        return paddedBackgroundLine(text, width, ROW_PADDING_X, background);
    }
}

export class MenuList extends Container {
    fillsMenuPanel = true;
    _compact;

    constructor(options = {}) {
        super();
        this._compact = options.compact;
    }

    render(width) {
        const lines = [];
        const compact = typeof this._compact === "function" ? this._compact() : this._compact === true;
        for (let index = 0; index < this.children.length; index++) {
            const child = this.children[index];
            if (child instanceof MenuRow) {
                if (compact) { lines.push(...child.renderContent(width)); continue; }
                const previousChild = this.children[index - 1];
                const nextChild = this.children[index + 1];
                const previousRow = previousChild instanceof MenuRow ? previousChild : undefined;
                lines.push(...child.renderPadding(width, child.selected || previousRow?.selected === true));
                lines.push(...child.renderContent(width));
                if (!(nextChild instanceof MenuRow)) lines.push(...child.renderPadding(width, child.selected));
                continue;
            }
            const childLines = fillsMenuPanel(child) ? child.render(width) : child.render(Math.max(1, width - PANEL_PADDING_X * 2));
            for (const line of childLines) {
                lines.push(fillsMenuPanel(child) ? line : surfaceLine(line, width));
            }
        }
        return lines;
    }
}
