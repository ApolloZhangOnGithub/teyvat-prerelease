// ── 命名来由（2026-09-22）：AX 是主概念（AxEngine 接口）——macax 是 engine 实现（非平行 provider 层）。
// ts 封装名不带 engine 词（ax.ts）；py 引擎本体带（ax-engine-macax.py）——NORM 001「同名不同扩展禁止」。
// ax.ts — vision.ax 主程序：读 macOS 辅助功能（AX）树 = 活 app 的 UI 元素树
// 与 vision.ocr 的分工（PROPOSAL 041）：活界面用 ax（精确/有结构/可交互/能读屏外）；图片文件用 ocr（唯一手段）。
// 供应商按名选择：目前仅 macax（macOS 实现）；Windows UIA / Linux AT-SPI2 后续另立实现文件 + 工厂加分支。
// 文档: B.docs/Dev.Common/Wiki/Eyes(Organ).WIKI  |  B.docs/Dev.Common/Proposals/041-*.PROPOSAL

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// 引擎路径动态发现（沿用 ocr 的 ISSUE 156 教训）：目标名在则用；不在（部署 rename 后）扫 ax-engine-*.py；
// 都不在则返回目标名让 execFile 报错（走友好处理），不抛。
function resolveEngine(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const target = join(dir, "ax-engine-macax.py");
  if (existsSync(target)) return target;
  try {
    const hits = readdirSync(dir).filter((f) => f.startsWith("ax-engine-") && f.endsWith(".py"));
    if (hits.length) return join(dir, hits[0]);
  } catch { /* readdir 失败 → 返回目标名让 execFile 报错 */ }
  return target;
}

const AX_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

// PyObjC 可用性只探测一次（进程内缓存）。缺依赖给可操作提示（PEP 668 场景）——不静默。
let pyobjcCache: null | boolean = null;
async function hasPyObjc(): Promise<boolean> {
  if (pyobjcCache !== null) return pyobjcCache;
  try {
    await execFileAsync("python3", ["-c", "import ApplicationServices"], { timeout: 15_000 });
    pyobjcCache = true;
  } catch (e) {
    console.error("[spirit.bio.abilities/vision.ax/ax.ts] " + ((e as any)?.message || e));
    pyobjcCache = false;
  }
  return pyobjcCache;
}

function logEyes(entry: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), ".teyvat/LogData", process.env.PAIMON_AGENT_ID || "unknown");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "eyes.log"), JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error("[spirit.bio.abilities/vision.ax/ax.ts] " + ((e as any)?.message || e));
    // 日志失败不影响主流程
  }
}

// ── 类型 ────────────────────────────────────────────────────
export interface AxApp {
  name: string;
  pid: number;
  bundle: string;
}

export interface AxNode {
  /** 树深度（0=窗口） */
  depth: number;
  role: string;
  subrole: string;
  title: string;
  value: string;
  desc: string;
  placeholder: string;
}

export interface AxResult {
  app: AxApp & { frontmost: boolean };
  trusted: boolean;
  elapsedMs: number;
  /** windows=从窗口树走（正常）；app=窗口取不到时的兜底（含菜单栏） */
  walkedFrom: "windows" | "app";
  windowsFound: number;
  counts: { elements: number; withText: number; dumped: number; max: number; menuSkipped: number; truncated: boolean };
  rolesFiltered: boolean;
  nodes?: AxNode[];
  texts?: string[];
  hint?: string;
}

export interface AxOptions {
  /** app 名字子串（如 "Safari"）；不传=最前台 app */
  app?: string;
  /** 按 pid 指定（优先于 app） */
  pid?: number;
  /** 树深度上限，默认 8 */
  depth?: number;
  /** 最多输出多少个「有文本」元素，默认 200（防灌爆上下文） */
  max?: number;
  /** 角色白名单（逗号分隔，如 "AXButton,AXStaticText"）；不传=内置文本角色白名单 */
  roles?: string;
  /** tree=结构树（默认）| text=纯文本（按树序去重） */
  mode?: "tree" | "text";
  /** 是否包含菜单栏子树（默认 false——菜单项动辄上百条） */
  menubar?: boolean;
  /** 不过滤角色（调试用） */
  allRoles?: boolean;
}

export interface AxEngine {
  list(): Promise<{ apps: AxApp[] } | { error: string }>;
  read(options?: AxOptions): Promise<AxResult | { error: string }>;
}

function buildArgs(options: AxOptions, list: boolean): string[] {
  const args = [resolveEngine()];
  if (list) return [...args, "--list"];
  if (options.app) args.push("--app", options.app);
  if (options.pid) args.push("--pid", String(options.pid));
  if (options.depth !== undefined) args.push("--depth", String(options.depth));
  if (options.max !== undefined) args.push("--max", String(options.max));
  if (options.roles) args.push("--roles", options.roles);
  if (options.mode) args.push("--mode", options.mode);
  if (options.menubar) args.push("--menubar");
  if (options.allRoles) args.push("--all-roles");
  return args;
}

// ── macOS 实现 ───────────────────────────────────────────────
export class MacAxEngine implements AxEngine {
  private async run<T>(args: string[], tag: string): Promise<T | { error: string }> {
    if (!(await hasPyObjc())) {
      return { error: "需要 PyObjC（macOS 辅助功能 AX）：python3 -m pip install --user pyobjc-framework-Quartz（Homebrew Python 受 PEP 668 保护时再加 --break-system-packages；install.sh 已尽量自动装）" };
    }
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync("python3", args, { timeout: AX_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
      const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string } & T;
      if (parsed?.ok === false) {
        logEyes({ ts: new Date().toISOString(), mode: tag, ok: false, error: String(parsed.error || "").slice(0, 300) });
        return { error: `AX 失败: ${parsed.error}` };
      }
      logEyes({ ts: new Date().toISOString(), mode: tag, elapsedMs: Date.now() - t0, ok: true });
      return parsed;
    } catch (e) {
      const msg = String((e as { stderr?: string })?.stderr || (e as Error)?.message || e).trim();
      logEyes({ ts: new Date().toISOString(), mode: tag, ok: false, error: msg.slice(0, 500) });
      return { error: `AX 失败: ${msg.slice(0, 300)}` };
    }
  }

  async list(): Promise<{ apps: AxApp[] } | { error: string }> {
    return this.run<{ apps: AxApp[] }>(buildArgs({}, true), "list");
  }

  async read(options: AxOptions = {}): Promise<AxResult | { error: string }> {
    return this.run<AxResult>(buildArgs(options, false), options.mode === "text" ? "text" : "tree");
  }
}

// ── 供应商工厂 ────────────────────────────────────────────────
// 目前只有 macOS 实现：非 darwin 返回 null（调用方给「AX 仅 macOS」提示——Windows 走 UIA、Linux 走 AT-SPI2，均未实现）。
export function createAxEngine(name?: string): AxEngine | null {
  const resolved = name ?? (process.platform === "darwin" ? "macax" : "");
  switch (resolved) {
    case "macax":
    case "default":
      return process.platform === "darwin" ? new MacAxEngine() : null;
    default:
      return null;
  }
}
