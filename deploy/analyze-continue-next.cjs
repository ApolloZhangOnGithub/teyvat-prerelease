#!/usr/bin/env node
// analyze-continue-next.cjs — ISSUE 073 研究：统计历史 session 的 continuous-next 消息（context 浪费量化）
// 只读 ~/.teyvat/SessionData/，不改代码、不动 agent。
const fs = require("fs");
const path = require("path");

const SD = path.join(require("os").homedir(), ".teyvat", "SessionData");
if (!fs.existsSync(SD)) { console.log("无 SessionData"); process.exit(0); }

const agents = fs.readdirSync(SD).filter(d => /^[a-f0-9]{8}$/.test(d));
let totalMsgs = 0, totalChars = 0, maxChain = 0, maxChainAgent = "";
let agentStats = [];
let sampleMsgs = [];

for (const aid of agents) {
  const dir = path.join(SD, aid);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")) : [];
  let cnt = 0, chars = 0, chain = 0, chainMax = 0;
  let lastTs = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln);
        if (o.type === "custom_message" && o.customType === "continuous-next") {
          cnt++; chars += (o.content || "").length;
          // 连续续命链：同 session 内相邻两条间隔 < 5min 算同一链
          const ts = new Date(o.timestamp || 0).getTime();
          if (ts - lastTs < 300000) chain++; else chain = 1;
          lastTs = ts;
          if (chain > chainMax) chainMax = chain;
          if (sampleMsgs.length < 3) sampleMsgs.push({ aid, content: (o.content || "").slice(0, 60) });
        }
      } catch {}
    }
  }
  totalMsgs += cnt; totalChars += chars;
  if (chainMax > maxChain) { maxChain = chainMax; maxChainAgent = aid; }
  if (cnt > 0) agentStats.push({ aid, sessions: files.length, cnt, chars, chainMax });
}

agentStats.sort((a, b) => b.cnt - a.cnt);
console.log("═══ continuous-next 历史数据分析（ISSUE 073）═══");
console.log(`agent 数: ${agents.length} | 有续命的 agent: ${agentStats.length}`);
console.log(`continuous-next 总条数: ${totalMsgs}`);
console.log(`注入文本总字符: ${totalChars.toLocaleString()} chars（≈${Math.round(totalChars / 3.5).toLocaleString()} tokens）`);
console.log(`最长连续续命链: ${maxChain} 条（agent ${maxChainAgent}）`);
console.log("");
console.log("── 各 agent 明细（按条数排序）──");
for (const s of agentStats.slice(0, 12)) {
  console.log(`  ${s.aid}: ${s.cnt} 条 / ${s.chars.toLocaleString()} chars / 最长链 ${s.chainMax} / sessions ${s.sessions}`);
}
console.log("");
console.log(`── 自驱式对比估算 ──`);
console.log(`注入式: ${totalChars.toLocaleString()} chars（意图栈全文重复注入）`);
const selfDriven = totalMsgs * 30; // "我继续，<短目标>" 约 20-40 字符
console.log(`自驱式: ≈${selfDriven.toLocaleString()} chars（"我继续，XXX" 每条约 30 字符）`);
console.log(`节省: ${(totalChars - selfDriven).toLocaleString()} chars ≈ ${Math.round((totalChars - selfDriven) / 3.5).toLocaleString()} tokens`);
console.log("");
console.log("── 样例（前 3 条 content 开头）──");
for (const s of sampleMsgs) console.log(`  [${s.aid}] ${s.content}...`);
