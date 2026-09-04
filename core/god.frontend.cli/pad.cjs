// pad.cjs — shared string padding with CJK width
// Used by genshin list, genshin analyse, and other CLI tools.

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
function computeAndSort(list, psOutput, now) {
  for (const p of list) {
    p._active = psOutput.split('\n').some(l => l.includes('genshin:') && l.includes('(main,') && l.includes(p.id));
    p._ago = Math.round((now - new Date(p.lastEnded || p.lastSeen).getTime()) / 60000);
  }
  list.sort((a, b) => (b._active ? 1 : 0) - (a._active ? 1 : 0) || a._ago - b._ago);
  return list;
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.\-]*$/;
function isValidName(name) { return NAME_RE.test(name); }

module.exports = { pad, lpad, rpad, vw, computeAndSort, NAME_RE, isValidName };
