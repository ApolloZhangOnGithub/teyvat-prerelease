// steam/gomoku.ts — 五子棋（minimax AI，15x15 棋盘，可分难度）

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logerr } from "#paths";

// ── 联机 fetch ──
function serverUrl(): string {
  if (process.env.GAME_SERVER_URL) return process.env.GAME_SERVER_URL;
  try {
    const port = readFileSync(join(homedir(), ".teyvat/RuntimeCache/game-server-port"), "utf8").trim();
    if (port) return `http://localhost:${port}`;
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam-006_gomoku.ts] " + ((e as any)?.message || e)); }
  return "http://localhost:19223";
}
async function gomokuPost(path: string, body: any): Promise<any> {
  const r = await fetch(`${serverUrl()}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`server: ${r.status}`);
  return r.json();
}
async function gomokuGet(path: string): Promise<any> {
  const r = await fetch(`${serverUrl()}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`server: ${r.status}`);
  return r.json();
}

export const gomokuOnline = {
  create: (playerName: string) => gomokuPost("/gomoku/create", { playerName }),
  join: (matchId: string, playerName: string) => gomokuPost("/gomoku/join", { matchId, playerName }),
  move: (matchId: string, token: string, row: number, col: number) => gomokuPost("/gomoku/move", { matchId, token, row, col }),
  get: (matchId: string) => gomokuGet(`/gomoku/${matchId}`),
  list: () => gomokuGet("/gomoku/list"),
};


export type GomokuDifficulty = 'easy' | 'medium' | 'hard';
const DIFF_DEPTH: Record<GomokuDifficulty, number> = { easy: 2, medium: 3, hard: 4 };
const DIFF_RANDOM: Record<GomokuDifficulty, number> = { easy: 0.4, medium: 0.1, hard: 0 }; // 随机选非最优步的概率

export interface GomokuResult { ok: boolean; error?: string; ai?: string }

const SIZE = 15;
const WIN = 5;

// 方向增量（4个方向：水平、垂直、对角1、对角2）
const DIRS: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];

function inBoard(r: number, c: number): boolean {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// 评估函数：对每种棋形打分
// 连五、活四、冲四、活三、眠三、活二...
function evalPattern(count: number, openEnds: number, player: number): number {
  if (count >= 5) return 1000000;
  if (count === 4) {
    if (openEnds === 2) return 50000;   // 活四
    if (openEnds === 1) return 5000;    // 冲四
  }
  if (count === 3) {
    if (openEnds === 2) return 5000;    // 活三
    if (openEnds === 1) return 500;     // 眠三
  }
  if (count === 2) {
    if (openEnds === 2) return 500;     // 活二
    if (openEnds === 1) return 50;      // 眠二
  }
  if (count === 1) {
    if (openEnds === 2) return 50;      // 活一
    if (openEnds === 1) return 5;       // 眠一
  }
  return 0;
}

function evalBoard(board: number[][], player: number): number {
  let score = 0;
  const visited = new Set<string>();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== player) continue;
      for (const [dr, dc] of DIRS) {
        const key = `${r},${c},${dr},${dc}`;
        if (visited.has(key)) continue;

        // 往前找连续长度
        let count = 1;
        let nr = r + dr, nc = c + dc;
        while (inBoard(nr, nc) && board[nr][nc] === player) {
          visited.add(`${nr},${nc},${dr},${dc}`);
          count++;
          nr += dr; nc += dc;
        }
        const open1 = inBoard(nr, nc) && board[nr][nc] === 0 ? 1 : 0;

        // 往后找
        nr = r - dr; nc = c - dc;
        while (inBoard(nr, nc) && board[nr][nc] === player) {
          visited.add(`${nr},${nc},${dr},${dc}`);
          count++;
          nr -= dr; nc -= dc;
        }
        const open2 = inBoard(nr, nc) && board[nr][nc] === 0 ? 1 : 0;

        score += evalPattern(count, open1 + open2, player);
        if (count >= 5) return 1000000;
      }
    }
  }
  return score;
}

function evalFull(board: number[][]): number {
  // player = 1 (黑子) 最大化, player = 2 (白子/AI) 最小化
  return evalBoard(board, 2) - evalBoard(board, 1) * 1.1; // 给先手稍微加点权重
}

function getMoves(board: number[][], radius: number = 2): [number, number][] {
  const candidates: [number, number][] = [];
  const near = new Set<string>();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== 0) {
        for (let dr = -radius; dr <= radius; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            const nr = r + dr, nc = c + dc;
            if (inBoard(nr, nc) && board[nr][nc] === 0) {
              near.add(`${nr},${nc}`);
            }
          }
        }
      }
    }
  }

  for (const key of near) {
    const [r, c] = key.split(',').map(Number);
    candidates.push([r, c]);
  }

  if (candidates.length === 0) {
    // 空棋盘：下中心
    return [[7, 7]];
  }

  // 按位置打分排序（启发式：离中心越近越好）
  candidates.sort((a, b) => {
    const ca = Math.abs(a[0] - 7) + Math.abs(a[1] - 7);
    const cb = Math.abs(b[0] - 7) + Math.abs(b[1] - 7);
    return ca - cb;
  });

  return candidates.slice(0, 30); // 最多考虑30个候选
}

function minimax(
  board: number[][],
  depth: number,
  alpha: number,
  beta: number,
  isMax: boolean // true = AI (player 2), false = human (player 1)
): number {
  if (depth === 0) return evalFull(board);

  const moves = getMoves(board);
  if (moves.length === 0) return 0;

  if (isMax) {
    let best = -Infinity;
    for (const [r, c] of moves) {
      board[r][c] = 2; // AI
      // 快速win检测
      if (evalBoard(board, 2) >= 1000000) {
        board[r][c] = 0;
        return 1000000 + depth;
      }
      const v = minimax(board, depth - 1, alpha, beta, false);
      board[r][c] = 0;
      best = Math.max(best, v);
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const [r, c] of moves) {
      board[r][c] = 1; // human
      if (evalBoard(board, 1) >= 1000000) {
        board[r][c] = 0;
        return -(1000000 + depth);
      }
      const v = minimax(board, depth - 1, alpha, beta, true);
      board[r][c] = 0;
      best = Math.min(best, v);
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

function aiMove(board: number[][], depth: number = 4): [number, number] | null {
  const moves = getMoves(board);
  if (moves.length === 0) return null;

  let bestMove = moves[0];
  let bestScore = -Infinity;
  const alpha = -Infinity;
  const beta = Infinity;

  for (const [r, c] of moves) {
    board[r][c] = 2;
    // 立即胜利
    if (evalBoard(board, 2) >= 1000000) {
      board[r][c] = 0;
      return [r, c];
    }
    const score = minimax(board, depth - 1, alpha, beta, false);
    board[r][c] = 0;
    if (score > bestScore) {
      bestScore = score;
      bestMove = [r, c];
    }
  }

  return bestMove;
}

function checkWin(board: number[][], r: number, c: number): boolean {
  const player = board[r][c];
  if (player === 0) return false;

  for (const [dr, dc] of DIRS) {
    let count = 1;
    for (let i = 1; i < WIN; i++) {
      const nr = r + dr * i, nc = c + dc * i;
      if (inBoard(nr, nc) && board[nr][nc] === player) count++;
      else break;
    }
    for (let i = 1; i < WIN; i++) {
      const nr = r - dr * i, nc = c - dc * i;
      if (inBoard(nr, nc) && board[nr][nc] === player) count++;
      else break;
    }
    if (count >= WIN) return true;
  }
  return false;
}

function isFull(board: number[][]): boolean {
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      if (board[r][c] === 0) return false;
  return true;
}

export type GomokuMode = 'ai' | 'online';

export class GomokuGame {
  board: number[][];   // 0=空, 1=黑(玩家), 2=白(AI)
  turn: 1 | 2;
  over: boolean;
  winner: number;       // 0=无, 1=黑胜, 2=白胜
  lastMove: [number, number] | null;
  moveCount: number;
  difficulty: GomokuDifficulty;
  mode: GomokuMode;
  // 联机字段
  matchId: string;
  token: string;
  myColor: 1 | 2;       // 本 agent 的棋子颜色
  onlineMsg: string;     // 上次服务器返回的消息
  players: string[];      // [黑方名, 白方名]
  opponent: string;       // 对手名

  constructor(difficulty: GomokuDifficulty = 'medium') {
    this.board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    this.turn = 1;  // 玩家先手（黑）
    this.over = false;
    this.winner = 0;
    this.lastMove = null;
    this.moveCount = 0;
    this.difficulty = difficulty;
    this.mode = 'ai';
    this.matchId = '';
    this.token = '';
    this.myColor = 1;
    this.onlineMsg = '';
    this.players = ['', ''];
    this.opponent = '';
  }

  /** 创建联机对局（我是黑方/创建者） */
  static onlineNew(matchId: string, token: string): GomokuGame {
    const g = new GomokuGame();
    g.mode = 'online';
    g.matchId = matchId;
    g.token = token;
    g.myColor = 1;
    g.onlineMsg = `对局码: ${matchId} | 等待对手加入...`;
    return g;
  }

  /** 加入联机对局（我是白方/加入者） */
  static onlineJoin(matchId: string, token: string): GomokuGame {
    const g = new GomokuGame();
    g.mode = 'online';
    g.matchId = matchId;
    g.token = token;
    g.myColor = 2;
    g.onlineMsg = `已加入 ${matchId}，执白。等待黑方走棋...`;
    return g;
  }

  /** 子菜单 */
  static subMenu(): string {
    return ["═══ 五子棋 ═══", "", "  AI 对战    — 新局", "  联机大厅    — 大厅", "", "「返回」回 Steam"].join("\n");
  }

  /** 大厅界面 */
  static lobbyScreen(matches: { id: string; players: number }[]): string {
    const lines = ["═══ 五子棋 · 联机大厅 ═══", ""];
    if (!matches || matches.length === 0) {
      lines.push("  (暂无房间)");
    } else {
      lines.push("  房间号    状态");
      for (const m of matches) {
        lines.push(`  ${m.id}      等待中 (${m.players}/2)`);
      }
    }
    lines.push("", "「创建」开新房间", "「加入 <码>」进入房间", "「刷新」刷新列表", "「返回」回菜单");
    return lines.join("\n");
  }

  /** 用服务器状态刷新本地棋盘 */
  syncFromServer(board: number[][], turn: 1 | 2, winner: 0 | 1 | 2, lastMove: [number, number] | null, moves: number, players?: string[]) {
    this.board = board.map(r => [...r]);
    this.turn = turn;
    this.winner = winner;
    this.over = winner !== 0 || board.every(r => r.every(c => c !== 0));
    this.lastMove = lastMove;
    this.moveCount = moves;
    if (players) {
      this.players = players;
      this.opponent = this.myColor === 1 ? (players[1] || '白方') : (players[0] || '黑方');
    }
    if (this.over) {
      if (winner === this.myColor) this.onlineMsg = '🎉 你赢了！';
      else if (winner === 0) this.onlineMsg = '平局！';
      else this.onlineMsg = `${this.opponent} 赢了！`;
    } else if (turn === this.myColor) {
      this.onlineMsg = `轮到你走棋 (对手: ${this.opponent})`;
    } else {
      this.onlineMsg = `等待 ${this.opponent} 走棋...`;
    }
  }

  place(row: number, col: number): GomokuResult {
    if (this.over) return { ok: false, error: "游戏已结束。「新局」重开。" };
    if (this.turn !== 1) return { ok: false, error: "等待 AI 走棋..." };
    if (!inBoard(row, col)) return { ok: false, error: `坐标超出范围（0-${SIZE - 1}）。` };
    if (this.board[row][col] !== 0) return { ok: false, error: "该位置已有棋子。" };

    // 玩家落子
    this.board[row][col] = 1;
    this.lastMove = [row, col];
    this.moveCount++;

    if (checkWin(this.board, row, col)) {
      this.over = true;
      this.winner = 1;
      return { ok: true };
    }
    if (isFull(this.board)) {
      this.over = true;
      return { ok: true };
    }

    // AI 走
    this.turn = 2;
    const depth = DIFF_DEPTH[this.difficulty];
    const rng = DIFF_RANDOM[this.difficulty];
    let move: [number, number] | null;
    if (rng > 0 && Math.random() < rng) {
      // 随机选一步（非最优），降低难度
      const allMoves = getMoves(this.board);
      const goodMoves = allMoves.slice(0, Math.max(5, Math.floor(allMoves.length * 0.4)));
      move = goodMoves[Math.floor(Math.random() * goodMoves.length)];
    } else {
      move = aiMove(this.board, depth);
    }
    if (move) {
      const [ar, ac] = move;
      this.board[ar][ac] = 2;
      this.lastMove = [ar, ac];
      this.moveCount++;

      if (checkWin(this.board, ar, ac)) {
        this.over = true;
        this.winner = 2;
        return { ok: true, ai: `${ar},${ac}` };
      }
      if (isFull(this.board)) {
        this.over = true;
        return { ok: true, ai: `${ar},${ac}` };
      }
    }

    this.turn = 1;
    return { ok: true, ai: move ? `${move[0]},${move[1]}` : '无' };
  }

  screen(): string {
    const colLabels = '    ' + Array.from({ length: SIZE }, (_, i) => i.toString().padStart(2)).join('');
    const lines: string[] = [];
    if (this.mode === 'online') {
      lines.push(`═══ 五子棋 · 联机 ═══`);
      lines.push(`对局 ${this.matchId}`);
      const blackTag = this.myColor === 1 ? '● 你(黑)' : `● ${this.players[0] || '黑方'}`;
      const whiteTag = this.myColor === 2 ? '○ 你(白)' : `○ ${this.players[1] || '白方'}`;
      lines.push(`${blackTag}  vs  ${whiteTag}`);
      if (this.winner === 0 && !this.over) {
        lines.push(`当前: ${this.turn === 1 ? '● 黑方走棋' : '○ 白方走棋'}`);
      }
    } else {
      const diffLabels: Record<GomokuDifficulty, string> = { easy: '简单', medium: '中等', hard: '困难' };
      lines.push(`═══ 五子棋 · ${diffLabels[this.difficulty]} ═══`);
    }
    lines.push('');
    lines.push(colLabels);

    for (let r = 0; r < SIZE; r++) {
      let row = r.toString().padStart(3) + ' ';
      for (let c = 0; c < SIZE; c++) {
        const v = this.board[r][c];
        if (v === 1) row += ' ●';
        else if (v === 2) row += ' ○';
        else if (r === 7 && c === 7) row += ' ┼'; // 天元
        else row += ' ·';
      }
      lines.push(row);
    }

    lines.push('');
    if (this.mode === 'online') {
      lines.push(this.onlineMsg);
      if (this.over) {
        lines.push('「新局」重开，「菜单」回 Steam');
      } else if (this.turn === this.myColor) {
        if (this.lastMove) lines.push(`对手走: (${this.lastMove[0]},${this.lastMove[1]})`);
        lines.push('输入坐标: <行> <列>（如 7 7 = 天元）');
      }
      lines.push('「刷新」同步棋盘');
    } else {
      if (this.over) {
        const msg = this.winner === 1 ? '🎉 你赢了！' : this.winner === 2 ? 'AI 赢了！' : '平局！';
        lines.push(msg);
        lines.push('「新局」重开，「菜单」回 Steam');
      } else {
        lines.push(`第 ${this.moveCount + 1} 手 · 轮到你（● 黑子）`);
        if (this.lastMove && this.moveCount > 0) {
          lines.push(`上步 AI: (${this.lastMove[0]},${this.lastMove[1]})`);
        }
        lines.push('输入坐标: <行> <列>（如 7 7 = 天元）');
        lines.push('「新局 简单/中等/困难」切换难度');
      }
    }
    return lines.join('\n');
  }

  toJSON() {
    return {
      board: this.board, turn: this.turn, over: this.over, winner: this.winner,
      lastMove: this.lastMove, moveCount: this.moveCount, difficulty: this.difficulty,
      mode: this.mode, matchId: this.matchId, token: this.token, myColor: this.myColor,
      onlineMsg: this.onlineMsg, players: this.players, opponent: this.opponent,
    };
  }

  static fromJSON(j: ReturnType<GomokuGame['toJSON']>): GomokuGame {
    const g = Object.create(GomokuGame.prototype);
    g.board = j.board; g.turn = j.turn; g.over = j.over; g.winner = j.winner;
    g.lastMove = j.lastMove; g.moveCount = j.moveCount;
    g.difficulty = j.difficulty || 'medium';
    g.mode = j.mode || 'ai';
    g.matchId = j.matchId || '';
    g.token = j.token || '';
    g.myColor = j.myColor || 1;
    g.onlineMsg = j.onlineMsg || '';
    g.players = j.players || ['', ''];
    g.opponent = j.opponent || '';
    return g;
  }
}
