// spy/engine.ts — 谁是卧底游戏引擎（纯逻辑，零 LLM，零 I/O）
// 所有状态变更通过方法调用，所有非法操作返回错误，不抛异常。

export interface WordPair { spy: string; civilian: string; hint?: string }

export interface Player {
  id: string;
  name: string;
  isSpy: boolean;
  word: string;
  alive: boolean;
  messageDescriptions: string[];
}

export type Phase = "describe" | "vote" | "end";
export type Winner = "spy" | "civilian" | null;

export interface VoteRecord { voter: string; target: string }
export interface RoundRecord {
  round: number;
  messageDescriptions: { player: string; text: string }[];
  votes: VoteRecord[];
  eliminated: string | null;
  tiebreak: boolean;
}

export interface GameState {
  phase: Phase;
  round: number;
  alivePlayers: string[];
  currentTurn: string | null;
  describeOrder: string[];
  describedThisRound: string[];
  votedThisRound: string[];
  winner: Winner;
  rounds: RoundRecord[];
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  state: GameState;
  message?: string;
}

const BUILTIN_WORDS: WordPair[] = [
  { spy: "薯条", civilian: "薯片" },
  { spy: "眼镜", civilian: "墨镜" },
  { spy: "牛奶", civilian: "豆浆" },
  { spy: "西瓜", civilian: "哈密瓜" },
  { spy: "口红", civilian: "唇膏" },
  { spy: "高铁", civilian: "动车" },
  { spy: "微信", civilian: "QQ" },
  { spy: "面包", civilian: "馒头" },
  { spy: "咖啡", civilian: "奶茶" },
  { spy: "蜡烛", civilian: "火把" },
  { spy: "护照", civilian: "身份证" },
  { spy: "沙发", civilian: "椅子" },
  { spy: "钢笔", civilian: "毛笔" },
  { spy: "足球", civilian: "篮球" },
  { spy: "医生", civilian: "护士" },
  { spy: "月亮", civilian: "太阳" },
  { spy: "空调", civilian: "风扇" },
  { spy: "地铁", civilian: "公交" },
  { spy: "饺子", civilian: "馄饨" },
  { spy: "雪碧", civilian: "七喜" },
];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class SpyGame {
  players: Player[] = [];
  phase: Phase = "describe";
  round = 1;
  describeOrder: string[] = [];
  describeIdx = 0;
  votes: VoteRecord[] = [];
  rounds: RoundRecord[] = [];
  currentRoundDescs: { player: string; text: string }[] = [];
  winner: Winner = null;
  wordPair: WordPair;

  constructor(playerNames: string[], spyCount = 1, wordPair?: WordPair) {
    if (playerNames.length < 3) throw new Error("至少 3 个玩家");
    if (spyCount >= playerNames.length) throw new Error("卧底数量必须少于玩家数");

    this.wordPair = wordPair ?? BUILTIN_WORDS[Math.floor(Math.random() * BUILTIN_WORDS.length)];
    const shuffled = shuffle(playerNames);
    const spyNames = new Set(shuffled.slice(0, spyCount));

    this.players = playerNames.map(name => ({
      id: name,
      name,
      isSpy: spyNames.has(name),
      word: spyNames.has(name) ? this.wordPair.spy : this.wordPair.civilian,
      alive: true,
      messageDescriptions: [],
    }));

    this.describeOrder = shuffle(this.alivePlayers().map(p => p.id));
  }

  private alivePlayers(): Player[] {
    return this.players.filter(p => p.alive);
  }

  private player(id: string): Player | undefined {
    return this.players.find(p => p.id === id);
  }

  getState(): GameState {
    return {
      phase: this.phase,
      round: this.round,
      alivePlayers: this.alivePlayers().map(p => p.id),
      currentTurn: this.phase === "describe" ? (this.describeOrder[this.describeIdx] ?? null) : null,
      describeOrder: this.describeOrder,
      describedThisRound: this.currentRoundDescs.map(d => d.player),
      votedThisRound: this.votes.map(v => v.voter),
      winner: this.winner,
      rounds: this.rounds,
    };
  }

  getPlayerView(playerId: string): string {
    const p = this.player(playerId);
    if (!p) return "错误：你不在这局游戏里。";

    const lines: string[] = [];
    lines.push(`═══ 谁是卧底 · 第 ${this.round} 轮 ═══`);
    lines.push(`你是: ${p.name} | 你的词: 「${p.word}」`);
    lines.push(`存活: ${this.alivePlayers().map(a => a.id).join(", ")} (${this.alivePlayers().length}人)`);
    lines.push("");

    if (this.phase === "describe") {
      lines.push(`── 描述阶段 ──`);
      if (this.currentRoundDescs.length > 0) {
        for (const d of this.currentRoundDescs) {
          lines.push(`  ${d.player}: "${d.text}"`);
        }
      }
      const currentTurn = this.describeOrder[this.describeIdx];
      if (currentTurn === playerId) {
        lines.push("");
        lines.push(`→ 轮到你描述。用你自己的话描述你的词，不要直接说出词语。`);
        lines.push(`  操作: describe <你的描述>`);
      } else if (currentTurn) {
        lines.push(`  等待 ${currentTurn} 描述...`);
      }
    } else if (this.phase === "vote") {
      lines.push(`── 投票阶段 ──`);
      lines.push(`本轮描述回顾:`);
      for (const d of this.currentRoundDescs) {
        lines.push(`  ${d.player}: "${d.text}"`);
      }
      lines.push("");
      if (this.votes.find(v => v.voter === playerId)) {
        lines.push(`你已投票。等待其他人...`);
        lines.push(`已投: ${this.votes.map(v => v.voter).join(", ")}`);
        const notYet = this.alivePlayers().filter(a => !this.votes.find(v => v.voter === a.id));
        if (notYet.length > 0) lines.push(`未投: ${notYet.map(a => a.id).join(", ")}`);
      } else {
        const candidates = this.alivePlayers().filter(a => a.id !== playerId).map(a => a.id);
        lines.push(`→ 投票淘汰一个你认为是卧底的人。`);
        lines.push(`  候选: ${candidates.join(", ")}`);
        lines.push(`  操作: vote <玩家名>`);
      }
    } else if (this.phase === "end") {
      lines.push(`══ 游戏结束 ══`);
      lines.push(`胜方: ${this.winner === "spy" ? "卧底" : "平民"}`);
      lines.push(`卧底词: 「${this.wordPair.spy}」 | 平民词: 「${this.wordPair.civilian}」`);
      lines.push(`卧底是: ${this.players.filter(p => p.isSpy).map(p => p.name).join(", ")}`);
    }

    if (this.rounds.length > 0 && this.phase !== "end") {
      lines.push("");
      lines.push(`── 历史 ──`);
      for (const r of this.rounds) {
        lines.push(`  第${r.round}轮: 淘汰 ${r.eliminated ?? "无"}${r.tiebreak ? " (平票重投)" : ""}`);
      }
    }

    return lines.join("\n");
  }

  toJSON() {
    return {
      players: this.players,
      phase: this.phase,
      round: this.round,
      describeOrder: this.describeOrder,
      describeIdx: this.describeIdx,
      votes: this.votes,
      rounds: this.rounds,
      currentRoundDescs: this.currentRoundDescs,
      winner: this.winner,
      wordPair: this.wordPair,
    };
  }

  static fromJSON(json: ReturnType<SpyGame['toJSON']>): SpyGame {
    const game = Object.create(SpyGame.prototype);
    game.players = json.players;
    game.phase = json.phase;
    game.round = json.round;
    game.describeOrder = json.describeOrder;
    game.describeIdx = json.describeIdx;
    game.votes = json.votes;
    game.rounds = json.rounds;
    game.currentRoundDescs = json.currentRoundDescs;
    game.winner = json.winner;
    game.wordPair = json.wordPair;
    return game;
  }

  describe(playerId: string, text: string): ActionResult {
    if (this.phase !== "describe") return { ok: false, error: "当前不是描述阶段。", state: this.getState() };
    if (!this.player(playerId)?.alive) return { ok: false, error: "你已被淘汰。", state: this.getState() };
    const currentTurn = this.describeOrder[this.describeIdx];
    if (currentTurn !== playerId) return { ok: false, error: `还没轮到你，当前轮到 ${currentTurn}。`, state: this.getState() };

    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "描述不能为空。", state: this.getState() };
    if (trimmed.includes(this.wordPair.spy) || trimmed.includes(this.wordPair.civilian)) {
      return { ok: false, error: "描述中不能包含任何玩家的词语！请重新描述。", state: this.getState() };
    }

    this.currentRoundDescs.push({ player: playerId, text: trimmed });
    this.player(playerId)!.messageDescriptions.push(trimmed);
    this.describeIdx++;

    if (this.describeIdx >= this.describeOrder.length) {
      this.phase = "vote";
      this.votes = [];
    }

    return { ok: true, state: this.getState(), message: `描述已记录。` };
  }

  vote(voterId: string, targetId: string): ActionResult {
    if (this.phase !== "vote") return { ok: false, error: "当前不是投票阶段。", state: this.getState() };
    if (!this.player(voterId)?.alive) return { ok: false, error: "你已被淘汰。", state: this.getState() };
    if (this.votes.find(v => v.voter === voterId)) return { ok: false, error: "你已经投过票了。", state: this.getState() };
    if (voterId === targetId) return { ok: false, error: "不能投自己。", state: this.getState() };
    const target = this.player(targetId);
    if (!target || !target.alive) return { ok: false, error: `${targetId} 不存在或已被淘汰。`, state: this.getState() };

    this.votes.push({ voter: voterId, target: targetId });

    if (this.votes.length >= this.alivePlayers().length) {
      return this.resolveVotes();
    }

    return { ok: true, state: this.getState(), message: `投票已记录。等待其他玩家投票。` };
  }

  private resolveVotes(): ActionResult {
    const counts: Record<string, number> = {};
    for (const v of this.votes) counts[v.target] = (counts[v.target] || 0) + 1;

    const maxVotes = Math.max(...Object.values(counts));
    const topPlayers = Object.entries(counts).filter(([, c]) => c === maxVotes).map(([id]) => id);

    let eliminated: string | null = null;
    let tiebreak = false;

    if (topPlayers.length === 1) {
      eliminated = topPlayers[0];
    } else {
      // 平票：随机淘汰一个（简化规则，完整版可以加PK）
      eliminated = topPlayers[Math.floor(Math.random() * topPlayers.length)];
      tiebreak = true;
    }

    if (eliminated) {
      const p = this.player(eliminated);
      if (p) p.alive = false;
    }

    this.rounds.push({
      round: this.round,
      messageDescriptions: [...this.currentRoundDescs],
      votes: [...this.votes],
      eliminated,
      tiebreak,
    });

    const winner = this.checkWin();
    if (winner) {
      this.winner = winner;
      this.phase = "end";
      return {
        ok: true,
        state: this.getState(),
        message: `${eliminated} 被淘汰！游戏结束，${winner === "spy" ? "卧底" : "平民"}获胜！`,
      };
    }

    this.round++;
    this.currentRoundDescs = [];
    this.votes = [];
    this.describeOrder = shuffle(this.alivePlayers().map(p => p.id));
    this.describeIdx = 0;
    this.phase = "describe";

    return {
      ok: true,
      state: this.getState(),
      message: `${eliminated} 被淘汰！${tiebreak ? "(平票随机)" : ""} 进入第 ${this.round} 轮。`,
    };
  }

  private checkWin(): Winner {
    const alive = this.alivePlayers();
    const spiesAlive = alive.filter(p => p.isSpy).length;
    const civiliansAlive = alive.filter(p => !p.isSpy).length;

    if (spiesAlive === 0) return "civilian";
    if (spiesAlive >= civiliansAlive) return "spy";
    return null;
  }
}
