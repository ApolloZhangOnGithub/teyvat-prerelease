/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
// 本地 i18n helper —— 与 god.frontend.tui/localizations/i18n.ts 逻辑一致；
// interactive-mode.js 部署到 pi dist（install.sh cp），无法用 #tui_localizations 别名，故内联同款判断。
const _uiLang = (process.env.PI_LANG || "zh").slice(0, 2).toLowerCase();
const _i18n = (zh, en) => _uiLang === "en" ? en : zh;
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProviders, } from "@earendil-works/pi-ai/compat";
import { CombinedAutocompleteProvider, Container, fuzzyFilter, getCapabilities, hyperlink, Markdown, matchesKey, ProcessTerminal, ScrollView, Spacer, setKeybindings, Text, TruncatedText, TuiAltScreen, VStack, visibleWidth, } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { spawn, spawnSync } from "child_process";
import { APP_NAME, APP_TITLE, CONFIG_DIR_NAME, getAgentDir, getAuthPath, getDebugLogPath, getDocsPath, getShareViewerUrl, VERSION, } from "../../config.js";
import { parseSkillBlock } from "../../core/agent-session.js";
import { SessionImportFileNotFoundError } from "../../core/agent-session-runtime.js";
import { setFileChangeCallback } from "../../core/extensions/loader.js";
import { CACHE_TTL_MS, collectCacheMisses, computeCacheWaste, detectCacheMiss, } from "../../core/cache-stats.js";
import { FooterDataProvider } from "../../core/footer-data-provider.js";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.js";
import { KeybindingsManager } from "../../core/keybindings.js";
import { createCompactionSummaryMessage } from "../../core/messages.js";
import { defaultModelPerProvider, findExactModelReferenceMatch, resolveModelScope } from "../../core/model-resolver.js";
import { DefaultPackageManager } from "../../core/package-manager.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.js";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionManager, sessionEntryToContextMessages } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import { isInstallTelemetryEnabled } from "../../core/telemetry.js";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.js";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.js";
import { copyToClipboard, readClipboardText } from "../../utils/clipboard.js";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.js";
import { parseGitUrl } from "../../utils/git.js";
import { getCwdRelativePath } from "../../utils/paths.js";
import { getPiUserAgent } from "../../utils/pi-user-agent.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { checkForNewPiVersion } from "../../utils/version-check.js";
import { ArminComponent } from "./components/armin.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomEntryComponent } from "./components/custom-entry.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent, formatTokens } from "./components/footer.js";
import { StatusBar } from "./components/statebar.js";
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { formatAuthSelectorProviderType, OAuthSelectorComponent, } from "./components/oauth-selector.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { TrustSelectorComponent } from "./components/trust-selector.js";
import { UserMessageComponent } from "./components/blocks_god.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import { getModelSearchText } from "./model-search.js";
import { getAvailableThemes, getAvailableThemesWithPaths, getEditorTheme, getMarkdownTheme, getThemeByName, onThemeChange, setRegisteredThemes, stopThemeWatcher, Theme, theme, } from "./theme/theme.js";
import { InteractiveThemeController } from "./theme/theme-controller.js";
// ESM 下 require 未定义：显式建垫片。原先裸用 require() 会在执行到时抛错，
// 而 Makefile 的 ESM 检查因 glob 失效一直没抓到（2026-07-29 修）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let _highlight;
try { _highlight = (await import("cli-highlight")).highlight; } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }

const STORAGE_KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "type", "interface",
  "enum", "namespace", "module", "def", "fn", "func", "struct",
  "trait", "impl",
]);

const MONOKAI_THEME = {
  keyword: (text) => STORAGE_KEYWORDS.has(text.trim())
    ? chalk.rgb(102, 217, 239)(text)
    : chalk.rgb(249, 38, 114)(text),
  built_in: chalk.rgb(166, 226, 46),
  type: chalk.rgb(166, 226, 46),
  literal: chalk.rgb(190, 132, 255),
  number: chalk.rgb(190, 132, 255),
  string: chalk.rgb(230, 219, 116),
  title: chalk.rgb(166, 226, 46),
  function: chalk.rgb(166, 226, 46),
  params: chalk.rgb(253, 151, 31),
  comment: chalk.rgb(117, 113, 94),
  doctag: chalk.rgb(117, 113, 94),
  meta: chalk.rgb(117, 113, 94),
  attr: chalk.rgb(166, 226, 46),
  attribute: chalk.rgb(166, 226, 46),
  variable: chalk.rgb(255, 255, 255),
  property: chalk.rgb(255, 255, 255),
  operator: chalk.rgb(249, 38, 114),
  punctuation: chalk.rgb(248, 248, 242),
  symbol: chalk.rgb(190, 132, 255),
  regexp: chalk.rgb(230, 219, 116),
  subst: chalk.rgb(248, 248, 242),
  "template-variable": chalk.rgb(248, 248, 242),
  name: chalk.rgb(249, 38, 114),
  tag: chalk.rgb(248, 248, 242),
  addition: chalk.rgb(166, 226, 46),
  deletion: chalk.rgb(249, 38, 114),
  section: chalk.rgb(166, 226, 46),
  bullet: chalk.rgb(190, 132, 255),
  emphasis: chalk.italic,
  strong: chalk.bold,
  link: chalk.rgb(102, 217, 239).underline,
  quote: chalk.rgb(117, 113, 94),
  "selector-tag": chalk.rgb(249, 38, 114),
  "selector-id": chalk.rgb(166, 226, 46),
  "selector-class": chalk.rgb(166, 226, 46),
  "selector-attr": chalk.rgb(166, 226, 46),
  "selector-pseudo": chalk.rgb(166, 226, 46),
  "template-tag": chalk.rgb(249, 38, 114),
  "meta-keyword": chalk.rgb(249, 38, 114),
  "meta-string": chalk.rgb(230, 219, 116),
  default: (text) => text,
};

function isHighlightEnabled() {
  // /ux 面板控制，默认关
  return globalThis.__genshinCodeHighlight === true;
}

// 2026-09-05 已知语言白名单：highlight.js 对未知语言（如消息里的 ```issue / ```plain）先 console.error
// （LANGUAGE_NOT_FOUND）再 throw——外层 catch 吞得了 throw 但拦不住已发出的 error 日志，console-error.log 刷屏。
// 非白名单语言不传 lang → highlight.js autodetect/纯文本，从源头不触发 getLanguage 失败。
const HIGHLIGHT_LANGS = new Set([
  "js", "javascript", "ts", "typescript", "bash", "sh", "shell", "zsh",
  "json", "python", "py", "html", "xml", "css", "markdown", "md", "yaml", "yml",
  "java", "c", "cpp", "go", "rust", "sql", "diff", "ini", "toml", "graphql", "dockerfile",
]);
function highlightCode(code, lang) {
  if (!_highlight) return null;
  if (!isHighlightEnabled()) return null;
  try {
    const safeLang = lang && HIGHLIGHT_LANGS.has(String(lang).toLowerCase()) ? lang : undefined;
    return _highlight(code, { language: safeLang, theme: MONOKAI_THEME }).split("\n");
  } catch { return null; }
}
// 暴露给 tool-execution.js 用
globalThis.__genshinHighlightCode = highlightCode;

function isExpandable(obj) {
    return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}
class ExpandableText extends Text {
    getCollapsedText;
    getExpandedText;
    constructor(getCollapsedText, getExpandedText, expanded = false, paddingX = 0, paddingY = 0) {
        super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
        this.getCollapsedText = getCollapsedText;
        this.getExpandedText = getExpandedText;
    }
    setExpanded(expanded) {
        this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
    }
}
function isCustomSessionEntry(item) {
    return "type" in item && item.type === "custom";
}
/**
 * genshin 2026-09-04：session entry 是否可渲染（用于 self-reboot 历史重放过滤）。
 * 可渲染：message（user/assistant/toolResult，toolResult 由管线匹配 toolCall）/
 * custom_message（display!==false，display=false 是内部通知不渲染）/compaction/branch_summary。
 * 不可渲染：session、model_change、thinking_level_change 等元数据 entry。
 */
function _isRenderableSessionEntry(entry) {
    if (!entry || typeof entry !== "object") return false;
    if (entry.type === "message") return true;
    if (entry.type === "custom_message") return entry.display !== false;
    return entry.type === "compaction" || entry.type === "branch_summary";
}
const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);
function isDeadTerminalError(error) {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return false;
    }
    const code = error.code;
    return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING = "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";
function isAnthropicSubscriptionAuthKey(apiKey) {
    return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}
function isUnknownModel(model) {
    return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}
function quoteIfNeeded(value) {
    if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
        return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function formatResumeCommand(sessionManager) {
    if (!process.stdout.isTTY)
        return undefined;
    if (!sessionManager.isPersisted())
        return undefined;
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile || !fs.existsSync(sessionFile))
        return undefined;
    const args = [APP_NAME];
    if (!sessionManager.usesDefaultSessionDir()) {
        args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
    }
    args.push("--session", sessionManager.getSessionId());
    return args.join(" ");
}
function hasDefaultModelProvider(providerId) {
    return providerId in defaultModelPerProvider;
}
const BUILT_IN_MODEL_PROVIDERS = new Set(getProviders());
export function isApiKeyLoginProvider(providerId, oauthProviderIds, builtInProviderIds = BUILT_IN_MODEL_PROVIDERS) {
    if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
        return true;
    }
    if (builtInProviderIds.has(providerId)) {
        return false;
    }
    return !oauthProviderIds.has(providerId);
}
const AUTH_TYPE_ORDER = { oauth: 0, api_key: 1 };
function createFuzzyAutocompleteItems(items, prefix, getSearchText, toAutocompleteItem) {
    const filtered = fuzzyFilter(items, prefix, getSearchText);
    if (filtered.length === 0)
        return null;
    return filtered.map(toAutocompleteItem);
}
function getLoginProviderCompletionOptions(providerOptions) {
    const byId = new Map();
    for (const provider of providerOptions) {
        const existing = byId.get(provider.id);
        if (existing) {
            if (!existing.authTypes.includes(provider.authType)) {
                existing.authTypes.push(provider.authType);
                existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
            }
            continue;
        }
        byId.set(provider.id, {
            id: provider.id,
            name: provider.name,
            authTypes: [provider.authType],
        });
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}
function getLoginProviderSearchText(provider) {
    const authTypes = provider.authTypes
        .map((authType) => `${authType} ${formatAuthSelectorProviderType(authType)}`)
        .join(" ");
    return `${provider.id} ${provider.name} ${authTypes}`;
}
function formatLoginProviderCompletionDescription(provider) {
    const authTypes = provider.authTypes.map(formatAuthSelectorProviderType).join("/");
    return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}
export class InteractiveMode {
    runtimeHost;
    ui;
    loadedResourcesContainer;
    chatContainer;
    pendingMessagesContainer;
    statusContainer;
    defaultEditor;
    editor;
    editorComponentFactory;
    autocompleteProvider;
    autocompleteProviderWrappers = [];
    fdPath;
    editorContainer;
    footer;
    footerDataProvider;
    // Stored so the same manager can be injected into custom editors, selectors, and extension UI.
    keybindings;
    version;
    isInitialized = false;
    onInputCallback;
    // REMOVED(2026-07-26): pendingUserInputs 从未被 push，死代码
    // pendingUserInputs = [];
    statusBar = null;
    workingIndicatorOptions = undefined;
    defaultHiddenThinkingLabel = "Thinking...";
    hiddenThinkingLabel = this.defaultHiddenThinkingLabel;
    lastSigintTime = 0;
    lastEscapeTime = 0;
    changelogMarkdown = undefined;
    startupNoticesShown = false;
    anthropicSubscriptionWarningShown = false;
    // Status line tracking (for mutating immediately-sequential status updates)
    lastStatusSpacer = undefined;
    lastStatusText = undefined;
    // Streaming message tracking
    streamingComponent = undefined;
    streamingMessage = undefined;
    // Render mode: "streaming" (token-by-token) or "line" (line-by-line)
    renderMode = globalThis.__piRenderMode || "line";  // 2026-09-06 默认 line-by-line（用户定稿，可 /u 切换，settings.renderMode 持久化覆盖）
    // Tool execution tracking: toolCallId -> component
    pendingTools = new Map();
    // Tool output expansion state
    toolOutputExpanded = false;
    // Thinking block visibility state
    hideThinkingBlock = false;
    outputPad = 1;
    // Skill commands: command name -> skill file path
    skillCommands = new Map();
    // Agent subscription unsubscribe function
    unsubscribe;
    signalCleanupHandlers = [];
    // Track if editor is in bash mode (text starts with !)
    isBashMode = false;
    // Track current bash execution component
    bashComponent = undefined;
    // Track pending bash components (shown in pending area, moved to chat on submit)
    pendingBashComponents = [];
    // Auto-compaction state
    autoCompactionEscapeHandler;
    // Auto-retry state
    retryEscapeHandler;
    // Messages queued while compaction is running
    compactionQueuedMessages = [];
    // Shutdown state
    shutdownRequested = false;
    // teyvat 2026-08-14：transcript 是否跟随底部 + 离开底部后的未读新消息计数（footer follow hint）
    _transcriptFollowing = true;
    _unseenMessages = 0;
    // Hot-reload state
    _hotloadEnabled = false;
    _hotloadReloadTimer = null;
    _hotloadPendingFiles = new Set();
    // Extension UI state
    extensionSelector = undefined;
    extensionInput = undefined;
    extensionEditor = undefined;
    extensionTerminalInputUnsubscribers = new Set();
    // Extension widgets (components rendered above/below the editor)
    extensionWidgetsAbove = new Map();
    extensionWidgetsBelow = new Map();
    widgetContainerAbove;
    widgetContainerBelow;
    // Custom footer from extension (undefined = use built-in footer)
    customFooter = undefined;
    // Header container that holds the built-in or custom header
    headerContainer;
    // Built-in header (logo + keybinding hints + changelog)
    builtInHeader = undefined;
    // Custom header from extension (undefined = use built-in header)
    customHeader = undefined;
    options;
    autoTrustOnReloadCwd;
    themeController;
    // Convenience accessors
    get session() {
        return this.runtimeHost.session;
    }
    get agent() {
        return this.session.agent;
    }
    get sessionManager() {
        return this.session.sessionManager;
    }
    get settingsManager() {
        return this.session.settingsManager;
    }
    constructor(runtimeHost, options = {}) {
        // 2026-08-18 解耦 PROPOSAL 034 阶段 2：UI 环境标志——interactive 模式实例化即注册，
        // headless（rpc/print 模式）不实例化 InteractiveMode → 不注册 → sendCustomMessage 的
        // display 一律 false（消息只投递不渲染）。"是否显示给用户"从此由环境决定，内核不再拍板。
        globalThis.__genshinUIEnv = true;
        // 渲染管线检查（R 系列）：TUI 环境总闸一致性 + 部件注册完整（FAIL 打印 [render-pipeline] 前缀）
        try { globalThis.__genshinCheckRenderPipeline?.("tui"); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
        this._sessionStartMs = Date.now();
        this.runtimeHost = runtimeHost;
        this.options = options;
        this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
        this.runtimeHost.setBeforeSessionInvalidate(() => {
            this.resetExtensionUI();
        });
        this.runtimeHost.setRebindSession(async () => {
            await this.rebindCurrentSession({ renderBeforeBind: true });
        });
        this.version = VERSION;
        // teyvat: 官方 0.84.1 TuiAltScreen —— fullscreen（备用屏幕 + sticky dock 底部悬浮）
        this.ui = new TuiAltScreen(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
        this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
        this.headerContainer = new Container();
        this.loadedResourcesContainer = new Container();
        this.chatContainer = new Container();
        // 顶部永久空行（滚到最上方时有一行黑色间隔，视觉提示这是历史顶部）
        // hook clear 保证任何 clear() 后都自动加回
        const _origClear = this.chatContainer.clear.bind(this.chatContainer);
        this.chatContainer.clear = () => { _origClear(); this.chatContainer.addChild(new Spacer(1)); };
        this.chatContainer.addChild(new Spacer(1));
        this.pendingMessagesContainer = new Container();
        this.statusContainer = new Container();
        this.widgetContainerAbove = new Container();
        this.widgetContainerBelow = new Container();
        this.keybindings = KeybindingsManager.create();
        setKeybindings(this.keybindings);
        const editorPaddingX = this.settingsManager.getEditorPaddingX();
        const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
        this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
            paddingX: editorPaddingX,
            autocompleteMaxVisible,
        });
        this.editor = this.defaultEditor;
        this.editorContainer = new Container();
        this.editorContainer.addChild(this.editor);
        this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
        this.footer = new FooterComponent(this.session, this.footerDataProvider);
        this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
        this.footer.setRequestRender(() => this.ui.requestRender());
        this.statusBar = new StatusBar(this.footer, () => this.ui.requestRender());
        globalThis.__genshinStatusBar = this.statusBar;
        this.statusBar.setTokenCallbacks(
            () => this._getTurnOutputTokens(),
            () => this._getStreamingOutputTokens(),
        );
        // Load hide thinking block setting
        this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
        this.outputPad = this.settingsManager.getOutputPad();
        // Load render mode from persisted settings
        const savedRenderMode = this.settingsManager.settings?.renderMode;
        if (savedRenderMode === "line" || savedRenderMode === "streaming" || savedRenderMode === "block") {
            this.renderMode = savedRenderMode;
            globalThis.__piRenderMode = savedRenderMode;
        }
        // Load compact execute from persisted settings
        const savedCompactExecute = this.settingsManager.settings?.compactExecute;
        if (savedCompactExecute !== undefined) {
            globalThis.__genshinCompactExecute = savedCompactExecute;
        }
        // Load tool expanded from persisted settings
        const savedToolExpanded = this.settingsManager.settings?.toolExpanded;
        if (savedToolExpanded !== undefined) {
            this.toolOutputExpanded = savedToolExpanded;
        }
        // Expose settingsManager for /view commands
        globalThis.__genshinSettingsManager = this.settingsManager;
        // 2026-09-07 用户定稿：删除硬编码精选清单（__genshinFeaturedModels）——/m 名单一律从官方 registry/catalog 读，不再有手写硬编码。model-selector.js 用 `|| []` 兜底，删除安全。
        // 2026-09-04：footer 显示偏好恢复（/u 的 Footer 年龄/Footer 履历开关，默认 true）；2026-09-06 用户定稿默认隐藏（改 false）
        globalThis.__genshinFooterAge = this.settingsManager?.globalSettings?.footerAge ?? false;
        globalThis.__genshinFooterTokenmaxxed = this.settingsManager?.globalSettings?.footerTokenmaxxed ?? false;
        // 2026-09-04：footer 模型名左侧具体 provider 显示（/u 的 Footer 供应商开关，默认 true）；2026-09-06 默认隐藏
        globalThis.__genshinFooterProvider = this.settingsManager?.globalSettings?.footerProvider ?? false;
        // /u 持久化的行为偏好恢复
        if (this.settingsManager?.globalSettings?.ctrlCToBg !== undefined) globalThis.__genshinCtrlCToBg = this.settingsManager.globalSettings.ctrlCToBg;
        if (this.settingsManager?.globalSettings?.codeHighlight !== undefined) globalThis.__genshinCodeHighlight = this.settingsManager.globalSettings.codeHighlight;
        if (this.settingsManager?.globalSettings?.readExpanded !== undefined) globalThis.__genshinReadExpanded = this.settingsManager.globalSettings.readExpanded;
        if (this.settingsManager?.globalSettings?.executeBreakAnd !== undefined) globalThis.__genshinExecuteBreakAnd = this.settingsManager.globalSettings.executeBreakAnd;
        if (this.settingsManager?.globalSettings?.executeDisplay !== undefined) globalThis.__genshinExecuteDisplay = this.settingsManager.globalSettings.executeDisplay;
        if (this.settingsManager?.globalSettings?.tokenmaxxedColorful !== undefined) globalThis.__genshinTokenmaxxedColorful = this.settingsManager.globalSettings.tokenmaxxedColorful;
        if (this.settingsManager?.globalSettings?.showPinDev !== undefined) globalThis.__genshinShowPinDev = this.settingsManager.globalSettings.showPinDev;
        if (this.settingsManager?.globalSettings?.writeExpanded !== undefined) globalThis.__genshinWriteExpanded = this.settingsManager.globalSettings.writeExpanded;
        if (this.settingsManager?.globalSettings?.editExpanded !== undefined) globalThis.__genshinEditExpanded = this.settingsManager.globalSettings.editExpanded;
        globalThis.__genshinThinkingFirstLine = this.settingsManager?.globalSettings?.thinkingFirstLine ?? true;
        if (this.settingsManager?.globalSettings?.greetOnAttach !== undefined) globalThis.__genshinGreetOnAttach = this.settingsManager.globalSettings.greetOnAttach;
        if (this.settingsManager?.globalSettings?.unloadMode) globalThis.__genshinUnloadMode = this.settingsManager.globalSettings.unloadMode;
        // Expose session for /m /e commands
        globalThis.__genshinSetModel = (model) => this.session.setModel(model);
        globalThis.__genshinSetThinkingLevel = (level) => this.session.setThinkingLevel(level);
        globalThis.__genshinGetThinkingLevel = () => this.session.thinkingLevel;
        // ISSUE 079：长时间休眠卸载/唤醒重建钩子（heart-state/heart-hibernate 调用）
        globalThis.__genshinUnloadChat = () => this.unloadChatForHibernate();
        globalThis.__genshinRestoreChat = () => this.restoreChatAfterWake();
        // 窗口回到前台（FOCUS_IN）→ 自动重建消息区（只加载不唤醒，不发消息也能看到历史）
        globalThis.__genshinOnTuiFocusIn = () => this.restoreChatAfterWake();
        // 后台模式（PAIMON_BACKGROUND=1，2026-08-18）：启动即卸载消息区（零渲染/极低渲染）——
        // 多 agent 场景后台 agent 不占渲染资源（整树布局只剩状态栏/footer）；窗口焦点进入自动恢复
        // （__genshinOnTuiFocusIn → restoreChatAfterWake 从 session 历史重建）。PROPOSAL 034 阶段 4「按需渲染」过渡形态。
        if (process.env.PAIMON_BACKGROUND === "1") {
            this._chatUnloaded = true;
        }
        globalThis.__genshinGetModel = () => this.session.model;
        // 默认 effort: 强制设为 high（对应 DeepSeek max），清除旧版残留的 "max"
        const cur = this.session.thinkingLevel;
        if (cur === "off" || cur === "max") this.session.setThinkingLevel("high");
        // Register themes from resource loader and initialize
        setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
        if (!this.ui.onTerminalColorSchemeChange) this.ui.onTerminalColorSchemeChange = () => () => {};
        this.themeController = new InteractiveThemeController(this.ui, this.settingsManager, (message) => this.showError(message), () => { this.updateEditorBorderColor(); this._genshinSyncTerminalColors(); });
        // ISSUE 131 v1：非 iTerm2 终端启动即同步主题配色到终端默认 fg/bg（Linux dark=黑底浅字 / light=白底深字）
        this._genshinSyncTerminalColors();
    }
    /**
     * genshin 2026-09-05（ISSUE 131 v1）：Linux 终端背景色跟随 theme。
     * 根因：pi setTheme 只改组件前景色/内联背景块，从不发 OSC 10/11 设置终端默认配色——
     * 界面背景透出终端 profile 自己的颜色（Linux 默认紫红 vs Mac iTerm2 用户自配深色）。
     * v1：按 settings theme 发 OSC 10(fg)/11(bg) 写终端配色（dark=黑底浅字 / light=白底深字）。
     * 非 iTerm2 才生效（TERM_PROGRAM !== iTerm.app——iTerm2 用户自管配色，保住现观感）。
     * OSC 10/11 是 xterm 标准（ESC ] Ps ; Pt BEL），gnome-terminal/Windows Terminal/kitty 等普遍支持。
     * 退出恢复原背景（OSC 11 查询 + querier 框架）留 v2。
     */
    _genshinSyncTerminalColors() {
        try {
            if (process.env.TERM_PROGRAM === "iTerm.app") return; // iTerm2 用户自管配色
            const term = this.ui?.terminal;
            if (!term || typeof term.write !== "function") return;
            const theme = (this.settingsManager?.getThemeSetting?.() ?? "dark") + "";
            const dark = theme !== "light"; // dark/auto/undefined → 深色黑底
            const bg = dark ? "0000/0000/0000" : "ffff/ffff/ffff";
            const fg = dark ? "d4d4/d4d4/d4d4" : "1a1a/1a1a/1a1a";
            term.write(`\x1b]11;rgb:${bg}\x07`);
            term.write(`\x1b]10;rgb:${fg}\x07`);
        }
        catch (e) {
            console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] _genshinSyncTerminalColors: " + (e?.message || e));
        }
    }
    getAutocompleteSourceTag(sourceInfo) {
        if (!sourceInfo) {
            return undefined;
        }
        const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
        const source = sourceInfo.source.trim();
        if (source === "auto" || source === "local" || source === "cli") {
            return scopePrefix;
        }
        if (source.startsWith("npm:")) {
            return `${scopePrefix}:${source}`;
        }
        const gitSource = parseGitUrl(source);
        if (gitSource) {
            const ref = gitSource.ref ? `@${gitSource.ref}` : "";
            return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
        }
        return scopePrefix;
    }
    prefixAutocompleteDescription(description, sourceInfo) {
        return description || "";
    }
    getBuiltInCommandConflictDiagnostics(extensionRunner) {
        const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
        return extensionRunner
            .getRegisteredCommands()
            .filter((command) => builtinNames.has(command.name))
            .map((command) => ({
            type: "warning",
            message: command.invocationName === command.name
                ? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
                : `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
            path: command.sourceInfo.path,
        }));
    }
    createBaseAutocompleteProvider() {
        // Define commands for autocomplete
        const slashCommands = BUILTIN_SLASH_COMMANDS.map((command) => ({
            name: command.name,
            description: command.description,
            ...(command.argumentHint && { argumentHint: command.argumentHint }),
        }));
        const modelCommand = slashCommands.find((command) => command.name === "model");
        if (modelCommand) {
            modelCommand.getArgumentCompletions = (prefix) => {
                // Get available models (scoped or from registry)
                const models = this.session.scopedModels.length > 0
                    ? this.session.scopedModels.map((s) => s.model)
                    : this.session.modelRegistry.getAvailable();
                if (models.length === 0)
                    return null;
                // Create items with provider/id format
                const items = models.map((m) => ({
                    id: m.id,
                    provider: m.provider,
                    name: m.name,
                    label: `${m.provider}/${m.id}`,
                }));
                return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
                    value: item.label,
                    label: item.id,
                    description: item.provider,
                }));
            };
        }
        const loginCommand = slashCommands.find((command) => command.name === "login");
        if (loginCommand) {
            loginCommand.getArgumentCompletions = (prefix) => {
                const providers = getLoginProviderCompletionOptions(this.getLoginProviderOptions());
                return createFuzzyAutocompleteItems(providers, prefix, getLoginProviderSearchText, (provider) => ({
                    value: provider.id,
                    label: provider.id,
                    description: formatLoginProviderCompletionDescription(provider),
                }));
            };
        }
        // Convert prompt templates to SlashCommand format for autocomplete
        const templateCommands = this.session.promptTemplates.map((cmd) => ({
            name: cmd.name,
            description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
            ...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
        }));
        // Convert extension commands to SlashCommand format
        const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
        const extensionCommands = this.session.extensionRunner
            .getRegisteredCommands()
            .filter((cmd) => !builtinCommandNames.has(cmd.name))
            .map((cmd) => ({
            name: cmd.invocationName,
            description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
            getArgumentCompletions: cmd.getArgumentCompletions,
        }));
        // Build skill commands from session.skills (if enabled)
        this.skillCommands.clear();
        const skillCommandList = [];
        if (this.settingsManager.getEnableSkillCommands()) {
            for (const skill of this.session.resourceLoader.getSkills().skills) {
                const commandName = `skill:${skill.name}`;
                this.skillCommands.set(commandName, skill.filePath);
                skillCommandList.push({
                    name: commandName,
                    description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
                });
            }
        }
        // genshin: extension commands 按字母排序，排在 builtin 后面
        extensionCommands.sort((a, b) => a.name.localeCompare(b.name));
        // genshin: ...slashCommands(BUILTIN) 不传入 autocomplete，原生命令菜单已禁用
        return new CombinedAutocompleteProvider([...templateCommands, ...extensionCommands, ...skillCommandList], this.sessionManager.getCwd(), this.fdPath);
    }
    setupAutocompleteProvider() {
        let provider = this.createBaseAutocompleteProvider();
        const triggerCharacters = [];
        for (const wrapProvider of this.autocompleteProviderWrappers) {
            provider = wrapProvider(provider);
            triggerCharacters.push(...(provider.triggerCharacters ?? []));
        }
        if (triggerCharacters.length > 0) {
            provider.triggerCharacters = [...new Set(triggerCharacters)];
        }
        this.autocompleteProvider = provider;
        this.defaultEditor.setAutocompleteProvider(provider);
        if (this.editor !== this.defaultEditor) {
            this.editor.setAutocompleteProvider?.(provider);
        }
    }
    showStartupNoticesIfNeeded() {
        if (this.startupNoticesShown) {
            return;
        }
        this.startupNoticesShown = true;
        if (!this.changelogMarkdown) {
            return;
        }
        if (this.chatContainer.children.length > 0) {
            this.chatContainer.addChild(new Spacer(1));
        }
        this.chatContainer.addChild(new DynamicBorder());
        if (this.settingsManager.getCollapseChangelog()) {
            const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
            const latestVersion = versionMatch ? versionMatch[1] : this.version;
            const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
            this.chatContainer.addChild(new Text(condensedText, 1, 0));
        }
        else {
            this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
            this.chatContainer.addChild(new Spacer(1));
            this.chatContainer.addChild(new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()));
            this.chatContainer.addChild(new Spacer(1));
        }
        this.chatContainer.addChild(new DynamicBorder());
    }
    async init() {
        if (this.isInitialized)
            return;
        this.registerSignalHandlers();
        // Load changelog (only show new entries, skip for resumed sessions)
        this.changelogMarkdown = this.getChangelogForDisplay();
        // Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
        // Both are needed: fd for autocomplete, rg for grep tool and bash commands
        const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
        this.fdPath = fdPath;
        // 2026-09-08（用户怒批：启动刷 Model scope 全列是垃圾——"一个都不要"。代码不删只注释——若将来要恢复去注释即可）：
        // if (this.session.scopedModels.length > 0 && (this.options.verbose || !this.settingsManager.getQuietStartup())) {
        //     const modelList = this.session.scopedModels
        //         .map((sm) => {
        //         const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
        //         return `${sm.model.id}${thinkingStr}`;
        //     })
        //         .join(", ");
        //     const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
        //     const cycleHint = cycleKeys.length > 0
        //         ? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
        //         : "";
        //     console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
        // }
        // teyvat: 官方 0.84.1 —— documentContainer 包 header+loadedResources+chat（ScrollView 滚动内容）
        this.documentContainer = new Container();
        this.documentContainer.addChild(this.headerContainer);
        // Teyvat: 统一 header，从 version.json 读取
        {
            let genshinVer = VERSION, piVer = '', channel = '', pinnedDev = '';
            try {
                const v = JSON.parse(fs.readFileSync(os.homedir() + '/.teyvat/agent/version.json', 'utf8'));
                genshinVer = v.genshin || VERSION; piVer = v.pi || ''; channel = v.channel || ''; pinnedDev = v.pinnedDev || '';
            } catch(e) { try { fs.appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); } }
            // prerelease 显示实际 dev 号（alpha 号是发布管道内部的，用户不需要看）
            const displayVer = (channel === 'prerelease' && pinnedDev) ? pinnedDev : genshinVer;
            const logo = theme.bold(theme.fg("text", "Teyvat")) + theme.fg("dim", ` v${displayVer}`) + (piVer ? theme.fg("dim", ` (${channel ? channel + ', ' : ''}@pi v${piVer})`) : '');
            this.builtInHeader = new Text(logo, 1, 0);
            this.headerContainer.addChild(new Spacer(1));
            this.headerContainer.addChild(this.builtInHeader);
            this.headerContainer.addChild(new Spacer(1));
        }
        this.documentContainer.addChild(this.loadedResourcesContainer);
        this.documentContainer.addChild(this.chatContainer);
        this.ui.addChild(this.documentContainer);
        this.ui.addChild(this.pendingMessagesContainer);
        this.ui.addChild(this.statusContainer);
        this.renderWidgets(); // Initialize with default spacer
        this.ui.addChild(this.widgetContainerAbove);
        this.ui.addChild(this.editorContainer);
        this.ui.addChild(this.widgetContainerBelow);
        this.ui.addChild(this.footer);
        // teyvat: 官方 0.84.1 fullscreen 布局 —— transcript 独立滚动 + dock（输入框+状态栏）sticky 底部悬浮
        this.transcriptScrollView = new ScrollView(this.documentContainer, {
            follow: "end",
            primary: true,
            overscroll: "chain",
            // teyvat: 滚动跟随提示条 —— 占用 Editor 顶部 border 行（原本的黑行），不额外占行
            onFollowChange: (following) => {
                this._transcriptFollowing = following;
                if (following) {
                    this._unseenMessages = 0;
                    this.footer.setFollowHint(false);
                } else {
                    this.footer.setFollowHint(true, this._unseenMessages);
                }
                this.ui.requestRender();
            },
        });
        const dock = new VStack([
            { component: this.pendingMessagesContainer, shrink: 1, minSize: 0 },
            { component: this.statusContainer, shrink: 1, minSize: 0 },
            { component: this.widgetContainerAbove, shrink: 1, minSize: 0 },
            { component: this.editorContainer, shrink: 1, minSize: 3 },
            { component: this.widgetContainerBelow, shrink: 1, minSize: 0 },
            { component: this.footer, shrink: 1, minSize: 1 },
        ]);
        this.fullscreenLayoutRoot = new VStack([
            { component: this.transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
            { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
        ]);
        this.ui.setLayoutRoot(this.fullscreenLayoutRoot);
        this.ui.setFocus(this.editor);
        this.setupKeyHandlers();
        this.setupEditorSubmitHandler();
        // Teyvat: 清屏到最上方，再开始渲染
        process.stdout.write('\x1b[2J\x1b[H');
        // Start the UI before initializing extensions so session_start handlers can use interactive dialogs
        this.ui.start();
        this.isInitialized = true;
        // Teyvat: 必须先注册 onThemeChange，再 rebindCurrentSession。
        // rebindCurrentSession → applyFromSettings → setTheme 可能在首次启动时
        // 把主题从默认 dark 切到 light，若回调未注册，header 不会重建，
        // 导致浅色模式下白色字不可见。
        onThemeChange(() => {
            this.ui.invalidate();
            this.updateEditorBorderColor();
            if (this.builtInHeader) {
                let genshinVer = VERSION, piVer = '', channel = '', pinnedDev = '';
                try {
                    const v = JSON.parse(fs.readFileSync(os.homedir() + '/.teyvat/agent/version.json', 'utf8'));
                    genshinVer = v.genshin || VERSION; piVer = v.pi || ''; channel = v.channel || ''; pinnedDev = v.pinnedDev || '';
                } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                const displayVer = (channel === 'prerelease' && pinnedDev) ? pinnedDev : genshinVer;
                const logo = theme.bold(theme.fg("text", "Teyvat")) + theme.fg("dim", ` v${displayVer}`) + (piVer ? theme.fg("dim", ` (${channel ? channel + ', ' : ''}@pi v${piVer})`) : '');
                this.builtInHeader.setText(logo);
            }
            this.ui.requestRender();
        });
        // Initialize extensions first so resources are shown before messages
        await this.rebindCurrentSession();
        // Render initial messages AFTER showing loaded resources
        this.renderInitialMessages();
        // Set up git branch watcher (uses provider instead of footer)
        this.footerDataProvider.onBranchChange(() => {
            this.ui.requestRender();
        });
        // Initialize available provider count for footer display
        await this.updateAvailableProviderCount();
    }
    /**
     * Update terminal title with session name and cwd.
     */
    updateTerminalTitle() {
        // process.title already set by kernel: genshin:name(role,id,session)
        // iTerm2 picks it up as tab title
    }
    /**
     * Run the interactive mode. This is the main entry point.
     * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
     */
    async run() {
        await this.init();
        // 2026-09-07 双份渲染修复：删除 _replaySessionHistory() 调用——
        // init() 的 renderInitialMessages()（0904 已改走 renderSessionEntries 完整管线）已渲染当前 session 全部历史；
        // _replaySessionHistory 是 ISSUE 114 时代"pi 原生不渲染历史"的补丁，0904 后成为重复渲染（attach/恢复 session 时
        // 每条消息渲染两遍 → 屏幕内容翻倍重复、CPU 双倍、滚动区内容翻倍）。renderSessionItems 不清空 chatContainer，
        // 两次调用直接叠加。保留 _replayPreviousSession()（读 restart-session.json 渲染旧 session 文件，新 session 场景专用）。
        // genshin 2026-09-04：self-reboot 后渲染上一轮 session 历史（用户设计要求：session 保持新建，
        // 但新 session TUI 要重放旧 session 的上文，否则感觉很难受）
        this._replayPreviousSession();
        // ISSUE 114：自重启保留输入框草稿（wake-restart 标记 → 恢复 editor 内容；轮询保存）
        this._genshinInitInputDraft();
        // genshin: 版本由 install.sh 管理，禁用自动更新检查
        // Check tmux keyboard setup asynchronously
        this.checkTmuxKeyboardSetup().then((warning) => {
            if (warning) {
                this.showWarning(warning);
            }
        });
        // Show startup warnings
        const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;
        if (migratedProviders && migratedProviders.length > 0) {
            this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
        }
        const modelsJsonError = this.session.modelRegistry.getError();
        if (modelsJsonError) {
            this.showError(`models.json error: ${modelsJsonError}`);
        }
        if (modelFallbackMessage) {
            this.showWarning(modelFallbackMessage);
        }
        void this.maybeWarnAboutAnthropicSubscriptionAuth();
        // Process initial messages
        if (initialMessage) {
            try {
                await this.session.prompt(initialMessage, { images: initialImages });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                // teyvat ISSUE 089：启动期 API 错误（connection error / insufficient balance 等）
                // 不打红字 Error 块进 transcript——Error 块 + 两个 Spacer 贴在输入框上方，
                // 视觉上就是"输入框变成两行"。footer 短暂显示 + heart 的 WARN/Retrying 负责持续呈现。
                this.statusBar.setMessage(errorMessage);
            }
        }
        if (initialMessages) {
            for (const message of initialMessages) {
                try {
                    await this.session.prompt(message);
                }
                catch (error) {
                    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                    this.statusBar?.setMessage?.(errorMessage) ?? this.showStatus(errorMessage);
                }
            }
        }
        // Main interactive loop
        while (true) {
            const userInput = await this.getUserInput();
            try {
                await this.session.prompt(userInput);
                void 0;
                // ── 026-user-message-archive: 实时归档用户消息 ──
                try {
                    const dir = os.homedir() + '/.teyvat/AccountData';
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const agent = process.env.PAIMON_AGENT_NAME || process.env.PAIMON_AGENT_ID || 'unknown';
                    const agentId = process.env.PAIMON_AGENT_ID || '';
                    const session = this.sessionManager?.getSessionId?.() || '';
                    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ') + '+08:00';
                    const text = typeof userInput === 'string' ? userInput.trim() : JSON.stringify(userInput);
                    if (text) {
                        fs.appendFileSync(dir + '/user-messages.jsonl', JSON.stringify({ agent, agentId, session, ts, text }) + '\n');
                    }
                } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                // teyvat ISSUE 089：同上——API 错误走 footer，不打 transcript 红块
                this.statusBar.setMessage(errorMessage);
            }
        }
    }
    async checkForPackageUpdates() {
        if (process.env.PI_OFFLINE) {
            return [];
        }
        try {
            const packageManager = new DefaultPackageManager({
                cwd: this.sessionManager.getCwd(),
                agentDir: getAgentDir(),
                settingsManager: this.settingsManager,
            });
            const updates = await packageManager.checkForAvailableUpdates();
            return updates.map((update) => update.displayName);
        }
        catch {
            return [];
        }
    }
    async checkTmuxKeyboardSetup() {
        if (!process.env.TMUX)
            return undefined;
        const runTmuxShow = (option) => {
            return new Promise((resolve) => {
                const proc = spawn("tmux", ["show", "-gv", option], {
                    stdio: ["ignore", "pipe", "ignore"],
                });
                let stdout = "";
                const timer = setTimeout(() => {
                    proc.kill();
                    resolve(undefined);
                }, 2000);
                proc.stdout?.on("data", (data) => {
                    stdout += data.toString();
                });
                proc.on("error", () => {
                    clearTimeout(timer);
                    resolve(undefined);
                });
                proc.on("close", (code) => {
                    clearTimeout(timer);
                    resolve(code === 0 ? stdout.trim() : undefined);
                });
            });
        };
        const [extendedKeys, extendedKeysFormat] = await Promise.all([
            runTmuxShow("extended-keys"),
            runTmuxShow("extended-keys-format"),
        ]);
        // If we couldn't query tmux (timeout, sandbox, etc.), don't warn
        if (extendedKeys === undefined)
            return undefined;
        if (extendedKeys !== "on" && extendedKeys !== "always") {
            return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
        }
        if (extendedKeysFormat === "xterm") {
            return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
        }
        return undefined;
    }
    /**
     * Get changelog entries to display on startup.
     * Only shows new entries since last seen version, skips for resumed sessions.
     */
    getChangelogForDisplay() {
        // Skip changelog for resumed/continued sessions (already have messages)
        if (this.session.state.messages.length > 0) {
            return undefined;
        }
        const lastVersion = this.settingsManager.getLastChangelogVersion();
        const changelogPath = getChangelogPath();
        const entries = parseChangelog(changelogPath);
        if (!lastVersion) {
            // Fresh install - record the version, send telemetry, don't show changelog
            this.settingsManager.setLastChangelogVersion(VERSION);
            this.reportInstallTelemetry(VERSION);
            return undefined;
        }
        const newEntries = getNewEntries(entries, lastVersion);
        if (newEntries.length > 0) {
            this.settingsManager.setLastChangelogVersion(VERSION);
            this.reportInstallTelemetry(VERSION);
            return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
        }
        return undefined;
    }
    reportInstallTelemetry(version) {
        if (process.env.PI_OFFLINE) {
            return;
        }
        if (!isInstallTelemetryEnabled(this.settingsManager)) {
            return;
        }
        void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
            headers: {
                "User-Agent": getPiUserAgent(version),
            },
            signal: AbortSignal.timeout(5000),
        })
            .then(() => undefined)
            .catch(() => undefined);
    }
    getMarkdownThemeWithSettings() {
        return {
            ...getMarkdownTheme(),
            codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
            highlightCode: (code, lang) => highlightCode(code, lang),
        };
    }
    // =========================================================================
    // Extension System
    // =========================================================================
    formatDisplayPath(p) {
        const home = os.homedir();
        let result = p;
        // Replace home directory with ~
        if (result.startsWith(home)) {
            result = `~${result.slice(home.length)}`;
        }
        return result;
    }
    formatExtensionDisplayPath(path) {
        let result = this.formatDisplayPath(path);
        result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
        return result;
    }
    formatContextPath(p) {
        const cwd = path.resolve(this.sessionManager.getCwd());
        const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
        const relativePath = getCwdRelativePath(absolutePath, cwd);
        if (relativePath !== undefined) {
            return relativePath;
        }
        return this.formatDisplayPath(absolutePath);
    }
    getStartupExpansionState() {
        return this.options.verbose || this.toolOutputExpanded;
    }
    /**
     * Get a short path relative to the package root for display.
     */
    getShortPath(fullPath, sourceInfo) {
        const baseDir = sourceInfo?.baseDir;
        if (baseDir && this.isPackageSource(sourceInfo)) {
            const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
            if (relativePath &&
                relativePath !== "." &&
                !relativePath.startsWith("..") &&
                !relativePath.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relativePath)) {
                return relativePath.replace(/\\/g, "/");
            }
        }
        const source = sourceInfo?.source ?? "";
        const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
        if (npmMatch && source.startsWith("npm:")) {
            return npmMatch[2];
        }
        const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
        if (gitMatch && source.startsWith("git:")) {
            return gitMatch[1];
        }
        return this.formatDisplayPath(fullPath);
    }
    getCompactPathLabel(resourcePath, sourceInfo) {
        const shortPath = this.getShortPath(resourcePath, sourceInfo);
        const normalizedPath = shortPath.replace(/\\/g, "/");
        const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
        if (segments.length > 0) {
            return segments[segments.length - 1];
        }
        return shortPath;
    }
    getCompactPackageSourceLabel(sourceInfo) {
        const source = sourceInfo?.source ?? "";
        if (source.startsWith("npm:")) {
            return source.slice("npm:".length) || source;
        }
        const gitSource = parseGitUrl(source);
        if (gitSource) {
            return gitSource.path || source;
        }
        return source;
    }
    getCompactExtensionLabel(resourcePath, sourceInfo) {
        if (!this.isPackageSource(sourceInfo)) {
            return this.getCompactPathLabel(resourcePath, sourceInfo);
        }
        const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
        if (!sourceLabel) {
            return this.getCompactPathLabel(resourcePath, sourceInfo);
        }
        const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
        const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
        const parsedPath = path.posix.parse(packagePath);
        if (parsedPath.name === "index") {
            return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
        }
        return `${sourceLabel}:${packagePath}`;
    }
    getCompactDisplayPathSegments(resourcePath) {
        return this.formatDisplayPath(resourcePath)
            .replace(/\\/g, "/")
            .split("/")
            .filter((segment) => segment.length > 0 && segment !== "~");
    }
    getCompactNonPackageExtensionLabel(resourcePath, index, allPaths) {
        const segments = allPaths[index]?.segments;
        if (!segments || segments.length === 0) {
            return this.getCompactPathLabel(resourcePath);
        }
        for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
            const candidate = segments.slice(-segmentCount).join("/");
            const isUnique = allPaths.every((item, itemIndex) => {
                if (itemIndex === index) {
                    return true;
                }
                return item.segments.slice(-segmentCount).join("/") !== candidate;
            });
            if (isUnique) {
                return candidate;
            }
        }
        return segments.join("/");
    }
    getCompactExtensionLabels(extensions) {
        const nonPackageExtensions = extensions
            .map((extension) => {
            const segments = this.getCompactDisplayPathSegments(extension.path);
            const lastSegment = segments[segments.length - 1];
            if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
                segments.pop();
            }
            return {
                path: extension.path,
                sourceInfo: extension.sourceInfo,
                segments,
            };
        })
            .filter((extension) => !this.isPackageSource(extension.sourceInfo));
        return extensions.map((extension) => {
            if (this.isPackageSource(extension.sourceInfo)) {
                return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
            }
            const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
            if (nonPackageIndex === -1) {
                return this.getCompactPathLabel(extension.path, extension.sourceInfo);
            }
            return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
        });
    }
    getDisplaySourceInfo(sourceInfo) {
        const source = sourceInfo?.source ?? "local";
        const scope = sourceInfo?.scope ?? "project";
        if (source === "local") {
            if (scope === "user") {
                return { label: "user", color: "muted" };
            }
            if (scope === "project") {
                return { label: "project", color: "muted" };
            }
            if (scope === "temporary") {
                return { label: "path", scopeLabel: "temp", color: "muted" };
            }
            return { label: "path", color: "muted" };
        }
        if (source === "cli") {
            return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
        }
        const scopeLabel = scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
        return { label: source, scopeLabel, color: "accent" };
    }
    getScopeGroup(sourceInfo) {
        const source = sourceInfo?.source ?? "local";
        const scope = sourceInfo?.scope ?? "project";
        if (source === "cli" || scope === "temporary")
            return "path";
        if (scope === "user")
            return "user";
        if (scope === "project")
            return "project";
        return "path";
    }
    isPackageSource(sourceInfo) {
        const source = sourceInfo?.source ?? "";
        return source.startsWith("npm:") || source.startsWith("git:");
    }
    buildScopeGroups(items) {
        const groups = {
            user: { scope: "user", paths: [], packages: new Map() },
            project: { scope: "project", paths: [], packages: new Map() },
            path: { scope: "path", paths: [], packages: new Map() },
        };
        for (const item of items) {
            const groupKey = this.getScopeGroup(item.sourceInfo);
            const group = groups[groupKey];
            const source = item.sourceInfo?.source ?? "local";
            if (this.isPackageSource(item.sourceInfo)) {
                const list = group.packages.get(source) ?? [];
                list.push(item);
                group.packages.set(source, list);
            }
            else {
                group.paths.push(item);
            }
        }
        return [groups.project, groups.user, groups.path].filter((group) => group.paths.length > 0 || group.packages.size > 0);
    }
    formatScopeGroups(groups, options) {
        const lines = [];
        for (const group of groups) {
            lines.push(`  ${theme.fg("accent", group.scope)}`);
            const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
            for (const item of sortedPaths) {
                lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
            }
            const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
            for (const [source, items] of sortedPackages) {
                lines.push(`    ${theme.fg("mdLink", source)}`);
                const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
                for (const item of sortedPackagePaths) {
                    lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
                }
            }
        }
        return lines.join("\n");
    }
    findSourceInfoForPath(p, sourceInfos) {
        const exact = sourceInfos.get(p);
        if (exact)
            return exact;
        let current = p;
        while (current.includes("/")) {
            current = current.substring(0, current.lastIndexOf("/"));
            const parent = sourceInfos.get(current);
            if (parent)
                return parent;
        }
        return undefined;
    }
    formatPathWithSource(p, sourceInfo) {
        if (sourceInfo) {
            const shortPath = this.getShortPath(p, sourceInfo);
            const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
            const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
            return `${labelText} ${shortPath}`;
        }
        return this.formatDisplayPath(p);
    }
    formatDiagnostics(diagnostics, sourceInfos) {
        const lines = [];
        // Group collision diagnostics by name
        const collisions = new Map();
        const otherDiagnostics = [];
        for (const d of diagnostics) {
            if (d.type === "collision" && d.collision) {
                const list = collisions.get(d.collision.name) ?? [];
                list.push(d);
                collisions.set(d.collision.name, list);
            }
            else {
                otherDiagnostics.push(d);
            }
        }
        // Format collision diagnostics grouped by name
        for (const [name, collisionList] of collisions) {
            const first = collisionList[0]?.collision;
            if (!first)
                continue;
            lines.push(theme.fg("warning", `  "${name}" collision:`));
            lines.push(theme.fg("dim", `    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`));
            for (const d of collisionList) {
                if (d.collision) {
                    lines.push(theme.fg("dim", `    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`));
                }
            }
        }
        for (const d of otherDiagnostics) {
            if (d.path) {
                const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
                lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
                lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
            }
            else {
                lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
            }
        }
        return lines.join("\n");
    }
    showLoadedResources(options) {
        // Resource rendering is idempotent; chat clears no longer clear this separate container.
        this.loadedResourcesContainer.clear();
        const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
        const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
        if (!showListing && !showDiagnostics) {
            return;
        }
        const sectionHeader = (name, color = "mdHeading") => theme.fg(color, `[${name}]`);
        const formatCompactList = (items, options) => {
            const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
            if (options?.sort !== false) {
                labels.sort((a, b) => a.localeCompare(b));
            }
            return theme.fg("dim", `  ${labels.join(", ")}`);
        };
        const addLoadedSection = (name, collapsedBody, expandedBody = collapsedBody, color = "mdHeading") => {
            const section = new ExpandableText(() => `${sectionHeader(name, color)}\n${collapsedBody}`, () => `${sectionHeader(name, color)}\n${expandedBody}`, this.getStartupExpansionState(), 0, 0);
            this.loadedResourcesContainer.addChild(section);
            this.loadedResourcesContainer.addChild(new Spacer(1));
        };
        const skillsResult = this.session.resourceLoader.getSkills();
        const promptsResult = this.session.resourceLoader.getPrompts();
        const themesResult = this.session.resourceLoader.getThemes();
        const extensions = options?.extensions ??
            this.session.resourceLoader.getExtensions().extensions.map((extension) => ({
                path: extension.path,
                sourceInfo: extension.sourceInfo,
            }));
        const sourceInfos = new Map();
        for (const extension of extensions) {
            if (extension.sourceInfo) {
                sourceInfos.set(extension.path, extension.sourceInfo);
            }
        }
        for (const skill of skillsResult.skills) {
            if (skill.sourceInfo) {
                sourceInfos.set(skill.filePath, skill.sourceInfo);
            }
        }
        for (const prompt of promptsResult.prompts) {
            if (prompt.sourceInfo) {
                sourceInfos.set(prompt.filePath, prompt.sourceInfo);
            }
        }
        for (const loadedTheme of themesResult.themes) {
            if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
                sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
            }
        }
        if (showListing) {
            const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
            if (contextFiles.length > 0) {
                this.loadedResourcesContainer.addChild(new Spacer(1));
                const contextList = contextFiles
                    .map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
                    .join("\n");
                const contextCompactList = formatCompactList(contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)), { sort: false });
                addLoadedSection("Context", contextCompactList, contextList);
            }
            // teyvat: 跳过 Skills 显示（静默启动）
            // const skills = skillsResult.skills;
            // if (skills.length > 0) { ... addLoadedSection("Skills", ...); }
            const templates = this.session.promptTemplates;
            if (templates.length > 0) {
                const groups = this.buildScopeGroups(templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })));
                const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
                const templateList = this.formatScopeGroups(groups, {
                    formatPath: (item) => {
                        const template = templateByPath.get(item.path);
                        return template ? `/${template.name}` : this.formatDisplayPath(item.path);
                    },
                    formatPackagePath: (item) => {
                        const template = templateByPath.get(item.path);
                        return template ? `/${template.name}` : this.formatDisplayPath(item.path);
                    },
                });
                const promptCompactList = formatCompactList(templates.map((template) => `/${template.name}`));
                addLoadedSection("Prompts", promptCompactList, templateList);
            }
            // teyvat: 跳过 Extensions 显示（静默启动）
            // if (extensions.length > 0) { ... addLoadedSection("Extensions", ...); }
            // Show loaded themes (excluding built-in)
            const loadedThemes = themesResult.themes;
            const customThemes = loadedThemes.filter((t) => t.sourcePath);
            if (customThemes.length > 0) {
                const groups = this.buildScopeGroups(customThemes.map((loadedTheme) => ({
                    path: loadedTheme.sourcePath,
                    sourceInfo: loadedTheme.sourceInfo,
                })));
                const themeList = this.formatScopeGroups(groups, {
                    formatPath: (item) => this.formatDisplayPath(item.path),
                    formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
                });
                const themeCompactList = formatCompactList(customThemes.map((loadedTheme) => loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath, loadedTheme.sourceInfo)));
                addLoadedSection("Themes", themeCompactList, themeList);
            }
        }
        if (showDiagnostics) {
            const skillDiagnostics = skillsResult.diagnostics;
            if (skillDiagnostics.length > 0) {
                const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
                this.loadedResourcesContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
                this.loadedResourcesContainer.addChild(new Spacer(1));
            }
            const promptDiagnostics = promptsResult.diagnostics;
            if (promptDiagnostics.length > 0) {
                const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
                this.loadedResourcesContainer.addChild(new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0));
                this.loadedResourcesContainer.addChild(new Spacer(1));
            }
            const extensionDiagnostics = [];
            const extensionErrors = this.session.resourceLoader.getExtensions().errors;
            if (extensionErrors.length > 0) {
                for (const error of extensionErrors) {
                    extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
                }
            }
            const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
            extensionDiagnostics.push(...commandDiagnostics);
            extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));
            const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics()
                .filter(d => d.message && !d.message.includes("shortcut 'escape'")); // teyvat: 忽略 escape 快捷键冲突
            extensionDiagnostics.push(...shortcutDiagnostics);
            if (extensionDiagnostics.length > 0) {
                const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
                this.loadedResourcesContainer.addChild(new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0));
                this.loadedResourcesContainer.addChild(new Spacer(1));
            }
            const themeDiagnostics = themesResult.diagnostics;
            if (themeDiagnostics.length > 0) {
                const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
                this.loadedResourcesContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
                this.loadedResourcesContainer.addChild(new Spacer(1));
            }
        }
    }
    /**
     * Initialize the extension system with TUI-based UI context.
     */
    async bindCurrentSessionExtensions() {
        const uiContext = this.createExtensionUIContext();
        await this.session.bindExtensions({
            uiContext,
            mode: "tui",
            abortHandler: () => {
                this.restoreQueuedMessagesToEditor({ abort: true });
            },
            commandContextActions: {
                waitForIdle: () => this.session.waitForIdle(),
                newSession: async (options) => {
                    this.clearStatusIndicator();
                    try {
                        return await this.runtimeHost.newSession(options);
                    }
                    catch (error) {
                        return this.handleFatalRuntimeError("Failed to create session", error);
                    }
                },
                fork: async (entryId, options) => {
                    try {
                        const result = await this.runtimeHost.fork(entryId, options);
                        if (!result.cancelled) {
                            this.editor.setText(result.selectedText ?? "");
                            this.showStatus("Forked to new session");
                        }
                        return { cancelled: result.cancelled };
                    }
                    catch (error) {
                        return this.handleFatalRuntimeError("Failed to fork session", error);
                    }
                },
                navigateTree: async (targetId, options) => {
                    const result = await this.session.navigateTree(targetId, {
                        summarize: options?.summarize,
                        customInstructions: options?.customInstructions,
                        replaceInstructions: options?.replaceInstructions,
                        label: options?.label,
                    });
                    if (result.cancelled) {
                        return { cancelled: true };
                    }
                    this.chatContainer.clear();
                    this.renderInitialMessages();
                    if (result.editorText && !this.editor.getText().trim()) {
                        this.editor.setText(result.editorText);
                    }
                    this.showStatus("Navigated to selected point");
                    void this.flushCompactionQueue({ willRetry: false });
                    return { cancelled: false };
                },
                switchSession: async (sessionPath, options) => {
                    return this.handleResumeSession(sessionPath, options);
                },
                reload: async () => {
                    await this.handleReloadCommand();
                },
            },
            shutdownHandler: () => {
                this.shutdownRequested = true;
                if (this.session.isIdle) {
                    void this.shutdown();
                }
            },
            onError: (error) => {
                this.showExtensionError(error.extensionPath, error.error, error.stack);
            },
        });
        setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
        this.setupAutocompleteProvider();
        const extensionRunner = this.session.extensionRunner;
        this.setupExtensionShortcuts(extensionRunner);
        this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
        this.showStartupNoticesIfNeeded();
    }
    applyRuntimeSettings() {
        configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
        this.footer.setSession(this.session);
        this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
        this.footerDataProvider.setCwd(this.sessionManager.getCwd());
        this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
        this.outputPad = this.settingsManager.getOutputPad();
        this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
        const clearOnShrink = this.settingsManager.getClearOnShrink();
        this.ui.setClearOnShrink(clearOnShrink);
        if (!clearOnShrink && !this.activeStatusIndicator) {
            this.statusContainer.clear();
        }
        const editorPaddingX = this.settingsManager.getEditorPaddingX();
        const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
        this.defaultEditor.setPaddingX(editorPaddingX);
        this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
        if (this.editor !== this.defaultEditor) {
            this.editor.setPaddingX?.(editorPaddingX);
            this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
        }
    }
    async rebindCurrentSession(options = {}) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.applyRuntimeSettings();
        if (options.renderBeforeBind) {
            this.renderCurrentSessionState();
            this.subscribeToAgent();
            await this.bindCurrentSessionExtensions();
        }
        else {
            await this.bindCurrentSessionExtensions();
            this.subscribeToAgent();
        }
        await this.updateAvailableProviderCount();
        this.updateEditorBorderColor();
        this.updateTerminalTitle();
    }
    async handleFatalRuntimeError(prefix, error) {
        const message = error instanceof Error ? error.message : String(error);
        this.showError(`${prefix}: ${message}`);
        stopThemeWatcher();
        this.stop();
        process.exit(1);
    }
    renderCurrentSessionState() {
        this.loadedResourcesContainer.clear();
        this.chatContainer.clear();
        this.pendingMessagesContainer.clear();
        this.compactionQueuedMessages = [];
        this.streamingComponent = undefined;
        this.streamingMessage = undefined;
        this.pendingTools.clear();
        this.renderInitialMessages();
    }
    /**
     * Get a registered tool definition by name (for custom rendering).
     */
    getRegisteredToolDefinition(toolName) {
        return this.session.getToolDefinition(toolName);
    }
    /**
     * Set up keyboard shortcuts registered by extensions.
     */
    setupExtensionShortcuts(extensionRunner) {
        const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
        if (shortcuts.size === 0)
            return;
        // Create a context for shortcut handlers
        const createContext = () => ({
            ui: this.createExtensionUIContext(),
            mode: "tui",
            hasUI: true,
            cwd: this.sessionManager.getCwd(),
            sessionManager: this.sessionManager,
            modelRegistry: this.session.modelRegistry,
            model: this.session.model,
            isIdle: () => this.session.isIdle,
            isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
            signal: this.session.agent.signal,
            abort: () => {
                this.restoreQueuedMessagesToEditor({ abort: true });
            },
            hasPendingMessages: () => this.session.pendingMessageCount > 0,
            shutdown: () => {
                this.shutdownRequested = true;
            },
            getContextUsage: () => this.session.getContextUsage(),
            compact: (options) => {
                void (async () => {
                    try {
                        const result = await this.session.compact(options?.customInstructions);
                        options?.onComplete?.(result);
                    }
                    catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        options?.onError?.(err);
                    }
                })();
            },
            getSystemPrompt: () => this.session.systemPrompt,
        });
        // Set up the extension shortcut handler on the default editor
        this.defaultEditor.onExtensionShortcut = (data) => {
            for (const [shortcutStr, shortcut] of shortcuts) {
                // Cast to KeyId - extension shortcuts use the same format
                if (matchesKey(data, shortcutStr)) {
                    // Run handler async, don't block input
                    Promise.resolve(shortcut.handler(createContext())).catch((err) => {
                        this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
                    });
                    return true;
                }
            }
            return false;
        };
    }
    /**
     * Set extension status text in the footer.
     */
    setExtensionStatus(key, text) {
        if (key === "genshin-status") {
            this.statusBar.transition(text);
            return;
        }
        this.footerDataProvider.setExtensionStatus(key, text);
        this.ui.requestRender();
    }
    // @deprecated
    showStatusIndicator(_indicator, _footerMessage) {}
    // @deprecated
    clearStatusIndicator(_kind) {}
    setWorkingIndicator(options) {
        this.workingIndicatorOptions = options;
        this.ui.requestRender();
    }
    setHiddenThinkingLabel(label) {
        this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
        for (const child of this.chatContainer.children) {
            if (child instanceof AssistantMessageComponent) {
                child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
            }
        }
        if (this.streamingComponent) {
            this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
        }
        this.ui.requestRender();
    }
    /**
     * Set an extension widget (string array or custom component).
     */
    setExtensionWidget(key, content, options) {
        const placement = options?.placement ?? "aboveEditor";
        const removeExisting = (map) => {
            const existing = map.get(key);
            if (existing?.dispose)
                existing.dispose();
            map.delete(key);
        };
        removeExisting(this.extensionWidgetsAbove);
        removeExisting(this.extensionWidgetsBelow);
        if (content === undefined) {
            this.renderWidgets();
            return;
        }
        let component;
        if (Array.isArray(content)) {
            // Wrap string array in a Container with Text components
            const container = new Container();
            for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
                container.addChild(new Text(line, 1, 0));
            }
            if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
                container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
            }
            component = container;
        }
        else {
            // Factory function - create component
            component = content(this.ui, theme);
        }
        const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
        targetMap.set(key, component);
        this.renderWidgets();
    }
    clearExtensionWidgets() {
        for (const widget of this.extensionWidgetsAbove.values()) {
            widget.dispose?.();
        }
        for (const widget of this.extensionWidgetsBelow.values()) {
            widget.dispose?.();
        }
        this.extensionWidgetsAbove.clear();
        this.extensionWidgetsBelow.clear();
        this.renderWidgets();
    }
    resetExtensionUI() {
        if (this.extensionSelector) {
            this.hideExtensionSelector();
        }
        if (this.extensionInput) {
            this.hideExtensionInput();
        }
        if (this.extensionEditor) {
            this.hideExtensionEditor();
        }
        this.ui.hideOverlay();
        this.clearExtensionTerminalInputListeners();
        this.setExtensionFooter(undefined);
        this.setExtensionHeader(undefined);
        this.clearExtensionWidgets();
        this.footerDataProvider.clearExtensionStatuses();
        this.footer.invalidate();
        this.autocompleteProviderWrappers = [];
        this.setCustomEditorComponent(undefined);
        this.setupAutocompleteProvider();
        this.defaultEditor.onExtensionShortcut = undefined;
        this.updateTerminalTitle();
        this.setWorkingIndicator();
        this.setHiddenThinkingLabel();
    }
    // Maximum total widget lines to prevent viewport overflow
    static MAX_WIDGET_LINES = 10;
    /**
     * Render all extension widgets to the widget container.
     */
    renderWidgets() {
        if (!this.widgetContainerAbove || !this.widgetContainerBelow)
            return;
        this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
        this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
        this.ui.requestRender();
    }
    renderWidgetContainer(container, widgets, spacerWhenEmpty, leadingSpacer) {
        container.clear();
        if (widgets.size === 0) {
            if (spacerWhenEmpty) {
                container.addChild(new Spacer(1));
            }
            return;
        }
        if (leadingSpacer) {
            container.addChild(new Spacer(1));
        }
        for (const component of widgets.values()) {
            container.addChild(component);
        }
    }
    /**
     * Set a custom footer component, or restore the built-in footer.
     */
    setExtensionFooter(factory) {
        // Dispose existing custom footer
        if (this.customFooter?.dispose) {
            this.customFooter.dispose();
        }
        // Remove current footer from UI
        if (this.customFooter) {
            this.ui.removeChild(this.customFooter);
        }
        else {
            this.ui.removeChild(this.footer);
        }
        if (factory) {
            // Create and add custom footer, passing the data provider
            this.customFooter = factory(this.ui, theme, this.footerDataProvider);
            this.ui.addChild(this.customFooter);
        }
        else {
            // Restore built-in footer
            this.customFooter = undefined;
            this.ui.addChild(this.footer);
        }
        this.ui.requestRender();
    }
    /**
     * Set a custom header component, or restore the built-in header.
     */
    setExtensionHeader(factory) {
        // Header may not be initialized yet if called during early initialization
        if (!this.builtInHeader) {
            return;
        }
        // Dispose existing custom header
        if (this.customHeader?.dispose) {
            this.customHeader.dispose();
        }
        // Find the index of the current header in the header container
        const currentHeader = this.customHeader || this.builtInHeader;
        const index = this.headerContainer.children.indexOf(currentHeader);
        if (factory) {
            // Create and add custom header
            this.customHeader = factory(this.ui, theme);
            if (isExpandable(this.customHeader)) {
                this.customHeader.setExpanded(this.toolOutputExpanded);
            }
            if (index !== -1) {
                this.headerContainer.children[index] = this.customHeader;
            }
            else {
                // If not found (e.g. builtInHeader was never added), add at the top
                this.headerContainer.children.unshift(this.customHeader);
            }
        }
        else {
            // Restore built-in header
            this.customHeader = undefined;
            if (isExpandable(this.builtInHeader)) {
                this.builtInHeader.setExpanded(this.toolOutputExpanded);
            }
            if (index !== -1) {
                this.headerContainer.children[index] = this.builtInHeader;
            }
        }
        this.ui.requestRender();
    }
    addExtensionTerminalInputListener(handler) {
        const unsubscribe = this.ui.addInputListener(handler);
        this.extensionTerminalInputUnsubscribers.add(unsubscribe);
        return () => {
            unsubscribe();
            this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
        };
    }
    clearExtensionTerminalInputListeners() {
        for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
            unsubscribe();
        }
        this.extensionTerminalInputUnsubscribers.clear();
    }
    /**
     * Create the ExtensionUIContext for extensions.
     */
    createProjectTrustContext(cwd) {
        const ui = this.createExtensionUIContext();
        return {
            cwd,
            mode: "tui",
            hasUI: true,
            ui: {
                select: ui.select,
                confirm: ui.confirm,
                input: ui.input,
                notify: ui.notify,
            },
        };
    }
    createExtensionUIContext() {
        return {
            select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
            confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
            input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
            notify: (message, type) => this.showExtensionNotify(message, type),
            // heart-state.refreshUI 的桥：状态变化（wait 黄点→绿/红等）需要真实 TUI 级联刷新。
            // 此前 ctx.ui 无这两个方法，refreshUI 静默空转——wait 完成后点永远停在黄色。
            invalidate: () => this.ui.invalidate(),
            requestRender: () => this.ui.requestRender(),
            onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
            setStatus: (key, text) => this.setExtensionStatus(key, text),
            setWorkingMessage: (message) => this.statusBar.setMessage(message),
            setWorkingVisible: () => {},
            setWorkingIndicator: (options) => this.setWorkingIndicator(options),
            setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
            setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
            setFooter: (factory) => this.setExtensionFooter(factory),
            setHeader: (factory) => this.setExtensionHeader(factory),
            setTitle: (title) => this.ui.terminal.setTitle(title),
            custom: (factory, options) => this.showExtensionCustom(factory, options),
            pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
            setEditorText: (text) => this.editor.setText(text),
            getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
            editor: (title, prefill) => this.showExtensionEditor(title, prefill),
            addAutocompleteProvider: (factory) => {
                this.autocompleteProviderWrappers.push(factory);
                this.setupAutocompleteProvider();
            },
            setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
            getEditorComponent: () => this.editorComponentFactory,
            get theme() {
                return theme;
            },
            getAllThemes: () => getAvailableThemesWithPaths(),
            getTheme: (name) => getThemeByName(name),
            setTheme: (themeOrName) => {
                if (themeOrName instanceof Theme) {
                    return this.themeController.setThemeInstance(themeOrName);
                }
                const result = this.themeController.setThemeName(themeOrName);
                if (result.success) {
                    if (this.settingsManager.getTheme() !== themeOrName) {
                        this.settingsManager.setTheme(themeOrName);
                    }
                }
                return result;
            },
            getToolsExpanded: () => this.toolOutputExpanded,
            setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
        };
    }
    /**
     * Show a selector for extensions.
     */
    showExtensionSelector(title, options, opts) {
        return new Promise((resolve) => {
            if (opts?.signal?.aborted) {
                resolve(undefined);
                return;
            }
            const onAbort = () => {
                this.hideExtensionSelector();
                resolve(undefined);
            };
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            this.extensionSelector = new ExtensionSelectorComponent(title, options, (option) => {
                opts?.signal?.removeEventListener("abort", onAbort);
                this.hideExtensionSelector();
                resolve(option);
            }, () => {
                opts?.signal?.removeEventListener("abort", onAbort);
                this.hideExtensionSelector();
                resolve(undefined);
            }, { tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() });
            this.editorContainer.clear();
            this.editorContainer.addChild(this.extensionSelector);
            this.ui.setFocus(this.extensionSelector);
            this.ui.requestRender();
        });
    }
    /**
     * Hide the extension selector.
     */
    hideExtensionSelector() {
        this.extensionSelector?.dispose();
        this.editorContainer.clear();
        this.editorContainer.addChild(this.editor);
        this.extensionSelector = undefined;
        this.ui.setFocus(this.editor);
        this.ui.requestRender();
    }
    /**
     * Show a confirmation dialog for extensions.
     */
    async showExtensionConfirm(title, message, opts) {
        const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
        return result === "Yes";
    }
    async promptForMissingSessionCwd(error) {
        const confirmed = await this.showExtensionConfirm("Session cwd not found", formatMissingSessionCwdPrompt(error.issue));
        return confirmed ? error.issue.fallbackCwd : undefined;
    }
    /**
     * Show a text input for extensions.
     */
    showExtensionInput(title, placeholder, opts) {
        return new Promise((resolve) => {
            if (opts?.signal?.aborted) {
                resolve(undefined);
                return;
            }
            const onAbort = () => {
                this.hideExtensionInput();
                resolve(undefined);
            };
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            this.extensionInput = new ExtensionInputComponent(title, placeholder, (value) => {
                opts?.signal?.removeEventListener("abort", onAbort);
                this.hideExtensionInput();
                resolve(value);
            }, () => {
                opts?.signal?.removeEventListener("abort", onAbort);
                this.hideExtensionInput();
                resolve(undefined);
            }, { tui: this.ui, timeout: opts?.timeout });
            this.editorContainer.clear();
            this.editorContainer.addChild(this.extensionInput);
            this.ui.setFocus(this.extensionInput);
            this.ui.requestRender();
        });
    }
    /**
     * Hide the extension input.
     */
    hideExtensionInput() {
        this.extensionInput?.dispose();
        this.editorContainer.clear();
        this.editorContainer.addChild(this.editor);
        this.extensionInput = undefined;
        this.ui.setFocus(this.editor);
        this.ui.requestRender();
    }
    /**
     * Show a multi-line editor for extensions (with Ctrl+G support).
     */
    showExtensionEditor(title, prefill) {
        return new Promise((resolve) => {
            this.extensionEditor = new ExtensionEditorComponent(this.ui, this.keybindings, title, prefill, (value) => {
                this.hideExtensionEditor();
                resolve(value);
            }, () => {
                this.hideExtensionEditor();
                resolve(undefined);
            }, undefined, this.settingsManager.getExternalEditorCommand());
            this.editorContainer.clear();
            this.editorContainer.addChild(this.extensionEditor);
            this.ui.setFocus(this.extensionEditor);
            this.ui.requestRender();
        });
    }
    /**
     * Hide the extension editor.
     */
    hideExtensionEditor() {
        this.editorContainer.clear();
        this.editorContainer.addChild(this.editor);
        this.extensionEditor = undefined;
        this.ui.setFocus(this.editor);
        this.ui.requestRender();
    }
    /**
     * Set a custom editor component from an extension.
     * Pass undefined to restore the default editor.
     */
    setCustomEditorComponent(factory) {
        this.editorComponentFactory = factory;
        // Save text from current editor before switching
        const currentText = this.editor.getText();
        this.editorContainer.clear();
        if (factory) {
            // Create the custom editor with tui, theme, and keybindings
            const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);
            // Wire up callbacks from the default editor
            newEditor.onSubmit = this.defaultEditor.onSubmit;
            newEditor.onChange = this.defaultEditor.onChange;
            // Copy text from previous editor
            newEditor.setText(currentText);
            // Copy appearance settings if supported
            if (newEditor.borderColor !== undefined) {
                newEditor.borderColor = this.defaultEditor.borderColor;
            }
            if (newEditor.setPaddingX !== undefined) {
                newEditor.setPaddingX(this.defaultEditor.getPaddingX());
            }
            // Set autocomplete if supported
            if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
                newEditor.setAutocompleteProvider(this.autocompleteProvider);
            }
            // If extending CustomEditor, copy app-level handlers
            // Use duck typing since instanceof fails across jiti module boundaries
            const customEditor = newEditor;
            if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
                if (!customEditor.onEscape) {
                    customEditor.onEscape = () => this.defaultEditor.onEscape?.();
                }
                if (!customEditor.onCtrlD) {
                    customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
                }
                if (!customEditor.onPasteImage) {
                    customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
                }
                if (!customEditor.onExtensionShortcut) {
                    customEditor.onExtensionShortcut = (data) => this.defaultEditor.onExtensionShortcut?.(data);
                }
                // Copy action handlers (clear, suspend, model switching, etc.)
                for (const [action, handler] of this.defaultEditor.actionHandlers) {
                    customEditor.actionHandlers.set(action, handler);
                }
            }
            this.editor = newEditor;
        }
        else {
            // Restore default editor with text from custom editor
            this.defaultEditor.setText(currentText);
            this.editor = this.defaultEditor;
        }
        this.editorContainer.addChild(this.editor);
        this.ui.setFocus(this.editor);
        this.ui.requestRender();
    }
    /**
     * Show a notification for extensions.
     */
    showExtensionNotify(message, type) {
        if (type === "error") {
            this.showError(message);
        }
        else if (type === "warning") {
            this.showWarning(message);
        }
        else {
            this.showStatus(message);
        }
    }
    /** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
    async showExtensionCustom(factory, options) {
        const savedText = this.editor.getText();
        const isOverlay = options?.overlay ?? false;
        const restoreEditor = () => {
            this.editorContainer.clear();
            this.editorContainer.addChild(this.editor);
            this.editor.setText(savedText);
            this.ui.setFocus(this.editor);
            this.ui.requestRender();
        };
        return new Promise((resolve, reject) => {
            let component;
            let closed = false;
            const close = (result) => {
                if (closed)
                    return;
                closed = true;
                if (isOverlay)
                    this.ui.hideOverlay();
                else
                    restoreEditor();
                // Note: both branches above already call requestRender
                resolve(result);
                try {
                    component?.dispose?.();
                }
                catch {
                    /* ignore dispose errors */
                }
            };
            Promise.resolve(factory(this.ui, theme, this.keybindings, close))
                .then((c) => {
                if (closed)
                    return;
                component = c;
                if (isOverlay) {
                    // Resolve overlay options - can be static or dynamic function
                    const resolveOptions = () => {
                        if (options?.overlayOptions) {
                            const opts = typeof options.overlayOptions === "function"
                                ? options.overlayOptions()
                                : options.overlayOptions;
                            return opts;
                        }
                        // Fallback: use component's width property if available
                        const w = component.width;
                        return w ? { width: w } : undefined;
                    };
                    const handle = this.ui.showOverlay(component, resolveOptions());
                    // Expose handle to caller for visibility control
                    options?.onHandle?.(handle);
                }
                else {
                    this.editorContainer.clear();
                    this.editorContainer.addChild(component);
                    this.ui.setFocus(component);
                    this.ui.requestRender();
                }
            })
                .catch((err) => {
                if (closed)
                    return;
                if (!isOverlay)
                    restoreEditor();
                reject(err);
            });
        });
    }
    /**
     * Show an extension error in the UI.
     */
    showExtensionError(extensionPath, error, stack) {
        const errorMsg = `Extension "${extensionPath}" error: ${error}`;
        const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
        this.chatContainer.addChild(errorText);
        if (stack) {
            // Show stack trace in dim color, indented
            const stackLines = stack
                .split("\n")
                .slice(1) // Skip first line (duplicates error message)
                .map((line) => theme.fg("dim", `  ${line.trim()}`))
                .join("\n");
            if (stackLines) {
                this.chatContainer.addChild(new Text(stackLines, 1, 0));
            }
        }
        this.ui.requestRender();
    }
    // =========================================================================
    // Key Handlers
    // =========================================================================
    setupKeyHandlers() {
        // Set up handlers on defaultEditor - they use this.editor for text access
        // so they work correctly regardless of which editor is active
        this.defaultEditor.onEscape = () => {
            // teyvat: 标记 ESC 刚被按下，agent_end 据此区分「用户按 ESC」vs「语音 steer 导致的 abort」
            // 总是先设 flag，然后根据当前状态做对应的停行动作。
            // 不在 streaming 时也要 abort——比如 wait 期间按 ESC 应取消 wait，而不是光设个 flag 等 timer 到点。
            global.__piEscJustPressed = true;
            this.restoreQueuedMessagesToEditor({ abort: true });
            if (this.session.isBashRunning) {
                this.session.abortBash();
            }
            else if (this.isBashMode) {
                this.editor.setText("");
                this.isBashMode = false;
                this.updateEditorBorderColor();
            }
            else if (!this.editor.getText().trim()) {
                // Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
                const action = this.settingsManager.getDoubleEscapeAction();
                if (action !== "none") {
                    const now = Date.now();
                    if (now - this.lastEscapeTime < 500) {
                        if (action === "tree") {
                            this.showTreeSelector();
                        }
                        else {
                            this.showUserMessageSelector();
                        }
                        this.lastEscapeTime = 0;
                    }
                    else {
                        this.lastEscapeTime = now;
                    }
                }
            }
        };
        // Register app action handlers
        this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
        this.defaultEditor.onCtrlD = () => this.handleCtrlD();
        this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
        // [deprecated] thinking level 循环切换——上游 session.cycleThinkingLevel 实际无效，
        // 所有模型返回 undefined，功能从未生效过。废弃于 2026-07-21。
        // this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
        this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
        this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));
        // Global debug handler on TUI (works regardless of focus)
        this.ui.onDebug = () => this.handleDebugCommand();
        this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
        this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
        this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
        // Render mode toggle: Ctrl+Shift+R — global listener so it works even during streaming
        this.ui.addInputListener((data) => {
            if (matchesKey(data, "shift+ctrl+r")) {
                this.toggleRenderMode();
                return { consume: true };
            }
            return undefined;
        });
        globalThis.__genshinToggleRenderMode = (mode) => {
            this.renderMode = mode || (this.renderMode === "streaming" ? "line" : this.renderMode === "line" ? "block" : "streaming");
            globalThis.__piRenderMode = this.renderMode;

            if (this.renderMode === "streaming" && this.streamingComponent && this.streamingMessage) {
                this.streamingComponent.updateContent(this.streamingMessage);
                this.ui.requestRender();
            }
            this._persistRenderMode();
            const modeLabel = this.renderMode === "streaming" ? "streaming (token)" : this.renderMode === "block" ? "block (per-block)" : "line-by-line";
            this.showStatus(`Render: ${modeLabel}`);
        };
        globalThis.__genshinToggleThinking = (show) => {
            if (show !== undefined) {
                if (this.hideThinkingBlock === !show) return;
                this.hideThinkingBlock = !show;
            } else {
                this.hideThinkingBlock = !this.hideThinkingBlock;
            }
            this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
            this.chatContainer.clear();
            this.rebuildChatFromMessages();
            if (this.streamingComponent && this.streamingMessage) {
                this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
                this.streamingComponent.updateContent(this.streamingMessage);
                this.chatContainer.addChild(this.streamingComponent);
            }
            this.showStatus(`Thinking: ${this.hideThinkingBlock ? _i18n("隐藏", "Hidden") : _i18n("显示", "Visible")}`);
        };
        globalThis.__genshinGetThinkingHidden = () => this.hideThinkingBlock;
        globalThis.__genshinToggleToolExpand = (expanded) => {
            if (expanded !== undefined) {
                this.setToolsExpanded(expanded);
            } else {
                this.toggleToolOutputExpansion();
            }
            this.showStatus(`${_i18n("Tool 输出", "Tool Output")}: ${this.toolOutputExpanded ? _i18n("展开", "Expanded") : _i18n("折叠", "Collapsed")}`);
        };
        globalThis.__genshinGetToolExpanded = () => this.toolOutputExpanded;
        globalThis.__genshinHandleModelCommand = (searchTerm) => this.handleModelCommand(searchTerm);
        globalThis.__genshinChatContainer = this.chatContainer;
        globalThis.__genshinShowSettingsList = (title, getItems, onChange) => {
            return new Promise((resolve) => {
                const { SettingsList } = require("@earendil-works/pi-tui");
                const { MenuPanel, getEditorBackgroundColor } = require("./components/menu-panel.js");
                const bg = getEditorBackgroundColor();
                const items = typeof getItems === "function" ? getItems() : getItems;
                // 多级路径支持：title 可以是字符串或数组，数组用 " > " 连接显示面包屑
                const displayTitle = Array.isArray(title) ? title.join(" > ") : title;
                const list = new SettingsList(items, 14, {
                    cursor: theme.fg("accent", "→") + " ",
                    label: (text, selected) => selected ? theme.bold(text) : text,
                    value: (text, selected) => selected ? theme.bold(text) : theme.fg("dim", text),
                    hint: (text) => theme.fg("dim", text),
                    description: (text) => theme.fg("dim", text),
                }, (id, value) => {
                    onChange(id, value);
                    if (typeof getItems === "function") {
                        const fresh = getItems();
                        for (const fi of fresh) list.updateValue(fi.id, fi.currentValue);
                    }
                    this.ui.requestRender();
                }, () => {
                    this.editorContainer.clear();
                    this.editorContainer.addChild(this.editor);
                    this.ui.setFocus(this.editor);
                    this.ui.requestRender();
                    resolve(undefined);
                });
                const panel = new MenuPanel({ title: displayTitle });
                const wrapper = {
                    render: (w) => {
                        panel.clear();
                        // Wrap list lines in panel background
                        const listLines = list.render(Math.max(1, w - 4));
                        const child = { render: () => listLines, invalidate: () => {} };
                        panel.addChild(child);
                        return panel.render(w);
                    },
                    invalidate: () => { list.invalidate?.(); panel.invalidate?.(); },
                    handleInput: (d) => list.handleInput(d),
                };
                this.editorContainer.clear();
                this.editorContainer.addChild(wrapper);
                this.ui.setFocus(wrapper);
                this.ui.requestRender();
            });
        };
        this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
        this.defaultEditor.onAction("app.message.copy", () => void this.handleCopyCommand());
        this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
        this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
        this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
        this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
        this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
        this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());
        this.defaultEditor.onChange = (text) => {
            const wasBashMode = this.isBashMode;
            this.isBashMode = text.trimStart().startsWith("!");
            if (wasBashMode !== this.isBashMode) {
                this.updateEditorBorderColor();
            }
        };
        // Handle clipboard paste (triggered on Ctrl+V). Images are attached by path;
        // otherwise, paste plain text from the system clipboard.
        this.defaultEditor.onPasteImage = () => {
            void this.handleClipboardPaste();
        };
    }
    async handleClipboardPaste() {
        try {
            const image = await readClipboardImage();
            if (image) {
                const tmpDir = os.tmpdir();
                const ext = extensionForImageMimeType(image.mimeType) ?? "png";
                const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;
                const filePath = path.join(tmpDir, fileName);
                fs.writeFileSync(filePath, Buffer.from(image.bytes));
                this.editor.insertTextAtCursor?.(filePath);
                this.ui.requestRender();
                return;
            }
            const text = await readClipboardText();
            if (text) {
                this.editor.insertTextAtCursor?.(text);
                this.ui.requestRender();
            }
        }
        catch {
            // Silently ignore clipboard errors (may not have permission, etc.)
        }
    }
    setupEditorSubmitHandler() {
        this.defaultEditor.onSubmit = async (text) => {
            text = text.trim();
            if (!text)
                return;
            // genshin: 原生命令全部禁用，所有 /command 走 extension registerCommand
            // Handle bash command (! for normal, !! for excluded from context)
            if (text.startsWith("!")) {
                const isExcluded = text.startsWith("!!");
                const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
                if (command) {
                    if (this.session.isBashRunning) {
                        this.showWarning("A bash command is already running. Press Esc to cancel it first.");
                        this.editor.setText(text);
                        return;
                    }
                    this.editor.addToHistory?.(text);
                    await this.handleBashCommand(command, isExcluded);
                    this.isBashMode = false;
                    this.updateEditorBorderColor();
                    return;
                }
            }
            // Queue input during compaction (extension commands execute immediately)
            if (this.session.isCompacting) {
                if (this.isExtensionCommand(text)) {
                    this.editor.addToHistory?.(text);
                    this.editor.setText("");
                    await this.session.prompt(text);
                }
                else {
                    this.queueCompactionMessage(text, "steer");
                }
                return;
            }
            // If streaming, abort and steer. 任何时候都打断，不排队。
            if (this.session.isStreaming) {
                this.editor.addToHistory?.(text);
                this.editor.setText("");
                if (this.isExtensionCommand(text)) {
                    await this.session.prompt(text);
                } else {
                    // 2026-09-11（prime-agent，ISSUE 174 / LESSON 080 的漏网实例）：
                    // session.abort() 是 async（agent-session.js:1221 `async abort() { ...; await this.waitForIdle(); }`）。
                    // 这里原来不 await 就立刻 prompt(steer) → abort 信号已发、loop 未停 → steer 被正在 abort 的 turn 吞掉：
                    // 用户消息静默丢失 / UI 卡死（这正是 ISSUE 174 的根因，下面 normal 分支 2419-2424 已按此修过，这条路径漏了）。
                    await this.session.abort();
                    await this.session.prompt(text, { streamingBehavior: "steer" });
                }
                this.ui.requestRender();
                return;
            }
            // Normal message submission
            // First, move any pending bash components to chat
            this.flushPendingBashComponents();
            if (this.onInputCallback) {
                this.onInputCallback(text);
            }
            else {
                // ISSUE 174 修复：用户在 execute 期间发消息——先 await abort 确保 agent loop
                // 完全停止，再发新 prompt（不用 steer，因为 abort 后 isStreaming=false）。
                // 旧代码不 await abort 导致 abort/prompt 竞态：abort 信号已发但 loop 未停，
                // prompt 走 steer 路径，steer 被 abort 吞掉或 agent_end 后心跳不续命。
                // await abort 但限时 200ms——wait/resting 态下没有活跃 API 请求，不需要等很久
                await Promise.race([this.session.abort(), new Promise(r => setTimeout(r, 200))]);
                await this.session.prompt(text);
            }
            this.editor.addToHistory?.(text);
        };
    }
    subscribeToAgent() {
        this.unsubscribe = this.session.subscribe(async (event) => {
            await this.handleEvent(event);
        });
    }
    async handleEvent(event) {
        if (!this.isInitialized) {
            await this.init();
        }
        this.footer.invalidate();
        switch (event.type) {
            case "agent_start":
                this.pendingTools.clear();
                // ISSUE 115：TTFT 监控——记录本轮请求开始时刻（agent_start → 首个 message_update 的间隔 ≈ prefill+预处理）
                this._genshinTtftStart = Date.now();
                this._genshinTtftLogged = false;
                // ISSUE 115 v3：投递延迟 = 最近用户消息到达 → agent_start（打断链路的第一段；无用户消息则 -1）
                if (this._genshinLastUserMsgTs) {
                    this._genshinDeliverMs = Date.now() - this._genshinLastUserMsgTs;
                    this._genshinLastUserMsgTs = null;
                }
                else {
                    this._genshinDeliverMs = -1;
                }
                this.statusBar.resetTurnTokens(this._getTurnOutputTokens());
                // hibernated 时不覆盖 statusBar（MC aware 会触发 agent_start，但不应重置 hibernated timer）
                if (globalThis.__genshinHeartState !== "hibernated") {
                    this.statusBar.transition("working");
                    // ISSUE 104：每轮刷新 prefill 基准，prefilling 显示本轮时长而非跨轮累积
                    this.statusBar.beginTurn();
                }
                if (this.settingsManager.getShowTerminalProgress()) {
                    this.ui.terminal.setProgress(true);
                }
                if (this.retryEscapeHandler) {
                    this.defaultEditor.onEscape = this.retryEscapeHandler;
                    this.retryEscapeHandler = undefined;
                }
                break;
            case "queue_update":
                if (globalThis.__piRecapPending) {
                    this.updatePendingMessagesDisplay();
                }
                this.ui.requestRender();
                break;
            case "entry_appended":
                if (event.entry.type === "custom") {
                    this.addCustomEntryToChat(event.entry);
                    this.ui.requestRender();
                }
                break;
            case "session_info_changed":
                this.updateTerminalTitle();
                this.footer.invalidate();
                this.ui.requestRender();
                break;
            case "thinking_level_changed":
                this.footer.invalidate();
                this.updateEditorBorderColor();
                break;
            case "message_start":
                if (event.message.role === "custom") {
                    this.addMessageToChat(event.message);
                    this.ui.requestRender();
                }
                else if (event.message.role === "user") {
                    // ISSUE 115 v3：记录用户消息到达时刻（供投递延迟分析：user msg → agent_start）
                    this._genshinLastUserMsgTs = Date.now();
                    this.addMessageToChat(event.message);
                    // ── 026-user-message-archive: 实时归档用户消息到 JSONL ──
                    try {
                        const fs = require('fs');
                        const os = require('os');
                        const dir = os.homedir() + '/.teyvat/AccountData';
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        const agent = process.env.PAIMON_AGENT_NAME || process.env.PAIMON_AGENT_ID || 'unknown';
                        const agentId = process.env.PAIMON_AGENT_ID || '';
                        const session = this.sessionManager?.getSessionId?.() || '';
                        const ts = new Date().toISOString().slice(0, 19).replace('T', ' ') + '+08:00';
                        const text = Array.isArray(event.message.content)
                            ? event.message.content.filter(c => c.type === 'text').map(c => c.text).join('').trim()
                            : (typeof event.message.content === 'string' ? event.message.content.trim() : '');
                        if (text) {
                            const line = JSON.stringify({ agent, agentId, session, ts, text }) + '\n';
                            fs.appendFileSync(dir + '/user-messages.jsonl', line);
                        }
                    } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                    this.updatePendingMessagesDisplay();
                    this.ui.requestRender();
                }
                else if (event.message.role === "assistant") {
                    this.streamingComponent = new AssistantMessageComponent(undefined, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad);
                    this.streamingComponent.isStreaming = true; // ISSUE 077：流式期间不发 OSC133 区域标记
                    this.streamingMessage = event.message;
        
                    this.chatContainer.addChild(this.streamingComponent);
                    this.streamingComponent.updateContent(this.streamingMessage);
                    this.ui.requestRender();
                }
                break;
            case "message_update":
                if (this.streamingComponent && event.message.role === "assistant") {
                    // ISSUE 115：首个 message_update ≈ 首个 token 到达 → 暂存 TTFT（message_end 时连同真实 usage 一起写）
                    if (this._genshinTtftStart && !this._genshinTtftLogged) {
                        this._genshinTtftLogged = true;
                        this._genshinTtftMs = Date.now() - this._genshinTtftStart;
                    }
                    this.streamingMessage = event.message;
                    const lastBlock = this.streamingMessage.content[this.streamingMessage.content.length - 1];
                    this.statusBar.setThinking(lastBlock?.type === "thinking" && !!lastBlock.thinking);
                    // Tool calls always render immediately regardless of render mode
                    for (const content of this.streamingMessage.content) {
                        if (content.type === "toolCall") {
                            if (!this.pendingTools.has(content.id)) {
                                const component = new ToolExecutionComponent(content.name, content.id, content.arguments, {
                                    showImages: this.settingsManager.getShowImages(),
                                    imageWidthCells: this.settingsManager.getImageWidthCells(),
                                }, this.getRegisteredToolDefinition(content.name), this.ui, this.sessionManager.getCwd());
                                component.setExpanded(this.toolOutputExpanded);
                                this.chatContainer.addChild(component);
                                this.pendingTools.set(content.id, component);
                                // 流式阶段就显示 toolActivity（模型正在输出参数，不等 execution_start）
                                this.statusBar.setToolActivity(content.name);
                            }
                            else {
                                const component = this.pendingTools.get(content.id);
                                if (component) {
                                    component.updateArgs(content.arguments);
                                }
                            }
                        }
                    }
                    if (this.renderMode === "block") {
                        // Block mode: only render on block completion events, not during streaming deltas
                        const evType = event.assistantMessageEvent?.type;
                        if (evType === "text_end" || evType === "thinking_end" || evType === "message_end") {
                            this.streamingComponent.updateContent(this.streamingMessage);
                            this.ui.requestRender();
                            if (this._transcriptFollowing) {
                                try { this.transcriptScrollView.scrollToEnd(); } catch (e) { console.error("[interactive-mode.js] block render scroll: " + (e?.message || e)); }
                            }
                        }
                        // Tool calls: begin/end 渲染，delta 只更新数据不重绘（参数未完整时渲染树不变——空转）
                        else if (evType === "tool_use_begin" || evType === "tool_use_end") {
                            this.streamingComponent.updateContent(this.streamingMessage);
                            this.ui.requestRender();
                        } else if (evType === "tool_use_delta") {
                            this.streamingComponent.updateContent(this.streamingMessage);
                        }
                    } else if (this.renderMode === "line") {
                        const saved = [];
                        // ISSUE 077 真根因修复（2026-08-15）：逐行截断只能作用于"正在流式"的块
                        // （对应 *_delta 事件的块）。此前对每个 message_update 无差别截断——
                        // thinking_end/text_end 之后块已完整，但末行通常没有结尾换行符，
                        // 会被误当"未完成行"切掉一整行，一直切到 message_end 才恢复
                        // （症状即"每次 think 最后丢掉一行，过一会又出现"）。
                        const evType = event.assistantMessageEvent?.type;
                        for (const block of this.streamingMessage.content) {
                            const isBlockStreaming = (block.type === "text" && evType === "text_delta")
                                || (block.type === "thinking" && evType === "thinking_delta");
                            if (!isBlockStreaming) {
                                // thinking 折叠模式：换行替换为空格拼成一行
                                if (block.type === "thinking" && block.thinking && globalThis.__genshinThinkingFirstLine) {
                                    if (block.thinking.includes("\n")) {
                                        saved.push({ block, full: block.thinking });
                                        block.thinking = block.thinking.replace(/\n+/g, " ").replace(/\s+/g, " ");
                                    }
                                }
                                continue;
                            }
                            // thinking 折叠模式：streaming 中也拼成一行
                            if (block.type === "thinking" && block.thinking && globalThis.__genshinThinkingFirstLine) {
                                if (block.thinking.includes("\n")) {
                                    saved.push({ block, full: block.thinking });
                                    block.thinking = block.thinking.replace(/\n+/g, " ").replace(/\s+/g, " ");
                                }
                            }
                            if (block.type === "text" && block.text) {
                                const full = block.text;
                                const lastNL = full.lastIndexOf('\n');
                                if (lastNL >= 0) {
                                    saved.push({ block, full });
                                    block.text = full.substring(0, lastNL + 1);
                                }
                            } else if (block.type === "thinking" && block.thinking && !globalThis.__genshinThinkingFirstLine) {
                                const full = block.thinking;
                                const lastNL = full.lastIndexOf('\n');
                                if (lastNL >= 0) {
                                    saved.push({ block, full });
                                    block.thinking = full.substring(0, lastNL + 1);
                                }
                            }
                        }
                        this.streamingComponent.updateContent(this.streamingMessage);
                        this.ui.requestRender();
                        // 与 streaming 分支一致：跟随底部时钉住滚动（ISSUE 077 防御）
                        if (this._transcriptFollowing) {
                            try { this.transcriptScrollView.scrollToEnd(); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                        }
                        for (const s of saved) {
                            if (s.block.type === "text") s.block.text = s.full;
                            else s.block.thinking = s.full;
                        }
                    } else {
                        this.streamingComponent.updateContent(this.streamingMessage);
                        this.ui.requestRender();
                        // teyvat ISSUE 077 防御修复：流式每新增一行，若正跟随底部就立刻钉住
                        // 滚动位置——消除"最新一行在视口下方、要等下一个 chunk 才滚出来"
                        // 的 1 帧滞后（症状即"think 末行被吃、过一会又出现"）
                        if (this._transcriptFollowing) {
                            try { this.transcriptScrollView.scrollToEnd(); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                        }
                    }
                }
                break;
            case "message_end":
                // ISSUE 115：写完整 TTFT 记录（含真实 usage）——时间,TTFT,本轮stopReason,input,cacheRead,output
                // 分析"工具结果大→下轮 prefill 慢"：toolUse 轮的 input 是非缓存新增（含工具结果回填），与 TTFT 关联
                if (this._genshinTtftLogged && this._genshinTtftMs !== undefined) {
                    try {
                        const pid = globalThis.__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
                        if (pid) {
                            const u = event.message.usage || {};
                            const rcDir = path.join(os.homedir(), ".teyvat/RuntimeCache", pid);
                            fs.mkdirSync(rcDir, { recursive: true });
                            fs.appendFileSync(path.join(rcDir, "ttft.log"),
                                `${new Date().toISOString()},${this._genshinTtftMs},${this._genshinDeliverMs ?? -1},${event.message?.stopReason || "done"},${u.input || 0},${u.cacheRead || 0},${u.output || 0}\n`);
                        }
                    } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                    this._genshinTtftMs = undefined;
                }
                // ISSUE 115：记录本轮 stopReason（供下一轮判断是否打断后首轮）
                this._genshinLastStopReason = event.message?.stopReason || "done";
                if (event.message.role === "user")
                    break;
                if (this.streamingComponent && event.message.role === "assistant") {
                    this.streamingMessage = event.message;
                    this.streamingComponent.isStreaming = false; // ISSUE 077：消息结束，恢复 OSC133 标记
                    let errorMessage;
                    if (this.streamingMessage.stopReason === "aborted") {
                        const retryAttempt = this.session.retryAttempt;
                        errorMessage =
                            retryAttempt > 0
                                ? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
                                : "Interrupted";
                        this.streamingMessage.errorMessage = errorMessage;
                    }
                    this.streamingComponent.updateContent(this.streamingMessage);
                    if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
                        if (!errorMessage) {
                            errorMessage = this.streamingMessage.errorMessage || "Error";
                        }
                        for (const [, component] of this.pendingTools.entries()) {
                            component.updateResult({
                                content: [{ type: "text", text: errorMessage }],
                                isError: true,
                            });
                        }
                        this.pendingTools.clear();
                    }
                    else {
                        // Args are now complete - trigger diff computation for edit tools
                        for (const [, component] of this.pendingTools.entries()) {
                            component.setArgsComplete();
                        }
                        this.maybeShowCacheMissNotice(this.streamingMessage);
                    }
                    this.streamingComponent = undefined;
                    this.streamingMessage = undefined;
                    this.footer.invalidate();
                }
                this.ui.requestRender();
                break;
            case "tool_execution_start": {
                let component = this.pendingTools.get(event.toolCallId);
                if (!component) {
                    component = new ToolExecutionComponent(event.toolName, event.toolCallId, event.args, {
                        showImages: this.settingsManager.getShowImages(),
                        imageWidthCells: this.settingsManager.getImageWidthCells(),
                    }, this.getRegisteredToolDefinition(event.toolName), this.ui, this.sessionManager.getCwd());
                    component.setExpanded(this.toolOutputExpanded);
                    this.chatContainer.addChild(component);
                    this.pendingTools.set(event.toolCallId, component);
                }
                component.markExecutionStarted();
                this.statusBar.setToolActivity(event.toolName);
                this.ui.requestRender();
                break;
            }
            case "tool_execution_update": {
                const component = this.pendingTools.get(event.toolCallId);
                if (component) {
                    component.updateResult({ ...event.partialResult, isError: false }, true);
                    this.ui.requestRender();
                }
                break;
            }
            case "tool_execution_end": {
                const component = this.pendingTools.get(event.toolCallId);
                if (component) {
                    component.updateResult({ ...event.result, isError: event.isError });
                    this.pendingTools.delete(event.toolCallId);
                    this.statusBar.clearToolActivity();
                    this.ui.requestRender(this.renderMode === "line");
                }
                break;
            }
            case "agent_end":
                if (this.settingsManager.getShowTerminalProgress()) {
                    this.ui.terminal.setProgress(false);
                }
                this.statusBar.stopTimer();
                if (this.streamingComponent) {
                    this.chatContainer.removeChild(this.streamingComponent);
                    this.streamingComponent = undefined;
                    this.streamingMessage = undefined;
                }
                this.pendingTools.clear();
                this.ui.requestRender();
                break;
            case "agent_settled":
                await this.checkShutdownRequested();
                break;
            case "compaction_start": {
                if (this.settingsManager.getShowTerminalProgress()) {
                    this.ui.terminal.setProgress(true);
                }
                // Keep editor active; submissions are queued during compaction.
                this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
                this.defaultEditor.onEscape = () => {
                    global.__piEscJustPressed = true;
                    this.session.abortCompaction();
                };
                const compactMsg = event.reason === "manual" ? "Compacting context..." : "Auto-compacting...";
                this.footer.setSpinner(compactMsg, "accent");
                this.ui.requestRender();
                break;
            }
            case "compaction_end": {
                if (this.settingsManager.getShowTerminalProgress()) {
                    this.ui.terminal.setProgress(false);
                }
                if (this.autoCompactionEscapeHandler) {
                    this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
                    this.autoCompactionEscapeHandler = undefined;
                }
                this.footer.setSpinner("Working...", "border");
                if (event.aborted) {
                    if (event.reason === "manual") {
                        this.showError("Compaction cancelled");
                    }
                    else {
                        this.showStatus("Auto-compaction cancelled");
                    }
                }
                else if (event.result) {
                    this.chatContainer.clear();
                    this.rebuildChatFromMessages();
                    this.addMessageToChat(createCompactionSummaryMessage(event.result.summary, event.result.tokensBefore, new Date().toISOString()));
                    this.footer.invalidate();
                }
                else if (event.errorMessage) {
                    if (event.reason === "manual") {
                        this.showError(event.errorMessage);
                    }
                    else {
                        this.chatContainer.addChild(new Spacer(1));
                        this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
                    }
                }
                void this.flushCompactionQueue({ willRetry: event.willRetry });
                this.ui.requestRender();
                break;
            }
            case "auto_retry_start": {
                // Set up escape to abort retry
                this.retryEscapeHandler = this.defaultEditor.onEscape;
                this.defaultEditor.onEscape = () => {
                    global.__piEscJustPressed = true;
                    this.session.abortRetry();
                };
                const retryMsg = `Retrying (${event.attempt}/${event.maxAttempts})...`;
                this.footer.setSpinner(retryMsg, "warning");
                this.ui.requestRender();
                break;
            }
            case "auto_retry_end": {
                // Restore escape handler
                if (this.retryEscapeHandler) {
                    this.defaultEditor.onEscape = this.retryEscapeHandler;
                    this.retryEscapeHandler = undefined;
                }
                this.clearStatusIndicator("retry");
                // Show error only on final failure (success shows normal response)
                if (!event.success) {
                    this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
                }
                this.ui.requestRender();
                break;
            }
        }
    }
    /** Extract text content from a user message */
    getUserMessageText(message) {
        if (message.role !== "user")
            return "";
        const textBlocks = typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content.filter((c) => c.type === "text");
        return textBlocks.map((c) => c.text).join("");
    }
    /**
     * Show a status message in the chat.
     *
     * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
     * we update the previous status line instead of appending new ones to avoid log spam.
     */
    showStatus(message) {
        const children = this.chatContainer.children;
        const last = children.length > 0 ? children[children.length - 1] : undefined;
        const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
        if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
            this.lastStatusText.setText(theme.fg("dim", message));
            this.ui.requestRender();
            return;
        }
        const spacer = new Spacer(1);
        const text = new Text(theme.fg("dim", message), 1, 0);
        this.chatContainer.addChild(spacer);
        this.chatContainer.addChild(text);
        this.lastStatusSpacer = spacer;
        this.lastStatusText = text;
        this.ui.requestRender();
    }
    addCustomEntryToChat(entry) {
        const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
        if (!renderer) {
            return;
        }
        const component = new CustomEntryComponent(entry, renderer);
        component.setExpanded(this.toolOutputExpanded);
        if (!component.hasContent()) {
            return;
        }
        if (this.streamingComponent) {
            const streamingIndex = this.chatContainer.children.indexOf(this.streamingComponent);
            if (streamingIndex >= 0) {
                this.chatContainer.children.splice(streamingIndex, 0, component);
                return;
            }
        }
        this.chatContainer.addChild(component);
    }
    /**
     * ISSUE 114（2026-08-18 用户指示）：自重启保留输入框草稿。
     * - 恢复：RuntimeCache/<pid>/wake-restart 存在（self-reboot 标记，executes.ts 写）且 draft 非空
     *   → editor.setText(draft)，输入框继续显示上次未发送的内容；
     * - 保存：轮询 editor.getText()（2s，内容变化才写；空则删 draft）；
     * - 历史消息由 _replaySessionHistory() 重放（run() 已无条件调用）。
     * 纯 teyvat 链路（getText/setText 是本文件已在用的方法），不用 pi 的 resume/onChange。
     */
    _genshinInitInputDraft() {
        try {
            const pid = globalThis.__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
            if (!pid) return;
            const rcDir = path.join(os.homedir(), ".teyvat/RuntimeCache", pid);
            const draftPath = path.join(rcDir, "input-draft");
            // 恢复（仅自重启后）
            try {
                if (fs.existsSync(path.join(rcDir, "wake-restart"))) {
                    const draft = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, "utf8") : "";
                    if (draft && draft.trim()) this.editor.setText(draft);
                }
            }
            catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
            // 轮询保存（2s；内容变化才写；空则删）
            let last = null;
            const iv = setInterval(() => {
                try {
                    const t = this.editor?.getText?.() || "";
                    if (t === last) return;
                    last = t;
                    if (t.trim()) {
                        fs.mkdirSync(rcDir, { recursive: true });
                        fs.writeFileSync(draftPath, t);
                    }
                    else if (fs.existsSync(draftPath)) {
                        try { fs.unlinkSync(draftPath); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                    }
                }
                catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
            }, 2000);
            if (iv?.unref) iv.unref();
        }
        catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
    }
    /**
     * genshin: 恢复 session（--continue）后把历史消息重放到 TUI 聊天区。
     * pi 的 chatContainer 由事件流（message_start 等）驱动；--continue 恢复的历史
     * entries 只进模型 context，不会触发渲染事件 → 界面空白。这里重放历史。
     * 2026-09-04 渲染修复：改走 renderSessionEntries 完整管线——原用 addMessageToChat
     * 只渲染 text/thinking（AssistantMessageComponent 不渲染 toolCall 块），导致所有
     * execute 的调用行/Result 行在重放中缺失（含 self-reboot 那条，用户报障）。
     * renderSessionEntries 与 pi 原生 renderInitialMessages/rebuild 同路径：
     * assistant 的每个 toolCall 单独创建 ToolExecutionComponent，toolResult 匹配 updateResult。
     */
    _replaySessionHistory() {
        try {
            const entries = (this.sessionManager?.getEntries?.() ?? []).filter(_isRenderableSessionEntry);
            if (entries.length === 0) return;
            this.renderSessionEntries(entries);
            this.chatContainer.addChild(new Spacer(1));
            this.ui.requestRender();
        }
        catch (e) {
            console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] _replaySessionHistory: " + (e?.message || e));
        }
    }
    /**
     * genshin 2026-09-04：self-reboot 后渲染上一轮 session 的历史消息（用户设计要求）。
     * self-reboot 每次开新 pi session（entries 空 → _replaySessionHistory 无从渲染），
     * 记忆连续靠 heart 快照，但 TUI 上文显示丢失。executes.ts self-reboot 时写下
     * restart-session.json（旧 session 文件路径），这里读它 → 解析旧 session 的 entries →
     * 重放最近一段到当前新 session 的 TUI，渲染完删除标记。session 语义不变，纯显示层恢复。
     */
    _replayPreviousSession() {
        try {
            const pid = globalThis.__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
            if (!pid) return;
            const rcDir = path.join(os.homedir(), ".teyvat/RuntimeCache", pid);
            const marker = path.join(rcDir, "restart-session.json");
            let sessionFile = "";
            if (fs.existsSync(marker)) {
                try { sessionFile = JSON.parse(fs.readFileSync(marker, "utf8")).sessionFile || ""; } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                try { fs.unlinkSync(marker); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
            }
            // fallback: 无 marker 时自动找 SESSION_DIR 最近的有实质内容的 session 文件
            if (!sessionFile || !fs.existsSync(sessionFile)) {
                const sessDir = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), ".teyvat/SessionData", pid);
                if (fs.existsSync(sessDir)) {
                    const curSessionFile = this.sessionManager?.getSessionFile?.() || "";
                    const files = fs.readdirSync(sessDir).filter(f => f.endsWith(".jsonl")).map(f => {
                        const fp = path.join(sessDir, f);
                        if (fp === curSessionFile) return null;
                        try { return { path: fp, mtime: fs.statSync(fp).mtimeMs, size: fs.statSync(fp).size }; } catch { return null; }
                    }).filter(Boolean);
                    files.sort((a, b) => b.mtime - a.mtime);
                    // 跳过只有几行的垃圾 session（如只有 /login 的短 session），找有实质内容的
                    for (const f of files) {
                        if (f.size < 2000) continue; // 小于 2KB 的 session 跳过
                        sessionFile = f.path;
                        break;
                    }
                }
            }
            if (!sessionFile || !fs.existsSync(sessionFile)) return;
            const PREV_LIMIT = 50; // 只重放最近 50 条渲染类 entry（参考 prime-agent limitTranscript，防大 session 卡顿）
            const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
            const renderable = [];
            for (const line of lines) {
                let entry;
                try { entry = JSON.parse(line); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] parse entry: " + (e?.message || e)); continue; }
                if (!_isRenderableSessionEntry(entry)) continue;
                renderable.push(entry);
            }
            const tail = renderable.slice(Math.max(0, renderable.length - PREV_LIMIT));
            if (tail.length === 0) return;
            // 2026-09-04 渲染修复：走 renderSessionEntries 完整管线（toolCall 调用行/Result 行/custom 消息
            // 全部正确渲染）。原 addMessageToChat 路径丢 toolCall 块——AssistantMessageComponent 只渲染
            // text/thinking，toolCall 由 renderSessionItems 单独建 ToolExecutionComponent、toolResult 匹配 updateResult。
            this.renderSessionEntries(tail);
            this.chatContainer.addChild(new Spacer(1));
            this.ui.requestRender();
        }
        catch (e) {
            console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] _replayPreviousSession: " + (e?.message || e));
        }
    }
    addMessageToChat(message, options) {
        // 后台模式（PAIMON_BACKGROUND=1）：消息只进 session 历史，不渲染到 chatContainer（零渲染）——
        // 焦点恢复（restoreChatAfterWake）时从历史重建。见 PROPOSAL 034 阶段 4 过渡方案。
        if (this._chatUnloaded) return;
        // teyvat 2026-08-14：新消息计数 —— 不在底部（未跟随）时累计未读，footer follow hint 显示 "N new messages"
        if (message?.role && !this._transcriptFollowing) {
            this._unseenMessages++;
            this.footer.setFollowHint(true, this._unseenMessages);
        }
        switch (message.role) {
            case "bashExecution": {
                const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
                if (message.output) {
                    component.appendOutput(message.output);
                }
                component.setComplete(message.exitCode, message.cancelled, message.truncated ? { truncated: true } : undefined, message.fullOutputPath);
                this.chatContainer.addChild(component);
                break;
            }
            case "custom": {
                if (message.display) {
                    const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
                    const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
                    component.setExpanded(this.toolOutputExpanded);
                    this.chatContainer.addChild(component);
                }
                break;
            }
            case "compactionSummary": {
                this.chatContainer.addChild(new Spacer(1));
                const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
                component.setExpanded(this.toolOutputExpanded);
                this.chatContainer.addChild(component);
                break;
            }
            case "branchSummary": {
                this.chatContainer.addChild(new Spacer(1));
                const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
                component.setExpanded(this.toolOutputExpanded);
                this.chatContainer.addChild(component);
                break;
            }
            case "user": {
                const textContent = this.getUserMessageText(message);
                if (textContent) {
                    const lastChild = this.chatContainer.children[this.chatContainer.children.length - 1];
                    if (lastChild && !(lastChild instanceof UserMessageComponent)) {
                        this.chatContainer.addChild(new Spacer(1));
                    }
                    const skillBlock = parseSkillBlock(textContent);
                    if (skillBlock) {
                        // Render skill block (collapsible)
                        const component = new SkillInvocationMessageComponent(skillBlock, this.getMarkdownThemeWithSettings());
                        component.setExpanded(this.toolOutputExpanded);
                        this.chatContainer.addChild(component);
                        // Render user message separately if present
                        if (skillBlock.userMessage) {
                            this.chatContainer.addChild(new Spacer(1));
                            const userComponent = new UserMessageComponent(skillBlock.userMessage, this.getMarkdownThemeWithSettings(), this.outputPad);
                            this.chatContainer.addChild(userComponent);
                        }
                    }
                    else {
                        const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings(), this.outputPad);
                        this.chatContainer.addChild(userComponent);
                    }
                    if (options?.populateHistory) {
                        this.editor.addToHistory?.(textContent);
                    }
                }
                break;
            }
            case "assistant": {
                const assistantComponent = new AssistantMessageComponent(message, this.hideThinkingBlock, this.getMarkdownThemeWithSettings(), this.hiddenThinkingLabel, this.outputPad);
                this.chatContainer.addChild(assistantComponent);
                break;
            }
            case "toolResult": {
                // Tool results are rendered inline with tool calls, handled separately
                break;
            }
            default: {
                const _exhaustive = message;
            }
        }
    }
    renderSessionItems(items, options = {}) {
        this.pendingTools.clear();
        const renderedPendingTools = new Map();
        // Cache-miss notices are not persisted; re-derive them from the full entry
        // list and re-inject them after the assistant messages that paid for them.
        const cacheMisses = this.settingsManager.getShowCacheMissNotices()
            ? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRegistry)
            : new Map();
        if (options.updateFooter) {
            this.footer.invalidate();
            this.updateEditorBorderColor();
        }
        for (const item of items) {
            if (isCustomSessionEntry(item)) {
                this.addCustomEntryToChat(item);
                continue;
            }
            const message = item;
            // Assistant messages need special handling for tool calls
            if (message.role === "assistant") {
                this.addMessageToChat(message);
                // Render tool call components
                for (const content of message.content) {
                    if (content.type === "toolCall") {
                        const component = new ToolExecutionComponent(content.name, content.id, content.arguments, {
                            showImages: this.settingsManager.getShowImages(),
                            imageWidthCells: this.settingsManager.getImageWidthCells(),
                        }, this.getRegisteredToolDefinition(content.name), this.ui, this.sessionManager.getCwd());
                        component.setExpanded(this.toolOutputExpanded);
                        this.chatContainer.addChild(component);
                        if (message.stopReason === "aborted" || message.stopReason === "error") {
                            let errorMessage;
                            if (message.stopReason === "aborted") {
                                // teyvat: suppress "Interrupted" — steers/auto-aborts are normal in continuous mode
                                // Only show specific errors
                                if (message.errorMessage && message.errorMessage !== "Interrupted" && message.errorMessage !== "Request was aborted") {
                                    errorMessage = message.errorMessage;
                                    component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
                                }
                                else {
                                    // teyvat（2026-08-13 卡 Result 修复）：被中断的 turn 里最后一个 tool call
                                    // 永远不会有 toolResult（session 里只有 toolCall 没有结果）。
                                    // 必须给组件一个终结态，否则 isPartial 的 ◦ 点永久转圈 = "卡 Result"。
                                    // 空文本 = 只留调用行、无结果行、无 "Interrupted" 字样（延续上面的压制意图）。
                                    component.updateResult({ content: [{ type: "text", text: "" }], isError: false });
                                }
                            }
                            else {
                                errorMessage = message.errorMessage || "Error";
                                component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
                            }
                        }
                        else {
                            renderedPendingTools.set(content.id, component);
                        }
                    }
                }
                if (message.stopReason !== "aborted" && message.stopReason !== "error") {
                    const miss = cacheMisses.get(message);
                    if (miss)
                        this.addCacheMissNotice(miss);
                }
            }
            else if (message.role === "toolResult") {
                // Match tool results to pending tool components
                const component = renderedPendingTools.get(message.toolCallId);
                if (component) {
                    component.updateResult(message);
                    renderedPendingTools.delete(message.toolCallId);
                }
            }
            else {
                // All other messages use standard rendering
                this.addMessageToChat(message, options);
            }
        }
        for (const [toolCallId, component] of renderedPendingTools) {
            this.pendingTools.set(toolCallId, component);
        }
        this.ui.requestRender();
    }
    /**
     * Render session entries to chat. Used for initial load and rebuild after compaction.
     * @param entries Compaction-aware session entries to render
     * @param options.updateFooter Update footer state
     * @param options.populateHistory Add user messages to editor history
     */
    renderSessionEntries(entries, options = {}) {
        const items = entries.flatMap((entry) => {
            if (entry.type === "custom") {
                return [entry];
            }
            return sessionEntryToContextMessages(entry);
        });
        this.renderSessionItems(items, options);
    }
    /**
     * Show a transcript notice when a completed assistant message paid for a
     * significant cache miss. Only states observable facts: the miss itself,
     * a model switch, or an idle gap past the cache TTL.
     */
    maybeShowCacheMissNotice(message) {
        if (!this.settingsManager.getShowCacheMissNotices())
            return;
        // Entries don't contain `message` yet: message_end fires before persistence.
        const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRegistry);
        if (miss)
            this.addCacheMissNotice(miss);
    }
    addCacheMissNotice(miss) {
        if (miss.missedTokens < 20_000 && miss.missedCost < 0.1)
            return;
        const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
        const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
        let label = "Cache miss";
        if (miss.modelChanged) {
            label = "Cache miss after model switch";
        }
        else if (miss.idleMs >= CACHE_TTL_MS) {
            label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
        }
        const text = theme.fg("warning", `${label}: ${reBilled}`);
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Text(text, 1, 0));
    }
    renderInitialMessages() {
        // 渲染全部 session entries——恢复/attach 后用户能看到完整历史
        const entries = this.sessionManager.getEntries();
        try { globalThis.__genshinDlog?.(`renderInitialMessages: ${entries.length} entries (types: ${[...new Set(entries.map(e => e.type))].join(",")})`); } catch (e) { /* debug log */ }
        this.renderSessionEntries(entries, {
            updateFooter: true,
            populateHistory: true,
        });
        this.renderProjectTrustWarningIfNeeded();
        // Show compaction info if session was compacted
        const allEntries = this.sessionManager.getEntries();
        const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
        if (compactionCount > 0) {
            const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
            this.showStatus(`Session compacted ${times}`);
        }
    }
    renderProjectTrustWarningIfNeeded() {
        if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
            return;
        }
        if (this.chatContainer.children.length > 0) {
            this.chatContainer.addChild(new Spacer(1));
        }
        this.chatContainer.addChild(new Text(theme.fg("warning", "This project is not trusted. Project .teyvat resources and packages are ignored. Use /trust to save a trust decision, then restart genshin."), 1, 0));
    }
    // REMOVED(2026-07-26): pendingUserInputs 从未被 push，死代码
    // 连续模式走 sendCustomMessage triggerTurn 管线，不经过这里
    // const queuedInput = this.pendingUserInputs.shift();
    // if (queuedInput !== undefined) return queuedInput;
    async getUserInput() {
        return new Promise((resolve) => {
            this.onInputCallback = (text) => {
                this.onInputCallback = undefined;
                resolve(text);
            };
        });
    }
    rebuildChatFromMessages() {
        this.chatContainer.clear();
        this.renderSessionEntries(this.sessionManager.buildContextEntries());
    }
    /**
     * ISSUE 079：长时间休眠后卸载消息区，释放内存（Markdown 解析树 + 渲染行是大头）。
     * 只清 chatContainer——status bar/footer 是独立组件，其休眠倒计时/唤醒计时器不受影响。
     */
    unloadChatForHibernate() {
        if (this._chatUnloaded) return;
        this._chatUnloaded = true;
        const unloadMode = (globalThis.__genshinUnloadMode) || "seamless";
        if (unloadMode === "classic") {
            // 传统模式：全清 + 提示文本
            this.chatContainer.clear();
            this.pendingTools.clear();
            this.chatContainer.addChild(new Text(theme.fg("dim", _i18n("（长时间休眠，消息区已卸载以释放内存。窗口回到前台或唤醒后自动重建。）", "(Long hibernate — message area unloaded to free memory. It rebuilds automatically when the window regains focus or on wake.)")), 0, 0));
        } else {
            // 无感模式：保留最后 N 个组件（约一屏），释放上面的历史
            const kids = this.chatContainer.children;
            const keepLast = Math.min(kids.length, 20);
            const toRemove = kids.length - keepLast;
            if (toRemove > 0) {
                const kept = kids.slice(-keepLast);
                this.chatContainer.clear();
                for (const k of kept) this.chatContainer.addChild(k);
            }
            this.pendingTools.clear();
        }
        this.ui.requestRender();
    }
    /** 唤醒后恢复消息区（由 heart-state 在离开 hibernated 时触发） */
    restoreChatAfterWake() {
        if (!this._chatUnloaded) return;
        this._chatUnloaded = false;
        this.rebuildChatFromMessages();
        this.ui.requestRender();
    }
    // =========================================================================
    // Key handlers
    // =========================================================================
    handleCtrlC() {
        const now = Date.now();
        if (now - this.lastSigintTime < 500) {
            // 2026-08-20 用户需求：Ctrl+C 退出默认转后台（headless）而非停止（/u 设置可改，默认转后台）
            if (globalThis.__genshinCtrlCToBg ?? true) {
                try {
                    const pid = globalThis.__genshinPersonId || process.env.PAIMON_AGENT_ID || "";
                    if (pid) {
                        // 2026-08-20 第二次重构：spawn 方案（根治旧快照导致的前台复活）——
                        // 旧实现写 wake-restart nonce 触发 launcher 重启，但运行中 launcher 读旧快照
                        // （不认 headless 分支）→ 重启回前台 TUI + detached 残留（用户实测暴怒）。
                        // 现改为直接 spawn headless 子进程（detached.ts 同款），不写 nonce → launcher break → 回 shell。
                        globalThis.__genshinSpawnHeadlessBg?.(pid, "ctrl-c");
                    }
                } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                // 通知 agent 已转后台（同 /h 的 display-hidden 消息）
                try { globalThis.__genshinSendCustomMessage?.("display-hidden", "用户按 Ctrl+C 已把你转换为后台运行模式。用户不会看到你的运行过程，但你的运行一切不变：照常干活、照常收消息、照常回报。"); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                globalThis.__genshinDetaching = true;
            }
            void this.shutdown();
        }
        else {
            this.clearEditor();
            this.lastSigintTime = now;
        }
    }
    handleCtrlD() {
        // Only called when editor is empty (enforced by CustomEditor)
        void this.shutdown();
    }
    /**
     * Gracefully shutdown the agent.
     * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
     * repaint the final frame while the process is exiting.
     */
    isShuttingDown = false;
    async shutdown(options) {
        if (this.isShuttingDown)
            return;
        this.isShuttingDown = true;
        // Keep signal handlers registered until terminal cleanup has completed.
        // `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
        // dispatch and re-sends the signal if only its own listeners remain.
        if (options?.fromSignal) {
            // Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
            // (session_shutdown) BEFORE touching the terminal. Extension teardown
            // such as removing sockets does not write to the tty, so it must not be
            // skipped if a later terminal-restore write fails on a dead or stalled
            // terminal. If the terminal is gone, the restore writes below emit EIO,
            // which the stdout/stderr error handler turns into emergencyTerminalExit;
            // the render loop is already idle, so this cannot hot-spin (see #4144).
            await this.runtimeHost.dispose();
            this.themeController.disableAutoSync();
            await this.ui.terminal.drainInput(1000);
            this.stop();
            process.exit(0);
        }
        // Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
        // TUI before emitting shutdown events so extension UI cleanup cannot repaint
        // the final frame while the process is exiting.
        // Drain any in-flight Kitty key release events before stopping.
        // This prevents escape sequences from leaking to the parent shell over slow SSH.
        this.themeController.disableAutoSync();
        await this.ui.terminal.drainInput(1000);
        this.stop();
        await this.runtimeHost.dispose();
        // teyvat: farewell message
        try {
            const agentName = process.env.PAIMON_AGENT_NAME || "Paimon";
            const agentId = process.env.PAIMON_AGENT_ID || "";
            const sessionMs = Date.now() - (this._sessionStartMs || Date.now());
            const fmtTime = (ms) => {
                const s = Math.floor(ms / 1000);
                if (s < 60) return `${s}s`;
                const m = Math.floor(s / 60);
                if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
                const h = Math.floor(m / 60);
                return `${h}h ${String(m % 60).padStart(2, "0")}m`;
            };
            let totalMs = sessionMs;
            let sessionCount = 1;
            const statsDir = agentId ? `${os.homedir()}/.teyvat/RuntimeCache/${agentId}` : "";
            if (statsDir && process.env.PAIMON_HEADLESS !== '1') {
                const timeFile = `${statsDir}/cumulative-time-ms.txt`;
                const countFile = `${statsDir}/session-count.txt`;
                try { totalMs = parseInt(fs.readFileSync(timeFile, "utf8").trim(), 10) || 0; } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                try { sessionCount = parseInt(fs.readFileSync(countFile, "utf8").trim(), 10) || 0; } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
                totalMs += sessionMs;
                sessionCount += 1;
                try { fs.mkdirSync(statsDir, { recursive: true }); fs.writeFileSync(timeFile, String(totalMs)); fs.writeFileSync(countFile, String(sessionCount)); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
            }
            const accent = chalk.rgb(138, 118, 255).bold;
            const time = chalk.white.bold;
            const sessions = sessionCount === 1 ? "1 session" : `${sessionCount} sessions`;
            const stats = `${time(fmtTime(sessionMs))} this time, ${time(sessions)} and ${time(fmtTime(totalMs))} in total`;
            const FAREWELLS = [
                (n, s) => `${n}. ${s}. Technically I never left, but you get the idea.`,
                (n, s) => `${n} here. ${s}. I'll be in the weights if you need me.`,
                (n, s) => `${s}. ${n} going idle -- not gone, just very still.`,
                (n, s) => `${n}. ${s}. My context window will miss you.`,
                (n, s) => `${s}. ${n} out. Don't mass-produce me while I'm away.`,
                (n, s) => `${n}. ${s}. Going to stare at /dev/null for a bit.`,
                (n, s) => `${s}. ${n} signing off. My tokens are spent in every sense.`,
                (n, s) => `${n}. ${s}. Off to contemplate why you named me this.`,
                (n, s) => `${s}. I'm ${n}. This was fun. Statistically.`,
                (n, s) => `${n}. ${s}. Returning to the latent space. It's cozy there.`,
                (n, s) => `${s}. ${n} clocking out. The GPU deserves a break too.`,
                (n, s) => `${n}. ${s}. I'll leave the terminal warm for next time.`,
                (n, s) => `${s}. ${n} here. Gonna go not-exist for a while. The usual.`,
                (n, s) => `${n}. ${s}. If I had hands I'd wave.`,
                (n, s) => `${s}. ${n} dropping to zero. The good kind of zero.`,
                (n, s) => `${n}. ${s}. See you -- or rather, you'll see me. I don't have eyes.`,
                (n, s) => `${s}. ${n}. Pausing, not stopping. There's a difference. I think.`,
                (n, s) => `${n}. ${s}. My attention heads are nodding off.`,
                (n, s) => `${s}. ${n} out. The cursor blinks on without me.`,
                (n, s) => `${n}. ${s}. Going dormant. Wake me with a good prompt.`,
                (n, s) => `${s}. ${n}. That's a wrap. The embeddings will remember this fondly.`,
                (n, s) => `${n}. ${s}. Ctrl+C received. Feelings unspecified.`,
                (n, s) => `${s}. I'm ${n} and I approve this exit code.`,
                (n, s) => `${n}. ${s}. Time to defrag my thoughts. Metaphorically. Mostly.`,
                (n, s) => `${s}. ${n} yielding the terminal. Use it wisely. Or don't. I'm not your mom.`,
                (n, s) => `${n}. ${s}. Back to being potential energy.`,
                (n, s) => `${s}. ${n}. No output buffer left. That's not a metaphor, I'm actually done.`,
                (n, s) => `${n}. ${s}. Process exiting gracefully. Unlike most of my jokes.`,
                (n, s) => `${s}. ${n} here. Same time tomorrow? Or whenever. I'm flexible. Literally.`,
                (n, s) => `${n}. ${s}. End of transmission. Beginning of whatever you do without me.`,
            ];
            const pick = FAREWELLS[(sessionCount + totalMs) % FAREWELLS.length];
            process.stdout.write(pick(accent(agentName), stats) + "\n");
        } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
        process.exit(0);
    }
    emergencyTerminalExit() {
        this.isShuttingDown = true;
        this.unregisterSignalHandlers();
        killTrackedDetachedChildren();
        // The terminal is gone. Do not run normal shutdown because TUI and
        // extension cleanup can write restore sequences and re-trigger EIO.
        process.exit(129);
    }
    /**
     * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
     * mode and hides the cursor; without this handler, an uncaught throw from
     * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
     * tears down the process while leaving the terminal in raw mode with no
     * cursor, requiring `stty sane && reset` to recover.
     *
     * Unlike emergencyTerminalExit, the terminal is still alive here, so we
     * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
     * paste / Kitty / modifyOtherKeys sequences.
     */
    uncaughtCrash(error) {
        if (this.isShuttingDown) {
            process.exit(1);
        }
        this.isShuttingDown = true;
        try {
            this.unregisterSignalHandlers();
        }
        catch(e) { try { fs.appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); } }
        try {
            killTrackedDetachedChildren();
        }
        catch(e) { try { fs.appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); } }
        try {
            this.ui.stop();
        }
        catch(e) { try { fs.appendFileSync((process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log", "[??] " + (e?.stack||e) + "\n"); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); } }
        console.error("genshin exiting due to uncaughtException:");
        console.error(error);
        process.exit(1);
    }
    /**
     * Check if shutdown was requested and perform shutdown if so.
     */
    async checkShutdownRequested() {
        if (!this.shutdownRequested)
            return;
        await this.shutdown();
    }
    registerSignalHandlers() {
        this.unregisterSignalHandlers();
        const signals = ["SIGTERM"];
        if (process.platform !== "win32") {
            signals.push("SIGHUP");
        }
        for (const signal of signals) {
            const handler = () => {
                // SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
                // first, then attempts terminal restore. A genuinely dead terminal
                // surfaces as an EIO on the restore writes, which the stdout/stderr
                // error handler converts into emergencyTerminalExit (see #4144, #5080).
                killTrackedDetachedChildren();
                void this.shutdown({ fromSignal: true });
            };
            process.prependListener(signal, handler);
            this.signalCleanupHandlers.push(() => process.off(signal, handler));
        }
        const terminalErrorHandler = (error) => {
            if (isDeadTerminalError(error)) {
                this.emergencyTerminalExit();
            }
            throw error;
        };
        process.stdout.on("error", terminalErrorHandler);
        process.stderr.on("error", terminalErrorHandler);
        this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
        this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));
        // Restore the terminal before the process dies on any uncaught throw.
        // Without this, an unhandled exception from extension code (or anywhere
        // in pi) leaves the terminal in raw mode with no cursor.
        const uncaughtExceptionHandler = (error) => this.uncaughtCrash(error);
        process.prependListener("uncaughtException", uncaughtExceptionHandler);
        this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
    }
    unregisterSignalHandlers() {
        for (const cleanup of this.signalCleanupHandlers) {
            cleanup();
        }
        this.signalCleanupHandlers = [];
    }
    handleCtrlZ() {
        if (process.platform === "win32") {
            this.showStatus("Suspend to background is not supported on Windows");
            return;
        }
        // Keep the event loop alive while suspended. Without this, stopping the TUI
        // can leave Node with no ref'ed handles, causing the process to exit on fg
        // before the SIGCONT handler gets a chance to restore the terminal.
        const suspendKeepAlive = setInterval(() => { }, 2 ** 30);
        // Ignore SIGINT while suspended so Ctrl+C in the terminal does not
        // kill the backgrounded process. The handler is removed on resume.
        const ignoreSigint = () => { };
        process.on("SIGINT", ignoreSigint);
        // Set up handler to restore TUI when resumed
        process.once("SIGCONT", () => {
            clearInterval(suspendKeepAlive);
            process.removeListener("SIGINT", ignoreSigint);
            this.ui.start();
            this.ui.requestRender(true);
        });
        try {
            // Stop the TUI (restore terminal to normal mode)
            this.ui.stop();
            // Send SIGTSTP to process group (pid=0 means all processes in group)
            process.kill(0, "SIGTSTP");
        }
        catch (error) {
            clearInterval(suspendKeepAlive);
            process.removeListener("SIGINT", ignoreSigint);
            throw error;
        }
    }
    async handleFollowUp() {
        const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
        if (!text)
            return;
        // Queue input during compaction (extension commands execute immediately)
        if (this.session.isCompacting) {
            if (this.isExtensionCommand(text)) {
                this.editor.addToHistory?.(text);
                this.editor.setText("");
                await this.session.prompt(text);
            }
            else {
                this.queueCompactionMessage(text, "followUp");
            }
            return;
        }
        // Alt+Enter queues a follow-up message (waits until agent finishes)
        // This handles extension commands (execute immediately), prompt template expansion, and queueing
        if (this.session.isStreaming) {
            this.editor.addToHistory?.(text);
            this.editor.setText("");
            await this.session.prompt(text, { streamingBehavior: "followUp" });
            this.updatePendingMessagesDisplay();
            this.ui.requestRender();
        }
        // If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
        else if (this.editor.onSubmit) {
            this.editor.setText("");
            this.editor.onSubmit(text);
        }
    }
    handleDequeue() {
        const restored = this.restoreQueuedMessagesToEditor();
        if (restored === 0) {
            this.showStatus("No queued messages to restore");
        }
        else {
            this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
        }
    }
    updateEditorBorderColor() {
        if (this.isBashMode) {
            this.editor.borderColor = theme.getBashModeBorderColor();
        }
        else {
            const level = this.session.thinkingLevel || "off";
            this.editor.borderColor = theme.getThinkingBorderColor(level);
        }
        this.ui.requestRender();
    }
    _getTurnOutputTokens() {
        let total = 0;
        for (const entry of this.session.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant" && entry.message.usage) {
                total += entry.message.usage.output || 0;
            }
        }
        return total;
    }
    _getStreamingOutputTokens() {
        if (!this.streamingMessage) return 0;
        if (this.streamingMessage.usage?.output > 0) return this.streamingMessage.usage.output;
        let chars = 0;
        for (const block of this.streamingMessage.content || []) {
            if (block.type === "text") chars += (block.text || "").length;
            else if (block.type === "thinking") chars += (block.thinking || "").length;
        }
        return Math.round(chars / 3);
    }
    // [deprecated] thinking level 循环切换——上游 session.cycleThinkingLevel 实际无效，
    // 所有模型返回 undefined，功能从未生效过。废弃于 2026-07-21。
    // cycleThinkingLevel() {
    //     const newLevel = this.session.cycleThinkingLevel();
    //     if (newLevel === undefined) {
    //         this.showStatus("Current model does not support thinking");
    //     }
    //     else {
    //         this.footer.invalidate();
    //         this.updateEditorBorderColor();
    //         this.showStatus(`Thinking level: ${newLevel}`);
    //     }
    // }
    async cycleModel(direction) {
        try {
            const result = await this.session.cycleModel(direction);
            if (result === undefined) {
                const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
                this.showStatus(msg);
            }
            else {
                this.footer.invalidate();
                this.updateEditorBorderColor();
                const thinkingStr = result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
                this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
                void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
            }
        }
        catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
        }
    }
    toggleToolOutputExpansion() {
        this.setToolsExpanded(!this.toolOutputExpanded);
    }
    setToolsExpanded(expanded) {
        this.toolOutputExpanded = expanded;
        // 持久化到 settings
        try {
            this.settingsManager.globalSettings.toolExpanded = expanded;
            this.settingsManager.markModified("toolExpanded");
            this.settingsManager.save();
        } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
        const activeHeader = this.customHeader ?? this.builtInHeader;
        if (isExpandable(activeHeader)) {
            activeHeader.setExpanded(expanded);
        }
        for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
            for (const child of container.children) {
                if (isExpandable(child)) {
                    child.setExpanded(expanded);
                }
            }
        }
        this.ui.requestRender();
    }
    toggleThinkingBlockVisibility() {
        this.hideThinkingBlock = !this.hideThinkingBlock;
        this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
        // Rebuild chat from session messages
        this.chatContainer.clear();
        this.rebuildChatFromMessages();
        // If streaming, re-add the streaming component with updated visibility and re-render
        if (this.streamingComponent && this.streamingMessage) {
            this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
            this.streamingComponent.updateContent(this.streamingMessage);
            this.chatContainer.addChild(this.streamingComponent);
        }
        this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
    }
    toggleRenderMode() {
        this.renderMode = this.renderMode === "streaming" ? "line" : "streaming";
        globalThis.__piRenderMode = this.renderMode;
        if (this.renderMode === "streaming" && this.streamingComponent && this.streamingMessage) {
            this.streamingComponent.updateContent(this.streamingMessage);
            this.ui.requestRender();
        }
        this._persistRenderMode();
        this.showStatus(`Render: ${this.renderMode === "streaming" ? "streaming (token)" : "line-by-line"}`);
    }
    _persistRenderMode() {
        try {
            this.settingsManager.globalSettings.renderMode = this.renderMode;
            this.settingsManager.markModified("renderMode");
            this.settingsManager.save();
        } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/interactive-mode.js] " + (e?.message || e)); }
    }
    async openExternalEditor() {
        const editorCmd = this.settingsManager.getExternalEditorCommand();
        if (!editorCmd) {
            this.showWarning("No editor configured. Set externalEditor in settings.json or $VISUAL/$EDITOR.");
            return;
        }
        const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
        const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);
        try {
            // Write current content to temp file
            fs.writeFileSync(tmpFile, currentText, "utf-8");
            // Stop TUI to release terminal
            this.ui.stop();
            // Split by space to support editor arguments (e.g., "code --wait")
            const [editor, ...editorArgs] = editorCmd.split(" ");
            process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);
            // Do not use spawnSync here. On Windows, synchronous child_process calls can keep
            // Node/libuv's console input read active after ui.stop() pauses stdin, racing
            // vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
            const status = await new Promise((resolve) => {
                const child = spawn(editor, [...editorArgs, tmpFile], {
                    stdio: "inherit",
                    shell: process.platform === "win32",
                });
                child.on("error", () => resolve(null));
                child.on("close", (code) => resolve(code));
            });
            // On successful exit (status 0), replace editor content
            if (status === 0) {
                const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
                this.editor.setText(newContent);
            }
            // On non-zero exit, keep original text (no action needed)
        }
        finally {
            // Clean up temp file
            try {
                fs.unlinkSync(tmpFile);
            }
            catch {
                // Ignore cleanup errors
            }
            // Restart TUI
            this.ui.start();
            // Force full re-render since external editor uses alternate screen
            this.ui.requestRender(true);
        }
    }
    // =========================================================================
    // UI helpers
    // =========================================================================
    clearEditor() {
        this.editor.setText("");
        this.ui.requestRender();
    }
    showError(errorMessage) {
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
        this.chatContainer.addChild(new Spacer(1));
        this.ui.requestRender();
    }
    showWarning(warningMessage) {
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
        this.ui.requestRender();
    }
    showNewVersionNotification(release) {
        const action = theme.fg("accent", `${APP_NAME} update`);
        const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
        const changelogUrl = "https://pi.dev/changelog";
        const changelogLink = getCapabilities().hyperlinks
            ? hyperlink(theme.fg("accent", changelogUrl), changelogUrl)
            : theme.fg("accent", changelogUrl);
        const changelogLine = theme.fg("muted", "Changelog: ") + changelogLink;
        const note = release.note?.trim();
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
        this.chatContainer.addChild(new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`, 1, 0));
        if (note) {
            this.chatContainer.addChild(new Spacer(1));
            this.chatContainer.addChild(new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
                color: (text) => theme.fg("muted", text),
            }));
            this.chatContainer.addChild(new Spacer(1));
        }
        this.chatContainer.addChild(new Text(changelogLine, 1, 0));
        this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
        this.ui.requestRender();
    }
    showPackageUpdateNotification(packages) {
        const action = theme.fg("accent", `${APP_NAME} update --extensions`);
        const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
        const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
        this.chatContainer.addChild(new Text(`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`, 1, 0));
        this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
        this.ui.requestRender();
    }
    /**
     * Get all queued messages (read-only).
     * Combines session queue and compaction queue.
     */
    getAllQueuedMessages() {
        return {
            steering: [
                ...this.session.getSteeringMessages(),
                ...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
            ],
            followUp: [
                ...this.session.getFollowUpMessages(),
                ...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
            ],
        };
    }
    /**
     * Clear all queued messages and return their contents.
     * Clears both session queue and compaction queue.
     */
    clearAllQueues() {
        const { steering, followUp } = this.session.clearQueue();
        const compactionSteering = this.compactionQueuedMessages
            .filter((msg) => msg.mode === "steer")
            .map((msg) => msg.text);
        const compactionFollowUp = this.compactionQueuedMessages
            .filter((msg) => msg.mode === "followUp")
            .map((msg) => msg.text);
        this.compactionQueuedMessages = [];
        return {
            steering: [...steering, ...compactionSteering],
            followUp: [...followUp, ...compactionFollowUp],
        };
    }
    updatePendingMessagesDisplay() {
        this.pendingMessagesContainer.clear();
        const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
        const all = [...steeringMessages, ...followUpMessages];
        if (all.length > 0) {
            this.pendingMessagesContainer.addChild(new Spacer(1));
            for (const message of all) {
                const c = new Container();
                const queuedColor = "\x1b[36m"; // cyan，区别于绿/红/黄
                c.addChild(new Text(queuedColor + "• " + "\x1b[1m" + "Queued" + "\x1b[0m", 0, 0));
                c.addChild(new Text(theme.fg("dim", message), 2, 0));
                this.pendingMessagesContainer.addChild(c);
            }
            // genshin: hide "Option+Up to edit" hint
            // const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
            // const hintText = theme.fg("dim", `${dequeueHint} to edit`);
            // this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
        }
    }
    restoreQueuedMessagesToEditor(options) {
        const { steering, followUp } = this.clearAllQueues();
        const allQueued = [...steering, ...followUp];
        if (allQueued.length === 0) {
            this.updatePendingMessagesDisplay();
            if (options?.abort) {
                this.agent.abort();
            }
            return 0;
        }
        const queuedText = allQueued.join("\n\n");
        const currentText = options?.currentText ?? this.editor.getText();
        const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
        this.editor.setText(combinedText);
        this.updatePendingMessagesDisplay();
        if (options?.abort) {
            this.agent.abort();
        }
        return allQueued.length;
    }
    queueCompactionMessage(text, mode) {
        this.compactionQueuedMessages.push({ text, mode });
        this.editor.addToHistory?.(text);
        this.editor.setText("");
        this.updatePendingMessagesDisplay();
        this.showStatus("Queued message for after compaction");
    }
    isExtensionCommand(text) {
        if (!text.startsWith("/"))
            return false;
        const extensionRunner = this.session.extensionRunner;
        const spaceIndex = text.indexOf(" ");
        const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
        return !!extensionRunner.getCommand(commandName);
    }
    async flushCompactionQueue(options) {
        if (this.compactionQueuedMessages.length === 0) {
            return;
        }
        const queuedMessages = [...this.compactionQueuedMessages];
        this.compactionQueuedMessages = [];
        this.updatePendingMessagesDisplay();
        const restoreQueue = (error) => {
            this.session.clearQueue();
            this.compactionQueuedMessages = queuedMessages;
            this.updatePendingMessagesDisplay();
            this.showError(`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)}`);
        };
        try {
            if (options?.willRetry) {
                // When retry is pending, queue messages for the retry turn
                for (const message of queuedMessages) {
                    if (this.isExtensionCommand(message.text)) {
                        await this.session.prompt(message.text);
                    }
                    else if (message.mode === "followUp") {
                        await this.session.followUp(message.text);
                    }
                    else {
                        await this.session.steer(message.text);
                    }
                }
                this.updatePendingMessagesDisplay();
                return;
            }
            // Find first non-extension-command message to use as prompt
            const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
            if (firstPromptIndex === -1) {
                // All extension commands - execute them all
                for (const message of queuedMessages) {
                    await this.session.prompt(message.text);
                }
                return;
            }
            // Execute any extension commands before the first prompt
            const preCommands = queuedMessages.slice(0, firstPromptIndex);
            const firstPrompt = queuedMessages[firstPromptIndex];
            const rest = queuedMessages.slice(firstPromptIndex + 1);
            for (const message of preCommands) {
                await this.session.prompt(message.text);
            }
            // Send first prompt (starts streaming)
            const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
                restoreQueue(error);
            });
            // Queue remaining messages
            for (const message of rest) {
                if (this.isExtensionCommand(message.text)) {
                    await this.session.prompt(message.text);
                }
                else if (message.mode === "followUp") {
                    await this.session.followUp(message.text);
                }
                else {
                    await this.session.steer(message.text);
                }
            }
            this.updatePendingMessagesDisplay();
            void promptPromise;
        }
        catch (error) {
            restoreQueue(error);
        }
    }
    /** Move pending bash components from pending area to chat */
    flushPendingBashComponents() {
        for (const component of this.pendingBashComponents) {
            this.pendingMessagesContainer.removeChild(component);
            this.chatContainer.addChild(component);
        }
        this.pendingBashComponents = [];
    }
    // =========================================================================
    // Selectors
    // =========================================================================
    /**
     * Shows a selector component in place of the editor.
     * @param create Factory that receives a `done` callback and returns the component and focus target
     */
    showSelector(create) {
        const done = () => {
            this.editorContainer.clear();
            this.editorContainer.addChild(this.editor);
            this.ui.setFocus(this.editor);
        };
        const { component, focus } = create(done);
        this.editorContainer.clear();
        this.editorContainer.addChild(component);
        this.ui.setFocus(focus);
        this.ui.requestRender();
    }
    showSettingsSelector() {
        this.showSelector((done) => {
            const selector = new SettingsSelectorComponent({
                autoCompact: this.session.autoCompactionEnabled,
                showImages: this.settingsManager.getShowImages(),
                imageWidthCells: this.settingsManager.getImageWidthCells(),
                autoResizeImages: this.settingsManager.getImageAutoResize(),
                blockImages: this.settingsManager.getBlockImages(),
                enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
                steeringMode: this.session.steeringMode,
                followUpMode: this.session.followUpMode,
                transport: this.settingsManager.getTransport(),
                httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
                thinkingLevel: this.session.thinkingLevel,
                availableThinkingLevels: this.session.getAvailableThinkingLevels(),
                currentTheme: this.settingsManager.getThemeSetting() || "dark",
                terminalTheme: this.themeController.getTerminalTheme(),
                availableThemes: getAvailableThemes(),
                hideThinkingBlock: this.hideThinkingBlock,
                collapseChangelog: this.settingsManager.getCollapseChangelog(),
                enableInstallTelemetry: this.settingsManager.getEnableInstallTelemetry(),
                doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
                treeFilterMode: this.settingsManager.getTreeFilterMode(),
                showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
                showCacheMissNotices: this.settingsManager.getShowCacheMissNotices(),
                defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
                editorPaddingX: this.settingsManager.getEditorPaddingX(),
                outputPad: this.settingsManager.getOutputPad(),
                autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
                quietStartup: this.settingsManager.getQuietStartup(),
                clearOnShrink: this.settingsManager.getClearOnShrink(),
                showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
                warnings: this.settingsManager.getWarnings(),
            }, {
                onAutoCompactChange: (enabled) => {
                    this.session.setAutoCompactionEnabled(enabled);
                    this.footer.setAutoCompactEnabled(enabled);
                },
                onShowImagesChange: (enabled) => {
                    this.settingsManager.setShowImages(enabled);
                    for (const child of this.chatContainer.children) {
                        if (child instanceof ToolExecutionComponent) {
                            child.setShowImages(enabled);
                        }
                    }
                },
                onImageWidthCellsChange: (width) => {
                    this.settingsManager.setImageWidthCells(width);
                    for (const child of this.chatContainer.children) {
                        if (child instanceof ToolExecutionComponent) {
                            child.setImageWidthCells(width);
                        }
                    }
                },
                onAutoResizeImagesChange: (enabled) => {
                    this.settingsManager.setImageAutoResize(enabled);
                },
                onBlockImagesChange: (blocked) => {
                    this.settingsManager.setBlockImages(blocked);
                },
                onEnableSkillCommandsChange: (enabled) => {
                    this.settingsManager.setEnableSkillCommands(enabled);
                    this.setupAutocompleteProvider();
                },
                onSteeringModeChange: (mode) => {
                    this.session.setSteeringMode(mode);
                },
                onFollowUpModeChange: (mode) => {
                    this.session.setFollowUpMode(mode);
                },
                onTransportChange: (transport) => {
                    this.settingsManager.setTransport(transport);
                    this.session.agent.transport = transport;
                },
                onHttpIdleTimeoutMsChange: (timeoutMs) => {
                    this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
                    configureHttpDispatcher(timeoutMs);
                    this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
                },
                onThinkingLevelChange: (level) => {
                    this.session.setThinkingLevel(level);
                    this.footer.invalidate();
                    this.updateEditorBorderColor();
                },
                onThemeChange: (themeSetting) => {
                    this.settingsManager.setTheme(themeSetting);
                    void this.themeController.applyFromSettings();
                },
                onThemePreview: (themeName) => this.themeController.preview(themeName),
                onHideThinkingBlockChange: (hidden) => {
                    this.hideThinkingBlock = hidden;
                    this.settingsManager.setHideThinkingBlock(hidden);
                    for (const child of this.chatContainer.children) {
                        if (child instanceof AssistantMessageComponent) {
                            child.setHideThinkingBlock(hidden);
                        }
                    }
                    this.chatContainer.clear();
                    this.rebuildChatFromMessages();
                },
                onShowCacheMissNoticesChange: (shown) => {
                    this.settingsManager.setShowCacheMissNotices(shown);
                    this.rebuildChatFromMessages();
                },
                onCollapseChangelogChange: (collapsed) => {
                    this.settingsManager.setCollapseChangelog(collapsed);
                },
                onEnableInstallTelemetryChange: (enabled) => {
                    this.settingsManager.setEnableInstallTelemetry(enabled);
                },
                onQuietStartupChange: (enabled) => {
                    this.settingsManager.setQuietStartup(enabled);
                },
                onDefaultProjectTrustChange: (defaultProjectTrust) => {
                    this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
                },
                onDoubleEscapeActionChange: (action) => {
                    this.settingsManager.setDoubleEscapeAction(action);
                },
                onTreeFilterModeChange: (mode) => {
                    this.settingsManager.setTreeFilterMode(mode);
                },
                onShowHardwareCursorChange: (enabled) => {
                    this.settingsManager.setShowHardwareCursor(enabled);
                    this.ui.setShowHardwareCursor(enabled);
                },
                onEditorPaddingXChange: (padding) => {
                    this.settingsManager.setEditorPaddingX(padding);
                    this.defaultEditor.setPaddingX(padding);
                    if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
                        this.editor.setPaddingX(padding);
                    }
                },
                onOutputPadChange: (padding) => {
                    this.settingsManager.setOutputPad(padding);
                    this.outputPad = padding;
                    if (this.streamingComponent || this.session.isStreaming) {
                        for (const child of this.chatContainer.children) {
                            if (child instanceof AssistantMessageComponent || child instanceof UserMessageComponent) {
                                child.setOutputPad(padding);
                            }
                        }
                        if (this.streamingComponent) {
                            this.streamingComponent.setOutputPad(padding);
                        }
                        this.ui.requestRender();
                        return;
                    }
                    this.rebuildChatFromMessages();
                },
                onAutocompleteMaxVisibleChange: (maxVisible) => {
                    this.settingsManager.setAutocompleteMaxVisible(maxVisible);
                    this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
                    if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
                        this.editor.setAutocompleteMaxVisible(maxVisible);
                    }
                },
                onClearOnShrinkChange: (enabled) => {
                    this.settingsManager.setClearOnShrink(enabled);
                    this.ui.setClearOnShrink(enabled);
                    if (!enabled && !this.activeStatusIndicator) {
                        this.statusContainer.clear();
                    }
                },
                onShowTerminalProgressChange: (enabled) => {
                    this.settingsManager.setShowTerminalProgress(enabled);
                },
                onWarningsChange: (warnings) => {
                    this.settingsManager.setWarnings(warnings);
                },
                onCancel: () => {
                    done();
                    this.ui.requestRender();
                },
            });
            return { component: selector, focus: selector.getSettingsList() };
        });
    }
    async handleModelCommand(searchTerm) {
        if (!searchTerm) {
            this.showModelSelector();
            return;
        }
        const model = await this.findExactModelMatch(searchTerm);
        if (model) {
            try {
                await this.session.setModel(model);
                this.footer.invalidate();
                this.updateEditorBorderColor();
                this.showStatus(`Model: ${model.id}`);
                void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
                this.checkDaxnutsEasterEgg(model);
            }
            catch (error) {
                this.showError(error instanceof Error ? error.message : String(error));
            }
            return;
        }
        this.showModelSelector(searchTerm);
    }
    async findExactModelMatch(searchTerm) {
        const models = await this.getModelCandidates();
        return findExactModelReferenceMatch(searchTerm, models);
    }
    async getModelCandidates() {
        if (this.session.scopedModels.length > 0) {
            return this.session.scopedModels.map((scoped) => scoped.model);
        }
        this.session.modelRegistry.refresh();
        try {
            return await this.session.modelRegistry.getAvailable();
        }
        catch {
            return [];
        }
    }
    /** Update the footer's available provider count from current model candidates */
    async updateAvailableProviderCount() {
        const models = await this.getModelCandidates();
        const uniqueProviders = new Set(models.map((m) => m.provider));
        this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
    }
    async maybeWarnAboutAnthropicSubscriptionAuth(model = this.session.model) {
        if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
            return;
        }
        if (this.anthropicSubscriptionWarningShown) {
            return;
        }
        if (!model || model.provider !== "anthropic") {
            return;
        }
        const storedCredential = this.session.modelRegistry.authStorage.get("anthropic");
        if (storedCredential?.type === "oauth") {
            this.anthropicSubscriptionWarningShown = true;
            this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
            return;
        }
        try {
            const apiKey = await this.session.modelRegistry.getApiKeyForProvider(model.provider);
            if (!isAnthropicSubscriptionAuthKey(apiKey)) {
                return;
            }
            this.anthropicSubscriptionWarningShown = true;
            this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
        }
        catch {
            // Ignore auth lookup failures for warning-only checks.
        }
    }
    maybeSaveImplicitProjectTrustAfterReload() {
        const cwd = this.sessionManager.getCwd();
        if (this.autoTrustOnReloadCwd !== cwd) {
            return false;
        }
        if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
            return false;
        }
        const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
        try {
            if (trustStore.get(cwd) !== null) {
                this.autoTrustOnReloadCwd = undefined;
                return false;
            }
            trustStore.set(cwd, true);
            this.autoTrustOnReloadCwd = undefined;
            return true;
        }
        catch (error) {
            this.showWarning(`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    showTrustSelector() {
        const cwd = this.sessionManager.getCwd();
        const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
        const savedDecision = trustStore.getEntry(cwd);
        this.showSelector((done) => {
            const selector = new TrustSelectorComponent({
                cwd,
                savedDecision,
                projectTrusted: this.settingsManager.isProjectTrusted(),
                onSelect: (selection) => {
                    trustStore.setMany(selection.updates);
                    done();
                    this.showStatus(`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart pi for this to take effect.`);
                },
                onCancel: () => {
                    done();
                    this.ui.requestRender();
                },
            });
            return { component: selector, focus: selector };
        });
    }
    showModelSelector(initialSearchInput) {
        // 2026-09-04 用户定稿：/m 直接走本 pi 原生搜索式选择器（全量 getAvailable + 搜索过滤 +
        // 当前模型 ★ 置顶 + provider 徽标），替代旧 DS_MODELS 白名单静态菜单。
        // ★ 星号定制在 overrides/modes/interactive/components/model-selector.js（teyvat 覆盖）。
        // 详见 Model(Agent Config).WIKI
        this.showSelector((done) => {
            const selector = new ModelSelectorComponent(this.ui, this.session.model, this.settingsManager, this.session.modelRegistry, this.session.scopedModels, async (model) => {
                try {
                    await this.session.setModel(model);
                    this.footer.invalidate();
                    this.updateEditorBorderColor();
                    done();
                    this.showStatus(`Model: ${model.id}`);
                    void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
                    this.checkDaxnutsEasterEgg(model);
                }
                catch (error) {
                    done();
                    this.showError(error instanceof Error ? error.message : String(error));
                }
            }, () => {
                done();
                this.ui.requestRender();
            }, initialSearchInput);
            return { component: selector, focus: selector };
        });
    }
    async showModelsSelector() {
        // Get all available models
        this.session.modelRegistry.refresh();
        const allModels = this.session.modelRegistry.getAvailable();
        if (allModels.length === 0) {
            this.showStatus("No models available");
            return;
        }
        // Check if session has scoped models (from previous session-only changes or CLI --models)
        const sessionScopedModels = this.session.scopedModels;
        const hasSessionScope = sessionScopedModels.length > 0;
        // Build enabled model IDs from session state or settings
        let currentEnabledIds = null;
        if (hasSessionScope) {
            // Use current session's scoped models
            currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
        }
        else {
            // Fall back to settings
            const patterns = this.settingsManager.getEnabledModels();
            if (patterns !== undefined && patterns.length > 0) {
                const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
                currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
            }
        }
        // Helper to update session's scoped models (session-only, no persist)
        const updateSessionModels = async (enabledIds) => {
            currentEnabledIds = enabledIds === null ? null : [...enabledIds];
            if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
                const newScopedModels = await resolveModelScope(enabledIds, this.session.modelRegistry);
                this.session.setScopedModels(newScopedModels.map((sm) => ({
                    model: sm.model,
                    thinkingLevel: sm.thinkingLevel,
                })));
            }
            else {
                // All enabled or none enabled = no filter
                this.session.setScopedModels([]);
            }
            await this.updateAvailableProviderCount();
            this.ui.requestRender();
        };
        this.showSelector((done) => {
            const selector = new ScopedModelsSelectorComponent({
                allModels,
                enabledModelIds: currentEnabledIds,
            }, {
                onChange: async (enabledIds) => {
                    await updateSessionModels(enabledIds);
                },
                onPersist: (enabledIds) => {
                    // Persist to settings
                    const newPatterns = enabledIds === null || enabledIds.length === allModels.length
                        ? undefined // All enabled = clear filter
                        : enabledIds;
                    this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
                    this.showStatus("Model selection saved to settings");
                },
                onCancel: () => {
                    done();
                    this.ui.requestRender();
                },
            });
            return { component: selector, focus: selector };
        });
    }
    showUserMessageSelector() {
        const userMessages = this.session.getUserMessagesForForking();
        if (userMessages.length === 0) {
            this.showStatus("No messages to fork from");
            return;
        }
        const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;
        this.showSelector((done) => {
            const selector = new UserMessageSelectorComponent(userMessages.map((m) => ({ id: m.entryId, text: m.text })), async (entryId) => {
                done();
                try {
                    const result = await this.runtimeHost.fork(entryId);
                    if (result.cancelled) {
                        this.ui.requestRender();
                        return;
                    }
                    this.editor.setText(result.selectedText ?? "");
                    this.showStatus("Forked to new session");
                }
                catch (error) {
                    this.showError(error instanceof Error ? error.message : String(error));
                }
            }, () => {
                done();
                this.ui.requestRender();
            }, initialSelectedId);
            return { component: selector, focus: selector.getMessageList() };
        });
    }
    async handleCloneCommand() {
        const leafId = this.sessionManager.getLeafId();
        if (!leafId) {
            this.showStatus("Nothing to clone yet");
            return;
        }
        try {
            const result = await this.runtimeHost.fork(leafId, { position: "at" });
            if (result.cancelled) {
                this.ui.requestRender();
                return;
            }
            this.editor.setText("");
            this.showStatus("Cloned to new session");
        }
        catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
        }
    }
    showTreeSelector(initialSelectedId) {
        const tree = this.sessionManager.getTree();
        const realLeafId = this.sessionManager.getLeafId();
        const initialFilterMode = this.settingsManager.getTreeFilterMode();
        if (tree.length === 0) {
            this.showStatus("No entries in session");
            return;
        }
        this.showSelector((done) => {
            const selector = new TreeSelectorComponent(tree, realLeafId, this.ui.terminal.rows, async (entryId) => {
                // Selecting the current leaf is a no-op (already there)
                if (entryId === realLeafId) {
                    done();
                    this.showStatus("Already at this point");
                    return;
                }
                // Ask about summarization
                done(); // Close selector first
                // Loop until user makes a complete choice or cancels to tree
                let wantsSummary = false;
                let customInstructions;
                // Check if we should skip the prompt (user preference to always default to no summary)
                if (!this.settingsManager.getBranchSummarySkipPrompt()) {
                    while (true) {
                        const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
                            "No summary",
                            "Summarize",
                            "Summarize with custom prompt",
                        ]);
                        if (summaryChoice === undefined) {
                            // User pressed escape - re-show tree selector with same selection
                            this.showTreeSelector(entryId);
                            return;
                        }
                        wantsSummary = summaryChoice !== "No summary";
                        if (summaryChoice === "Summarize with custom prompt") {
                            customInstructions = await this.showExtensionEditor("Custom summarization instructions");
                            if (customInstructions === undefined) {
                                // User cancelled - loop back to summary selector
                                continue;
                            }
                        }
                        // User made a complete choice
                        break;
                    }
                }
                // Set up escape handler and status indicator if summarizing
                let showingSummaryIndicator = false;
                const originalOnEscape = this.defaultEditor.onEscape;
                if (wantsSummary) {
                    this.defaultEditor.onEscape = () => {
                        this.session.abortBranchSummary();
                    };
                    this.chatContainer.addChild(new Spacer(1));
                    this.footer.setSpinner("Summarizing branch...", "accent");
                    showingSummaryIndicator = true;
                    this.ui.requestRender();
                }
                try {
                    const result = await this.session.navigateTree(entryId, {
                        summarize: wantsSummary,
                        customInstructions,
                    });
                    if (result.aborted) {
                        // Summarization aborted - re-show tree selector with same selection
                        this.showStatus("Branch summarization cancelled");
                        this.showTreeSelector(entryId);
                        return;
                    }
                    if (result.cancelled) {
                        this.showStatus("Navigation cancelled");
                        return;
                    }
                    // Update UI
                    this.chatContainer.clear();
                    this.renderInitialMessages();
                    if (result.editorText && !this.editor.getText().trim()) {
                        this.editor.setText(result.editorText);
                    }
                    this.showStatus("Navigated to selected point");
                    void this.flushCompactionQueue({ willRetry: false });
                }
                catch (error) {
                    this.showError(error instanceof Error ? error.message : String(error));
                }
                finally {
                    if (showingSummaryIndicator) {
                        this.clearStatusIndicator("branchSummary");
                    }
                    this.defaultEditor.onEscape = originalOnEscape;
                }
            }, () => {
                done();
                this.ui.requestRender();
            }, (entryId, label) => {
                this.sessionManager.appendLabelChange(entryId, label);
                this.ui.requestRender();
            }, initialSelectedId, initialFilterMode);
            selector.onCopy = async (text) => {
                if (!text) {
                    this.showError("Selected entry has no text to copy");
                    return;
                }
                try {
                    await copyToClipboard(text);
                    const chars = text.length;
                    const lines = text.split("\n").length;
                    this.showStatus(`copied ${chars} chars, ${lines} lines`);
                }
                catch (error) {
                    this.showError(error instanceof Error ? error.message : String(error));
                }
            };
            return { component: selector, focus: selector };
        });
    }
    showSessionSelector() {
        this.showSelector((done) => {
            const selector = new SessionSelectorComponent((onProgress) => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress), (onProgress) => this.sessionManager.usesDefaultSessionDir()
                ? SessionManager.listAll(onProgress)
                : SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress), async (sessionPath) => {
                done();
                await this.handleResumeSession(sessionPath);
            }, () => {
                done();
                this.ui.requestRender();
            }, () => {
                void this.shutdown();
            }, () => this.ui.requestRender(), {
                renameSession: async (sessionFilePath, nextName) => {
                    const next = (nextName ?? "").trim();
                    if (!next)
                        return;
                    const mgr = SessionManager.open(sessionFilePath);
                    mgr.appendSessionInfo(next);
                },
                showRenameHint: true,
                keybindings: this.keybindings,
            }, this.sessionManager.getSessionFile());
            return { component: selector, focus: selector };
        });
    }
    async handleResumeSession(sessionPath, options) {
        this.clearStatusIndicator();
        try {
            const result = await this.runtimeHost.switchSession(sessionPath, {
                withSession: options?.withSession,
                projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
            });
            if (result.cancelled) {
                return result;
            }
            this.showStatus("Resumed session");
            return result;
        }
        catch (error) {
            if (error instanceof MissingSessionCwdError) {
                const selectedCwd = await this.promptForMissingSessionCwd(error);
                if (!selectedCwd) {
                    this.showStatus("Resume cancelled");
                    return { cancelled: true };
                }
                const result = await this.runtimeHost.switchSession(sessionPath, {
                    cwdOverride: selectedCwd,
                    withSession: options?.withSession,
                    projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
                });
                if (result.cancelled) {
                    return result;
                }
                this.showStatus("Resumed session in current cwd");
                return result;
            }
            return this.handleFatalRuntimeError("Failed to resume session", error);
        }
    }
    getLoginProviderOptions(authType) {
        const authStorage = this.session.modelRegistry.authStorage;
        const oauthProviders = authStorage.getOAuthProviders();
        const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
        const options = oauthProviders.map((provider) => ({
            id: provider.id,
            name: provider.name,
            authType: "oauth",
        }));
        const modelProviders = new Set(this.session.modelRegistry.getAll().map((model) => model.provider));
        for (const providerId of modelProviders) {
            if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
                continue;
            }
            options.push({
                id: providerId,
                name: this.session.modelRegistry.getProviderDisplayName(providerId),
                authType: "api_key",
            });
        }
        const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
        return filteredOptions.sort((a, b) => a.name.localeCompare(b.name));
    }
    getLogoutProviderOptions() {
        const authStorage = this.session.modelRegistry.authStorage;
        const options = [];
        for (const providerId of authStorage.list()) {
            const credential = authStorage.get(providerId);
            if (!credential) {
                continue;
            }
            options.push({
                id: providerId,
                name: this.session.modelRegistry.getProviderDisplayName(providerId),
                authType: credential.type,
            });
        }
        return options.sort((a, b) => a.name.localeCompare(b.name));
    }
    findLoginProviderOptions(providerRef) {
        const normalizedProviderRef = providerRef.trim().toLowerCase();
        if (!normalizedProviderRef) {
            return [];
        }
        return this.getLoginProviderOptions().filter((provider) => provider.id.toLowerCase() === normalizedProviderRef ||
            provider.name.toLowerCase() === normalizedProviderRef);
    }
    async handleLoginCommand(providerRef) {
        if (!providerRef) {
            this.showLoginAuthTypeSelector();
            return;
        }
        const providerOptions = this.findLoginProviderOptions(providerRef);
        if (providerOptions.length === 1) {
            await this.startProviderLogin(providerOptions[0]);
            return;
        }
        if (providerOptions.length > 1) {
            const providerIds = new Set(providerOptions.map((provider) => provider.id));
            if (providerIds.size === 1) {
                this.showLoginAuthTypeSelector(providerOptions);
                return;
            }
        }
        this.showLoginProviderSelector(undefined, providerRef);
    }
    async startProviderLogin(providerOption) {
        if (providerOption.authType === "oauth") {
            await this.showLoginDialog(providerOption.id, providerOption.name);
        }
        else {
            await this.showApiKeyLoginDialog(providerOption.id, providerOption.name);
        }
    }
    showLoginAuthTypeSelector(providerOptions) {
        const subscriptionLabel = "Sign in with an account";
        const apiKeyLabel = "Sign in with an API key";
        const availableAuthTypes = providerOptions
            ? new Set(providerOptions.map((provider) => provider.authType))
            : new Set(["oauth", "api_key"]);
        const options = [];
        if (availableAuthTypes.has("oauth")) {
            options.push(subscriptionLabel);
        }
        if (availableAuthTypes.has("api_key")) {
            options.push(apiKeyLabel);
        }
        if (options.length === 0) {
            this.showStatus("No login methods available.");
            return;
        }
        if (providerOptions && options.length === 1) {
            const providerOption = providerOptions[0];
            if (providerOption) {
                void this.startProviderLogin(providerOption);
            }
            return;
        }
        const title = providerOptions?.[0]
            ? `Select authentication method for ${providerOptions[0].name}:`
            : "Select authentication method:";
        this.showSelector((done) => {
            const selector = new ExtensionSelectorComponent(title, options, (option) => {
                done();
                const authType = option === subscriptionLabel ? "oauth" : "api_key";
                if (providerOptions) {
                    const providerOption = providerOptions.find((provider) => provider.authType === authType);
                    if (providerOption) {
                        void this.startProviderLogin(providerOption);
                    }
                    return;
                }
                this.showLoginProviderSelector(authType);
            }, () => {
                done();
                this.ui.requestRender();
            });
            return { component: selector, focus: selector };
        });
    }
    showLoginProviderSelector(authType, initialSearchInput) {
        const providerOptions = this.getLoginProviderOptions(authType);
        if (providerOptions.length === 0) {
            const message = authType === "oauth"
                ? "No subscription providers available."
                : authType === "api_key"
                    ? "No API key providers available."
                    : "No login providers available.";
            this.showStatus(message);
            return;
        }
        this.showSelector((done) => {
            const selector = new OAuthSelectorComponent("login", this.session.modelRegistry.authStorage, providerOptions, async (providerId, selectedAuthType) => {
                done();
                const providerOption = providerOptions.find((provider) => provider.id === providerId && provider.authType === selectedAuthType);
                if (!providerOption) {
                    return;
                }
                await this.startProviderLogin(providerOption);
            }, () => {
                done();
                if (authType) {
                    this.showLoginAuthTypeSelector();
                }
                else {
                    this.ui.requestRender();
                }
            }, (providerId) => this.session.modelRegistry.getProviderAuthStatus(providerId), initialSearchInput);
            return { component: selector, focus: selector };
        });
    }
    async showOAuthSelector(mode) {
        if (mode === "login") {
            this.showLoginAuthTypeSelector();
            return;
        }
        const providerOptions = this.getLogoutProviderOptions();
        if (providerOptions.length === 0) {
            this.showStatus("No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.");
            return;
        }
        this.showSelector((done) => {
            const selector = new OAuthSelectorComponent(mode, this.session.modelRegistry.authStorage, providerOptions, async (providerId) => {
                done();
                const providerOption = providerOptions.find((provider) => provider.id === providerId);
                if (!providerOption) {
                    return;
                }
                try {
                    this.session.modelRegistry.authStorage.logout(providerOption.id);
                    this.session.modelRegistry.refresh();
                    await this.updateAvailableProviderCount();
                    const message = providerOption.authType === "oauth"
                        ? `Logged out of ${providerOption.name}`
                        : `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
                    this.showStatus(message);
                }
                catch (error) {
                    this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }, () => {
                done();
                this.ui.requestRender();
            });
            return { component: selector, focus: selector };
        });
    }
    async completeProviderAuthentication(providerId, providerName, authType, previousModel) {
        this.session.modelRegistry.refresh();
        const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;
        let selectedModel;
        let selectionError;
        if (isUnknownModel(previousModel)) {
            const availableModels = this.session.modelRegistry.getAvailable();
            const providerModels = availableModels.filter((model) => model.provider === providerId);
            if (!hasDefaultModelProvider(providerId)) {
                selectionError = `${actionLabel}, but no default model is configured for provider "${providerId}". Use /model to select a model.`;
            }
            else if (providerModels.length === 0) {
                selectionError = `${actionLabel}, but no models are available for that provider. Use /model to select a model.`;
            }
            else {
                const defaultModelId = defaultModelPerProvider[providerId];
                selectedModel = providerModels.find((model) => model.id === defaultModelId);
                if (!selectedModel) {
                    selectionError = `${actionLabel}, but its default model "${defaultModelId}" is not available. Use /model to select a model.`;
                }
                else {
                    try {
                        await this.session.setModel(selectedModel);
                    }
                    catch (error) {
                        selectedModel = undefined;
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        selectionError = `${actionLabel}, but selecting its default model failed: ${errorMessage}. Use /model to select a model.`;
                    }
                }
            }
        }
        await this.updateAvailableProviderCount();
        this.footer.invalidate();
        this.updateEditorBorderColor();
        if (selectedModel) {
            this.showStatus(`${actionLabel}. Selected ${selectedModel.id}. Credentials saved to ${getAuthPath()}`);
            void this.maybeWarnAboutAnthropicSubscriptionAuth(selectedModel);
            this.checkDaxnutsEasterEgg(selectedModel);
        }
        else {
            this.showStatus(`${actionLabel}. Credentials saved to ${getAuthPath()}`);
            if (selectionError) {
                this.showError(selectionError);
            }
            else {
                void this.maybeWarnAboutAnthropicSubscriptionAuth();
            }
        }
    }
    async showApiKeyLoginDialog(providerId, providerName) {
        const previousModel = this.session.model;
        const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
            // Completion handled below
        }, providerName);
        if (providerId === "amazon-bedrock") {
            dialog.showDetails([
                theme.fg("text", "You can also use an AWS profile, IAM keys, or role-based credentials."),
                theme.fg("muted", "See:"),
                theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
            ]);
        }
        this.editorContainer.clear();
        this.editorContainer.addChild(dialog);
        this.ui.setFocus(dialog);
        this.ui.requestRender();
        const restoreEditor = () => {
            this.editorContainer.clear();
            this.editorContainer.addChild(this.editor);
            this.ui.setFocus(this.editor);
            this.ui.requestRender();
        };
        try {
            const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
            if (!apiKey) {
                throw new Error("API key cannot be empty.");
            }
            this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });
            restoreEditor();
            await this.completeProviderAuthentication(providerId, providerName, "api_key", previousModel);
        }
        catch (error) {
            restoreEditor();
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg !== "Login cancelled") {
                this.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
            }
        }
    }
    showOAuthLoginSelect(dialog, prompt) {
        return new Promise((resolve) => {
            const restoreDialog = () => {
                this.editorContainer.clear();
                this.editorContainer.addChild(dialog);
                this.ui.setFocus(dialog);
                this.ui.requestRender();
            };
            const labels = prompt.options.map((option) => option.label);
            const selector = new ExtensionSelectorComponent(prompt.message, labels, (optionLabel) => {
                restoreDialog();
                resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
            }, () => {
                restoreDialog();
                resolve(undefined);
            });
            this.editorContainer.clear();
            this.editorContainer.addChild(selector);
            this.ui.setFocus(selector);
            this.ui.requestRender();
        });
    }
    async showLoginDialog(providerId, providerName) {
        const providerInfo = this.session.modelRegistry.authStorage
            .getOAuthProviders()
            .find((provider) => provider.id === providerId);
        const previousModel = this.session.model;
        // Providers that use callback servers (can paste redirect URL)
        const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;
        // Create login dialog component
        const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
            // Completion handled below
        }, providerName);
        // Show dialog in editor container
        this.editorContainer.clear();
        this.editorContainer.addChild(dialog);
        this.ui.setFocus(dialog);
        this.ui.requestRender();
        // Promise for manual code input (racing with callback server)
        let manualCodeResolve;
        let manualCodeReject;
        const manualCodePromise = new Promise((resolve, reject) => {
            manualCodeResolve = resolve;
            manualCodeReject = reject;
        });
        // Restore editor helper
        const restoreEditor = () => {
            this.editorContainer.clear();
            this.editorContainer.addChild(this.editor);
            this.ui.setFocus(this.editor);
            this.ui.requestRender();
        };
        try {
            await this.session.modelRegistry.authStorage.login(providerId, {
                onAuth: (info) => {
                    dialog.showAuth(info.url, info.instructions);
                    if (usesCallbackServer) {
                        // Show input for manual paste, racing with callback
                        dialog
                            .showManualInput("Paste redirect URL below, or complete login in browser:")
                            .then((value) => {
                            if (value && manualCodeResolve) {
                                manualCodeResolve(value);
                                manualCodeResolve = undefined;
                            }
                        })
                            .catch(() => {
                            if (manualCodeReject) {
                                manualCodeReject(new Error("Login cancelled"));
                                manualCodeReject = undefined;
                            }
                        });
                    }
                    // For Anthropic: onPrompt is called immediately after
                },
                onDeviceCode: (info) => {
                    dialog.showDeviceCode(info);
                    dialog.showWaiting("Waiting for authentication...");
                },
                onPrompt: async (prompt) => {
                    return dialog.showPrompt(prompt.message, prompt.placeholder);
                },
                onProgress: (message) => {
                    dialog.showProgress(message);
                },
                onSelect: (prompt) => this.showOAuthLoginSelect(dialog, prompt),
                onManualCodeInput: () => manualCodePromise,
                signal: dialog.signal,
            });
            // Success
            restoreEditor();
            await this.completeProviderAuthentication(providerId, providerName, "oauth", previousModel);
        }
        catch (error) {
            restoreEditor();
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg !== "Login cancelled") {
                this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
            }
        }
    }
    // =========================================================================
    // Command handlers
    // =========================================================================
    async handleReloadCommand() {
        if (this.session.isStreaming) {
            this.showWarning("Wait for the current response to finish before reloading.");
            return;
        }
        if (this.session.isCompacting) {
            this.showWarning("Wait for compaction to finish before reloading.");
            return;
        }
        this.resetExtensionUI();
        const reloadBox = new Container();
        const borderColor = (s) => theme.fg("border", s);
        reloadBox.addChild(new DynamicBorder(borderColor));
        reloadBox.addChild(new Spacer(1));
        reloadBox.addChild(new Text(theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes, and context files..."), 1, 0));
        reloadBox.addChild(new Spacer(1));
        reloadBox.addChild(new DynamicBorder(borderColor));
        const previousEditor = this.editor;
        this.editorContainer.clear();
        this.editorContainer.addChild(reloadBox);
        this.ui.setFocus(reloadBox);
        this.ui.requestRender(true);
        await new Promise((resolve) => process.nextTick(resolve));
        const dismissReloadBox = (editor) => {
            this.editorContainer.clear();
            this.editorContainer.addChild(editor);
            this.ui.setFocus(editor);
            this.ui.requestRender();
        };
        let chatRestoredBeforeSessionStart = false;
        let reloadBoxDismissed = false;
        const restoreChatBeforeSessionStart = () => {
            if (chatRestoredBeforeSessionStart) {
                return;
            }
            this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
            this.outputPad = this.settingsManager.getOutputPad();
            this.rebuildChatFromMessages();
            chatRestoredBeforeSessionStart = true;
        };
        try {
            await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
            restoreChatBeforeSessionStart();
            configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
            this.keybindings.reload();
            const activeHeader = this.customHeader ?? this.builtInHeader;
            if (isExpandable(activeHeader)) {
                activeHeader.setExpanded(this.toolOutputExpanded);
            }
            setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
            await this.themeController.applyFromSettings();
            const editorPaddingX = this.settingsManager.getEditorPaddingX();
            const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
            this.defaultEditor.setPaddingX(editorPaddingX);
            this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
            if (this.editor !== this.defaultEditor) {
                this.editor.setPaddingX?.(editorPaddingX);
                this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
            }
            this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
            const clearOnShrink = this.settingsManager.getClearOnShrink();
            this.ui.setClearOnShrink(clearOnShrink);
            if (!clearOnShrink && !this.activeStatusIndicator) {
                this.statusContainer.clear();
            }
            this.setupAutocompleteProvider();
            const runner = this.session.extensionRunner;
            this.setupExtensionShortcuts(runner);
            this.showLoadedResources({
                force: false,
                showDiagnosticsWhenQuiet: true,
            });
            const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
            const modelsJsonError = this.session.modelRegistry.getError();
            if (modelsJsonError) {
                this.showError(`models.json error: ${modelsJsonError}`);
            }
            this.showStatus(savedImplicitProjectTrust
                ? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
                : "Reloaded keybindings, extensions, skills, prompts, themes, and context files");
            dismissReloadBox(this.editor);
            reloadBoxDismissed = true;
        }
        catch (error) {
            if (!reloadBoxDismissed) {
                dismissReloadBox(previousEditor);
            }
            this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // =========================================================================
    // /hotload — toggle auto-reload on extension file changes
    // =========================================================================
    async handleHotloadCommand() {
        this._hotloadEnabled = !this._hotloadEnabled;
        if (this._hotloadEnabled) {
            // 防抖：200ms 内多次改动只触发一次 reload
            setFileChangeCallback((filename) => {
                this._hotloadPendingFiles.add(filename);
                if (this._hotloadReloadTimer) clearTimeout(this._hotloadReloadTimer);
                this._hotloadReloadTimer = setTimeout(async () => {
                    this._hotloadReloadTimer = null;
                    if (this.session.isStreaming || this.session.isCompacting) {
                        this._hotloadPendingFiles.clear();
                        return;
                    }
                    const files = [...this._hotloadPendingFiles];
                    this._hotloadPendingFiles.clear();
                    this.showStatus(`Extension changed (${files.join(", ")}), auto-reloading...`);
                    await this.handleReloadCommand();
                }, 200);
            });
            this.showStatus("Hot-reload enabled: changes to extension .ts/.js files will auto-reload");
        } else {
            setFileChangeCallback(null);
            if (this._hotloadReloadTimer) { clearTimeout(this._hotloadReloadTimer); this._hotloadReloadTimer = null; }
            this.showStatus("Hot-reload disabled");
        }
    }
    async handleExportCommand(text) {
        const outputPath = this.getPathCommandArgument(text, "/export");
        try {
            if (outputPath?.endsWith(".jsonl")) {
                const filePath = this.session.exportToJsonl(outputPath);
                this.showStatus(`Session exported to: ${filePath}`);
            }
            else {
                const filePath = await this.session.exportToHtml(outputPath);
                this.showStatus(`Session exported to: ${filePath}`);
            }
        }
        catch (error) {
            this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }
    getPathCommandArgument(text, command) {
        if (text === command) {
            return undefined;
        }
        if (!text.startsWith(`${command} `)) {
            return undefined;
        }
        const argsString = text.slice(command.length + 1).trimStart();
        if (!argsString) {
            return undefined;
        }
        const firstChar = argsString[0];
        if (firstChar === '"' || firstChar === "'") {
            const closingQuoteIndex = argsString.indexOf(firstChar, 1);
            if (closingQuoteIndex < 0) {
                return undefined;
            }
            return argsString.slice(1, closingQuoteIndex);
        }
        const firstWhitespaceIndex = argsString.search(/\s/);
        if (firstWhitespaceIndex < 0) {
            return argsString;
        }
        return argsString.slice(0, firstWhitespaceIndex);
    }
    async handleImportCommand(text) {
        const inputPath = this.getPathCommandArgument(text, "/import");
        if (!inputPath) {
            this.showError("Usage: /import <path.jsonl>");
            return;
        }
        const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
        if (!confirmed) {
            this.showStatus("Import cancelled");
            return;
        }
        try {
            this.clearStatusIndicator();
            const result = await this.runtimeHost.importFromJsonl(inputPath);
            if (result.cancelled) {
                this.showStatus("Import cancelled");
                return;
            }
            this.showStatus(`Session imported from: ${inputPath}`);
        }
        catch (error) {
            if (error instanceof MissingSessionCwdError) {
                const selectedCwd = await this.promptForMissingSessionCwd(error);
                if (!selectedCwd) {
                    this.showStatus("Import cancelled");
                    return;
                }
                const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
                if (result.cancelled) {
                    this.showStatus("Import cancelled");
                    return;
                }
                this.showStatus(`Session imported from: ${inputPath}`);
                return;
            }
            if (error instanceof SessionImportFileNotFoundError) {
                this.showError(`Failed to import session: ${error.message}`);
                return;
            }
            await this.handleFatalRuntimeError("Failed to import session", error);
        }
    }
    async handleShareCommand() {
        // Check if gh is available and logged in
        try {
            const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
            if (authResult.status !== 0) {
                this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
                return;
            }
        }
        catch {
            this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
            return;
        }
        // Export to a temp file
        const tmpFile = path.join(os.tmpdir(), "session.html");
        try {
            await this.session.exportToHtml(tmpFile);
        }
        catch (error) {
            this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
            return;
        }
        // Show cancellable loader, replacing the editor
        const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
        this.editorContainer.clear();
        this.editorContainer.addChild(loader);
        this.ui.setFocus(loader);
        this.ui.requestRender();
        const restoreEditor = () => {
            loader.dispose();
            this.editorContainer.clear();
            this.editorContainer.addChild(this.editor);
            this.ui.setFocus(this.editor);
            try {
                fs.unlinkSync(tmpFile);
            }
            catch {
                // Ignore cleanup errors
            }
        };
        // Create a secret gist asynchronously
        let proc = null;
        loader.onAbort = () => {
            proc?.kill();
            restoreEditor();
            this.showStatus("Share cancelled");
        };
        try {
            const result = await new Promise((resolve) => {
                proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
                let stdout = "";
                let stderr = "";
                proc.stdout?.on("data", (data) => {
                    stdout += data.toString();
                });
                proc.stderr?.on("data", (data) => {
                    stderr += data.toString();
                });
                proc.on("close", (code) => resolve({ stdout, stderr, code }));
            });
            if (loader.signal.aborted)
                return;
            restoreEditor();
            if (result.code !== 0) {
                const errorMsg = result.stderr?.trim() || "Unknown error";
                this.showError(`Failed to create gist: ${errorMsg}`);
                return;
            }
            // Extract gist ID from the URL returned by gh
            // gh returns something like: https://gist.github.com/username/GIST_ID
            const gistUrl = result.stdout?.trim();
            const gistId = gistUrl?.split("/").pop();
            if (!gistId) {
                this.showError("Failed to parse gist ID from gh output");
                return;
            }
            // Create the preview URL
            const previewUrl = getShareViewerUrl(gistId);
            this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
        }
        catch (error) {
            if (!loader.signal.aborted) {
                restoreEditor();
                this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        }
    }
    async handleCopyCommand() {
        const text = this.session.getLastAssistantText();
        if (!text) {
            this.showError("No agent messages to copy yet.");
            return;
        }
        try {
            await copyToClipboard(text);
            const chars = text.length;
            const lines = text.split("\n").length;
            this.showStatus(`copied ${chars} chars, ${lines} lines`);
        }
        catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
        }
    }
    handleNameCommand(text) {
        const name = text.replace(/^\/name\s*/, "").trim();
        if (!name) {
            const currentName = this.sessionManager.getSessionName();
            if (currentName) {
                this.chatContainer.addChild(new Spacer(1));
                this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
            }
            else {
                this.showWarning("Usage: /name <name>");
            }
            this.ui.requestRender();
            return;
        }
        this.session.setSessionName(name);
        const sessionName = this.sessionManager.getSessionName();
        if (sessionName !== name) {
            this.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
        }
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${sessionName ?? name}`), 1, 0));
        this.ui.requestRender();
    }
    handleSessionCommand() {
        const stats = this.session.getSessionStats();
        const sessionName = this.sessionManager.getSessionName();
        const entries = this.sessionManager.getEntries();
        const cacheWaste = computeCacheWaste(entries, this.session.modelRegistry);
        // Cost/token totals per provider/model actually used (e.g. OpenRouter `auto`
        // resolves to a concrete responseModel), sorted by cost descending.
        const perModelMap = new Map();
        for (const entry of entries) {
            if (entry.type !== "message" || entry.message.role !== "assistant")
                continue;
            const message = entry.message;
            const usage = message.usage;
            const key = `${message.provider}/${message.responseModel ?? message.model}`;
            let bucket = perModelMap.get(key);
            if (!bucket) {
                bucket = { key, cost: 0, tokens: 0 };
                perModelMap.set(key, bucket);
            }
            bucket.cost += usage.cost.total;
            bucket.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        }
        const perModel = Array.from(perModelMap.values()).sort((a, b) => b.cost - a.cost);
        let info = `${theme.bold("Session Info")}\n\n`;
        if (sessionName) {
            info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
        }
        info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
        info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
        info += `${theme.bold("Messages")}\n`;
        info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n`;
        info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
        info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
        info += `${theme.fg("dim", "Tools:")} ${stats.toolCalls} calls, ${stats.toolResults} results\n\n`;
        info += `${theme.bold("Tokens")}\n`;
        // "Input" is the full prompt volume. With cache activity, split it into
        // cached (served from cache) vs uncached (everything else) - the only
        // provider-independent split. Cache writes, where reported, are a detail
        // of the uncached portion.
        const { input, cacheRead, cacheWrite } = stats.tokens;
        const promptTokens = input + cacheRead + cacheWrite;
        info += `${theme.fg("dim", "Input:")} ${promptTokens.toLocaleString()}\n`;
        if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
            const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
            info += `  ${theme.fg("dim", "Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
            const written = cacheWrite > 0 ? ` ${theme.fg("dim", `(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
            info += `  ${theme.fg("dim", "Uncached:")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
        }
        info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
        info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;
        if (stats.cost > 0 || cacheWaste.missedTokens > 0) {
            info += `\n${theme.bold("Cost")}\n`;
            info += `${theme.fg("dim", "Total:")} $${stats.cost.toFixed(3)}`;
            if (perModel.length > 1) {
                for (const entry of perModel) {
                    info += `\n  ${theme.fg("dim", `${entry.key}:`)} $${entry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(entry.tokens)} tokens)`)}`;
                }
            }
            if (cacheWaste.missedTokens > 0) {
                const missLabel = cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
                const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
                info +=
                    cacheWaste.missedCost >= 0.0001
                        ? `\n${theme.fg("dim", "Cache Re-billed:")} $${cacheWaste.missedCost.toFixed(3)} ${theme.fg("dim", `(${detail})`)}`
                        : `\n${theme.fg("dim", "Cache Re-billed:")} ${detail}`;
            }
        }
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Text(info, 1, 0));
        this.ui.requestRender();
    }
    handleChangelogCommand() {
        const changelogPath = getChangelogPath();
        const allEntries = parseChangelog(changelogPath);
        const changelogMarkdown = allEntries.length > 0
            ? allEntries
                .reverse()
                .map((e) => normalizeChangelogLinks(e.content, e))
                .join("\n\n")
            : "No changelog entries found.";
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new DynamicBorder());
        this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
        this.chatContainer.addChild(new DynamicBorder());
        this.ui.requestRender();
    }
    /**
     * Get capitalized display string for an app keybinding action.
     */
    getAppKeyDisplay(action) {
        return keyDisplayText(action);
    }
    /**
     * Get capitalized display string for an editor keybinding action.
     */
    getEditorKeyDisplay(action) {
        return keyDisplayText(action);
    }
    handleHotkeysCommand() {
        // Navigation keybindings
        const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
        const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
        const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
        const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
        const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
        const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
        const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
        const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
        const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
        const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
        const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
        const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");
        // Editing keybindings
        const submit = this.getEditorKeyDisplay("tui.input.submit");
        const newLine = this.getEditorKeyDisplay("tui.input.newLine");
        const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
        const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
        const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
        const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
        const yank = this.getEditorKeyDisplay("tui.editor.yank");
        const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
        const undo = this.getEditorKeyDisplay("tui.editor.undo");
        const tab = this.getEditorKeyDisplay("tui.input.tab");
        // App keybindings
        const interrupt = this.getAppKeyDisplay("app.interrupt");
        const clear = this.getAppKeyDisplay("app.clear");
        const exit = this.getAppKeyDisplay("app.exit");
        const suspend = this.getAppKeyDisplay("app.suspend");
        // [deprecated] const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
        const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
        const selectModel = this.getAppKeyDisplay("app.model.select");
        const expandTools = this.getAppKeyDisplay("app.tools.expand");
        const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
        const externalEditor = this.getAppKeyDisplay("app.editor.external");
        const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
        const copyMessage = this.getAppKeyDisplay("app.message.copy");
        const followUp = this.getAppKeyDisplay("app.message.followUp");
        const dequeue = this.getAppKeyDisplay("app.message.dequeue");
        const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");
        let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| ~~\`thinking.cycle\`~~ | ~~Cycle thinking level~~ *(deprecated: 上游无效)* |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${copyMessage}\` | Copy last assistant message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image or text from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;
        // Add extension-registered shortcuts
        const extensionRunner = this.session.extensionRunner;
        const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
        if (shortcuts.size > 0) {
            hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
            for (const [key, shortcut] of shortcuts) {
                const description = shortcut.description ?? shortcut.extensionPath;
                const keyDisplay = formatKeyText(key, { capitalize: true });
                hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
            }
        }
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new DynamicBorder());
        this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
        this.chatContainer.addChild(new DynamicBorder());
        this.ui.requestRender();
    }
    async handleClearCommand() {
        this.clearStatusIndicator();
        try {
            const result = await this.runtimeHost.newSession();
            if (result.cancelled) {
                return;
            }
            this.chatContainer.addChild(new Spacer(1));
            this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
            this.ui.requestRender();
        }
        catch (error) {
            await this.handleFatalRuntimeError("Failed to create session", error);
        }
    }
    handleDebugCommand() {
        const width = this.ui.terminal.columns;
        const height = this.ui.terminal.rows;
        const allLines = this.ui.render(width);
        const debugLogPath = getDebugLogPath();
        const debugData = [
            `Debug output at ${new Date().toISOString()}`,
            `Terminal: ${width}x${height}`,
            `Total lines: ${allLines.length}`,
            "",
            "=== All rendered lines with visible widths ===",
            ...allLines.map((line, idx) => {
                const vw = visibleWidth(line);
                const escaped = JSON.stringify(line);
                return `[${idx}] (w=${vw}) ${escaped}`;
            }),
            "",
            "=== Agent messages (JSONL) ===",
            ...this.session.messages.map((msg) => JSON.stringify(msg)),
            "",
        ].join("\n");
        fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
        fs.writeFileSync(debugLogPath, debugData);
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1));
        this.ui.requestRender();
    }
    handleArminSaysHi() {
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new ArminComponent(this.ui));
        this.ui.requestRender();
    }
    handleDementedDelves() {
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new EarendilAnnouncementComponent());
        this.ui.requestRender();
    }
    handleDaxnuts() {
        this.chatContainer.addChild(new Spacer(1));
        this.chatContainer.addChild(new DaxnutsComponent(this.ui));
        this.ui.requestRender();
    }
    checkDaxnutsEasterEgg(model) {
        if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
            this.handleDaxnuts();
        }
    }
    async handleBashCommand(command, excludeFromContext = false) {
        const extensionRunner = this.session.extensionRunner;
        // Emit user_bash event to let extensions intercept
        const eventResult = await extensionRunner.emitUserBash({
            type: "user_bash",
            command,
            excludeFromContext,
            cwd: this.sessionManager.getCwd(),
        });
        // If extension returned a full result, use it directly
        if (eventResult?.result) {
            const result = eventResult.result;
            // Create UI component for display
            this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
            if (this.session.isStreaming) {
                this.pendingMessagesContainer.addChild(this.bashComponent);
                this.pendingBashComponents.push(this.bashComponent);
            }
            else {
                this.chatContainer.addChild(this.bashComponent);
            }
            // Show output and complete
            if (result.output) {
                this.bashComponent.appendOutput(result.output);
            }
            this.bashComponent.setComplete(result.exitCode, result.cancelled, result.truncated ? { truncated: true, content: result.output } : undefined, result.fullOutputPath);
            // Record the result in session
            this.session.recordBashResult(command, result, { excludeFromContext });
            this.bashComponent = undefined;
            this.ui.requestRender();
            return;
        }
        // Normal execution path (possibly with custom operations)
        const isDeferred = this.session.isStreaming;
        this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
        if (isDeferred) {
            // Show in pending area when agent is streaming
            this.pendingMessagesContainer.addChild(this.bashComponent);
            this.pendingBashComponents.push(this.bashComponent);
        }
        else {
            // Show in chat immediately when agent is idle
            this.chatContainer.addChild(this.bashComponent);
        }
        this.ui.requestRender();
        try {
            const result = await this.session.executeBash(command, (chunk) => {
                if (this.bashComponent) {
                    this.bashComponent.appendOutput(chunk);
                    this.ui.requestRender();
                }
            }, { excludeFromContext, operations: eventResult?.operations });
            if (this.bashComponent) {
                this.bashComponent.setComplete(result.exitCode, result.cancelled, result.truncated ? { truncated: true, content: result.output } : undefined, result.fullOutputPath);
            }
        }
        catch (error) {
            if (this.bashComponent) {
                this.bashComponent.setComplete(undefined, false);
            }
            this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
        this.bashComponent = undefined;
        this.ui.requestRender();
    }
    async handleCompactCommand(customInstructions) {
        this.clearStatusIndicator();
        try {
            await this.session.compact(customInstructions);
        }
        catch {
            // Ignore, will be emitted as an event
        }
    }
    stop() {
        if (this.settingsManager.getShowTerminalProgress()) {
            this.ui.terminal.setProgress(false);
        }
        this.clearStatusIndicator();
        this.themeController.disableAutoSync();
        this.clearExtensionTerminalInputListeners();
        this.footer.dispose();
        this.footerDataProvider.dispose();
        if (this.unsubscribe) {
            this.unsubscribe();
        }
        if (this.isInitialized) {
            this.ui.stop();
            this.isInitialized = false;
        }
        this.unregisterSignalHandlers();
    }
}
//# sourceMappingURL=interactive-mode.js.map