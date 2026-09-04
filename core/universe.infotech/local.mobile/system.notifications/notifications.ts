// system.notifications/notifications.ts — 手机统一通知管线
// 任何 app 调 schedule/push，kernel 到时间自动 steer 打断主意识

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logerr } from "#paths";
import { sendCustomMessage } from "#kernel_backbone";

interface Notification {
  id: string;
  app: string;
  title: string;
  body: string;
  ts: number;
}

interface ScheduledNotification extends Notification {
  fireAt: number;
  timer: ReturnType<typeof setTimeout>;
}

let pi: ExtensionAPI | null = null;
const pending: Notification[] = [];
const scheduled: Map<string, ScheduledNotification> = new Map();
let idCounter = 0;

export function initNotifications(piInstance: ExtensionAPI) {
  pi = piInstance;
}

// 立即推送——steer 打断主意识
export function push(app: string, title: string, body: string) {
  const n: Notification = { id: `notif-${++idCounter}`, app, title, body, ts: Date.now() };
  pending.push(n);
  if (pending.length > 100) pending.shift();

  if (!pi) return;
  try {
    sendCustomMessage(pi, "mobile-notification", `${app}: ${title}\n${body}`);
  } catch (e) { console.error("[universe.infotech/local.mobile/system.notifications/notifications.ts] " + ((e as any)?.message || e)); }
}

// 定时推送——到时间自动 steer
export function schedule(app: string, title: string, body: string, delayMs: number): string {
  const id = `sched-${++idCounter}`;
  const fireAt = Date.now() + delayMs;

  const timer = setTimeout(() => {
    scheduled.delete(id);
    push(app, title, body);
  }, delayMs);

  scheduled.set(id, { id, app, title, body, ts: Date.now(), fireAt, timer });
  return id;
}

// 取消定时推送
export function cancel(id: string): boolean {
  const s = scheduled.get(id);
  if (!s) return false;
  clearTimeout(s.timer);
  scheduled.delete(id);
  return true;
}

// 查看未读通知
export function getNotifications(limit: number = 20): Notification[] {
  return pending.slice(-limit);
}

// 查看等待中的定时通知
export function getScheduled(): { id: string; app: string; title: string; fireAt: number }[] {
  return [...scheduled.values()].map(s => ({
    id: s.id, app: s.app, title: s.title, fireAt: s.fireAt,
  }));
}

// 清除所有通知
export function clearNotifications() {
  pending.length = 0;
}

// 清除所有定时
export function clearAllScheduled() {
  for (const s of scheduled.values()) clearTimeout(s.timer);
  scheduled.clear();
}

// 独立可用（不需要 genshin 内核）：检查 message-service 未读消息
export async function checkUnreadMessages(agentId?: string): Promise<{count: number, last?: {from: string, text: string}} | null> {
  const me = agentId || process.env.PAIMON_AGENT_NAME || "unknown";
  const server = process.env.MSG_SERVER || "http://127.0.0.1:9224";
  try {
    const r = await fetch(server, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "inbox", agent_id: me }),
      signal: AbortSignal.timeout(2000),
    });
    const data = await r.json();
    const unread = (data.messages || []).filter((m: any) => !m.read);
    if (!unread.length) return { count: 0 };
    const last = unread[unread.length - 1];
    return { count: unread.length, last: { from: last.from, text: last.text } };
  } catch { return null; }
}
