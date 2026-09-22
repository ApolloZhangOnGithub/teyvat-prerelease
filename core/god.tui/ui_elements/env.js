// ── teyvat 统一环境标识符（JS 版）───────────────────────────────────────
// 2026-09-16（用户定稿）：渲染类默认 global，只有明确 WSL 特殊的（ASCII 符号回退 / ANSI 残渣处理）
// 才用 isWsl()。禁止各处散落 process.platform / WSL_DISTRO_NAME / WT_SESSION 判断。
//
// 环境：macos（优先开发）/ linux（适配已测）/ wsl（问题最多，blockrender 已有一批分支）/ win32（Windows 原生）
// 判定：
//   darwin            → macos
//   win32             → win32
//   linux + WSL 环境变量 → wsl（WSL_DISTRO_NAME=WSL2 / WSL_INTEROP=WSL1）
//   linux（非 WSL）     → linux
//   其他               → global

export function detectEnv() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return "wsl";
    return "linux";
  }
  return "global";
}

let _cached = null;
/** 当前环境（进程内缓存，env 不会变） */
export function env() {
  if (_cached === null) _cached = detectEnv();
  return _cached;
}

/** 是否 WSL（WSL 专属处理的唯一判据——别的地方不要重复判断） */
export function isWsl() {
  return env() === "wsl";
}
