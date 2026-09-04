// steam/snake.ts — 贪吃蛇（时间驱动：每次查看自动推进，反应慢就死）

export type Dir = 'u' | 'd' | 'l' | 'r';
const W = 20, H = 15;
const TICK_MS = 400; // 每 400ms 走一步（手机操作延迟友好）

const DIR_DELTA: Record<Dir, [number, number]> = { u: [-1, 0], d: [1, 0], l: [0, -1], r: [0, 1] };

export class SnakeGame {
  body: [number, number][];
  dir: Dir;
  food: [number, number];
  over: boolean;
  score: number;
  lastTick: number; // Date.now()
  started: boolean; // 收到第一次输入后才开始计时

  constructor() {
    const cy = Math.floor(H / 2);
    this.body = [[cy, 4], [cy, 3], [cy, 2]];
    this.dir = 'r';
    this.score = 0;
    this.over = false;
    this.food = this.#spawnFood();
    this.lastTick = Date.now();
    this.started = false;
  }

  #spawnFood(): [number, number] {
    const bodySet = new Set(this.body.map(([r, c]) => `${r},${c}`));
    const free: [number, number][] = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (!bodySet.has(`${r},${c}`)) free.push([r, c]);
    return free.length ? free[Math.floor(Math.random() * free.length)] : [-1, -1];
  }

  input(dir: Dir) {
    if (this.over) return;
    // 第一次输入：从现在开始，不追旧账
    if (!this.started) { this.started = true; this.lastTick = Date.now(); }
    // 先追上时间，再改方向
    this.#catchUp();
    const opp: Record<Dir, Dir> = { u: 'd', d: 'u', l: 'r', r: 'l' };
    if (dir !== opp[this.dir]) this.dir = dir;
  }

  // 追赶流逝时间：每 TICK_MS 走一步（未开始时冻结）
  #catchUp() {
    if (!this.started) { this.lastTick = Date.now(); return; }
    const now = Date.now();
    const steps = Math.floor((now - this.lastTick) / TICK_MS);
    for (let i = 0; i < steps; i++) {
      if (this.over) break;
      this.#tick();
    }
    this.lastTick = now;
  }

  #tick() {
    const [dr, dc] = DIR_DELTA[this.dir];
    const [hr, hc] = this.body[0];
    const nr = hr + dr, nc = hc + dc;
    if (nr < 0 || nr >= H || nc < 0 || nc >= W) { this.over = true; return; }
    for (let i = 0; i < this.body.length - 1; i++) {
      if (this.body[i][0] === nr && this.body[i][1] === nc) { this.over = true; return; }
    }
    this.body.unshift([nr, nc]);
    if (nr === this.food[0] && nc === this.food[1]) {
      this.score += 10;
      this.food = this.#spawnFood();
    } else {
      this.body.pop();
    }
  }

  // 获取当前画面（先追时间）
  view(): string { this.#catchUp(); return this.#render(); }

  #render(): string {
    const grid: string[][] = Array.from({ length: H }, () => Array(W).fill(' '));
    for (let i = 0; i < this.body.length; i++) {
      const [r, c] = this.body[i];
      if (r >= 0 && r < H && c >= 0 && c < W) grid[r][c] = i === 0 ? '●' : '○';
    }
    const [fr, fc] = this.food;
    if (fr >= 0 && fr < H && fc >= 0 && fc < W) grid[fr][fc] = '★';
    const top = '┌' + '─'.repeat(W) + '┐';
    const bot = '└' + '─'.repeat(W) + '┘';
    const rows = grid.map(r => '│' + r.join('') + '│');
    return [top, ...rows, bot].join('\n');
  }

  screen(): string {
    this.#catchUp();
    const lines = ['═══ 贪吃蛇 ═══', '', this.#render(), ''];
    if (this.over) {
      lines.push(`游戏结束！得分: ${this.score}`);
      lines.push('「新局」重开，「菜单」回 Steam');
    } else {
      lines.push(`得分: ${this.score} | 每 ${TICK_MS}ms 走一步`);
      lines.push('方向: w上 s下 a左 d右');
      if (!this.started) lines.push('🐍 蛇在等你——输入方向开始！');
    }
    return lines.join('\n');
  }
}
