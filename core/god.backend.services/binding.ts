// 文档: B.docs/Dev.Common/Wiki/Services(God Level Support).WIKI
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const PAIMON = join(homedir(), ".teyvat");
const USER_ACCOUNT = join(PAIMON, "UserAccount");
const BINDING_FILE = join(USER_ACCOUNT, "binding.json");

export interface Binding {
  githubUserId: number;
  githubLogin: string;
  deviceId: string;
  boundAt: string;
  token: string;
}

export function getBinding(): Binding | null {
  try { return JSON.parse(readFileSync(BINDING_FILE, "utf8")); } catch { return null; }
}

export function saveBinding(b: Binding) {
  mkdirSync(USER_ACCOUNT, { recursive: true });
  writeFileSync(BINDING_FILE, JSON.stringify(b, null, 2));
}

export function clearBinding() {
  if (existsSync(BINDING_FILE)) writeFileSync(BINDING_FILE, "{}");
}

export function getOrCreateDeviceId(): string {
  const b = getBinding();
  if (b?.deviceId) return b.deviceId;
  return randomBytes(4).toString("hex");
}
