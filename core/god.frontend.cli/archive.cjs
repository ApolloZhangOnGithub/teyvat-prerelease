(async () => {
const fs = require('fs');
const { computeAndSort } = require('./pad.cjs');
const { execSync } = require('child_process');

const PLIST = process.argv[2];
const MODE = process.argv[3];
const targets = process.argv.slice(4);
const PAIMON_HOME = process.env.PAIMON_HOME || (require('os').homedir() + '/.teyvat');
const zh = process.env.PAIMON_LANG === 'zh';
const T = (a, b) => zh ? a : b;

const list = JSON.parse(fs.readFileSync(PLIST, 'utf8'));

// ── org 支持：6位hex = 组织号 → 展开为成员 agent 列表 ──
const ORGS_FILE = PAIMON_HOME + '/AgentWorkDir/Organizational/orgs.json';
let orgs = [];
try { orgs = JSON.parse(fs.readFileSync(ORGS_FILE, 'utf8')); } catch (e) { console.error("[god.frontend.cli/archive.cjs] " + (e?.message || e)); }
const now = Date.now();
let ps = '';
try { ps = execSync('ps aux', { encoding: 'utf8' }); } catch (e) { console.error("[god.frontend.cli/archive.cjs] " + (e?.message || e)); }

function sorted(filterFn) {
  const a = list.filter(filterFn);
  computeAndSort(a, ps, now);
  return a;
}

const poolRaw = sorted(MODE === 'archive' ? (x => !x.archived) : (x => x.archived));
// 归档时只能选不在运行的（数字对应离线编号，同 genshin list）
const pool = MODE === 'archive' ? poolRaw.filter(p => !p._active) : poolRaw;
const picked = new Set();
const errs = [];

// 2026-09-07（用户定稿）：运行中归档前置就是 kill——文案按 F/B 区分提示，去掉误导性的"/h 转后台"（转后台≠停止，归档仍拦）。
function fbState(p) {
  return fs.existsSync(PAIMON_HOME + '/RuntimeCache/' + p.id + '/detached') ? '后台' : '前台';
}

// 展开 org ID（6位hex）→ 成员 agent ID 列表
let orgArchiveName = ''; // 记录被归档的组织名
const expanded = [];
for (const arg of targets) {
  if (/^[a-f0-9]{6}$/.test(arg)) {
    const org = orgs.find(o => o.id === arg);
    if (org) {
      // 检查是否有 live 的成员——只要有一个人活着就不能归档
      if (MODE === 'archive') {
        const liveMembers = org.members.filter(mid => {
          const a = list.find(x => x.id === mid);
          return a && a._active;
        });
        if (liveMembers.length > 0) {
          const liveNames = liveMembers.map(mid => {
            const a = list.find(x => x.id === mid);
            return a ? a.name : mid;
          }).join(', ');
          errs.push(T(`组织「${org.name}」有 ${liveMembers.length} 人在运行中，不能归档: ${liveNames}`, `Organization "${org.name}" has ${liveMembers.length} member(s) running; cannot archive: ${liveNames}`));
          continue;
        }
      }
      orgArchiveName = org.name;
      for (const mid of org.members) {
        const agent = list.find(a => a.id === mid);
        if (agent) expanded.push(agent.name);
      }
      continue;
    }
  }
  expanded.push(arg);
}

for (const arg of expanded) {
  if (arg === '*' || arg === 'all') {
    pool.forEach(p => picked.add(p));
  } else if (/^\d+-\d+$/.test(arg)) {
    const m = arg.match(/^(\d+)-(\d+)$/);
    const a = parseInt(m[1]), b = parseInt(m[2]);
    // 先检查起始是否在范围内，不在直接报错整段
    if (a > pool.length) { errs.push(T('序号 ' + arg + ' 超出范围（共 ' + pool.length + ' 个）', 'Index ' + arg + ' out of range (' + pool.length + ' total)')); continue; }
    const end = Math.min(b, pool.length);
    for (let i = a; i <= end; i++) picked.add(pool[i - 1]);
    if (b > pool.length) errs.push(T('序号 ' + (pool.length + 1) + '-' + b + ' 超出范围（共 ' + pool.length + ' 个）', 'Index ' + (pool.length + 1) + '-' + b + ' out of range (' + pool.length + ' total)'));
  } else if (/^\d+[ofba]$/.test(arg)) {
    // 2026-08-20 分组编号路由（用户定稿，与列表 1o/1f/1b 显示一致）：
    // 1o=offline 第 N、1f=front(前台) 第 N、1b=background(后台) 第 N、1a=active 合并（F+B 按列表顺序，兼容 1f/1b）
    const n = parseInt(arg) - 1;
    const grp = arg.slice(-1);
    let cands;
    if (grp === 'o') cands = poolRaw.filter(p => !p._active);
    else if (grp === 'f') cands = poolRaw.filter(p => p._active && !fs.existsSync(PAIMON_HOME + '/RuntimeCache/' + p.id + '/detached'));
    else if (grp === 'b') cands = poolRaw.filter(p => p._active && fs.existsSync(PAIMON_HOME + '/RuntimeCache/' + p.id + '/detached'));
    else cands = poolRaw.filter(p => p._active);
    const p = cands[n];
    if (p) {
      if (MODE === 'archive' && p._active) errs.push(T(`「${p.name}」正在${fbState(p)}运行中，不能归档（先 kill 停止）`, `"${p.name}" is running in ${fbState(p) === '后台' ? 'background' : 'foreground'}; cannot archive (kill it first)`));
      else picked.add(p);
    } else errs.push(T('序号 ' + arg + ' 超出范围（' + grp + ' 组共 ' + cands.length + ' 个）', 'Index ' + arg + ' out of range (' + grp + ' group, ' + cands.length + ' total)'));
  } else if (/^\d+$/.test(arg)) {
    const p = pool[parseInt(arg) - 1];
    if (p) picked.add(p);
    else errs.push(T('序号 ' + arg + ' 超出范围（共 ' + pool.length + ' 个）', 'Index ' + arg + ' out of range (' + pool.length + ' total)'));
  } else {
    const p = pool.find(x => x.name === arg);
    if (p) picked.add(p);
    else {
      // 2026-08-20 修复：区分"正在运行不能归档"与"真没找到"——原报错误导（运行中的 agent 被 _active 过滤却报"没找到"）
      const running = list.find(x => x.name === arg && x._active);
      if (running) errs.push(T(`「${arg}」正在${fbState(running)}运行中，不能归档（先 kill 停止）`, `"${arg}" is running in ${fbState(running) === '后台' ? 'background' : 'foreground'}; cannot archive (kill it first)`));
      else errs.push(T('没找到 "' + arg + '"', 'Not found: "' + arg + '"'));
    }
  }
}

if (errs.length) {
  console.error(errs.join('；'));
  process.exit(1);
}

if (!picked.size) {
  console.error(T('没有可处理的目标。', 'No targets to process.'));
  process.exit(1);
}

// ── 回忆录检查（已禁用 — 用户不再使用 memoir 功能）──
// const MEMOIR_DIR = process.env.PAIMON_MEMOIR_DIR || PAIMON_HOME + '/MemoirData';
// try { require('fs').mkdirSync(MEMOIR_DIR, { recursive: true }); } catch (e) { console.error("[god.frontend.cli/archive.cjs] " + (e?.message || e)); }
// 
// let memoirWarn = '';
// if (MODE === 'archive' && MEMOIR_DIR) {
//   const missing = [...picked].filter(p => !fs.existsSync(MEMOIR_DIR + '/' + p.id + '.MEMOIR'));
//   if (missing.length === 1) memoirWarn = '该agent尚未撰写回忆录(' + MEMOIR_DIR + '/' + missing[0].id + '.MEMOIR), ';
//   else if (missing.length > 1) memoirWarn = missing.length + '个agent尚未撰写回忆录，';
// }

// 2026-09-04 用户需求：确认提示带状态组标记——纯数字/分组路由时用户看不出这个序号是哪组的第几。
// 组：O=offline(!active) / F=front(active 前台) / B=background(active headless)；
// 组内序号 = 该组按列表排序（computeAndSort，与 genshin list 显示一致）中的位置，形态如 [O] (o1)。
const _grpTag = (p) => {
  try {
    let g, label;
    if (p._active) {
      const detached = fs.existsSync(PAIMON_HOME + '/RuntimeCache/' + p.id + '/detached');
      g = detached ? 'b' : 'f'; label = detached ? 'B' : 'F';
    } else { g = 'o'; label = 'O'; }
    const cands = poolRaw.filter(x => {
      if (x._active) { const d = fs.existsSync(PAIMON_HOME + '/RuntimeCache/' + x.id + '/detached'); return d ? g === 'b' : g === 'f'; }
      return g === 'o';
    });
    const n = cands.findIndex(x => x.id === p.id) + 1;
    return n > 0 ? ` [${label}] (${g}${n})` : '';
  } catch (e) { console.error("[god.frontend.cli/archive.cjs] " + (e?.message || e)); return ''; }
};

const names = orgArchiveName
  ? T(`组织「${orgArchiveName}」的 ${[...picked].length} 人(` + [...picked].map(p => p.name).join(', ') + ')', `members of organization "${orgArchiveName}" (${[...picked].length}: ` + [...picked].map(p => p.name).join(', ') + ')')
  : [...picked].map(p => p.name + _grpTag(p)).join(', ');
process.stdout.write(T((MODE === 'archive' ? '确定归档 ' : '确定恢复 ') + names + '? (Y 确认，其他取消) ', (MODE === 'archive' ? 'Archive ' : 'Restore ') + names + '? (Y to confirm) '));

const rl = require('readline').createInterface({ input: process.stdin });
const ans = await new Promise(r => { rl.question('', a => { rl.close(); r(a) }); });
if (!ans || !/^y/i.test(ans)) { console.log('cancelled'); process.exit(0); }

for (const p of picked) {
  // 如果还在跑，先杀掉
  if (MODE === 'archive' && p._active) {
    try {
      const pid = execSync(`ps aux | grep 'genshin:.*${p.id}' | grep -v grep | awk '{print $2}'`, {encoding:'utf8'}).trim().split('\n')[0];
      if (pid) { process.kill(parseInt(pid)); console.log(T(`  已杀掉 ${p.name} (PID ${pid})`, `  Killed ${p.name} (PID ${pid})`)); }
    } catch (e) { console.error("[god.frontend.cli/archive.cjs] " + (e?.message || e)); }
  }
  p.archived = (MODE === 'archive');
  p.archivedAt = (MODE === 'archive') ? new Date().toISOString() : undefined;
  // 同步 IdentityData + 记录完整历史
  const idPath = PAIMON_HOME + '/IdentityData/' + p.id + '/identity.json';
  try {
    const idDir = require('path').dirname(idPath);
    require('fs').mkdirSync(idDir, { recursive: true });
    let idData = {};
    try { idData = JSON.parse(fs.readFileSync(idPath, 'utf8')); } catch (e) { console.error("[god.frontend.cli/archive.cjs] " + (e?.message || e)); }
    idData.archived = p.archived;
    idData.archivedAt = p.archivedAt;
    if (!idData.archiveHistory) idData.archiveHistory = [];
    idData.archiveHistory.push({ action: MODE, at: new Date().toISOString() });
    fs.writeFileSync(idPath, JSON.stringify(idData, null, 2));
  } catch (e) { console.error("[god.frontend.cli/archive.cjs] " + (e?.message || e)); }
}
fs.writeFileSync(PLIST, JSON.stringify(list, null, 2));
// 归档后自动压缩，恢复后自动解压
for (const p of picked) {
  const COMPRESS = __dirname + '/xscompress.cjs';
  const { spawn } = require('child_process');
  if (MODE === 'archive') {
    spawn('node', [COMPRESS, 'compress', p.id], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('node', [COMPRESS, 'decompress', p.id], { stdio: 'ignore', detached: true }).unref();
  }
}
console.log(T((MODE === 'archive' ? '已归档 ' : 'OK 已恢复 ') + [...picked].map(p => p.name).join('、'), (MODE === 'archive' ? 'Archived ' : 'OK restored ') + [...picked].map(p => p.name).join(', ')));
})();
