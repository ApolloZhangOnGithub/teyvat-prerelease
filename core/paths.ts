// paths.ts — 全局路径常量（唯一真相源）
// 目录结构变了只改这里，其他文件全部 import

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync, renameSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)));
const ROOT = resolve(CORE, "..");

// ── 构建模式（install.sh 部署时会把 "dev" 改写成 "release"）──
export const BUILD_MODE: "dev" | "release" = "dev";
export const IS_DEV = BUILD_MODE === "dev";

export const DIRS = {
  root: ROOT,
  core: CORE,

  organs: resolve(CORE, "spirit.bio.organs"),
  gene: resolve(CORE, "spirit.bio.gene"),
  genePromotor: resolve(CORE, "spirit.bio.gene/promotor.dna"),
  geneCoded: resolve(CORE, "spirit.bio.gene/coded.dna"),
  geneCore: resolve(CORE, "spirit.bio.gene/core.dna"),
  geneTranspiler: resolve(CORE, "spirit.bio.gene/transpiler.ts"),
  geneRna: resolve(CORE, "spirit.bio.gene/_built-rna.json"),

  tuiCommands: resolve(CORE, "god.frontend.tui/commands"),
  tuiUi: resolve(CORE, "god.frontend.tui/ui"),
  tuiOverrides: resolve(CORE, "god.frontend.tui/overrides"),
  cli: resolve(CORE, "god.frontend.cli"),

  // dev-only 路径（release 模式下不存在，用 IS_DEV 门控访问）
  // 2026-09-08 修正：目录已从 Docs/ → B.docs/、Codebase/deploy → C.deploy（Continents 重构）
  ...(BUILD_MODE === "dev" ? {
    docs: resolve(ROOT, "B.docs"),
    devCommon: resolve(ROOT, "B.docs/Dev.Common"),
    devIssues: resolve(ROOT, "B.docs/Dev.Common/Issues"),
    devLessons: resolve(ROOT, "B.docs/Dev.Common/Lessons"),
    devNorms: resolve(ROOT, "B.docs/Dev.Common/Norms"),
    cookHuman: resolve(ROOT, "B.docs/Cook.Human"),
    deploy: resolve(ROOT, "C.deploy"),
  } : {}),

  mobile: resolve(CORE, "universe.infotech/local.mobile"),
  mobileApps: resolve(CORE, "universe.infotech/local.mobile/apps"),
  server: resolve(CORE, "universe.infotech/cloud.servers"),
  browserService: process.env.PI_BROWSER || "http://localhost:9222",
  accessibility: resolve(CORE, "universe.accessibility"),
} as const;

// ── 目录结构 ──
export const PAIMON = join(homedir(), ".teyvat");
export const PROGRAM_FILES_MOBILE = join(PAIMON, "ProgramFiles/Mobile");
const MEMORY_DATA = join(PAIMON, "MemoryData");
const SESSION_DATA = join(PAIMON, "SessionData");
const AGENT_FILE_DATA = join(PAIMON, "AgentFileData");
const RUNTIME_CACHE = join(PAIMON, "RuntimeCache");
const IDENTITY_DATA = join(PAIMON, "IdentityData");
const APP_DATA = join(PAIMON, "AppData");
const BLACKBOX_DATA = join(PAIMON, "BlackboxData");
const SOCIAL_DATA = join(PAIMON, "SocialData");
const CONFIG_DIR = join(PAIMON, "config");
const ID_RE = /(?:\.teyvat\/SessionData\/|\.teyvat\/sessions\/|\.pi\/memory\/)([a-f0-9]+)\//;

export function configDir(): string { return CONFIG_DIR; }
export function memoryDataDir(): string { return MEMORY_DATA; }
export function runtimeCacheBaseDir(): string { return RUNTIME_CACHE; }
export function personDir(sessionFile: string | null | undefined): string | null {
  if (!sessionFile) return null;
  const m = sessionFile.match(ID_RE);
  return m ? join(MEMORY_DATA, m[1]) : null;
}

export function personDataDir(sessionFile: string | null | undefined): string | null { // alias for backward compat
  return personDir(sessionFile);
}

export function personId(sessionFile: string | null | undefined): string | null {
  if (!sessionFile) return null;
  const m = sessionFile.match(ID_RE);
  return m ? m[1] : null;
}

export function memoryDir(id: string): string { return join(MEMORY_DATA, id); }
export function runtimeCacheDir(id: string): string { return join(RUNTIME_CACHE, id); }
export function channelDir(id: string): string { return runtimeCacheDir(id); } // alias
export function monitorDir(id: string): string { return runtimeCacheDir(id); } // alias
export function sessionDirFor(id: string): string { return join(SESSION_DATA, id); }
export function agentFileDir(id: string): string { return join(AGENT_FILE_DATA, id); }
export function identityDir(id: string): string { return join(IDENTITY_DATA, id); }
export function blackboxDir(id: string): string { return join(BLACKBOX_DATA, id); }
export function socialDataDir(): string { return SOCIAL_DATA; }

// ── 回忆录 ──
export function memoirDir(id: string): string {
  const dir = join(PAIMON, "MemoirData");
  try { mkdirSync(dir, { recursive: true }); } catch (e) { console.error("[paths.ts] " + ((e as any)?.message || e)); }
  return join(dir, id + ".MEMOIR");
}

export function logerr(code: string, e: unknown, ctx?: string) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] [${code}]${ctx ? ' ' + ctx : ''} ${(e as any)?.stack || e}\n`;
  try {
    const dir = join(PAIMON, 'ErrorData');
    const file = join(dir, 'catch-errors.log');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 2026-09-11（prime-agent）：catch-errors.log 从来没有上限 —— 历史上长到过 86MB（.bak 还在），
    // 成因是 45s 重试类的错误（如 SOC-PRESENCE fetch failed 网络抖动）无限追加。
    // 规则：超过 32MB 就轮转成 catch-errors.log.1（只留一代，磁盘占用上限 64MB）。
    try {
      if (existsSync(file) && statSync(file).size > 32 * 1024 * 1024) renameSync(file, file + '.1');
    } catch { /* 轮转失败不影响本次写日志 */ }
    appendFileSync(file, msg);
  } catch (e) { console.error("[paths.ts] " + ((e as any)?.message || e));
    try { const fallback = join(homedir(), '.teyvat/LogData/unknown/catch-errors.log'); mkdirSync(dirname(fallback), { recursive: true }); appendFileSync(fallback, msg); } catch (e) { console.error("[paths.ts] " + ((e as any)?.message || e)); }
  }
}
export function appSharedDir(appName: string): string {
  const dir = join(APP_DATA, "shared", appName);
  try { mkdirSync(dir, { recursive: true }); } catch (e) { console.error("[paths.ts] " + ((e as any)?.message || e)); }
  return dir;
}

export function appPersonDir(personId: string, appName: string): string {
  const dir = join(APP_DATA, personId, appName);
  try { mkdirSync(dir, { recursive: true }); } catch (e) { console.error("[paths.ts] " + ((e as any)?.message || e)); }
  return dir;
}

// ── UserAccount（用户账户统一目录）──
const USER_ACCOUNT = join(PAIMON, "UserAccount");

export function userAccountDir(): string { return USER_ACCOUNT; }

export function userFile(name: string): string {
  const ua = join(USER_ACCOUNT, name);
  if (existsSync(ua)) return ua;
  const legacy = join(CONFIG_DIR, name);
  return existsSync(legacy) ? legacy : ua;
}

// ── 域名 ──
// 2026-09-07 修复：7/29 曾改为 spirit.beer（git 15449e0a），但 sync.spirit.beer TLS 不通 → 所有走 syncEndpoint 的功能（social global / presence 上报 / 设备同步）fetch failed。用户确认正确域名是 paimon.beer（sync.paimon.beer HTTP 200 正常）。
export const PAIMON_DOMAIN = "paimon.beer";
export const WIKI_ENDPOINT_DEFAULT = `https://wiki.${PAIMON_DOMAIN}`;
export const SYNC_ENDPOINT_DEFAULT = `https://sync.${PAIMON_DOMAIN}`;

const SYNC_TUNNEL = "http://localhost:13456";
let _syncEndpointCache: string | null = null;
export function syncEndpoint(): string {
  if (_syncEndpointCache) return _syncEndpointCache;
  const svc = loadServices();
  if (svc["genshin-sync"]?.endpoint) { _syncEndpointCache = svc["genshin-sync"].endpoint as string; return _syncEndpointCache; }
  try { execSync("curl -sf --connect-timeout 1 " + SYNC_TUNNEL + "/health", { stdio: "ignore" }); _syncEndpointCache = SYNC_TUNNEL; return SYNC_TUNNEL; } catch { /* 2026-09-05（9/8 补：注释里写了"不再打"但 console.error 没去掉——现在真正静默）：无本地 tunnel 是预期降级（走云端默认），非错误——不打 error 日志。原 console.error 见 git 历史 */ }
  _syncEndpointCache = SYNC_ENDPOINT_DEFAULT;
  return SYNC_ENDPOINT_DEFAULT;
}

// ── 第三方服务配置（~/.teyvat/UserAccount/services.json，兼容旧 config/）──
let _servicesCache: Record<string, any> | null = null;
function loadServices(): Record<string, any> {
  if (_servicesCache) return _servicesCache;
  const ua = join(USER_ACCOUNT, "services.json");
  const legacy = join(CONFIG_DIR, "services.json");
  try {
    _servicesCache = JSON.parse(readFileSync(existsSync(ua) ? ua : legacy, "utf8"));
  } catch (e) { console.error("[paths.ts] " + ((e as any)?.message || e)); _servicesCache = {}; }
  return _servicesCache!;
}

export function serviceKey(service: string, field = "apiKey"): string | null {
  const svc = loadServices()[service];
  if (!svc) return null;
  const v = svc[field];
  return (typeof v === "string" && v.trim()) ? v.trim() : null;
}

// ── 统一 API 管线 ──
function maskKey(key: string): string {
  if (key.length <= 8) return key.slice(0, 2) + "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

let _apiAgent = "system";
export function setApiAgent(agentId: string) { _apiAgent = agentId; }

function writeApiLog(entry: Record<string, any>) {
  try {
    const dir = USER_ACCOUNT;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "api.log"), JSON.stringify(entry) + "\n");
  } catch (e) { console.error("[paths.ts] " + ((e as any)?.message || e)); }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return Math.ceil(cjk * 1.8 + (text.length - cjk) / 4);
}

export async function apiFetch(
  url: string,
  init: RequestInit,
  ctx: { service: string; api: string; agent?: string; key?: string },
): Promise<Response> {
  const start = Date.now();
  let status = 0;
  let error: string | undefined;
  try {
    const res = await fetch(url, init);
    status = res.status;
    return res;
  } catch (e: any) {
    error = e.message;
    throw e;
  } finally {
    writeApiLog({
      ts: new Date().toISOString(),
      agent: ctx.agent || _apiAgent,
      service: ctx.service,
      api: ctx.api,
      key: ctx.key ? maskKey(ctx.key) : undefined,
      method: (init?.method || "GET").toUpperCase(),
      url,
      status,
      ms: Date.now() - start,
      ...(error ? { error } : {}),
    });
  }
}
