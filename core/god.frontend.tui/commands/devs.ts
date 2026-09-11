// devs.ts — /experimental 命令
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
  return 0x0001;
}

function saveExpFlag(v: number) {
  try {
    const p = userFile("settings.json");
    const s = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    s.experimental = v;
    writeFileSync(p, JSON.stringify(s, null, 2));
  } catch (e) { console.error("[god.frontend.tui/commands/devs.ts] " + ((e as any)?.message || e)); }
}

function loadResearchFlag(): boolean {
  try {
    if (existsSync(userFile("settings.json"))) {
      const s = JSON.parse(readFileSync(userFile("settings.json"), "utf8"));
      if (typeof s.research === "boolean") return s.research;
    }
  } catch (e) { console.error("[god.frontend.tui/commands/devs.ts] " + ((e as any)?.message || e)); }
  return true;
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

  const showSettingsList = (globalThis as any).__genshinShowSettingsList;
  if (showSettingsList) {
    const getItems = () => {
      const xattrOn = !!(expFlag & 0x0001);
      const researchOn = loadResearchFlag();
      return [
        { id: "xattr", label: T("xattr 文件元数据", "xattr file metadata"), currentValue: xattrOn ? T("开", "On") : T("关", "Off"), values: [T("关", "Off"), T("开", "On")] },
        { id: "research", label: T("RESEARCH logits 记录", "RESEARCH logits recording"), currentValue: researchOn ? T("开", "On") : T("关", "Off"), values: [T("关", "Off"), T("开", "On")] },
      ];
    };
    await showSettingsList(T("实验性功能", "Experimental"), getItems, (id: string, value: string) => {
      const on = value === T("开", "On");
      if (id === "xattr") {
        expFlag = on ? (expFlag | 0x0001) : (expFlag & ~0x0001);
        (globalThis as any).__genshinExperimental = expFlag;
        saveExpFlag(expFlag);
      } else if (id === "research") {
        saveResearchFlag(on);
        (globalThis as any).__genshinResearch = on;
      }
    });
  } else {
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
        expFlag = xattrOn ? (expFlag & ~0x0001) : (expFlag | 0x0001);
        (globalThis as any).__genshinExperimental = expFlag;
        saveExpFlag(expFlag);
      } else if (pick.startsWith("RESEARCH")) {
        saveResearchFlag(!researchOn);
        (globalThis as any).__genshinResearch = !researchOn;
      }
    }
  }
}
