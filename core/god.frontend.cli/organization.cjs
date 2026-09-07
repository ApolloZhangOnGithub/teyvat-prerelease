// genshin -o              → 列出所有组织
// genshin -o <name>       → 创建组织
// genshin -o <org_id> <agent> → agent 加入组织
// genshin -o <org> leave <agent> → agent 退出组织
(async () => {
const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');
const { computeAndSort, isValidName } = require('./pad.cjs');

const PLIST = process.argv[2];
const ARG1 = process.argv[3];
const ARG2 = process.argv[4];
const ARG3 = process.argv[5];
const PAIMON_HOME = process.env.PAIMON_HOME || (require('os').homedir() + '/.teyvat');
const zh = process.env.PAIMON_LANG === 'zh';
const T = (a, b) => zh ? a : b;

const list = JSON.parse(fs.readFileSync(PLIST, 'utf8'));
const now = Date.now();
let ps = '';
try { ps = execSync('ps aux', { encoding: 'utf8' }); } catch (e) { console.error("[god.frontend.cli/organization.cjs] " + (e?.message || e)); }
for (const p of list) {
  p._active = ps.split('\n').some(l => l.includes('genshin:') && l.includes('(main,') && l.includes(p.id));
  p._ago = Math.round((now - new Date(p.lastEnded || p.lastSeen).getTime()) / 60000);
}
const sorted = computeAndSort(list.filter(p => !p.archived), ps, now);

const ORGS_FILE = PAIMON_HOME + '/AgentWorkDir/Organizational/orgs.json';
fs.mkdirSync(require('path').dirname(ORGS_FILE), { recursive: true });
let orgs = [];
try { orgs = JSON.parse(fs.readFileSync(ORGS_FILE, 'utf8')); } catch { orgs = []; }

function getOrgs(agent) {
  if (Array.isArray(agent.orgs)) return agent.orgs;
  if (agent.org) return [agent.org];
  return [];
}
function setOrgs(agent, orgIds) {
  agent.orgs = orgIds;
  delete agent.org;
}

function vw(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    )) ? 2 : 1;
  }
  return w;
}
function pad(s, n) { return s + ' '.repeat(Math.max(0, n - vw(s))); }

// ── 无参数: 列出所有组织 ──
if (!ARG1) {
  const BOLD = '\x1b[1m', D = '\x1b[90m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[0m';
  let devVer = '';
  try { const v = JSON.parse(fs.readFileSync(PAIMON_HOME + '/agent/version.json', 'utf8')); const dv = (v.channel === 'prerelease' && v.pinnedDev) ? v.pinnedDev : v.genshin; devVer = D + '  v' + dv + ' (' + v.channel + ')' + R; } catch (e) { console.error("[god.frontend.cli/organization.cjs] " + (e?.message || e)); }
  console.log('');
  console.log('  ' + BOLD + 'Teyvat' + R + D + ' · ' + orgs.length + ' organization' + (orgs.length === 1 ? '' : 's') + R + devVer);
  console.log('');
  if (orgs.length === 0) { console.log(T('  (暂无组织)\n\n  创建: genshin -o <组织名>', '  (no organizations)\n\n  Create: genshin -o <org-name>')); process.exit(0); }

  for (const o of orgs) {
    let activeCount = 0, bestAgo = Infinity;
    for (const mid of o.members) {
      const a = list.find(x => x.id === mid);
      if (!a || a.archived) continue;
      if (a._active) activeCount++;
      if (a._ago < bestAgo) bestAgo = a._ago;
    }
    o._activeCount = activeCount;
    o._bestAgo = bestAgo === Infinity ? 999999 : bestAgo;
  }
  orgs.sort((a, b) => {
    if (a._activeCount > 0 && b._activeCount > 0) return b._activeCount - a._activeCount;
    if (a._activeCount > 0) return -1;
    if (b._activeCount > 0) return 1;
    return a._bestAgo - b._bestAgo;
  });

  const LM = 4;
  const lm = ' '.repeat(LM);
  const nw = Math.max(...orgs.map(o => vw(o.name)), 4) + 1;
  const hName = pad(T('名称', 'NAME'), nw + 2);
  const hId = pad('ID', 8);
  const hDate = pad(T('成立', 'CREATED'), 12);
  const cols = process.stdout.columns || 80;
  const prefixW = LM + (nw + 2) + 8 + 12;
  const memberW = Math.max(10, cols - prefixW - LM);

  const rowsPlain = [], rowsDisplay = [];
  for (const o of orgs) {
    const allArchived = o.members.length > 0 && o.members.every(mid => {
      const a = list.find(x => x.id === mid);
      return !a || a.archived;
    });
    const members = o.members.map(mid => {
      const a = list.find(x => x.id === mid);
      if (!a) return { display: D + mid + R, plain: mid };
      if (a.archived) return { display: D + a.name + R, plain: a.name };
      if (a._active) return { display: G + a.name + R, plain: a.name };
      return { display: Y + a.name + R, plain: a.name };
    });
    const orgName = allArchived ? D + '*' + o.name + R : o.name;
    const orgNamePlain = allArchived ? '*' + o.name : o.name;
    const prefixPlain = pad(orgNamePlain, nw + 2) + pad(o.id, 8) + pad(o.created || '', 12);
    const prefixDisp = pad(orgNamePlain, nw + 2).replace(orgNamePlain, orgName) + pad(o.id, 8) + pad(o.created || '', 12);
    if (members.length === 0) {
      rowsPlain.push([prefixPlain]);
      rowsDisplay.push([prefixDisp]);
      continue;
    }
    const linesP = [], linesD = [];
    let curP = '', curD = '';
    for (let i = 0; i < members.length; i++) {
      const sep = curP ? ', ' : '';
      const nextP = curP + sep + members[i].plain;
      if (curP && nextP.length > memberW) {
        linesP.push(curP); linesD.push(curD);
        curP = members[i].plain; curD = members[i].display;
      } else {
        curP = nextP;
        curD += (curD ? ', ' : '') + members[i].display;
      }
    }
    if (curP) { linesP.push(curP); linesD.push(curD); }
    rowsPlain.push([prefixPlain + linesP[0], ...linesP.slice(1)]);
    rowsDisplay.push([prefixDisp + linesD[0], ...linesD.slice(1)]);
  }

  const hdrPlain = hName + hId + hDate + T('成员', 'MEMBERS');
  let maxW = vw(hdrPlain);
  for (const rp of rowsPlain) {
    for (const line of rp) {
      const w = vw(line);
      if (w > maxW) maxW = w;
    }
  }

  console.log(lm + hName + hId + hDate + T('成员', 'MEMBERS'));
  console.log(lm + '─'.repeat(maxW));
  const indent = ' '.repeat(prefixW);
  for (let r = 0; r < rowsDisplay.length; r++) {
    const rd = rowsDisplay[r];
    console.log(lm + rd[0]);
    for (let i = 1; i < rd.length; i++) console.log(indent + rd[i]);
  }
  console.log('');
  process.exit(0);
}

// ── 模式 1: genshin -o <名称|ID|序号>（无 agent 参数）→ 查看或创建 ──
if (!ARG2) {
  // 先尝试查找：按 ID、名称、序号
  let found = orgs.find(o => o.id === ARG1 || o.name === ARG1);
  if (!found && /^\d+$/.test(ARG1)) {
    const idx = parseInt(ARG1) - 1;
    if (idx >= 0 && idx < orgs.length) found = orgs[idx];
  }
  if (found) {
    const D = '\x1b[90m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[0m';
    const memberStrs = found.members.map(mid => {
      const a = list.find(x => x.id === mid);
      if (!a) return D + mid + R;
      if (a.archived) return D + a.name + R;
      if (a._active) return G + a.name + R;
      return Y + a.name + R;
    });
    console.log(found.name + ' (' + found.id + ')');
    console.log(T('  成员: ', '  Members: ') + (memberStrs.length > 0 ? memberStrs.join(', ') : T('无', 'none')));
    console.log(T('  成立: ', '  Created: ') + (found.created || T('未知', 'unknown')));
    process.exit(0);
  }
  // 不存在 → 尝试创建
  const name = ARG1;
  if (!isValidName(name)) {
    console.error(T('组织「' + name + '」不存在。\n如需创建，名称必须以英文字母开头，只能包含 a-z A-Z 0-9 _ . -', 'Organization "' + name + '" does not exist.\nTo create one, the name must start with a letter and contain only a-z A-Z 0-9 _ . -'));
    process.exit(1);
  }
  process.stdout.write(T('组织「' + name + '」不存在，是否创建? (Y 确认，其他取消) ', 'Organization "' + name + '" does not exist. Create it? (Y to confirm) '));
  const rl = require('readline').createInterface({ input: process.stdin });
  const ans = await new Promise(r => { rl.question('', a => { rl.close(); r(a); }); });
  if (ans !== 'Y') { console.log(T('取消', 'Cancelled')); process.exit(0); }
  const id = crypto.randomBytes(3).toString('hex');
  orgs.push({ id, name, members: [], created: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));
  console.log(T('组织「' + name + '」已创建 (' + id + ')', 'Organization "' + name + '" created (' + id + ')'));
  process.exit(0);
}

// ── 模式 2/3: genshin -o <org> <agent> | genshin -o <org> leave <agent> ──
const ORG_ARG = ARG1;
const isLeave = ARG2 === 'leave';
const AGENT_ARG = isLeave ? ARG3 : ARG2;

if (isLeave && !AGENT_ARG) {
  console.error(T('用法: genshin o <组织> leave <agent name/id/index|序号>', 'Usage: genshin o <org> leave <agent name/id/index>'));
  process.exit(1);
}

const org = orgs.find(o => o.id === ORG_ARG || o.name === ORG_ARG);
if (!org) { console.error(T('组织 ' + ORG_ARG + ' 不存在', 'Organization ' + ORG_ARG + ' does not exist')); process.exit(1); }

const active = sorted.filter(p => p._active);
const offline = sorted.filter(p => !p._active);

async function addToOrg(agent) {
  if (org.members.includes(agent.id)) {
    console.error(T(agent.name + ' 已处于「' + org.name + '」组织中', agent.name + ' is already in organization "' + org.name + '"'));
    process.exit(1);
  }
  const curOrgs = getOrgs(agent);
  const curNames = curOrgs.map(oid => { const o = orgs.find(x => x.id === oid); return o ? '「' + o.name + '」' : oid; });
  const hint = curNames.length > 0 ? T('（当前已在 ' + curNames.join('、') + ' 中）', ' (already in ' + curNames.join(', ') + ')') : '';
  process.stdout.write(T('将 ' + agent.name + ' 加入「' + org.name + '」' + hint + '? (Y 确认，其他取消) ', 'Add ' + agent.name + ' to "' + org.name + '"' + hint + '? (Y to confirm) '));
  const rl = require('readline').createInterface({ input: process.stdin });
  const ans = await new Promise(r => { rl.question('', a => { rl.close(); r(a); }); });
  if (ans !== 'Y') { console.log(T('取消', 'Cancelled')); process.exit(0); }
  org.members.push(agent.id);
  fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));
  setOrgs(agent, [...curOrgs, org.id]);
  fs.writeFileSync(PLIST, JSON.stringify(list, null, 2));
  console.log(T(agent.name + ' 已加入「' + org.name + '」(' + org.id + ')', agent.name + ' added to "' + org.name + '" (' + org.id + ')'));
}

async function removeFromOrg(agent) {
  if (!org.members.includes(agent.id)) {
    console.error(T(agent.name + ' 不在「' + org.name + '」组织中', agent.name + ' is not in "' + org.name + '"'));
    process.exit(1);
  }
  process.stdout.write(T('将 ' + agent.name + ' 从「' + org.name + '」中移除? (Y 确认，其他取消) ', 'Remove ' + agent.name + ' from "' + org.name + '"? (Y to confirm) '));
  const rl = require('readline').createInterface({ input: process.stdin });
  const ans = await new Promise(r => { rl.question('', a => { rl.close(); r(a); }); });
  if (ans !== 'Y') { console.log(T('取消', 'Cancelled')); process.exit(0); }
  org.members = org.members.filter(m => m !== agent.id);
  fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));
  const curOrgs = getOrgs(agent).filter(oid => oid !== org.id);
  setOrgs(agent, curOrgs);
  fs.writeFileSync(PLIST, JSON.stringify(list, null, 2));
  console.log(T(agent.name + ' 已从「' + org.name + '」中移除', agent.name + ' removed from "' + org.name + '"'));
}

const action = isLeave ? removeFromOrg : addToOrg;

const numMatch = AGENT_ARG.match(/^(\d+)(a|o)?$/);
if (numMatch) {
  const idx = parseInt(numMatch[1]) - 1;
  const suffix = numMatch[2];
  if (suffix === 'a') {
    const agent = active[idx];
    if (!agent) { console.error(T('序号 ' + AGENT_ARG + ' 超出范围（共 ' + active.length + ' 个活跃 agent）', 'Index ' + AGENT_ARG + ' out of range (' + active.length + ' active agents)')); process.exit(1); }
    await action(agent);
  } else if (suffix === 'o') {
    const agent = offline[idx];
    if (!agent) { console.error(T('序号 ' + AGENT_ARG + ' 超出范围（共 ' + offline.length + ' 个离线 agent）', 'Index ' + AGENT_ARG + ' out of range (' + offline.length + ' offline agents)')); process.exit(1); }
    await action(agent);
  } else {
    const a = active[idx], o = offline[idx];
    if (a && o) {
      console.error(T('序号 ' + AGENT_ARG + ' 有歧义:\n  ' + AGENT_ARG + 'a → ' + a.name + ' (活跃)\n  ' + AGENT_ARG + 'o → ' + o.name + ' (离线)\n请使用 ' + numMatch[1] + 'a 或 ' + numMatch[1] + 'o 选取', 'Index ' + AGENT_ARG + ' is ambiguous:\n  ' + AGENT_ARG + 'a → ' + a.name + ' (active)\n  ' + AGENT_ARG + 'o → ' + o.name + ' (offline)\nUse ' + numMatch[1] + 'a or ' + numMatch[1] + 'o'));
      process.exit(1);
    }
    const agent = a || o;
    if (!agent) { console.error(T('序号 ' + AGENT_ARG + ' 超出范围（活跃 ' + active.length + ' 个，离线 ' + offline.length + ' 个）', 'Index ' + AGENT_ARG + ' out of range (' + active.length + ' active, ' + offline.length + ' offline)')); process.exit(1); }
    await action(agent);
  }
} else {
  const agent = list.find(p => p.name === AGENT_ARG || p.id === AGENT_ARG);
  if (!agent) { console.error(T('没找到 "' + AGENT_ARG + '"', 'Not found: "' + AGENT_ARG + '"')); process.exit(1); }
  await action(agent);
}
})();
