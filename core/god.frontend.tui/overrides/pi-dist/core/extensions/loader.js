/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as _bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as _bundledPiTui from "@earendil-works/pi-tui";
// jiti disabled by teyvat
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.js";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @earendil-works/pi-coding-agent.
import * as _bundledPiCodingAgent from "../../index.js";
import { resolvePath } from "../../utils/paths.js";
import { createEventBus } from "../event-bus.js";
import { execCommand } from "../exec.js";
import { createSyntheticSourceInfo } from "../source-info.js";
/** Modules available to extensions via virtualModules (for compiled Bun binary) */
const VIRTUAL_MODULES = {
    typebox: _bundledTypebox,
    "typebox/compile": _bundledTypeboxCompile,
    "typebox/value": _bundledTypeboxValue,
    "@sinclair/typebox": _bundledTypebox,
    "@sinclair/typebox/compile": _bundledTypeboxCompile,
    "@sinclair/typebox/value": _bundledTypeboxValue,
    "@earendil-works/pi-agent-core": _bundledPiAgentCore,
    "@earendil-works/pi-tui": _bundledPiTui,
    "@earendil-works/pi-ai": _bundledPiAiCompat,
    "@earendil-works/pi-ai/compat": _bundledPiAiCompat,
    "@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
    "@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
    "@mariozechner/pi-agent-core": _bundledPiAgentCore,
    "@mariozechner/pi-tui": _bundledPiTui,
    "@mariozechner/pi-ai": _bundledPiAiCompat,
    "@mariozechner/pi-ai/compat": _bundledPiAiCompat,
    "@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
    "@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};
const require = createRequire(import.meta.url);
/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases = null;
function getAliases() {
    if (_aliases)
        return _aliases;
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const packageIndex = path.resolve(__dirname, "../..", "index.js");
    const typeboxEntry = require.resolve("typebox");
    const typeboxCompileEntry = require.resolve("typebox/compile");
    const typeboxValueEntry = require.resolve("typebox/value");
    const packagesRoot = path.resolve(__dirname, "../../../../");
    const resolveWorkspaceOrImport = (workspaceRelativePath, specifier) => {
        const workspacePath = path.join(packagesRoot, workspaceRelativePath);
        if (fs.existsSync(workspacePath)) {
            return workspacePath;
        }
        return fileURLToPath(import.meta.resolve(specifier));
    };
    const piCodingAgentEntry = packageIndex;
    const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
    const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
    const piAiCompatEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@earendil-works/pi-ai/compat");
    const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai/oauth");
    _aliases = {
        "@earendil-works/pi-coding-agent": piCodingAgentEntry,
        "@earendil-works/pi-agent-core": piAgentCoreEntry,
        "@earendil-works/pi-tui": piTuiEntry,
        "@earendil-works/pi-ai": piAiCompatEntry,
        "@earendil-works/pi-ai/compat": piAiCompatEntry,
        "@earendil-works/pi-ai/oauth": piAiOauthEntry,
        "@mariozechner/pi-coding-agent": piCodingAgentEntry,
        "@mariozechner/pi-agent-core": piAgentCoreEntry,
        "@mariozechner/pi-tui": piTuiEntry,
        "@mariozechner/pi-ai": piAiCompatEntry,
        "@mariozechner/pi-ai/compat": piAiCompatEntry,
        "@mariozechner/pi-ai/oauth": piAiOauthEntry,
        typebox: typeboxEntry,
        "typebox/compile": typeboxCompileEntry,
        "typebox/value": typeboxValueEntry,
        "@sinclair/typebox": typeboxEntry,
        "@sinclair/typebox/compile": typeboxCompileEntry,
        "@sinclair/typebox/value": typeboxValueEntry,
    };
    return _aliases;
}
/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime() {
    const notInitialized = () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
    };
    const state = {};
    const assertActive = () => {
        if (state.staleMessage) {
            throw new Error(state.staleMessage);
        }
    };
    const runtime = {
        sendMessage: notInitialized,
        sendUserMessage: notInitialized,
        appendEntry: notInitialized,
        setSessionName: notInitialized,
        getSessionName: notInitialized,
        setLabel: notInitialized,
        getActiveTools: notInitialized,
        getAllTools: notInitialized,
        setActiveTools: notInitialized,
        // registerTool() is valid during extension load; refresh is only needed post-bind.
        refreshTools: () => { },
        getCommands: notInitialized,
        setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
        getThinkingLevel: notInitialized,
        setThinkingLevel: notInitialized,
        flagValues: new Map(),
        pendingProviderRegistrations: [],
        assertActive,
        invalidate: (message) => {
            state.staleMessage ??=
                message ??
                    "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
        },
        // Pre-bind: queue registrations so bindCore() can flush them once the
        // model registry is available. bindCore() replaces both with direct calls.
        registerProvider: (name, config, extensionPath = "<unknown>") => {
            runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
        },
        unregisterProvider: (name) => {
            runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
        },
    };
    return runtime;
}
/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(extension, runtime, cwd, eventBus) {
    const api = {
        // Registration methods - write to extension
        on(event, handler) {
            runtime.assertActive();
            const list = extension.handlers.get(event) ?? [];
            list.push(handler);
            extension.handlers.set(event, list);
        },
        registerTool(tool) {
            runtime.assertActive();
            extension.tools.set(tool.name, {
                definition: tool,
                sourceInfo: extension.sourceInfo,
            });
            runtime.refreshTools();
        },
        registerCommand(name, options) {
            runtime.assertActive();
            extension.commands.set(name, {
                name,
                sourceInfo: extension.sourceInfo,
                ...options,
            });
        },
        registerShortcut(shortcut, options) {
            runtime.assertActive();
            extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
        },
        registerFlag(name, options) {
            runtime.assertActive();
            extension.flags.set(name, { name, extensionPath: extension.path, ...options });
            if (options.default !== undefined && !runtime.flagValues.has(name)) {
                runtime.flagValues.set(name, options.default);
            }
        },
        registerMessageRenderer(messageType, renderer) {
            runtime.assertActive();
            extension.messageRenderers.set(messageType, renderer);
        },
        registerEntryRenderer(customType, renderer) {
            runtime.assertActive();
            extension.entryRenderers ??= new Map();
            extension.entryRenderers.set(customType, renderer);
        },
        // Flag access - checks extension registered it, reads from runtime
        getFlag(name) {
            runtime.assertActive();
            if (!extension.flags.has(name))
                return undefined;
            return runtime.flagValues.get(name);
        },
        // Action methods - delegate to shared runtime
        sendMessage(message, options) {
            runtime.assertActive();
            runtime.sendMessage(message, options);
        },
        sendUserMessage(content, options) {
            runtime.assertActive();
            runtime.sendUserMessage(content, options);
        },
        appendEntry(messageType, data) {
            runtime.assertActive();
            runtime.appendEntry(messageType, data);
        },
        setSessionName(name) {
            runtime.assertActive();
            runtime.setSessionName(name);
        },
        getSessionName() {
            runtime.assertActive();
            return runtime.getSessionName();
        },
        setLabel(entryId, label) {
            runtime.assertActive();
            runtime.setLabel(entryId, label);
        },
        exec(command, args, options) {
            runtime.assertActive();
            return execCommand(command, args, options?.cwd ?? cwd, options);
        },
        getActiveTools() {
            runtime.assertActive();
            return runtime.getActiveTools();
        },
        getAllTools() {
            runtime.assertActive();
            return runtime.getAllTools();
        },
        setActiveTools(toolNames) {
            runtime.assertActive();
            runtime.setActiveTools(toolNames);
        },
        getCommands() {
            runtime.assertActive();
            return runtime.getCommands();
        },
        setModel(model) {
            runtime.assertActive();
            return runtime.setModel(model);
        },
        getThinkingLevel() {
            runtime.assertActive();
            return runtime.getThinkingLevel();
        },
        setThinkingLevel(level) {
            runtime.assertActive();
            runtime.setThinkingLevel(level);
        },
        registerProvider(name, config) {
            runtime.assertActive();
            runtime.registerProvider(name, config, extension.path);
        },
        unregisterProvider(name) {
            runtime.assertActive();
            runtime.unregisterProvider(name, extension.path);
        },
        events: eventBus,
    };
    return api;
}
async function loadExtensionModule(extensionPath) {
    // teyvat: 先把扩展入口解析成 realpath 再交给 jiti。
    // 否则经软链加载的扩展(如 device → Codebase/core/universe.infotech/local.mobile)，其 #subpath-imports
    // (#hands_terminal/#physical_space 等)会从软链路径 ~/.teyvat/agent/extensions/device/ 向上找 package.json
    // → 找不到 Codebase/core/package.json → 报 "Cannot find module '#hands_terminal'"。
    // realpath 后 jiti 从真实位置向上走，正确命中 core/package.json 的别名表（teyvat 这种
    // 软链根自带 package.json 的本来就 OK，realpath 对它无副作用；真目录扩展也不受影响）。
    let realExtensionPath = extensionPath;
    try {
        realExtensionPath = fs.realpathSync(extensionPath);
    }
    catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[64001] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/overrides/pi-dist/core/extensions/loader.js] " + (e?.message || e)); } }
    // teyvat: jiti disabled — use native Node import
    // 缓存失效：加 ?t=timestamp 强制 Node 重新执行模块顶层代码
    // 模块内部 import (#kernel_ribosome 等) 不受影响——那些包本身不变
    const cacheBust = `${realExtensionPath}?t=${Date.now()}`;
    const module = await import(cacheBust);
    const factory = typeof module === "function" ? module : module?.default;
    return typeof factory !== "function" ? undefined : factory;
}
/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath, resolvedPath) {
    const source = extensionPath.startsWith("<") && extensionPath.endsWith(">")
        ? extensionPath.slice(1, -1).split(":")[0] || "temporary"
        : "local";
    const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);
    return {
        path: extensionPath,
        resolvedPath,
        sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
        handlers: new Map(),
        tools: new Map(),
        messageRenderers: new Map(),
        entryRenderers: new Map(),
        commands: new Map(),
        flags: new Map(),
        shortcuts: new Map(),
    };
}
async function loadExtension(extensionPath, cwd, eventBus, runtime) {
    const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });
    try {
        const factory = await loadExtensionModule(resolvedPath);
        if (!factory) {
            return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
        }
        const extension = createExtension(extensionPath, resolvedPath);
        const api = createExtensionAPI(extension, runtime, cwd, eventBus);
        await factory(api);
        return { extension, error: null };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { extension: null, error: `Failed to load extension: ${message}` };
    }
}
/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath = "<inline>") {
    const extension = createExtension(extensionPath, extensionPath);
    const resolvedCwd = resolvePath(cwd);
    const api = createExtensionAPI(extension, runtime, resolvedCwd, eventBus);
    await factory(api);
    return extension;
}
/**
 * Load extensions from paths.
 */
export async function loadExtensions(paths, cwd, eventBus, runtime) {
    const extensions = [];
    const errors = [];
    const resolvedCwd = resolvePath(cwd);
    const resolvedEventBus = eventBus ?? createEventBus();
    const resolvedRuntime = runtime ?? createExtensionRuntime();
    for (const extPath of paths) {
        const { extension, error } = await loadExtension(extPath, resolvedCwd, resolvedEventBus, resolvedRuntime);
        if (error) {
            errors.push({ path: extPath, error });
            continue;
        }
        if (extension) {
            extensions.push(extension);
        }
    }
    return {
        extensions,
        errors,
        runtime: resolvedRuntime,
    };
}
function readPiManifest(packageJsonPath) {
    try {
        const content = fs.readFileSync(packageJsonPath, "utf-8");
        const pkg = JSON.parse(content);
        if (pkg.pi && typeof pkg.pi === "object") {
            return pkg.pi;
        }
        return null;
    }
    catch {
        return null;
    }
}
function isExtensionFile(name) {
    return name.endsWith(".ts") || name.endsWith(".js");
}
/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir) {
    // Check for package.json with "pi" field first
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        const manifest = readPiManifest(packageJsonPath);
        if (manifest?.extensions?.length) {
            const entries = [];
            for (const extPath of manifest.extensions) {
                const resolvedExtPath = path.resolve(dir, extPath);
                if (fs.existsSync(resolvedExtPath)) {
                    entries.push(resolvedExtPath);
                }
            }
            if (entries.length > 0) {
                return entries;
            }
        }
    }
    // Check for index.ts or index.js
    const indexTs = path.join(dir, "index.ts");
    const indexJs = path.join(dir, "index.js");
    if (fs.existsSync(indexTs)) {
        return [indexTs];
    }
    if (fs.existsSync(indexJs)) {
        return [indexJs];
    }
    return null;
}
/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const discovered = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            // teyvat: 跳过【禁用/备份】的扩展目录 —— 名字以 . 或 _ 开头,或带 .disabled/.bak/.stale/.old。
            // 这样停用一个扩展只需把目录改名(加后缀),不必把它移出 extensions/。loader 直接不当它是扩展。
            if (entry.name.startsWith(".") || entry.name.startsWith("_") ||
                /\.(bak|stale|old)\b/i.test(entry.name) || /disabled/i.test(entry.name)) {
                continue;
            }
            // 1. Direct files: *.ts or *.js
            if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
                discovered.push(entryPath);
                continue;
            }
            // 2 & 3. Subdirectories
            if (entry.isDirectory() || entry.isSymbolicLink()) {
                const entries = resolveExtensionEntries(entryPath);
                if (entries) {
                    discovered.push(...entries);
                }
            }
        }
    }
    catch {
        return [];
    }
    return discovered;
}
/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(configuredPaths, cwd, agentDir = getAgentDir(), eventBus) {
    const resolvedCwd = resolvePath(cwd);
    const resolvedAgentDir = resolvePath(agentDir);
    const allPaths = [];
    const seen = new Set();
    const addPaths = (paths) => {
        for (const p of paths) {
            const resolved = path.resolve(p);
            if (!seen.has(resolved)) {
                seen.add(resolved);
                allPaths.push(p);
            }
        }
    };
    // 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
    const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
    addPaths(discoverExtensionsInDir(localExtDir));
    // 2. Global extensions: agentDir/extensions/
    const globalExtDir = path.join(resolvedAgentDir, "extensions");
    addPaths(discoverExtensionsInDir(globalExtDir));
    // 启动文件监听，改动自动清缓存
    startExtensionWatcher([localExtDir, globalExtDir]);
    // 3. Explicitly configured paths
    for (const p of configuredPaths) {
        const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            // Check for package.json with pi manifest or index.ts
            const entries = resolveExtensionEntries(resolved);
            if (entries) {
                addPaths(entries);
                continue;
            }
            // No explicit entries - discover individual files in directory
            addPaths(discoverExtensionsInDir(resolved));
            continue;
        }
        addPaths([resolved]);
    }
    return loadExtensions(allPaths, resolvedCwd, eventBus);
}
// extension cache (for clearExtensionCache, imported by resource-loader.js in pi 0.79.10+)
const extensionCache = new Map();
let extensionCacheCwd = undefined;
let extensionCacheGeneration = 0;

export function clearExtensionCache() {
    extensionCache.clear();
    extensionCacheCwd = undefined;
    extensionCacheGeneration++;
}

export async function loadExtensionsCached(paths, cwd, eventBus, runtime) {
    const resolvedCwd = resolvePath(cwd);
    if (extensionCacheCwd !== resolvedCwd) {
        clearExtensionCache();
        extensionCacheCwd = resolvedCwd;
    }
    const cacheKey = paths.slice().sort().join('\0');
    const cached = extensionCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const result = await loadExtensions(paths, resolvedCwd, eventBus, runtime);
    extensionCache.set(cacheKey, result);
    return result;
}

// ── 文件监听: 自动清理缓存 + 热加载回调 ──
let _watcherStarted = false;
let _onFileChange = null;

export function setFileChangeCallback(cb) {
  _onFileChange = cb;
}

export function startExtensionWatcher(extDirs) {
  if (_watcherStarted) return;
  _watcherStarted = true;
  for (const dir of extDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && /\.(ts|js)$/.test(filename)) {
          clearExtensionCache();
          if (_onFileChange) _onFileChange(filename);
        }
      });
    } catch(e) { try { require("fs").appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[64002] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/overrides/pi-dist/core/extensions/loader.js] " + (e?.message || e)); } }
  }
}
//# sourceMappingURL=loader.js.map