// analyse.cjs — 磁盘分析工具
// 用法:
//   node analyse.cjs                → JSON 输出（给其他工具消费）
//   node analyse.cjs --render zh    → 直接渲染表格
const fs = require('fs');
const path = require('path');
const { vw } = require(path.join(__dirname, 'pad.cjs'));
const PAIMON_HOME = process.env.PAIMON_HOME || (require('os').homedir() + '/.teyvat');

const MEM_DIR = PAIMON_HOME + '/MemoryData';
const PLIST = MEM_DIR + '/plist.json';

function dirSize(dir) {
  let total = 0;
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else try { total += fs.statSync(fp).size; } catch (e) { console.error("[god.frontend.cli/analyse.cjs] " + (e?.message || e)); }
      }
    };
    walk(dir);
  } catch (e) { console.error("[god.frontend.cli/analyse.cjs] " + (e?.message || e)); }
  return total;
}

function fileSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

function analyse() {
  let agents = [];
  try { agents = JSON.parse(fs.readFileSync(PLIST, 'utf8')); } catch (e) { console.error("[god.frontend.cli/analyse.cjs] " + (e?.message || e)); }

  const rows = [];
  const totals = { s_main: 0, s_hippo: 0, s_subcon: 0, blackbox: 0, m_context: 0, m_working: 0, m_cortex: 0, m_deep: 0, total: 0 };

  for (const a of agents) {
    const d = path.join(MEM_DIR, a.id);
    const sessDir = path.join(PAIMON_HOME, 'SessionData', a.id);
    const s_main = dirSize(path.join(sessDir, 'MainSessions')) + dirSize(sessDir); // 含 flat session 文件
    const s_hippo = dirSize(path.join(sessDir, 'HippocampusSessions'));
    const s_subcon = dirSize(path.join(sessDir, 'SubconsciousSessions'));
    const bb = dirSize(path.join(PAIMON_HOME, 'BlackboxData', a.id));
    const m_context = fileSize(path.join(d, 'context.md')) + fileSize(path.join(d, 'context.archive.jsonl'));
    const m_working = fileSize(path.join(d, 'work_memory.md'));
    const m_cortex = fileSize(path.join(d, 'cortex.md'));
    const m_deep = fileSize(path.join(d, 'deep_cortex.md'));
    const ch = dirSize(path.join(PAIMON_HOME, 'ChannelData', a.id));
    const total = s_main + s_hippo + s_subcon + bb + m_context + m_working + m_cortex + m_deep + ch;

    const row = {
      name: a.name, id: a.id, archived: !!a.archived,
      kind: a.kind || 'coding-agent',
      created: a.created || null,
      lastSeen: a.lastSeen || null,
      s_main, s_hippo, s_subcon, blackbox: bb,
      m_context, m_working, m_cortex, m_deep, total
    };
    rows.push(row);
    for (const k of Object.keys(totals)) totals[k] += row[k] || 0;
  }

  rows.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
  return { rows, totals };
}

// ── render ──
function render(data, lang) {
  const zh = lang === 'zh';
  const R = '\x1b[0m', DIM = '\x1b[90m', BOLD = '\x1b[1m';
  const GRN = '\x1b[32m', YLW = '\x1b[33m', RED = '\x1b[31m';

  const { rpad, lpad } = require(path.join(__dirname, 'pad.cjs'));

  function fmtMB(b) {
    const mb = b / 1024 / 1024;
    if (mb < 0.01) return '—';
    return mb.toFixed(1);
  }

  function scolor(b) {
    const mb = b / 1024 / 1024;
    if (mb < 0.01) return DIM;
    if (mb < 10) return GRN;
    if (mb < 100) return YLW;
    return RED;
  }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }

  const { rows, totals } = data;
  const CW = 10;
  const sizeCols = ['s_main', 's_hippo', 's_subcon', 'blackbox', 'm_context', 'm_working', 'm_cortex', 'm_deep', 'total'];
  const colLabel = { created: 'Created', lastSeen: 'LastUsed', s_main: 'Session', s_hippo: 'HC-Sess', s_subcon: 'SC-Sess', blackbox: 'Blackbox', m_context: 'Context', m_working: 'WorkMem', m_cortex: 'Cortex', m_deep: 'DeepCtx', total: 'Total' };
  const allCols = ['created', 'lastSeen', ...sizeCols];

  const nw = Math.max(8, ...rows.map(r => vw(r.name + (r.archived ? ' [A]' : '')))) + 2;
  const lineW = nw + CW * allCols.length;

  console.log('');
  console.log(`  ${BOLD}${zh ? '磁盘分析' : 'Disk Analysis'}${R}  ${DIM}(MB)${R}`);
  console.log('');

  // header
  let hdr = '  ' + rpad('', nw);
  for (const c of allCols) hdr += lpad(colLabel[c], CW);
  console.log(DIM + hdr + R);
  console.log('  ' + '─'.repeat(lineW));

  // rows
  for (const r of rows) {
    const label = r.name + (r.archived ? ' [A]' : '');
    let line = '  ' + rpad(label, nw);
    line += lpad(fmtDate(r.created), CW);
    line += lpad(fmtDate(r.lastSeen), CW);
    for (const c of sizeCols) {
      line += scolor(r[c]) + lpad(fmtMB(r[c]), CW) + R;
    }
    console.log(line);
  }

  // totals
  console.log('  ' + '─'.repeat(lineW));
  let tline = '  ' + BOLD + rpad(zh ? '合计' : 'Total', nw) + R;
  tline += ' '.repeat(CW * 2); // skip date cols
  for (const c of sizeCols) {
    tline += scolor(totals[c]) + BOLD + lpad(fmtMB(totals[c]), CW) + R;
  }
  console.log(tline);

  console.log('');
  console.log(DIM + '  S = Session   M = Memory   [A] = ' + (zh ? '已归档' : 'archived') + R);
}

// ── main ──
const data = analyse();
if (process.argv.includes('--render')) {
  const lang = process.argv[process.argv.indexOf('--render') + 1] || 'en';
  render(data, lang);
} else {
  console.log(JSON.stringify(data, null, 2));
}
