// agent-stats.cjs — agent 列表统计（磁盘大小 + 记忆 token）的共享计算/缓存
// 运行方：主进程（kernel.heart 心跳，每 ~5 分钟 + 启动后首刷 + shutdown 终刷）计算并写入
//         ~/.teyvat/RuntimeCache/<id>/list-stats.json
// 查询方：list.cjs 只读缓存（缺失才现算——离线从未写过的 agent）
// 计算逻辑只此一份，list.cjs 与 heart.ts 共用（2026-08-13 用户要求：运行时实时运算储存，查询时获取即可）
const fs = require("fs");
const path = require("path");

function dirSize(dir) {
  let total = 0;
  // 2026-08-20：目录可能不存在（AgentFileData/MonitorData/BlackboxData 等只对特定 agent 创建）——
  // 不检查会 readdirSync ENOENT（console-error.log 实测：.31 后暴露，heart.ts statsDir 修复后轮到它）
  if (!fs.existsSync(dir)) return 0;
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else try { total += fs.statSync(fp).size; } catch (e) { console.error("[god.frontend.cli/agent-stats.cjs] " + (e?.message || e)); }
      }
    };
    walk(dir);
  } catch (e) { console.error("[god.frontend.cli/agent-stats.cjs] " + (e?.message || e)); }
  return total;
}

function estTokens(t) {
  let cjk = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return Math.round(cjk * 1.8 + (t.length - cjk) * 0.25);
}

/** 计算单个 agent 的列表统计（重活：逐文件走目录 + 全文估 token，只在运行时/离线兜底时跑） */
function computeAgentStats(home, memDir, id) {
  const md = path.join(memDir, id);
  const memSize = dirSize(md);
  let totalSize = memSize;
  for (const sub of ["SessionData", "AgentFileData", "MonitorData", "BlackboxData", "RuntimeCache", "IdentityData", "ErrorData", "AgentWorkDir/Individual"]) {
    totalSize += dirSize(path.join(path.dirname(memDir), sub, id));
  }
  const readFile = (f) => { try { return fs.readFileSync(path.join(md, f), "utf8"); } catch { return ""; } };
  const ctxTokens = estTokens(readFile("context.md"));
  const workTokens = estTokens(readFile("work_memory.md"));
  const neoTokens = estTokens(readFile("neocortex.md"));
  const memoir = fs.existsSync(path.join(home, "MemoirData", id + ".MEMOIR"));
  return { memSize, totalSize, ctxTokens, workTokens, neoTokens, memoir, updatedAt: Date.now() };
}

function statsPath(home, id) {
  return path.join(home, "RuntimeCache", id, "list-stats.json");
}

function writeStats(home, id, s) {
  try {
    const p = statsPath(home, id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s));
  } catch (e) { console.error("[god.frontend.cli/agent-stats.cjs] " + (e?.message || e)); }
}

function readStats(home, id) {
  try { return JSON.parse(fs.readFileSync(statsPath(home, id), "utf8")); } catch { return null; }
}

module.exports = { computeAgentStats, writeStats, readStats, estTokens, dirSize };
