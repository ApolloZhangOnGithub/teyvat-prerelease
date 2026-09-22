// ── blocktrace.ts — 统一块 id 脊梁（PROPOSAL 042）──
// 给每个「块」（agent 文本 / 工具调用+结果 / 系统消息 / social）分配一个跨 memory / session / TUI
// 三处共用的唯一 id，作为 highlight / amem 按子树归档 / 块父子追溯 的 infra 底座。
//
// id 约定：
//   - 工具块（toolCall + toolResult）→ `tc-<toolCallId>`：一个工具往返共用同一个 id，天然链接调用与结果
//   - 消息块（assistant 文本 / user / think / system / social）→ `bt-<seq36>`：自生成，单调短 id
// 单例（module 级 Map）——memory（brain.memory）与 TUI（interactive-mode）跑在同一 Node 进程，直接共享。

export interface BlockTrace {
  /** 唯一 id（工具块 = tc-<toolCallId>，消息块 = bt-<seq>） */
  id: string;
  kind: "toolCall" | "toolResult" | "assistant" | "user" | "think" | "system" | "social" | "custom";
  tool?: string;
  toolCallId?: string;
  entryId?: string;
  ts?: number;
}

const registry = new Map<string, BlockTrace>();
const components = new Map<string, unknown>(); // TUI 组件注册（highlight 染色用）
let _seq = 0;

/** 自生成单调 id（消息块用）。bt-1 / bt-2 / ...，短而稳定。 */
export function nextBlockId(): string {
  _seq += 1;
  return `bt-${_seq.toString(36)}`;
}

/**
 * 给一个块分配并登记稳定 id。
 * 工具块（kind=toolCall/toolResult 且带 toolCallId）→ 复用 `tc-<toolCallId>`（同一 toolCallId 反复调用返回同一 id）。
 * 其余 → 自生成 `bt-<seq>`。
 * 返回 BlockTrace（已入 registry）。
 */
export function trackBlock(input: {
  kind: BlockTrace["kind"];
  tool?: string;
  toolCallId?: string;
  entryId?: string;
  ts?: number;
}): BlockTrace {
  const isTool = input.kind === "toolCall" || input.kind === "toolResult";
  const id = isTool && input.toolCallId ? `tc-${input.toolCallId}` : nextBlockId();
  const existing = registry.get(id);
  if (existing) {
    // 同 id 复用（如 toolResult 找它对应 toolCall 的块）：补齐缺失字段
    if (!existing.tool && input.tool) existing.tool = input.tool;
    if (!existing.toolCallId && input.toolCallId) existing.toolCallId = input.toolCallId;
    if (!existing.entryId && input.entryId) existing.entryId = input.entryId;
    return existing;
  }
  const tr: BlockTrace = {
    id,
    kind: input.kind,
    tool: input.tool,
    toolCallId: input.toolCallId,
    entryId: input.entryId,
    ts: input.ts,
  };
  registry.set(id, tr);
  return tr;
}

/** 按 id 查块元数据 */
export function lookupBlock(id: string): BlockTrace | undefined {
  return registry.get(id);
}

/** 注册 TUI 组件（供 highlight 染色） */
export function registerComponent(id: string, component: unknown): void {
  components.set(id, component);
}

/** 取已注册的 TUI 组件 */
export function getComponent(id: string): unknown {
  return components.get(id);
}

/** 注销组件（组件销毁时） */
export function unregisterComponent(id: string): void {
  components.delete(id);
}

/** 测试/调试用：当前登记的块数 */
export function blockCount(): number {
  return registry.size;
}
