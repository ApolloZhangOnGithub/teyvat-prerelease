// spirit.bio.gene/transpiler.ts
// ── RNA 装配器 ────────────────────────────────────────────────────────────────
// 把基因组装配成 RNA（spirit.bio.gene/rna.json）。
// 输入：promotor.dna（引导区声明，fun 语言）+ CHRs/*.CHR（内容件，每条染色体 = 一个基因序列单元）
// 输入：promotor.dna（引导区声明，fun 语言）+ CHRs/*.CHR（染色体内容件）
//
// 两套解析器：
//   parseAssembler() —— 缩进式声明语言：vir / func / session / mode / tag / in / duty / coded:
//   parseAssemblee()  —— 解析 CHRs/*.CHR 的 `# 分节`（纯提示，无声明）
//
// 然后 compile()：补全双向 belong/contain、解析 mode:abled、把 coded:name 解析成实际 prompt、
// 校验（未声明的 vir 前缀=error，缺 session/mode=warning，coded 引用不到=error）。
//
// 运行：  bun spirit.bio.gene/transpiler.ts
// 产物：  spirit.bio.gene/rna.json

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logerr } from "#paths";

const GENE_ROOT = dirname(fileURLToPath(import.meta.url));
const ORGANS_DIR = resolve(GENE_ROOT, "../spirit.bio.organs");

// ── 类型 ─────────────────────────────────────────────────────────────────────
type Duty = { name: string; desc: string; coded: string | null };
type FuncDecl = {
  name: string;
  future: boolean;
  session: string[]; // ["all"] / ["none"] / ["main", ...]
  abled: { mode: "any" | "none" | "list"; list: string[] };
  alias: string[];
  modules: string[];
  belong: string[];
  contain: string[];
  codedRefs: string[]; // func 级 coded:（不分 mode）
  path?: string; // func 声明 `path:` 显式指定入口目录（2026-08-18 加；覆盖默认推导 spirit.bio.organs/{name}）
  duties: Record<string, Duty[]>; // mode -> duties（来自 `in <mode>`）
};
type ModeDecl = { name: string; alias: string[]; abled: string[] };
type TagDecl = { name: string; belong: string[]; contain: string[] };

// ── 工具 ─────────────────────────────────────────────────────────────────────
const stripComment = (l: string) => {
  const i = l.indexOf("//");
  return i >= 0 ? l.slice(0, i) : l;
};
const indentOf = (l: string) => l.length - l.replace(/^ +/, "").length;
const splitList = (s: string) =>
  s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

// ── 解析 promotor.dna（引导区声明）──────────────────────────────────────
function parseAssembler(text: string) {
  const virs = new Set<string>(); // 去掉前导 . 的 vir 地址，如 "body" / "body.hands"
  const funcs: Record<string, FuncDecl> = {};
  const modes: Record<string, ModeDecl> = {};
  const sessions: string[] = [];
  const tags: Record<string, TagDecl> = {};

  let cur: { kind: "func" | "mode" | "tag" | "vir"; name: string } | null = null;
  let curIn: string | null = null; // func 内当前 `in <mode>`
  let curDuty: Duty | null = null;

  const lines = text.split("\n");
  for (const raw of lines) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = indentOf(line);
    const t = line.trim();

    // ── 顶层声明（indent 0）──
    if (indent === 0) {
      curIn = null;
      curDuty = null;
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^vir\s+\.(\S+)/))) {
        virs.add(m[1]);
        cur = { kind: "vir", name: m[1] };
      } else if ((m = t.match(/^((?:@[A-Za-z]+\s+)*)(?:future\s+)?func\s+(\S+)/))) {
        const name = m[2];
        const tags = (m[1] || "").trim().split(/\s+/).filter(Boolean);
        const isFuture = tags.includes("@FUTURE") || tags.includes("@ABANDONED") || !!m[1]?.includes("future");
        funcs[name] = {
          name,
          future: isFuture,
          session: [],
          abled: { mode: "list", list: [] },
          alias: [],
          modules: [],
          belong: [],
          contain: [],
          codedRefs: [],
          duties: {},
        };
        cur = { kind: "func", name };
      } else if ((m = t.match(/^session\s+(\S+)/))) {
        if (!sessions.includes(m[1])) sessions.push(m[1]);
        cur = null;
      } else if ((m = t.match(/^mode\s+(\S+)/))) {
        modes[m[1]] = { name: m[1], alias: [], abled: [] };
        cur = { kind: "mode", name: m[1] };
      } else if ((m = t.match(/^tag\s+(\S+)/))) {
        tags[m[1]] = { name: m[1], belong: [], contain: [] };
        cur = { kind: "tag", name: m[1] };
      } else {
        cur = null;
      }
      continue;
    }

    // ── 缩进行：归属当前顶层块 ──
    if (!cur) continue;

    if (cur.kind === "func") {
      const f = funcs[cur.name];
      let m: RegExpMatchArray | null;
      // func 级属性 → 重置 in/duty 上下文
      if ((m = t.match(/^session\s+(.+)/))) {
        f.session = splitList(m[1]);
        curIn = null; curDuty = null;
      } else if ((m = t.match(/^path:\s*(\S+)/))) {
        // 2026-08-18 显式入口目录：func 声明 `path: <目录>`（覆盖默认推导 spirit.bio.organs/{name}）——
        // 特例必须声明（如 hands.fileacts-read 入口在 hands.fileacts/、universe.infotech/local.mobile 在 A.core 顶层），不是容错是准确声明。
        f.path = m[1]; curIn = null; curDuty = null;
      } else if ((m = t.match(/^mode:abled\s+(.+)/))) {
        const list = splitList(m[1]);
        if (list.includes("any")) f.abled = { mode: "any", list: [] };
        else if (list.includes("none")) f.abled = { mode: "none", list: [] };
        else f.abled = { mode: "list", list };
        curIn = null; curDuty = null;
      } else if (t.match(/^mode:disabled\s+/)) {
        curIn = null; curDuty = null; // 暂不支持减法，忽略
      } else if ((m = t.match(/^alias\s+(.+)/))) {
        f.alias.push(...splitList(m[1])); curIn = null; curDuty = null;
      } else if ((m = t.match(/^module\s+(.+)/))) {
        f.modules.push(...splitList(m[1])); curIn = null; curDuty = null;
      } else if ((m = t.match(/^belong\s+(.+)/))) {
        f.belong.push(...splitList(m[1])); curIn = null; curDuty = null;
      } else if ((m = t.match(/^contain\s+(.+)/))) {
        f.contain.push(...splitList(m[1])); curIn = null; curDuty = null;
      } else if ((m = t.match(/^in\s+(\S+)/))) {
        curIn = m[1];
        if (!f.duties[curIn]) f.duties[curIn] = [];
        curDuty = null;
      } else if ((m = t.match(/^duty\s+(\S+)/))) {
        curDuty = { name: m[1], desc: "", coded: null };
        if (curIn) f.duties[curIn].push(curDuty);
      } else if ((m = t.match(/^coded:(\S+)/))) {
        if (curDuty) curDuty.coded = m[1];
        else f.codedRefs.push(m[1]); // func 级
      } else if (curDuty) {
        // duty 描述续行
        curDuty.desc = (curDuty.desc ? curDuty.desc + " " : "") + t;
      }
    } else if (cur.kind === "mode") {
      const md = modes[cur.name];
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^alias\s+(.+)/))) md.alias.push(...splitList(m[1]));
      else if ((m = t.match(/^abled\s*(.*)/))) md.abled.push(...splitList(m[1]));
    } else if (cur.kind === "tag") {
      const tg = tags[cur.name];
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^belong\s+(.+)/))) tg.belong.push(...splitList(m[1]));
      else if ((m = t.match(/^contain\s+(.+)/))) tg.contain.push(...splitList(m[1]));
    }
  }

  return { virs, funcs, modes, sessions, tags };
}

// ── 解析 CHRs/*.CHR（内容件，# 分节纯提示）──────────────────────────────
function parseAssemblee(text: string): Record<string, string> {
  // CHR 行注释：去前导空白后以 `;;` 开头的行是注释，装配时剔除（不注入，仅保留在 .CHR 里维护历史）。
  // 先剔注释行再分节——注释行里的 `# xxx` 不会误判成分节标记。
  const kept = text.split("\n").filter((l) => !l.trim().startsWith(";;")).join("\n");
  const out: Record<string, string> = {};
  // `# name` 分节：从 # 行到下个 # 行或文件尾
  const re = /^# (\S+)\s*$/gm;
  let m: RegExpExecArray | null;
  let lastIdx = 0;
  let lastName: string | null = null;
  while ((m = re.exec(kept))) {
    if (lastName !== null) {
      out[lastName] = kept.slice(lastIdx, m.index).trim();
    }
    lastName = m[1];
    lastIdx = m.index + m[0].length;
  }
  if (lastName !== null) out[lastName] = kept.slice(lastIdx).trim();
  return out;
}

// ── 编译：promotor + coded → RNA ─────────────────────────────────────────────
function compile(
  p: ReturnType<typeof parseAssembler>,
  coded: Record<string, string>,
  opts: { strict?: boolean } = {},
) {
  const strict = opts.strict !== false;
  const errors: string[] = [];
  const warnings: string[] = [];
  const modeNames = Object.keys(p.modes);

  // alias → 实名 解析表（func/tag 都能起别名）
  const aliasToReal: Record<string, string> = {};
  for (const f of Object.values(p.funcs))
    for (const a of f.alias) aliasToReal[a] = f.name;

  // ── 双向 belong/contain 补全（func ↔ tag）──
  const tagContains: Record<string, Set<string>> = {};
  const funcTags: Record<string, Set<string>> = {};
  for (const name of Object.keys(p.tags)) tagContains[name] = new Set();
  for (const name of Object.keys(p.funcs)) funcTags[name] = new Set();

  const resolveTag = (x: string) => p.tags[x] ? x : (aliasToReal[x] ?? x);

  // func.belong T  →  func∈T
  for (const f of Object.values(p.funcs)) {
    for (const b of f.belong) {
      const tg = resolveTag(b);
      if (!p.tags[tg]) { warnings.push(`func ${f.name} belong 未声明的 tag: ${b}`); continue; }
      funcTags[f.name].add(tg);
      tagContains[tg].add(f.name);
    }
  }
  // tag.contain X  →  X∈tag （X 可为 func 名 / alias / tag 命名空间内的相对 alias / 子 tag）
  for (const tg of Object.values(p.tags)) {
    for (const c of tg.contain) {
      // 解析顺序：实名 func → 全局 alias → tag 命名空间下的相对 alias（如 memory 下的 hippocampus = memory.hippocampus）
      let real = p.funcs[c] ? c : aliasToReal[c];
      if (!real && aliasToReal[`${tg.name}.${c}`]) real = aliasToReal[`${tg.name}.${c}`];
      real = real ?? c;
      if (p.funcs[real]) { funcTags[real].add(tg.name); tagContains[tg.name].add(real); }
      else if (p.tags[real]) { tagContains[tg.name].add(real); } // 子 tag 关系
      else warnings.push(`tag ${tg.name} contain 未知目标: ${c}`);
    }
  }

  // ── tag 传递闭包：dotted 父子（lobes.temporal ⊂ lobes）+ tag.belong 上级 ──
  const tagParents: Record<string, Set<string>> = {};
  for (const name of Object.keys(p.tags)) {
    tagParents[name] = new Set();
    // dotted 层级父：lobes.temporal → lobes
    const segs = name.split(".");
    for (let i = 1; i < segs.length; i++) {
      const anc = segs.slice(0, i).join(".");
      if (p.tags[anc]) tagParents[name].add(anc);
    }
    // 显式 tag.belong（如 lobes belong brain —— brain 是 vir，不是 tag，跳过非 tag）
    for (const b of p.tags[name].belong) {
      const r = resolveTag(b);
      if (p.tags[r]) tagParents[name].add(r);
    }
  }
  const allAncestors = (tag: string, seen = new Set<string>()): Set<string> => {
    for (const par of tagParents[tag] ?? []) {
      if (!seen.has(par)) { seen.add(par); allAncestors(par, seen); }
    }
    return seen;
  };

  // ── vir 前缀校验：func 名除最后一段外，每级前缀必须是已声明 vir（或本身是 func）──
  const checkVirPrefix = (name: string) => {
    const segs = name.split(".");
    for (let i = 1; i < segs.length; i++) {
      const pre = segs.slice(0, i).join(".");
      if (!p.virs.has(pre) && !p.funcs[pre]) {
        errors.push(`func ${name} 的前缀 .${pre} 未用 vir 声明`);
      }
    }
  };

  // ── coded 解析 ──
  const resolveCoded = (ref: string, where: string): string | null => {
    if (coded[ref] !== undefined) return coded[ref];
    errors.push(`${where} 引用的 coded:${ref} 在 assemblee 文件中找不到`);
    return null;
  };

  // ── 反向校验: assemblee 里每个分区都必须被至少一个 func 引用（变体模式跳过）──
  if (strict) {
    const allRefs = new Set<string>();
    for (const f of Object.values(p.funcs)) {
      for (const r of f.codedRefs) allRefs.add(r);
      for (const ds of Object.values(f.duties)) for (const d of ds) if (d.coded) allRefs.add(d.coded);
    }
    for (const k of Object.keys(coded)) {
      if (!allRefs.has(k)) {
        errors.push(`coded:${k} 在 CHR 分区中定义但没有任何 func 引用它。请在 promotor.dna 中对应的 func 下加 coded:${k}`);
      }
    }
  }

  // ── 检测 organs/ 下有 .ts 文件但未在 promotor.dna 声明的目录（变体跳过）──
  if (strict) try {
    // 基础设施库：只有具名导出、无 default(pi) 入口，不是 func，不该要求 promotor.dna 声明
    const INFRA_DIRS = new Set([
      "kernel.ribosome", "hands.executes", "kernel.core",
      "kernel.backbone", // 消息总线库 (#kernel_backbone)
      "kernel.nerves",   // 异步写入库 (#kernel_nerves)，被 brain.memory / brain.metaconsciousness 使用
    ]);
    const entries = readdirSync(ORGANS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || INFRA_DIRS.has(e.name)) continue;
      const dirPath = `${ORGANS_DIR}/${e.name}`;
      const hasTS = readdirSync(dirPath).some((f: string) => f.endsWith(".ts") && !f.includes(".CHANGELOG") && !f.endsWith(".SPEC"));
      if (hasTS && !p.funcs[e.name]) {
        warnings.push(`spirit.bio.organs/${e.name}/ 有 .ts 但未在 promotor.dna 声明 func。`);
      }
    }
  } catch (e) { console.error("[spirit.bio.gene/polymerase.ts] " + ((e as any)?.message || e)); }

  // ── 逐 func 生成 ──
  const rnaFuncs: Record<string, any> = {};
  for (const f of Object.values(p.funcs)) {
    checkVirPrefix(f.name);

    // session 默认
    let session = f.session;
    if (session.length === 0) {
      session = ["all"];
      if (!f.future) warnings.push(`func ${f.name} 未声明 session，默认 all`);
    }

    // 每个 mode 的启用状态
    const modesResolved: Record<string, "abled" | "disabled"> = {};
    if (f.abled.mode === "any") for (const m of modeNames) modesResolved[m] = "abled";
    else if (f.abled.mode === "none") for (const m of modeNames) modesResolved[m] = "disabled";
    else {
      if (f.abled.list.length === 0 && !f.future)
        warnings.push(`func ${f.name} 未声明 mode:abled，默认全部 disabled`);
      for (const m of modeNames)
        modesResolved[m] = f.abled.list.includes(m) ? "abled" : "disabled";
    }

    // func 级 coded（不分 mode）
    const prompts: Record<string, string> = {};
    for (const ref of f.codedRefs) {
      const txt = resolveCoded(ref, `func ${f.name}`);
      if (txt !== null) prompts[ref] = txt;
    }

    // 各 mode 的 duties（带解析后的 prompt）
    const duties: Record<string, any[]> = {};
    for (const [mode, list] of Object.entries(f.duties)) {
      duties[mode] = list.map((d) => {
        let prompt: string | null = null;
        if (d.coded) prompt = resolveCoded(d.coded, `func ${f.name} in ${mode} duty ${d.name}`);
        return { name: d.name, desc: d.desc || null, coded: d.coded, prompt };
      });
    }

    // tag 传递闭包
    const directTags = new Set(funcTags[f.name]);
    const transTags = new Set(directTags);
    for (const tg of directTags) for (const anc of allAncestors(tg)) transTags.add(anc);

    const entry: any = {
      name: f.name,
      future: f.future,
      session,
      modes: modesResolved,
    };
    // 空内容省略（rna 只输出有值的字段）
    // func 入口目录：显式 path 字段优先，否则默认推导（2026-08-18 修复：无脑推导曾产出错误 path，见上面解析注释）
    if (!f.future) entry.path = f.path || `spirit.bio.organs/${f.name}`;
    if (f.alias.length) entry.alias = f.alias;
    if (f.modules.length) entry.modules = f.modules;
    if (f.belong.length) entry.belong = f.belong;
    const tags = [...transTags].sort();
    const tagsDirect = [...directTags].sort();
    if (tags.length) entry.tags = tags;
    if (tagsDirect.length) entry.tagsDirect = tagsDirect;
    if (f.codedRefs.length) entry.promptRefs = f.codedRefs;
    if (Object.keys(prompts).length) entry.prompts = prompts;
    if (Object.keys(duties).length) entry.duties = duties;
    rnaFuncs[f.name] = entry;
  }

  // ── tag 表 ──
  const rnaTags: Record<string, any> = {};
  for (const [name, tg] of Object.entries(p.tags)) {
    rnaTags[name] = {
      name,
      belong: tg.belong,
      parents: [...(tagParents[name] ?? [])].sort(),
      members: [...tagContains[name]].sort(),
    };
  }

  // ── mode 表 ──
  const rnaModes: Record<string, any> = {};
  for (const [name, md] of Object.entries(p.modes))
    rnaModes[name] = { name, alias: md.alias };

  const out: any = {
    generatedFrom: ["spirit.bio.gene/promotor.dna", "spirit.bio.gene/CHRs/*.CHR"],
    note: "GENERATED by spirit.bio.gene/polymerase.ts — 不要手改，改 .dna/.CHR 后重新装配。",
    sessions: p.sessions,
    modes: rnaModes,
    tags: rnaTags,
    funcs: rnaFuncs,
    coded,
    aliasToReal,
  };
  // 空内容省略（无错误/警告时不输出）
  if (errors.length) out.errors = errors;
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
function transcribe(assemblerPath: string, assembleePaths: string[], outPath: string, label: string, strict = true) {
  const assemblerText = readFileSync(assemblerPath, "utf8");
  // 每个 assemblee 文件独立解析（避免文件间头部注释混入分区内容）
  const coded: Record<string, string> = {};
  for (const ap of assembleePaths) {
    Object.assign(coded, parseAssemblee(readFileSync(ap, "utf8")));
  }

  const parsed = parseAssembler(assemblerText);
  const rna = compile(parsed, coded, { strict });

  writeFileSync(outPath, JSON.stringify(rna, null, 2) + "\n");

  const F = Object.keys(rna.funcs).length;
  const C = Object.keys(coded).length;
  console.log(`transcribed → ${label}  (${F} funcs, ${C} coded prompts)`);
  for (const w of (rna.warnings || [])) console.log(`  WARN: ${w}`);
  for (const e of (rna.errors || [])) console.log(`  ✗ error:   ${e}`);
  if ((rna.errors || []).length) {
    console.log(`\n${rna.errors.length} error(s) — RNA 已写出但不应用于运行。`);
    process.exit(1);
  }
}

function main() {
  const CORE_ROOT = resolve(GENE_ROOT, "..");

  // 默认装配（coding-agent）：声明区 promotor.dna（代码，根目录）+ 内容区 CHRs/*.CHR
  const DNAS_DIR = `${GENE_ROOT}/CHRs`;
  const assembleePaths = readdirSync(DNAS_DIR)
    .filter((f: string) => f.endsWith(".CHR") && !f.includes(".REMOVED"))
    .map((f: string) => `${DNAS_DIR}/${f}`)
    .sort();
  transcribe(
    `${GENE_ROOT}/promotor.dna`,
    assembleePaths,
    `${GENE_ROOT}/rna.json`,
    "spirit.bio.gene/rna.json"
  );

  // 变体转录：扫描 variants.kinds.*/promotor.*.dna
  const variantsBase = resolve(CORE_ROOT, ".");
  try {
    for (const entry of readdirSync(variantsBase, { withFileTypes: true })) {
      if (!entry.name.startsWith("variants.kinds.") || !entry.isDirectory()) continue;
      const kind = entry.name.replace("variants.kinds.", "");
      const varDir = resolve(variantsBase, entry.name);
      const varPromotor = resolve(varDir, `promotor.${kind}.dna`);
      const varCoded = resolve(varDir, `coded.${kind}.dna`);
      try { readFileSync(varPromotor); } catch { continue; }
      const assembleePaths = [`${GENE_ROOT}/*_.DNA`];
      try { readFileSync(varCoded); } catch (e) { console.error("[spirit.bio.gene/polymerase.ts] " + ((e as any)?.message || e)); }
      const outPath = resolve(varDir, "rna.json");
      transcribe(varPromotor, assembleePaths, outPath, `variants.kinds.${kind}/rna.json`, false);
    }
  } catch (e) { console.error("[spirit.bio.gene/polymerase.ts] " + ((e as any)?.message || e)); }
}

main();
