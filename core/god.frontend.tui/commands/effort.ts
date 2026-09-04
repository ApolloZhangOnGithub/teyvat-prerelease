// god.frontend.tui/commands/effort.ts
// /e 命令 — DeepSeek effort: max/pi=high, high/pi=medium, low/pi=low
import { i18n } from "#tui_localizations";

const MAP: [string, string][] = [
  ["max", "high"],
  ["high", "medium"],
  ["low", "low"],
];

export async function effortHandler(_args: any, ctx: any) {
  const setThinking = (globalThis as any).__genshinSetThinkingLevel;
  if (!setThinking) { ctx.ui.notify(i18n("session 未就绪", "session not ready"), "error"); return; }

  const curPi = ((globalThis as any).__genshinGetThinkingLevel?.()) || "high";
  const curDs = MAP.find(([, pi]) => pi === curPi)?.[0] || "max";

  const options = MAP.map(([ds]) => {
    const prefix = curDs === ds ? "● " : "  ";
    return `${prefix}${ds}`;
  });

  const choice = await ctx.ui.select("Effort", options);
  if (!choice) return;

  const idx = options.indexOf(choice);
  if (idx < 0) return;
  const [, piLevel] = MAP[idx];
  if (MAP[idx][0] === curDs) return;

  setThinking(piLevel);
  ctx.ui.notify(`Effort: ${MAP[idx][0]}`, "info");
}
