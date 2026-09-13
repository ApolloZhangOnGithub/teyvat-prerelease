// kernel.nerves/nerves — 神经系统：异步信号传导
// organ 产生信号（记忆、意识流、事件），nerves 负责异步传到目的地（磁盘），不阻塞 organ。
// 用法：import { appendAsync } from "#kernel_nerves";

import { createWriteStream, statSync, mkdirSync, existsSync, renameSync, appendFileSync } from "node:fs";
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
  try { currentSize = statSync(path).size; } catch (e) {
    // 2026-09-05：新日志文件首次 append 时文件尚未创建 → stat ENOENT 是正常场景（size=0），静默；其他错误才打日志
    if ((e as any)?.code !== "ENOENT") console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e));
  }

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
  const oldStream = entry.stream;
  // 2026-09-13（审计）：.rotating 用 "w"——崩溃残留的 .rotating 若用 "a" 打开，旧数据会被拼在新数据前面再换回正式路径
  ensureDir(path);
  const newStream = createWriteStream(path + ".rotating", { flags: "w", highWaterMark: 64 * 1024 });
  // Swap immediately so new writes go to the temp file; rename old+new after old flushes.
  let swapped = false;
  const swap = () => {
    if (swapped) return; swapped = true;
    // 2026-09-13（审计 HIGH）：原来 rename(path → .1) 直接覆盖上一代 .1——每次轮转永久丢一代。现在保留两代（.1 → .2，再 path → .1）。
    try { if (existsSync(path + ".1")) renameSync(path + ".1", path + ".2"); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
    try { renameSync(path, path + ".1"); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
    try { renameSync(path + ".rotating", path); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
  };
  try {
    oldStream.end(swap);
    // 旧流早已出错时 end 回调永远不来 → 写入永远留在 .rotating；5s 兜底换回
    setTimeout(swap, 5000).unref?.();
  } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); swap(); }
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

// 2026-09-13（审计）：process.exit 是同步的，stream.end() 冲不出还排在队列里的块——重启/崩溃时最后几行（memory.ts 记过 11 分钟对话丢失）就没了。
// 退出时把每个流尚未写出的缓冲块用同步 append 落盘，再销毁流（避免重复写）。正在写的那一块不在 writableBuffer 里，不会写两遍。
export function flushAllSync(): void {
  for (const [path, entry] of pool) {
    try {
      const buf = (entry.stream as any).writableBuffer as Array<{ chunk: any; encoding?: string }> | undefined;
      if (Array.isArray(buf) && buf.length) {
        for (const b of buf) { try { appendFileSync(path, b.chunk, (b.encoding as any) || "utf8"); } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] flush " + path + ": " + ((e as any)?.message || e)); } }
      }
      entry.stream.destroy();
    } catch (e) { console.error("[spirit.bio.organs/kernel.nerves/nerves.ts] " + ((e as any)?.message || e)); }
  }
  pool.clear();
}

process.on("exit", flushAllSync);
