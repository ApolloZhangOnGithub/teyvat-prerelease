// highlight-pin.ts — 高亮 pin 状态（block.highlight 组件，2026-09-23）
// pin = 把高亮「固定」住（跨滚动/重建不丢）；未 pin 的高亮是临时染色。v1 内存态。

const _pinned = new Set<string>();

export function pinBlock(id: string): void { _pinned.add(id); }

export function unpinBlock(id: string): void { _pinned.delete(id); }

export function isPinned(id: string): boolean { return _pinned.has(id); }

export function pinnedList(): string[] { return [..._pinned]; }
