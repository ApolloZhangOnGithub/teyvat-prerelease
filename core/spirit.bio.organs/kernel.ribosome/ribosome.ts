// kernel.ribosome/blood.ts
// ── 核糖体侧 ─────────────────────────────────────────────────────────────────
// 读取 RNA 转录本（spirit.bio.gene/_built-rna.json），把 prompt 交给各个 func（蛋白质）。
// 这是机器，不是基因。func 不再硬编码 prompt 文本，而是向这里取：
//   getPrompt("heart.continuous")              —— func 级 prompt（按 coded:name）
//   getDuty("brain.hippocampus", "sleep.night") —— 某 mode 下的职责 prompt（按 in/duty 的 coded:）
//
// _built-rna.json 由 spirit.bio.gene/transpiler.ts 生成。改了 .dna 要重新转录。
// 路径解析：默认相对本文件 ../../spirit.bio.gene/_built-rna.json；可用环境变量 PI_ALIVE_RNA 覆盖（部署用）。
// 文档: B.docs/Dev.Common/Wiki/RNA(Bio Element).WIKI
// 文档: B.docs/Dev.Common/Wiki/Blood(Bio Mechanism).WIKI

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = resolve(RUNTIME_DIR, "../..");
const RNA_PATH = process.env.PI_ALIVE_RNA || resolve(CORE_ROOT, "spirit.bio.gene/rna.json");

// ── RNA 类型（与 transpiler 输出对应，宽松定义）──
interface Duty { name: string; desc: string | null; coded: string | null; prompt: string | null }
interface RnaFunc {
  name: string;
  path: string | null;
  future: boolean;
  session: string[];
  modes: Record<string, "abled" | "disabled">;
  alias: string[];
  modules: string[];
  belong: string[];
  tags: string[];
  promptRefs: string[];
  prompts: Record<string, string>;
  duties: Record<string, Duty[]>;
}
interface Rna {
  sessions: string[];
  modes: Record<string, { name: string; alias: string[] }>;
  tags: Record<string, any>;
  funcs: Record<string, RnaFunc>;
  coded: Record<string, string>;
  aliasToReal: Record<string, string>;
  errors: string[];
  warnings: string[];
}

// ── 懒加载 + 校验 ──
let _rna: Rna | null = null;
export function reloadRNA(): void { _rna = null; }
export function rna(): Rna {
  if (_rna) return _rna;
  // 1. 加载 RNA（从 coded.dna 编译的转录本）
  let raw: Rna;
  try {
    raw = JSON.parse(readFileSync(RNA_PATH, "utf8"));
  } catch (e: any) {
    throw new Error(`[teyvat] 读不到 RNA: ${RNA_PATH}\n先转录：bun spirit.bio.gene/transpiler.ts\n${e?.message ?? e}`);
  }
  if (raw.errors?.length) {
    throw new Error(`[teyvat] RNA 含 ${raw.errors.length} 个错误，拒绝运行：\n  ` + raw.errors.join("\n  "));
  }
  // 2. 缓存
  _rna = raw;
  return raw;
}

// ── 运行期状态：当前 mode / session 角色 ──
let _mode: string = process.env.PI_ALIVE_MODE || "DWN";
let _sessionRole: string = "main";

// ── prompt 取用（从 _built-rna.json 的 coded 段读取，装配式设计）────────────

export function getPrompt(name: string): string {
  const coded = rna().coded;
  const p = coded[name];
  if (p === undefined) {
    throw new Error(`[teyvat] prompt 不存在: "${name}"（检查 *.DNA 是否有 # ${name} 分区，并确认 assembly.dna 引用了它）`);
  }
  return p;
}

/** 取某 func 在某 mode 下的职责列表（含已解析的 prompt）。无则空数组。 */
export function getDuty(funcName: string, mode: string = _mode): Duty[] {
  return rna().funcs[funcName]?.duties[mode] ?? [];
}

/** 取某 func 在某 mode 下「第一个」职责的 prompt（最常见用法）。无则 null。 */
export function getDutyPrompt(funcName: string, mode: string = _mode): string | null {
  const d = getDuty(funcName, mode);
  return d.length ? d[0].prompt : null;
}

/** 取某 func 声明的所有 func 级 coded prompt（已解析）。 */
export function getFuncPrompts(funcName: string): string[] {
  const f = rna().funcs[funcName];
  if (!f) return [];
  return f.promptRefs.map((r) => f.prompts[r]).filter((x): x is string => !!x);
}

// ── 工具 ↔ CHR 联动（工具开关精确控制 coded prompt 加载）──────────────
// manifest 工具条目可带 chr 字段（对应 coded prompt 名），如 amem→memory.amem。
// 工具激活时返回对应 prompt 内容；未激活/无 chr 映射的工具不返回。
// 数据源: spirit.bio.gene/tools.manifest.json（与 core.ts 过滤同一份）。
import { readFileSync as _rfs, existsSync as _es } from "node:fs";
import { resolve as _resolve, dirname as _dirname } from "node:path";
import { fileURLToPath as _furl } from "node:url";

let _toolChrCache: Record<string, string> | null = null;
export function reloadToolChr(): void { _toolChrCache = null; }
function toolChrMap(): Record<string, string> {
  if (_toolChrCache) return _toolChrCache;
  // 2026-08-20 修复：旧名 readToolManifest 已重构为 getToolManifest（重构遗留——
  // 调用未定义函数导致 tool↔CHR 联动从未工作，错误被空 catch 吞，console-error.log 实测发现）
  const m = getToolManifest();
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(m.tools || {})) {
    const chr = (v as any)?.chr;
    if (typeof chr === "string" && chr) out[name] = chr;
  }
  _toolChrCache = out;
  return out;
}

// 完整工具清单（含 desc/group/default/chr），供 help 工具等按需查询。
let _toolManifestCache: any = null;
export function reloadToolManifest(): void { _toolManifestCache = null; }
export function getToolManifest(): any {
  if (_toolManifestCache) return _toolManifestCache;
  const mPath = _resolve(_dirname(fileURLToPath(import.meta.url)), "../..", "spirit.bio.gene/tools.manifest.json");
  const mPathAlt = process.env.PI_ALIVE_MANIFEST || mPath;
  try {
    _toolManifestCache = JSON.parse(_rfs(_es(mPathAlt) ? mPathAlt : mPath, "utf8"));
  } catch { _toolManifestCache = { tools: {} }; }
  return _toolManifestCache;
}

/** 给定激活工具列表，返回应注入的 coded prompt 内容数组（按 manifest chr 映射）。 */
export function getActiveToolChrPrompts(activeTools: string[]): string[] {
  const map = toolChrMap();
  const out: string[] = [];
  for (const t of activeTools || []) {
    const chr = map[t];
    if (!chr) continue;
    try {
      const p = rna().coded[chr];
      if (p) out.push(p);
    } catch (e) { console.error("[spirit.bio.organs/kernel.ribosome/ribosome.ts] " + ((e as any)?.message || e)); }
  }
  return out;
}

// ── func / mode / session 查询 ───────────────────────────────────────────────

export function getFunc(funcName: string): RnaFunc | undefined {
  // 支持 alias
  const real = rna().funcs[funcName] ? funcName : rna().aliasToReal[funcName];
  return real ? rna().funcs[real] : undefined;
}

export function listFuncs(opts?: { includeFuture?: boolean }): RnaFunc[] {
  const all = Object.values(rna().funcs);
  return opts?.includeFuture ? all : all.filter((f) => !f.future);
}

/** func 是否在某 mode 下启用。 */
export function isAbled(funcName: string, mode: string = _mode): boolean {
  return getFunc(funcName)?.modes[mode] === "abled";
}

/** func 是否该在某 session 角色里加载（session 含 "all" 或包含该角色即是）。 */
export function runsInSession(funcName: string, role: string = _sessionRole): boolean {
  const s = getFunc(funcName)?.session ?? [];
  return s.includes("all") || s.includes(role);
}

// ── mode 状态 ────────────────────────────────────────────────────────────────

export function getMode(): string { return _mode; }
export function listModes(): string[] { return Object.keys(rna().modes); }
export function setMode(mode: string): void {
  // 支持 alias（wake→DWN, sleep→sleep.night）
  const real = rna().modes[mode]
    ? mode
    : Object.values(rna().modes).find((m) => m.alias.includes(mode))?.name;
  if (!real) throw new Error(`[teyvat] 未知 mode: "${mode}"，可用: ${listModes().join(", ")}`);
  _mode = real;
}

// ── session 角色（由 kernel 在 session_start 时设置）──
export function getSessionRole(): string { return _sessionRole; }
export function setSessionRole(role: string): void { _sessionRole = role; }

// ── 调试：原始 RNA ──
export function rnaRaw(): Rna { return rna(); }
