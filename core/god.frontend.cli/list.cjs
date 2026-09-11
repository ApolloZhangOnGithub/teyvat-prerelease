// list.cjs — 共享的 agent 列表渲染
// 用法: node list.cjs <plist.json> <memoryDir> <lang> <filter>
//   filter: "active" (非归档) | "archived" (已归档)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { homedir } = require('os');

const PLIST = process.argv[2];
const MEM_DIR = process.argv[3];
const lang = process.argv[4] || 'en';
const filter = process.argv[5] || 'list'; // list=agents only, active=agents+help(legacy), help=usage only
const zh = lang === 'zh';

// ── Codeforces 风格履历段位（共享自 cf-rank.cjs）──
// ⚠️ 注意：genshin 默认列表走本文件（list.cjs），不是 cli.ts！改 cli.ts 列表不生效（别的 agent 踩过多次）。
// 阈值/颜色改 cf-rank.cjs（单一真相源）。
const { getCfRank, cfPaint } = require('./cf-rank.cjs');

// 路径从环境变量读取（launcher.sh export）
const PAIMON_HOME = process.env.PAIMON_HOME || (homedir() + '/.teyvat');
const PAIMON_CONFIG = process.env.PAIMON_CONFIG || (PAIMON_HOME + '/config');

// developer mode
let devMode = false;
try {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(PAIMON_CONFIG, 'settings.json'), 'utf8')); } catch (e) { if (e && e.code !== 'ENOENT') console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
  devMode = !!s.developerMode;
} catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
try { const v = JSON.parse(fs.readFileSync(path.join(PAIMON_HOME, 'agent/version.json'), 'utf8')); if (v.genshin && v.genshin.includes('-dev.')) devMode = true; } catch (e) { if (e && e.code !== 'ENOENT') console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
// detail mode (-D flag)
const detailMode = !!process.env.PAIMON_DETAIL;

const Y = '\x1b[33m', G = '\x1b[32m', D = '\x1b[90m', C = '\x1b[36m', M = '\x1b[35m', R = '\x1b[0m', BOLD = '\x1b[1m', RED = '\x1b[31m', YLW = '\x1b[33m';
// 2026-09-07（用户：light 白底 logo 消失）：logo 纯 BOLD 无色 → 用终端默认前景色，白底下浅色字不可见。
// 按 settings theme 给 logo 固定颜色：dark → 白亮粗体；light → 深色粗体（黑），两端都可见。
let LOGO_FG = '\x1b[97m'; // dark 默认：亮白
{
  try {
    const s = JSON.parse(fs.readFileSync(path.join(PAIMON_CONFIG, 'settings.json'), 'utf8'));
    if (s && s.theme === 'light') LOGO_FG = '\x1b[30m'; // light：黑
  } catch (e) { /* settings 缺失/损坏 → 保持 dark 默认 */ }
}
const LOGO = LOGO_FG + BOLD;
const KIND_COLORS = { 'coding-agent': M, 'coding': M };

const { pad, lpad, vw } = require(path.join(__dirname, 'pad.cjs'));
const { computeAgentStats, readStats, estTokens } = require(path.join(__dirname, 'agent-stats.cjs'));

function fmtSizeRaw(b) {
  const mb = b / 1024 / 1024;
  if (mb < 0.01) return '  —     ';
  return mb.toFixed(2).padStart(7) + ' MB';
}
function fmtSizeColor(b) {
  const mb = b / 1024 / 1024;
  const raw = fmtSizeRaw(b);
  if (mb < 0.01) return D + raw + R;
  if (mb < 10) return '\x1b[32m' + raw + R;    // green
  if (mb < 100) return '\x1b[33m' + raw + R;   // yellow
  return '\x1b[31m' + raw + R;                  // red
}
function fmtColor(b, text) {
  const mb = b / 1024 / 1024;
  if (mb < 0.01) return D + text + R;
  if (mb < 10) return '\x1b[32m' + text + R;
  if (mb < 100) return '\x1b[33m' + text + R;
  return '\x1b[31m' + text + R;
}

const allList = JSON.parse(fs.readFileSync(PLIST, 'utf8'));
const list = filter === 'help' ? [] : allList.filter(filter === 'archived' ? (p => p.archived) : (p => !p.archived));

if (!list.length && filter !== 'help') {
  if (zh) {
    console.log('');
    console.log('  还没有 agent。');
    console.log('');
    console.log('  创建: genshin <名字>');
    console.log('  示例: genshin alice_' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
    console.log('');
    console.log('  更多: genshin -h');
    console.log('');
  } else {
    console.log('');
    console.log('  No agents yet.');
    console.log('');
    console.log('  Create: genshin <name>');
    console.log('  Example: genshin alice');
    console.log('');
    console.log('  More: genshin -h');
    console.log('');
  }
  process.exit(0);
}

const now = Date.now();
// 活动检测：main.pid + kill -0（heart 每 30s futimes 心跳；90s 内触碰且进程存在 = 活跃）。
// 2026-08-14 提速：替代 execSync('ps aux')（单次 ~0.23s）；低频命令仍走 pad.cjs 的 computeAndSort。
for (const p of list) {
  let active = false;
  try {
    const pf = PAIMON_HOME + '/MemoryData/' + p.id + '/main.pid';
    const st = fs.statSync(pf);
    if (now - st.mtimeMs <= 90_000) {
      const pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
      if (pid) { process.kill(pid, 0); active = true; }
    }
  } catch { /* 无 pid 文件/进程不存在 */ }
  p._active = active;
  p._ago = Math.round((now - new Date(p.lastEnded || p.lastSeen).getTime()) / 60000);
  // 2026-08-20 用户需求：先 F（前台 TUI）后 B（后台 headless）——detached 标记存在 = 后台
  p._fb = active && fs.existsSync(PAIMON_HOME + '/RuntimeCache/' + p.id + '/detached') ? 1 : 0;
}
// 排序：active > offline，同为 active 时 F > B，最后按 ago
// 注意：不要改排序顺序——launcher 的 _resolve_active_arg 依赖与此一致的序号
list.sort((a, b) => (b._active ? 1 : 0) - (a._active ? 1 : 0) || (a._fb || 0) - (b._fb || 0) || a._ago - b._ago);
// 排序结果落盘（原 launcher 里第二个 node 子进程做的事，2026-08-14 收拢进来，省一次 node + ps 开销）
if (filter === 'list') {
  try {
    const d = PAIMON_HOME + '/RuntimeCache';
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(d + '/genshin-order-last.json', JSON.stringify(list.map(p => p.id)));
  } catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
}
  // 列表统计（磁盘大小 + 记忆 token）：优先读运行时缓存的 list-stats.json
  // （主进程 kernel.heart 心跳每 ~5 分钟维护 + 启动首刷 + shutdown 终刷），
  // 缺失才现算（离线从未写过的 agent）。查询只读缓存 = 瞬时（2026-08-13 用户要求）。
  const { writeStats } = require(path.join(__dirname, 'agent-stats.cjs'));
  for (const p of list) {
    let s = readStats(PAIMON_HOME, p.id);
    if (!s) {
      s = computeAgentStats(PAIMON_HOME, MEM_DIR, p.id);
      writeStats(PAIMON_HOME, p.id, s); // 兜底现算后写回缓存，下次查询即只读
    }
    p._memSize = s.memSize ?? 0;
    p._size = s.totalSize ?? 0;
    p._memoir = !!s.memoir;
    p._ctxTokens = s.ctxTokens ?? 0;
    p._workTokens = s.workTokens ?? 0;
    p._neoTokens = s.neoTokens ?? 0;
    p._totalTokens = (s.ctxTokens ?? 0) + (s.workTokens ?? 0) + (s.neoTokens ?? 0);
    // RSI-001: 辈分 + 社会资历
    p._age = '';
    try {
      const md = path.join(MEM_DIR, p.id);
      const bp = path.join(md, 'birth.json');
      let bts = 0;
      if (fs.existsSync(bp)) { bts = JSON.parse(fs.readFileSync(bp, 'utf8')).birth_ts || 0; }
      else { try { bts = fs.statSync(md).birthtimeMs || 0; } catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); } if (bts) { try { fs.writeFileSync(bp, JSON.stringify({ birth_ts: bts, created: new Date(bts).toISOString(), source: 'dir_birthtime' })); } catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); } } }
      if (bts) {
        const ms = now - bts, h = ms / 3600000, d = ms / 86400000;
        if (h < 1) p._age = Math.floor(ms / 60000) + 'm';
        else if (d < 1) p._age = h.toFixed(1) + 'h';
        else if (d < 7) p._age = d.toFixed(1) + 'd';
        else if (d < 30) p._age = (d / 7).toFixed(1) + 'w';
        else if (d < 365) p._age = (d / 30.44).toFixed(1) + 'mo';
        else p._age = (d / 365.25).toFixed(1) + 'y';
      }
    } catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
    p._tokenmaxxed = '';
    if (!p.archived) {
      try {
        const md = path.join(MEM_DIR, p.id);
        const pp = path.join(md, 'tokenmaxxed.json');
        let pt = 0;
        if (fs.existsSync(pp)) { pt = JSON.parse(fs.readFileSync(pp, 'utf8')).tokenmaxxed || 0; }
        // tokenmaxxed.json 只由运行时 session_shutdown 写入，不在这里补算
        if (pt > 0) {
          const rk = getCfRank(pt);
          p._tokenmaxxed = pt < 1000 ? pt + '' : pt < 1e6 ? (pt / 1000).toFixed(1) + 'k' : (pt / 1e6).toFixed(1) + 'M';
          // 2026-08-15 用户：履历栏不需要写称号（段位名），染色就行——暂时注释掉，要恢复取消下面这行
          // p._tokenmaxxed = rk.name + ' ' + p._tokenmaxxed;
          p._tokenmaxxedHex = rk.hex;
        }
      } catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
    }
  }

const L_NAME = zh ? '名称' : 'NAME';
const L_KIND = zh ? '类型' : 'KIND';
const L_ID = 'ID';
const L_ORG = zh ? '组织' : 'ORG';
const L_MEMOIR = zh ? '回忆录' : 'MEMOIR';
const L_DISK = zh ? '磁盘（记忆/总计）' : 'DISK (MEM/TOTAL)';
const L_HOST = zh ? '主机' : 'HOST';
const L_STATUS = zh ? '状态' : 'STATUS';
const L_AGE = zh ? '年龄' : 'AGE';
const L_POND = zh ? '履历' : 'EXP';

let orgMap = {};
try { const orgs = JSON.parse(fs.readFileSync(path.join(PAIMON_HOME, 'AgentWorkDir', 'Organizational', 'orgs.json'), 'utf8')); for (const o of orgs) orgMap[o.id] = o.name; } catch (e) { if (e && e.code !== 'ENOENT') console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
for (const p of list) {
  const ids = Array.isArray(p.orgs) ? p.orgs : (p.org ? [p.org] : []);
  p._orgName = ids.length > 0 ? ids.map(id => orgMap[id] || id).join(', ') : '/';
}

const hostW = detailMode ? Math.max(vw(L_HOST), ...list.map(p => vw(p.hostname || (zh ? '本机' : 'local')))) : 0;
const idW = Math.max(vw(L_ID), ...list.map(p => vw(p.id)));
const orgW = Math.max(vw(L_ORG), ...list.map(p => vw(p._orgName)));

const nw = Math.max(vw(L_NAME) + 2, ...list.map(p => vw(p.name))) + 2;
const shortKind = (k) => k === 'coding-agent' ? 'coding' : (k || 'coding-agent'); // chatbot deprecated
const kw = Math.max(vw(L_KIND) + 2, ...list.map(p => vw(shortKind(p.kind)))) + 2;
const diskStrs = list.map(p => ({
  mem: fmtSizeRaw(p._memSize).trim(),
  total: fmtSizeRaw(p._size).trim()
}));
const memW = Math.max(...diskStrs.map(d => vw(d.mem)));
const totW = Math.max(...diskStrs.map(d => vw(d.total)));
const diskDisplay = list.map((_p, i) => {
  const m = ' '.repeat(memW - vw(diskStrs[i].mem)) + diskStrs[i].mem;
  const t = ' '.repeat(totW - vw(diskStrs[i].total)) + diskStrs[i].total;
  return { raw: m + ' / ' + t, mem: m, total: t };
});
const ageW = Math.max(vw(L_AGE), ...list.map(p => vw(p._age || '')));
const pondW = Math.max(vw(L_POND), ...list.map(p => vw(p._tokenmaxxed || '')));
const numW = String(list.length).length;
const hdr = ' '.repeat(numW + 2 + 1); // number + '. ' + trailing space

const title = filter === 'help'
  ? '  ' + LOGO + 'Teyvat' + R + D + ' ' + (zh ? '用法' : 'usage') + R
  : filter === 'archived'
  ? '  ' + LOGO + 'Teyvat' + R + D + ' · ' + list.length + (zh ? ' 已归档' : ' archived') + R
  : '  ' + LOGO + 'Teyvat' + R + D + ' · ' + list.length + ' agent' + (list.length === 1 ? '' : 's') + R
    + (() => { try { const v = JSON.parse(fs.readFileSync(PAIMON_HOME + '/agent/version.json', 'utf8')); const dv = (v.channel === 'prerelease' && v.pinnedDev) ? v.pinnedDev : v.genshin; return D + '  v' + dv + ' (' + v.channel + ')' + R; } catch(e) { try { fs.mkdirSync(PAIMON_HOME + '/LogData', { recursive: true }); fs.appendFileSync(PAIMON_HOME + '/LogData/genshin-list-error.log', 'version display: ' + (e?.message||e) + '\n'); } catch(_) { /* 日志写入失败不阻塞列表 */ } return ''; } })();

const statusStrs = list.map(p => {
  let tag = '', time = '';
  if (p._active) {
    const rc = `${PAIMON_HOME}/RuntimeCache/${p.id}`;
    try {
      if (fs.existsSync(`${PAIMON_HOME}/MemoryData/${p.id}/paused`) || fs.existsSync(`${rc}/paused`)) tag = '[P]';
      else if (fs.existsSync(`${rc}/main-resting`)) tag = '[W]';
      else if (fs.existsSync(`${rc}/main-hibernate`)) tag = '[H]';
      else tag = '[A]';
      // 2026-08-20 用户需求：前台/后台（TUI vs headless）——detached 标记存在 = 后台 [B]，否则前台 [F]
      tag += fs.existsSync(`${rc}/detached`) ? ' [B]' : ' [F]';
    } catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
    const secs = Math.round((now - new Date(p.lastSeen).getTime()) / 1000);
    if (secs < 5) time = zh ? '刚刚' : 'just now';
    else if (secs < 60) time = zh ? `${secs}秒` : `${secs}s`;
    else {
      const mins = Math.floor(secs / 60);
      if (mins < 60) time = zh ? `${mins}分钟` : `${mins}m`;
      else {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h < 24) time = zh ? `${h}小时${m > 0 ? m + '分钟' : ''}` : `${h}h${m > 0 ? ' ' + m + 'm' : ''}`;
        else {
          const d = Math.floor(h / 24);
          const rh = h % 24;
          if (rh > 0) time = zh ? `${d}天${rh}小时` : `${d}d ${rh}h`;
          else if (m > 0) time = zh ? `${d}天${m}分钟` : `${d}d ${m}m`;
          else time = zh ? `${d}天` : `${d}d`;
        }
      }
    }
    return { tag, time };
  }
  // 离线
  const endTs = p.lastEnded || p.lastSeen;
  if (!endTs) time = zh ? '从未启动' : 'not started';
  else {
    const secs2 = Math.round((now - new Date(endTs).getTime()) / 1000);
    if (secs2 < 5) time = zh ? '刚刚' : 'just now';
    else if (secs2 < 60) time = zh ? `${secs2}秒前` : `${secs2}s ago`;
    else {
      const t = Math.floor(secs2 / 60);
      if (t < 60) time = zh ? `${t}分钟前` : `${t}m ago`;
      else {
        const h = Math.floor(t / 60);
        if (t < 1440) time = zh ? `${h}小时前` : `${h}h ago`;
        else time = zh ? `${Math.floor(h / 24)}天前` : `${Math.floor(h / 24)}d ago`;
      }
    }
  }
  return { tag, time };
});
const activeLabel = '';
// 状态列宽度 = tag + time 整体计算（如 "[A] 2小时36分钟" vs "[O] 1天前"）
const statusFullStrs = statusStrs.map((s, i) => {
  const tag = s.tag ? s.tag + ' ' : '[O]     ';
  return tag + s.time;
});
const tw = Math.max(...statusFullStrs.map(s => vw(s)));

if (filter !== 'help') {
console.log('');
console.log(title);
console.log('');
const showStatus = filter !== 'archived';
const L_STATE = zh ? '运行时长/上次访问' : 'STATUS';
// 2026-09-11：宽度自适应——终端不够宽时按优先级依次隐藏列
const termW = process.stdout.columns || 120;
const baseW = numW + 2 + 1 + nw + tw + 4; // num + '. ' + space + name + status + padding
const showOrg = termW >= baseW + orgW + 2;
const showId = termW >= baseW + (showOrg ? orgW + 2 : 0) + idW + 2;
const showAge = termW >= baseW + (showOrg ? orgW + 2 : 0) + (showId ? idW + 2 : 0) + ageW + 2;
const showPond = termW >= baseW + (showOrg ? orgW + 2 : 0) + (showId ? idW + 2 : 0) + (showAge ? ageW + 2 : 0) + pondW + 2;
const r1Hdr = hdr + pad(L_NAME, nw) + (detailMode ? pad(L_KIND, kw) + ' ' : '') + (showOrg ? pad(L_ORG, orgW) + '  ' : '') + (showId ? pad(L_ID, idW) + '  ' : '') + (showAge ? pad(L_AGE, ageW) + '  ' : '') + (showPond ? pad(L_POND, pondW) : '') + (detailMode ? '  ' + pad(L_MEMOIR, 6) : '') + (detailMode && hostW > 0 ? '  ' + pad(L_HOST, hostW) : '') + (showStatus ? '  ' + L_STATE : '');

let oNum = 1, fNum = 1, bNum = 1; // 分组编号：offline=o / front=f / background=b 各自独立（2026-08-20 用户定稿：管理命令按 1o/1f/1b 路由，不再混编）
// 分页：每 PAGE_SIZE 个 agent 暂停（直接 inline，无死代码）
const PAGE_SIZE = 10;
// 第一遍：收集所有行用于计算宽度
const rows1 = [], rows2 = [];
const savedActive = [];
for (let i = 0; i < list.length; i++) {
  const p = list[i];
  const org = p._orgName;
  const kind = shortKind(p.kind);
  const s = statusStrs[i];
  const statusFull = statusFullStrs[i];
  // 2026-08-20 用户需求（修正）：B（后台 headless）状态区整体用鲸鱼蓝 #718EF4——"绿色有哪些，蓝色就有哪些"（整段 tag+time 蓝，不再只 [B] 单字母）
  // statusColor 与序号同色（下面 numColor 计算后覆盖）
  let statusColor = '';
  let statusReset = R;
  // 2026-09-11 序号颜色重设计：按状态区分
  // [W]/[F] 前台活跃 = 绿 | [P]/[B] 后台 = 蓝 | [H] 休眠 = 黄 | [O] 离线 = 白（默认色）
  let numIdx, numColor;
  if (p._active) {
    if (statusFull.includes('[H]') || statusFull.includes('[P]')) { numColor = Y; numIdx = bNum++; }
    else if (statusFull.includes('[B]')) { numColor = '\x1b[38;2;113;142;244m'; numIdx = bNum++; }
    else { numColor = G; numIdx = fNum++; }
  } else { numColor = '\x1b[37m'; numIdx = oNum++; } // O 离线 = 白色
  statusColor = numColor; // 状态+时间与序号同色
  const num = numColor + String(numIdx).padStart(numW) + '. ' + R;
  const kc = KIND_COLORS[kind] || D;
  const memoir = pad(p._memoir ? '✓' : '✗', 6);
  const ctxWindow = 1000000;
  const pct = ctxWindow > 0 ? ((p._totalTokens / ctxWindow) * 100).toFixed(1) : '0.0';
  const dpct = ctxWindow > 0 ? ((p._ctxTokens / ctxWindow) * 100).toFixed(1) : '0.0';
  const wpct = ctxWindow > 0 && p._workTokens > 0 ? ((p._workTokens / ctxWindow) * 100).toFixed(1) : '0';
  const npct = ctxWindow > 0 && p._neoTokens > 0 ? ((p._neoTokens / ctxWindow) * 100).toFixed(1) : '0';
  const fmtTokShort = (n) => n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n);
  const statusPart = showStatus ? '  ' + statusColor + pad(statusFull, tw) + statusReset : '';
  const host = detailMode ? (p.hostname || (zh ? '本机' : 'local')) : '';
  const ageCol = pad(p._age || '', ageW);
  const pondCol = p._tokenmaxxedHex ? cfPaint(p._tokenmaxxedHex, pad(p._tokenmaxxed || '', pondW)) : pad(p._tokenmaxxed || '', pondW);
  const row1 = '  ' + num + ' ' + pad(p.name, nw) + (detailMode ? kc + pad(kind, kw) + R + ' ' : '') + (showOrg ? pad(org, orgW) + '  ' : '') + (showId ? p.id + ' '.repeat(Math.max(0, idW - vw(p.id))) + '  ' : '') + (showAge ? ageCol + '  ' : '') + (showPond ? pondCol : '') + (detailMode ? '  ' + memoir : '') + (detailMode && hostW > 0 ? '  ' + pad(host, hostW) : '') + statusPart;
  rows1.push(row1);
  savedActive.push(p._active);
  if (detailMode) {
    const breakdown = D + (zh ? '[对话' + dpct + ' 工作' + wpct + ' 新皮层' + npct + ']' : '[chat' + dpct + ' work' + wpct + ' ctx' + npct + ']') + R;
    const memLine = '      ' + D + (zh ? '记忆' + pct + '% ' : 'mem ' + pct + '% ') + breakdown + '/' + fmtTokShort(ctxWindow);
    rows2.push(memLine + '  ' + D + fmtSizeRaw(p._size).trim() + R);
  } else { rows2.push(''); }
}
// 横线宽度 = header 和所有数据行中最宽的
const r1HdrW = vw(r1Hdr.replace(/\x1b\[[0-9;]*m/g, ''));
const r1MaxRow = Math.max(r1HdrW, ...rows1.map(r => vw(r.replace(/\x1b\[[0-9;]*m/g, ''))));
console.log('  ' + r1Hdr);
console.log('  ' + '─'.repeat(r1MaxRow));
// 第二遍：输出
for (let i = 0; i < rows1.length; i++) {
  console.log(rows1[i]);
  if (rows2[i]) console.log(rows2[i]);
  const agentCount = i + 1;
  if (process.stdout.isTTY && agentCount % PAGE_SIZE === 0 && agentCount < list.length) {
    process.stdout.write(D + (zh ? '  -- Enter 继续, q/Esc 退出 --' : '  -- Enter to continue, q/Esc to quit --') + R);
    const buf = Buffer.alloc(64);
    try { require('fs').readSync(0, buf, 0, 64); } catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
    const firstByte = buf[0];
    const input = buf.toString('utf8').trim().toLowerCase();
    if (firstByte === 0x1b || input === 'q') { process.exit(0); }
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
  }
}
// sync 状态底行（2026-09-05 移除：sync 已废弃 AgentInstanceSync 停用——旧记录无意义，显示过时同步时间误导）
} // end if (filter !== 'help')

if (filter === 'help') {
  let ver = '';
  try { const v = JSON.parse(fs.readFileSync(PAIMON_HOME + '/agent/version.json', 'utf8')); const dv = (v.channel === 'prerelease' && v.pinnedDev) ? v.pinnedDev : v.genshin; ver = ' v' + dv; } catch (e) { console.error("[god.frontend.cli/list.cjs] " + (e?.message || e)); }
  console.log('');
  console.log('  ' + LOGO + 'Teyvat · Help' + R + ver);
  console.log('');
  if (zh) {
    console.log('  世界上最先进的 AI 硅基智能系统，在持续生命、Agent Native OS、AI间交互、记忆设计等领先 Claude Code 等前沿工程。');
  } else {
    console.log('  Most advanced silicon-based intelligent system worldwide ever, pioneering the way of persistent life, state retention, inter-agent interaction, real memory, agent-native technology and other methods ahead of cutting-edge agent cli engineerings.');
  }
}

console.log('');
if (filter === 'active' || filter === 'help') {
if (filter === 'archived') {
  console.log('  genshin unarchive <' + (zh ? 'agent name/id/index' : 'agent') + '>  ' + (zh ? '恢复归档' : 'restore'));
} else {
  const W = 40;  // 列宽需容纳最长命令（unarchive/rename 行 ~38 字符），2026-09-05 从 30 调大——W<cmd 宽时描述不齐
  const row = (cmd, desc) => {
    const pad = W - vw(cmd);
    if (pad >= 2) console.log('    ' + cmd + ' '.repeat(pad) + desc);
    else console.log('    ' + cmd + '\n' + ' '.repeat(4 + W) + desc);
  };
  const hdr = (s) => { console.log(''); console.log('  ' + BOLD + s + R); };

  if (zh) {
    hdr('管理');
    row('<agent name/id/index>',                    '创建新 agent 或启动已有 agent');
    row('kill, k <agent name/id/index>',           '终止正在运行的 agent 进程');
    row('archive, a <agent name/id/index>',        '归档 agent，从主列表隐藏');
    row('unarchive, ua <agent name/id/index>',     '恢复已归档的 agent 到主列表');
    row('archived, A',                    '列出所有已归档的 agents');
    row('rename <agent name/id/index> <新名称>',    '重命名 agent，保留历史记录');
    row('clone, c <agent name/id/index>',      '克隆 agent（完整复制记忆/工作区，生成 XXXX-C）');
    row('note, n',                    '列出所有非归档 agent 的备注');
    row('note, n <agent> [备注]',     '查看 / 追加 agent 备注');

    hdr('组织');
    row('org, o',                         '列出所有组织及成员');
    row('org, o <名称|ID|序号>',          '查看组织详情，不存在则创建');
    row('org, o <组织> <agent>',          '加入组织，可同属多个组织');
    row('org, o <组织> leave <agent>',    '从组织移除');
    row('',                               'agent 可用名称、ID 或序号 (1a/1o)');

    hdr('调试');
    // ⚠️ 以下调试入口已废弃（2026-09-05 用户定稿）：mc/hc 的 tmux 会话连接与 mobile 手机屏调试不再维护——相关器官已停用或移出主链
    // row('meta, mc <agent>',              '连接到 agent 的元意识 tmux session');
    // row('hippo, hc <agent>',             '连接到 agent 的海马体 tmux session');
    // row('mobile, m <agent name/id/index>',         '查看 agent 的手机屏幕输出');

    row('version, v',            '显示当前版本号和可用通道');

    hdr('人类工具');
    row('god h, god health',     '开发者健康仪表盘 (Apple Health 风格)');
    row('god m, god mobile',     '手机 TUI');

    hdr('诊断');
    row('help, h',               '显示此帮助信息');
    row('doctor',                '运行系统诊断，检查配置和健康状态');

    hdr('账户');
    row('login',                 '通过 GitHub 登录并绑定账户');
    row('logout',                '登出，清除 token（保留绑定）');
    row('unbind',                '解除账户绑定');
    row('whoami',                '显示当前账户和同步状态');

    hdr('设置');
    row('settings, s',           '打开交互式设置界面');
    row('config provider <名称> --base-url <url> [--token <key>] [--models id1,id2]',
                                 '配置 OpenAI 兼容 provider（自动发现模型，--models 可手动指定）');
  } else {
    hdr('Manage');
    row('<agent>',                        'Create a new agent or start an existing one');
    row('kill, k <agent>',               'Terminate a running agent process');
    row('archive, a <agent>',            'Archive an agent, hide from main list');
    row('unarchive, ua <agent>',         'Restore an archived agent to main list');
    row('archived, A',                    'List all archived agents');
    row('rename <agent> <new-name>',     'Rename an agent, preserving history');
    row('clone, c <agent>',              'Clone an agent (copy memory/workspace, XXXX-C)');
    row('note, n',                    'List notes of all non-archived agents');
    row('note, n <agent> [note]',     'View / append agent note');

    hdr('Organization');
    row('org, o',                         'List all organizations and members');
    row('org, o <name|ID|index>',         'View org details, or create if new');
    row('org, o <org> <agent>',           'Add agent to org, multi-org supported');
    row('org, o <org> leave <agent>',     'Remove agent from organization');
    row('',                               'agent: name, ID or index (1a/1o)');

    hdr('Debug');
    row('meta, mc <agent>',              'Attach to metaconsciousness tmux session');
    row('hippo, hc <agent>',             'Attach to hippocampus tmux session');
    row('mobile, m <agent>',            'View mobile screen output of an agent');

    row('version, v',           'Show current version and available channels');

    hdr('Human Tools');
    row('god h, god health',    'Developer health dashboard (Apple Health style)');
    row('god m, god mobile',    'Mobile TUI');

    hdr('Diagnose');
    row('help, h',              'Show this help message');
    row('doctor',               'Run system diagnostics and health checks');

    hdr('Account');
    row('login',                         'Log in with GitHub account');
    row('logout',                        'Log out, clear token (keep binding)');
    row('unbind',                        'Remove account binding');
    row('whoami',                        'Show current account and sync status');

    hdr('Settings');
    row('settings, s',                   'Open interactive settings interface');
    row('config provider <name> --base-url <url> [--token <key>] [--models id1,id2]',
                                 'Configure an OpenAI-compatible provider (auto-discovers models, --models to specify manually)');
  }
}
console.log('');
}
