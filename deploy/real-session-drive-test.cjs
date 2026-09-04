#!/usr/bin/env node
// real-session-drive-test.cjs — ISSUE 073 真实数据 + 真实 API 实验
// 用户定稿：不用模拟，用真实历史 session + 项目一致（deepseek models.json 配置）验证自驱标记。
// 方法：取真实 session 里每次 continuous-next（续命）注入点**之前**的真实回合上下文（最后 3 条 message），
//       转 API 格式 + system 续命约定（"回合结束想继续就输出『我继续，<短目标>』"），重放给 deepseek，
//       检查模型在真实场景下回合结束时是否可靠输出"我继续，"标记。
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const sessionDir = path.join(HOME, ".teyvat/SessionData/af5c5269");
const sessions = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl")).sort().reverse();
console.log(`扫描 ${sessions.length} 个真实 session（跨全部历史续命点）`);

// 读 models.json 拿 deepseek 配置（不打印 key）
const mm = JSON.parse(fs.readFileSync(path.join(HOME, ".teyvat/agent/models.json"), "utf8"));
const ds = mm.providers["deepseek"];
if (!ds) { console.log("无 deepseek provider"); process.exit(1); }
const BASE = ds.baseUrl + (ds.baseUrl.endsWith("/v1") ? "" : "/v1");
const MODEL = process.argv[2] || "deepseek-v4-flash";

// 扫描所有 session 收集 continuous-next 注入点（跨全部历史）
const cnIdx = []; // {file, line}
for (const f of sessions) {
  const lines = fs.readFileSync(path.join(sessionDir, f), "utf8").split("\n").filter(Boolean);
  lines.forEach((l, i) => { try { const o = JSON.parse(l); if (o.type === "custom_message" && o.customType === "continuous-next") cnIdx.push({ f, i, o }); } catch {} });
}
console.log(`continuous-next 注入点: ${cnIdx.length} 个（真实续命场景，跨 ${sessions.length} 个 session）`);
function toApi(m) {
  const role = m?.message?.role;
  if (!role) return null;
  // tool 结果消息：过滤（assistant 的 toolCall 已文本化，实验只需回合语义）
  if (role === "toolResult" || role === "tool") return null;
  const content = (m.message.content || []).filter(c => c.type !== "thinking");
  const parts = content.map(c => {
    if (c.type === "text") return c.text;
    if (c.type === "toolCall") return `[调用工具 ${c.name}]`;
    if (c.type === "toolResult") return `[工具结果] ${String(c.result ?? "").slice(0, 120)}`;
    return "";
  }).filter(Boolean);
  if (parts.length === 0) return null;
  return { role, content: parts.join("\n") };
}

// 每个 CN 点：取它前面最后 3 条真实 message 作为上下文 → 重放
const SYSTEM = `你是 genshin agent（teyvat 框架）。回合结束时**必须且只能在正式回复（思考之外的实际输出）输出以下三者之一**：\n【我继续，<下回合短目标>】——想继续干活\n【wait】——暂时等待\n【hibernate】——休眠\n不允许输出其他内容，不允许只在思考里决定。`;
const MAX_CN = Math.min(cnIdx.length, 5); // 最多测 5 个真实场景（控制成本）
let marked = 0, parsed = 0, ok = 0, errs = 0;

(async () => {
for (let k = 0; k < MAX_CN; k++) {
  const { f, i, o } = cnIdx[k];
  // 读该 session 全部记录
  const recs = fs.readFileSync(path.join(sessionDir, f), "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // 收集 CN 点之前的 message（最多 3 条）
  const msgs = [];
  for (let j = i - 1; j >= 0 && msgs.length < 3; j--) {
    if (recs[j].type === "message") { const api = toApi(recs[j]); if (api) msgs.unshift(api); }
  }
  if (msgs.length === 0) continue;
  // 真实意图栈（CN 的 content 就是意图栈全文，取前 200 字做上下文提示）
  const intent = (o.content || "").slice(0, 200);

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM },
      ...msgs,
      { role: "user", content: `（真实意图栈）${intent}\n回合结束。按规则决定下一步：继续则输出【我继续，<短目标>】，否则输出 wait/hibernate。` },
    ],
    max_tokens: 20000, // 对齐项目真实配置（models.json maxTokens=384000）；800 不够 thinking 吃
    temperature: 0.3,
  };
  try {
    const res = await fetch(BASE + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ds.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.log(`场景${k + 1}: API ${res.status} ${(await res.text()).slice(0, 120)}`); errs++; continue; }
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    const out = msg.content || ""; // 只从正式 content 提取（不拼 reasoning——避免污染）
    const reasoning = msg.reasoning_content || "";
    // 诊断：content 空时看 reasoning_content（deepseek reasoning 模型 content 可能在 thinking 里）
    const tail = out.trim().split("\n").pop() || "";
    const hasMark = out.includes("我继续");
    const m = out.match(/我继续[，,:：]\s*(.{1,60})/);
    if (k < 2) console.log(`场景${k + 1}: content=${out.length}字 reasoning=${reasoning.length}字 | keys=${Object.keys(msg).join(",")}`);
    if (hasMark) {
      marked++;
      console.log(`场景${k + 1}: ✅ 输出标记 | 末尾: "${tail.slice(0, 60)}"`);
      if (m) { parsed++; console.log(`       提取目标: "${m[1].slice(0, 40)}"`); }
    } else {
      console.log(`场景${k + 1}: ❌ 无标记 | 末尾: "${tail.slice(0, 60)}"`);
    }
    ok++;
  } catch (e) { console.log(`场景${k + 1}: 请求错误 ${e.message}`); errs++; }
}

console.log("\n═══ 真实实验统计（deepseek " + MODEL + "）═══");
console.log(`测试场景: ${MAX_CN} 个（真实续命点）| 成功请求: ${ok} | 错误: ${errs}`);
console.log(`标记输出率: ${marked}/${ok} (${ok ? Math.round(marked / ok * 100) : 0}%)`);
console.log(`可解析目标率: ${parsed}/${ok} (${ok ? Math.round(parsed / ok * 100) : 0}%)`);
})().catch(e => { console.error("实验失败:", e.message); process.exit(1); });
