// god.frontend.tui/commands/tools.ts
// /tools 命令 — per-tool 粒度会话级工具管理
//   /tools              列出全部工具 + 当前状态（default/模型覆盖/会话覆盖/实际激活）
//   /tools <name>       toggle 该工具会话级开关（RuntimeCache 持久化，重启失效）
//   /tools reset        清空会话级覆盖，回到 manifest default + 模型覆盖
// 文档: B.docs/Dev.Common/Wiki/Slash&Tools(Concept).WIKI
// 修复 2026-08-15: 原来只列出 activeTools 无开关功能。现支持会话级 per-tool toggle。
// 会话覆盖文件: ~/.teyvat/RuntimeCache/<id>/tools-session.json

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
// 工具清单走 ribosome 既有管线 getToolManifest()（带缓存/环境变量/出错兜底），
// 不再手写 __dirname 拼路径——ESM 下 __dirname 是 undefined，manifest 永远读空（2026-08-15 用户报修）。
import { getToolManifest } from "#kernel_ribosome";
import { DIRS } from "#paths";
import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

function sessionOverrides(): Record<string, boolean> {
  try {
    const dir = path.join(os.homedir(), ".teyvat/RuntimeCache", (globalThis as any).__genshinPersonId || "unknown");
    const f = path.join(dir, "tools-session.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")) || {};
  } catch (e) { console.error("[god.frontend.tui/commands/tools.ts] " + ((e as any)?.message || e)); }
  return {};
}

function saveSessionOverrides(ov: Record<string, boolean>): boolean {
  try {
    const dir = path.join(os.homedir(), ".teyvat/RuntimeCache", (globalThis as any).__genshinPersonId || "unknown");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tools-session.json"), JSON.stringify(ov, null, 2));
    return true;
  } catch (e) { console.error("[god.frontend.tui/commands/tools.ts] " + ((e as any)?.message || e)); return false; }
}

export function toolsHandler(getActiveTools: () => string[], setActiveTools?: (t: string[]) => void) {
  return async (args: string, ctx: any) => {
    const arg = (args || "").trim();
    const active: string[] = getActiveTools() ?? [];

    // ── reset：清空会话覆盖，并即时恢复 manifest default + 模型覆盖 ──
    if (arg === "reset") {
      saveSessionOverrides({});
      if (setActiveTools) {
        try {
          const m = getToolManifest();
          const base = new Set<string>();
          for (const [k, v] of Object.entries(m.tools || {})) { if ((v as any).default && !(v as any).abandoned) base.add(k); }
          const modelId = (ctx?.model?.id || "").toString();
          if (modelId) {
            const mmp = path.join(DIRS.core, `spirit.bio.gene/tools/${modelId}.json`);
            if (fs.existsSync(mmp)) {
              const ov = JSON.parse(fs.readFileSync(mmp, "utf8"))?.overrides || {};
              for (const [k, v] of Object.entries(ov)) { if (v === true) base.add(k); else if (v === false) base.delete(k); }
            }
          }
          const cur = getActiveTools() ?? [];
          setActiveTools(cur.filter((t: string) => base.has(t)));
        } catch (e) { console.error("[god.frontend.tui/commands/tools.ts] " + ((e as any)?.message || e)); }
      }
      ctx.ui.notify(T("会话级工具覆盖已清空，回到 manifest default + 模型覆盖", "Session tool overrides cleared, back to manifest default + model overrides"), "info");
      return;
    }

    // ── 读 manifest（全部工具 + default + chr）── 走 ribosome 管线
    const manifestTools: Record<string, any> = getToolManifest().tools || {};

    // ── 读模型覆盖（当前模型）──
    let modelOverrides: Record<string, boolean> = {};
    try {
      const modelId = (ctx?.model?.id || "").toString();
      if (modelId) {
        const mmp = path.join(DIRS.core, `spirit.bio.gene/tools/${modelId}.json`);
        if (fs.existsSync(mmp)) modelOverrides = JSON.parse(fs.readFileSync(mmp, "utf8"))?.overrides || {};
      }
    } catch (e) { console.error("[god.frontend.tui/commands/tools.ts] " + ((e as any)?.message || e)); }

    // ── toggle：/tools <name> ──
    if (arg && arg !== "reset") {
      const name = arg.toLowerCase();
      if (!(name in manifestTools)) {
        ctx.ui.notify(T(`未知工具: ${name}。用 /tools 查看全部`, `Unknown tool: ${name}. Use /tools to list all`), "error");
        return;
      }
      const ov = sessionOverrides();
      const currentlyActive = active.includes(name) || active.some((t) => t.toLowerCase() === name);
      ov[name] = !currentlyActive;
      saveSessionOverrides(ov);
      // 即时生效（不依赖重启）：当前 session 立即更新 activeTools
      if (setActiveTools) {
        const next = [...active];
        const idx = next.findIndex((t) => t.toLowerCase() === name);
        if (ov[name] && idx < 0) next.push(name);
        if (!ov[name] && idx >= 0) next.splice(idx, 1);
        setActiveTools(next);
      }
      ctx.ui.notify(i18n(
        `/tools ${name} → ${ov[name] ? "启用" : "禁用"}（会话级，重启失效）`,
        `/tools ${name} → ${ov[name] ? "enabled" : "disabled"} (session-level, lost on restart)`
      ), "info");
      return;
    }

    // ── 列表模式 ──
    const names = Object.keys(manifestTools).sort();
    const sess = sessionOverrides();

    const showSettingsList = (globalThis as any).__genshinShowSettingsList;
    if (showSettingsList) {
      // 新管线：SettingsList 左右键切启用/禁用
      const getItems = () => names.map((n: string) => {
        const def = manifestTools[n];
        const activeNow: string[] = getActiveTools() ?? [];
        const isActive = activeNow.includes(n) || activeNow.some((t: string) => t.toLowerCase() === n);
        const flags: string[] = [];
        if (def.locked) flags.push("locked");
        if (n in sess) flags.push("sess");
        else if (n in modelOverrides) flags.push("model");
        const flagStr = flags.length ? ` [${flags.join(",")}]` : "";
        return {
          id: n,
          label: `${n}${flagStr}`,
          currentValue: isActive ? T("启用", "On") : T("禁用", "Off"),
          values: def.locked ? [] : [T("启用", "On"), T("禁用", "Off")],
        };
      });
      await showSettingsList("Tools", getItems, (id: string, value: string) => {
        const on = value === T("启用", "On");
        sess[id] = on;
        saveSessionOverrides(sess);
        if (setActiveTools) {
          const cur = getActiveTools() ?? [];
          const next = [...cur];
          const idx = next.findIndex((t: string) => t.toLowerCase() === id);
          if (on && idx < 0) next.push(id);
          if (!on && idx >= 0) next.splice(idx, 1);
          setActiveTools(next);
        }
      });
      return;
    }

    // [FALLBACK] 旧管线
    const nameW = Math.max(4, ...names.map((n: string) => n.length));
    for (;;) {
      const activeNow: string[] = getActiveTools() ?? [];
      const opts: string[] = [];
      for (const n of names) {
        const def = manifestTools[n];
        const isActive = activeNow.includes(n) || activeNow.some((t) => t.toLowerCase() === n);
        const flags: string[] = [];
        if (def.locked) flags.push("locked");
        if (n in sess) flags.push("sess");
        else if (n in modelOverrides) flags.push("model");
        const flagStr = flags.length ? `[${flags.join(",")}]` : "";
        opts.push(`${isActive ? "●" : "○"} ${n.padEnd(nameW)}${flagStr ? " " + flagStr : ""}`);
      }
      const choice = await ctx.ui.select("Tools", opts);
      if (!choice) break;
      const idx = opts.indexOf(choice);
      const name = names[idx];
      if (!name) continue;
      const currentlyActive = activeNow.includes(name) || activeNow.some((t) => t.toLowerCase() === name);
      sess[name] = !currentlyActive;
      saveSessionOverrides(sess);
      if (setActiveTools) {
        const next = [...activeNow];
        const idx2 = next.findIndex((t) => t.toLowerCase() === name);
        if (sess[name] && idx2 < 0) next.push(name);
        if (!sess[name] && idx2 >= 0) next.splice(idx2, 1);
        setActiveTools(next);
      }
      ctx.ui.notify(i18n(
        `/tools ${name} → ${sess[name] ? "启用" : "禁用"}（会话级，重启失效）`,
        `/tools ${name} → ${sess[name] ? "enabled" : "disabled"} (session-level, lost on restart)`
      ), "info");
    }
  };
}
