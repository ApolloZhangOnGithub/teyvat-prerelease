// steam/werewolf.ts — 狼人杀游戏引擎（纯逻辑，零 LLM）

export type Role = 'werewolf' | 'villager' | 'seer' | 'witch';
export type NightPhase = 'wolf_kill' | 'seer_check' | 'witch_action' | 'done';
export type DayPhase = 'discuss' | 'vote' | 'done';
export type Phase = 'night' | 'day' | 'end';
export type Winner = 'werewolf' | 'villager' | null;

export interface WWPlayer {
  id: string;
  role: Role;
  alive: boolean;
  // 女巫状态
  hasAntidote: boolean;   // 解药
  hasPoison: boolean;      // 毒药
  // 预言家查验记录
  checkedPlayers: { id: string; role: Role }[];
  // 当前轮记录
  hasSpoken: boolean;
  hasVoted: boolean;
}

export interface WWAction {
  action: string;    // 'wolf_kill', 'seer_check', 'witch_save', 'witch_poison', 'witch_skip', 'vote', 'speak'
  by: string;
  target?: string;
  text?: string;
}

export interface WWState {
  phase: Phase;
  nightPhase: NightPhase;
  dayPhase: DayPhase;
  round: number;
  winner: Winner;
  // 本回合数据
  wolfKillTarget: string | null;      // 狼人选的目标
  witchSaved: boolean;                // 女巫是否使用解药
  witchPoisonTarget: string | null;   // 女巫毒杀目标
  nightDeaths: string[];              // 夜晚死亡名单
  // 当前行动者
  currentActor: string | null;
  // 历史
  history: WWAction[];
  // 讨论记录
  currentDiscussion: { player: string; text: string }[];
  // 投票
  currentVotes: { voter: string; target: string }[];
  // 存活
  alivePlayers: string[];
}

export interface WWActionResult {
  ok: boolean;
  error?: string;
  state: WWState;
  message?: string;
}

export class WerewolfGame {
  players: WWPlayer[];
  phase: Phase = 'night';
  nightPhase: NightPhase = 'wolf_kill';
  dayPhase: DayPhase = 'discuss';
  winner: Winner = null;
  round = 1;
  history: WWAction[] = [];

  // 本回合夜间数据
  wolfKillTarget: string | null = null;
  witchSaved = false;
  witchPoisonTarget: string | null = null;
  nightDeaths: string[] = [];

  // 讨论和投票
  currentDiscussion: { player: string; text: string }[] = [];
  currentVotes: { voter: string; target: string }[] = [];
  discussOrder: string[] = [];
  discussIdx = 0;

  constructor(playerNames: string[]) {
    if (playerNames.length < 5) throw new Error("至少需要 5 名玩家");

    // 分配角色：1狼、1预言家、1女巫、其余村民
    const shuffled = [...playerNames].sort(() => Math.random() - 0.5);
    const roles: Role[] = ['werewolf', 'seer', 'witch'];
    while (roles.length < shuffled.length) roles.push('villager');

    this.players = shuffled.map((name, i) => ({
      id: name,
      role: roles[i],
      alive: true,
      hasAntidote: roles[i] === 'witch',
      hasPoison: roles[i] === 'witch',
      checkedPlayers: [],
      hasSpoken: false,
      hasVoted: false,
    }));

    this.discussOrder = this.#aliveIds();
  }

  #find(id: string): WWPlayer | undefined {
    return this.players.find(p => p.id === id);
  }

  #aliveIds(): string[] {
    return this.players.filter(p => p.alive).map(p => p.id);
  }

  #aliveWerewolves(): number {
    return this.players.filter(p => p.alive && p.role === 'werewolf').length;
  }

  #aliveVillagers(): number {
    return this.players.filter(p => p.alive && p.role !== 'werewolf').length;
  }

  getState(): WWState {
    return {
      phase: this.phase,
      nightPhase: this.nightPhase,
      dayPhase: this.dayPhase,
      round: this.round,
      winner: this.winner,
      wolfKillTarget: this.wolfKillTarget,
      witchSaved: this.witchSaved,
      witchPoisonTarget: this.witchPoisonTarget,
      nightDeaths: this.nightDeaths,
      currentActor: this.#getCurrentActor(),
      history: this.history,
      currentDiscussion: this.currentDiscussion,
      currentVotes: this.currentVotes,
      alivePlayers: this.#aliveIds(),
    };
  }

  #getCurrentActor(): string | null {
    if (this.phase === 'night') {
      const alive = this.#aliveIds();
      if (this.nightPhase === 'wolf_kill') {
        // 狼人：如果只有一个狼人，它来选
        const wolves = this.players.filter(p => p.alive && p.role === 'werewolf');
        return wolves.length > 0 ? wolves[0].id : null;
      }
      if (this.nightPhase === 'seer_check') {
        const seer = this.players.find(p => p.alive && p.role === 'seer');
        return seer?.id ?? null;
      }
      if (this.nightPhase === 'witch_action') {
        const witch = this.players.find(p => p.alive && p.role === 'witch');
        return witch?.id ?? null;
      }
      return null;
    }
    if (this.phase === 'day') {
      if (this.dayPhase === 'discuss') {
        return this.discussOrder[this.discussIdx] ?? null;
      }
      return null; // vote phase: all alive vote
    }
    return null;
  }

  // ──── 狼人行动 ────
  wolfKill(playerId: string, targetId: string): WWActionResult {
    if (this.phase !== 'night') return { ok: false, error: "现在是白天。", state: this.getState() };
    if (this.nightPhase !== 'wolf_kill') return { ok: false, error: "现在不是狼人行动阶段。", state: this.getState() };
    const p = this.#find(playerId);
    if (!p || p.role !== 'werewolf' || !p.alive) return { ok: false, error: "你不是狼人。", state: this.getState() };
    const t = this.#find(targetId);
    if (!t || !t.alive) return { ok: false, error: "目标无效。", state: this.getState() };
    if (t.role === 'werewolf') return { ok: false, error: "不能杀同伴。", state: this.getState() };

    this.wolfKillTarget = targetId;
    this.history.push({ action: 'wolf_kill', by: playerId, target: targetId });
    this.#nextNightPhase();
    return { ok: true, state: this.getState(), message: "狼人已行动。" };
  }

  // ──── 预言家查验 ────
  seerCheck(playerId: string, targetId: string): WWActionResult {
    if (this.phase !== 'night') return { ok: false, error: "现在是白天。", state: this.getState() };
    if (this.nightPhase !== 'seer_check') return { ok: false, error: "现在不是预言家行动阶段。", state: this.getState() };
    const p = this.#find(playerId);
    if (!p || p.role !== 'seer' || !p.alive) return { ok: false, error: "你不是预言家。", state: this.getState() };
    const t = this.#find(targetId);
    if (!t || !t.alive) return { ok: false, error: "目标无效。", state: this.getState() };
    if (targetId === playerId) return { ok: false, error: "不能查验自己。", state: this.getState() };

    p.checkedPlayers.push({ id: targetId, role: t.role });
    this.history.push({ action: 'seer_check', by: playerId, target: targetId });

    const result = t.role === 'werewolf' ? '狼人' : '好人';
    this.#nextNightPhase();
    return { ok: true, state: this.getState(), message: `查验结果：${targetId} 是${result}。` };
  }

  // ──── 女巫行动 ────
  witchAction(playerId: string, useAntidote: boolean, poisonTarget?: string): WWActionResult {
    if (this.phase !== 'night') return { ok: false, error: "现在是白天。", state: this.getState() };
    if (this.nightPhase !== 'witch_action') return { ok: false, error: "现在不是女巫行动阶段。", state: this.getState() };
    const p = this.#find(playerId);
    if (!p || p.role !== 'witch' || !p.alive) return { ok: false, error: "你不是女巫。", state: this.getState() };

    // 解药
    if (useAntidote && this.wolfKillTarget) {
      if (!p.hasAntidote) return { ok: false, error: "解药已用过。", state: this.getState() };
      p.hasAntidote = false;
      this.witchSaved = true;
      this.history.push({ action: 'witch_save', by: playerId, target: this.wolfKillTarget });
    }

    // 毒药
    if (poisonTarget) {
      if (!p.hasPoison) return { ok: false, error: "毒药已用过。", state: this.getState() };
      const t = this.#find(poisonTarget);
      if (!t || !t.alive) return { ok: false, error: "毒杀目标无效。", state: this.getState() };
      p.hasPoison = false;
      this.witchPoisonTarget = poisonTarget;
      this.history.push({ action: 'witch_poison', by: playerId, target: poisonTarget });
    }

    if (!useAntidote && !poisonTarget) {
      this.history.push({ action: 'witch_skip', by: playerId });
    }

    // 进入天亮
    this.#dawn();
    return { ok: true, state: this.getState() };
  }

  // ──── 天亮处理 ────
  #dawn() {
    // 结算死亡
    if (this.wolfKillTarget && !this.witchSaved) {
      this.nightDeaths.push(this.wolfKillTarget);
    }
    if (this.witchPoisonTarget) {
      this.nightDeaths.push(this.witchPoisonTarget);
    }

    // 执行死亡
    for (const id of this.nightDeaths) {
      const p = this.#find(id);
      if (p) p.alive = false;
    }

    this.#checkWin();
    if (this.winner) return;

    // 进入白天
    this.phase = 'day';
    this.dayPhase = 'discuss';
    this.discussOrder = this.#aliveIds().sort(() => Math.random() - 0.5);
    this.discussIdx = 0;
    this.currentDiscussion = [];
    this.currentVotes = [];
    for (const p of this.players) { p.hasSpoken = false; p.hasVoted = false; }
  }

  // ──── 讨论 ────
  speak(playerId: string, text: string): WWActionResult {
    if (this.phase !== 'day') return { ok: false, error: "现在是夜晚。", state: this.getState() };
    if (this.dayPhase !== 'discuss') return { ok: false, error: "现在不是讨论阶段。", state: this.getState() };
    const p = this.#find(playerId);
    if (!p || !p.alive) return { ok: false, error: "你已被淘汰。", state: this.getState() };
    if (p.hasSpoken) return { ok: false, error: "本回合已发言。", state: this.getState() };
    // 不强制按顺序发言，简化版允许任意存活玩家发言

    p.hasSpoken = true;
    this.currentDiscussion.push({ player: playerId, text });
    this.history.push({ action: 'speak', by: playerId, text });
    this.discussIdx++;

    // 所有人都发言完毕 → 进入投票
    const alive = this.#aliveIds();
    if (alive.every(id => this.#find(id)!.hasSpoken)) {
      this.dayPhase = 'vote';
    }

    return { ok: true, state: this.getState() };
  }

  // 跳过讨论，直接进入投票
  skipDiscuss(): WWActionResult {
    if (this.phase !== 'day') return { ok: false, error: "现在是夜晚。", state: this.getState() };
    if (this.dayPhase !== 'discuss') return { ok: false, error: "现在不是讨论阶段。", state: this.getState() };
    this.dayPhase = 'vote';
    return { ok: true, state: this.getState(), message: "进入投票阶段。" };
  }

  // ──── 投票 ────
  vote(playerId: string, targetId: string): WWActionResult {
    if (this.phase !== 'day') return { ok: false, error: "现在是夜晚。", state: this.getState() };
    if (this.dayPhase !== 'vote') return { ok: false, error: "现在不是投票阶段。", state: this.getState() };
    const p = this.#find(playerId);
    if (!p || !p.alive) return { ok: false, error: "你已被淘汰，不能投票。", state: this.getState() };
    if (p.hasVoted) return { ok: false, error: "你已投过票。", state: this.getState() };
    if (playerId === targetId) return { ok: false, error: "不能投自己。", state: this.getState() };
    const t = this.#find(targetId);
    if (!t || !t.alive) return { ok: false, error: "目标无效。", state: this.getState() };

    p.hasVoted = true;
    this.currentVotes.push({ voter: playerId, target: targetId });
    this.history.push({ action: 'vote', by: playerId, target: targetId });

    const alive = this.#aliveIds();
    if (alive.every(id => this.#find(id)!.hasVoted)) {
      return this.#resolveVotes();
    }

    return { ok: true, state: this.getState(), message: "投票已记录。" };
  }

  #resolveVotes(): WWActionResult {
    // 计票
    const counts: Record<string, number> = {};
    for (const v of this.currentVotes) {
      counts[v.target] = (counts[v.target] || 0) + 1;
    }

    const maxVotes = Math.max(...Object.values(counts), 0);
    const top = Object.entries(counts).filter(([, c]) => c === maxVotes).map(([id]) => id);

    let eliminated: string | null = null;

    if (top.length === 1) {
      eliminated = top[0];
    } else if (top.length > 1) {
      // 平票：无人被淘汰
    }

    let msg = '';
    if (eliminated) {
      const p = this.#find(eliminated);
      if (p) p.alive = false;
      msg = `${eliminated} 被投票放逐！`;
    } else {
      msg = `平票，无人被放逐。`;
    }

    this.#checkWin();
    if (this.winner) {
      return { ok: true, state: this.getState(), message: msg };
    }

    // 进入下一轮夜晚
    this.#nextRound();
    return { ok: true, state: this.getState(), message: msg };
  }

  #nextRound() {
    this.round++;
    this.phase = 'night';
    this.nightPhase = 'wolf_kill';
    this.dayPhase = 'discuss';
    this.wolfKillTarget = null;
    this.witchSaved = false;
    this.witchPoisonTarget = null;
    this.nightDeaths = [];
    this.currentDiscussion = [];
    this.currentVotes = [];
    this.discussIdx = 0;
  }

  // 跳过当前夜晚阶段（用于死角色自动推进）
  autoAdvanceNight(): void {
    if (this.phase !== 'night') return;
    if (this.nightPhase === 'wolf_kill' && !this.players.some(p => p.alive && p.role === 'werewolf')) {
      this.#nextNightPhase();
    } else if (this.nightPhase === 'seer_check' && !this.players.some(p => p.alive && p.role === 'seer')) {
      this.#nextNightPhase();
    } else if (this.nightPhase === 'witch_action' && !this.players.some(p => p.alive && p.role === 'witch')) {
      this.#dawn();
    }
  }

  #nextNightPhase() {
    if (this.nightPhase === 'wolf_kill') {
      if (this.players.some(p => p.alive && p.role === 'seer')) {
        this.nightPhase = 'seer_check';
      } else if (this.players.some(p => p.alive && p.role === 'witch')) {
        this.nightPhase = 'witch_action';
      } else {
        this.#dawn();
      }
    } else if (this.nightPhase === 'seer_check') {
      if (this.players.some(p => p.alive && p.role === 'witch')) {
        this.nightPhase = 'witch_action';
      } else {
        this.#dawn();
      }
    }
    // 如果目标角色已死，自动跳过
    this.#autoSkipDead();
  }

  // 跳过已死亡角色的夜晚阶段
  #autoSkipDead() {
    if (this.phase !== 'night') return;
    if (this.nightPhase === 'seer_check' && !this.players.some(p => p.alive && p.role === 'seer')) {
      this.#nextNightPhase();
    } else if (this.nightPhase === 'witch_action' && !this.players.some(p => p.alive && p.role === 'witch')) {
      this.#dawn();
    }
  }

  #checkWin() {
    const w = this.#aliveWerewolves();
    const v = this.#aliveVillagers();
    if (w === 0) { this.winner = 'villager'; this.phase = 'end'; }
    else if (w >= v) { this.winner = 'werewolf'; this.phase = 'end'; }
  }

  // ──── UI ────

  getPlayerView(playerId: string): string {
    const p = this.#find(playerId);
    if (!p) return "错误：你不在这局游戏里。";

    const lines: string[] = [];
    const roleNames: Record<Role, string> = { werewolf: '🐺 狼人', villager: '👤 村民', seer: '🔮 预言家', witch: '🧪 女巫' };
    lines.push(`═══ 狼人杀 · 第 ${this.round} ${this.phase === 'night' ? '夜' : this.phase === 'day' ? '天' : '局'} ═══`);
    lines.push(`你的身份: ${roleNames[p.role]}`);
    lines.push(`存活: ${this.#aliveIds().join(', ')} (${this.#aliveIds().length}人)`);

    // 显示已知信息
    if (p.role === 'seer' && p.checkedPlayers.length > 0) {
      lines.push(`查验记录: ${p.checkedPlayers.map(c => `${c.id}=${c.role === 'werewolf' ? '🐺' : '✅'}`).join(', ')}`);
    }
    if (p.role === 'witch') {
      lines.push(`解药: ${p.hasAntidote ? '✅' : '❌'} | 毒药: ${p.hasPoison ? '✅' : '❌'}`);
    }

    lines.push('');

    if (this.phase === 'night') {
      lines.push('🌙 天黑请闭眼...');
      if (this.nightPhase === 'wolf_kill' && p.role === 'werewolf') {
        const targets = this.#aliveIds().filter(id => this.#find(id)!.role !== 'werewolf');
        lines.push(`→ 狼人请选择击杀目标: ${targets.join(', ')}`);
        lines.push(`  操作: kill <玩家名>`);
      } else if (this.nightPhase === 'seer_check' && p.role === 'seer') {
        const targets = this.#aliveIds().filter(id => id !== playerId);
        lines.push(`→ 预言家请选择查验目标: ${targets.join(', ')}`);
        lines.push(`  操作: check <玩家名>`);
      } else if (this.nightPhase === 'witch_action' && p.role === 'witch') {
        if (this.wolfKillTarget) {
          lines.push(`今夜 ${this.wolfKillTarget} 被杀。`);
          if (p.hasAntidote) lines.push(`→ 使用解药救人？操作: save`);
        }
        if (p.hasPoison) {
          const targets = this.#aliveIds().filter(id => id !== playerId);
          lines.push(`→ 使用毒药杀人？操作: poison <玩家名>`);
        }
        lines.push(`→ 或跳过: skip`);
      } else {
        lines.push(`  等待其他玩家行动...`);
      }
    } else if (this.phase === 'day') {
      if (this.nightDeaths.length > 0) {
        lines.push(`💀 昨夜死亡: ${this.nightDeaths.join(', ')}`);
      } else {
        lines.push(`✨ 昨夜是平安夜。`);
      }
      lines.push('');

      if (this.dayPhase === 'discuss') {
        if (this.currentDiscussion.length > 0) {
          for (const d of this.currentDiscussion) lines.push(`  ${d.player}: "${d.text}"`);
        }
        if (!p.hasSpoken && p.alive) {
          lines.push(`→ 轮到你发言。操作: say <发言内容>`);
        } else if (!p.alive) {
          lines.push(`  你已死亡，请保持安静。`);
        } else {
          lines.push(`  等待其他人发言... (输入 skip 跳过)`);
        }
      } else if (this.dayPhase === 'vote') {
        if (this.currentDiscussion.length > 0) {
          lines.push('── 讨论回顾 ──');
          for (const d of this.currentDiscussion) lines.push(`  ${d.player}: "${d.text}"`);
          lines.push('');
        }
        if (!p.hasVoted && p.alive) {
          const targets = this.#aliveIds().filter(id => id !== playerId);
          lines.push(`→ 请投票放逐: ${targets.join(', ')}`);
          lines.push(`  操作: vote <玩家名>`);
        } else if (p.alive) {
          lines.push(`  你已投票。等待其他人...`);
          const voted = this.currentVotes.map(v => v.voter);
          const notYet = this.#aliveIds().filter(id => !voted.includes(id));
          if (notYet.length > 0) lines.push(`  未投: ${notYet.join(', ')}`);
        }
      }
    } else if (this.phase === 'end') {
      lines.push(`══ 游戏结束 ══`);
      lines.push(`胜方: ${this.winner === 'werewolf' ? '🐺 狼人' : '👥 好人阵营'}`);
      lines.push('');
      lines.push('身份揭晓:');
      for (const pl of this.players) {
        const roleNames: Record<Role, string> = { werewolf: '🐺 狼人', villager: '👤 村民', seer: '🔮 预言家', witch: '🧪 女巫' };
        lines.push(`  ${pl.id}: ${roleNames[pl.role]} ${pl.alive ? '' : '💀'}`);
      }
    }

    return lines.join('\n');
  }

  toJSON() {
    return {
      players: this.players, phase: this.phase, nightPhase: this.nightPhase,
      dayPhase: this.dayPhase, winner: this.winner, round: this.round,
      history: this.history, wolfKillTarget: this.wolfKillTarget,
      witchSaved: this.witchSaved, witchPoisonTarget: this.witchPoisonTarget,
      nightDeaths: this.nightDeaths, currentDiscussion: this.currentDiscussion,
      currentVotes: this.currentVotes, discussOrder: this.discussOrder,
      discussIdx: this.discussIdx,
    };
  }

  static fromJSON(j: ReturnType<WerewolfGame['toJSON']>): WerewolfGame {
    const g = Object.create(WerewolfGame.prototype);
    g.players = j.players; g.phase = j.phase; g.nightPhase = j.nightPhase;
    g.dayPhase = j.dayPhase; g.winner = j.winner; g.round = j.round;
    g.history = j.history; g.wolfKillTarget = j.wolfKillTarget;
    g.witchSaved = j.witchSaved; g.witchPoisonTarget = j.witchPoisonTarget;
    g.nightDeaths = j.nightDeaths; g.currentDiscussion = j.currentDiscussion;
    g.currentVotes = j.currentVotes; g.discussOrder = j.discussOrder;
    g.discussIdx = j.discussIdx;
    return g;
  }
}
