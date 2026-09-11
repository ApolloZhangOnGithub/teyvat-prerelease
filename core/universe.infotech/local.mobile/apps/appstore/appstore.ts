import type { MobileApp } from "../../system.kernel/kernel.ts";
import { addAgentApp, removeAgentApp } from "../../system.kernel/kernel.ts";
import { PROGRAM_FILES_MOBILE } from "#paths";
import path from "node:path";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, copyFileSync, renameSync, statSync } from "node:fs";

function scanApps(): string[] {
  if (!existsSync(PROGRAM_FILES_MOBILE)) return [];
  try {
    return readdirSync(PROGRAM_FILES_MOBILE).filter(d =>
      !d.startsWith(".") && !d.startsWith("@FUTURE.") && !d.startsWith("@removed.") &&
      statSync(path.join(PROGRAM_FILES_MOBILE, d)).isDirectory()
    );
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/appstore/appstore.ts] " + ((e as any)?.message || e)); return []; }
}

function buildAppList(): string {
  const lines: string[] = ["═══ App Store ═══", ""];
  const dirs = scanApps();

  for (const d of dirs.sort()) {
    lines.push(`  ${d}`);
  }

  lines.push("");
  lines.push("── 命令 ──");
  lines.push("  导入 <path> / import <path>   — 从本地路径导入 .ts");
  lines.push("  导入 github:<user>/<repo>     — 从 GitHub 导入");
  lines.push("  卸载 <name> / uninstall <name> — 卸载用户安装的 app");
  lines.push("  详情 <name> / info <name>     — 查看 app 详情");
  lines.push("  列表 / list                   — 刷新列表");
  return lines.join("\n");
}

// 2026-09-11（prime-agent）安全修复：app 名有两个来源都是"不可信输入"——
//   ① appstore 从**下载的代码**里正则提取 `name:`（完全没校验字符）；
//   ② 卸载/信息等命令的名字直接来自 agent 的 mobile 工具输入。
// 后果：`name: "../../x"` 会让 writeFileSync 写到 apps 目录之外（还会建目录），卸载则把**任意已存在目录**
// rename 成 `@removed.…`（等于把数据藏起来）。这里统一收口：
//   - 名字只允许 [A-Za-z0-9_-]，首字符字母数字，最长 40
//   - 解析后必须仍在 apps 目录内（防穿越的兜底断言）
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
function appDirFor(name: string): string | null {
  if (!APP_NAME_RE.test(name)) return null;
  const base = path.resolve(PROGRAM_FILES_MOBILE) + path.sep;
  const dir = path.resolve(PROGRAM_FILES_MOBILE, name);
  return dir.startsWith(base) ? dir : null;
}

async function validateAppSource(code: string): Promise<{ valid: boolean; name?: string; error?: string }> {
  // 基本静态检查：文件中是否包含 export const/let app 和必要字段
  if (!code.includes("export const app") && !code.includes("export let app")) {
    return { valid: false, error: "文件未导出 app 对象" };
  }
  for (const field of ["name", "icon", "messageDescription", "onOpen", "onAction"]) {
    if (!code.includes(field)) {
      return { valid: false, error: `缺少必要字段: ${field}` };
    }
  }
  // 尝试从代码中提取 name
  const nameMatch = code.match(/name:\s*["']([^"']+)["']/);
  const name = nameMatch?.[1];
  if (!name) return { valid: false, error: "无法从代码中解析 app name" };
  if (!APP_NAME_RE.test(name)) return { valid: false, error: `app name 非法（只允许字母数字 _ -，最长 40）: ${name}` };
  return { valid: true, name };
}

async function handleInstall(name: string): Promise<string> {
  const dirs = scanApps();
  if (dirs.includes(name)) {
    return `「${name}」已存在于 apps/，无需安装。`;
  }
  return `未找到「${name}」。\n\n如需导入外部 app，使用:\n  导入 <本地路径>\n  导入 github:<user>/<repo>`;
}

async function handleImportLocal(filePath: string): Promise<string> {
  const absPath = path.resolve(filePath);
  if (!existsSync(absPath)) {
    return `文件不存在: ${absPath}`;
  }
  if (!absPath.endsWith(".ts")) {
    return "只支持导入 .ts 文件";
  }

  let code: string;
  try {
    code = readFileSync(absPath, "utf8");
  } catch (e: any) {
    return `读取文件失败: ${e.message}`;
  }

  const validation = await validateAppSource(code);
  if (!validation.valid) {
    return `验证失败: ${validation.error}`;
  }

  const appName = validation.name!;
  const appDir = appDirFor(appName);
  if (!appDir) return `app name 非法: ${appName}`;   // 兜底（validateAppSource 已挡，双保险）

  if (existsSync(appDir)) {
    return `「${appName}」已存在于 apps/。如需重装，先卸载。`;
  }

  mkdirSync(appDir, { recursive: true });
  copyFileSync(absPath, path.join(appDir, `${appName}.ts`));
  addAgentApp(appName);

  return `已导入「${appName}」到 apps/${appName}/\n\n重启后 kernel 将自动发现并加载此 app。`;
}

async function handleImportGithub(spec: string): Promise<string> {
  // spec: "user/repo" or "user/repo/file.ts"
  const parts = spec.split("/");
  if (parts.length < 2) {
    return "格式: github:<user>/<repo> 或 github:<user>/<repo>/<file.ts>";
  }

  const user = parts[0];
  const repo = parts[1];
  const file = parts[2] || `${repo}.ts`;
  const url = `https://raw.githubusercontent.com/${user}/${repo}/main/${file}`;

  let code: string;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      return `GitHub 下载失败 (${res.status}): ${url}`;
    }
    code = await res.text();
  } catch (e: any) {
    return `网络错误: ${e.message}\nURL: ${url}`;
  }

  const validation = await validateAppSource(code);
  if (!validation.valid) {
    return `验证失败: ${validation.error}\n来源: ${url}`;
  }

  const appName = validation.name!;
  const appDir = appDirFor(appName);
  if (!appDir) return `app name 非法: ${appName}`;   // 兜底（validateAppSource 已挡，双保险）

  if (existsSync(appDir)) {
    return `「${appName}」已存在于 apps/。如需重装，先卸载。`;
  }

  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, `${appName}.ts`), code, "utf8");
  addAgentApp(appName);

  return `已从 GitHub 导入「${appName}」\n来源: ${url}\n位置: apps/${appName}/\n\n重启后 kernel 将自动发现并加载此 app。`;
}

async function handleUninstall(name: string): Promise<string> {
  const appDir = appDirFor(name);
  if (!appDir) return `app name 非法: ${name}`;   // 防"卸载 ../../x"把任意目录改名（2026-09-11 修复）
  if (!existsSync(appDir)) {
    return `未找到「${name}」。`;
  }

  const removedDir = path.join(PROGRAM_FILES_MOBILE, `@removed.${name}`);
  try {
    renameSync(appDir, removedDir);
  } catch (e: any) {
    return `卸载失败: ${e.message}`;
  }
  removeAgentApp(name);

  return `已卸载「${name}」\n(备份位于 apps/@removed.${name}/)`;
}

function handleInfo(name: string): string {
  const dirs = scanApps();
  const dir = dirs.find(d => d.toLowerCase() === name.toLowerCase());
  if (!dir) return `未找到「${name}」。`;

  const appDir = path.join(PROGRAM_FILES_MOBILE, dir);
  const files = readdirSync(appDir).filter(f => f.endsWith(".ts") && !f.includes(".test"));
  const isSymlink = (() => { try { const s = statSync(appDir); return s.isSymbolicLink(); } catch (e) { console.error("[universe.infotech/local.mobile/apps/appstore/appstore.ts] " + ((e as any)?.message || e)); return false; } })();

  const lines = [
    `═══ ${dir} ═══`,
    "",
    `  目录: ${dir}`,
    `  文件: ${files.join(", ") || "(无)"}`,
    `  类型: ${isSymlink ? "内置 (symlink)" : "用户安装"}`,
  ];
  return lines.join("\n");
}

export const app: MobileApp = {
  name: "appstore",
  icon: "商店",
  messageDescription: "应用商店 — 安装/卸载/导入 app",

  onOpen(state, _personDir) {
    return {
      screen: buildAppList(),
      state: state ?? {},
    };
  },

  async onAction(input, state, _personDir) {
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();

    // 列表 / list
    if (/^(列表|list)$/i.test(trimmed)) {
      return { screen: buildAppList(), state };
    }

    // 安装 <name> / install <name>
    const installMatch = trimmed.match(/^(?:安装|install)\s+(.+)$/i);
    if (installMatch) {
      const result = await handleInstall(installMatch[1].trim());
      return { screen: result, state };
    }

    // 导入 github:<user>/<repo> / import github:<user>/<repo>
    const ghMatch = trimmed.match(/^(?:导入|import)\s+github:(.+)$/i);
    if (ghMatch) {
      const result = await handleImportGithub(ghMatch[1].trim());
      return { screen: result, state };
    }

    // 导入 <path> / import <path>
    const importMatch = trimmed.match(/^(?:导入|import)\s+(.+)$/i);
    if (importMatch) {
      const result = await handleImportLocal(importMatch[1].trim());
      return { screen: result, state };
    }

    // 卸载 <name> / uninstall <name>
    const uninstallMatch = trimmed.match(/^(?:卸载|uninstall)\s+(.+)$/i);
    if (uninstallMatch) {
      const result = await handleUninstall(uninstallMatch[1].trim());
      return { screen: result, state };
    }

    // 详情 <name> / info <name>
    const infoMatch = trimmed.match(/^(?:详情|info)\s+(.+)$/i);
    if (infoMatch) {
      const result = handleInfo(infoMatch[1].trim());
      return { screen: result, state };
    }

    return {
      screen: `未知命令: ${trimmed}\n\n${buildAppList()}`,
      state,
    };
  },
};
