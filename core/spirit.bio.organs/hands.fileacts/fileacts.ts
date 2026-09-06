// 文档: B.docs/Dev.Common/Wiki/File-Conventions(Norm).WIKI
// 文档: B.docs/Dev.Common/Wiki/Hands(Organ).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { access, readFile, appendFile, rename as fsRename, mkdir, readdir, stat as fsStat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

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
    const raw = execSync(`xattr -p ${XATTR_KEY} "${filePath}"`, { encoding: "utf8", timeout: 2000, stdio: ["ignore","pipe","ignore"] });
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

function writeMetaRaw(filePath: string, json: string): boolean {
  try {
    execSync(`xattr -w ${XATTR_KEY} '${json.replace(/'/g, `'\\''`)}' "${filePath}"`, { timeout: 2000, stdio: "ignore" });
    return true;
  } catch {
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
export interface AgentTrust { all?: boolean; root?: boolean; trusted: TrustEntry[] }
let authDb: { agents: Record<string, AgentTrust> } = { agents: {} };

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
  } catch {
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

// prompt 来自 coded.dna（coded fileactions.wise + fileactions.rules），由 runtime 取，不再硬编码。
const PROMPT = getPrompt("fileactions.wise");
const RULES_PROMPT = (() => { try { return getPrompt("fileactions.rules"); } catch { return ""; } })();

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
  const p = path.replace(/\\/g, "/");
  return p.includes("/.ssh/") || p.includes("/.ssh") ||
    p.includes("/.teyvat/agent/auth.json") ||
    p.includes("/.teyvat/trust.json") ||
    p.includes("/.teyvat/agent/models.json") ||
    p.includes("/fileacts.ts") ||
    p.includes("/pi-coding-agent/dist/") ||
    p.includes("/.teyvat/") ||
    p.includes("/R.release/") ||
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
  try { await access(path); return true; } catch { return false; }
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
  try { const c = await readFile(path, "utf8"); return c.trim().length > 0; } catch { return false; }
}

async function lastLine(path: string): Promise<string> {
  try {
    const c = await readFile(path, "utf8");
    const lines = c.trim().split("\n");
    return lines[lines.length - 1]?.trim() ?? "";
  } catch { return ""; }
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

// ── Execute 命令校验（由 kernel.heart/process.ts 调用）──
export function validateExecute(cmd: string, selfId?: string): { blocked: boolean; message?: string } {
  // make 命令豁免（2026-09-07 用户：make 部署时不要误判拦截）——提前到内容词检查之前：
  // make 的 msg/detail 参数是部署描述数据（可能含 rm/kill/路径等词），不是要执行的命令，不应触发内容词拦截。
  // cd 路径可能带空格（引号包裹，如 cd "/Users/.../Agent Intelligence/...")——正则需支持引号路径。
  if (/^\s*(?:cd\s+("[^"]*"|\S+)\s*&&\s*)?make\s/i.test(cmd)) return { blocked: false };
  if (/\brm\b/i.test(cmd)) return { blocked: true, message: i18n("请使用 Execute 工具执行 trash 命令来将文件移入回收站。", "Use the Execute tool with the trash command to move files to the recycle bin.") };
  if (/\bsed\b/i.test(cmd)) return { blocked: true, message: i18n("请勿使用 sed 命令。你可使用 Read 命令读取文件。", "Do not use the sed command. Use the Read command to read files.") };
  if (/^\s*python[23]?\s+-c\b/.test(cmd) || /^\s*bash\s+-c\b/.test(cmd)) return { blocked: true, message: i18n("禁止直接执行 python/bash 内联代码。请在工作目录下创建脚本文件再运行。", "Inline python/bash code is forbidden. Create a script file in the workdir and run it.") };
  if (/\bpython[23]?\s*<</.test(cmd) || /\bpython[23]?\s+-\s*$/.test(cmd)) return { blocked: true, message: i18n("禁止直接执行 python 内联代码。请在工作目录下创建 .py 文件，然后用 python <文件名>.py 运行。", "Inline python code is forbidden. Create a .py file in the workdir, then run it with python <filename>.py.") };
  if (/(kill|pkill|killall)\s.*genshin/i.test(cmd)) return { blocked: true, message: i18n("禁止杀掉 genshin 进程。用 genshin -k <序号> 或 /stop 正常终止。", "Killing the genshin process is forbidden. Use genshin -k <index> or /stop to terminate normally.") };
  // 禁止访问其他人数据目录；自己 ID 的 MemoryData/AgentFileData/ExecuteData 等放行
  if (/(?:~\/\.local\/lib\/genshin\/|~\/\.teyvat\/|\$HOME\/\.teyvat\/)(?:extensions|extensions-stable|MemoryData|SessionData|RuntimeCache|BlackboxData|IdentityData|AgentFileData|AppData|ExecuteData|LogData|config|UserAccount)/i.test(cmd)) {
    if (selfId && new RegExp(String.raw`(?:MemoryData|AgentFileData|SessionData|RuntimeCache|BlackboxData|IdentityData|AppData|ExecuteData|LogData)/${selfId}`).test(cmd)) {
      return { blocked: false };
    }
    // 放行 AppData/shared（跨 agent 共享数据）
    if (/AppData\/shared\//i.test(cmd)) {
      return { blocked: false };
    }
    // 如果 authorize.json 中当前 agent 有 root: true，全部放行
    try {
      const auth = JSON.parse(readFileSync(join(homedir(), ".teyvat/config/authorize.json"), "utf8"));
      if (selfId && auth.agents?.[selfId]?.root) {
        return { blocked: false };
      }
    } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
    return { blocked: true, message: i18n("禁止 Execute 操作他人数据目录。要读源码请用 Read 指定 DEV 路径。", "Execute on other agents' data dirs is forbidden. To read source, use Read with the DEV path.") };
  }
  if (/^\s*mv\s/i.test(cmd)) {
    const parsed = parseMv(cmd);
    if (!parsed) return { blocked: true, message: i18n("mv 格式不对。用法: mv <旧名> <新名>", "mv format invalid. Usage: mv <old-name> <new-name>") };
    if (!parsed.isRename) return { blocked: true, message: i18n("跨目录 mv 被拦截。用 edit 改文件内容，write 创建新文件。", "Cross-directory mv is blocked. Use edit to change file content, write to create new files.") };
    return { blocked: false };
  }
  return { blocked: false };
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("syntax-error", (message: any, _opts: any, theme: any) => {
    return renderMessage.notice(theme, "Syntax", (message.content ?? "").toString());
  });
  loadTrust();

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

    // ── /tmp 禁止（2026-08-20 用户定稿）：write 默认禁 /tmp（临时文件应写 AgentWorkDir），force:true 才放行；
    //    bash 写 /tmp 一律禁（bash 无 force 参数，危险操作不留口子）。macOS /tmp → /private/tmp 一并拦。──
    if (authPath && (authPath.startsWith("/tmp/") || authPath === "/tmp" || authPath.startsWith("/private/tmp/"))) {
      if (event.toolName === "write" && (event.input as any)?.force === true) {
        // 用户显式 force 强制（写在临时目录的临时文件，模型自行负责清理）
      } else {
        return { block: true, reason: i18n(`写 /tmp 目录被禁止（临时文件请写你的 AgentWorkDir）。确需写 /tmp 时，write 加 force:true 强制。`, `Writing to /tmp is blocked (temporary files should go to your AgentWorkDir). If you really need to write /tmp, add force:true to write.`) };
      }
    }

    // ── 系统保护: SSH密钥/凭证/钱包/自身代码/pi dist ──
    if (authPath && isSystemProtected(authPath)) {
      const isRead = ["read","view","ls","list","glob","grep","find"].includes(event.toolName);
      if (authPath.includes("/.ssh/") || authPath.includes("auth.json") || authPath.includes("models.json")) {
        return { block: true, reason: i18n(`系统保护 — ${authPath.split("/").pop()} 是凭证文件，agent 不可访问。`, `System protected — ${authPath.split("/").pop()} is a credential file, not accessible to agents.`) };
      }
      if (authPath.includes("/pi-coding-agent/dist/") || authPath.includes("/.teyvat/agent/") || authPath.includes("/.local/lib/teyvat/")) {
        if (!isRead) {
          return { block: true, reason: i18n(`请不要直接修改 ~/.local/lib/teyvat/ 下的文件。请修改开发源码 ~/Documents/Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core/ 下的对应文件，然后 cd C.deploy && make dev-minutely 部署。`, `Do not modify files under ~/.local/lib/teyvat/ directly. Edit the dev tree at ~/Documents/Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core/ and run: cd C.deploy && make dev-minutely.`) };
        }
        if (IS_DEV) {
          return { block: true, reason: i18n(`请不要读 ~/.teyvat/agent/。请阅读 ~/Documents/Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core/ 开发目录中的源文件。`, `Do not read ~/.teyvat/agent/. Read the source files in ~/Documents/Agent Intelligence/MODERN/TEYVAT/teyvat-main/A.core/.`) };
        }
      }
      if (authPath.includes("/R.release/") && !isRead) {
        return { block: true, reason: i18n(`RELEASE 保护 — 不要改已经发布的版本。`, `RELEASE protected — do not modify released versions.`) };
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
      if (rule.on !== tn) continue;
      if (rule.pattern) {
        const cmd = tn === "bash" ? ((event.input as any).command ?? "") : "";
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
          return { block: true, reason: i18n(`文件已存在且非空。使用 Edit 修改已有文件，或使用 Execute trash 后重新创建。Write 仅可适用于创建新文件或覆盖空文件（0 字节）。`, `File already exists and is not empty. Use Edit to modify the existing file, or Execute trash and recreate. Write is only for creating new files or overwriting empty (0-byte) files.`) };
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

      // 禁止 rm——只能用 remove 工具标记为 .REMOVED，不能直接删
      if (/\brm\b/.test(cmd) && !cmd.includes("UNREGULATED")) {
        return { block: true, reason: i18n("禁止 rm！用 trash 工具删除文件。", "rm is forbidden! Use the trash tool to delete files.") };
      }

      // 禁止 npx/npm install——包安装由 install.sh 管理
      if (/\bnpx\b|\bnpm\s+(i|install)\b/.test(cmd)) {
        return { block: true, reason: i18n("禁止 npx/npm install！包管理由 install.sh 统一处理。", "npx/npm install is forbidden! Package management is handled by install.sh.") };
      }

      // 禁止 python -c / python3 -c 直接执行代码——必须先写 .py 文件再运行
      if (/\bpython[23]?\s+-c\b/.test(cmd) || /\bpython[23]?\s*<</.test(cmd) || /\bpython[23]?\s+-\s*$/.test(cmd)) {
        return { block: true, reason: i18n("禁止直接执行 python 内联代码。请在工作目录下创建 .py 文件，然后用 python <文件名>.py 运行。", "Inline python execution is forbidden. Create a .py file in the workdir, then run it with python <filename>.py.") };
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
  (pi as any).on("input", async (event: any, _ctx: any) => {
    if (event.toolName !== undefined) {
      try { sendCustomMessage(pi, "tool-result-debug", `tool_result: ${event.toolName}`); } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
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
      const checker = ext === "ts" || ext === "tsx" ? "npx tsc --noEmit"
        : ext === "js" || ext === "mjs" || ext === "cjs" ? "node --check"
        : ext === "py" ? "python3 -m py_compile"
        : ext === "go" ? "go build"
        : ext === "rs" ? "cargo check --quiet"
        : null;
      if (checker) {
        try {
          const { execSync } = await import("node:child_process");
          execSync(`${checker} "${filePath}"`, { encoding: "utf8", timeout: 10000 });
        } catch (e: any) {
          const err = (e.stderr || e.stdout || e.message || "").toString().slice(0, 500);
          result.content.push({ type: "text", text: i18n(`WARN: 语法错误:\n${err}\n请立即修复。`, `WARN: Syntax error:\n${err}\nPlease fix immediately.`) });
          try { sendCustomMessage(pi, "syntax-error", i18n(`WARN: 语法错误 ${basename(filePath)}:\n${err}`, `WARN: Syntax error in ${basename(filePath)}:\n${err}`)); } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
        }
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
          const { execSync } = await import("node:child_process");
          const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
          const out = execSync(`cd ${root} && bun spirit.bio.gene/polymerase.ts`, { encoding: "utf8", timeout: 10000 });
          if (out.includes("✗ error") || out.includes("WARN:")) {
            // 直接追加到 event 结果，模型立即可见
            const lines = out.split("\n").filter((l: string) => l.includes("✗") || l.includes("WARN:"));
            (event as any).result.content.unshift({ type: "text", text: i18n(`\nDNA 装配反馈:\n${lines.join("\n")}`, `\nDNA assembly feedback:\n${lines.join("\n")}`) });
          }
        } catch (e: any) {
          (event as any).result.content.unshift({ type: "text", text: i18n(`\nDNA 装配失败: ${e.message}`, `\nDNA assembly failed: ${e.message}`) });
        }
      }

      // DEPRECATED: 自动写 .HISTORY（diff 记录）。职能已被 git commit + MAKELOG.CHANGELOG 覆盖，保留不删。
      if (path.endsWith(".HISTORY") || path.endsWith(".CHANGELOG")) {
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
    // DEPRECATED: CHANGELOG 已退役（见 COMPANIONS 注释）。保留不删，向后兼容。
    if (event.toolName === "write" && !event.isError) {
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
        if (!SELF.includes(ext2) && !(await exists(`${filePath}.SPEC`))) {
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

      // DEPRECATED: mv/rename 后自动写 CHANGELOG + NAMETRACE。职能已被 minutely 意图日志覆盖，保留不删。
      const clPath = `${newPath}.CHANGELOG`;
      const action = mv.isRename ? "renamed" : "moved";
      await appendFile(clPath, `[${fmt()}] ${action} from ${mv.src}\n`, "utf8").catch(() => {});

      if (mv.isRename) {
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
      const { statSync } = await import("node:fs");
      const abs = resolve(path);
      const st = statSync(abs);
      const size = st.size < 1024 ? `${st.size}B` : st.size < 1024*1024 ? `${(st.size/1024).toFixed(1)}KB` : `${(st.size/1024/1024).toFixed(1)}MB`;
      const mtime = new Date(st.mtimeMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      let meta = `@ ${size}  ${mtime}`;
      // git 检测：从文件所在目录向上找 .git
      let gitMsg = "";
      try {
        const { execSync } = await import("node:child_process");
        const dir = dirname(abs);
        if (execSync(`cd "${dir}" && git rev-parse --git-dir 2>/dev/null`, { timeout: 3000 }).toString().trim()) {
          const log = execSync(`cd "${dir}" && git log -1 --format="%s" -- "${abs}" 2>/dev/null`, { timeout: 3000 }).toString().trim();
          if (log) gitMsg = `\n  ${log}`;
        }
      } catch (e) { console.error("[spirit.bio.organs/hands.fileacts/fileacts.ts] " + ((e as any)?.message || e)); }
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
          try { entries = await readdir(dir); } catch { return; }
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
