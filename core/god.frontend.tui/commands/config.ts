import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { i18n } from "#tui_localizations";
const T = (zh: string, en: string) => i18n(zh, en);

const UA_DIR = join(homedir(), ".teyvat/UserAccount");
const UA_FILE = join(UA_DIR, "services.json");
const LEGACY_FILE = join(homedir(), ".teyvat/config/services.json");
const MODELS_FILE = join(homedir(), ".teyvat/config/models.json");

interface ServiceDef { name: string; en: string; group: string; fields: Record<string, string> }

// pi 内置 provider → env 变量名（源：pi-ai env-api-keys.js getApiKeyEnvVars；2026-09-04 合规化：
// 全部 provider 的 key 由 /c 维护写入 ~/.teyvat/config/env-keys.sh，launcher 启动 agent 前 source——
// 不再依赖用户 zshrc 的野 key（zshrc 野 key 属绕过 /c 的不合规路径））
const PROVIDER_ENV_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  mistral: "MISTRAL_API_KEY",
  minimax: "MINIMAX_API_KEY",
  huggingface: "HF_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
};

const DEFAULTS: Record<string, ServiceDef> = {
  deepseek: { name: "深度求索",             en: "DeepSeek",             group: "国内", fields: { apiKey: "", enabled: "y" } },
  "doubao-seed": { name: "豆包模型",        en: "Doubao Seed",           group: "国内", fields: { url: "", apiKey: "", model: "" } },
  qwen:    { name: "阿里千问百炼",          en: "Qwen Bailian",          group: "国内", fields: { apiKey: "", baseUrl: "", enabled: "y" } },
  "doubao-voicengine": { name: "豆包语音", en: "Doubao Voicengine",     group: "国内", fields: { appId: "", token: "" } },
  weread: { name: "微信读书",               en: "WeRead",                group: "国内", fields: { apiKey: "" } },
  amap:    { name: "高德",                  en: "Amap",                  group: "国内", fields: { apiKey: "" } },
  meituan: { name: "美团",                  en: "Meituan",               group: "国内", fields: { apiKey: "" } },
  openrouter: { name: "OpenRouter",             en: "OpenRouter",             group: "国外", fields: { apiKey: "", enabled: "y" } }, // 2026-09-04: pi 内置 provider（auth 读 env OPENROUTER_API_KEY），key 写 ~/.zshrc 供 launcher 继承；enabled=y 注册到 /m
  brave:  { name: "Brave 搜索",             en: "Brave Search",          group: "国外", fields: { apiKey: "" } },
  anna:   { name: "Anna 图书馆",            en: "Anna's Archive",        group: "国外", fields: { apiKey: "" } },
  x:      { name: "X (Twitter)",            en: "X API",              group: "国外", fields: { "Consumer Key": "", "Secret Key": "", "Bearer Token": "" } },
  bigmodel: { name: "智谱",                 en: "BigModel (Zhipu)",      group: "国内", fields: { apiKey: "", enabled: "y" } }, // 2026-08-27 glm-5.3-flash（baseUrl 固定 open.bigmodel.cn，用户只需配 apiKey）；09-04 加 enabled 开关（默认配了 apiKey 即启用）
  zai:      { name: "Z.ai 智谱",           en: "Z.ai (GLM)",           group: "国外", fields: { apiKey: "", enabled: "y" } }, // 09-04 合规化：ZAI_API_KEY 由 /c 维护
  cerebras: { name: "Cerebras",             en: "Cerebras",             group: "国外", fields: { apiKey: "", enabled: "y" } },
  groq:     { name: "Groq",                 en: "Groq",                 group: "国外", fields: { apiKey: "", enabled: "y" } },
  moonshotai: { name: "月之暗面 Kimi",       en: "Moonshot (Kimi)",      group: "国内", fields: { apiKey: "", enabled: "y" } },
  mistral:  { name: "Mistral",              en: "Mistral",              group: "国外", fields: { apiKey: "", enabled: "y" } },
  minimax:  { name: "MiniMax",              en: "MiniMax",              group: "国内", fields: { apiKey: "", enabled: "y" } },
  xai:      { name: "xAI (Grok)",           en: "xAI (Grok)",           group: "国外", fields: { apiKey: "", enabled: "y" } },
};

function defaultFields(): Record<string, any> {
  const s: Record<string, any> = {};
  for (const [k, v] of Object.entries(DEFAULTS)) s[k] = { ...v.fields };
  return s;
}

// 2026-08-27: /c 配置的 apiKey 同步到 models.json 对应 provider（模型切换 /m 用；baseUrl 固定官方端点不覆盖）
function syncModelsJson(services: Record<string, any>) {
  try {
    if (!existsSync(MODELS_FILE)) return;
    const m = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
    const svc = services.bigmodel;
    const prov = m.providers?.bigmodel;
    if (svc && prov) {
      if (typeof svc.apiKey === "string" && svc.apiKey.trim()) prov.apiKey = svc.apiKey.trim();
      writeFileSync(MODELS_FILE, JSON.stringify(m, null, 4));
    }
  } catch (e) { console.error("[god.frontend.tui/commands/config.ts] syncModelsJson: " + ((e as any)?.message || e)); }
}

// 2026-09-04 合规化（泛化原 syncOpenRouterEnv）：所有 pi 内置 provider 的 key 由 /c 统一维护——
// 写 ~/.teyvat/config/env-keys.sh（pi 内置 provider 只认 env 变量，变量名见 PROVIDER_ENV_KEYS；
// launcher.sh 每次迭代 source env-keys.sh，同名变量覆盖用户 zshrc 野 key——/c 成为唯一凭证入口）。
// 重启 agent 生效。
function syncProviderEnvKey(provider: string, services: Record<string, any>): void {
  try {
    const envVar = PROVIDER_ENV_KEYS[provider];
    if (!envVar) return;
    const key = services[provider]?.apiKey;
    if (typeof key !== "string" || !key.trim()) return;
    const line = `export ${envVar}="${key.trim()}"`;
    const envFile = join(homedir(), ".teyvat/config/env-keys.sh");
    let envContent = existsSync(envFile) ? readFileSync(envFile, "utf8") : "# teyvat agent env keys（/c 维护，launcher 启动 agent 前 source）\n";
    const envLines = envContent.split("\n");
    const eIdx = envLines.findIndex((l) => new RegExp(`^\\s*export\\s+${envVar}=`).test(l));
    if (eIdx >= 0) envLines[eIdx] = line;
    else envLines.push(line);
    writeFileSync(envFile, envLines.join("\n") + (envLines.join("\n").endsWith("\n") ? "" : "\n"));
  } catch (e) { console.error("[god.frontend.tui/commands/config.ts] syncProviderEnvKey: " + ((e as any)?.message || e)); }
}

// 2026-09-04: openrouter 是 pi 内置 provider（openrouterProvider() 的 auth = envApiKeyAuth(["OPENROUTER_API_KEY"])）——
// 实测 models.json 的 provider.apiKey 对内置 provider 无效（openrouter 模型 auth 判定 0），key 必须在环境变量。
// 已泛化为 syncProviderEnvKey（上）。保留此别名注释以示历史。
function syncOpenRouterEnv(services: Record<string, any>) {
  syncProviderEnvKey("openrouter", services);
}

// 2026-09-04（用户设计）：/c 配置服务 = 注册到 /m 的管线——enabledModels 追加 provider/* pattern，
// 经 resolveModelScope 解析为 scopedModels → /m 选择器默认 scoped 视图显示该 provider 全部模型（Tab 切 all 看全量）。
// patterns 持久化在 globalSettings.enabledModels（settingsManager.setEnabledModels），重启 agent 生效。
// 启用开关：services[key].enabled（默认 "y"=配了 apiKey 即启用；设 "n"=从 /m 移除该 provider）。
function registerToM(provider: string): void {
  try {
    const sm = (globalThis as any).__genshinSettingsManager;
    if (!sm?.setEnabledModels) return; // settingsManager 未就绪
    const patterns: string[] = [...(sm.getEnabledModels?.() || [])];
    const p = `${provider}/*`;
    if (!patterns.includes(p)) { patterns.push(p); sm.setEnabledModels(patterns); }
  } catch (e) { console.error("[god.frontend.tui/commands/config.ts] registerToM: " + ((e as any)?.message || e)); }
}

function unregisterFromM(provider: string): void {
  try {
    const sm = (globalThis as any).__genshinSettingsManager;
    if (!sm?.setEnabledModels) return;
    const patterns: string[] = [...(sm.getEnabledModels?.() || [])];
    const next = patterns.filter((x) => x !== `${provider}/*`);
    if (next.length !== patterns.length) sm.setEnabledModels(next);
  } catch (e) { console.error("[god.frontend.tui/commands/config.ts] unregisterFromM: " + ((e as any)?.message || e)); }
}

// provider 类服务的注册/停用统一入口（enabled 默认 "y"=配了 apiKey 即启用）
function syncProviderRegistration(key: string, svc: Record<string, any>): void {
  const isEnabled = String(svc.enabled ?? "y").trim().toLowerCase() !== "n";
  if (isEnabled) registerToM(key);
  else unregisterFromM(key);
}

export async function configHandler(_args: any, ctx: any) {
  const sf = existsSync(UA_FILE) ? UA_FILE : existsSync(LEGACY_FILE) ? LEGACY_FILE : UA_FILE;
  let services: Record<string, any> = {};
  try { services = JSON.parse(readFileSync(sf, "utf8")); } catch (e) { console.error("[god.frontend.tui/commands/config.ts] " + ((e as any)?.message || e)); }
  const keys = Object.keys(services);
  if (!keys.length) {
    mkdirSync(UA_DIR, { recursive: true });
    services = defaultFields();
    writeFileSync(UA_FILE, JSON.stringify(services, null, 2));
  }
  // 确保所有 DEFAULTS key 与字段都存在（向后兼容：svc 存在但缺新字段如 enabled 时补默认值，
  // 否则显示「未设置」且 isEnabled 判定依赖散落——2026-09-04 用户报 enabled 显示 bug）
  let patched = false;
  for (const k of Object.keys(DEFAULTS)) {
    if (!services[k]) { services[k] = { ...DEFAULTS[k].fields }; patched = true; }
    else {
      for (const [fk, fv] of Object.entries(DEFAULTS[k].fields)) {
        if (services[k][fk] === undefined) { services[k][fk] = fv; patched = true; }
      }
    }
  }
  if (patched) { try { mkdirSync(UA_DIR, { recursive: true }); writeFileSync(UA_FILE, JSON.stringify(services, null, 2)); } catch (e) { console.error("[god.frontend.tui/commands/config.ts] " + ((e as any)?.message || e)); } }

  while (true) {
    const displayKeys = Object.keys(services).sort((a, b) => {
      const ga = DEFAULTS[a]?.group || "";
      const gb = DEFAULTS[b]?.group || "";
      if (ga !== gb) return ga.localeCompare(gb);
      return (DEFAULTS[a]?.name || a).localeCompare(DEFAULTS[b]?.name || b, "zh-CN");
    });
    // CJK 视觉宽度
    const cw = (s: string) => { let w = 0; for (const c of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1; return w; };
    // 左列最大宽度：取所有左列字符串的视觉宽
    const leftMax = Math.max(...displayKeys.map(k => {
      const isCN = DEFAULTS[k]?.group === "国内";
      return cw(isCN ? (DEFAULTS[k]?.name || k) : (DEFAULTS[k]?.en || k));
    }));
    // 右列最大宽度（第三栏对启用状态列对齐，2026-09-04）
    const rightMax = Math.max(...displayKeys.map(k => {
      const isCN = DEFAULTS[k]?.group === "国内";
      return cw(isCN ? (DEFAULTS[k]?.en || k) : (DEFAULTS[k]?.name || k));
    }));
    const options = displayKeys.map(key => {
      const svc = services[key] || {};
      const fields = Object.keys(svc);
      const cn = DEFAULTS[key]?.name || key;
      const en = DEFAULTS[key]?.en || "";
      const isCN = DEFAULTS[key]?.group === "国内";
      const left = isCN ? cn : en;
      const right = isCN ? en : cn;
      const allSet = fields.every(f => typeof svc[f] === "string" && svc[f].trim());
      const noneSet = fields.every(f => !svc[f] || !(svc[f] as string).trim());
      const icon = allSet ? "[✓]" : noneSet ? "[ ]" : "[◐]";
      const pad = " ".repeat(leftMax - cw(left) + 2);
      // 第三栏：启用状态（provider 类显示 [启用]/[停用]，非 provider 显示 — 保持对齐；2026-09-04）
      const isProviderSvc = "enabled" in (DEFAULTS[key]?.fields || {});
      const enabledOn = String(svc.enabled ?? "y").trim().toLowerCase() !== "n";
      const statusCol = isProviderSvc ? (enabledOn ? "[启用]" : "[停用]") : "—";
      const pad2 = " ".repeat(rightMax - cw(right) + 2);
      return { key, text: `${icon} ${left}${pad}${right}${pad2}${statusCol}` };
    });
    const choice = await ctx.ui.select(T("服务配置", "Service Config"), options.map(o => o.text));
    if (!choice) break;
    const idx = options.findIndex(o => o.text === choice);
    if (idx < 0) break;
    const key = options[idx].key;
    const svc = services[key] || {};
    // 2026-08-27: 字段以 DEFAULTS 定义为准（services.json 里的残留键不显示，如 bigmodel 旧 baseUrl）
    const fields = Object.keys(DEFAULTS[key]?.fields || svc);
    const display = i18n(DEFAULTS[key]?.name || key, DEFAULTS[key]?.en || key);

    while (true) {
      const fieldOpts = fields.map(f => {
        const v = svc[f];
        const display = (typeof v === "string" && v.trim()) ? v.slice(0, 8) + "..." : T("(未设置)", "(not set)");
        return `${f.padEnd(16)}  ${display}`;
      });
      const fieldChoice = await ctx.ui.select(T(`${display} 配置`, `${display} Config`), fieldOpts);
      if (!fieldChoice) break;
      const fi = fieldOpts.indexOf(fieldChoice);
      if (fi < 0) break;
      const field = fields[fi];
      const newVal = await ctx.ui.input(`${display}.${field}`);
      if (newVal !== undefined && newVal !== null) {
        svc[field] = newVal.trim();
        services[key] = svc;
        mkdirSync(UA_DIR, { recursive: true });
        writeFileSync(UA_FILE, JSON.stringify(services, null, 2));
        if (key === "bigmodel") { syncModelsJson(services); syncProviderRegistration(key, svc); }
        else if (PROVIDER_ENV_KEYS[key]) { syncProviderEnvKey(key, services); syncProviderRegistration(key, svc); }
        else if (key === "qwen") syncProviderRegistration(key, svc); // qwen 为 models.json 自定义 provider（不走 env），但注册/停用管线同
      }
    }
  }
}
