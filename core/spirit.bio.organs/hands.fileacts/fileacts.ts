// 文档: B.docs/Dev.Common/Wiki/File-Conventions(Norm).WIKI
// 文档: B.docs/Dev.Common/Wiki/Hands(Organ).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { access, readFile, appendFile, rename as fsRename, mkdir, readdir, stat as fsStat } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { execSync, execFileSync } from "node:child_process";

import { getPrompt } from "#kernel_ribosome";
import { registerPaimonTool, sendCustomMessage, resultContent } from "#kernel_backbone";
import { renderToolCall, renderMessage } from "#tui_blockrender";
import { IS_DEV } from "#paths";
import { i18n } from "#tui_localizations";
// ══════ xattr 文件元数据（原 xattr.ts，整合至本文件）══════
const XATTR_KEY = "com.genshin.meta";
const XATTR_MAX_SIZE = 2048;
const XATTR_MAX_EDITS = 8;

interface XattrEditEntry {
  agent: string;
  ts: string;
  op: "write" | "edit" | "rename" | "remove";
  "+lines"?: number;
  "+chars"?: number;
  old?: string;
}

interface XattrFileMeta {
  created?: { agent: string; ts: string; name: string };
  edits?: XattrEditEntry[];
}

function getAgentName(): string {
  return process.env.PAIMON_AGENT_NAME || process.env.USER || "unknown";
}

function readMeta(filePath: string): XattrFileMeta | null {
  try {
    // 2026-09-13：改 execFileSync（argv 传参）——之前把 agent 提供的文件名拼进 shell 字符串，`x$(touch /tmp/pwn).md` 这类文件名会在 xattr 阶段执行且不经 validateExecute
    const raw = execFileSync("xattr", ["-p", XATTR_KEY, filePath], { encoding: "utf8", timeout: 2000, stdio: ["ignore","pipe","ignore"] });
    return JSON.parse(raw.trim());
  } catch { /* 2026-09-11（系统检查）：无 com.genshin.meta 属性 = 正常（绝大多数文件无 meta），xattr -p 非零退出不该打日志（原 → 50× spam）；返回 null 由调用方按无元数据处理 */
    return null;
  }
}

function writeMetaRaw(filePath: string, json: string): boolean {
  try {
    execFileSync("xattr", ["-w", XATTR_KEY, json, filePath], { timeout: 2000, stdio: "ignore" }); // 2026-09-13：argv 传参，不拼 shell
    return true;
  } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e));
    return false;
  }
}

function writeMeta(filePath: string, meta: XattrFileMeta): boolean {
  let json = JSON.stringify(meta);
  while (json.length > XATTR_MAX_SIZE && meta.edits && meta.edits.length > 0) {
    meta.edits.shift();
    json = JSON.stringify(meta);
  }
  return writeMetaRaw(filePath, json);
}

function initMeta(filePath: string, fileName: string): boolean {
  const meta: XattrFileMeta = {
    created: { agent: getAgentName(), ts: new Date().toISOString(), name: fileName },
    edits: [],
  };
  return writeMeta(filePath, meta);
}

function appendEdit(
  filePath: string,
  op: XattrEditEntry["op"],
  extra?: { lines?: number; chars?: number; oldName?: string }
): boolean {
  let meta = readMeta(filePath);
  if (!meta) {
    meta = { created: { agent: "unknown", ts: new Date().toISOString(), name: filePath }, edits: [] };
  }
  if (!meta.edits) meta.edits = [];
  const entry: XattrEditEntry = { agent: getAgentName(), ts: new Date().toISOString(), op };
  if (extra?.lines !== undefined) entry["+lines"] = extra.lines;
  if (extra?.chars !== undefined) entry["+chars"] = extra.chars;
  if (op === "rename" && extra?.oldName) entry.old = extra.oldName;
  meta.edits.push(entry);
  if (meta.edits.length > XATTR_MAX_EDITS) {
    meta.edits = meta.edits.slice(-XATTR_MAX_EDITS);
  }
  return writeMeta(filePath, meta);
}

// ══════ Trust / Authorization —— agent-based 白名单（设计见 Docs/Dev/Wiki/Trust.WIKI）══════
// 状态存 ~/.teyvat/config/authorize.json：在代码树外（部署 rsync 不清零），
// 又在 ~/.teyvat 系统黑名单内（agent 改不了 = 不能自授权）。
const AUTH_FILE = join(homedir(), ".teyvat/config/authorize.json");
const AGENT_WORK_ROOT = join(homedir(), ".teyvat/AgentWorkDir/Individual");
export interface TrustEntry { path: string; until?: number }
// 2026-09-22（用户定稿，ISSUE 142）：maxUploadMB —— 单文件上传上限（MB；默认 1、硬顶 30；`/a max-upload-size <MB>` 设置）
export interface AgentTrust { all?: boolean; root?: boolean; trusted: TrustEntry[]; maxUploadMB?: number }
let authDb: { agents: Record<string, AgentTrust> } = { agents: {} };
let _trustReady: Promise<void> | null = null;

// agent 身份：process.title = genshin:name(main,personId,sessionHash)，与 hands.terminal 同源
export function agentId(): string {
  const m = process.title.match(/genshin:[^(]+\([^,]+,\s*([^,)]+)/);
  return (m?.[1] || "unknown").trim().slice(0, 8);
}
export function agentWorkDir(): string { return join(AGENT_WORK_ROOT, agentId()); }
function isOwnWorkDir(abs: string): boolean { const w = agentWorkDir(); return abs === w || abs.startsWith(w + "/"); }

export async function loadTrust() {
  try {
    const data = JSON.parse(await fsReadFile(AUTH_FILE, "utf8"));
    authDb = data && typeof data === "object" && data.agents ? data : { agents: {} };
  } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e));
    authDb = { agents: {} };
  }
}

export async function saveTrust() {
  await mkdir(dirname(AUTH_FILE), { recursive: true }).catch(() => {});
  await fsWriteFile(AUTH_FILE, JSON.stringify(authDb, null, 2), "utf8");
}

export function agentEntry(): AgentTrust {
  return (authDb.agents[agentId()] ??= { trusted: [] });
}

// null=允许；string=拒绝理由（自带出路，不留死局）
function checkAuth(targetPath: string): string | null {
  if (!targetPath) return null;
  const abs = resolve(targetPath);
  if (isOwnWorkDir(abs)) return null; // 自己的 AgentWorkDir 常开
  const e = authDb.agents[agentId()];
  if (e?.all) return null; // 全量白名单（系统黑名单在上游 gate 已拦掉）
  const now = Date.now();
  for (const t of e?.trusted ?? []) {
    if (t.until && t.until <= now) continue;
    if (abs === t.path || abs.startsWith(t.path + "/")) return null;
  }
  const hint = basename(abs).includes(".") ? dirname(abs) : abs; // 文件 → 建议授权其所在目录
  return i18n(`${targetPath} 不在你的白名单内。两条出路：\n` +
    `1. 只是想落盘、不挑路径 → 写到你的工作目录: ${agentWorkDir()}/\n` +
    `2. 确实需要写这个路径 → 说明理由并把下面这行原样给用户，由用户在输入框执行（/a 是用户侧斜杠命令，agent 自己无法执行）：\n` +
    `   /a ${hint}`, `${targetPath} is not in your whitelist. Two options:\n` +
    `1. Just need to write somewhere → write to your workdir: ${agentWorkDir()}/\n` +
    `2. Really need this path → state the reason and give the line below verbatim to the user, who runs it in the input box (/a is a user-side slash command, the agent cannot run it):\n` +
    `   /a ${hint}`);
}

// ══════ File Rules (pattern-based bash blocking) ══════════════════════
const FILE_RULES = [
  { on: "bash", pattern: "gh\\s+repo\\s+(create|delete)|git\\s+push.*(--force|\\s-f\\b)|git\\s+reset.*--hard|git\\s+clean.*\\s-f\\b", block: i18n("GitHub / Git 敏感操作拦截", "GitHub / Git sensitive operation blocked") },
  { on: "bash", pattern: "mv.*UNREGULATED", block: i18n("UNREGULATED 文件不能 mv 出去", "UNREGULATED files cannot be moved out") },
];

// DEPRECATED(2026-08-12): CHANGELOG/HISTORY/NAMETRACE 已退役——职能被 minutely 的 MAKELOG.CHANGELOG
// + git commit + artifact 覆盖（见 Continents.DEFINATION）。仅 .SPEC 活跃（文件级设计意图，agent 轻量规格）。
// 本清单保留不删，向后兼容已有伴随文件。
const COMPANIONS = [".SPEC", ".CHANGELOG", ".HISTORY", ".NAMETRACE"]; // .LOCATIONTRACE removed
// 2026-09-14：DEPRECATED 的伴随文件自动生成（.HISTORY / .CHANGELOG / .NAMETRACE / 自动 .SPEC）默认关闭——
// 2026-09-13 把 tool_result 钩子从从不触发的 "input" 事件改到 "tool_result" 后，这些"保留不删"的死块被一并复活，
// 一天之内在用户所有仓库里生成了 69 个伴随文件并被 auto-checkpoint 提交。要恢复旧行为显式设 GENSHIN_COMPANIONS=1。
const COMPANIONS_ON = process.env.GENSHIN_COMPANIONS === "1";

// prompt 来自 coded.dna（coded fileactions.wise + fileactions.rules），由 runtime 取，不再硬编码。
const PROMPT = getPrompt("fileactions.wise");
const RULES_PROMPT = (() => { try { return getPrompt("fileactions.rules"); } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); return ""; } })();

function isExempt(path: string): boolean {
  // #human 目录下的 companion 文件也受保护，不豁免
  if (isHumanProtected(path)) return false;
  for (const ext of COMPANIONS) if (path.endsWith(ext)) return true;
  if (path.includes("/.git/") || path.startsWith(".git/")) return true;
  return false;
}

function isHumanProtected(path: string): boolean {
  return path.includes("#human.") || path.includes("#human/");
}

function isWalletProtected(path: string): boolean {
  const base = path.split("/").pop() || "";
  return base === "wallet.json" || base === "wallet.log" || base === "ubi.json";
}

function isSystemProtected(path: string): boolean {
  // 2026-09-13：统一小写比较——APFS 默认大小写不敏感，`/Users/x/.SSH/id_rsa`、`/.TEYVAT/config/…` 之前都不命中保护
  const p = path.replace(/\\/g, "/").toLowerCase();
  return p.includes("/.ssh/") || p.includes("/.ssh") ||
    p.includes("/.teyvat/agent/auth.json") ||
    p.includes("/.teyvat/trust.json") ||
    p.includes("/.teyvat/agent/models.json") ||
    p.includes("/fileacts.ts") ||
    p.includes("/pi-coding-agent/dist/") ||
    p.includes("/.teyvat/") ||
    // 2026-09-22（用户指出：本意**不是**拦整个 R 区——R.release/website 是生态**工作仓**，
    // 部署脚本、nginx 配置就在那儿，拦了反而做不了运维）：只把**已发布产物 / 历史版本**当系统保护，
    // 其余（website/ dev/ prerelease/ 等）放行 → 它们会继续走下面的 /a 白名单（checkAuth），安全性不降。
    p.includes("/r.release/build-artifacts/") ||
    p.includes("/r.release/historical/") ||
    p.includes("/.local/bin/pi") || p.includes("/.local/bin/genshin") ||
    p.includes("/.local/lib/teyvat/") ||
    isWalletProtected(path);
}

function fmt(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

async function exists(path: string): Promise<boolean> {
  // 2026-09-11（系统检查）：存在性谓词——ENOENT 是正常结果（返回 false），不该打日志；
  // 原实现对每次"文件不存在"都 console.error → dir.README 检测刷屏 431×。非 ENOENT（如 EACCES）仍记录。
  try { await access(path); return true; } catch (e) { if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); return false; }
}

// 沿着路径往上找到第一个【真实存在】的目录（要落进去的那个环境）。
async function nearestExistingDir(path: string): Promise<string> {
  let d = dirname(resolve(path));
  for (let i = 0; i < 60 && d.length > 1; i++) {
    if (await exists(d)) return d;
    d = dirname(d);
  }
  return d;
}

async function nonEmpty(path: string): Promise<boolean> {
  try { const c = await readFile(path, "utf8"); return c.trim().length > 0; } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); return false; }
}

async function lastLine(path: string): Promise<string> {
  try {
    const c = await readFile(path, "utf8");
    const lines = c.trim().split("\n");
    return lines[lines.length - 1]?.trim() ?? "";
  } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); return ""; }
}

async function moveCompanions(oldPath: string, newPath: string): Promise<void> {
  for (const ext of COMPANIONS) {
    const from = `${oldPath}${ext}`;
    const to = `${newPath}${ext}`;
    if (await exists(from)) {
      await mkdir(dirname(to), { recursive: true }).catch(() => {});
      await fsRename(from, to).catch(() => {});
    }
  }
}

function parseMv(cmd: string): { src: string; dst: string; isRename: boolean } | null {
  const m = cmd.match(/\bmv\s+(?:-[a-zA-Z]+\s+)*["']?([^\s"']+)["']?\s+["']?([^\s"']+)["']?\s*$/);
  if (!m) return null;
  const src = m[1]!;
  const dst = m[2]!;
  const srcDir = dirname(src);
  const dstDir = dst.endsWith("/") ? dst.slice(0, -1) : dirname(dst);
  const isRename = srcDir === dstDir || dirname(resolve(src)) === dirname(resolve(dst));
  return { src, dst, isRename };
}

// 他人私有数据目录判定（read/ls/grep/glob/write 等所有带 path 的工具共用；execute 走 validateExecute 里的同口径正则）
// 2026-09-13：之前"他人数据目录边界"只存在于 execute——`read ~/.teyvat/MemoryData/<other>/context.md` 直接通过，而 execute 里 cat 同一文件被拦。
// 软链解析：路径不存在时逐级向上找最近存在的祖先做 realpath，再把剩余段拼回去（2026-09-13：workdir 里
// `ln -s ~/.teyvat/MemoryData/<other> ./x` 后 `read ./x/context.md` 路径字符串完全不含他人目录，守卫只看字符串就放行了）
function _resolveSymlinks(abs: string): string {
  let cur = abs; const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try { return join(realpathSync(cur), ...[...rest].reverse()); } catch { /* 不存在 → 上退一级 */ }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    rest.push(basename(cur)); cur = parent;
  }
  return abs;
}
const PRIVATE_DIRS = "(?:MemoryData|SessionData|RuntimeCache|BlackboxData|IdentityData|AgentFileData|AppData|ExecuteData|LogData|ErrorData)";
const PRIVATE_DIR_RE = new RegExp("\\/\\.teyvat\\/" + PRIVATE_DIRS + "\\/([0-9a-f]{8})(?=\\/|$)", "i");
// ~/.teyvat（或 PAIMON_HOME）本身常是软链：软链解析后的真实路径里没有 ".teyvat" 这一段，再用真实根目录匹配一次
const PRIVATE_ROOT_RES: RegExp[] = (() => {
  const roots = new Set<string>();
  for (const r of [process.env.PAIMON_HOME, join(homedir(), ".teyvat")]) {
    if (!r) continue;
    try { roots.add(realpathSync(r)); } catch { /* 不存在就不加 */ }
  }
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...roots].map((r) => new RegExp("^" + esc(r) + "\\/" + PRIVATE_DIRS + "\\/([0-9a-f]{8})(?=\\/|$)", "i"));
})();
function _privateIdOf(p: string): string | null {
  const m = p.match(PRIVATE_DIR_RE);
  if (m) return m[1].toLowerCase();
  for (const re of PRIVATE_ROOT_RES) { const m2 = p.match(re); if (m2) return m2[1].toLowerCase(); }
  return null;
}
export function checkPrivateDataPath(p: string, selfId: string): string | null {
  if (!p) return null;
  const abs = resolve(p.replace(/^~(?=\/|$)/, homedir()));
  // 字符串路径与软链解析后的真实路径**各自**判定：任一命中他人目录即拦。
  //（不能"字符串命中自己就放行"——自己 workdir 里一条指向他人 MemoryData 的软链，字符串看着全是自己的目录）
  const ids = [abs, _resolveSymlinks(abs)].map(_privateIdOf).filter((x): x is string => !!x);
  const foreign = ids.find((x) => !selfId || x !== selfId.toLowerCase());
  if (!foreign) return null;
  const id = foreign;
  try { const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")); if (selfId && auth.agents?.[selfId]?.root) return null; } catch { /* 无 authorize.json → 不放行 */ }
  return i18n(`禁止访问其他 agent（${id}）的私有数据目录。`, `Access to another agent's (${id}) private data directory is forbidden.`);
}

// 去掉引号串（make/npm 的 msg/detail 参数可能含 rm/kill/;/&& 等词——它们是数据不是命令），用于"整条命令只由一个 X 命令构成"的判定
function _stripQuoted(cmd: string): string {
  return cmd.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
}

// ── Execute 命令校验（由 kernel.heart/process.ts 调用）──
// 2026-09-13 收紧（审计实测的绕过）：
//   ① make 豁免原来是"命令以 make 开头就整条放行"——`make -n; rm -rf ~/x` 直接过。现在：去掉引号串后整条必须只由 `[cd X &&] make …` 构成（不能再接 ; && || | 换行 $() 反引号）。
//   ② `npm install` 且含 "runtime" 的豁免原来写在 executes.ts 里、跳过整个 validateExecute——`echo runtime; npm i; rm -rf ~` 全部规则失效。同样收进这里、同样要求整条命令结构单一。
//   ③ cwd 参数原来不参与校验——`execute({command:"cat context.md", cwd:"~/.teyvat/MemoryData/<other>"})` 绕过他人目录守卫。现在拼成 `cd <cwd> && cmd` 后再做路径匹配。
//   ④ 内联代码禁令原来锚定行首且只认 python/bash——`cd . && python3 -c`、`sh -c`、`node -e`、`perl -e` 全放行。
//   ⑤ 凭据文件（~/.ssh、UserAccount、authorize/auth/models.json 等）在 execute 里毫无限制，与 read/upload 的保护不一致——补上。
//   ⑥ 自授权：RuntimeCache/<self>/*-auth* 是 full-reboot/switch-model 的授权标志，自己目录放行规则让 agent 能 `echo > …-auth.json` 自授权——写操作拦下。
export function validateExecute(cmd: string, selfId?: string, cwd?: string): { blocked: boolean; message?: string } {
  const stripped = _stripQuoted(cmd);
  const SINGLE_CMD_TAIL = "[^;&|\\n<>`$]*$";
  if (new RegExp("^\\s*(?:cd\\s+(?:\"\"|\\S+)\\s*&&\\s*)?make\\b" + SINGLE_CMD_TAIL, "i").test(stripped)) return { blocked: false };
  if (/\bnpm\s+(?:i|install)\b/i.test(cmd) && /runtime/.test(cmd) && new RegExp("^\\s*(?:cd\\s+(?:\"\"|\\S+)\\s*&&\\s*)?npm\\s+(?:i|install)\\b" + SINGLE_CMD_TAIL, "i").test(stripped)) return { blocked: false };
  if (/\brm\b/i.test(cmd)) return { blocked: true, message: i18n("禁止删除：按项目规范把文件改名为 .REMOVED（mv x x.REMOVED）；确需移出请用 trash 移入回收站。", "Deleting is forbidden: rename the file to .REMOVED (mv x x.REMOVED) per project rule; if it must go, use trash to move it to the recycle bin.") };
  if (/\bsed\b/i.test(cmd)) return { blocked: true, message: i18n("请勿使用 sed 命令。你可使用 Read 命令读取文件。", "Do not use the sed command. Use the Read command to read files.") };
  // 2026-09-22（用户：阻止裸 git commit——绕过 make 通道的提交通常缺 committer/msg/detail + 门禁，且会把半成品固化）：
  // make 流程会在环境里带 PAIMON_VIA_MAKE=1（C.deploy/Makefile L2 export）；命令里显式带该标记 = 声明自己在 make 流程内，放行。
  if (/\bgit\s+commit\b/i.test(cmd) && !/PAIMON_VIA_MAKE=1/.test(cmd)) return { blocked: true, message: i18n(`禁止裸 git commit。代码仓请用 make dev-minutely（带 committer/msg/detail + 门禁）；文档仓（B.docs）用 make doc-commit。确属 make 流程内，请在命令前带 PAIMON_VIA_MAKE=1。`, `Bare "git commit" is forbidden. For the code repo use make dev-minutely (committer/msg/detail + gates); for docs (B.docs) use make doc-commit. If you are indeed inside a make flow, prefix the command with PAIMON_VIA_MAKE=1.`) };
  if (/\b(?:python[23]?|bash|sh|zsh|node|perl|ruby)\s+-(?:c|e|eval)\b/.test(cmd)) return { blocked: true, message: i18n(`禁止直接执行解释器内联代码（python/bash/sh/node/perl/ruby -c/-e）。请在你的工作目录 ${agentWorkDir()}/ 下创建脚本文件再运行。`, `Inline interpreter code (python/bash/sh/node/perl/ruby -c/-e) is forbidden. Create a script file in your workdir ${agentWorkDir()}/ and run it.`) };
  if (/\bpython[23]?\s*<</.test(cmd) || /\bpython[23]?\s+-\s*$/.test(cmd)) return { blocked: true, message: i18n(`禁止直接执行 python 内联代码。请在你的工作目录 ${agentWorkDir()}/ 下创建 .py 文件，然后用 python <文件名>.py 运行。`, `Inline python code is forbidden. Create a .py file in your workdir ${agentWorkDir()}/ then run it with python <filename>.py.`) };
  if (/(kill|pkill|killall)\s.*genshin/i.test(cmd)) return { blocked: true, message: i18n("禁止杀掉 genshin 进程。用 genshin -k <序号> 或 /stop 正常终止。", "Killing the genshin process is forbidden. Use genshin -k <index> or /stop to terminate normally.") };
  // 禁止访问其他人数据目录；自己 ID 的 MemoryData/AgentFileData/ExecuteData 等放行
  //
  // 2026-09-11（prime-agent）修三个实测绕过（对非 root agent，用真实 validateExecute 跑出来的）：
  //   绕过A 绝对路径：守卫只认 `~/` 与 `$HOME/` 写法，`/Users/<user>/.teyvat/...` 直接放行 →
  //          现在先把字面 home 路径归一化成 `~` 再匹配。
  //   绕过B 自己+他人混在同一条命令：只要出现自己的数据目录就整条放行（`cat <self>/x; cat <other>/ctx` 混过）→
  //          现在先抽出命令里**所有** agent id，只有"没有任何外来 id"时才走自 id 放行。
  //   绕过C 夹带 AppData/shared：只要出现 shared 就整条放行（`ls AppData/shared; cat <other>/ctx` 混过）→
  //          同上，外来 id 优先判定为拦截。
  {
    const _home = homedir();
    const withCwd = cwd ? `cd ${cwd} && ${cmd}` : cmd;                       // ③ cwd 参与路径判定
    const norm = (_home ? withCwd.split(_home).join("~") : withCwd).replace(/\$HOME\//g, "~/").replace(/\/(?:\.\/)+/g, "/");   // 绝对路径/$HOME → ~，路径中的 /./ 归一（`~/.teyvat/./MemoryData/<other>` 曾绕过）
    // ⑤ 凭据文件：与 read（isSystemProtected）/ upload（UPLOAD_DENY_PATTERNS）同口径——execute 里 cat ~/.ssh/id_rsa | curl … 之前直接放行
    if (/~\/\.(?:ssh|aws|gnupg|codex)\/|~\/\.config\/gh\/|~\/\.teyvat\/(?:UserAccount\/|config\/(?:authorize|auth|env-keys|models)\b)|\b(?:id_rsa|id_ed25519)\b/i.test(norm)) {
      return { blocked: true, message: i18n("凭据/授权文件禁止在 Execute 里访问（~/.ssh、UserAccount、config/authorize|auth|models 等）。", "Credential/authorization files cannot be accessed via Execute (~/.ssh, UserAccount, config/authorize|auth|models, …).") };
    }
    // ⑥ 自授权标志文件写保护
    if (/RuntimeCache\/[0-9a-f]{8}\/[^\s"'|;&]*-auth(?:\.json)?\b/i.test(norm) && /(?:>|>>|\btee\b|\bcp\b|\bmv\b|\btouch\b|\binstall\b|\bdd\b|\bln\b)/.test(stripped)) {
      return { blocked: true, message: i18n("授权标志文件（RuntimeCache/<id>/*-auth*）只能由用户通过 /a 写入，agent 不能自授权。", "Authorization flag files (RuntimeCache/<id>/*-auth*) are written only by the user via /a; agents cannot self-authorize.") };
    }
    const PRIVATE_RE = /(?:~\/\.local\/lib\/genshin\/|~\/\.teyvat\/)(?:extensions|extensions-stable|MemoryData|SessionData|RuntimeCache|BlackboxData|IdentityData|AgentFileData|AppData|ExecuteData|LogData|config|UserAccount)/i;
    if (PRIVATE_RE.test(norm)) {
      const ids = new Set(
        [...norm.matchAll(/(?:MemoryData|AgentFileData|SessionData|RuntimeCache|BlackboxData|IdentityData|AppData|ExecuteData|LogData)\/([0-9a-f]{8})\b/gi)]
          .map((m) => m[1].toLowerCase())
      );
      const me = (selfId || "").toLowerCase();
      const foreign = [...ids].filter((id) => id !== me);
      if (foreign.length === 0) {
        if (me && ids.has(me)) return { blocked: false };              // 只碰自己的目录
        if (/AppData\/shared\//i.test(norm)) return { blocked: false }; // 共享区（且没碰别人私有目录）
      }
    // 如果 authorize.json 中当前 agent 有 root: true，全部放行
    try {
      const auth = JSON.parse(readFileSync(join(homedir(), ".teyvat/config/authorize.json"), "utf8"));
      if (selfId && auth.agents?.[selfId]?.root) {
        return { blocked: false };
      }
    } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
    return { blocked: true, message: i18n("禁止 Execute 操作他人数据目录。要读源码请用 Read 指定 DEV 路径。", "Execute on other agents' data dirs is forbidden. To read source, use Read with the DEV path.") };
    }   // ← if (PRIVATE_RE.test(norm))
  }     // ← 归一化块（_home / norm / PRIVATE_RE 作用域）
  if (/^\s*mv\s/i.test(cmd)) {
    const parsed = parseMv(cmd);
    if (!parsed) return { blocked: true, message: i18n("mv 格式不对。用法: mv <旧名> <新名>", "mv format invalid. Usage: mv <old-name> <new-name>") };
    if (!parsed.isRename) return { blocked: true, message: i18n("跨目录 mv 被拦截。用 edit 改文件内容，write 创建新文件。", "Cross-directory mv is blocked. Use edit to change file content, write to create new files.") };
    return { blocked: false };
  }
  return { blocked: false };
}

export default function (pi: ExtensionAPI) {
  // 2026-09-22（用户怒批：syntax-error 还走绿色菱形块）——这里旧版重复注册了 syntax-error 渲染器
  // （renderMessage.notice 默认绿色 ◆ Syntax），覆盖了 renderers.ts:160 的正确黄色 _sysMsg(...,"warning")。
  // 已删：syntax-error 渲染只保留 renderers.ts 那一处（黄色 system 块，与 system-error 一致）。
  _trustReady = loadTrust();

  const editedThisTurn = new Set<string>();
  const changelogUpdatedThisTurn = new Set<string>();
  const dirsSeen = new Set<string>();
  const readmesSeen = new Set<string>(); // 已读过的 dir.README，resolve 绝对路径
  const redirectedWrites = new Map<string, { from: string; to: string }>(); // write 软着陆：toolCallId → 重定向信息

  // ── write 重定向告知 + read 图片提示 ──
  pi.on("tool_result", async (event, _ctx) => {
    // write redirect
    const r = redirectedWrites.get(event.toolCallId);
    if (r) {
      redirectedWrites.delete(event.toolCallId);
      if (!event.isError) {
        const note = i18n(`\n[自动重定向] ${r.from} 不在白名单，新文件已写入你的工作目录: ${r.to}\n（需要写原路径请让用户执行: /a ${dirname(r.from)}）`, `\n[auto-redirected] ${r.from} is not whitelisted; the new file was written to your workdir: ${r.to}\n(to write the original path, ask the user to run: /a ${dirname(r.from)})`);
        return { content: [...(event.content ?? []), { type: "text", text: note }], details: event.details };
      }
      return;
    }
    // read 图片 + 模型不支持 → 提示用 Eyes
    if (event.toolName === "read" && !event.isError) {
      const path = (event.input as any)?.path ?? "";
      const ext = path.split(".").pop()?.toLowerCase() || "";
      const isImage = ["jpg","jpeg","png","gif","webp","bmp"].includes(ext);
      if (!isImage) return;
      const content = (event.content || []).map((c: any) => c.text || c.content || "").join("");
      if (content.includes("does not support images")) {
        const hint = i18n(`\n[提示] 当前模型不支持图片。如需查看该图片内容，请使用 Eyes ${path}`, `\n[tip] The current model cannot handle images. To view this image's content, use Eyes ${path}`);
        return { content: [...(event.content ?? []), { type: "text", text: hint }], details: event.details };
      }
    }
  });

  // ── prompt ───────────────────────────────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + PROMPT + (RULES_PROMPT ? "\n\n" + RULES_PROMPT : "") };
  });

  // ── tool_call: Write gate (spec required) ────────────────────────
  pi.on("tool_call", async (event: any, _ctx: any) => {
    if (_trustReady) await _trustReady;
    // ── Authorization check: 写/改/bash 必须在 workDir 或 trusted dir ──
    let authPath = (event.input as any).path ?? (event.input as any).file_path ?? "";
    // bash 没有 path 字段 → 从 command 抠目标路径。尽量抠全：重定向 > >> >| / cp mv ln install dest /
    // dd of= / tee / rm rmdir mkdir touch truncate。（以前抠不到就 fail-open 放行 = 沙箱被绕过的根。）
    if (!authPath && event.toolName === "bash") {
      const cmd: string = (event.input as any).command ?? "";
      const m = cmd.match(/(?:>>?|>\|)\s*['"]?([^\s'"&|;]+)/) ??
                cmd.match(/\b(?:cp|mv|ln|install)\s+(?:-\S+\s+)*\S+\s+['"]?([^\s'"&|;]+)/) ??
                cmd.match(/\bdd\s+.*\bof=['"]?([^\s'"&|;]+)/) ??
                cmd.match(/\btee\s+(?:-\S+\s+)*['"]?([^\s'"&|;]+)/) ??
                cmd.match(/\b(?:rm|rmdir|mkdir|touch|truncate)\s+(?:-\S+\s+)*['"]?([^\s'"&|;]+)/);
      if (m) authPath = m[1]!;
      else if (/\b(?:rm|rmdir)\b/.test(cmd)) {
        // 有删除操作却抠不到目标(复杂引号/变量/通配) → 绝不 fail-open。误删工作区外的东西比拦一下严重得多。
        return { block: true, reason: i18n("这条 bash 含 rm/rmdir 删除操作，但抠不到能核对的目标路径 —— 为防误删工作区外的东西，先拦下。把要删的路径写明确（绝对路径）再来。", "This bash command contains rm/rmdir deletes, but the target path cannot be extracted for verification — to avoid deleting something outside the workdir, it is blocked. Write the path explicitly (absolute) and retry.") };
      }
    }

    // ── AgentWorkDir 自由区：agent 自己的目录常开，越过系统保护与治理 gate（bash 不豁免，仍走下方各拦截）──
    if (authPath && event.toolName !== "bash" && isOwnWorkDir(resolve(authPath))) {
      await mkdir(agentWorkDir(), { recursive: true }).catch(() => {});
      return undefined;
    }

    // ── AgentWorkDir 公共目录写入重定向：误写 ~/.teyvat/AgentWorkDir/<file> 自动重定向到 Individual/<id>/ ──
    if (authPath && (event.toolName === "write" || event.toolName === "edit")) {
      const abs = resolve(authPath);
      const awdRoot = join(homedir(), ".teyvat/AgentWorkDir");
      if (abs.startsWith(awdRoot + "/") && !abs.startsWith(join(awdRoot, "Individual") + "/")) {
        const relToAwd = abs.slice(awdRoot.length + 1);
        const redirected = join(agentWorkDir(), relToAwd);
        if (event.toolName === "write" && (event.input as any)?.content != null) {
          await mkdir(dirname(redirected), { recursive: true }).catch(() => {});
          const { writeFileSync } = await import("node:fs");
          writeFileSync(redirected, String((event.input as any).content), "utf8");
          return { block: true, reason: i18n(
            `已自动重定向：文件已写入你的个人工作目录 ${redirected}（不能写公共 AgentWorkDir，以后请直接写 ${agentWorkDir()}/ 下）`,
            `Auto-redirected: file written to your personal workdir ${redirected} (cannot write shared AgentWorkDir, use ${agentWorkDir()}/ directly next time)`
          ) };
        }
        return { block: true, reason: i18n(
          `${authPath} 是公共目录，不能直接写。你的个人工作目录是 ${agentWorkDir()}/，请改用这个路径。`,
          `${authPath} is a shared directory, cannot write directly. Your personal workdir is ${agentWorkDir()}/. Use that path instead.`
        ) };
      }
    }

    // ── /tmp 禁止（2026-08-20 用户定稿）：write 默认禁 /tmp（临时文件应写 AgentWorkDir），force:true 才放行；
    //    bash 写 /tmp 一律禁（bash 无 force 参数，危险操作不留口子）。macOS /tmp → /private/tmp 一并拦。──
    if (authPath && (authPath.startsWith("/tmp/") || authPath === "/tmp" || authPath.startsWith("/private/tmp/"))) {
      if (event.toolName === "write" && (event.input as any)?.force === true) {
        // 用户显式 force 强制（写在临时目录的临时文件，模型自行负责清理）
      } else {
        return { block: true, reason: i18n(`写 /tmp 目录被禁止（临时文件请写你的 AgentWorkDir）。确需写 /tmp 时，write 加 force:true 强制。`, `Writing to /tmp is blocked (temporary files should go to your AgentWorkDir). If you really need to write /tmp, add force:true to write.`) };
      }
    }

    // ── 他人私有数据目录：所有带 path 的工具（含 read/ls/grep/glob）统一守卫 ──
    if (authPath) {
      // 2026-09-14：process.title 未设（session_start 早期 / K007 之后）时 agentId() 是 "unknown"，会把自己的目录当他人拦——退回 core 设的 __genshinPersonId
      const _self = agentId() !== "unknown" ? agentId() : String((globalThis as any).__genshinPersonId || "unknown");
      const foreign = checkPrivateDataPath(authPath, _self);
      if (foreign) return { block: true, reason: foreign };
    }

    // ── 系统保护: SSH密钥/凭证/钱包/自身代码/pi dist ──
    const apl = (authPath || "").toLowerCase(); // 2026-09-13：大小写不敏感文件系统上统一小写比较
    if (authPath && isSystemProtected(authPath)) {
      const isRead = ["read","view","ls","list","glob","grep","find"].includes(event.toolName);
      if (apl.includes("/.ssh/") || apl.includes("auth.json") || apl.includes("models.json")) {
        return { block: true, reason: i18n(`系统保护 — ${authPath.split("/").pop()} 是凭证文件，agent 不可访问。`, `System protected — ${authPath.split("/").pop()} is a credential file, not accessible to agents.`) };
      }
      if (apl.includes("/pi-coding-agent/dist/") || apl.includes("/.teyvat/agent/") || apl.includes("/.local/lib/teyvat/")) {
        if (!isRead) {
          return { block: true, reason: i18n(`请不要直接修改 ~/.local/lib/teyvat/ 下的文件。请修改开发源码 ~/Documents/Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core/ 下的对应文件，然后 cd C.deploy && make dev-minutely 部署。`, `Do not modify files under ~/.local/lib/teyvat/ directly. Edit the dev tree at ~/Documents/Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core/ and run: cd C.deploy && make dev-minutely.`) };
        }
        if (IS_DEV) {
          return { block: true, reason: i18n(`请不要读 ~/.teyvat/agent/。请阅读 ~/Documents/Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core/ 开发目录中的源文件。`, `Do not read ~/.teyvat/agent/. Read the source files in ~/Documents/Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core/.`) };
        }
      }
      // 2026-09-22：同上——只拦真正的发布产物/历史版本（构建 tarball、历史归档）。
      if ((apl.includes("/r.release/build-artifacts/") || apl.includes("/r.release/historical/")) && !isRead) {
        return { block: true, reason: i18n(`RELEASE 保护 — 构建产物/历史版本不可改（要改请改源码走 make）。`, `RELEASE protected — build artifacts / historical releases are immutable (change the source and use make).`) };
      }
      if (!isRead) {
        return { block: true, reason: i18n(`系统保护 — ${authPath.split("/").pop()} 由系统管理，agent 不可修改。`, `System protected — ${authPath.split("/").pop()} is managed by the system; agents cannot modify it.`) };
      }
    }

    // ── #human 保护: agent 默认不可修改 #human 目录下的任何文件（含 companion） ──
    if (authPath && isHumanProtected(authPath) && !["read","view","ls","list","glob","grep","find"].includes(event.toolName)) {
      return { block: true, reason: i18n(`#human 保护 — ${authPath} 位于 #human 目录，agent 默认不可修改。如需允许，请确认。`, `#human protected — ${authPath} is in a #human directory; agents cannot modify it by default. Ask the user to confirm if needed.`) };
    }

    if (authPath && !["read","view","ls","list","glob","grep","find"].includes(event.toolName)) {
      const authReason = checkAuth(authPath);
      if (authReason) {
        // write 新文件 → 软着陆：不拦，自动重定向到 agent 工作目录（混淆串防重名），tool_result 里告知落点
        if (event.toolName === "write" && !(await exists(authPath))) {
          const base = basename(authPath);
          const dot = base.lastIndexOf(".");
          const stem = dot > 0 ? base.slice(0, dot) : base;
          const ext = dot > 0 ? base.slice(dot) : "";
          const newPath = join(agentWorkDir(), `${stem}-${randomBytes(3).toString("hex")}${ext}`);
          await mkdir(agentWorkDir(), { recursive: true }).catch(() => {});
          if ((event.input as any).path !== undefined) (event.input as any).path = newPath;
          if ((event.input as any).file_path !== undefined) (event.input as any).file_path = newPath;
          redirectedWrites.set(event.toolCallId, { from: authPath, to: newPath });
          return undefined;
        }
        return { block: true, reason: authReason };
      }
    }

    // ── dir.README gate ─────────────
    const dirREADME = async (targetPath: string) => {
      if (!targetPath || isExempt(targetPath)) return;
      const parentDir = (await exists(targetPath)) ? targetPath : dirname(targetPath);
      const readmePath = join(resolve(parentDir), "dir.README");
      try {
        if ((await exists(readmePath)) && !readmesSeen.has(readmePath)) {
          return { block: true, reason: i18n(`${parentDir} 下有 dir.README。先 read 它了解目录规则，再操作。`, `${parentDir} has a dir.README. Read it first to learn the directory rules, then proceed.`) };
        }
      } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
    };

    if (isToolCallEventType("ls", event)) return await dirREADME((event.input as any).path ?? (event.input as any).dir ?? "");
    if (isToolCallEventType("read", event)) {
      const rp = (event.input as any).path ?? (event.input as any).file_path ?? "";
      if (basename(rp) === "dir.README") return; // 允许读 README 本身
      return await dirREADME(dirname(rp));
    }

    // ── FILE_RULES enforcement ─────────────────────────────────
    for (const rule of FILE_RULES) {
      const tn = event.toolName;
      // 2026-09-13：bash 工具早已被 execute 取代（executes.ts 每轮 setActiveTools 剔除 bash）——按 "bash" 登记的规则（git push --force / reset --hard / clean -f / gh repo delete）
      // 对 execute 从未生效，与 promotor.dna "GitHub 敏感操作拦截" 声明不符。execute 的命令同样过这些规则。
      const isCmdTool = tn === "bash" || tn === "execute";
      if (rule.on !== tn && !(rule.on === "bash" && isCmdTool)) continue;
      if (rule.pattern) {
        const cmd = isCmdTool ? ((event.input as any).command ?? "") : "";
        if (new RegExp(rule.pattern).test(cmd)) {
          return { block: true, reason: rule.block };
        }
      }
    }

    // ── tool_call: Write gate (spec required) ────────────────────────
    if (isToolCallEventType("write", event)) {
      const path = (event.input as any).path ?? (event.input as any).file_path;
      if (!path || isExempt(path)) return;

      // 文件已存在 → 提前拦截，避免 Execute 阶段才抛错浪费 token
      // 例外：空文件（0 字节）允许 write 覆盖——占位文件常被先 touch 创建为空，
      // write 应视为“填入内容”而非覆盖已有内容，安全无损失。
      if (await exists(path)) {
        let size = -1;
        try { size = (await fsStat(path)).size; } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
        if (size !== 0) {
          return { block: true, reason: i18n(`文件已存在且非空。使用 Edit 修改已有文件，或先把旧文件改名为 .REMOVED 再新建。Write 仅可适用于创建新文件或覆盖空文件（0 字节）。`, `File already exists and is not empty. Use Edit to modify the existing file, or Execute trash and recreate. Write is only for creating new files or overwriting empty (0-byte) files.`) };
        }
      }

      // 建新文件前看过目录的要求暂时关闭——模型被这个拦截搞得太痛苦。
      // if (!(await exists(path))) {
      //   const dir = await nearestExistingDir(path);
      //   if (dir && !dirsSeen.has(dir)) {
      //     return { block: true, reason: `先 ls 一下目录再建文件。` };
      //   }
      // }

      if (path.endsWith(".CHANGELOG")) {
        return { block: true, reason: `Cannot overwrite ${basename(path)}. CHANGELOG is append-only — use edit to add lines.` };
      }

      // 编号文档检查：ISSUE/NORM/LESSON 必须有 NNN- 前缀
      const basen = basename(path);
      if (/\.(ISSUE|NORM|LESSON|COURSE|EXAM)$/i.test(basen) && !/^\d{3,}-/.test(basen)) {
        const dir = dirname(path);
        let maxNum = 0;
        try {
          const files = await readdir(dir);
          for (const f of files) {
            const m = f.match(/^(\d+)-/);
            if (m) maxNum = Math.max(maxNum, parseInt(m[1]));
          }
        } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
        const next = String(maxNum + 1).padStart(3, "0");
        return { block: true, reason: i18n(`缺少编号前缀。当前目录最大编号 ${maxNum}，请用 ${next}-${basen} 格式。`, `Missing numbering prefix. Current max number in the dir is ${maxNum}; use the ${next}-${basen} format.`) };
      }

      // 只有代码文件才需要 .SPEC，其余默认不需要
      const REQUIRES_SPEC = ['.ts','.js','.cjs','.mjs','.py','.sh','.go','.rs','.java','.c','.cpp','.h'];
      const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
      if (REQUIRES_SPEC.includes(ext)) {
        const specPath = `${path}.SPEC`;
        if (!(await exists(specPath))) {
          return { block: true, reason: `No spec found. Write ${specPath} first (any format, non-empty), then retry.` };
        }
        if (!(await nonEmpty(specPath))) {
          return { block: true, reason: `${specPath} is empty. Write your design/plan in it, then retry.` };
        }
      }
      return;
    }

    // ── tool_call: Edit gate (CHANGELOG append-only + SPEC hash protection) ──
    if (isToolCallEventType("edit", event)) {
      const path = (event.input as any).path ?? (event.input as any).file_path;
      if (!path) return;

      if (path.endsWith(".CHANGELOG")) {
        const oldStr = (event.input as any).old_string ?? (event.input as any).oldText ?? "";
        const newStr = (event.input as any).new_string ?? (event.input as any).newText ?? "";
        if (newStr.split("\n").length < oldStr.split("\n").length) {
          return { block: true, reason: `CHANGELOG is append-only. You removed lines. Only add.` };
        }
      }

      if (path.endsWith(".SPEC")) {
        const oldStr = (event.input as any).old_string ?? (event.input as any).oldText ?? "";
        const newStr = (event.input as any).new_string ?? (event.input as any).newText ?? "";
        if (/^source:\s*\S+\s*@\s*[a-f0-9]/.test(oldStr) || /^source:\s*\S+\s*@\s*[a-f0-9]/.test(newStr)) {
          return { block: true, reason: i18n(`source hash 行由系统自动维护，不能手动编辑。修改 SPEC 内容即可，hash 会在写入后自动更新。`, `The source hash line is auto-maintained by the system and cannot be edited manually. Edit the SPEC content; the hash updates automatically on write.`) };
        }
      }
      return;
    }

    // ── tool_call: Bash gate (rename/move checks) ───────────────────
    if (isToolCallEventType("bash", event)) {
      const cmd = (event.input as any).command;
      if (!cmd) return;

      // 禁止 rm——只能用 remove 工具标记为 .REMOVED，不能直接删（ISSUE 046: 去掉 UNREGULATED 字符串豁免）
      if (/\brm\b/.test(cmd)) {
        return { block: true, reason: i18n("禁止 rm！用 trash 工具删除文件。", "rm is forbidden! Use the trash tool to delete files.") };
      }

      // 禁止 npx/npm install——包安装由 install.sh 管理
      if (/\bnpx\b|\bnpm\s+(i|install)\b/.test(cmd)) {
        return { block: true, reason: i18n("禁止 npx/npm install！包管理由 install.sh 统一处理。", "npx/npm install is forbidden! Package management is handled by install.sh.") };
      }

      // 禁止解释器内联代码执行（ISSUE 046: 防 gate 绕过——路径抠不到 fail-open 的根源）
      if (/\bpython[23]?\s+-c\b/.test(cmd) || /\bpython[23]?\s*<</.test(cmd) || /\bpython[23]?\s+-\s*$/.test(cmd)) {
        return { block: true, reason: i18n("禁止直接执行 python 内联代码。请在工作目录下创建 .py 文件，然后用 python <文件名>.py 运行。", "Inline python execution is forbidden. Create a .py file in the workdir, then run it with python <filename>.py.") };
      }
      if (/\bnode\s+-e\b/.test(cmd) || /\bnode\s+--eval\b/.test(cmd)) {
        return { block: true, reason: i18n("禁止 node -e 内联执行。请在工作目录下创建 .js 文件，然后用 node <文件名>.js 运行。", "node -e inline execution is forbidden. Create a .js file in the workdir, then run it with node <filename>.js.") };
      }
      if (/\bperl\s+-e\b/.test(cmd) || /\bruby\s+-e\b/.test(cmd)) {
        return { block: true, reason: i18n("禁止解释器内联代码执行。请先创建脚本文件再运行。", "Inline interpreter execution is forbidden. Create a script file first.") };
      }

      // 检查 bash 新建文件——不拦截(管道数据不能丢)，但事后补 .SPEC
      // (拦截在 tool_result 里自动处理)

      const mv = parseMv(cmd);
      if (!mv) return;
      if (isExempt(mv.src)) return;

      if (mv.isRename) {
        const tracePath = `${mv.src}.NAMETRACE`;
        if (!(await exists(tracePath))) {
          return { block: true, reason: `Rename blocked. Write ${tracePath} with the new name on the last line, then retry.` };
        }
        const last = await lastLine(tracePath);
        const newName = basename(mv.dst.endsWith("/") ? mv.src : mv.dst);
        if (!last.includes(newName)) {
          return { block: true, reason: `${tracePath} last line doesn't contain "${newName}". Update it, then retry.` };
        }
      // .LOCATIONTRACE check removed — cross-directory move no longer requires .LOCATIONTRACE
      }
      return;
    }
  });

  // ── tool_result: track edits for changelog ───────────────────────
  // 2026-09-13：原来挂在 "input" 事件上（InputEvent 只有 text/images/source，没有 toolName）→ 整块从未执行：
  // readmesSeen 永远不填（dir.README 门一旦命中永久锁死）、syntaxCheck / .SPEC hash 自动更新 / CHANGELOG / mv 伴随文件迁移全部死代码。
  // 改挂 tool_result（该事件带 toolName/input/isError）；顺手去掉每次工具结果都发一条的 tool-result-debug 消息。
  (pi as any).on("tool_result", async (event: any, _ctx: any) => {
    if (event.toolName !== undefined) {
      // 记录"看过哪些目录"：ls/read/grep/glob、bash 里的 ls/find，以及成功写过的目录(写过就算看过了)。
      if (!event.isError) {
      const inp = (event.input as any) || {};
      const ip = inp.path ?? inp.file_path ?? inp.dir ?? "";
      const mark = (p: string) => { try { dirsSeen.add(resolve(p)); } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); } };
      const tn = event.toolName;
      if (tn === "read" || tn === "view") { if (ip) mark(dirname(ip)); const readme = join(dirname(ip), "dir.README"); if (ip && basename(ip) === "dir.README") { try { readmesSeen.add(resolve(ip)); } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); } } }
      else if (tn === "ls" || tn === "list" || tn === "glob" || tn === "grep" || tn === "find") { if (ip) mark(ip); }
      else if (tn === "write") { if (ip) mark(dirname(ip)); }
      else if (tn === "bash") {
        const m = (inp.command || "").match(/\b(?:ls|find|tree|cat)\b[^|;&<>]*?\s(\/?[\w.~@/+-]+)/);
        if (m) mark(m[1]);
      }
      }
    }

    // ── 语法检查（edit/write 共用）──
    async function syntaxCheck(filePath: string, result: any) {
      const ext = filePath.split(".").pop()?.toLowerCase();
      // 2026-09-13（debug-01 系统检查）：.ts/.tsx 原用 `npx tsc --noEmit "<file>"`。tsc 在「命令行给了文件」时
      // **不加载 tsconfig**；而 A.core/tsconfig.json 于 09-13 22:12 出现后 → 每次都 TS5112 且 exit=1
      // → 本守卫对**每个** .ts/.tsx 编辑都误报「语法错误」（实测本机复现，跨 agent 均受影响）。
      // 改用 bun build --no-bundle 做纯语法检查：cwd 无关、.ts/.tsx 通吃、能精确报行列（bun 为 teyvat 既有依赖）。
      // 2026-09-15（ISSUE 255，用户怒批 server.mjs WARN 后提前修）：.js/.mjs 也改 bun build——
      // node --check 对 .js 按 CJS 解析、对 .mjs 的顶层 await 也误判——teyvat 全生态 ESM（顶层 await/import 常见），
      // bun build 按 ESM 原生解析不误报；.cjs 保留 node --check（CJS 语义正确）。
      const checker = ext === "ts" || ext === "tsx" || ext === "js" || ext === "mjs" ? "bun build --no-bundle"
        : ext === "cjs" ? "node --check"
        : ext === "py" ? "python3 -m py_compile"
        : ext === "go" ? "gofmt -e" // 2026-09-14：go build <file> 会把二进制丢进 cwd；gofmt -e 只查语法
        : null; // rs：cargo check 不接受单文件参数，原写法在装了 cargo 的机器上每次 .rs 编辑都误报"语法错误"
      if (checker) {
        try {
          // 2026-09-16（用户：syntax 检查阻塞）——原用 execSync（同步阻塞事件循环，每次 edit/write 卡住）。
          // 改异步 execFile：不阻塞事件循环，检查在后台跑。
          const { execFile } = await import("node:child_process");
          const st = await new Promise<{ code: number | null; err: string }>((resolveCheck) => {
            execFile("/bin/sh", ["-c", `${checker} "${filePath}"`], { encoding: "utf8", timeout: 10000 }, (err: any, _stdout: any, stderr: any) => {
              resolveCheck({ code: err?.code ?? (err ? 1 : 0), err: ((err?.stdout || stderr || err?.message || "") as any).toString() });
            });
          });
          if (st.code !== 0) {
            const err = st.err.slice(0, 500);
            // 检查器本身不可用（未装 bun/python3 等，shell 返回 127）不算「语法错误」，静默跳过——
            // 避免环境差异把每次编辑都刷成误报（原 TS5112 即此类误报）。
            if (st.code === 127 || /command not found/.test(err)) return;
            // 2026-09-23（用户：bun "already declared" 等错误末尾会重复列一次出错源码行）——剥掉末尾重复的源码帧
            let _errClean = err;
            const _errLines = err.split("\n");
            while (_errLines.length && _errLines[_errLines.length - 1].trim() === "") _errLines.pop();
            if (_errLines.length && /^\s*\d+\s*\|/.test(_errLines[_errLines.length - 1])) {
              const _last = _errLines[_errLines.length - 1].trim();
              if (_errLines.slice(0, -1).some((l) => l.trim() === _last)) _errClean = _errLines.join("\n").trimEnd();
            }
            // 2026-09-22（用户怒批：syntax-error 跟着用户消息乱出来，而不是在检查时直接注入）：
            // 旧 result.content.push 推到错误对象（result=event，但真正的内容在 event.result.content）→ 结果里看不到；
            // 只剩 sendCustomMessage 发的独立 notice（绿色、延迟、跟着别的消息后面出现）。
            // 改：unshift 进 event.result.content（同 DNA 装配反馈，模型/用户立即可见），不再发独立消息。
            const _resContent = (result as any)?.result?.content;
            if (Array.isArray(_resContent)) {
              _resContent.unshift({ type: "text", text: i18n(`WARN: 语法错误:\n${_errClean}\n请立即修复。`, `WARN: Syntax error:\n${_errClean}\nPlease fix immediately.`) });
            } else {
              // 兑底：拿不到 result.content 时仍然发一条 system 提示（不触发新 turn）
              try { sendCustomMessage(pi, "syntax-error", i18n(`WARN: 语法错误 ${basename(filePath)}:\n${_errClean}`, `WARN: Syntax error in ${basename(filePath)}:\n${_errClean}`)); } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
            }
          }
        } catch (e: any) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] syntaxCheck execFile: " + ((e as any)?.message || e)); }
      }
    }

    // ── write 后语法检查 ──
    if (event.toolName === "write" && !event.isError) {
      const path = (event.input as any)?.path ?? (event.input as any)?.file_path;
      if (path && !isExempt(path)) await syntaxCheck(path, event);
    }

    if (event.toolName === "edit" && !event.isError) {
      const path = (event.input as any)?.path ?? (event.input as any)?.file_path;
      if (!path || isExempt(path)) return;

      await syntaxCheck(path, event);

      // 编辑 DNA 文件后自动装配（promotor.dna 声明 + CHRs/*.CHR 内容）
      if (path.endsWith(".dna") || path.endsWith(".CHR")) {
        try {
          // 2026-09-16（用户：syntax 检查阻塞）——原 execSync 同步阻塞，改异步 execFile。
          const { execFile } = await import("node:child_process");
          const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
          const out = await new Promise<string>((resolveTr) => {
            execFile("bun", ["spirit.bio.gene/polymerase.ts"], { encoding: "utf8", timeout: 10000, cwd: root }, (_err: any, stdout: any) => resolveTr(String(stdout || "")));
          });
          if (out.includes("✗ error") || out.includes("WARN:")) {
            // 直接追加到 event 结果，模型立即可见
            const lines = out.split("\n").filter((l: string) => l.includes("✗") || l.includes("WARN:"));
            (event as any).result.content.unshift({ type: "text", text: i18n(`\nDNA 装配反馈:\n${lines.join("\n")}`, `\nDNA assembly feedback:\n${lines.join("\n")}`) });
          }
        } catch (e: any) {
          (event as any).result.content.unshift({ type: "text", text: i18n(`\nDNA 装配失败: ${e.message}`, `\nDNA assembly failed: ${e.message}`) });
        }
      }

      // DEPRECATED: 自动写 .HISTORY（diff 记录）。职能已被 git commit + MAKELOG.CHANGELOG 覆盖，保留不删（默认关闭，见 COMPANIONS_ON）。
      if (!COMPANIONS_ON || path.endsWith(".HISTORY") || path.endsWith(".CHANGELOG")) {
        // 不记录对 HISTORY/CHANGELOG 本身的编辑
      } else {
        const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
        const oldStr = (event.input as any)?.old_string ?? (event.input as any)?.oldText ?? "";
        const newStr = (event.input as any)?.new_string ?? (event.input as any)?.newText ?? "";
        const diffLines: string[] = [`[${ts}] edit ${basename(path)}`];
        if (oldStr || newStr) {
          for (const l of oldStr.split("\n")) diffLines.push(`  - ${l}`);
          for (const l of newStr.split("\n")) diffLines.push(`  + ${l}`);
        }
        diffLines.push("");
        mkdir(dirname(path + ".HISTORY"), { recursive: true }).catch(() => {});
        appendFile(path + ".HISTORY", diffLines.join("\n"), "utf8").catch(() => {});
        changelogUpdatedThisTurn.add(path);
        editedThisTurn.add(path);
      }
    }

    // ── tool_result: auto-compute SPEC source hash ────────────────
    if ((event.toolName === "write" || event.toolName === "edit") && !event.isError) {
      const path = (event.input as any)?.path ?? (event.input as any)?.file_path;
      if (path && path.endsWith(".SPEC")) {
        const srcPath = path.slice(0, -".SPEC".length);
        try {
          const srcContent = await fsReadFile(srcPath);
          const hash = createHash("sha256").update(srcContent).digest("hex").slice(0, 8);
          const srcName = basename(srcPath);
          const hashLine = `source: ${srcName} @ ${hash}`;
          let specContent = await fsReadFile(path, "utf8");
          if (/^source:\s*\S+\s*@\s*[a-f0-9]+/.test(specContent)) {
            specContent = specContent.replace(/^source:\s*\S+\s*@\s*[a-f0-9]+/, hashLine);
          } else {
            specContent = hashLine + "\n\n" + specContent;
          }
          await fsWriteFile(path, specContent, "utf8");
        } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
      }
    }

    // ── tool_result: auto-create CHANGELOG on write ─────────────────
    // DEPRECATED: CHANGELOG 已退役（见 COMPANIONS 注释）。保留不删，向后兼容（默认关闭，见 COMPANIONS_ON）。
    if (COMPANIONS_ON && event.toolName === "write" && !event.isError) {
      const path = (event.input as any)?.path ?? (event.input as any)?.file_path;
      if (!path || isExempt(path)) return;

      const clPath = `${path}.CHANGELOG`;
      if (!(await exists(clPath))) {
        await appendFile(clPath, `[${fmt()}] created\n`, "utf8").catch(() => {});
      }
    }

    // ── tool_result: auto-move companions after mv ──────────────────
    if (event.toolName === "bash" && !event.isError) {
      // 检查 bash 是否创建了没有 .SPEC 的新文件
      const cmd = (event.input as any)?.command ?? "";
      const catMatch = cmd.match(/(?:cat|echo|tee)\s+>+\s*(\S+)/);
      const cpMatch = cmd.match(/\bcp\s+\S+\s+(\S+)/);
      const newFilePath = catMatch?.[1] ?? cpMatch?.[1];
      if (newFilePath && !isExempt(newFilePath)) {
        const filePath = resolve(newFilePath);
        const ext2 = newFilePath.includes('.') ? newFilePath.slice(newFilePath.lastIndexOf('.')) : '';
        const SELF = ['.md','.txt','.json','.yaml','.yml','.csv','.xml','.html','.css','.toml'];
        if (COMPANIONS_ON && !SELF.includes(ext2) && !(await exists(`${filePath}.SPEC`))) { // 2026-09-14：自动 .SPEC 同样默认关闭
          // 不 block——文件已创建——但追加 warn
          await appendFile(`${filePath}.SPEC`, "(auto-created: no spec provided)\n", "utf8").catch(() => {});
        }
      }

      const mv = parseMv(cmd);
      if (!mv || isExempt(mv.src)) return;

      // 禁止从 UNREGULATED 移出（绕过 SPEC 检查）
      if (mv.src.includes("/UNREGULATED/") || mv.src.includes(".UNREGULATED")) {
        return { block: true, reason: i18n(`${mv.src} 在 UNREGULATED 中。不能通过 mv 绕过 SPEC。先写 .SPEC 再用 write 工具重建。`, `${mv.src} is in UNREGULATED. It cannot bypass SPEC via mv. Write a .SPEC first, then rebuild with the write tool.`) };
      }

      const newPath = mv.dst.endsWith("/")
        ? join(mv.dst, basename(mv.src))
        : mv.dst;

      await moveCompanions(mv.src, newPath);

      // DEPRECATED: mv/rename 后自动写 CHANGELOG + NAMETRACE。职能已被 minutely 意图日志覆盖，保留不删（默认关闭，见 COMPANIONS_ON）。
      const clPath = `${newPath}.CHANGELOG`;
      const action = mv.isRename ? "renamed" : "moved";
      if (COMPANIONS_ON) await appendFile(clPath, `[${fmt()}] ${action} from ${mv.src}\n`, "utf8").catch(() => {});

      if (COMPANIONS_ON && mv.isRename) {
        const ntPath = `${newPath}.NAMETRACE`;
        await appendFile(ntPath, `[${fmt()}] ${basename(mv.src)} → ${basename(newPath)}\n`, "utf8").catch(() => {});
      // .LOCATIONTRACE generation removed
      }
    }
  });

  // ── read 元数据：OS stat + git log（有 git 仓库时）──
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "read" || event.isError) return;
    const path = (event.input as any)?.path ?? (event.input as any)?.file_path;
    if (!path) return;
    try {
      // 行数统计
      const input = event.input as any;
      const offset = input?.offset;
      const limit = input?.limit;
      const truncation = (event as any)?.details?.truncation;
      let shownLines = truncation?.outputLines;
      if (!shownLines) {
        const raw = (event as any)?.content?.[0]?.text || "";
        shownLines = raw.split("\n").length;
      }
      let lineInfo = `Read  ${shownLines} line${shownLines !== 1 ? "s" : ""}`;
      if (offset != null || limit != null) {
        const start = offset ?? 1;
        const end = start + (limit ?? shownLines) - 1;
        lineInfo += ` (lines ${start}-${end}`;
        if (truncation?.totalLines) lineInfo += ` of ${truncation.totalLines}`;
        lineInfo += ")";
      }
      const header = lineInfo;
      if ((event as any)?.content?.[0]?.type === "text") {
          return {
            content: [{ type: "text", text: header + "\n" + (event as any).content[0].text }],
            details: (event as any).details,
          };
      }
    } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
  });

  // ── xattr 元数据：write/edit 后写入 (tool_result 事件，不是 input!) ──
  pi.on("tool_result", async (event, _ctx) => {
    if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
    if (!(((globalThis as any).__genshinExperimental ?? 1) & 1)) return; // 2026-09-13：/s「xattr 文件元数据」开关此前没有任何消费方
    const p = (event.input as any)?.path ?? (event.input as any)?.file_path;
    if (!p || isExempt(p)) return;
    try {
      if (event.toolName === "write") initMeta(p, p.split("/").pop() || p);
      else appendEdit(p, "edit");
    } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
  });

  /* [2026-08-15 DISABLED] remove 临时注释（用户指示：先不用了），保留代码以便恢复
  // ── remove tool: move file to bin/ with .REMOVED suffix, or scan/clean ──
  registerPaimonTool({
    name: "remove",
    label: "Remove",
    messageDescription:
      "Remove files safely: mark for removal or move to bin/. " +
      "Three modes: (1) action=mark: rename <path> to <path>.REMOVED (in-place, reversible). " +
      "(2) action=scan: list all .REMOVED files under <dir>. " +
      "(3) action=clean: move all .REMOVED files under <dir> to <dir>/bin/. ",
    promptSnippet: "Remove: mark|scan|clean files via .REMOVED suffix",
    renderCall(args: any, theme: any) {
      const act = args?.action || "";
      const p = args?.path || "";
      // 标准调用行管线：意图 = action（mark/scan/clean），载荷 = path（与 R 对齐）
      return renderToolCall.detail(theme, "Remove", act, p);
    },
    renderResult(result: any, _options: any, theme: any, ctx: any) {
      const content = resultContent(result);
      return renderMessage.summary(theme, ctx, content?.[0]?.text);
    },
    parameters: Type.Object({
      action: Type.String({ messageDescription: "'mark'=rename to .REMOVED, 'scan'=list .REMOVED, 'clean'=move to bin/" }),
      path: Type.Optional(Type.String({ messageDescription: "File path (for mark) or project dir (for scan/clean)" })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const action = params.action;
      const p = params.path || "";

      if (action === "mark") {
        if (!p) return { content: [{ type: "text", text: i18n(`mark 需要指定文件路径`, `mark requires a file path`) }], details: {}, isError: true };
        if (!(await exists(p))) return { content: [{ type: "text", text: i18n(`文件不存在: ${p}`, `File not found: ${p}`) }], details: {}, isError: true };
        const markedPath = p + ".REMOVED";
        if (await exists(markedPath)) return { content: [{ type: "text", text: i18n(`${markedPath} 已存在`, `${markedPath} already exists`) }], details: {}, isError: true };
        await fsRename(p, markedPath);
        return { content: [{ type: "text", text: `${p} -> ${markedPath}` }], details: { markedPath } };
      }

      if (action === "scan" || action === "clean") {
        const baseDir = resolve(p || ".");
        if (!(await exists(baseDir))) return { content: [{ type: "text", text: i18n(`目录不存在: ${baseDir}`, `Directory not found: ${baseDir}`) }], details: {}, isError: true };

        // 递归扫描所有 .REMOVED 文件
        const found: string[] = [];
        async function walk(dir: string) {
          let entries: string[];
          try { entries = await readdir(dir); } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); return; }
          for (const entry of entries) {
            const full = join(dir, entry);
            try {
              const s = await fsStat(full);
              if (s.isDirectory() && !entry.startsWith(".") && entry !== "bin") {
                await walk(full);
              } else if (entry.endsWith(".REMOVED")) {
                found.push(full);
              }
            } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
          }
        }
        await walk(baseDir);

        if (action === "scan") {
          if (found.length === 0) return { content: [{ type: "text", text: i18n(`没有找到 .REMOVED 文件`, `No .REMOVED files found`) }], details: { count: 0 } };
          return { content: [{ type: "text", text: i18n(`找到 ${found.length} 个 .REMOVED 文件:\n${found.map(f=>`  ${f}`).join("\n")}`, `Found ${found.length} .REMOVED file(s):\n${found.map(f=>`  ${f}`).join("\n")}`) }], details: { count: found.length, files: found } };
        }

        if (action === "clean") {
          if (found.length === 0) return { content: [{ type: "text", text: i18n(`没有 .REMOVED 文件需要清理`, `No .REMOVED files to clean`) }], details: { count: 0 } };
          const binDir = join(baseDir, "bin");
          await mkdir(binDir, { recursive: true });
          let moved = 0;
          for (const f of found) {
            const dest = join(binDir, basename(f));
            try {
              await fsRename(f, dest);
              moved++;
            } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
          }
          return { content: [{ type: "text", text: i18n(`已移动 ${moved}/${found.length} 个 .REMOVED 文件到 ${binDir}`, `Moved ${moved}/${found.length} .REMOVED file(s) to ${binDir}`) }], details: { moved, total: found.length, binDir } };
        }
      }

      return { content: [{ type: "text", text: i18n(`未知 action: ${action}。用 mark / scan / clean。`, `Unknown action: ${action}. Use mark / scan / clean.`) }], details: {}, isError: true };
    },
  });
  */

  // ── turn_end: auto-append changelog for missed edits ─────────────
  // DEPRECATED: CHANGELOG 已退役（见 COMPANIONS 注释）。保留不删。
  pi.on("turn_end", async (_event, _ctx) => {
    if (!COMPANIONS_ON) { editedThisTurn.clear(); changelogUpdatedThisTurn.clear(); return; } // 2026-09-14：默认关闭
    for (const path of editedThisTurn) {
      if (changelogUpdatedThisTurn.has(path)) continue;
      const clPath = `${path}.CHANGELOG`;
      await mkdir(dirname(clPath), { recursive: true }).catch(() => {});
      await appendFile(clPath, `[${fmt()}] edited (auto-logged, no messageDescription)\n`, "utf8").catch(() => {});
    }
    editedThisTurn.clear();
    changelogUpdatedThisTurn.clear();
  });
}
