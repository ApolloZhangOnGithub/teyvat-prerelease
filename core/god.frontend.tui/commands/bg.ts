// god.frontend.tui/commands/bg.ts
// /b —— 查看/管理后台任务（execute bg/tty）。
// 界面参考 claude code 的键盘驱动风格：主列表 ↑↓ 选择，选中后进入二级操作
// （详情/终止），esc 层层返回；底部按键提示由 ctx.ui.select 自带
// （↑↓ navigate · ⏎ select · esc cancel）。
// 数据源：executes.ts 通过 globalThis.__genshinBgTasks / __genshinKillBg 桥接
// （命令层与扩展同进程，直接读模块级 running 注册表的快照）。

import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function getTasks(): any[] {
  try { return (globalThis as any).__genshinBgTasks ?? []; } catch (e) { console.error("[god.frontend.tui/commands/bg.ts] " + ((e as any)?.message || e)); return []; }
}

export async function bgHandler(args: string, ctx: any) {
  const a = (args ?? "").trim();

  // /b kill @N —— 直接终止，不进菜单
  const killMatch = a.match(/^kill\s+@?(\d+)\s*$/);
  if (killMatch) {
    const kill = (globalThis as any).__genshinKillBg;
    if (typeof kill !== "function") {
      ctx.ui.notify(T("后台任务模块未加载（扩展未就绪）", "Background task module not loaded (extension not ready)"), "error");
      return;
    }
    const r = await kill(parseInt(killMatch[1]));
    ctx.ui.notify(r, r.includes("not found") ? "warning" : "info");
    return;
  }
  if (a && a !== "list" && !/^list$/.test(a)) {
    ctx.ui.notify(T("用法: /b 查看后台任务 | /b kill @N 终止", "Usage: /b list background tasks | /b kill @N"), "warning");
    return;
  }

  const tasks = getTasks();
  if (tasks.length === 0) {
    ctx.ui.notify("(no background commands)", "info");
    return;
  }

  while (true) {
    const items = tasks.map((t) => {
      const elapsed = fmtDuration((Date.now() - t.startTime) / 1000);
      const tag = t.type === "tty" ? "tty" : "bg ";
      // 有标题优先显示标题（人类可读），无则截断命令
      const cmd = t.title || (t.command.length > 70 ? t.command.slice(0, 67) + "..." : t.command);
      return `@${t.id}  ${elapsed}  ${tag}  ${cmd}`;
    });
    const pick = await ctx.ui.select(T(`后台任务 (${tasks.length})`, `Background tasks (${tasks.length})`), items);
    if (!pick) return; // esc 退出

    const m = pick.match(/@(\d+)/);
    if (!m) return;
    const id = parseInt(m[1]);
    const t = tasks.find((x) => x.id === id);
    if (!t) continue;

    const act = await ctx.ui.select(T(`管理 @${id}`, `Manage @${id}`), [T(`详情 @${id}`, `Details @${id}`), T(`终止 @${id}`, `Kill @${id}`), T("返回列表", "Back to list")]);
    if (!act) return;

    if (act.startsWith(T("详情", "Details"))) {
      const started = new Date(t.startTime).toLocaleString();
      const lines = [
        `@${id}  ${t.type === "tty" ? "tty(tmux)" : "background"}`,
        t.title ? T(`标题: ${t.title}`, `Title: ${t.title}`) : "",
        T(`命令: ${t.command}`, `Command: ${t.command}`),
        T(`启动: ${started}（已运行 ${fmtDuration((Date.now() - t.startTime) / 1000)}）`, `Started: ${started} (running ${fmtDuration((Date.now() - t.startTime) / 1000)})`),
        t.type === "tty" && t.tmuxSession ? `tmux: ${t.tmuxSession}` : "",
        t.tail ? T(`输出尾部: ${t.tail}`, `Output tail: ${t.tail}`) : "",
        t.recId ? T(`记录: ~/.teyvat/ExecuteData/<personId>/${t.recId}.json`, `Record: ~/.teyvat/ExecuteData/<personId>/${t.recId}.json`) : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), "info");
    } else if (act.startsWith(T("终止", "Kill"))) {
      const ok = await ctx.ui.confirm(T("终止后台任务", "Kill background task"), T(`确定终止 @${id}？`, `Kill @${id}?`), {});
      if (!ok) continue;
      const kill = (globalThis as any).__genshinKillBg;
      if (typeof kill !== "function") {
        ctx.ui.notify(T("后台任务模块未加载（扩展未就绪）", "Background task module not loaded (extension not ready)"), "error");
        return;
      }
      const r = await kill(id);
      ctx.ui.notify(r, r.includes("not found") ? "warning" : "info");
      // 杀掉后从本地快照移除，列表即时反映
      const idx = tasks.findIndex((x) => x.id === id);
      if (idx >= 0) tasks.splice(idx, 1);
      if (tasks.length === 0) return;
    }
    // "返回列表" → 继续循环
  }
}
