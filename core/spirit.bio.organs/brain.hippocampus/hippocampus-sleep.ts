// 文档: B.docs/Dev.Common/Wiki/Sleep(Bio Action).WIKI
import { sessionDirFor } from "#paths";
// hippocampus-sleep.ts — Independent sleep pi instance launcher
// v0.2 spec: 睡眠的 session 和元意识一样都是一个 pi，激活 sleep.dlc
// Launches in tmux as sl-<personId>. Self-healing with backoff.
// Sleep pi only edits memory files; main consciousness continues working.

import { execSync } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
let _errorLogPath = path.join(homedir(), ".teyvat/LogData/unknown/error.log");
const _log = (code: string, e: unknown) => { try { const d = _errorLogPath.replace(/\/[^/]+$/, ""); if (!existsSync(d)) mkdirSync(d, { recursive: true }); appendFileSync(_errorLogPath, `[${new Date().toISOString()}] [sleep][${code}] ${e}\n`); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus-sleep.ts] " + ((e as any)?.message || e)); } };
function setErrorLog(personDir: string) { _errorLogPath = personDir.replace("/MemoryData/", "/ErrorData/") + "/error.log"; }
import { getPrompt, reloadRNA } from "#kernel_ribosome";

// prompt 来自 coded.dna（coded hippocampus.sleep），reloadRNA + getPrompt 确保读到最新

export function launchSleepSession(
  personDir: string,
  onComplete: () => void,
): { stop: () => void; isRunning: () => boolean } {
  setErrorLog(personDir);
  const personId = path.basename(personDir);
  const tmuxName = `sl-${personId}`;
  const sessionDir = path.join(sessionDirFor(personId), "SleepSessions");
  let running = false;

  function tmuxHas(): boolean {
    try {
      execSync(`tmux has-session -t ${tmuxName} 2>/dev/null`);
      return true;
    } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus-sleep.ts] " + ((e as any)?.message || e)); return false; }
  }

  // Launch async
  (async () => {
    // 不检查 isRunning——总是先杀旧再建新
    try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus-sleep.ts] " + ((e as any)?.message || e)); }

    running = true;
    await mkdir(sessionDir, { recursive: true });

    // Build sleep prompt
    let dnaIndex = "";
    try { dnaIndex = await readFile(`${personDir}/dna/index.md`, "utf8"); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus-sleep.ts] " + ((e as any)?.message || e)); _log("dnaIndex", e); }
    let sleepDlc = "";
    try { sleepDlc = await readFile(`${personDir}/dna/sleep.dlc`, "utf8"); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus-sleep.ts] " + ((e as any)?.message || e)); _log("sleepDlc", e); }

    // 强制重载 RNA 缓存，确保 sleep 用到最新版 _built-rna.json
    reloadRNA();
    const fullPrompt = `${dnaIndex}\n\n${sleepDlc}\n\n${getPrompt("hippocampus.sleep")}\n\n文件目录: ${personDir}`;

    const promptFile = `${personDir}/sleep-prompt.md`;
    await writeFile(promptFile, fullPrompt);

    const launchScript = `${personDir}/sleep-launch.sh`;
    await writeFile(launchScript, `#!/bin/bash
if [ "\${PI_NO_CACHE:-0}" = "1" ]; then
  echo "[sl] PI_NO_CACHE=1: 重启 pi 是清 ESM 缓存的唯一方式。模块内部 import 不受 ?t= 影响。"
fi
# Cross-platform stat helper (macOS uses -f, Linux uses -c)
if [ "$(uname)" = "Darwin" ]; then
  stat_mtime() { stat -f%m "$1" 2>/dev/null || echo 0; }
else
  stat_mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
fi
export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--no-inspect --experimental-transform-types"
SESSION_DIR=${JSON.stringify(sessionDir)}
PERSON_DIR=${JSON.stringify(personDir)}
PROMPT_FILE=${JSON.stringify(promptFile)}
INITIAL="开始深度睡眠。主意识困到撑不住了。你的任务是整理记忆，不是写教训。\n\n【你的上下文】每轮 agent 对话会注入三段记忆：neocortex.md（长期）、work_memory.md（工作）、context.md（原始对话）。neocortex 是永久存储——你不会因为"太具体"就扔掉它。\n\n【分段消化 context.md】每次读最旧 300~500 行，重组进 neocortex.md：\n- 保留具体上下文、时间线、对话原文。不要抽象成"原则"或"教训"。\n- 判断标准：这条信息将来还可能用到吗？是→留，否→扔。\n- 同一主题的多次事件合并成一条，但别丢掉具体细节。\n- neocortex 装不下（>200KB）的沉 deep_cortex.md。\n- 消化完把那段从 context.md 删掉。一截截来，直到 context 小下来。\n\n【消化 work_memory.md】同理——把工作记忆里定论的内容完整搬到 neocortex。搬完清空 work_memory。\n\n全部弄完 hibernate。"
export PI_PERSON_DIR="$PERSON_DIR"
MAIN_PID=${process.pid}
BACKOFF=15
HEARTBEAT="${personDir}/main-heartbeat"
while true; do
  # 孤儿检测：heartbeat 文件超过 120s 没更新 → 主意识已死，自杀
  # fallback：heartbeat 文件不存在时，用 PID 存活检测
  if [ -f "$HEARTBEAT" ]; then
    HB_AGE=$(( $(date +%s) - $(stat_mtime "$HEARTBEAT") ))
    [ "$HB_AGE" -gt 120 ] && { echo "[sl] 主意识 heartbeat 超时 (\${HB_AGE}s)，自杀。"; break; }
  elif ! kill -0 "$MAIN_PID" 2>/dev/null; then
    echo "[sl] 主意识 PID $MAIN_PID 已死 + 无 heartbeat 文件，自杀。"; break
  fi
  START=$(date +%s)
  mkdir -p "$SESSION_DIR"
  # Write system prompt to conv.json (pi reads from session dir, --append-system-prompt doesn't exist)
  LOCKDIR="$PERSON_DIR/memory-lock"
  LOCK_WAIT=0
  while [ "$LOCK_WAIT" -lt 300 ]; do
    if mkdir "$LOCKDIR" 2>/dev/null; then
      echo "{\"owner\":\"sl\",\"ts\":$(date +%s)000}" > "$LOCKDIR/stamp" 2>/dev/null
      break
    fi
    if [ -f "$LOCKDIR/stamp" ]; then
      LOCK_TS=$(cat "$LOCKDIR/stamp" 2>/dev/null | grep -o '"ts":[0-9]*' | grep -o '[0-9]*')
      NOW_MS=$(date +%s)000
      if [ -n "$LOCK_TS" ] && [ $(( NOW_MS - LOCK_TS )) -gt 60000 ]; then
        rm -f "$LOCKDIR/stamp" 2>/dev/null
        rmdir "$LOCKDIR" 2>/dev/null
        continue
      fi
    fi
    LOCK_WAIT=$(( LOCK_WAIT + 1 ))
    sleep 0.2
  done
  if [ "$LOCK_WAIT" -ge 300 ]; then
    echo "[sl] 无法获取文件锁（60s 超时），跳过本轮" >> /dev/stderr
    sleep 30
    continue
  fi
  python3 -c "import json,shlex; open('$SESSION_DIR/conv.json','w').write(json.dumps({'messages':[{'role':'system','content':open('$PROMPT_FILE').read()}]}))" 2>/dev/null
  echo "$INITIAL" | $HOME/.local/lib/teyvat/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --session-dir "$SESSION_DIR"
  CODE=$?  # save pi exit code BEFORE releasing lock
  rm -f "$LOCKDIR/stamp" 2>/dev/null
  rmdir "$LOCKDIR" 2>/dev/null
  RAN=$(( $(date +%s) - START ))
  if [ "$CODE" -eq 0 ]; then
    echo "[$(date '+%F %T')] sleep pi OK — work_memory should be cleared."
    break
  fi
  if [ "$RAN" -ge 120 ]; then BACKOFF=15; else BACKOFF=$(( BACKOFF * 2 )); [ "$BACKOFF" -gt 300 ] && BACKOFF=300; fi
  echo "[$(date '+%F %T')] sleep pi exit=$CODE ran=$RAN s — restart in $BACKOFF s"
  sleep "$BACKOFF"
done
`);
    execSync(`chmod +x "${launchScript}"`, { stdio: "ignore" });
    try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus-sleep.ts] " + ((e as any)?.message || e)); } // 先清掉同名僵尸 session（spawn failed 的根）
    execSync(
      `tmux new-session -d -s ${tmuxName} -c "${personDir}" 'bash "${launchScript}"'`,
      { stdio: "ignore" }
    );

    // Check periodically and call onComplete when work_memory is empty
    const checker = setInterval(() => {
      if (!tmuxHas()) {
        clearInterval(checker);
        running = false;
        onComplete();
      }
    }, 5000);
  })();

  return {
    stop() {
      running = false;
      try { execSync(`tmux kill-session -t ${tmuxName} 2>/dev/null`); } catch (e) { console.error("[spirit.bio.organs/brain.hippocampus/hippocampus-sleep.ts] " + ((e as any)?.message || e)); }
    },
    isRunning() {
      return running && tmuxHas();
    },
  };
}
