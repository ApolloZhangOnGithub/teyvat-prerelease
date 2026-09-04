// 文档: B.docs/Dev.Common/Wiki/Hippocampus(Organ).WIKI
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync, statSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debug } from '#gene_riboswitch';
import { join } from "node:path";
import { homedir } from "node:os";
let _errorLogPath = join(homedir(), ".teyvat/LogData/unknown/error.log");
const _log = (code: string, e: unknown) => { try { const d = _errorLogPath.replace(/\/[^/]+$/, ""); if (!existsSync(d)) mkdirSync(d, { recursive: true }); appendFileSync(_errorLogPath, `[${new Date().toISOString()}] [hippocampus][${code}] ${e}\n`); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus.ts] " + ((e as any)?.message || e)); } };
function setErrorLog(personDir: string) { _errorLogPath = personDir.replace("/MemoryData/", "/ErrorData/") + "/error.log"; }
import { getPrompt } from "#kernel_ribosome";
import { personDir as getPersonDir } from "#paths";
import { sendCustomMessage } from "#kernel_backbone";

function hcFlag(personDir: string): string { return `${personDir}/hippocampus.json`; }
function hcDisabled(personDir: string): boolean {
  try { return !!JSON.parse(readFileSync(hcFlag(personDir), "utf8")).disabled; } catch { return false; }
}
function setHcDisabled(personDir: string, disabled: boolean): void {
  try { writeFileSync(hcFlag(personDir), JSON.stringify({ disabled, ts: new Date().toISOString() })); } catch (e) { _log("setHcDisabled", e); }
}

export interface HippocampusHandle {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  getSessionId(): string;
}

export function createHippocampus(
  pi: ExtensionAPI,
  onError: (msg: string) => void,
  personDir: string,
): HippocampusHandle {
  setErrorLog(personDir);
  const personId = personDir.match(/([a-f0-9]+)$/)?.[1] ?? "x";
  const tmuxName = `hc-${personId}`;
      const sessionDir = path.join(personDir, "..", "..", "SessionData", personId, "HippocampusSessions");
  let running = false;

  function tmuxHas(): boolean {
    try {
      execSync(`tmux has-session -t ${tmuxName} 2>/dev/null`);
      return true;
    } catch { return false; }
  }

  const self: HippocampusHandle = {
    async start() {
      running = true;

      await mkdir(sessionDir, { recursive: true });

      const convPath = `${sessionDir}/conv.json`;
      await writeFile(convPath, JSON.stringify([
        { role: "system", content: getPrompt("hippocampus.gen_work_mem") }
      ]));

      try { writeFileSync(`${personDir}/hc-offset`, String(statSync(`${personDir}/context.md`).size)); } catch (e) { _log("writeHcOffset", e); }

      const launchScript = `${personDir}/hippocampus-launch.sh`;
      const templatePath = fileURLToPath(new URL("./hippocampus-launcher.sh.template", import.meta.url));
      const script = readFileSync(templatePath, "utf8")
        .replaceAll("{{SESSION_DIR}}", sessionDir)
        .replaceAll("{{PERSON_DIR}}", personDir);
      await writeFile(launchScript, script);
      execSync(`chmod +x "${launchScript}"`, { stdio: "ignore" });

      try {
        try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus.ts] " + ((e as any)?.message || e)); }
        execSync(
          `tmux new-session -d -s ${tmuxName} -c "${personDir}" 'bash "${launchScript}"'`,
          { stdio: "ignore" }
        );
      } catch (err: any) {
        onError(`Hippocampus tmux spawn failed: ${err?.message ?? err}`);
        running = false;
      }
    },

    stop() {
      running = false;
      try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus.ts] " + ((e as any)?.message || e)); }
    },

    isRunning() { return tmuxHas(); },
    getSessionId() { return tmuxName; },
  };

  return self;
}

// [DISABLED 2026-08-15] 海马体后台编码进程已禁用，由 amem 工具替代主动记忆管理。
// export default function (pi: ExtensionAPI) {
//   if (process.env.PAIMON_NO_MC) return;
//   let handle: HippocampusHandle | null = null;
//   let personDir: string | null = null;
//   let hcDisabledNotified = false;
//
//   pi.on("session_start", async (_event, ctx) => {
//     const sf = ctx.sessionManager.getSessionFile();
//     personDir = getPersonDir(sf);
//     debug.log('D0400', `session_start: sf=${sf} personDir=${personDir} hcDisabled=${personDir?hcDisabled(personDir):'N/A'}`);
//     if (personDir && !hcDisabled(personDir)) {
//       handle = createHippocampus(
//         pi,
//         (msg) => sendCustomMessage(pi, "hippocampus-error", `WARN: Hippocampus error: ${msg}`),
//         personDir,
//       );
//       try { await handle.start(); (globalThis as any).__genshinHippocampusHandle = handle; } catch (e: any) {
//         try { sendCustomMessage(pi, "hippocampus-error", `WARN: 海马体启动异常（已隔离，不影响主意识）: ${e?.message ?? e}`); } catch (e2) { _log("sendHcError", e2); }
//       }
//     }
//   });
//
//   pi.on("session_shutdown", async () => {
//     handle?.stop();
//     handle = null;
//     personDir = null;
//   });
//
//   return [];
// }
export default function (_pi: ExtensionAPI) { return []; }
