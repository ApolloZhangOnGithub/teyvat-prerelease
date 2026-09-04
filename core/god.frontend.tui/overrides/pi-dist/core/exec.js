/**
 * Shared command execution utilities for extensions and custom tools.
 * teyvat: 缓冲上限防 RangeError 崩溃。
 */
import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.js";

// JS 字符串上限约 512MB，留余量
const MAX_BYTES = 100 * 1024 * 1024; // 100MB

export async function execCommand(command, args, cwd, options) {
    return new Promise((resolve) => {
        const proc = spawn(command, args, {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let stdoutFull = false;
        let killed = false;
        let timeoutId;
        const killProcess = () => {
            if (!killed) {
                killed = true;
                proc.kill("SIGTERM");
                setTimeout(() => {
                    if (!proc.killed) {
                        proc.kill("SIGKILL");
                    }
                }, 5000);
            }
        };
        if (options?.signal) {
            if (options.signal.aborted) {
                killProcess();
            }
            else {
                options.signal.addEventListener("abort", killProcess, { once: true });
            }
        }
        if (options?.timeout && options.timeout > 0) {
            timeoutId = setTimeout(() => {
                killProcess();
            }, options.timeout);
        }
        proc.stdout?.on("data", (data) => {
            if (stdoutFull) return;
            const chunk = data.toString();
            if (stdout.length + chunk.length > MAX_BYTES) {
                stdout += chunk.slice(0, MAX_BYTES - stdout.length);
                stdout += "\n\n[... stdout truncated at 100MB]";
                stdoutFull = true;
            } else {
                stdout += chunk;
            }
        });
        proc.stderr?.on("data", (data) => {
            const chunk = data.toString();
            if (stderr.length + chunk.length > MAX_BYTES) {
                if (!stderr.includes("[... stderr truncated")) {
                    stderr += chunk.slice(0, MAX_BYTES - stderr.length);
                    stderr += "\n\n[... stderr truncated at 100MB]";
                }
            } else {
                stderr += chunk;
            }
        });
        waitForChildProcess(proc)
            .then((code) => {
            if (timeoutId) clearTimeout(timeoutId);
            if (options?.signal) {
                options.signal.removeEventListener("abort", killProcess);
            }
            resolve({ stdout, stderr, code: code ?? 0, killed });
        })
            .catch((_err) => {
            if (timeoutId) clearTimeout(timeoutId);
            if (options?.signal) {
                options.signal.removeEventListener("abort", killProcess);
            }
            resolve({ stdout, stderr, code: 1, killed });
        });
    });
}
//# sourceMappingURL=exec.js.map