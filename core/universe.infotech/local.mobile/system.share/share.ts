// system.share/share.ts — iOS 风格两级分享
// 1. 选 App (WeChat/...)  →  2. 选目的地 (朋友圈/聊天/...)

export interface ShareTarget {
  name: string;            // e.g. "朋友圈"
  handler: (content: string, personDir: string) => string;
}
const appTargets = new Map<string, ShareTarget[]>(); // appName → targets

export function registerShareTarget(app: string, t: ShareTarget) {
  if (!appTargets.has(app)) appTargets.set(app, []);
  appTargets.get(app)!.push(t);
}

/** Step 1: show available apps */
export function shareApps(): string {
  const apps = [...appTargets.keys()];
  if (!apps.length) return "没有可用的分享目标。";
  const lines = ["--- 分享到 ---", ""];
  for (let i = 0; i < apps.length; i++) lines.push(`  ${i + 1}. ${apps[i]}`);
  lines.push("", "输入序号选择 App");
  return lines.join("\n");
}

/** Step 2: show destinations within the selected app */
export function shareDestinations(appIndex: number): { app: string; screen: string } | null {
  const apps = [...appTargets.keys()];
  const app = apps[appIndex - 1];
  if (!app) return null;
  const ts = appTargets.get(app) || [];
  const lines = [`--- 分享到 ${app} ---`, ""];
  for (let i = 0; i < ts.length; i++) lines.push(`  ${i + 1}. ${ts[i].name}`);
  lines.push("", "输入序号选择目的地");
  return { app, screen: lines.join("\n") };
}

/** Step 3: execute share */
export function shareTo(appIndex: number, destIndex: number, content: string, personDir: string): string {
  const apps = [...appTargets.keys()];
  const app = apps[appIndex - 1];
  if (!app) return "无效的 App 序号。";
  const ts = appTargets.get(app) || [];
  const t = ts[destIndex - 1];
  if (!t) return "无效的目的地序号。";
  return t.handler(content, personDir);
}
