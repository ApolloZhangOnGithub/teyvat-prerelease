// debug.ts — 统一 Debug 管线
//
// 用法：
//   import { debug } from '#gene_riboswitch';
//   if (debug.enabled('D0001')) { debug.log('D0001', 'msg'); }
//
// 启用：PI_DEBUG=D0001,D0003
// 输出：~/.teyvat/DebugData/<personId>/debug.log (JSONL)

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 注册表：所有 debug ID 集中登记 ──────────────────────────────────────
// 新增 ID 时在这里加一行，check-debug.sh 自动扫描校验。
const REGISTRY: Record<string, { category: string; desc: string; file?: string }> = {
  // Heart (D0001–D0099)
  D0001: { category: "Heart", desc: "状态转换日志 (dlog)" },
  D0002: { category: "Heart", desc: "hibernate bgCount 追踪" },
  D0003: { category: "TUI",   desc: "StatusBar tick 计时" },
  D0004: { category: "TUI",   desc: "setStatus 状态变更" },

  // TUI (D0100–D0199)
  D0100: { category: "TUI",   desc: "渲染错误日志" },
  D0101: { category: "TUI",   desc: "TUI 通用日志" },
  D0103: { category: "TUI",   desc: "diff 调试日志" },

  // Mobile (D0200–D0299)
  D0200: { category: "Mobile", desc: "Safari 调试日志" },

  // Metaconsciousness (D0300–D0399)
  D0300: { category: "Meta",  desc: "MC spawn 启动日志" },

  // Hippocampus (D0400–D0499)
  D0400: { category: "Hippo", desc: "HC 通用调试日志" },

  // General (D1000–D1099)
  D1000: { category: "General", desc: "catch errors 兜底日志" },
};

// ── 运行时 ──────────────────────────────────────────────────────────

let _enabled: Set<string> | null = null;

function getEnabled(): Set<string> {
  if (_enabled) return _enabled;
  const raw = process.env.PI_DEBUG || "";
  _enabled = new Set(
    raw.split(",").map(s => s.trim()).filter(s => s.startsWith("D") && s.length === 5)
  );
  return _enabled;
}

function getLogPath(): string {
  try {
    const pid = (globalThis as any).__genshinPersonId || "unknown";
    const dir = join(homedir(), ".teyvat", "DebugData", pid);
    mkdirSync(dir, { recursive: true });
    return join(dir, "debug.log");
  } catch (e) { console.error("[spirit.bio.gene/_debug_riboswitch.ts] " + ((e as any)?.message || e));
    return join(homedir(), ".teyvat/LogData/unknown/debug.log");
  }
}

export const debug = {
  /** 检查指定 ID 是否启用 */
  enabled(id: string): boolean {
    return getEnabled().has(id);
  },

  /** 写入调试日志（JSONL 格式，自动附加 ts 和 id） */
  log(id: string, msg: string | Record<string, any>): void {
    if (!this.enabled(id)) return;
    try {
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        id,
        msg: typeof msg === "string" ? msg : JSON.stringify(msg),
      });
      appendFileSync(getLogPath(), entry + "\n");
    } catch (e) { console.error("[spirit.bio.gene/_debug_riboswitch.ts] " + ((e as any)?.message || e)); /* 静默吞错——debug 不能影响正常流程 */ }
  },

  /** 列出所有已注册的 ID（用于 check-debug.sh） */
  get registry(): Readonly<typeof REGISTRY> { return REGISTRY; },
};
