// god.frontend.tui/commands/effort.ts
import { i18n } from "#tui_localizations";

const MAP: [string, string][] = [
  ["max", "high"],
  ["high", "medium"],
  ["low", "low"],
];

export async function effortHandler(_args: any, ctx: any) {
  const setThinking = (globalThis as any).__genshinSetThinkingLevel;
  if (!setThinking) { ctx.ui.notify(i18n("session 未就绪", "session not ready"), "error"); return; }

  const showSettingsList = (globalThis as any).__genshinShowSettingsList;
  const curPi = ((globalThis as any).__genshinGetThinkingLevel?.()) || "high";
  const curDs = MAP.find(([, pi]) => pi === curPi)?.[0] || "max";

  if (showSettingsList) {
    const getItems = () => [
      { id: "effort", label: "Effort", currentValue: curDs, values: MAP.map(([ds]) => ds) },
    ];
    await showSettingsList("Effort", getItems, (id: string, value: string) => {
      const entry = MAP.find(([ds]) => ds === value);
      if (entry) setThinking(entry[1]);
    });
  } else {
    const options = MAP.map(([ds]) => `${curDs === ds ? "● " : "  "}${ds}`);
    const choice = await ctx.ui.select("Effort", options);
    if (!choice) return;
    const idx = options.indexOf(choice);
    if (idx < 0) return;
    setThinking(MAP[idx][1]);
  }
}
