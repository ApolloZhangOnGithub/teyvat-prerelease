/**
 * Bash command execution with streaming support and cancellation.
 *
 * teyvat override（2026-09-16：ANSI 残渣根因修复——不是事后清洗）
 *
 * ── 根因 ──
 * pi 原实现 onData 逐 chunk 做：
 *   sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true })))
 * ANSI 序列（如 \x1b[38;5;222m）若跨 stdout chunk 边界被拆开，stripAnsi 匹配不到「不完整序列」
 * （ansi-regex 必须见到终止字节才匹配）→ 漏剥；紧接的 sanitizeBinaryOutput 又剥掉控制字符
 * \x1b(0x1b)，于是残留 `[38;5;222m` / `38;5;222m` 这类裸 SGR 参数碎片（「38;5 泄漏」）。
 * stdout 分块越小越易触发：WSL/conpty 分块小 → 只在 WSL 明显；macOS/Linux 常用整块到达 → 序列完整。
 *
 * ── 修复（用户定稿：清洗不对，会误伤代码里真实的 `38;5`）──
 * 不逐 chunk 各自 strip，而是把「末尾不完整 ANSI 序列」carry 到下一 chunk，凑成完整序列再剥——
 * 从 capture 层根除残渣：保留原始字节、只对完整序列正确剥离，不做无脑正则剥。
 * 流结束时 flush 残留 carry。
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.js";
import { sanitizeBinaryOutput } from "../utils/shell.js";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";
const ESC = "\u001b";
const BEL = "\u0007";
/**
 * 末尾「不完整 ANSI 序列」的长度（0 = 末尾不是不完整序列，可安全剥）。
 * 只回看最后一个 ESC，避免长输出 O(n²)。
 *  - CSI：ESC [ (中间字节*)(参数字节*)，尚未出现终止字节 → 不完整
 *  - OSC：ESC ] …，尚未以 BEL 或 ST(ESC\) 收尾 → 不完整
 */
function incompleteAnsiTailLen(s) {
    const i = s.lastIndexOf(ESC);
    if (i === -1)
        return 0;
    const tail = s.slice(i);
    // CSI 未终止：ESC 后只含「中间字节 + 参数字节」，一定还没到终止字节
    if (/^\u001b[[\]()#;?]*[0-9;:]*$/.test(tail))
        return tail.length;
    // OSC 未终止
    if (tail.startsWith(ESC + "]") && !tail.includes(BEL) && !tail.includes(ESC + "\\"))
        return tail.length;
    return 0;
}
/**
 * 逐 chunk 处理器：carry 不完整 ANSI 序列，凑完整再剥。
 * push(data) 返回本次可安全输出的文本；flush() 输出流结束时残留的 carry。
 */
function createAnsiSafeChunkProcessor() {
    const decoder = new TextDecoder();
    let carry = "";
    const emit = (raw) => raw ? sanitizeBinaryOutput(stripAnsi(raw)).replace(/\r/g, "") : "";
    return {
        push(data) {
            let raw = carry + decoder.decode(data, { stream: true });
            const cut = incompleteAnsiTailLen(raw);
            if (cut > 0) {
                carry = raw.slice(raw.length - cut);
                raw = raw.slice(0, raw.length - cut);
            }
            else {
                carry = "";
            }
            return emit(raw);
        },
        flush() {
            const raw = carry + decoder.decode();
            carry = "";
            return emit(raw);
        },
    };
}
/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(command, cwd, operations, options) {
    const outputChunks = [];
    let outputBytes = 0;
    const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
    let tempFilePath;
    let tempFileStream;
    let totalBytes = 0;
    const ensureTempFile = () => {
        if (tempFilePath) {
            return;
        }
        const id = randomBytes(8).toString("hex");
        tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
        tempFileStream = createWriteStream(tempFilePath);
        for (const chunk of outputChunks) {
            tempFileStream.write(chunk);
        }
    };
    const processor = createAnsiSafeChunkProcessor();
    const sink = (text) => {
        if (!text)
            return;
        if (tempFileStream) {
            tempFileStream.write(text);
        }
        outputChunks.push(text);
        outputBytes += text.length;
        while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
            const removed = outputChunks.shift();
            outputBytes -= removed.length;
        }
        if (options?.onChunk) {
            options.onChunk(text);
        }
    };
    const onData = (data) => {
        totalBytes += data.length;
        const text = processor.push(data);
        if (totalBytes > DEFAULT_MAX_BYTES) {
            ensureTempFile();
        }
        sink(text);
    };
    try {
        const result = await operations.exec(command, cwd, {
            onData,
            signal: options?.signal,
        });
        sink(processor.flush());
        const fullOutput = outputChunks.join("");
        const truncationResult = truncateTail(fullOutput);
        if (truncationResult.truncated) {
            ensureTempFile();
        }
        if (tempFileStream) {
            tempFileStream.end();
        }
        const cancelled = options?.signal?.aborted ?? false;
        return {
            output: truncationResult.truncated ? truncationResult.content : fullOutput,
            exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
            cancelled,
            truncated: truncationResult.truncated,
            fullOutputPath: tempFilePath,
        };
    }
    catch (err) {
        if (options?.signal?.aborted) {
            sink(processor.flush());
            const fullOutput = outputChunks.join("");
            const truncationResult = truncateTail(fullOutput);
            if (truncationResult.truncated) {
                ensureTempFile();
            }
            if (tempFileStream) {
                tempFileStream.end();
            }
            return {
                output: truncationResult.truncated ? truncationResult.content : fullOutput,
                exitCode: undefined,
                cancelled: true,
                truncated: truncationResult.truncated,
                fullOutputPath: tempFilePath,
            };
        }
        if (tempFileStream) {
            tempFileStream.end();
        }
        throw err;
    }
}
