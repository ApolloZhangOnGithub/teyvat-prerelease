import { modelsAreEqual } from "@earendil-works/pi-ai";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, } from "@earendil-works/pi-tui";
import { getModelSelectorSearchText } from "../model-search.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";
// 2026-09-04：models.dev 目录自动维护（loadModelsDevExtras）需要 node 模块
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
    // 架构通用：MODELSDEV_PROVIDERS 映射表加 provider id 即启用其他 provider。
    // 离线/超时/解析失败 → 返回 []（用内置目录，永不卡 /m）。
    // 2026-09-13（用户：bigmodel 下也不全）：启用 bigmodel→zhipuai、deepseek→deepseek（models.dev 的 provider 键）。
    MODELSDEV_PROVIDERS = { bigmodel: "zhipuai", deepseek: "deepseek", xiaomi: "xiaomi" };
    MODELSDEV_URL = "https://models.dev/api.json";
    MODELSDEV_TTL_MS = 24 * 60 * 60 * 1000;
    // 2026-09-04：models.dev 目录合并——**只读缓存**（零网络，不卡 /m；缓存由启动时的后台预同步维护，见模块级 syncModelsDevCache）
    // 离线/缓存不存在 → 返回 []（用内置目录）。
    MODELSDEV_PROVIDERS = { bigmodel: "zhipuai", deepseek: "deepseek", xiaomi: "xiaomi" }; // 2026-09-24 去 openrouter（375 个不用）+ 加 xiaomi（mimo-v2.6）
    // 2026-09-15（用户定位）：无内置同名 provider 的（如 bigmodel）——合成条目的 baseUrl/api 从官方端点表取，
    // 否则 fallback 到 openrouter 打错地址。新 provider 启用时在此补端点。
    MODELSDEV_ENDPOINTS = { bigmodel: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions" }, xiaomi: { baseUrl: "https://api.xiaomimimo.com/v1", api: "openai-completions" } };
    MODELSDEV_URL = "https://models.dev/api.json";
    MODELSDEV_TTL_MS = 24 * 60 * 60 * 1000;
    MODELSDEV_CACHE_FILE = () => join(homedir(), ".teyvat", "RuntimeCache", process.env.PAIMON_AGENT_ID || "unknown", "modelsdev-catalog.json");
    // 2026-09-13：OpenRouter 官方现存清单（下架过滤的权威依据）
    OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
    OPENROUTER_ALIVE_FILE = () => join(homedir(), ".teyvat", "RuntimeCache", process.env.PAIMON_AGENT_ID || "unknown", "openrouter-alive.json");
    readOpenRouterAlive() {
        try {
            const f = this.OPENROUTER_ALIVE_FILE();
            if (!existsSync(f)) return null;
            const j = JSON.parse(readFileSync(f, "utf8"));
            return Array.isArray(j?.ids) && j.ids.length > 100 ? new Set(j.ids) : null;
        } catch { return null; }
    }
    readModelsDevCache() {
        try {
            const f = this.MODELSDEV_CACHE_FILE();
            if (!existsSync(f)) return null;
            return JSON.parse(readFileSync(f, "utf8"));
        } catch { return null; }
    }
    // 2026-09-13（dev-01）：补上**从未实现的写入端**。
    // 背景：models.dev 缓存的读取端（readModelsDevCache）与合并逻辑（loadModelsDevExtras）2026-09-04 就落好了，
    // 但没人往缓存文件里写（注释提到的模块级 syncModelsDevCache 根本不存在）→ 缓存永远不存在 → 合并/元数据全废，
    // 实际表现：/m 里 openrouter 只有 pi 内置的旧目录（7/30），新模型（如 z-ai/glm-5.3）永远进不来。
    // 逻辑：构建列表时若缓存缺失/过期（TTL 24h）→ 后台拉取写入（fire-and-forget，不阻塞本次 /m，下次生效）。
    syncModelsDevCache() {
        try {
            const f = this.MODELSDEV_CACHE_FILE();
            let fresh = false;
            try { fresh = Date.now() - statSync(f).mtimeMs < this.MODELSDEV_TTL_MS; } catch { /* 无缓存 → 需要拉取 */ }
            if (fresh) return;
            void (async () => {
                try {
                    const res = await fetch(this.MODELSDEV_URL, { signal: AbortSignal.timeout(30000) });
                    if (!res || !res.ok) return;
                    const text = await res.text();
                    if (!text || text.length < 1000 || !text.trimStart().startsWith("{")) return;
                    mkdirSync(dirname(f), { recursive: true });
                    writeFileSync(f + ".tmp", text);
                    renameSync(f + ".tmp", f); // 原子替换，避免读到半写文件
                    // 2026-09-13：顺带拉 **OpenRouter 官方现存清单**（下架过滤的权威依据——
                    // models.dev 是聚合目录、不及时清理已下架模型，拿它当“现存”依据会一个都过滤不掉）。
                    try {
                        const f2 = this.OPENROUTER_ALIVE_FILE();
                        let fresh2 = false;
                        try { fresh2 = Date.now() - statSync(f2).mtimeMs < this.MODELSDEV_TTL_MS; } catch { /* 无缓存 */ }
                        if (!fresh2) {
                            const r2 = await fetch(this.OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30000) });
                            if (r2 && r2.ok) {
                                const j2 = await r2.json();
                                const ids = Array.isArray(j2?.data) ? j2.data.map((m) => m.id).filter(Boolean) : [];
                                if (ids.length > 100) {
                                    writeFileSync(f2 + ".tmp", JSON.stringify({ ts: Date.now(), ids }));
                                    renameSync(f2 + ".tmp", f2);
                                }
                            }
                        }
                    } catch (e) { console.error("[teyvat model-selector] OpenRouter 现存清单同步失败: " + (e?.message ?? e)); }
                } catch (e) { console.error("[teyvat model-selector] models.dev 缓存同步失败: " + (e?.message ?? e)); }
            })();
        } catch (e) { console.error("[teyvat model-selector] models.dev 同步触发失败: " + (e?.message ?? e)); }
    }
    async loadModelsDevExtras(availableModels) {
        this.syncModelsDevCache(); // 缓存缺失/过期 → 后台补（本次 /m 仍用现有缓存，下次生效）
        const catalog = this.readModelsDevCache();
        if (!catalog) return [];
        const extras = [];
        const seen = new Set(availableModels.map((m) => `${m.provider}::${m.id}`));
        // 2026-09-13：按 provider 收集内置模型——合成条目继承其 api/baseUrl（见下）
        const inherit = {};
        for (const m of availableModels) { if (m.provider && !inherit[m.provider]) inherit[m.provider] = m; }
        for (const [prov, mdKey] of Object.entries(this.MODELSDEV_PROVIDERS)) {
            const mdProv = catalog[mdKey];
            if (!mdProv?.models) continue;
            // 2026-09-13：该 provider 的 api/baseUrl 从**内置同名模型**继承。
            // （原实现把 baseUrl 硬编码成 openrouter——一旦启用 bigmodel/deepseek，请求会打到错误的端点）
            const base = inherit[prov] || this.MODELSDEV_ENDPOINTS?.[prov] || {};
            for (const mdModel of Object.values(mdProv.models)) {
                // 2026-09-24（用户）：deepseek-flash 是 models.dev 的重复 id（registry 里是 deepseek-v4-flash），排除避免两套 id 混淆；
                // xiaomi 只保留 mimo-v2.6 两个（过滤 tts 那些，用户只用 v2.6）。
                if (prov === "deepseek" && mdModel.id === "deepseek-flash") continue;
                if (prov === "xiaomi" && !/^mimo-v2\.6/.test(mdModel.id)) continue;
                const fullId = mdModel.id; // models.dev 的 id 自带子前缀（openrouter: z-ai/glm-5.3；zhipuai: glm-5.3）
                const key = `${prov}::${fullId}`;
                if (seen.has(key)) continue;
                seen.add(key);
                extras.push({
                    id: fullId,
                    name: mdModel.name || fullId,
                    api: base.api || "openai-completions",
                    provider: prov,
                    baseUrl: base.baseUrl || "https://openrouter.ai/api/v1",
                    input: (mdModel.modalities?.input && mdModel.modalities.input.length) ? mdModel.modalities.input : ["text"],
                    reasoning: !!mdModel.reasoning,
                    contextWindow: mdModel.limit?.context || 200000,
                    maxTokens: mdModel.limit?.output || 64000,
                    cost: { input: mdModel.cost?.input || 0, output: mdModel.cost?.output || 0, cacheRead: mdModel.cost?.cache_read || 0, cacheWrite: mdModel.cost?.cache_write || 0 },
                    openWeights: mdModel.open_weights,
                    family: mdModel.family || "",
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
            // 2026-09-13（用户：下架模型当然要过滤）：对**启用了 models.dev 目录的 provider**，
            // 把内置目录里那些 models.dev 已不存在的模型（= 官方已下架，选了会报错）从列表里去掉。
            // （未启用目录的 provider 不动——它们没有权威现存清单，贸然过滤会误删）
            try {
                const cat0 = this.readModelsDevCache();
                if (cat0) {
                    const alive = new Set();
                    for (const [prov, mdKey] of Object.entries(this.MODELSDEV_PROVIDERS)) {
                        const mdProv = cat0[mdKey];
                        if (!mdProv?.models) continue;
                        for (const mdModel of Object.values(mdProv.models)) alive.add(`${prov}::${mdModel.id}`);
                    }
                    if (alive.size > 0) {
                        // openrouter 用**官方清单**（models.dev 会滞后、清不掉下架模型）；其他启用的 provider 用 models.dev
                        const aliveOR = this.readOpenRouterAlive();
                        const kept = availableModels.filter((m) => {
                            if (m.provider === "openrouter") return aliveOR ? aliveOR.has(m.id) : true;
                            if (this.MODELSDEV_PROVIDERS[m.provider]) return alive.has(`${m.provider}::${m.id}`);
                            return true;
                        });
                        const dropped = availableModels.length - kept.length;
                        if (dropped > 0) console.error(`[teyvat model-selector] 过滤已下架模型 ${dropped} 个`);
                        availableModels = kept;
                    }
                }
            } catch (e) { console.error("[teyvat model-selector] 下架过滤失败（保留全部）: " + (e?.message ?? e)); }
            // 补元数据：openWeights / family / _vendor / _series
            // openWeights 数据源：open_weighted_lists.json（从 OpenRouter API 抓取维护的权威映射）> models.dev catalog > 未知
            let owMap = {};
            try {
                // model-selector.js 部署在 pi dist（runtime/），open_weighted_lists.json 在 extensions/teyvat/——用 PAIMON_EXT（launcher 导出）+ fallback
                const owCandidates = [
                    join(process.env.PAIMON_EXT || join(homedir(), ".local/lib/teyvat/extensions/teyvat"), "spirit.bio.gene/open_weighted_lists.json"),
                ];
                for (const p of owCandidates) { if (existsSync(p)) { owMap = JSON.parse(readFileSync(p, "utf8")); break; } }
            } catch { /* open_weighted_lists.json 缺失 → 全部未知 */ }
            const catalog = this.readModelsDevCache();
            for (const model of availableModels) {
                // vendor 提取（openrouter ID 格式 vendor/model-name；非 openrouter 取 provider）
                const vendor = model.id.includes("/") ? model.id.split("/")[0].toLowerCase() : model.provider.toLowerCase();
                model._vendor = vendor;
                // openWeights：open_weighted_lists.json 精确查找（按完整 ID，再按 base ID 去掉版本后缀）
                if (model.openWeights === undefined) {
                    const ow = owMap[model.id] ?? owMap[model.id.split(":")[0]];
                    if (ow !== undefined) model.openWeights = ow;
                }
                // fallback：models.dev catalog
                if (catalog && (model.openWeights === undefined || !model.family)) {
                    for (const mdProv of Object.values(catalog)) {
                        if (!mdProv?.models) continue;
                        const found = Object.values(mdProv.models).find((m) => m.id === model.id || m.id === `${model.provider}/${model.id}`);
                        if (found) {
                            if (model.openWeights === undefined && found.open_weights !== undefined) model.openWeights = found.open_weights;
                            if (!model.family && found.family) model.family = found.family;
                            break;
                        }
                    }
                }
                // series：family 优先，否则从 model ID 提取
                if (!model.family) {
                    const bare = model.id.includes("/") ? model.id.slice(model.id.indexOf("/") + 1) : model.id;
                    const first = bare.split(/[-_]/)[0].toLowerCase();
                    model.family = first || "";
                }
                model._series = model.family;
            }
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
        })).filter((item) => {
            // 2026-09-24（用户：只动 scoped，all 保持全量）——
            // deepseek/* 通配符会误匹配 openrouter 的 "deepseek/..." 模型（id 前缀匹配）+ models.dev 的 deepseek-flash 重复 id。
            // 这两类只在 scoped 视图过滤；all 视图（allModels）不动。
            if (item.provider === "openrouter")
                return false;
            if (item.provider === "deepseek" && item.id === "deepseek-flash")
                return false;
            // xiaomi 只保留 mimo-v2.6 两个（flash/pro），token-plan/ultraspeed/v2.5/v2-pro 都去掉
            if (item.provider.startsWith("xiaomi") && item.id !== "mimo-v2.6-flash" && item.id !== "mimo-v2.6-pro")
                return false;
            return true;
        });
        // scoped 模型也需要补元数据（_vendor/_series/openWeights），否则 Tab 切 scope 后渲染闪退
        for (const item of this.scopedModelItems) {
            const m = item.model;
            if (!m._vendor) m._vendor = m.id.includes("/") ? m.id.split("/")[0].toLowerCase() : m.provider?.toLowerCase() || "";
            if (!m._series) m._series = m.family || (m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id).split(/[-_]/)[0].toLowerCase();
        }
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
            // 2026-09-07 用户反馈排序乱：featured 组内 + provider 组内都按模型 id 字典序（原只 provider 字典序，组内保持 registry 原序——观感乱）
            const pc = a.provider.localeCompare(b.provider);
            return pc !== 0 ? pc : a.id.localeCompare(b.id);
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
        // 六栏渲染：hoster | provider | series | model | context | open/closed
        // ★ = featured 推荐（置顶，result 鲸鱼蓝）；✓ = 正在使用的模型（行尾，success 绿）
        // 选中行：所有文字用 accent 色高亮
        const vis = this.filteredModels.slice(startIndex, endIndex);
        const hosterW = Math.max(6, ...vis.map((it) => it.provider.length));
        const vendorW = Math.max(6, ...vis.map((it) => (it.model._vendor || "").length));
        const seriesW = Math.max(5, ...vis.map((it) => (it.model._series || "").length));
        const modelW = Math.max(16, ...vis.map((it) => {
            const bare = it.id.includes("/") ? it.id.slice(it.id.indexOf("/") + 1) : it.id;
            return bare.length;
        }));
        for (let i = startIndex; i < endIndex; i++) {
            const item = this.filteredModels[i];
            if (!item) continue;
            const featured = (globalThis.__genshinFeaturedModels) || [];
            const isFeatured = featured.some((f) => f.provider === item.provider && f.id === item.id);
            const isSelected = i === this.selectedIndex;
            const isCurrent = modelsAreEqual(this.currentModel, item.model);
            const fg = (color, text) => isSelected ? theme.fg("accent", text) : (color === "plain" ? text : theme.fg(color, text));
            const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
            const star = isFeatured ? theme.fg("result", "★ ") : "  ";
            const hosterCol = fg("muted", item.provider.padEnd(hosterW + 1));
            const vendorCol = fg("muted", (item.model._vendor || "?").padEnd(vendorW + 1));
            const seriesCol = fg("muted", (item.model._series || "?").padEnd(seriesW + 1));
            const bareId = item.id.includes("/") ? item.id.slice(item.id.indexOf("/") + 1) : item.id;
            const modelCol = isCurrent && !isSelected ? theme.fg("result", bareId.padEnd(modelW + 1)) : fg("plain", bareId.padEnd(modelW + 1));
            const ctxW = item.model.contextWindow;
            const ctxStr = ctxW ? (ctxW >= 1e6 ? (ctxW / 1e6).toFixed(1) + "M" : Math.round(ctxW / 1000) + "k") : "";
            const ctxCol = fg("muted", ctxStr.padStart(5));
            const ow = item.model.openWeights;
            const owCol = ow === true ? fg("success", " open") : ow === false ? fg("muted", "close") : fg("muted", "    ?");
            const check = isCurrent ? theme.fg("success", " ✓") : "";
            this.listContainer.addChild(new Text(`${prefix}${star}${hosterCol}${vendorCol}${seriesCol}${modelCol} ${ctxCol} ${owCol}${check}`, 0, 0));
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