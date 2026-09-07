// 文档: B.docs/Dev.Common/Wiki/Trust(Hands Mechanism).WIKI
import { resolve, join, dirname } from "node:path";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { agentId, agentWorkDir, loadTrust, saveTrust, agentEntry } from "#hands_fileactions";
import { getToolManifest } from "#kernel_ribosome";
import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

// ── 工具持久授权（/a enable-<tool> /a disable-<tool>）──
// 每个 agent 一个独立目录：~/.teyvat/config/tools-auth/<agentId>/tools-auth.json
// 跨 session 持久（区别于 /tools 的会话级 tools-session.json）。目录即 agent，分离管理。
const toolsAuthPath = (pid: string) => join(homedir(), ".teyvat/config/tools-auth", pid, "tools-auth.json");

async function loadToolsAuth(pid: string): Promise<{ enabled: string[]; disabled: string[] }> {
  try {
    const d = JSON.parse(await readFile(toolsAuthPath(pid), "utf8"));
    return { enabled: d.enabled || [], disabled: d.disabled || [] };
  } catch (e) { console.error("[god.frontend.tui/commands/authdir.ts] " + ((e as any)?.message || e)); return { enabled: [], disabled: [] }; }
}

async function manifestToolNames(): Promise<string[]> {
  // 走 ribosome 既有管线 getToolManifest()（带缓存/环境变量/出错兜底），不手写路径
  try {
    return Object.keys(getToolManifest().tools || {});
  } catch (e) { console.error("[god.frontend.tui/commands/authdir.ts] " + ((e as any)?.message || e)); return []; }
}

export async function authdirCompletions(prefix: string) {
  const items: { value: string; label: string; description?: string }[] = [];
  const rm = prefix.match(/^remove\s+(.*)$/);
  if (rm) {
    await loadTrust();
    const e = agentEntry();
    for (const c of ["all", ...e.trusted.map(t => t.path)]) {
      if (c.startsWith(rm[1]!)) items.push({ value: `remove ${c}`, label: c });
    }
    return items.length ? items : null;
  }
  // enable-<tool> / disable-<tool> 补全（列出 manifest 工具名）
  const tm = prefix.match(/^(enable|disable)[- ](.*)$/);
  if (tm) {
    const names = await manifestToolNames();
    for (const n of names) {
      if (n.toLowerCase().startsWith(tm[2]!.toLowerCase())) items.push({ value: `${tm[1]}-${n}`, label: `${tm[1]}-${n}` });
    }
    return items.length ? items : null;
  }
  const subs: [string, string][] = [["all", T("全量白名单（系统黑名单仍生效）", "Full whitelist (system blacklist still applies)")], ["self-reboot", T("授权模型自主重启", "Authorize model self-reboot")], ["model ", T("授权模型切换（status switch-model，<id>|all）", "Authorize model switch (status switch-model, <id>|all)")], ["remove ", T("撤销授权", "Revoke authorization")], ["list", T("查看状态", "View status")]];
  for (const [s, desc] of subs) {
    if (s.startsWith(prefix)) items.push({ value: s, label: s.trim(), description: desc });
  }
  const raw = prefix.replace(/^~(?=\/|$)/, homedir());
  try {
    const slash = raw.lastIndexOf("/");
    const dir = slash >= 0 ? (raw.slice(0, slash) || "/") : ".";
    const base = slash >= 0 ? raw.slice(slash + 1) : raw;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (base ? !ent.name.startsWith(base) : ent.name.startsWith(".")) continue;
      const full = (dir === "/" ? "" : dir === "." ? "" : dir + "/") + ent.name;
      items.push({ value: (full || ent.name) + "/", label: ent.name + "/" });
      if (items.length >= 25) break;
    }
  } catch (e) { console.error("[god.frontend.tui/commands/authdir.ts] " + ((e as any)?.message || e)); }
  return items.length ? items : null;
}

export async function authdirHandler(args: string, ctx: any, tools?: { getActive: () => string[]; setActive: (t: string[]) => void }) {
  await loadTrust();
  const e = agentEntry();
  const a = (args ?? "").trim();
  if (!a || a === "list") {
    const now = Date.now();
    const rows = e.trusted.filter(t => !t.until || t.until > now)
      .map(t => ` - ${t.path}${t.until ? T(`（剩 ${Math.ceil((t.until - now) / 60000)} 分钟）`, ` (${Math.ceil((t.until - now) / 60000)} min left)`) : ""}`);
    const pid = (globalThis as any).__genshinPersonId || "";
    const auth = await loadToolsAuth(pid);
    ctx.ui.notify(i18n(
      `agent: ${agentId()}\n工作目录(常开): ${agentWorkDir()}\n全量白名单: ${e.all ? "开" : "关"}\nroot授权: ${e.root ? "开" : "关"}\n工具持久授权: enable[${auth.enabled.join(",") || "无"}] disable[${auth.disabled.join(",") || "无"}]\n信任目录:\n${rows.join("\n") || " (无)"}`,
      `agent: ${agentId()}\nWorkdir (persistent): ${agentWorkDir()}\nFull whitelist: ${e.all ? "on" : "off"}\nRoot auth: ${e.root ? "on" : "off"}\nPersistent tool auth: enable[${auth.enabled.join(",") || "none"}] disable[${auth.disabled.join(",") || "none"}]\nTrusted dirs:\n${rows.join("\n") || " (none)"}`
    ), "info");
    return;
  }
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  if (a === "all") {
    e.all = true; await saveTrust();
    ctx.ui.notify(T("已开启全量白名单（系统黑名单仍生效）", "Full whitelist enabled (system blacklist still applies)"), "info");
    return;
  }
  if (a === "root") {
    e.root = true; await saveTrust();
    ctx.ui.notify(T("已开启 root 授权（~/.teyvat 全域可操作）", "Root authorization enabled (~/.teyvat fully accessible)"), "info");
    return;
  }
  if (a === "self-reboot") {
    const pid = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
    if (pid) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const flagDir = join(homedir(), ".teyvat/RuntimeCache", pid);
      mkdirSync(flagDir, { recursive: true });
      writeFileSync(join(flagDir, "self-reboot-auth"), JSON.stringify({ authorized: true, ts: Date.now(), by: "user" }));
      ctx.ui.notify(T("self-reboot 已授权（永久生效）。模型可通过 execute({command:\"self-reboot\"}) 重启进程。", "self-reboot authorized (permanent). The model can restart the process via execute({command:\"self-reboot\"})."), "info");
    } else { ctx.ui.notify(T("无法确定 agent ID", "Cannot determine agent ID"), "warning"); }
    return;
  }
  if (a === "remove" || a.startsWith("remove ")) {
    const rest = unquote(a.slice(6));
    if (rest === "all") { e.all = false; await saveTrust(); ctx.ui.notify(T("已关闭全量白名单", "Full whitelist disabled"), "info"); return; }
    if (rest === "root") { e.root = false; await saveTrust(); ctx.ui.notify(T("已关闭 root 授权", "Root authorization disabled"), "info"); return; }
    if (!rest) { ctx.ui.notify(T("/authdir remove <目录|all>", "/authdir remove <dir|all>"), "warning"); return; }
    const p = resolve(rest.replace(/^~(?=\/|$)/, homedir()));
    e.trusted = e.trusted.filter(t => t.path !== p);
    await saveTrust(); ctx.ui.notify(T(`已撤销: ${p}`, `Revoked: ${p}`), "info");
    return;
  }
  // 2026-09-07 用户定稿：/a model 授权——status switch-model 切换模型（默认禁止，需授权 specific 或 all）
  if (a === "model" || a.startsWith("model ") || a === "m" || a.startsWith("m ")) {
    const rest = unquote(a.replace(/^(m|model)\s*/, "").trim());
    const pid = (globalThis as any).__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
    if (!pid) { ctx.ui.notify(T("无法确定 agent ID", "Cannot determine agent ID"), "warning"); return; }
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir: home2 } = await import("node:os");
    const flagDir = join(home2(), ".teyvat/RuntimeCache", pid);
    mkdirSync(flagDir, { recursive: true });
    const all = rest === "all";
    const auth = { authorized: true, all, models: all ? [] : (rest ? [rest] : []), ts: Date.now(), by: "user" };
    writeFileSync(join(flagDir, "model-switch-auth.json"), JSON.stringify(auth));
    ctx.ui.notify(T(
      all ? `已授权 ${pid} 切换任意模型（/a model all 全量）。agent 可 Status switch-model。` :
        `已授权 ${pid} 切换到模型 ${rest}。agent 可 Status switch-model。`,
      all ? `${pid} authorized to switch any model (/a model all). Agent can use Status switch-model.` :
        `${pid} authorized to switch to model ${rest}. Agent can use Status switch-model.`
    ), "info");
    return;
  }
  // ── 工具持久授权：/a enable-<tool> | /a disable-<tool> ──
  const tm = a.match(/^(enable|disable)[- ](.+)$/);
  if (tm) {
    const op = tm[1] as "enable" | "disable";
    const want = unquote(tm[2]).toLowerCase();
    const names = await manifestToolNames();
    const canon = names.find(n => n.toLowerCase() === want);
    if (!canon) {
      ctx.ui.notify(T(`未知工具: ${want}。manifest 工具: ${names.join(", ") || "(空)"}`, `Unknown tool: ${want}. Manifest tools: ${names.join(", ") || "(empty)"}`), "error");
      return;
    }
    const pid = (globalThis as any).__genshinPersonId || "";
    if (!pid) { ctx.ui.notify(T("无法确定 agent ID", "Cannot determine agent ID"), "warning"); return; }
    const me = await loadToolsAuth(pid);
    const en = new Set(me.enabled);
    const dis = new Set(me.disabled);
    if (op === "enable") { en.add(canon); dis.delete(canon); }
    else { dis.add(canon); en.delete(canon); }
    try {
      await mkdir(dirname(toolsAuthPath(pid)), { recursive: true });
      await writeFile(toolsAuthPath(pid), JSON.stringify({ enabled: [...en], disabled: [...dis] }, null, 2));
    } catch (err: any) {
      ctx.ui.notify(T(`持久授权表写入失败: ${err?.message}`, `Failed to write persistent auth table: ${err?.message}`), "error");
      return;
    }
    // 即时生效（不依赖重启，与 /tools 同机制）
    if (tools) {
      const cur = tools.getActive();
      if (op === "enable" && !cur.some(t => t.toLowerCase() === canon)) tools.setActive([...cur, canon]);
      if (op === "disable") tools.setActive(cur.filter(t => t.toLowerCase() !== canon));
    }
    ctx.ui.notify(i18n(
      `/a ${op}-${canon} ${op === "enable" ? "已授权" : "已撤销授权"}（持久，跨 session 生效）`,
      `/a ${op}-${canon} ${op === "enable" ? "authorized" : "revoked"} (persistent, across sessions)`
    ), "info");
    return;
  }

  const mm = a.match(/^(.*?)(?:\s+(\d+))?$/s)!;
  const rawPath = unquote(mm[1] ?? "");
  const min = mm[2] ? parseInt(mm[2], 10) : NaN;
  if (!rawPath) { ctx.ui.notify(T("/authdir <目录> [分钟] | /a all | /authdir remove <目录|all>", "/authdir <dir> [minutes] | /a all | /authdir remove <dir|all>"), "warning"); return; }
  const p = resolve(rawPath.replace(/^~(?=\/|$)/, homedir()));
  e.trusted = e.trusted.filter(t => t.path !== p);
  e.trusted.push({ path: p, until: Number.isFinite(min) && min > 0 ? Date.now() + min * 60000 : undefined });
  await saveTrust();
  ctx.ui.notify(i18n(
    `已信任: ${p}${Number.isFinite(min) && min > 0 ? `（${min} 分钟）` : "（永久）"}`,
    `Trusted: ${p}${Number.isFinite(min) && min > 0 ? ` (${min} min)` : " (permanent)"}`
  ), "info");
}
