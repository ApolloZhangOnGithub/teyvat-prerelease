// pad.cjs — shared string padding with CJK width
// Used by genshin list, genshin analyse, and other CLI tools.

const fs = require('fs');
const os = require('os');
const PAIMON_HOME = process.env.PAIMON_HOME || (os.homedir() + '/.teyvat');

function vw(s) {
  let w = 0;
  for (const c of [...String(s)]) {
    const cp = c.codePointAt(0);
    w += (cp && cp > 0x2E7F) ? 2 : 1;
  }
  return w;
}

/** Right-pad to visible width n */
function pad(s, n) {
  return String(s) + ' '.repeat(Math.max(0, n - vw(String(s))));
}

/** Left-pad to visible width n */
function lpad(s, n) {
  return ' '.repeat(Math.max(0, n - vw(String(s)))) + String(s);
}

/** Alias for pad */
function rpad(s, n) {
  return pad(s, n);
}

/** Compute _active/_ago and sort agents by active first, then recency */
// 2026-09-09（用户报 `genshin a 1` 选错——离线编号错位）：active 判定必须与 list.cjs 同源（main.pid 心跳）。
// 原实现用 ps 进程存在判定——心跳停但进程还挂着的 agent（卡死/僵尸）被当 active 滤出离线池 →
// 与列表显示（心跳判定 [O]）编号错位（a 1 选到显示第 2 的离线 agent，实测 ARPA）。
// 统一：main.pid mtime ≤90s（heart 30s futimes 心跳）+ kill -0 进程存在 = active（心跳代表 agent 正常运转）。
function computeAndSort(list, _psOutput, now) {
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
  }
  list.sort((a, b) => (b._active ? 1 : 0) - (a._active ? 1 : 0) || a._ago - b._ago);
  return list;
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.\-]*$/;
function isValidName(name) { return NAME_RE.test(name); }

module.exports = { pad, lpad, rpad, vw, computeAndSort, NAME_RE, isValidName };
