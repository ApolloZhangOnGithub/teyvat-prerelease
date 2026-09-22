// god.tui/commands/bg.ts
// /b —— 查看/管理后台任务（execute bg/tty）。
// 界面参考 claude code 的键盘驱动风格：主列表 ↑↓ 选择，选中后进入二级操作
// （详情/终止），esc 层层返回；底部按键提示由 ctx.ui.select 自带
// （↑↓ navigate · ⏎ select · esc cancel）。
// 数据源：executes.ts 通过 globalThis.__genshinBgTasks / __genshinKillBg 桥接
// （命令层与扩展同进程，直接读模块级 running 注册表的快照）。

import { i18n } from "#tui_localizations";
import { fmtElapsedCoarse } from "#tui_blockrender";
const T = (zh: string, en: string) => i18n(zh, en);

// 2026-09-13（ISSUE 226）：耗时格式唯一实现在 blocks_nongod.fmtElapsedCoarse（与 statebar 的 lasting 同款）
function fmtDuration(secs: number): string {
  return fmtElapsedCoarse(Math.max(0, Math.round(secs)) * 1000);
}

function getTasks(): any[] {
  try { return (globalThis as any).__genshinBgTasks ?? []; } catch (e) { console.error("[god.tui/commands/bg.ts] " + ((e as any)?.message || e)); return []; }
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

  const showSettingsList = (globalThis as any).__genshinShowSettingsList;
  if (showSettingsList) {
    // 新管线：SettingsList（只读展示，Enter 进子操作）
    // 2026-09-13（审计 HIGH）：SettingsList 的 activateItem 只在 values.length>0 时才调 onChange——原来 values:[] 且无 onActivate，Enter/方向键全无反应，杀/详情根本进不去。改用 onActivate。
    const onPick = async (id: string) => {
      const tid = parseInt(id);
      const t = tasks.find((x) => x.id === tid);
      if (!t) return;
      const act = await ctx.ui.select(T(`@${tid}`, `@${tid}`), [T("终止", "Kill"), T("详情", "Details")]);
      if (!act) return;
      if (act.startsWith(T("终止", "Kill"))) {
        const kill = (globalThis as any).__genshinKillBg;
        if (typeof kill === "function") {
          const r = await kill(tid);
          ctx.ui.notify(r, r.includes("not found") ? "warning" : "info");
          const idx = tasks.findIndex((x) => x.id === tid);
          if (idx >= 0) tasks.splice(idx, 1);
        }
      } else if (act.startsWith(T("详情", "Details"))) {
        const started = new Date(t.startTime).toLocaleString();
        ctx.ui.notify([`@${tid} ${t.type === "tty" ? "tty" : "bg"}`, t.title || "", t.command, `${started} (${fmtDuration((Date.now() - t.startTime) / 1000)})`].filter(Boolean).join("\n"), "info");
      }
    };
    const getItems = () => tasks.map((t) => {
      const elapsed = fmtDuration((Date.now() - t.startTime) / 1000);
      const tag = t.type === "tty" ? "tty" : "bg";
      const cmd = t.title || (t.command.length > 50 ? t.command.slice(0, 47) + "..." : t.command);
      return { id: String(t.id), label: `@${t.id} ${tag} ${cmd}`, currentValue: elapsed, values: [], onActivate: () => { void onPick(String(t.id)); } };
    });
    await showSettingsList(T(`后台任务 (${tasks.length})`, `Background (${tasks.length})`), getItems, onPick);
    return;
  }

  // [FALLBACK] 旧管线
  while (true) {
    const items = tasks.map((t) => {
      const elapsed = fmtDuration((Date.now() - t.startTime) / 1000);
      const tag = t.type === "tty" ? "tty" : "bg ";
      const cmd = t.title || (t.command.length > 70 ? t.command.slice(0, 67) + "..." : t.command);
      return `@${t.id}  ${elapsed}  ${tag}  ${cmd}`;
    });
    const pick = await ctx.ui.select(T(`后台任务 (${tasks.length})`, `Background tasks (${tasks.length})`), items);
    if (!pick) return;
    const m = pick.match(/@(\d+)/);
    if (!m) return;
    const id = parseInt(m[1]);
    const t = tasks.find((x) => x.id === id);
    if (!t) continue;
    const act = await ctx.ui.select(T(`管理 @${id}`, `Manage @${id}`), [T(`详情 @${id}`, `Details @${id}`), T(`终止 @${id}`, `Kill @${id}`), T("返回列表", "Back to list")]);
    if (!act) return;
    if (act.startsWith(T("详情", "Details"))) {
      const started = new Date(t.startTime).toLocaleString();
      ctx.ui.notify([`@${id} ${t.type === "tty" ? "tty(tmux)" : "background"}`, t.title || "", t.command, `${started} (${fmtDuration((Date.now() - t.startTime) / 1000)})`].filter(Boolean).join("\n"), "info");
    } else if (act.startsWith(T("终止", "Kill"))) {
      const kill = (globalThis as any).__genshinKillBg;
      if (typeof kill === "function") {
        const r = await kill(id);
        ctx.ui.notify(r, r.includes("not found") ? "warning" : "info");
        const idx = tasks.findIndex((x) => x.id === id);
        if (idx >= 0) tasks.splice(idx, 1);
        if (tasks.length === 0) return;
      }
    }
  }
}
