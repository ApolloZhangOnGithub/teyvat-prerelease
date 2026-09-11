import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { estimateTokens } from "#paths";

const PAIMON = path.join(homedir(), ".teyvat");
const PLIST = path.join(PAIMON, "MemoryData", "plist.json");

// ── helpers ──

function readFile(p: string): string {
  try { return fs.readFileSync(p, "utf-8"); } catch (e) { console.error("[god.frontend.tui/commands/infos.ts] " + ((e as any)?.message || e)); return ""; }
}

function loadPlist(): any[] {
  try { return JSON.parse(fs.readFileSync(PLIST, "utf8")); } catch (e) { console.error("[god.frontend.tui/commands/infos.ts] " + ((e as any)?.message || e)); return []; }
}

// ── Page 1: Identity ──

function renderIdentity(query: string): string[] {
  const ref = query || process.env.PAIMON_AGENT_ID || process.env.PAIMON_AGENT_NAME || "";
  if (!ref) return ["  usage: /identity [id|name]"];

  const list = loadPlist();
  const record = list.find((p: any) => p.id === ref) || list.find((p: any) => p.name === ref);
  if (!record) return [`  agent "${ref}" not found`];

  const D = "\x1b[90m"; const R = "\x1b[0m"; const B = "\x1b[1m"; const A = "\x1b[96m";
  const lines: string[] = [];
  lines.push(`  ${B}${A}Agent Identity${R}`);
  lines.push("");
  lines.push(`  ID:       ${record.id}`);
  // 2026-08-18 补 session hash：footer 显示但鼠标选不中（TUI 每帧差分重绘打断选中），
  // 身份命令输出到消息区可复制（与 footer.js 同款 process.title 正则）
  try {
    const m = process.title.match(/genshin:[^(]+\([^,]+,[^,]+,\s*([^)]+)/);
    if (m) lines.push(`  Session:  ${m[1]}`);
  } catch (e) { console.error("[god.frontend.tui/commands/infos.ts] " + ((e as any)?.message || e)); }
  lines.push(`  Name:     ${record.name}`);
  if (record.kind) lines.push(`  Kind:     ${record.kind}`);
  if (record.model) lines.push(`  Model:    ${record.model}`);
  if (record.created) lines.push(`  Created:  ${record.created.slice(0, 19).replace("T", " ")}`);
  if (record.lastSeen) lines.push(`  LastSeen: ${record.lastSeen.slice(0, 19).replace("T", " ")}`);
  if (record.org) lines.push(`  Org:      ${record.org}`);
  if (record.archived) lines.push(`  Status:   ${D}archived${R}`);
  if (record.note) lines.push(`  Note:     ${record.note}`);

  const idFile = path.join(PAIMON, "IdentityData", record.id, "identity.json");
  try {
    const idData = JSON.parse(fs.readFileSync(idFile, "utf8"));
    if (Array.isArray(idData.renameHistory) && idData.renameHistory.length) {
      lines.push("");
      lines.push(`  ${D}Rename History${R}`);
      for (const r of idData.renameHistory.slice(0, 10)) {
        lines.push(`  ${D}${r.at?.slice(0, 10) || "?"}${R}  ${r.from} → ${r.to}`);
      }
    }
  } catch (e) { console.error("[god.frontend.tui/commands/infos.ts] " + ((e as any)?.message || e)); }

  const memDir = path.join(PAIMON, "MemoryData", record.id);
  if (fs.existsSync(memDir)) {
    let size = 0;
    const walk = (d: string) => {
      try {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) walk(fp);
          else try { size += fs.statSync(fp).size; } catch (e) { console.error("[god.frontend.tui/commands/infos.ts] " + ((e as any)?.message || e)); }
        }
      } catch (e) { console.error("[god.frontend.tui/commands/infos.ts] " + ((e as any)?.message || e)); }
    };
    walk(memDir);
    lines.push("");
    lines.push(`  Memory:   ${(size / 1024).toFixed(0)} KB`);
  }

  return lines;
}

// ── Page 2: Context Usage ──

function renderContextUsage(): string[] {
  const personDir: string | undefined = (globalThis as any).__genshinPersonDir;
  if (!personDir) return ["  No person directory."];

  const modelMax = parseInt(process.env.PI_MODEL_MAX_TOKENS || "") || 1000000;
  const model = process.env.PI_MODEL || "deepseek";
  const windowLabel = modelMax >= 1000000
    ? (modelMax / 1000000).toFixed(0) + "M context"
    : (modelMax / 1000).toFixed(0) + "k context";

  const dnaIndex = readFile(path.join(personDir, "dna/index.md"));
  const cortex = readFile(path.join(personDir, "neocortex.md"));
  const workMem = readFile(path.join(personDir, "work_memory.md"));
  const context = readFile(path.join(personDir, "context.md"));
  const deepCortex = readFile(path.join(personDir, "deep_cortex.md"));

  const cats = [
    { name: "DNA",          tokens: estimateTokens(dnaIndex),  color: "\x1b[90m" },
    { name: "Cortex",       tokens: estimateTokens(cortex),    color: "\x1b[33m" },
    { name: "Work Memory",  tokens: estimateTokens(workMem),   color: "\x1b[32m" },
    { name: "Context",      tokens: estimateTokens(context),   color: "\x1b[34m" },
  ];
  const used = cats.reduce((s, c) => s + c.tokens, 0);
  const free = Math.max(0, modelMax - used);
  const total = modelMax;
  const pct = (n: number) => total > 0 ? (n / total * 100).toFixed(1) : "0.0";
  const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
  const R = "\x1b[0m";
  const D = "\x1b[90m";
  const B = "\x1b[1m";
  const A = "\x1b[96m";

  const cols = 20;
  const totalCells = 200;
  const cellSize = total / totalCells;
  const rows = Math.ceil(totalCells / cols);
  const grid: string[] = [];
  let cellIdx = 0;
  for (let r = 0; r < rows; r++) {
    let row = "    ";
    for (let c = 0; c < cols; c++) {
      if (cellIdx >= totalCells) { row += "  "; cellIdx++; continue; }
      const cellMid = (cellIdx + 0.5) * cellSize;
      let acc = 0; let ci = -1;
      for (let i = 0; i < cats.length; i++) { acc += cats[i].tokens; if (cellMid < acc) { ci = i; break; } }
      row += ci >= 0 ? cats[ci].color + "\u25C9 " + R : D + "\u25E6 " + R;
      cellIdx++;
    }
    grid.push(row);
  }

  const info = [
    `${B}${A}Context Usage${R}`,
    `${B}${model} (${windowLabel})${R}`,
    `${fmt(used)}/${fmt(total)} tokens (${pct(used)}%)`,
    ``,
    `${D}Estimated usage by category${R}`,
  ];
  for (const c of cats) {
    if (c.tokens > 0) info.push(`${c.color}\u25C9${R} ${c.name}: ${fmt(c.tokens)} tokens (${pct(c.tokens)}%)`);
  }
  info.push(`${D}\u25E6${R} Free space: ${fmt(free)} (${pct(free)}%)`);
  if (deepCortex) info.push(`${D}\u25CE${R} Deep Cortex (disk): ${fmt(estimateTokens(deepCortex))} tokens`);

  const gridW = 4 + cols * 2;
  const pad = " ".repeat(gridW);
  const lines: string[] = [""];
  const maxRows = Math.max(grid.length, info.length);
  for (let i = 0; i < maxRows; i++) {
    const left = i < grid.length ? grid[i] : pad;
    const right = i < info.length ? "  " + info[i] : "";
    lines.push(left + right);
  }

  return lines;
}

// ── main handler ──

export async function identityHandler(args: any, ctx: any) {
  const query = typeof args === "string" ? args.trim() : args?.args?.trim?.() || "";

  const identityLines = renderIdentity(query);
  const contextLines = renderContextUsage();

  const allLines = [...identityLines, "", ...contextLines];
  await ctx.ui.select("Identity", allLines);
}
