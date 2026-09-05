import { modelsAreEqual } from "@earendil-works/pi-ai";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, } from "@earendil-works/pi-tui";
import { getModelSelectorSearchText } from "../model-search.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";
// 2026-09-04：models.dev 目录自动维护（loadModelsDevExtras）需要 node 模块
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const MAX_VISIBLE = 10; // 2026-09-05（用户）：边缘滚动——可视行数（从 updateList 局部常量提出，handleInput 也要用）
/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container {
    searchInput;
    // Focusable implementation - propagate to searchInput for IME cursor positioning
    _focused = false;
    get focused() {
        return this._focused;
    }
    set focused(value) {
        this._focused = value;
        this.searchInput.focused = value;
    }
    listContainer;
    allModels = [];
    scopedModelItems = [];
    activeModels = [];
    filteredModels = [];
    selectedIndex = 0;
    currentModel;
    settingsManager;
    modelRegistry;
    onSelectCallback;
    onCancelCallback;
    errorMessage;
    tui;
    scopedModels;
    scope = "all";
    scopeText;
    scopeHintText;
    constructor(tui, currentModel, settingsManager, modelRegistry, scopedModels, onSelect, onCancel, initialSearchInput) {
        super();
        this.tui = tui;
        this.currentModel = currentModel;
        this.settingsManager = settingsManager;
        this.modelRegistry = modelRegistry;
        this.scopedModels = scopedModels;
        this.scope = scopedModels.length > 0 ? "scoped" : "all";
        this.onSelectCallback = onSelect;
        this.onCancelCallback = onCancel;
        // Add top border
        this.addChild(new DynamicBorder());
        this.addChild(new Spacer(1));
        // Add hint about model filtering
        if (scopedModels.length > 0) {
            this.scopeText = new Text(this.getScopeText(), 0, 0);
            this.addChild(this.scopeText);
            this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
            this.addChild(this.scopeHintText);
        }
        else {
            const hintText = "Only showing models from configured providers. Use /c to configure API keys.";
            this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
        }
        this.addChild(new Spacer(1));
        // Create search input
        this.searchInput = new Input();
        if (initialSearchInput) {
            this.searchInput.setValue(initialSearchInput);
        }
        this.searchInput.onSubmit = () => {
            // Enter on search input selects the first filtered item
            if (this.filteredModels[this.selectedIndex]) {
                this.handleSelect(this.filteredModels[this.selectedIndex].model);
            }
        };
        this.addChild(this.searchInput);
        this.addChild(new Spacer(1));
        // Create list container
        this.listContainer = new Container();
        this.addChild(this.listContainer);
        this.addChild(new Spacer(1));
        // Add bottom border
        this.addChild(new DynamicBorder());
        // Load models and do initial render
        this.loadModels().then(() => {
            if (initialSearchInput) {
                this.filterModels(initialSearchInput);
            }
            else {
                this.updateList();
            }
            // Request re-render after models are loaded
            this.tui.requestRender();
        });
    }
    // 2026-09-04（用户定稿）：models.dev 目录自动维护——拉取 https://models.dev/api.json（缓存 24h），
    // 返回内置目录缺失的 openrouter 模型（合成 teyvat Model 格式：api/baseUrl 继承内置 openrouter provider，
    // cost 从 models.dev 换算已是每百万美元、limit.context→contextWindow、limit.output→maxTokens、reasoning）。
    // 架构通用：MODELSDEV_PROVIDERS 映射表加 provider id 即启用其他 provider（deepseek→deepseek、bigmodel→zhipuai）。
    // 离线/超时/解析失败 → 返回 []（用内置目录，永不卡 /m）。
    MODELSDEV_PROVIDERS = { openrouter: "openrouter" }; // 2026-09-04 先行 openrouter；deepseek:"deepseek"、bigmodel:"zhipuai" 待启用
    MODELSDEV_URL = "https://models.dev/api.json";
    MODELSDEV_TTL_MS = 24 * 60 * 60 * 1000;
    // 2026-09-04：models.dev 目录合并——**只读缓存**（零网络，不卡 /m；缓存由启动时的后台预同步维护，见模块级 syncModelsDevCache）
    // 离线/缓存不存在 → 返回 []（用内置目录）。
    MODELSDEV_PROVIDERS = { openrouter: "openrouter" }; // 2026-09-04 先行 openrouter；deepseek:"deepseek"、bigmodel:"zhipuai" 待启用
    MODELSDEV_URL = "https://models.dev/api.json";
    MODELSDEV_TTL_MS = 24 * 60 * 60 * 1000;
    MODELSDEV_CACHE_FILE = () => join(homedir(), ".teyvat", "RuntimeCache", process.env.PAIMON_AGENT_ID || "unknown", "modelsdev-catalog.json");
    readModelsDevCache() {
        try {
            const f = this.MODELSDEV_CACHE_FILE();
            if (!existsSync(f)) return null;
            return JSON.parse(readFileSync(f, "utf8"));
        } catch { return null; }
    }
    async loadModelsDevExtras(availableModels) {
        const catalog = this.readModelsDevCache();
        if (!catalog) return [];
        const extras = [];
        const seen = new Set(availableModels.map((m) => `${m.provider}::${m.id}`));
        for (const [prov, mdKey] of Object.entries(this.MODELSDEV_PROVIDERS)) {
            const mdProv = catalog[mdKey];
            if (!mdProv?.models) continue;
            for (const mdModel of Object.values(mdProv.models)) {
                const fullId = mdKey === prov ? mdModel.id : `${mdKey}/${mdModel.id}`; // models.dev 的 id 可能含子前缀
                const key = `${prov}::${fullId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                extras.push({
                    id: fullId,
                    name: mdModel.name || fullId,
                    api: "openai-completions",
                    provider: prov,
                    baseUrl: "https://openrouter.ai/api/v1",
                    // 2026-09-05：必须有 input（缺省 → transform-messages.js 的 model.input.includes 炸——inkling 事件）
                    // models.dev 的 modalities.input 映射（如 ["text","image"]）；缺省 text（LLM 兜底）
                    input: (mdModel.modalities?.input && mdModel.modalities.input.length) ? mdModel.modalities.input : ["text"],
                    reasoning: !!mdModel.reasoning,
                    contextWindow: mdModel.limit?.context || 200000,
                    maxTokens: mdModel.limit?.output || 64000,
                    cost: { input: mdModel.cost?.input || 0, output: mdModel.cost?.output || 0, cacheRead: mdModel.cost?.cache_read || 0, cacheWrite: mdModel.cost?.cache_write || 0 },
                });
            }
        }
        return extras;
    }
    async loadModels() {
        let models;
        // Refresh to pick up any changes to models.json
        this.modelRegistry.refresh();
        // Check for models.json errors
        const loadError = this.modelRegistry.getError();
        if (loadError) {
            this.errorMessage = loadError;
        }
        // Load available models (built-in models still work even if models.json failed)
        try {
            let availableModels = await this.modelRegistry.getAvailable();
            // 2026-09-04（用户定稿）：models.dev 目录自动维护——拉 models.dev api.json（缓存 24h），
            // 对 openrouter 先行（deepseek/zai/bigmodel→zhipuai 架构已通用，加映射即启用），
            // diff 内置缺失的模型合成条目合并进列表（元数据从 models.dev 换算），新模型即时出现在 /m。
            try {
                availableModels = [...availableModels, ...await this.loadModelsDevExtras(availableModels)];
            } catch (e) { console.error("[teyvat model-selector] models.dev 合并失败（用内置目录）: " + (e?.message ?? e)); }
            models = availableModels.map((model) => ({
                provider: model.provider,
                id: model.id,
                model,
            }));
        }
        catch (error) {
            this.allModels = [];
            this.scopedModelItems = [];
            this.activeModels = [];
            this.filteredModels = [];
            this.errorMessage = error instanceof Error ? error.message : String(error);
            return;
        }
        this.allModels = this.sortModels(models);
        this.scopedModels = this.scopedModels.map((scoped) => {
            const refreshed = this.modelRegistry.find(scoped.model.provider, scoped.model.id);
            return refreshed ? { ...scoped, model: refreshed } : scoped;
        });
        this.scopedModelItems = this.scopedModels.map((scoped) => ({
            provider: scoped.model.provider,
            id: scoped.model.id,
            model: scoped.model,
        }));
        this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
        this.filteredModels = this.activeModels;
        const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
        this.selectedIndex =
            currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
        // 2026-09-05 边缘滚动：初始让选中项在可视区顶部（不是居中），旧 startIndex=0 导致选中项在可视区外时箭头不可见
        this.startIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - MAX_VISIBLE)));
    }
    sortModels(models) {
        const sorted = [...models];
        // 2026-09-04 teyvat 定稿（用户设计）：featured（精选）置顶用 ✓ 标记，当前选择的模型用颜色标记（不置顶），
        // 其余按 provider 字典序。精选清单由 interactive-mode.js 注入 globalThis.__genshinFeaturedModels。
        const featured = (globalThis.__genshinFeaturedModels) || [];
        const featRank = (item) => {
            const i = featured.findIndex((f) => f.provider === item.provider && f.id === item.id);
            return i >= 0 ? i : featured.length; // 非 featured 排 featured 之后
        };
        sorted.sort((a, b) => {
            const fa = featRank(a);
            const fb = featRank(b);
            if (fa !== fb) return fa - fb;
            return a.provider.localeCompare(b.provider);
        });
        return sorted;
    }
    getScopeText() {
        const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
        const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
        return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
    }
    getScopeHintText() {
        return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
    }
    setScope(scope) {
        if (this.scope === scope)
            return;
        this.scope = scope;
        this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
        const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
        this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
        // 2026-09-05 边缘滚动：切 scope 让选中项在可视区顶部
        this.startIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.activeModels.length - MAX_VISIBLE)));
        this.filterModels(this.searchInput.getValue());
        if (this.scopeText) {
            this.scopeText.setText(this.getScopeText());
        }
    }
    filterModels(query) {
        this.filteredModels = query
            ? fuzzyFilter(this.activeModels, query, ({ id, provider, model }) => getModelSelectorSearchText({ id, provider, name: model.name }))
            : this.activeModels;
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
        // 2026-09-05 边缘滚动：过滤后让选中项在可视区顶部（避免选中项在可视区外箭头不可见）
        this.startIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - MAX_VISIBLE)));
        this.updateList();
    }
    updateList() {
        this.listContainer.clear();
        const maxVisible = MAX_VISIBLE;
        // 2026-09-05（用户）：边缘滚动——startIndex 为实例状态，箭头先走到可视区边缘、列表才滚动。
        // 旧实现从 selectedIndex 居中重算（startIndex = selectedIndex - maxVisible/2），每次按键列表都跟滚，
        // 箭头永远在中间——用户期望"先移动箭头到边缘再移动列表"。
        if (typeof this.startIndex !== "number") this.startIndex = 0;
        this.startIndex = Math.max(0, Math.min(this.startIndex, Math.max(0, this.filteredModels.length - maxVisible)));
        const startIndex = this.startIndex;
        const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);
        // Show visible slice of filtered models
        // 2026-09-04 用户定稿：两栏渲染——provider 对齐栏 + model 栏（去 provider 前缀，不重复）。
        // ★ = featured 推荐（置顶，result 鲸鱼蓝）；✓ = 正在使用的模型（行尾，success 绿）；当前模型 id 用 result 鲸鱼蓝。
        const providerMax = Math.max(8, ...this.filteredModels.map((it) => it.provider.length));
        for (let i = startIndex; i < endIndex; i++) {
            const item = this.filteredModels[i];
            if (!item)
                continue;
            const featured = (globalThis.__genshinFeaturedModels) || [];
            const isFeatured = featured.some((f) => f.provider === item.provider && f.id === item.id);
            const isSelected = i === this.selectedIndex;
            const isCurrent = modelsAreEqual(this.currentModel, item.model);
            const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
            const star = isFeatured ? theme.fg("result", "★ ") : "  ";
            const providerCol = theme.fg("muted", item.provider.padEnd(providerMax + 2));
            // model 栏：去 provider 前缀（openrouter 风格 id 如 anthropic/claude-xxx → claude-xxx；无斜杠的内置 id 原样）
            const bareId = item.id.includes("/") ? item.id.slice(item.id.indexOf("/") + 1) : item.id;
            const modelText = isCurrent ? theme.fg("result", bareId) : bareId;
            const check = isCurrent ? theme.fg("success", " ✓") : "";
            this.listContainer.addChild(new Text(`${prefix}${star}${providerCol}${modelText}${check}`, 0, 0));
        }
        // Add scroll indicator if needed
        if (startIndex > 0 || endIndex < this.filteredModels.length) {
            const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
            this.listContainer.addChild(new Text(scrollInfo, 0, 0));
        }
        // Show error message or "no results" if empty
        if (this.errorMessage) {
            // Show error in red
            const errorLines = this.errorMessage.split("\n");
            for (const line of errorLines) {
                this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
            }
        }
        else if (this.filteredModels.length === 0) {
            this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
        }
        else {
            const selected = this.filteredModels[this.selectedIndex];
            this.listContainer.addChild(new Spacer(1));
            this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
        }
    }
    handleInput(keyData) {
        const kb = getKeybindings();
        if (kb.matches(keyData, "tui.input.tab")) {
            if (this.scopedModelItems.length > 0) {
                const nextScope = this.scope === "all" ? "scoped" : "all";
                this.setScope(nextScope);
                if (this.scopeHintText) {
                    this.scopeHintText.setText(this.getScopeHintText());
                }
            }
            return;
        }
        // Up arrow - 2026-09-05（用户）：边缘滚动——箭头先走到可视区顶部，列表才上滚；最顶再按 wrap 到底部
        if (kb.matches(keyData, "tui.select.up")) {
            if (this.filteredModels.length === 0)
                return;
            if (this.selectedIndex === 0) {
                // wrap：跳到底部（startIndex 也跳到底部窗口，避免箭头落在可视区外）
                this.selectedIndex = this.filteredModels.length - 1;
                this.startIndex = Math.max(0, this.filteredModels.length - MAX_VISIBLE);
            } else {
                this.selectedIndex--;
                if (this.selectedIndex < this.startIndex) this.startIndex--; // 箭头越过可视区上边缘 → 列表上滚一行（箭头停在上边缘）
            }
            this.updateList();
        }
        // Down arrow - 边缘滚动：箭头先走到可视区底部，列表才下滚；最底再按 wrap 到顶部
        else if (kb.matches(keyData, "tui.select.down")) {
            if (this.filteredModels.length === 0)
                return;
            if (this.selectedIndex === this.filteredModels.length - 1) {
                // wrap：跳到顶部
                this.selectedIndex = 0;
                this.startIndex = 0;
            } else {
                this.selectedIndex++;
                if (this.selectedIndex >= this.startIndex + MAX_VISIBLE) this.startIndex++; // 箭头越过可视区下边缘 → 列表下滚一行（箭头停在下边缘）
            }
            this.updateList();
        }
        // Enter
        else if (kb.matches(keyData, "tui.select.confirm")) {
            const selectedModel = this.filteredModels[this.selectedIndex];
            if (selectedModel) {
                this.handleSelect(selectedModel.model);
            }
        }
        // Escape or Ctrl+C
        else if (kb.matches(keyData, "tui.select.cancel")) {
            this.onCancelCallback();
        }
        // Pass everything else to search input
        else {
            this.searchInput.handleInput(keyData);
            this.filterModels(this.searchInput.getValue());
        }
    }
    handleSelect(model) {
        // Save as new default
        this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
        this.onSelectCallback(model);
    }
    getSearchInput() {
        return this.searchInput;
    }
}
//# sourceMappingURL=model-selector.js.map