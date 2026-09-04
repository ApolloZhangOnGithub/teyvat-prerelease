// devs.ts — /experimental 命令
// 管理实验性功能开关，统一管线 PI_EXPERIMENTAL=XPxxxx
// 持久化到 settings.json 的 experimental 字段
// 文档: B.docs/Dev.Common/Wiki/Blackbox(Dev Debugging).WIKI

import { userFile } from "#paths";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

function loadExpFlag(): number {
  try {
    if (existsSync(userFile("settings.json"))) {
      const s = JSON.parse(readFileSync(userFile("settings.json"), "utf8"));
      if (typeof s.experimental === "number") return s.experimental;
    }
  } catch (e) { console.error("[god.frontend.tui/commands/devs.ts] " + ((e as any)?.message || e)); }
  return 0x0001; // 默认: xattr ON
}

function saveExpFlag(v: number) {
  try {
    const p = userFile("settings.json");
    const s = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    s.experimental = v;
    writeFileSync(p, JSON.stringify(s, null, 2));
  } catch (e) { console.error("[god.frontend.tui/commands/devs.ts] " + ((e as any)?.message || e)); }
}

// RESEARCH 管线开关（Proposals/032）：独立于 experimental 位，持久化 settings.json.research
function loadResearchFlag(): boolean {
  try {
    if (existsSync(userFile("settings.json"))) {
      const s = JSON.parse(readFileSync(userFile("settings.json"), "utf8"));
      if (typeof s.research === "boolean") return s.research;
    }
  } catch (e) { console.error("[god.frontend.tui/commands/devs.ts] " + ((e as any)?.message || e)); }
  return true; // 默认: RESEARCH logits 记录 ON
}

function saveResearchFlag(v: boolean) {
  try {
    const p = userFile("settings.json");
    const s = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    s.research = v;
    writeFileSync(p, JSON.stringify(s, null, 2));
  } catch (e) { console.error("[god.frontend.tui/commands/devs.ts] " + ((e as any)?.message || e)); }
}

export async function experimentalHandler(_args: any, ctx: any) {
  let expFlag = (globalThis as any).__genshinExperimental;
  if (expFlag === undefined || expFlag === null) {
    expFlag = loadExpFlag();
    (globalThis as any).__genshinExperimental = expFlag;
  }

  while (true) {
    const xattrOn = !!(expFlag & 0x0001);
    const researchOn = loadResearchFlag();
    const menu = [
      T(`xattr 文件元数据  ${xattrOn ? "开" : "关"}`, `xattr file metadata  ${xattrOn ? "on" : "off"}`),
      T(`RESEARCH logits 记录  ${researchOn ? "开" : "关"}`, `RESEARCH logits recording  ${researchOn ? "on" : "off"}`),
    ];
    const pick = await ctx.ui.select(T("实验性功能", "Experimental Features"), menu);
    if (!pick) return;

    if (pick.startsWith("xattr")) {
      const newFlag = xattrOn ? (expFlag & ~0x0001) : (expFlag | 0x0001);
      (globalThis as any).__genshinExperimental = newFlag;
      saveExpFlag(newFlag);
      expFlag = newFlag;
    } else if (pick.startsWith("RESEARCH")) {
      const nv = !researchOn;
      saveResearchFlag(nv);
      (globalThis as any).__genshinResearch = nv;
    }
  }
}
