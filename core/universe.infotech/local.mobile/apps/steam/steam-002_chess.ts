// apps/steam/chess.ts — 国际象棋（纯规则 minimax AI，零 LLM）

interface Move { fr: number; fc: number; tr: number; tc: number; promo?: string }

const INIT = [
  ['r','n','b','q','k','b','n','r'],
  ['p','p','p','p','p','p','p','p'],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['P','P','P','P','P','P','P','P'],
  ['R','N','B','Q','K','B','N','R'],
];

function cp(b: string[][]): string[][] { return b.map(r => [...r]); }
function ok(r: number, c: number) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function isW(p: string) { return p >= 'A' && p <= 'Z'; }
function isB(p: string) { return p >= 'a' && p <= 'z'; }

interface S { b: string[][]; t: 'w' | 'b'; cs: { K: boolean; Q: boolean; k: boolean; q: boolean }; ep: [number, number] | null; over: boolean; res: string | null }

function init(): S { return { b: cp(INIT), t: 'w', cs: { K: true, Q: true, k: true, q: true }, ep: null, over: false, res: null }; }

function gen(s: S, c: 'w' | 'b'): Move[] {
  const ms: Move[] = [], own = c === 'w' ? isW : isB, opp = c === 'w' ? isB : isW;
  const dir = c === 'w' ? -1 : 1, sr = c === 'w' ? 6 : 1, pr = c === 'w' ? 0 : 7;
  for (let r = 0; r < 8; r++) for (let co = 0; co < 8; co++) {
    const p = s.b[r][co]; if (!own(p)) continue;
    const t = p.toUpperCase();
    if (t === 'P') {
      const nr = r + dir;
      if (ok(nr, co) && !s.b[nr][co]) {
        if (nr === pr) { for (const pp of c === 'w' ? ['Q','R','B','N'] : ['q','r','b','n']) ms.push({ fr: r, fc: co, tr: nr, tc: co, promo: pp }); }
        else { ms.push({ fr: r, fc: co, tr: nr, tc: co }); if (r === sr) { const n2 = r + dir * 2; if (!s.b[n2][co]) ms.push({ fr: r, fc: co, tr: n2, tc: co }); } }
      }
      for (const dc of [-1, 1]) { const nc = co + dc; if (!ok(nr, nc)) continue; if (opp(s.b[nr][nc])) { if (nr === pr) { for (const pp of c === 'w' ? ['Q','R','B','N'] : ['q','r','b','n']) ms.push({ fr: r, fc: co, tr: nr, tc: nc, promo: pp }); } else ms.push({ fr: r, fc: co, tr: nr, tc: nc }); } if (s.ep && s.ep[0] === nr && s.ep[1] === nc) ms.push({ fr: r, fc: co, tr: nr, tc: nc }); }
    }
    if (t === 'N') for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) { const nr = r + dr, nc = co + dc; if (ok(nr, nc) && !own(s.b[nr][nc])) ms.push({ fr: r, fc: co, tr: nr, tc: nc }); }
    const sl = (dirs: number[][]) => { for (const [dr, dc] of dirs) { let nr = r + dr, nc = co + dc; while (ok(nr, nc)) { if (own(s.b[nr][nc])) break; ms.push({ fr: r, fc: co, tr: nr, tc: nc }); if (opp(s.b[nr][nc])) break; nr += dr; nc += dc; } } };
    if (t === 'B' || t === 'Q') sl([[-1,-1],[-1,1],[1,-1],[1,1]]);
    if (t === 'R' || t === 'Q') sl([[-1,0],[1,0],[0,-1],[0,1]]);
    if (t === 'K') {
      for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) { const nr = r + dr, nc = co + dc; if (ok(nr, nc) && !own(s.b[nr][nc])) ms.push({ fr: r, fc: co, tr: nr, tc: nc }); }
      const rk = c === 'w' ? 7 : 0, rc = c === 'w' ? 'R' : 'r';
      if (r === rk && co === 4) {
        if ((c === 'w' ? s.cs.K : s.cs.k) && !s.b[rk][5] && !s.b[rk][6] && s.b[rk][7] === rc) ms.push({ fr: rk, fc: 4, tr: rk, tc: 6 });
        if ((c === 'w' ? s.cs.Q : s.cs.q) && !s.b[rk][3] && !s.b[rk][2] && !s.b[rk][1] && s.b[rk][0] === rc) ms.push({ fr: rk, fc: 4, tr: rk, tc: 2 });
      }
    }
  }
  return ms;
}

function ap(s: S, m: Move): S {
  const n: S = { b: cp(s.b), t: s.t === 'w' ? 'b' : 'w', cs: { ...s.cs }, ep: null, over: false, res: null };
  const p = n.b[m.fr][m.fc], t = p.toUpperCase();
  n.b[m.tr][m.tc] = m.promo || p; n.b[m.fr][m.fc] = '';
  if (t === 'P' && s.ep && m.tr === s.ep[0] && m.tc === s.ep[1]) n.b[m.fr][m.tc] = '';
  if (t === 'P' && Math.abs(m.tr - m.fr) === 2) n.ep = [((m.fr + m.tr) >> 1), m.fc];
  if (t === 'K') {
    if (m.fc === 4 && m.tc === 6) { n.b[m.fr][5] = n.b[m.fr][7]; n.b[m.fr][7] = ''; }
    if (m.fc === 4 && m.tc === 2) { n.b[m.fr][3] = n.b[m.fr][0]; n.b[m.fr][0] = ''; }
    if (s.t === 'w') { n.cs.K = false; n.cs.Q = false; } else { n.cs.k = false; n.cs.q = false; }
  }
  if (m.fr === 7 && m.fc === 0) n.cs.Q = false; if (m.fr === 7 && m.fc === 7) n.cs.K = false;
  if (m.fr === 0 && m.fc === 0) n.cs.q = false; if (m.fr === 0 && m.fc === 7) n.cs.k = false;
  if (m.tr === 7 && m.tc === 0) n.cs.Q = false; if (m.tr === 7 && m.tc === 7) n.cs.K = false;
  if (m.tr === 0 && m.tc === 0) n.cs.q = false; if (m.tr === 0 && m.tc === 7) n.cs.k = false;
  return n;
}

function att(s: S, r: number, c: number, by: 'w' | 'b'): boolean {
  const own = by === 'w' ? isW : isB;
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) { const nr = r + dr, nc = c + dc; if (ok(nr, nc) && own(s.b[nr][nc]) && s.b[nr][nc].toUpperCase() === 'N') return true; }
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) { const nr = r + dr, nc = c + dc; if (ok(nr, nc) && own(s.b[nr][nc]) && s.b[nr][nc].toUpperCase() === 'K') return true; }
  const pr = by === 'w' ? r + 1 : r - 1;
  for (const dc of [-1, 1]) { const nc = c + dc; if (ok(pr, nc) && s.b[pr][nc] === (by === 'w' ? 'P' : 'p')) return true; }
  const sl = (dirs: number[][], pcs: string[]) => { for (const [dr, dc] of dirs) { let nr = r + dr, nc = c + dc; while (ok(nr, nc)) { const sq = s.b[nr][nc]; if (sq) { if (own(sq) && pcs.includes(sq.toUpperCase())) return true; break; } nr += dr; nc += dc; } } return false; };
  return sl([[-1,-1],[-1,1],[1,-1],[1,1]], ['B','Q']) || sl([[-1,0],[1,0],[0,-1],[0,1]], ['R','Q']);
}

function fk(s: S, c: 'w' | 'b'): [number, number] {
  const k = c === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) for (let co = 0; co < 8; co++) if (s.b[r][co] === k) return [r, co];
  return [-1, -1];
}

function chk(s: S, c: 'w' | 'b'): boolean { const [r, co] = fk(s, c); return att(s, r, co, c === 'w' ? 'b' : 'w'); }

function legal(s: S): Move[] {
  return gen(s, s.t).filter(m => {
    const ns = ap(s, m);
    if (chk(ns, s.t)) return false;
    if (s.b[m.fr][m.fc].toUpperCase() === 'K' && Math.abs(m.tc - m.fc) === 2) {
      if (chk(s, s.t)) return false;
      const mid = ap(s, { fr: m.fr, fc: m.fc, tr: m.fr, tc: ((m.fc + m.tc) >> 1) });
      if (chk(mid, s.t)) return false;
    }
    return true;
  });
}

// ── Evaluation ──

const PV: Record<string, number> = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };
const PST: Record<string, number[]> = {
  P: [0,0,0,0,0,0,0,0,50,50,50,50,50,50,50,50,10,10,20,30,30,20,10,10,5,5,10,25,25,10,5,5,0,0,0,20,20,0,0,0,5,-5,-10,0,0,-10,-5,5,5,10,10,-20,-20,10,10,5,0,0,0,0,0,0,0,0],
  N: [-50,-40,-30,-30,-30,-30,-40,-50,-40,-20,0,0,0,0,-20,-40,-30,0,10,15,15,10,0,-30,-30,5,15,20,20,15,5,-30,-30,0,15,20,20,15,0,-30,-30,5,10,15,15,10,5,-30,-40,-20,0,5,5,0,-20,-40,-50,-40,-30,-30,-30,-30,-40,-50],
  B: [-20,-10,-10,-10,-10,-10,-10,-20,-10,0,0,0,0,0,0,-10,-10,0,10,10,10,10,0,-10,-10,5,5,10,10,5,5,-10,-10,0,10,10,10,10,0,-10,-10,10,10,10,10,10,10,-10,-10,5,0,0,0,0,5,-10,-20,-10,-10,-10,-10,-10,-10,-20],
  R: [0,0,0,0,0,0,0,0,5,10,10,10,10,10,10,5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,-5,0,0,0,0,0,0,-5,0,0,0,5,5,0,0,0],
  Q: [-20,-10,-10,-5,-5,-10,-10,-20,-10,0,0,0,0,0,0,-10,-10,0,5,5,5,5,0,-10,-5,0,5,5,5,5,0,-5,0,0,5,5,5,5,0,-5,-10,5,5,5,5,5,0,-10,-10,0,5,0,0,0,0,-10,-20,-10,-10,-5,-5,-10,-10,-20],
  K: [-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-30,-40,-40,-50,-50,-40,-40,-30,-20,-30,-30,-40,-40,-30,-30,-20,-10,-20,-20,-20,-20,-20,-20,-10,20,20,0,0,0,0,20,20,20,30,10,0,0,10,30,20],
};

function ev(s: S): number {
  let sc = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = s.b[r][c]; if (!p) continue;
    const t = p.toUpperCase(), v = PV[t] || 0, ps = PST[t];
    if (isW(p)) sc += v + (ps ? ps[r * 8 + c] : 0);
    else sc -= v + (ps ? ps[(7 - r) * 8 + c] : 0);
  }
  return sc;
}

// ── AI: minimax + alpha-beta ──

function mm(s: S, d: number, a: number, b: number, mx: boolean): number {
  const ms = legal(s);
  if (!ms.length) return chk(s, s.t) ? (mx ? -99999 + d : 99999 - d) : 0;
  if (d === 0) return ev(s);
  ms.sort((x, y) => {
    const cx = s.b[x.tr][x.tc] ? PV[s.b[x.tr][x.tc].toUpperCase()] || 0 : 0;
    const cy = s.b[y.tr][y.tc] ? PV[s.b[y.tr][y.tc].toUpperCase()] || 0 : 0;
    return cy - cx;
  });
  if (mx) { let v = -Infinity; for (const m of ms) { v = Math.max(v, mm(ap(s, m), d - 1, a, b, false)); a = Math.max(a, v); if (b <= a) break; } return v; }
  let v = Infinity; for (const m of ms) { v = Math.min(v, mm(ap(s, m), d - 1, a, b, true)); b = Math.min(b, v); if (b <= a) break; } return v;
}

function best(s: S, depth = 3): Move | null {
  const ms = legal(s);
  if (!ms.length) return null;
  ms.sort((x, y) => { const cx = s.b[x.tr][x.tc] ? PV[s.b[x.tr][x.tc].toUpperCase()] || 0 : 0; const cy = s.b[y.tr][y.tc] ? PV[s.b[y.tr][y.tc].toUpperCase()] || 0 : 0; return cy - cx; });
  let top: Move = ms[0], topV = s.t === 'w' ? -Infinity : Infinity;
  const mx = s.t === 'w';
  let al = -Infinity, be = Infinity;
  for (const m of ms) {
    const v = mm(ap(s, m), depth - 1, al, be, !mx);
    if (mx) { if (v > topV) { topV = v; top = m; } al = Math.max(al, v); }
    else { if (v < topV) { topV = v; top = m; } be = Math.min(be, v); }
  }
  return top;
}

// ── Public ──

function sq(r: number, c: number): string { return String.fromCharCode(97 + c) + (8 - r); }

export class ChessGame {
  s: S;
  log: string[] = [];
  difficulty: 'easy' | 'medium' | 'hard';

  constructor(difficulty: 'easy' | 'medium' | 'hard' = 'medium') {
    this.s = init();
    this.difficulty = difficulty;
  }

  parseInput(input: string): Move | null {
    const m = input.match(/^([a-h])([1-8])([a-h])([1-8])([qrbn])?$/i);
    if (!m) return null;
    return { fr: 8 - +m[2], fc: m[1].charCodeAt(0) - 97, tr: 8 - +m[4], tc: m[3].charCodeAt(0) - 97, promo: m[5] ? (this.s.t === 'w' ? m[5].toUpperCase() : m[5].toLowerCase()) : undefined };
  }

  move(input: string): { ok: boolean; error?: string; ai?: string } {
    if (this.s.over) return { ok: false, error: "游戏已结束。输入「新局」重开。" };
    if (this.s.t !== 'w') return { ok: false, error: "等待对手走棋。" };
    const parsed = this.parseInput(input);
    if (!parsed) return { ok: false, error: "格式: e2e4（起点终点）。升变加字母如 e7e8q。" };
    const ls = legal(this.s);
    let hit = ls.find(m => m.fr === parsed.fr && m.fc === parsed.fc && m.tr === parsed.tr && m.tc === parsed.tc);
    if (!hit) return { ok: false, error: `${input} 不合法。` };
    if (parsed.promo && hit.promo) hit = { ...hit, promo: parsed.promo };

    this.s = ap(this.s, hit);
    this.log.push(sq(hit.fr, hit.fc) + sq(hit.tr, hit.tc));
    this.ckEnd();
    if (this.s.over) return { ok: true };

    const depthMap = { easy: 1, medium: 2, hard: 3 };
    const ai = best(this.s, depthMap[this.difficulty]);
    if (!ai) { this.ckEnd(); return { ok: true }; }
    this.s = ap(this.s, ai);
    const as = sq(ai.fr, ai.fc) + sq(ai.tr, ai.tc);
    this.log.push(as);
    this.ckEnd();
    return { ok: true, ai: as };
  }

  ckEnd() {
    if (this.s.over) return;
    if (!legal(this.s).length) {
      this.s.over = true;
      this.s.res = chk(this.s, this.s.t) ? (this.s.t === 'w' ? "黑方胜（将杀）" : "白方胜（将杀）") : "和棋（逼和）";
    }
  }

  resign() { this.s.over = true; this.s.res = "认输 — 黑方胜"; }

  toJSON() { return { b: this.s.b, t: this.s.t, cs: this.s.cs, ep: this.s.ep, over: this.s.over, res: this.s.res, log: this.log, difficulty: this.difficulty }; }
  static fromJSON(j: any): ChessGame { const g = new ChessGame(); if (j) { g.s.b = j.b; g.s.t = j.t; g.s.cs = j.cs; g.s.ep = j.ep; g.s.over = j.over; g.s.res = j.res; g.log = j.log || []; g.difficulty = j.difficulty || 'medium'; } return g; }

  render(): string {
    const lines = ["  a b c d e f g h"];
    for (let r = 0; r < 8; r++) lines.push(`${8 - r} ${this.s.b[r].map(p => p || '.').join(' ')} ${8 - r}`);
    lines.push("  a b c d e f g h");
    return lines.join("\n");
  }

  screen(): string {
    const diffLabels = { easy: '简单', medium: '中等', hard: '困难' };
    const lines = [`═══ 国际象棋 · ${diffLabels[this.difficulty]} ═══`, "", this.render(), ""];
    if (this.s.over) {
      lines.push(`结果: ${this.s.res}`);
      lines.push("「新局」重开，「菜单」回 Steam");
    } else {
      if (chk(this.s, this.s.t)) lines.push("  将军！");
      lines.push("你执白，轮到你走。输入走法（如 e2e4）");
      lines.push("「新局 简单/中等/困难」切换难度");
      lines.push("「认输」放弃，「菜单」回 Steam");
    }
    if (this.log.length) lines.push("", `近步: ${this.log.slice(-8).join(" ")}`);
    return lines.join("\n");
  }
}
