/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { parseArgs, printHelp } from "./cli/args.js";
import { processFileArguments } from "./cli/file-processor.js";
import { buildInitialMessage } from "./cli/initial-message.js";
import { listModels } from "./cli/list-models.js";
import { createProjectTrustContext } from "./cli/project-trust.js";
import { selectSession } from "./cli/session-picker.js";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.js";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.js";
import { createAgentSessionRuntime } from "./core/agent-session-runtime.js";
import { createAgentSessionFromServices, createAgentSessionServices, } from "./core/agent-session-services.js";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.js";
import { resolveCliModel, resolveModelScope } from "./core/model-resolver.js";
import { restoreStdout, takeOverStdout } from "./core/output-guard.js";
import { resolveProjectTrusted } from "./core/project-trust.js";
import { formatMissingSessionCwdPrompt, getMissingSessionCwdIssue, MissingSessionCwdError, } from "./core/session-cwd.js";
import { assertValidSessionId, SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, resetTimings, time } from "./core/timings.js";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.js";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.js";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.js";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.js";
// ── EPIPE 兜底（2026-08-20，frontierLM 转交的闪退 BUG）────────────────────────
// stdout/stderr 管道对端关闭（用户关终端 / blackbox 的 pty 死亡 / tmux pane 关闭）后，
// 任何写 stdout 都抛 write EPIPE：若发生在 core.ts 注册 uncaughtException 之前（启动早期）
// 会直接闪退（crash.log 都来不及记）。这里在最早处挂 error 监听吞掉 EPIPE——
// agent 转为无渲染继续工作（符合"内核常驻"愿景）；运行期其余 EPIPE 由 core.ts 兜底。
for (const _s of [process.stdout, process.stderr]) {
  _s.on("error", (err) => {
    if (err && (err.code === "EPIPE" || err.code === "EIO" || err.code === "EAGAIN")) return; // 静默：对端已关 / pty 已收 / 管道满，渲染不可达，内核继续跑
    // 2026-09-14：其余错误记日志但不 throw——throw 会变成 uncaughtException 在关机途中杀掉 agent（原意只是"别悄悄吞"）
    try { require("fs").appendFileSync((process.env.HOME || "") + "/.teyvat/LogData/genshin-catch-errors.log", "[main.js stdio error] " + (err && err.stack || err) + "\n"); } catch (e) { /* 日志写不了就算了 */ }
  });
}
const EXTENSION_LOAD_FAILURE_HINT = 'Hint: Start without extensions using "pi -ne".';
/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin() {
    // If stdin is a TTY, we're running interactively - don't read stdin
    if (process.stdin.isTTY) {
        return undefined;
    }
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => {
            resolve(data.trim() || undefined);
        });
        process.stdin.resume();
    });
}
function collectSettingsDiagnostics(settingsManager, context) {
    return settingsManager.drainErrors().map(({ scope, error }) => ({
        type: "warning",
        message: `(${context}, ${scope} settings) ${error.message}`,
    }));
}
function reportDiagnostics(diagnostics) {
    for (const diagnostic of diagnostics) {
        const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
        const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
        console.error(color(`${prefix}${diagnostic.message}`));
    }
}
function isTruthyEnvFlag(value) {
    if (!value)
        return false;
    return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
function resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY) {
    if (parsed.mode === "rpc") {
        return "rpc";
    }
    if (parsed.mode === "json") {
        return "json";
    }
    if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
        return "print";
    }
    return "interactive";
}
function toPrintOutputMode(appMode) {
    return appMode === "json" ? "json" : "text";
}
function isPlainRuntimeMetadataCommand(parsed) {
    return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}
async function prepareInitialMessage(parsed, autoResizeImages, stdinContent) {
    if (parsed.fileArgs.length === 0) {
        return buildInitialMessage({ parsed, stdinContent });
    }
    const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
    return buildInitialMessage({
        parsed,
        fileText: text,
        fileImages: images,
        stdinContent,
    });
}
/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function findLocalSessionByExactId(sessionId, cwd, sessionDir) {
    const localSessions = await SessionManager.list(cwd, sessionDir);
    const localMatch = localSessions.find((s) => s.id === sessionId);
    return localMatch ? { type: "local", path: localMatch.path } : undefined;
}
async function resolveSessionPath(sessionArg, cwd, sessionDir) {
    // If it looks like a file path, resolve it before handing it to the session manager.
    if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
        return { type: "path", path: resolvePath(sessionArg, cwd) };
    }
    // Try to match as session ID in current project first
    const localSessions = await SessionManager.list(cwd, sessionDir);
    const localMatch = localSessions.find((s) => s.id === sessionArg) ?? localSessions.find((s) => s.id.startsWith(sessionArg));
    if (localMatch) {
        return { type: "local", path: localMatch.path };
    }
    // Try global search across all projects
    const allSessions = await SessionManager.listAll(sessionDir);
    const globalMatch = allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));
    if (globalMatch) {
        return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
    }
    // Not found anywhere
    return { type: "not_found", arg: sessionArg };
}
/** Prompt user for yes/no confirmation */
async function promptConfirm(message) {
    return new Promise((resolve) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(`${message} [y/N] `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
        });
    });
}
function validateForkFlags(parsed) {
    if (!parsed.fork)
        return;
    const conflictingFlags = [
        parsed.session ? "--session" : undefined,
        parsed.continue ? "--continue" : undefined,
        parsed.resume ? "--resume" : undefined,
        parsed.noSession ? "--no-session" : undefined,
    ].filter((flag) => flag !== undefined);
    if (conflictingFlags.length > 0) {
        console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
        process.exit(1);
    }
}
function validateSessionIdFlags(parsed) {
    if (parsed.sessionId === undefined)
        return;
    const conflictingFlags = [
        parsed.session ? "--session" : undefined,
        parsed.continue ? "--continue" : undefined,
        parsed.resume ? "--resume" : undefined,
    ].filter((flag) => flag !== undefined);
    if (conflictingFlags.length > 0) {
        console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
        process.exit(1);
    }
    try {
        assertValidSessionId(parsed.sessionId);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
    }
}
function openSessionOrExit(path, sessionDir) {
    try {
        return SessionManager.open(path, sessionDir);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
    }
}
function forkSessionOrExit(sourcePath, cwd, sessionDir, sessionId) {
    try {
        return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
    }
}
async function createSessionManager(parsed, cwd, sessionDir, settingsManager) {
    if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
        return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
    }
    if (parsed.fork) {
        if (parsed.sessionId) {
            const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
            if (existingTarget) {
                console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
                process.exit(1);
            }
        }
        const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);
        switch (resolved.type) {
            case "path":
            case "local":
            case "global":
                return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);
            case "not_found":
                console.error(chalk.red(`No session found matching '${resolved.arg}'`));
                process.exit(1);
        }
    }
    if (parsed.session) {
        const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);
        switch (resolved.type) {
            case "path":
            case "local":
                return openSessionOrExit(resolved.path, sessionDir);
            case "global": {
                console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
                const shouldFork = await promptConfirm("Fork this session into current directory?");
                if (!shouldFork) {
                    console.log(chalk.dim("Aborted."));
                    process.exit(0);
                }
                return forkSessionOrExit(resolved.path, cwd, sessionDir);
            }
            case "not_found":
                console.error(chalk.red(`No session found matching '${resolved.arg}'`));
                process.exit(1);
        }
    }
    if (parsed.resume) {
        try {
            const selectedPath = await selectSession((onProgress) => SessionManager.list(cwd, sessionDir, onProgress), (onProgress) => SessionManager.listAll(sessionDir, onProgress), settingsManager);
            if (!selectedPath) {
                console.log(chalk.dim("No session selected"));
                process.exit(0);
            }
            return SessionManager.open(selectedPath, sessionDir);
        }
        finally {
            stopThemeWatcher();
        }
    }
    if (parsed.continue) {
        return SessionManager.continueRecent(cwd, sessionDir);
    }
    if (parsed.sessionId) {
        const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
        if (existingSession) {
            return SessionManager.open(existingSession.path, sessionDir);
        }
        console.error(chalk.yellow(`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`));
    }
    return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}
// 2026-09-16 用户：禁用垃圾管线——宽容匹配/自动纠 id 是静默兑底（掩盖 id 写错），逐行注释不删。恢复精确 find，写错 id 就报错。
// function _resolveModelTolerant(modelRegistry, provider, id) {
//     if (!id) return undefined;
//     const direct = provider ? modelRegistry.find(provider, id) : undefined;
//     if (direct) return direct;
//     const pool = modelRegistry.models || modelRegistry.getAvailable?.() || [];
//     let m = pool.find((x) => x.id === id);
//     if (m) return m;
//     const fuzzy = pool.filter((x) => x.id.endsWith(id) || id.endsWith(x.id) || (id.includes("flash") && x.id.includes("flash")));
//     if (fuzzy.length) {
//         console.warn(chalk.yellow(`⚠️ 模型 id "${id}" 未精确匹配，已模糊匹配到 "${fuzzy[0].id}"。候选: ${fuzzy.slice(0, 3).map((x) => x.id).join(", ")}`));
//         return fuzzy[0];
//     }
//     return undefined;
// }
function buildSessionOptions(parsed, scopedModels, sessionContext, modelRegistry, settingsManager) {
    const options = {};
    const diagnostics = [];
    let cliThinkingFromModel = false;
    // 2026-09-22（用户：需要唯一真相的改好）：会话上下文只当"记录"读。
    // pi 会把本会话最后一次 model_change 放在 sessionContext.model（session-manager 的 getSessionContextSettings）——
    // 它是"那时用过什么"，**不是**决策源；决策只走下面的配置链（CLI → per-agent → settings 默认 → scoped[0]）。
    const sessionModel = sessionContext?.model ?? null;
    // Model from CLI
    // - supports --provider <name> --model <pattern>
    // - supports --model <provider>/<pattern>
    if (parsed.model) {
        const resolved = resolveCliModel({
            cliProvider: parsed.provider,
            cliModel: parsed.model,
            cliThinking: parsed.thinking,
            modelRegistry,
        });
        if (resolved.warning) {
            diagnostics.push({ type: "warning", message: resolved.warning });
        }
        if (resolved.error) {
            diagnostics.push({ type: "error", message: resolved.error });
        }
        if (resolved.model) {
            options.model = resolved.model;
            // Allow "--model <pattern>:<thinking>" as a shorthand.
            // Explicit --thinking still takes precedence (applied later).
            if (!parsed.thinking && resolved.thinkingLevel) {
                options.thinkingLevel = resolved.thinkingLevel;
                cliThinkingFromModel = true;
            }
        }
    }
    // 2026-08-18 per-agent 模型记忆（用户要求：模型切换必须 per-agent，不能写共享 settings）。
    // 2026-09-16 迁到 config/individual/<sid>/model.json（不混 social registry）。
    // 只读 config/individual，不 fallback（用户定稿：不要各种 fallback——判定严格、信息说清楚，不靠兜底掩盖）。
    if (!options.model) {
      try {
        const myId = process.env.PAIMON_AGENT_ID || "";
        if (/^[a-f0-9]{8}$/.test(myId)) {
          const modelFile = join(homedir(), ".teyvat/config/individual", myId, "model.json");
          if (existsSync(modelFile)) {
            const rec = JSON.parse(readFileSync(modelFile, "utf8"));
            if (rec?.model) {
              // 2026-09-16（windows agent 定位，main.js:331 vs AuthStorage.create()@523）：
              // getAvailable() 依赖 auth（hasConfiguredAuth），auth 未加载时返回空 → 解析失败掉 fallback。
              // 只用 find()（查 this.models，不过滤 auth，不受 AuthStorage 时机影响）。
              const savedModel = modelRegistry.find(rec.modelProvider, rec.model);
              if (savedModel) options.model = savedModel;
              else {
                // 2026-09-16（用户：静默 fallback 难以察觉，排查 glm 耗时 3h）：显式 warning。
                // 2026-09-16（windows_first_agent_01 实测）：原文案"未配 key 或 id 不存在"误导——find 只查 id 不查 auth，
                // key 与解析无关；真相是该 id 既不在注册表、也不在 models.dev 目录（重启无法保留）。
                console.warn(chalk.yellow(`⚠️ per-agent 模型 "${rec.model}" (${rec.modelProvider || "?"}) 无法解析：该 id 不在注册表、也不在 models.dev 目录（重启无法保留）。请在 /m 改选一个有效模型。已回退默认。`));
              }
            }
          }
        }
      } catch { /* 读失败回退默认 */ }
    }
    // 2026-09-22（用户：唯一真相）：去掉 `!hasExistingSession` 门——此前"已有会话"时配置链被**整段跳过**，
    // 于是"配置说的"和"会话记的"各说各话、静默分叉（恢复会话时 settings 默认不生效，只能碰运气）。
    // 现在配置链**永远**参与：per-agent 文件 > settings 默认（经 enabledModels 校验）> scoped[0] 兼底（显式 warning）。
    if (!options.model) {
        const savedProvider = settingsManager.getDefaultProvider();
        const savedModelId = settingsManager.getDefaultModel();
        const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
        if (savedModel) {
            const savedInScope = scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel));
            if (savedInScope) {
                options.model = savedInScope.model;
                if (!parsed.thinking && savedInScope.thinkingLevel) {
                    options.thinkingLevel = savedInScope.thinkingLevel;
                }
            }
            else if (scopedModels.length > 0) {
                // 2026-09-16 用户：禁用垃圾管线——defaultModel 优先是自动纠正（enabledModels 矛盾时自动换），逐行注释。
                // 恢复：不自动用 defaultModel，掉 scopedModels[0] 但显式 warning（让用户看到矛盾）。
                // options.model = savedModel;
                // console.warn(chalk.yellow(`⚠️ settings 默认模型 "${savedModelId}" (${savedProvider}) 不在 enabledModels 范围，仍按默认值使用。`));
                options.model = scopedModels[0].model;
                console.warn(chalk.yellow(`⚠️ settings 默认模型 "${savedModelId}" (${savedProvider}) 不在 enabledModels 范围，回退到 "${scopedModels[0].model.id}"。`));
            }
            else {
                // 2026-09-22（a_great_agent_on_imac_01 报的阻断 bug：`scopedModels[0].model` 越界崩溃 → unhandledRejection 卡死）：
                // 这条分支原本直接读 scopedModels[0]，但 `enabledModels` 没配/解析不出任何模型时 scopedModels 是空数组
                // （默认模型配了、enabledModels 没配 → 必现；TypeError 抛在 async 初始化里被吞 → 进程空转、终端不进 raw、用户卡住）。
                // 修：有 scoped[0] 就按原样退它；**一个都没有**时用用户明确配的默认模型（总不能没模型跑），并显式告警。
                if (scopedModels.length > 0) {
                    options.model = scopedModels[0].model;
                    console.warn(chalk.yellow(`⚠️ settings 默认模型 "${savedModelId}" (${savedProvider}) 不在 enabledModels 范围，回退到 "${scopedModels[0].model.id}"。`));
                }
                else {
                    options.model = savedModel;
                    console.warn(chalk.yellow(`⚠️ settings 默认模型 "${savedModelId}" (${savedProvider}) 不在 enabledModels 范围，且 enabledModels 解析不出任何模型 → 按 settings 默认模型继续（建议去 /s 把模型范围配上）。`));
                }
            }
        }
        else if (scopedModels.length > 0) {
            options.model = scopedModels[0].model;
            if (!parsed.thinking && scopedModels[0].thinkingLevel) {
                options.thinkingLevel = scopedModels[0].thinkingLevel;
            }
        }
    }
    // 2026-09-22（用户：唯一真相）：会话里那份模型 vs 本次配置决定的模型——不一致就**显式说清**（不静默分叉）。
    // 正常情况下两者一致（/m 会同时写 per-agent 文件 + 会话的 model_change）；不一致 = 真有东西对不上。
    if (options.model && sessionModel) {
        const sameModel = sessionModel.provider === options.model.provider && sessionModel.modelId === options.model.id;
        if (!sameModel) {
            const msg = `会话记录里的模型是 ${sessionModel.provider || "?"}/${sessionModel.modelId || "?"}，配置决定的是 ${options.model.provider}/${options.model.id}——本次按**配置**使用（配置是唯一真相，会话只是记录；要改配置用 /m）。`;
            console.warn(chalk.yellow(`⚠️ ${msg}`));
            diagnostics.push({ type: "warning", message: msg });
        }
    }
    // Thinking level from CLI (takes precedence over scoped model thinking levels set above)
    if (parsed.thinking) {
        options.thinkingLevel = parsed.thinking;
    }
    // Scoped models for Ctrl+P cycling
    // Keep thinking level undefined when not explicitly set in the model pattern.
    // Undefined means "inherit current session thinking level" during cycling.
    if (scopedModels.length > 0) {
        options.scopedModels = scopedModels.map((sm) => ({
            model: sm.model,
            thinkingLevel: sm.thinkingLevel,
        }));
    }
    // API key from CLI - set in authStorage
    // (handled by caller before createAgentSession)
    // Tools
    if (parsed.noTools) {
        options.noTools = "all";
    }
    else if (parsed.noBuiltinTools) {
        options.noTools = "builtin";
    }
    if (parsed.tools) {
        options.tools = [...parsed.tools];
    }
    if (parsed.excludeTools) {
        options.excludeTools = [...parsed.excludeTools];
    }
    return { options, cliThinkingFromModel, diagnostics };
}
function resolveCliPaths(cwd, paths) {
    return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}
async function promptForMissingSessionCwd(issue, settingsManager) {
    return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
        { label: "Continue", value: issue.fallbackCwd },
        { label: "Cancel", value: undefined },
    ]);
}
export async function main(args, options) {
    resetTimings();
    const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
    if (offlineMode) {
        process.env.PI_OFFLINE = "1";
        process.env.PI_SKIP_VERSION_CHECK = "1";
    }
    if (process.platform === "win32") {
        cleanupWindowsSelfUpdateQuarantine(getPackageDir());
    }
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
    configureHttpDispatcher();
    if (await handlePackageCommand(args, { extensionFactories: options?.extensionFactories })) {
        const exitCode = process.exitCode ?? 0;
        if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
            // We normally prefer process.exit(0) for package commands so bad extensions cannot keep
            // one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
            // runs during teardown; let successful `pi update` drain naturally instead.
            // https://github.com/nodejs/node/issues/56645
            return;
        }
        process.exit(exitCode);
        return;
    }
    if (await handleConfigCommand(args, { extensionFactories: options?.extensionFactories })) {
        return;
    }
    const parsed = parseArgs(args);
    if (parsed.diagnostics.length > 0) {
        for (const d of parsed.diagnostics) {
            const color = d.type === "error" ? chalk.red : chalk.yellow;
            console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
        }
        if (parsed.diagnostics.some((d) => d.type === "error")) {
            process.exit(1);
        }
    }
    time("parseArgs");
    if (parsed.version) {
        console.log(VERSION);
        process.exit(0);
    }
    if (parsed.export) {
        let result;
        try {
            const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
            result = await exportFromFile(parsed.export, outputPath);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Failed to export session";
            console.error(chalk.red(`Error: ${message}`));
            process.exit(1);
        }
        console.log(`Exported to: ${result}`);
        process.exit(0);
    }
    let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
    const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
    if (shouldTakeOverStdout) {
        takeOverStdout();
    }
    if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
        console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
        process.exit(1);
    }
    validateForkFlags(parsed);
    validateSessionIdFlags(parsed);
    // Run migrations (pass cwd for project-local migrations)
    const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
    time("runMigrations");
    const startupSettingsManager = SettingsManager.create(cwd, agentDir);
    reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));
    // Experimental first-time setup: theme choice and analytics opt-in.
    // Runs before any runtime services are created so the chosen settings apply everywhere.
    if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
        await showFirstTimeSetup(startupSettingsManager);
        time("firstTimeSetup");
    }
    // Decide the final runtime cwd before creating cwd-bound runtime services.
    // --session and --resume may select a session from another project, so project-local
    // settings, resources, provider registrations, and models must be resolved only after
    // the target session cwd is known. The startup-cwd settings manager is used only for
    // sessionDir lookup during session selection.
    const envSessionDir = process.env[ENV_SESSION_DIR];
    const sessionDir = (parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
        (envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
        startupSettingsManager.getSessionDir();
    let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
    const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
    if (missingSessionCwdIssue) {
        if (appMode === "interactive") {
            const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
            if (!selectedCwd) {
                process.exit(0);
            }
            sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile, sessionDir, selectedCwd);
        }
        else {
            console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
            process.exit(1);
        }
    }
    if (parsed.name !== undefined) {
        const name = parsed.name.trim();
        if (!name) {
            console.error(chalk.red("Error: --name requires a non-empty value"));
            process.exit(1);
        }
        sessionManager.appendSessionInfo(name);
    }
    time("createSessionManager");
    const trustStore = new ProjectTrustStore(agentDir);
    const sessionCwd = sessionManager.getCwd();
    const autoTrustOnReloadCwd = parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
        ? sessionCwd
        : undefined;
    const trustPromptMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
    const projectTrustByCwd = new Map();
    const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
    const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
    const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
    const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
    const authStorage = AuthStorage.create();
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext, }) => {
        const isInitialRuntime = sessionStartEvent === undefined;
        const projectTrustDiagnostics = [];
        const cachedProjectTrust = projectTrustByCwd.get(cwd);
        const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
        const shouldResolveProjectTrust = parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
        const projectTrusted = shouldResolveProjectTrust
            ? false
            : (cachedProjectTrust ??
                parsed.projectTrustOverride ??
                (!hasTrustRequiringResources || trustStore.get(cwd) === true));
        const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            authStorage,
            settingsManager: runtimeSettingsManager,
            extensionFlagValues: parsed.unknownFlags,
            resourceLoaderReloadOptions: shouldResolveProjectTrust
                ? {
                    resolveProjectTrust: async ({ extensionsResult }) => {
                        const trusted = await resolveProjectTrusted({
                            cwd,
                            trustStore,
                            trustOverride: parsed.projectTrustOverride,
                            defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
                            extensionsResult,
                            projectTrustContext: projectTrustContext ??
                                createProjectTrustContext({
                                    cwd,
                                    mode: isInitialRuntime ? trustPromptMode : appMode,
                                    settingsManager: startupSettingsManager,
                                    hasUI: isInitialRuntime && trustPromptMode === "interactive",
                                }),
                            onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
                        });
                        projectTrustByCwd.set(cwd, trusted);
                        return trusted;
                    },
                }
                : undefined,
            resourceLoaderOptions: {
                additionalExtensionPaths: resolvedExtensionPaths,
                additionalSkillPaths: resolvedSkillPaths,
                additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
                additionalThemePaths: resolvedThemePaths,
                noExtensions: parsed.noExtensions,
                noSkills: parsed.noSkills,
                noPromptTemplates: parsed.noPromptTemplates,
                noThemes: parsed.noThemes,
                noContextFiles: parsed.noContextFiles,
                systemPrompt: parsed.systemPrompt,
                appendSystemPrompt: parsed.appendSystemPrompt,
                extensionFactories: options?.extensionFactories,
            },
        });
        const { settingsManager, modelRegistry, resourceLoader } = services;
        const diagnostics = [
            ...projectTrustDiagnostics,
            ...services.diagnostics,
            ...collectSettingsDiagnostics(settingsManager, "runtime creation"),
            ...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
                type: "error",
                message: `Failed to load extension "${path}": ${error}`,
            })),
        ];
        const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
        const scopedModels = modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
        // 2026-09-22（用户：唯一真相）：把整个会话上下文交给 buildSessionOptions——配置链是唯一决定点，
        // 会话里的 model_change 只用来"对不上就说清楚"（此前只传 messages.length > 0 当开关用）。
        const sessionContext = sessionManager.buildSessionContext();
        const { options: sessionOptions, cliThinkingFromModel, diagnostics: sessionOptionDiagnostics, } = buildSessionOptions(parsed, scopedModels, sessionContext, modelRegistry, settingsManager);
        diagnostics.push(...sessionOptionDiagnostics);
        if (parsed.apiKey) {
            if (!sessionOptions.model) {
                diagnostics.push({
                    type: "error",
                    message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
                });
            }
            else {
                authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
            }
        }
        const created = await createAgentSessionFromServices({
            services,
            sessionManager,
            sessionStartEvent,
            model: sessionOptions.model,
            thinkingLevel: sessionOptions.thinkingLevel,
            scopedModels: sessionOptions.scopedModels,
            tools: sessionOptions.tools,
            excludeTools: sessionOptions.excludeTools,
            noTools: sessionOptions.noTools,
            customTools: sessionOptions.customTools,
        });
        const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
        if (created.session.model && cliThinkingOverride) {
            created.session.setThinkingLevel(created.session.thinkingLevel);
        }
        return {
            ...created,
            services,
            diagnostics,
        };
    };
    time("createRuntime");
    const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: sessionManager.getCwd(),
        agentDir,
        sessionManager,
    });
    time("createAgentSessionRuntime");
    const { services, session, modelFallbackMessage } = runtime;
    const { settingsManager, modelRegistry, resourceLoader } = services;
    applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
    configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
    if (parsed.help) {
        const extensionFlags = resourceLoader
            .getExtensions()
            .extensions.flatMap((extension) => Array.from(extension.flags.values()));
        printHelp(extensionFlags);
        process.exit(0);
    }
    if (parsed.listModels !== undefined) {
        const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
        await listModels(modelRegistry, searchPattern);
        process.exit(0);
    }
    // Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
    let stdinContent;
    if (appMode !== "rpc") {
        stdinContent = await readPipedStdin();
        if (stdinContent !== undefined && appMode === "interactive") {
            appMode = "print";
        }
    }
    time("readPipedStdin");
    const { initialMessage, initialImages } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize(), stdinContent);
    time("prepareInitialMessage");
    initTheme(settingsManager.getTheme(), appMode === "interactive");
    time("initTheme");
    // Show deprecation warnings in interactive mode
    if (appMode === "interactive" && deprecationWarnings.length > 0) {
        await showDeprecationWarnings(deprecationWarnings);
    }
    time("resolveModelScope");
    reportDiagnostics(runtime.diagnostics);
    if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
        console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
    }
    // ── teyvat 自修复引擎 · 扩展加载边界 ──────────────────────────────────────
    // 单个扩展(器官)加载失败【不该杀掉整个 pi】(用户原话:"不想再因为一两行问题进不去了")。
    // loader 已逐扩展 try/catch 隔离(收集 error、继续加载其余),这里把"扩展加载失败"从【致命 exit】
    // 降为【红字报错但继续启动】—— genshin 带着能用的器官照常起来,agent 看到"X 器官坏了:<error>"自己去修。
    // 非扩展类 error(模型/配置等真致命的)仍然 exit(1)。
    if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error" && !/Failed to load extension/.test(diagnostic.message))) {
        process.exit(1);
    }
    time("createAgentSession");
    if (appMode !== "interactive" && !session.model) {
        console.error(chalk.red(formatNoModelsAvailableMessage()));
        process.exit(1);
    }
    const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
    if (startupBenchmark && appMode !== "interactive") {
        console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
        process.exit(1);
    }
    if (appMode === "rpc") {
        printTimings();
        // 渲染管线检查（R 系列）：headless 环境总闸一致性（不得有半开渲染状态）
        try { globalThis.__genshinCheckRenderPipeline?.("headless"); } catch (e) { console.error("[god.tui/overrides/pi-dist/main.js] " + (e?.message || e)); }
        await runRpcMode(runtime);
    }
    else if (appMode === "interactive") {
        const interactiveMode = new InteractiveMode(runtime, {
            migratedProviders,
            modelFallbackMessage,
            autoTrustOnReloadCwd,
            initialMessage,
            initialImages,
            initialMessages: parsed.messages,
            verbose: parsed.verbose,
        });
        if (startupBenchmark) {
            await interactiveMode.init();
            time("interactiveMode.init");
            // Give the TUI's stdin handler a brief chance to consume terminal query replies
            // (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
            await new Promise((resolve) => setTimeout(resolve, 150));
            interactiveMode.stop();
            stopThemeWatcher();
            printTimings();
            if (process.stdout.writableLength > 0) {
                await new Promise((resolve) => process.stdout.once("drain", resolve));
            }
            if (process.stderr.writableLength > 0) {
                await new Promise((resolve) => process.stderr.once("drain", resolve));
            }
            return;
        }
        printTimings();
        await interactiveMode.run();
    }
    else {
        printTimings();
        const exitCode = await runPrintMode(runtime, {
            mode: toPrintOutputMode(appMode),
            messages: parsed.messages,
            initialMessage,
            initialImages,
        });
        stopThemeWatcher();
        restoreStdout();
        if (exitCode !== 0) {
            process.exitCode = exitCode;
        }
        return;
    }
}
//# sourceMappingURL=main.js.map