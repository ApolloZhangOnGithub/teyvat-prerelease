// kernel.core/core.ts
// ── 内核 / 装配点 ────────────────────────────────────────────────────────────
// pi 把这一个扩展当入口加载。kernel 读 RNA，把每个 func（蛋白质）表达到同一个 pi 上。
// 这是机器，不是基因。
//
// 设计取舍（诚实说明）：
//  - kernel 在「每个」genshin 实例里都跑（main / 元意识 tmux / 海马体 tmux / 睡眠 tmux）。
//  - 目前 kernel 加载「所有非 future 的 func」，由 func 自己按 session 角色自门控
//    （元意识检测 ismetaconsciousness、海马体检测 personDir……这和现行 live 行为一致）。
//  - rna 的 session 字段先作为「声明 + 运行期可查询」，严格按 session 选择性加载留作后续优化。
//  - mode 切换：func 在 before_agent_start 里查 runtime.getMode()/isAbled() 决定是否表达，
//    所以 /mode 切换后，下一轮 agent 起来就生效。
// 文档: B.docs/Dev.Common/Wiki/Kernel(Core).WIKI

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { logerr, userFile, runtimeCacheDir } from "#paths";

// ── i18n 辅助 ──
export function t(zh: string, en: string): string {
  return ((globalThis as any).__genshinLang === "zh") ? zh : en;
}
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DIRS, IS_DEV } from "#paths";
import { personId } from "../kernel.heart/heart-state.ts"; // 从 process.title 解析 agent id（__genshinPersonId 全局变量由 metaconsciousness 才赋值，core.ts 过滤链可能先执行）
import * as rt from "#kernel_ribosome";

// ── func 静态登记表（新增 func：在 spirit.bio.organs 建文件夹 + promotor.dna 声明 + 这里加一行）──
// 入口 = 该 func 真正带 default(pi) 的文件，不再要空壳 index.ts。
import body_heart from "#kernel_heart";                       // 心脏 func 入口（状态机+continuous loop）。曾指向 kernel 自身导致递归自表达栈爆，见 LESSON 030
import body_hands_execute from "#hands_execute";               // execute tool（从 heart 分离）
import body_hands_fileactions from "#hands_fileactions";
import body_hands_fileread from "../hands.fileacts/fileacts-read.ts";   // read 工具覆盖：office 格式自动分发 + pi 原逻辑回退
import body_hands_webacts from "#hands_webacts";
import brain_memory from "#brain_memory";   // 记忆机能（原 brain.hippocampus/hippocampus-memory.ts，已独立为器官）；2026-08-18 统一 default 导出（原 registerMemory 具名，NORM-009 func 入口统一）
// 2026-08-20 技术债处理（用户责令）：以下两个 import 注释掉（不导入）——
//  brain.hippocampus：@FUTURE 预留（promotor.dna:103）+ TRADITIONAL_HIPPOCAMPUS 开关关（false）→ 不装配
//  brain.metaconsciousness：rna.json 无注册 → 装配循环不查 REGISTRY → 不装配（REGISTRY 映射为死映射）
// import brain_hippocampus_spawn from "#brain_hippocampus";   // 海马体 spawn（default export）
// @Dep import brain_amygdala from "#brain_amygdala";  // @ABANDONED 杏仁核
import brain_senses_bioclock from "#brain_bioclock";
// import brain_senses_metaconsciousness from "#brain_metaconsciousness"; // 技术债：rna.json 无注册，不装配
import brain_intentions from "../brain.intentions/intentions.ts";
import body_ear from "#head_ears";
import body_mouth from "#head_mouth";
import body_eyes_visual from "#head_eyes";
import technology_mobile from "#infotech_mobile";
import body_social from "#social_communicate";
import body_help from "#kernel_help";   // help 工具：按需查询工具用法（system prompt 只给摘要，详情走 help）

import { sendCustomMessage, MESSAGE_TYPES, flushTools } from "#kernel_backbone";
import { initBlockrender } from "#tui_blockrender";
import { Text, Container } from "@earendil-works/pi-tui";
initBlockrender(Text, Container);
import { registerGodCommands } from "../../god.frontend.tui/commands/register.ts";
import { initStatusUI } from "../../spirit.bio.organs/kernel.heart/heart-state.ts";

// ── console.error 全局重定向（2026-08-20 用户定稿，LESSON 063）：console.error 输出到 stderr 会污染 TUI 屏幕——
//    526 处空 catch 批量加的 console.error 全部闪屏成垃圾。重定向到 LogData/<id>/console-error.log，
//    禁止上屏（错误保留可查）。TUI 环境禁止任何 console 直接输出。
const __consoleErrId = (() => {
  // 2026-08-20 修复：优先用环境变量（launcher 启动即设置）——process.title 在模块加载时还没设置，
  // 用 title 解析会失败落到 unknown/（实测：错误全写进 LogData/unknown/console-error.log）
  if (process.env.PAIMON_AGENT_ID) return process.env.PAIMON_AGENT_ID;
  try { const m = process.title.match(/\(main,([a-f0-9]+)/); return m?.[1] || "unknown"; } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); return "unknown"; }
})();
const __consoleErrDir = join(homedir(), ".teyvat", "LogData", __consoleErrId);
const __consoleErrPath = join(__consoleErrDir, "console-error.log");
try { mkdirSync(__consoleErrDir, { recursive: true }); } catch { /* 目录创建失败则放弃（此处禁止 console.error：会递归进重定向后的自身） */ }
console.error = (...args: any[]) => {
  try { appendFileSync(__consoleErrPath, new Date().toISOString() + " " + args.map(String).join(" ") + "\n"); } catch { /* 日志写入失败则静默丢弃（禁止 console.error 递归） */ }
  // 不再输出 stderr（TUI 会显示成垃圾），错误已入日志文件可查
};

// 新增工具必须在此 REGISTRY 登记！同时还要：promotor.dna 加 func 声明 + tools.manifest.json 加条目（NORM-013, LESSON 055）
// 四步：1) registerPaimonTool 2) tools.manifest.json 3) promotor.dna func 声明 4) 本 REGISTRY import + 登记
// Wiki: Func(Bio Mechanism).WIKI
type FuncEntry = (pi: ExtensionAPI) => void;
const REGISTRY: Record<string, FuncEntry> = {
  "kernel.heart": body_heart,
  "hands.executes": body_hands_execute,
  "hands.fileacts": body_hands_fileactions,
  "hands.fileacts-read": body_hands_fileread,
  "hands.webacts": body_hands_webacts,
  "brain.memory": brain_memory,
  // @Dep "brain.amygdala": brain_amygdala,  // @ABANDONED
  "brain.bioclock": brain_senses_bioclock,
  // "brain.metaconsciousness": brain_senses_metaconsciousness,  // 2026-08-20 注释：rna.json 无注册，装配循环不驱动该映射（技术债）
  "brain.intentions": brain_intentions,
  "head.ears": body_ear,
  "head.eyes": body_eyes_visual,
  "head.mouth": body_mouth,
  "universe.infotech/local.mobile": technology_mobile,
  "social.communicate": body_social,
  "kernel.help": body_help,

};

// session 角色：从 session 文件路径判断这个 genshin 实例是谁
function detectRole(sessionFile?: string | null): string {
  if (!sessionFile) return "main";
  if (sessionFile.includes("metaconsciousnessSessions")) return "metaconsciousness";
  if (sessionFile.includes("HippocampusSessions")) return "hippocampus";
  if (sessionFile.includes("SleepSessions")) return "sleep";
  return "main";
}

export default function kernelMain(pi: ExtensionAPI) {
  // 自动备份调度（从 bioclock 迁入 backup.ts，此处启动）
  import("../../god.frontend.cli/backup.ts").then(m => m.startAutoBackup()).catch(e => console.error("[kernel.core] startAutoBackup: " + ((e as any)?.message || e)));
  // 2026-08-20：全局消息桥——命令层（god.frontend.tui/commands/）拿不到 pi，
  // 但 /h 等命令需要给 agent 注入通知消息（用户设计：/h 转后台时通知 agent，用 Life Restarted 管线渲染）。
  // 这里把 sendCustomMessage 挂到 globalThis 供命令层调用（backbone 强制所有消息走 sendCustomMessage）。
  (globalThis as any).__genshinSendCustomMessage = (type: string, content: string, details?: unknown, overrides?: any) => {
    try { sendCustomMessage(pi, type, content, details, overrides); } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
  };
  // ── 收集工具描述：注册时记录 messageDescription，before_agent_start 时注入 system prompt ──
  const _toolDescs = new Map<string, string>();
  const _origRegisterTool = pi.registerTool.bind(pi);
  pi.registerTool = (def: any) => {
    if (def.name && def.messageDescription) {
      _toolDescs.set(def.name, def.messageDescription);
    }
    return _origRegisterTool(def);
  };

  // ── 字段别名：teyvat 的命名 → genshin 框架的命名。拦截 sendMessage 自动映射。
  // teyvat: messageType / isDisplayedInTUI / isTriggerNewTurn
  // pi:  customType   / display          / triggerTurn
  const _origSendMessage = pi.sendMessage.bind(pi);
  (pi as any).sendMessage = (msg: any, opts?: any) => {
    if (msg) {
      if ('messageType' in msg && !('customType' in msg)) msg.customType = msg.messageType;
      if ('isDisplayedInTUI' in msg && !('display' in msg)) msg.display = msg.isDisplayedInTUI;
    }
    if (opts) {
      if ('isTriggerNewTurn' in opts && !('triggerTurn' in opts)) opts.triggerTurn = opts.isTriggerNewTurn;
    }
    // 强制校验：所有 customType 必须在 backbone MESSAGE_TYPES 注册
    const ct = msg?.customType || msg?.messageType;
    if (ct && !MESSAGE_TYPES[ct]) {
      const err = `[backbone] 消息类型 "${ct}" 未注册。所有消息必须走 sendCustomMessage()，不能直接调 pi.sendMessage()。`;
      logerr("MSG_UNREG", err);
      if (process.env.NODE_ENV !== "production") throw new Error(err);
    }
    return _origSendMessage(msg, opts);
  };

  // 崩溃记录器：写进 agent 自身 ErrorData，不是 /tmp。
  // 用 prependListener 抢在 pi 自己的退出处理器之前先落盘。
  try {
    const crashLog = (tag: string, e: any) => {
      try {
        const pid = (globalThis as any).__genshinPersonId || "unknown";
        const ed = `${homedir()}/.teyvat/ErrorData/${pid}`;
        mkdirSync(ed, { recursive: true });
        appendFileSync(`${ed}/crash.log`, `[${new Date().toISOString()}] [${process.title}] ${tag}:\n${e?.stack ?? e}\n\n`);
      } catch (e2) { logerr("K001", e2); }
    };
    // 结束原因标记：crash（异常）/ user-ctrl-c（用户中断）
    (globalThis as any).__genshinSessionEndReason = undefined;
    let _epipeLogged = false;
    process.prependListener("uncaughtException", (e) => {
      // 2026-08-20 EPIPE 兜底（frontierLM 转交闪退）：管道对端关闭（终端关/pty 死亡）不闪退，
      // 静默记录继续跑——main.js 顶部已挂 stdout/stderr error 监听吞写 stdout 的 EPIPE，
      // 这里是第二道防线（覆盖非 stdout 管道写路径）。只记一次防刷屏。
      if ((e as any)?.code === "EPIPE") {
        if (!_epipeLogged) { _epipeLogged = true; crashLog("EPIPE-ignored", e); }
        return;
      }
      (globalThis as any).__genshinSessionEndReason = "crash"; crashLog("uncaughtException", e);
    });
    process.prependListener("unhandledRejection", (e: any) => { (globalThis as any).__genshinSessionEndReason = "crash"; crashLog("unhandledRejection", e); });
    process.prependListener("SIGINT", () => { (globalThis as any).__genshinSessionEndReason = "user-ctrl-c"; });
    process.prependListener("SIGTERM", () => { (globalThis as any).__genshinSessionEndReason = "user-ctrl-c"; });
    // exit 时同步写 session 结束记录（exit 一定会触发，比 session_shutdown 可靠）
    process.prependListener("exit", () => {
      try {
        const pid = (globalThis as any).__genshinPersonId;
        if (!pid) return;
        const logDir = `${homedir()}/.teyvat/LogData/${pid}`;
        mkdirSync(logDir, { recursive: true });
        // self-reboot 命令写了 reason 文件 → 自行重启；否则用信号标记；默认正常退出
        let reason = "shutdown";
        try {
          const rp = join(homedir(), ".teyvat/RuntimeCache", pid, "self-reboot-reason.json");
          if (existsSync(rp)) reason = "self-reboot";
        } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
        const sig = (globalThis as any).__genshinSessionEndReason;
        if (reason === "shutdown" && sig) reason = sig;
        const st = (globalThis as any).__genshinSessStartedAt || Date.now();
        appendFileSync(join(logDir, "sessions.log"), JSON.stringify({ type: "end", ts: new Date().toISOString(), reason, elapsed_ms: Date.now() - st }) + "\n");
      } catch (e2) { logerr("K023", e2); }
    });
  } catch (e) { logerr("K002", e); }

  // 余额硬闸最先装上（代码强制，不靠模型）：余额到地板/烧钱超速 → 连小号一起停。


  // 钱包工具（agent 查余额/交易记录）—— dollar 系统已冷冻,禁用
  // installDollarTools(pi);

  // ── 身份（装配式设计：从 prompt 体系取 # identity，不再直读 core.dna）──
  let _coreDna = "";
  try {
    _coreDna = rt.getPrompt("identity");
  } catch (e: any) { logerr("K010", `identity prompt 读取失败: ${e?.message ?? e}`); }

  // ── 身份 + 工具概览注入（替换框架默认 system prompt）──
  // 2026-08-15 精简：不再注入完整 messageDescription（每个工具几十~几百字符），
  // 改为一行摘要（manifest desc 优先）+ 指引用 help <name> 查详情——省 system prompt token，
  // agent 需要细节时主动 help。完整说明仍由 help 工具按需提供。
  // ISSUE 117（2026-08-18）：system prompt 冻结——首次生成后每轮复用同一份（逐字不变）。
  // 此前每轮动态组装（依赖 getActiveTools），wait/hibernate 打断 → 会话 rebind →
  // getActiveTools 的 assertActive 抛错 → 注入中断 → 前缀回落 pi 默认 → 全量缓存 miss（30s+ prefill）。
  // 冻结后前缀永久稳定 = 前缀缓存命中的关键（与 memory 快照冻结同思路）。
  let _frozenSystemPrompt = "";
  // ISSUE 115 缓存诊断：记录 system prompt hash——冻结后每轮 hash 逐字一致 = 前缀稳定（放开头确保每轮都记录，
  // 即使冻结 return 或首轮 getActiveTools 抛错走降级分支也能留证）
  const _logSyspromptHash = () => {
    if (!_frozenSystemPrompt) return;
    try {
      let h = 0;
      for (let i = 0; i < _frozenSystemPrompt.length; i++) h = ((h << 5) - h + _frozenSystemPrompt.charCodeAt(i)) | 0;
      const dir = runtimeCacheDir(personId());
      if (dir) { mkdirSync(dir, { recursive: true }); appendFileSync(dir + "/sysprompt.log", `${new Date().toISOString()},${h},${_frozenSystemPrompt.length}\n`); }
    } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
  };
  pi.on("before_agent_start", async (event) => {
    // 每轮记录 hash（冻结后应逐字一致）
    _logSyspromptHash();
    // 冻结复用：后续轮直接返回同一份（无论状态如何变化，前缀逐字不变）
    if (_frozenSystemPrompt) return { systemPrompt: _frozenSystemPrompt };
    // getActiveTools 保护：rebind 期间 assertActive 可能抛错（ISSUE 117），用空数组降级
    let active: string[] = [];
    try { active = pi.getActiveTools?.() ?? []; } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
    let mTools: Record<string, any> = {};
    try { mTools = rt.getToolManifest()?.tools || {}; } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
    const toolLines = active
      .filter((name: string) => _toolDescs.has(name))
      .map((name: string) => {
        const mdef = mTools[name];
        const desc = mdef?.desc || String(_toolDescs.get(name)).split("\n")[0].slice(0, 100);
        return `- ${name}: ${desc}`;
      });
    const toolSection = toolLines.length ? "\n\n## Tools\n" + toolLines.join("\n") + "\n完整用法用 help <name> 查询（如 help amem）。" : "";

    // 用 core.dna 身份替换框架默认的 "expert coding assistant" 模板，
    // 保留框架追加的尾部信息（date/cwd/context files）
    if (_coreDna) {
      const base = event.systemPrompt || "";
      // 框架尾部：从 "Current date:" 开始的部分
      const dateIdx = base.lastIndexOf("\nCurrent date:");
      const tail = dateIdx >= 0 ? base.slice(dateIdx) : "";
      _frozenSystemPrompt = _coreDna + toolSection + tail;
    } else if (toolLines.length) {
      _frozenSystemPrompt = event.systemPrompt + toolSection;
    } else {
      return; // 理论上不发生（_coreDna 空且无工具）；不注入保持 pi 默认
    }
    // 首轮生成后记录一次（后续轮由 handler 开头的 _logSyspromptHash 记录）
    _logSyspromptHash();
    return { systemPrompt: _frozenSystemPrompt };
  });

  // 读 RNA（含错误会抛 → 整个扩展拒绝加载，fail loud）
  const raw = rt.rnaRaw();
  const loaded: string[] = [];
  const missing: string[] = [];

  // 提前检测 session 角色（从环境/进程信息推断）
  const earlyRole = (() => {
    const cwd = process.cwd();
    if (cwd.includes("metaconsciousnessSessions")) return "metaconsciousness";
    if (cwd.includes("HippocampusSessions")) return "hippocampus";
    if (cwd.includes("SleepSessions")) return "sleep";
    return "main";
  })();

  // ── 表达每个 func（按 session 过滤）──
  for (const f of Object.values(raw.funcs)) {
    if (f.future) continue;
    // session 门控：暂时禁用（PROPOSAL-001）。hippocampus 的 registerMemory 主意识也需要，
    // 按 session 过滤会导致主意识丢失记忆注入。等 func 拆分完（memory 独立出 hippocampus）再启用。
    // const sessions: string[] = f.session || [];
    // if (sessions.length > 0 && !sessions.includes("all") && !sessions.includes(earlyRole)) {
    //   continue;
    // }
    const entry = REGISTRY[f.name];
    if (!entry) { missing.push(f.name); continue; }
    // 自指防护：entry 指回 kernel 自己（别名配错）会无限递归自表达直到栈爆，跳过并告警
    if ((entry as unknown) === kernelMain) {
      try { sendCustomMessage(pi, "system-error", `WARN: func ${f.name} 的 REGISTRY entry 指向 kernel 自身（#别名配错?），已跳过以防递归`); } catch (e2) { logerr("K016", e2); }
      continue;
    }
    try {
      entry(pi);
      loaded.push(f.name);
    } catch (e: any) {
      // ⚠️ FAIL-FAST（用户多次强调，2026-08-18 第三次，ISSUE 112）：func 加载失败必须报错中断，
      // 不能静默 WARN。教训（2026-08-18 实测）：静默 WARN → manifest default:true 工具未注入
      // → K020 启动硬检查才 throw（social 曾因此未注入）；且 K020 throw 在 process.title 设置前，
      // 导致 personId() 提取失败 → validateExecute 的 root/own-id 放行全失效，连锁故障。
      // make 门禁：C.deploy/check-func-load.cjs 会在部署时加载所有 func 预检（构建期拦截）。
      logerr("K002", e, `func ${f.name} load`);
      throw new Error(`[K002] func ${f.name} 加载失败（fail-fast，ISSUE 112）: ${e?.message ?? e}`);
    }
  }
  // ── 工具统一注册（所有 organ 加载完后 flush）──
  try { flushTools(pi); } catch (e: any) { logerr("K005", e); }

  // promotor.dna 声明了、但 REGISTRY 里没登记的 func —— 提醒（不致命）
  if (missing.length) {
    try {
      sendCustomMessage(pi, "system-error", `WARN: 这些 func 在 promotor.dna 已声明但 kernel 未登记: ${missing.join(", ")}（在 kernel.core/core.ts REGISTRY 加 import）`);
    } catch (e2) { logerr("K006", e2); }
  }

  // 反向检查：REGISTRY 登记了、但 promotor.dna/RNA 未声明的 func —— 不能静默！
  // LESSON 055：hands.fileacts-read 曾因 RNA 缺声明而静默不注册（代码/登记/文档全齐，唯独基因少一行），
  // read 的 office 支持写了却从未生效，只有实测才能暴露。此检查保证反向断线必报警。
  try {
    const declaredSet = new Set(Object.keys(raw.funcs));
    const unDeclared = Object.keys(REGISTRY).filter((name) => !declaredSet.has(name));
    if (unDeclared.length) {
      sendCustomMessage(pi, "system-error", `WARN: 这些 func 在 kernel REGISTRY 已登记但 promotor.dna 未声明: ${unDeclared.join(", ")}（在 promotor.dna 加 func 声明并重新生成 rna.json，否则永远不会被加载）`);
    }
  } catch (e2) { logerr("K023", e2); }

  // ── session 角色检测 + 进程自报家门（不可伪造）──────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    try { initStatusUI(ctx.ui); } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
    const sf = ctx.sessionManager.getSessionFile();
    const role = detectRole(sf);
    rt.setSessionRole(role);

    // ── 工具过滤（代码层强制，所有 role 都过滤）──
    {
      const ROLE_TOOLS: Record<string, string[]> = {};
      try {
        const manifestPath = resolve(DIRS.core, "spirit.bio.gene/tools.manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.roles) Object.assign(ROLE_TOOLS, manifest.roles);
      } catch (e) { logerr("K007", e); }

      let allowed: Set<string>;
      if (role === "main") {
        try {
          const manifestPath = resolve(DIRS.core, "spirit.bio.gene/tools.manifest.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          const tools = manifest.tools || {};
          // 标准 default 集合
          const enabled = new Set<string>();
          for (const [k, v] of Object.entries(tools)) {
            const e = v as any;
            if (e.default && !e.abandoned) enabled.add(k);
          }
          // 每模型工具覆盖清单：spirit.bio.gene/tools/<model-id>.json（出生时克隆 template.json）
          try {
            // session_start 事件不带 model（heart.ts 的 before_agent_start 才有 event.model）。
            // 从 ctx.model / settings.defaultModel 兜底取当前模型 id。
            let modelId = ((ctx as any)?.model?.id || "").toString();
            if (!modelId) {
              try {
                const sPath = userFile("settings.json");
                if (existsSync(sPath)) {
                  const s = JSON.parse(readFileSync(sPath, "utf8"));
                  modelId = (s?.defaultModel || "").toString();
                }
              } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
            }
            if (modelId) {
              const modelPath = resolve(DIRS.core, `spirit.bio.gene/tools/${modelId}.json`);
              if (existsSync(modelPath)) {
                const ov = JSON.parse(readFileSync(modelPath, "utf8"))?.overrides || {};
                for (const [k, v] of Object.entries(ov)) {
                  if (v === true) enabled.add(k);
                  else if (v === false) enabled.delete(k);
                }
              }
            }
          } catch (e2) { logerr("K024", e2); }
          allowed = enabled;
        } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); allowed = new Set(); }
      } else {
        allowed = new Set(ROLE_TOOLS[role] || []);
      }

      // ── 工具持久授权（/a enable-<tool> /a disable-<tool>，~/.teyvat/config/tools-auth.json）──
      // 用户批准的叠加层（跨 session）：enable 可启用 manifest default:false 的工具，disable 撤销。
      // 仅 main 角色生效（metaconsciousness/hippocampus/sleep 是系统角色，不受用户授权影响）。
      // 优先级：会话覆盖(/tools) > 用户全局禁用(settings.disabled) > 持久授权 > 模型覆盖 > manifest default
      if (role === "main") {
        try {
          const pid = personId();
          if (pid) {
            // 每 agent 独立目录：~/.teyvat/config/tools-auth/<pid>/tools-auth.json
            const authPath = join(homedir(), ".teyvat/config/tools-auth", pid, "tools-auth.json");
            if (existsSync(authPath)) {
              const d = JSON.parse(readFileSync(authPath, "utf8")) || {};
              const en: string[] = d.enabled || [];
              const dis: string[] = d.disabled || [];
              if (en.length || dis.length) {
                const manifestPath = resolve(DIRS.core, "spirit.bio.gene/tools.manifest.json");
                let allNames: string[] = [];
                try {
                  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
                  allNames = Object.keys(m.tools || {});
                } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
                for (const n of en) {
                  const canon = allNames.find(x => x.toLowerCase() === n.toLowerCase());
                  if (canon) allowed.add(canon);
                }
                for (const n of dis) {
                  const canon = allNames.find(x => x.toLowerCase() === n.toLowerCase());
                  if (canon) allowed.delete(canon);
                }
              }
            }
          }
        } catch (e) { logerr("K026", e); }
      }

      if (allowed.size > 0) {
        const current: string[] = pi.getActiveTools() ?? [];
        const filtered = current.filter((t: string) => allowed.has(t));
        pi.setActiveTools(filtered);
      }

      // ── 用户设置的工具禁用（settings.json tools.disabled）──
      try {
        const settingsPath = userFile("settings.json");
        if (existsSync(settingsPath)) {
          const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
          const disabled: string[] = settings?.tools?.disabled || [];
          if (disabled.length > 0) {
            const current = pi.getActiveTools();
            pi.setActiveTools(current.filter((t: string) => !disabled.includes(t)));
          }
        }
      } catch (e) { logerr("K009", e); }

      // ── 会话级工具覆盖（/tools <name> toggle，RuntimeCache/tools-session.json）──
      // 覆盖优先级：会话 > 模型 > manifest default。会话可启用 default:false 的工具。
      try {
        const pid = (globalThis as any).__genshinPersonId || (globalThis as any).__genshinPersonDir?.split("/").pop() || "";
        if (pid) {
          const sessPath = join(runtimeCacheDir(pid), "tools-session.json");
          if (existsSync(sessPath)) {
            const sessOv = JSON.parse(readFileSync(sessPath, "utf8")) || {};
            const current = pi.getActiveTools();
            const lower = current.map((t: string) => t.toLowerCase());
            const out: string[] = [...current];
            // manifest 全部工具名（含 default:false）——会话启用时从这里校验并取规范名
            const manifestPath = resolve(DIRS.core, "spirit.bio.gene/tools.manifest.json");
            let allNames: string[] = [];
            try {
              const m = JSON.parse(readFileSync(manifestPath, "utf8"));
              allNames = Object.keys(m.tools || {});
            } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
            for (const [k, v] of Object.entries(sessOv)) {
              const i = lower.indexOf(k.toLowerCase());
              if (v === true && i < 0) {
                // 启用：只加 manifest 声明的工具（防污染 activeTools）
                const canon = allNames.find((n) => n.toLowerCase() === k.toLowerCase());
                if (canon) out.push(canon);
              } else if (v === false && i >= 0) {
                out.splice(i, 1);
              }
            }
            pi.setActiveTools(out);
          }
        }
      } catch (e) { logerr("K025", e); }
    }

    // ── 启动硬检查：manifest 声明但未注入的工具 → throw Error ──
    if (role === "main") {
      try {
        const manifestPath = resolve(DIRS.core, "spirit.bio.gene/tools.manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const tools = manifest.tools || {};
        const expected = Object.entries(tools)
          .filter(([_, v]: [string, any]) => v.default && !v.abandoned)
          .map(([k]) => k);
        const settingsPath = userFile("settings.json");
        let disabled: string[] = [];
        if (existsSync(settingsPath)) {
          disabled = JSON.parse(readFileSync(settingsPath, "utf8"))?.tools?.disabled || [];
        }
        const active = pi.getActiveTools().map((t: string) => t.toLowerCase());
        const activeOrig = pi.getActiveTools();
        // WARN: 大小写不一致
        for (const t of expected) {
          if (!active.includes(t.toLowerCase())) continue;
          const orig = activeOrig.find((a: string) => a.toLowerCase() === t.toLowerCase());
          if (orig !== t) console.warn(`[K022] 工具名大小写不一致: manifest="${t}" vs 注册="${orig}"，已容错匹配`);
        }
        const missing = expected.filter((t: string) => !disabled.includes(t.toLowerCase()) && !active.includes(t.toLowerCase()));
        if (missing.length > 0) {
          const msg = `[K020] 工具未注入: ${missing.join(", ")}。manifest 声明 default:true 且未被 settings 禁用，但未注入。检查对应 func 是否在 export default 顶层调用了 registerPaimonTool。`;
          logerr("K020", msg);
          throw new Error(msg);
        }
      } catch (e: any) {
        if (e?.message?.includes("[K020]")) throw e;
        logerr("K021", e);
      }
    }

    // 角色和 id 都从 session 文件路径推出来 —— 路径是启动时 --session-dir 定死的，
    // 模型运行中改不了它，也没有任何改 process.title 的工具，所以【不可伪造】。
    // 不设角色的 env 覆盖（避免被人/模型用环境变量假冒角色）。
    // 结果：ps / pgrep 里直接显示 teyvat:<role>:<id>，杀进程可精确定位、绝不误伤工作进程。
    //   例：pgrep -fl "teyvat:hippocampus"   只列海马体小号
    const id = sf?.match(/(?:\.teyvat\/SessionData|\.teyvat\/sessions|\.pi\/memory)\/([a-f0-9]+)\//)?.[1] ?? "unknown";
    const sid = sf?.split("/").pop()?.replace(".jsonl","").slice(-12) || "?";
    try { process.title = `genshin:${process.env.PAIMON_AGENT_NAME || id}(${role},${id},${sid})`; } catch (e) { logerr("K010", e); }
    // 启动版本记录
    try {
      const verPath = join(homedir(), ".teyvat/agent/version.json");
      if (existsSync(verPath)) {
        const ver = JSON.parse(readFileSync(verPath, "utf8"));
        const logDir = join(homedir(), ".teyvat/LogData", id);
        mkdirSync(logDir, { recursive: true });
        appendFileSync(join(logDir, "startup.log"), JSON.stringify({ ts: new Date().toISOString(), genshin: ver.genshin, pi: ver.pi, channel: ver.channel || "minutely", role }) + "\n");
        // session 生命周期 start 事件（sessions.log，与 status @history 配套）
        // 启动原因：PI_ALIVE_WOKE=1（launcher self-reboot 拉起）或 reason 文件存在 = 自行重启；否则正常启动
        // （heart.ts 会消费并 unlink reason 文件，可能先于此处执行——所以环境变量才是可靠信号）
        let startReason = process.env.PI_ALIVE_WOKE === "1" ? "self-reboot" : "startup";
        if (startReason === "startup") {
          try {
            const rp = join(homedir(), ".teyvat/RuntimeCache", id, "self-reboot-reason.json");
            if (existsSync(rp)) startReason = "self-reboot";
          } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
        }
        appendFileSync(join(logDir, "sessions.log"), JSON.stringify({ type: "start", ts: new Date().toISOString(), genshin: ver.genshin, channel: ver.channel || "minutely", role, reason: startReason }) + "\n");
        (globalThis as any).__genshinSessStartedAt = Date.now();
      }
    } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
    // 全局路径——所有代码从这里读，不再解析路径
    try {
      global.__genshinPersonId = id;
      global.__genshinPersonName = process.env.PAIMON_AGENT_NAME || id;
      global.__genshinPersonDir = join(homedir(), ".teyvat/MemoryData", id);
      global.__genshinRuntimeDir = join(homedir(), ".teyvat/RuntimeCache", id);
      try { mkdirSync(global.__genshinRuntimeDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
      global.__genshinChannelDir = join(homedir(), ".teyvat/RuntimeCache", id);
      global.__genshinSessionDir = join(homedir(), ".teyvat/SessionData", id);
      global.__genshinAgentFileDir = join(homedir(), ".teyvat/AgentFileData", id);
      // 2026-08-20 工作目录启动自动创建（frontierLM 新需求）：每个 agent 启动时确保
      // AgentWorkDir/Individual/<id> 存在（fileacts 的 isOwnWorkDir 依赖它判断自由区）。
      global.__genshinAgentWorkDir = join(homedir(), ".teyvat/AgentWorkDir/Individual", id);
      try { mkdirSync(global.__genshinAgentWorkDir, { recursive: true }); } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
      // 读取用户语言偏好
      try {
        const settingsPath = userFile("settings.json");
        if (existsSync(settingsPath)) {
          const s = JSON.parse(readFileSync(settingsPath, "utf8"));
          global.__genshinLang = s.lang === "zh" ? "zh" : "en";
        }
      } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); global.__genshinLang = "en"; }
    } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }

    // 更新 lastSeen——重新读文件拿最新 archived 状态，已归档的不碰
    try {
      const plistPath = join(homedir(), ".teyvat/MemoryData/plist.json");
      const freshList = JSON.parse(readFileSync(plistPath, "utf8"));
      const p = freshList.find((x: any) => x.id === id);
      if (p && !p.archived) { p.lastSeen = new Date().toISOString(); writeFileSync(plistPath, JSON.stringify(freshList, null, 2)); }
    } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }

    // 心跳文件：每 30s 更新一次，hc/sc session 用它检测主意识是否存活（替代 PID 看门狗）
    // 不再写 heartbeat 文件——sc/hc 用 kill -0 检测主进程

    // 启动回顾由心跳的 recap 负责（continuous-resume，见 heartbeat.ts）。旧的 greeting 已弃用移除。

    // ── UBI 发放 —— dollar 系统已冷冻至 @FUTURE.,整块禁用 ──
    // if (role === "main" && id !== "unknown" && process.env.PI_DISABLE_UBI !== "1") {
    //   const personDir = global.__genshinPersonDir;
    //   try {
    //     const ubi = checkAndPayUbi(personDir);
    //     if (ubi.paid) {
    //       try { sendCustomMessage(pi, "ubi-paid", `UBI: +$${ubi.amount}`); } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
    //     }
    //   } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
    // }

    // ── 已知外部问题：macOS 自带 Terminal.app 闪退（见 Issues.DEV/012）──────────────
    // Terminal.app 的渲染层(NSView/QuartzCore)在重 TUI(高频重绘+emoji+真彩)下会段错误崩溃——
    // 是 Terminal 自己的 bug，pi 修不了。检测到用默认终端就提示换重型终端。仅主意识、仅启动时一次。
    if (role === "main" && process.env.TERM_PROGRAM === "Apple_Terminal") {
      try {
        ctx.ui?.notify?.(
          "WARN: 你在用 macOS 自带 Terminal.app —— 重 TUI 下它会偶发闪退(渲染层段错误，是 Terminal 自己的 bug，不是 pi)。\n" +
          "建议换更结实的终端：Ghostty / WezTerm / kitty / iTerm2(GPU 渲染，扛得住高频重绘+真彩)。\n" +
          "(若靠 Terminal.app 给麦克风/TCC 授权，换终端后记得给新终端重授一遍。)",
          "warning"
        );
      } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
    }

    // ── 部署检测：已移除（2026-09-11 prime-agent）──
    // 原实现在 IS_DEV 下探测 `Codebase/core/spirit.bio.organs` —— 那是 Continents 重构**之前**的路径
    // （现在源码树是 A.core/ + C.deploy/），而且算出来的 devRoot 在函数里**从未被使用**：
    // 死代码 + 过期路径，双份误导（后来人会以为存在部署检测机制）。真要恢复的话，路径按当前布局
    // （A.core/spirit.bio.organs）判断，并且必须真正消费这个值。

    // ── 反方向健康检查：主意识定时监控 hc/sc 是否存活 ──
    if (role === "main") {
      // session_start 可能重复触发（reload/rebind），先清旧 interval，否则堆积后 execSync 会磨死事件循环
      try { clearInterval((globalThis as any).__genshinHealthInterval); } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
      const _hcInterval = setInterval(() => {
        try {
          const h = (globalThis as any).__genshinHippocampusHandle;
          if (h && !h.isRunning()) { h.start().catch(() => {}); }
          const s = (globalThis as any).__genshinMetaconsciousnessHandle;
          if (s && !s.isRunning()) { s.start().catch(() => {}); }
        } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
      }, 30000);
      (globalThis as any).__genshinHealthInterval = _hcInterval;
    }
  });

  // ── session_shutdown：写 lastEnded + 清理健康检查 ──
  pi.on("session_shutdown", async () => {
    // 清理健康检查定时器
    try { const hi = (globalThis as any).__genshinHealthInterval; if (hi) clearInterval(hi); } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
    try {
      const id = (globalThis as any).__genshinPersonId;
      if (id) {
        const plistPath = join(homedir(), ".teyvat/MemoryData/plist.json");
        const freshList = JSON.parse(readFileSync(plistPath, "utf8"));
        const p = freshList.find((x: any) => x.id === id);
        if (p && !p.archived) { p.lastEnded = new Date().toISOString(); writeFileSync(plistPath, JSON.stringify(freshList, null, 2)); }
      }
    } catch (e) { console.error("[spirit.bio.organs/kernel.core/core.ts] " + ((e as any)?.message || e)); }
  });

  // ── Commands — god 层注册用户命令，headless 模式(PAIMON_HEADLESS=1)跳过 ──
  if (!process.env.PAIMON_HEADLESS) registerGodCommands(pi);
}
