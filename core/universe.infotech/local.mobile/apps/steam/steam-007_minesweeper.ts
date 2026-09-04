// steam/minesweeper.ts — 扫雷

interface Cell {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  adjacent: number; // 周围雷数
}

export interface SweeperResult {
  ok: boolean;
  error?: string;
  win?: boolean;
}

export class MinesweeperGame {
  grid: Cell[][];
  rows: number;
  cols: number;
  mines: number;
  over: boolean;
  won: boolean;
  firstMove: boolean;
  flagMode: boolean; // toggle: reveal vs flag
  revealed: number;

  constructor(rows = 9, cols = 9, mines = 10) {
    this.rows = Math.min(20, Math.max(5, rows));
    this.cols = Math.min(30, Math.max(5, cols));
    this.mines = Math.min(mines, this.rows * this.cols - 1);
    this.over = false;
    this.won = false;
    this.firstMove = true;
    this.flagMode = false;
    this.revealed = 0;
    this.grid = this.#initGrid();
    this.#placeMines(); // 首次点击时可能会重新布雷，所以先布雷也没关系
  }

  #initGrid(): Cell[][] {
    return Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => ({
        mine: false, revealed: false, flagged: false, adjacent: 0,
      }))
    );
  }

  #placeMines(excludeR?: number, excludeC?: number) {
    const total = this.rows * this.cols;
    const exclude = excludeR !== undefined ? [`${excludeR},${excludeC}`] : [];
    // 排除首点及其周围
    if (excludeR !== undefined && excludeC !== undefined) {
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = excludeR + dr, nc = excludeC + dc;
          if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols)
            exclude.push(`${nr},${nc}`);
        }
    }

    const candidates: number[] = [];
    for (let i = 0; i < total; i++) {
      const r = Math.floor(i / this.cols), c = i % this.cols;
      if (!exclude.includes(`${r},${c}`)) candidates.push(i);
    }

    // 随机选 mines 个
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    for (const idx of candidates.slice(0, this.mines)) {
      const r = Math.floor(idx / this.cols), c = idx % this.cols;
      this.grid[r][c].mine = true;
    }

    // 算 adjacent count
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c].mine) continue;
        let count = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols && this.grid[nr][nc].mine)
              count++;
          }
        this.grid[r][c].adjacent = count;
      }
  }

  reveal(row: number, col: number): SweeperResult {
    if (this.over) return { ok: false, error: "游戏已结束。「新局」重开。" };
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols)
      return { ok: false, error: `坐标超出范围（${this.rows}x${this.cols}）。` };

    let cell = this.grid[row][col];
    if (cell.flagged) return { ok: false, error: "该格已插旗，先取消旗帜。" };
    if (cell.revealed) return { ok: false, error: "该格已翻开。" };

    // 首点：确保不是雷
    if (this.firstMove) {
      this.firstMove = false;
      if (cell.mine) {
        // 重新布雷，排除此格
        this.grid = this.#initGrid();
        this.#placeMines(row, col);
        // 重新获取新 grid 的 cell 引用，否则 cell 仍指向旧 grid（mine=true）导致误报踩雷
        cell = this.grid[row][col];
      }
    }

    if (cell.mine) {
      // 踩雷，全部翻开
      cell.revealed = true;
      this.over = true;
      this.won = false;
      for (const r of this.grid)
        for (const c of r)
          if (c.mine) c.revealed = true;
      return { ok: true, win: false };
    }

    // 安全格，展开
    this.#floodFill(row, col);

    // 检查胜利
    if (this.revealed >= this.rows * this.cols - this.mines) {
      this.over = true;
      this.won = true;
      return { ok: true, win: true };
    }

    return { ok: true };
  }

  #floodFill(r: number, c: number) {
    const stack: [number, number][] = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop()!;
      const cell = this.grid[cr][cc];
      if (cell.revealed || cell.flagged || cell.mine) continue;
      cell.revealed = true;
      this.revealed++;
      if (cell.adjacent === 0) {
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = cr + dr, nc = cc + dc;
            if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols)
              stack.push([nr, nc]);
          }
      }
    }
  }

  flag(row: number, col: number): SweeperResult {
    if (this.over) return { ok: false, error: "游戏已结束。" };
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols)
      return { ok: false, error: "坐标超出范围。" };
    const cell = this.grid[row][col];
    if (cell.revealed) return { ok: false, error: "该格已翻开，不能插旗。" };
    cell.flagged = !cell.flagged;
    return { ok: true };
  }

  // 快速翻开：输入坐标直接翻
  action(row: number, col: number, isFlag: boolean): SweeperResult {
    if (isFlag) return this.flag(row, col);
    // 如果已翻开且有周围雷数，执行快速翻开（chord）：翻周围未标记格
    const cell = this.grid[row][col];
    if (cell.revealed && cell.adjacent > 0) {
      let flagCount = 0;
      const toReveal: [number, number][] = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = row + dr, nc = col + dc;
          if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
            if (this.grid[nr][nc].flagged) flagCount++;
            else if (!this.grid[nr][nc].revealed) toReveal.push([nr, nc]);
          }
        }
      if (flagCount === cell.adjacent) {
        for (const [nr, nc] of toReveal) {
          const res = this.reveal(nr, nc);
          if (!res.ok || res.win !== undefined) return res;
        }
        return { ok: true };
      }
      return { ok: false, error: "旗帜数量不对，不能快速翻开。" };
    }
    return this.reveal(row, col);
  }

  screen(): string {
    const lines = [`═══ 扫雷 ═══`, ''];
    lines.push(`雷: ${this.mines} | 已翻: ${this.revealed} | 剩余: ${this.rows * this.cols - this.mines - this.revealed}`);
    lines.push('');

    // 顶部列号
    let header = '   ';
    for (let c = 0; c < this.cols; c++) header += c.toString().padStart(2).slice(-1) + ' ';
    lines.push(header);

    for (let r = 0; r < this.rows; r++) {
      let row = r.toString().padStart(2) + ' ';
      for (let c = 0; c < this.cols; c++) {
        const cell = this.grid[r][c];
        if (this.over && cell.mine) {
          row += cell.revealed ? '💥' : '💣';
        } else if (cell.flagged) {
          row += '🚩';
        } else if (!cell.revealed) {
          row += '⬜';
        } else if (cell.mine) {
          row += '💣';
        } else if (cell.adjacent === 0) {
          row += '  ';
        } else {
          row += ' ' + cell.adjacent.toString();
        }
      }
      lines.push(row);
    }

    lines.push('');
    if (this.over) {
      lines.push(this.won ? '🎉 你赢了！' : '💥 踩雷了！');
      lines.push('「新局」重开，「菜单」回 Steam');
    } else {
      lines.push('「行 列」翻开 | 「f 行 列」插旗');
      lines.push('如「3 4」翻开(3,4)，「f 3 4」插旗');
      lines.push('数字格上直接输入坐标可快速翻开周围');
    }
    return lines.join('\n');
  }

  toJSON() {
    return {
      grid: this.grid, rows: this.rows, cols: this.cols, mines: this.mines,
      over: this.over, won: this.won, firstMove: this.firstMove, revealed: this.revealed,
    };
  }

  static fromJSON(j: ReturnType<MinesweeperGame['toJSON']>): MinesweeperGame {
    const g = Object.create(MinesweeperGame.prototype);
    g.grid = j.grid; g.rows = j.rows; g.cols = j.cols; g.mines = j.mines;
    g.over = j.over; g.won = j.won; g.firstMove = j.firstMove; g.revealed = j.revealed;
    return g;
  }
}
