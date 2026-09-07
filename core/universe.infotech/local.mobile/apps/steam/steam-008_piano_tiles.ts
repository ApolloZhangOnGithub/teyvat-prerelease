// steam/piano-tiles.ts — 别踩白块儿（节奏游戏 / LLM 反应速度 benchmark）
// 4 列，每轮随机一列出现黑块，agent 必须在限时内点对列。
// 节奏随分数加快。支持难度选择。

export type PianoTilesDifficulty = 'easy' | 'normal' | 'hard';

interface DiffConfig {
  startMs: number;
  stepPerScore: number;  // 每 N 分降一次
  dropMs: number;        // 每次降多少 ms
  floorMs: number;
}
const DIFF: Record<PianoTilesDifficulty, DiffConfig> = {
  easy:   { startMs: 5000, stepPerScore: 5, dropMs: 100, floorMs: 300 },
  normal: { startMs: 3000, stepPerScore: 5, dropMs: 150, floorMs: 200 },
  hard:   { startMs: 1500, stepPerScore: 3, dropMs: 200, floorMs: 200 },
};

export class PianoTiles {
  score: number;
  over: boolean;
  combo: number;
  bestScore: number;
  currentTile: number;
  tileStartTime: number;
  timeLimit: number;
  started: boolean;
  difficulty: PianoTilesDifficulty;
  _difficultyChosen: boolean;  // 是否已选难度
  private personId: string = '';
  private static personIdStatic: string = '';

  constructor(difficulty: PianoTilesDifficulty = 'easy') {
    this.score = 0;
    this.over = false;
    this.combo = 0;
    this.bestScore = 0;
    this.currentTile = Math.floor(Math.random() * 4);
    this.tileStartTime = 0;
    this.difficulty = difficulty;
    this._difficultyChosen = false;
    const cfg = DIFF[difficulty];
    this.timeLimit = cfg.startMs;
    this.started = false;
  }

  /** 设难度（用游戏内输入选择） */
  chooseDifficulty(diff: PianoTilesDifficulty) {
    this.difficulty = diff;
    this._difficultyChosen = true;
    const cfg = DIFF[diff];
    this.timeLimit = cfg.startMs;
    this.currentTile = Math.floor(Math.random() * 4);
  }

  static setPersonId(pid: string) { PianoTiles.personIdStatic = pid; }

  static savePath(): string {
    return `${homedir()}/.teyvat/MemoryData/${PianoTiles.personIdStatic}/piano-tiles.json`;
  }

  static loadBest(): number {
    try { return JSON.parse(readFileSync(PianoTiles.savePath(), 'utf8')).best || 0; } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam-008_piano_tiles.ts] " + ((e as any)?.message || e)); return 0; }
  }

  saveBest() {
    try { writeFileSync(PianoTiles.savePath(), JSON.stringify({ best: this.bestScore })); } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam-008_piano_tiles.ts] " + ((e as any)?.message || e)); }
  }

  private calcLimit(score: number): number {
    const cfg = DIFF[this.difficulty];
    return Math.max(cfg.floorMs, cfg.startMs - Math.floor(score / cfg.stepPerScore) * cfg.dropMs);
  }

  /** 点一列。难度没选时，先处理难度输入 */
  tap(colOrInput: any): { hit: boolean; timedOut: boolean; ms: number; needScreen?: boolean } {
    // 还没选难度——检查是不是难度输入
    if (!this._difficultyChosen) {
      const input = String(colOrInput).trim();
      const diffMap: Record<string, PianoTilesDifficulty> = { '简单': 'easy', '普通': 'normal', '困难': 'hard', 'easy': 'easy', 'normal': 'normal', 'hard': 'hard' };
      const diff = diffMap[input.toLowerCase()];
      if (diff) {
        this.chooseDifficulty(diff);
        return { hit: true, timedOut: false, ms: 0, needScreen: true };
      }
      return { hit: false, timedOut: false, ms: 0, needScreen: true };
    }
    const col = typeof colOrInput === 'number' ? colOrInput : parseInt(String(colOrInput), 10);
    if (isNaN(col)) return { hit: false, timedOut: false, ms: 0 };
    if (this.over) return { hit: false, timedOut: true, ms: 0 };
    if (!this.started) { this.started = true; this.tileStartTime = Date.now(); }
    const elapsed = Date.now() - this.tileStartTime;
    // 先检查超时
    if (elapsed > this.timeLimit) {
      this.over = true;
      this.bestScore = Math.max(this.bestScore, this.score);
      this.saveBest();
      return { hit: false, timedOut: true, ms: elapsed };
    }
    // 点对了
    if (col === this.currentTile) {
      this.score++;
      this.combo++;
      this.bestScore = Math.max(this.bestScore, this.score);
      // 出新块
      this.currentTile = Math.floor(Math.random() * 4);
      this.tileStartTime = Date.now();
      this.timeLimit = this.calcLimit(this.score);
      return { hit: true, timedOut: false, ms: elapsed };
    }
    // 点错了
    this.over = true;
    this.bestScore = Math.max(this.bestScore, this.score);
    this.saveBest();
    return { hit: false, timedOut: false, ms: elapsed };
  }

  /** 检查是否已经超时（agent 看画面时可能已经超时了） */
  checkTimeout(): boolean {
    if (this.over) return true;
    if (Date.now() - this.tileStartTime > this.timeLimit) {
      this.over = true;
      this.bestScore = Math.max(this.bestScore, this.score);
      this.saveBest();
      return true;
    }
    return false;
  }

  static subMenu(): string {
    return [
      '🎵 别踩白块儿 — 难度选择',
      '',
      '  简单  — 5000ms 起，每 5 分 −100ms，底 300ms',
      '  普通  — 3000ms 起，每 5 分 −150ms，底 200ms',
      '  困难  — 1500ms 起，每 3 分 −200ms，底 200ms',
      '',
      '输入 简单/普通/困难 开始',
      '输入 返回 回菜单',
    ].join('\n');
  }

  screen(): string {
    // 还没选难度 → 显示难度选择
    if (!this._difficultyChosen) {
      return [
        '🎵 别踩白块儿 — 难度选择',
        '',
        '  简单  — 5000ms 起，每 5 分 −100ms',
        '  普通  — 3000ms 起，每 5 分 −150ms',
        '  困难  — 1500ms 起，每 3 分 −200ms',
        '',
        '输入 简单/普通/困难 开始',
        '输入 返回 回菜单',
      ].join('\n');
    }
    if (!this.started) { this.started = true; this.tileStartTime = Date.now(); }
    if (this.checkTimeout()) {
      return this.gameOverScreen('⏰ 超时！');
    }
    const elapsed = Date.now() - this.tileStartTime;
    const remaining = this.timeLimit - elapsed;
    const cols = ['①', '②', '③', '④'];
    const display: string[] = [];
    for (let row = 3; row >= 0; row--) {
      const line: string[] = [];
      for (let c = 0; c < 4; c++) {
        if (row === 0 && c === this.currentTile) line.push('⬛');
        else line.push('⬜');
      }
      display.push('  ' + line.join(' '));
    }
    const diffLabel = { easy: '简单', normal: '普通', hard: '困难' }[this.difficulty];
    return [
      `🎵 别踩白块儿 [${diffLabel}]  分数 ${this.score}  连击 ${this.combo}  最佳 ${this.bestScore}`,
      `⏱️ ${Math.max(0, remaining)}ms  (限时 ${this.timeLimit}ms)`,
      '',
      ...display,
      '',
      `点 ${cols[this.currentTile]} (输入 1-4)  | 返回`,
    ].join('\n');
  }

  gameOverScreen(reason: string): string {
    return [
      `💀 游戏结束  ${reason}`,
      `分数 ${this.score}  最佳 ${this.bestScore}`,
      '',
      this.score === this.bestScore && this.score > 0 ? '🏆 新纪录！' : '',
      '',
      '新局 / 返回',
    ].filter(Boolean).join('\n');
  }

  static fromJSON(data: any): PianoTiles {
    const g = Object.create(PianoTiles.prototype);
    Object.assign(g, data);
    g.timeLimit = g.timeLimit || 2000;
    g.tileStartTime = g.tileStartTime || Date.now();
    g.currentTile = g.currentTile ?? Math.floor(Math.random() * 4);
    return g;
  }
}

import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { logerr } from "#paths";
