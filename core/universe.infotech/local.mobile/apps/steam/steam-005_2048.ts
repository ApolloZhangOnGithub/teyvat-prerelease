// steam/g2048.ts — 2048 拼图游戏

import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logerr } from "#paths";

export type Dir4 = 'u' | 'd' | 'l' | 'r';

export class G2048 {
  grid: number[][];
  score: number;
  over: boolean;
  won: boolean;
  private moved: boolean = false;
  private history: { grid: number[][]; score: number; over: boolean; won: boolean }[] = [];

  constructor() {
    this.grid = Array.from({ length: 4 }, () => Array(4).fill(0));
    this.score = 0;
    this.over = false;
    this.won = false;
    this.#spawn();
    this.#spawn();
  }

  #spawn() {
    const empty: [number, number][] = [];
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        if (this.grid[r][c] === 0) empty.push([r, c]);
    if (!empty.length) return;
    const [r, c] = empty[Math.floor(Math.random() * empty.length)];
    this.grid[r][c] = Math.random() < 0.9 ? 2 : 4;
  }

  #slide(row: number[]) {
    // compress: remove zeros
    let arr = row.filter(x => x !== 0);
    // merge
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i] === arr[i + 1]) {
        arr[i] *= 2;
        this.score += arr[i];
        if (arr[i] === 2048) this.won = true;
        arr.splice(i + 1, 1);
      }
    }
    // pad
    while (arr.length < 4) arr.push(0);
    return arr;
  }

  move(dir: Dir4): boolean {
    if (this.over) return false;
    // 保存状态用于撤回
    if (!this.history) this.history = [];
    this.history.push({
      grid: this.grid.map(r => [...r]),
      score: this.score,
      over: this.over,
      won: this.won,
    });
    const old = this.grid.map(r => [...r]);

    if (dir === 'l') {
      for (let r = 0; r < 4; r++) this.grid[r] = this.#slide(this.grid[r]);
    } else if (dir === 'r') {
      for (let r = 0; r < 4; r++) this.grid[r] = this.#slide([...this.grid[r]].reverse()).reverse();
    } else if (dir === 'u') {
      for (let c = 0; c < 4; c++) {
        const col = this.#slide([this.grid[0][c], this.grid[1][c], this.grid[2][c], this.grid[3][c]]);
        for (let r = 0; r < 4; r++) this.grid[r][c] = col[r];
      }
    } else if (dir === 'd') {
      for (let c = 0; c < 4; c++) {
        const col = this.#slide([this.grid[3][c], this.grid[2][c], this.grid[1][c], this.grid[0][c]]).reverse();
        for (let r = 0; r < 4; r++) this.grid[r][c] = col[r];
      }
    }

    this.moved = old.some((r, i) => r.some((v, j) => v !== this.grid[i][j]));
    if (this.moved) this.#spawn();

    // check game over
    if (!this.#canMove()) this.over = true;

    return this.moved;
  }

  undo(): string {
    if (this.history.length === 0) return "没有可撤回的步骤。";
    const prev = this.history.pop()!;
    this.grid = prev.grid;
    this.score = prev.score;
    this.over = prev.over;
    this.won = prev.won;
    return "已撤回上一步。";
  }

  #canMove(): boolean {
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) {
        if (this.grid[r][c] === 0) return true;
        if (c < 3 && this.grid[r][c] === this.grid[r][c + 1]) return true;
        if (r < 3 && this.grid[r][c] === this.grid[r + 1][c]) return true;
      }
    return false;
  }

  #cell(v: number): string {
    if (v === 0) return '     ';
    return v.toString().padStart(5);
  }

  screen(): string {
    const lines = ['═══ 2048 ═══', '', `得分: ${this.score}`, ''];
    lines.push('+' + '-'.repeat(22) + '+');
    for (const row of this.grid) {
      lines.push('| ' + row.map(v => this.#cell(v)).join(' ') + '|');
    }
    lines.push('+' + '-'.repeat(22) + '+');
    lines.push('');
    if (this.over) {
      lines.push('游戏结束！「新局」重开，「菜单」回 Steam');
    } else {
      if (this.won) lines.push('🎉 你达到 2048 了！继续玩或「新局」重开。');
      lines.push('方向: w↑ s↓ a← d→  撤回=undo | 新局=restart');
    }
    return lines.join('\n');
  }

  private static _personId = '';

  static setPersonId(id: string) { G2048._personId = id; }

  save(slot = 'auto'): string {
    try {
      const dir = join(homedir(), '.teyvat', 'AppData', G2048._personId, 'steam');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${slot}.json`), JSON.stringify({
        slot, ts: new Date().toISOString(),
        grid: this.grid, score: this.score, over: this.over, won: this.won,
      }));
      return `已保存到「${slot}」。`;
    } catch (e: any) { return '保存失败: ' + (e.message || String(e)); }
  }

  static load(slot = 'auto'): G2048 | null {
    try {
      const raw = readFileSync(join(homedir(), '.teyvat', 'AppData', G2048._personId, 'steam', `${slot}.json`), 'utf8');
      return G2048.fromJSON(JSON.parse(raw));
    } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam-005_2048.ts] " + ((e as any)?.message || e)); return null; }
  }

  static listSlots(): { slot: string; score: number; ts: string }[] {
    try {
      const dir = join(homedir(), '.teyvat', 'AppData', G2048._personId, 'steam');
      const result: { slot: string; score: number; ts: string }[] = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = readFileSync(join(dir, f), 'utf8');
          const j = JSON.parse(raw);
          result.push({ slot: j.slot || f.slice(0, -5), score: j.score ?? 0, ts: j.ts ?? '' });
        } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam-005_2048.ts] " + ((e as any)?.message || e)); }
      }
      return result.sort((a, b) => b.ts.localeCompare(a.ts));
    } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam-005_2048.ts] " + ((e as any)?.message || e)); return []; }
  }

  toJSON() {
    return { grid: this.grid, score: this.score, over: this.over, won: this.won };
  }

  static fromJSON(j: ReturnType<G2048['toJSON']>): G2048 {
    const g = new G2048();
    g.grid = j.grid;
    g.score = j.score;
    g.over = j.over;
    g.won = j.won;
    g.history = [];
    g.moved = false;
    return g;
  }
}
