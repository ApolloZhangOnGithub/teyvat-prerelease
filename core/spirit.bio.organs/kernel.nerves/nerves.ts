// kernel.nerves/nerves — 神经系统：异步信号传导
// organ 产生信号（记忆、意识流、事件），nerves 负责异步传到目的地（磁盘），不阻塞 organ。
// 用法：import { appendAsync } from "#kernel_nerves";

import { createWriteStream, statSync, mkdirSync, existsSync, renameSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";

interface StreamEntry {
  stream: WriteStream;
  bytes: number;
  maxBytes: number;
  errCount: number;
}

const pool = new Map<string, StreamEntry>();

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB 轮转阈值

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function openStream(path: string): WriteStream {
  ensureDir(path);
  return createWriteStream(path, { flags: "a", highWaterMark: 64 * 1024 });
}

function getEntry(path: string, maxBytes?: number): StreamEntry {
  let entry = pool.get(path);
  if (entry) return entry;

  let currentSize = 0;
  try { currentSize = statSync(path).size; } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }

  const stream = openStream(path);
  entry = {
    stream,
    bytes: currentSize,
    maxBytes: maxBytes ?? DEFAULT_MAX_BYTES,
    errCount: 0,
  };

  stream.on("error", () => {
    entry!.errCount++;
    if (entry!.errCount > 5) {
      pool.delete(path);
      try { stream.destroy(); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
    }
  });

  pool.set(path, entry);
  return entry;
}

function rotate(path: string, entry: StreamEntry): void {
  try { entry.stream.end(); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
  try { renameSync(path, path + ".1"); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
  const newStream = openStream(path);
  entry.stream = newStream;
  entry.bytes = 0;
  entry.errCount = 0;
  newStream.on("error", () => {
    entry.errCount++;
    if (entry.errCount > 5) {
      pool.delete(path);
      try { newStream.destroy(); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
    }
  });
}

export function appendAsync(path: string, text: string, maxBytes?: number): void {
  const entry = getEntry(path, maxBytes);
  if (entry.bytes > entry.maxBytes) {
    rotate(path, entry);
  }
  entry.stream.write(text);
  entry.bytes += Buffer.byteLength(text);
}

export function bytesWritten(path: string): number {
  return pool.get(path)?.bytes ?? 0;
}

export function closeWriter(path: string): void {
  const entry = pool.get(path);
  if (entry) {
    try { entry.stream.end(); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
    pool.delete(path);
  }
}

export function closeAll(): void {
  for (const [, entry] of pool) {
    try { entry.stream.end(); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
  }
  pool.clear();
}

process.on("exit", closeAll);
