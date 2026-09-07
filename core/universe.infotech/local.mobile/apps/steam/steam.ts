import { serviceKey, apiFetch } from "#paths";
// steam/steam.ts — Steam 游戏平台 v3
// 谁是卧底 + 国际象棋 + 贪吃蛇 + 狼人杀 + 2048 + 五子棋 + 扫雷

import type { MobileApp } from "../../system.kernel/kernel.ts";
import { SpyGame } from "./steam-001_who_is_spy.ts";
import { ChessGame } from "./steam-002_chess.ts";
import { SnakeGame } from "./steam-003_greedy_snake.ts";
import { WerewolfGame } from "./steam-004_werewolf.ts";
import { G2048 } from "./steam-005_2048.ts";
import { GomokuGame, gomokuOnline } from "./steam-006_gomoku.ts";
import type { GomokuDifficulty } from "./steam-006_gomoku.ts";
import { PianoTiles } from "./steam-008_piano_tiles.ts";
import type { PianoTilesDifficulty } from "./steam-008_piano_tiles.ts";
import { MinesweeperGame } from "./steam-007_minesweeper.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logerr } from "#paths";

// ── LLM bot ──

function getApiKey(): string | null {
  return serviceKey("deepseek");
}

async function llm(system: string, user: string): Promise<string> {
  const key = getApiKey();
  if (!key) return "";
  try {
    const res = await Promise.race([
      apiFetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_tokens: 300, temperature: 0.9,
        }),
        signal: AbortSignal.timeout(3000),
      }, { service: "deepseek", api: "/chat/completions", key }),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    if (!res) return "";
    const j = await res.json() as any;
    return (j.choices?.[0]?.message?.content || "").trim().replace(/^["「]|["」]$/g, "");
  } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam.ts] " + ((e as any)?.message || e)); return ""; }
}

// 本地 fallback：LLM 不可用时，根据词生成简单描述
const LOCAL_FALLBACKS: Record<string, string[]> = {
  "薯条": ["炸的", "蘸番茄酱吃"], "薯片": ["袋装", "脆的零食"],
  "眼镜": ["戴在脸上", "帮助看清东西"], "墨镜": ["遮阳", "夏天常戴"],
  "牛奶": ["白色液体", "补钙"], "豆浆": ["豆制品", "早餐喝"],
  "西瓜": ["绿色外皮", "夏天吃"], "哈密瓜": ["黄色果肉", "甜瓜"],
  "口红": ["涂抹嘴唇", "美妆"], "唇膏": ["滋润", "防干裂"],
  "高铁": ["速度快", "出远门坐"], "动车": ["也是快的火车", "短途多"],
  "微信": ["聊天", "绿色图标"], "QQ": ["聊天软件", "企鹅图标"],
  "面包": ["烤的", "西式主食"], "馒头": ["蒸的", "中式主食"],
  "咖啡": ["苦的", "提神醒脑"], "奶茶": ["甜的", "年轻人爱喝"],
  "蜡烛": ["能点燃", "照明用"], "火把": ["手持燃烧", "古代照明"],
  "护照": ["出国用", "一本蓝色"], "身份证": ["国内用", "随身携带"],
  "沙发": ["软的", "客厅家具"], "椅子": ["硬的", "可以坐"],
  "钢笔": ["蘸墨水", "写字"], "毛笔": ["软笔头", "书法"],
  "足球": ["用脚踢", "圆的"], "篮球": ["用手拍", "橙色的"],
  "医生": ["看病", "白大褂"], "护士": ["护理", "白衣天使"],
  "月亮": ["晚上看", "会变圆缺"], "太阳": ["白天", "发光发热"],
  "空调": ["制冷", "挂在墙上"], "风扇": ["转的", "吹风"],
  "地铁": ["地下跑", "通勤"], "公交": ["地上跑", "等车"],
  "饺子": ["皮包馅", "过年吃"], "馄饨": ["汤里", "皮更薄"],
  "雪碧": ["柠檬味", "绿色瓶"], "七喜": ["也是柠檬味", "白瓶"],
};
function localFallback(word: string): string {
  const opts = LOCAL_FALLBACKS[word];
  if (!opts) return "这个东西挺常见的";
  return opts[Math.floor(Math.random() * opts.length)];
}

async function botDescribe(name: string, word: string, isSpy: boolean, round: number, prevDescs: { player: string; text: string }[]): Promise<string> {
  const history = prevDescs.length > 0 ? "前面的描述:\n" + prevDescs.map(d => `${d.player}: "${d.text}"`).join("\n") : "你是第一个。";
  const sys = `你在玩谁是卧底。你的词是「${word}」。用一句话描述，不能说出词语本身或其中任何一个字。绝对不能抄袭或复述别人说过的描述，必须用完全不同的角度。${isSpy ? "你是卧底，描述要模糊但合理，让人觉得你拿到的词和大家一样。" : "你是平民，描述要有区分度但别太明显。"}只输出描述，限15字。`;
  const llmResult = await llm(sys, `第${round}轮。${history}\n轮到${name}。`);
  if (llmResult) return llmResult;
  // 本地 fallback：取不一样的描述
  const used = new Set(prevDescs.map(d => d.text));
  const opts = LOCAL_FALLBACKS[word];
  if (opts) {
    for (const o of opts) if (!used.has(o)) return o;
    return opts[0];
  }
  return "这个东西挺常见的";
}

async function botVote(name: string, word: string, isSpy: boolean, alive: string[], descs: { player: string; text: string }[]): Promise<string> {
  const candidates = alive.filter(id => id !== name);
  if (candidates.length === 0) return "";
  const descText = descs.map(d => `${d.player}: "${d.text}"`).join("\n");
  const sys = `你在玩谁是卧底。你的词是「${word}」。${isSpy ? "你是卧底，投掉一个平民。" : "找描述最不一样的人。"}只回复一个名字。`;
  const reply = await llm(sys, `描述:\n${descText}\n从 ${candidates.join("、")} 中选。`);
  if (reply) return candidates.find(c => reply.includes(c)) || candidates[Math.floor(Math.random() * candidates.length)];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ── runBots：非阻塞，后台运行，完成时自动更新状态 ──
let botRunning = false;
async function runBots(game: SpyGame, agentId: string, onUpdate?: () => void): Promise<void> {
  if (botRunning) return;
  botRunning = true;
  try {
    // 描述阶段：串行（每个 bot 需要看到前面的描述）
    while (game.phase === "describe") {
      const current = game.getState().currentTurn;
      if (!current || current === agentId) break;
      const p = game.players.find(x => x.id === current);
      if (!p) break;
      game.describe(current, await botDescribe(current, p.word, p.isSpy, game.round, game.currentRoundDescs));
      onUpdate?.();
    }
    // 投票阶段：并行
    if (game.phase === "vote") {
      const alive = game.getState().alivePlayers;
      await Promise.all(
        alive.filter(pid => pid !== agentId && !game.votes.find(v => v.voter === pid))
          .map(async pid => {
            const p = game.players.find(x => x.id === pid)!;
            game.vote(pid, await botVote(pid, p.word, p.isSpy, alive, game.currentRoundDescs));
            onUpdate?.();
          })
      );
    }
    onUpdate?.();
  } finally {
    botRunning = false;
  }
}

// ── 狼人杀 - bot 函数 ──

let wwRunning = false;

async function wolfKillBot(game: WerewolfGame, wolfId: string): Promise<string | null> {
  const alive = game.getState().alivePlayers;
  const targets = alive.filter(id => game.players.find(p => p.id === id)?.role !== 'werewolf');
  if (targets.length === 0) return null;
  const sys = `你是狼人杀中的狼人。选一个今晚要杀的目标。优先杀预言家或女巫。只回复一个玩家名。`;
  const reply = await llm(sys, `存活玩家: ${targets.join(", ")}`);
  if (reply) return targets.find(t => reply.includes(t)) || targets[Math.floor(Math.random() * targets.length)];
  return targets[Math.floor(Math.random() * targets.length)];
}

async function seerCheckBot(game: WerewolfGame, seerId: string): Promise<string | null> {
  const alive = game.getState().alivePlayers;
  const targets = alive.filter(id => id !== seerId);
  if (targets.length === 0) return null;
  const seer = game.players.find(p => p.id === seerId);
  const unchecked = targets.filter(id => !seer?.checkedPlayers.find(c => c.id === id));
  const pool = unchecked.length > 0 ? unchecked : targets;
  const sys = `你是狼人杀中的预言家。选一个今晚要查验的玩家。优先查验可疑的人。只回复一个玩家名。`;
  const reply = await llm(sys, `存活玩家: ${pool.join(", ")}`);
  if (reply) return pool.find(t => reply.includes(t)) || pool[Math.floor(Math.random() * pool.length)];
  return pool[Math.floor(Math.random() * pool.length)];
}

async function witchBot(game: WerewolfGame, witchId: string): Promise<{ save: boolean; poison?: string }> {
  const witch = game.players.find(p => p.id === witchId);
  let save = false, poison: string | undefined;
  if (game.wolfKillTarget && witch?.hasAntidote) {
    save = game.round === 1 || Math.random() < 0.5;
  }
  if (witch?.hasPoison && game.getState().alivePlayers.length > 4) {
    const targets = game.getState().alivePlayers.filter(id => id !== witchId);
    if (targets.length > 0) {
      const sys = `你是狼人杀中的女巫。选一个用毒的目标。优先毒可疑的人。只回复一个玩家名，或回复"不毒"。`;
      const reply = await llm(sys, `存活玩家: ${targets.join(", ")}`);
      if (reply && reply !== '不毒') poison = targets.find(t => reply.includes(t));
    }
  }
  return { save, poison };
}

async function werewolfSpeakBot(game: WerewolfGame, playerId: string): Promise<string> {
  const p = game.players.find(p => p.id === playerId)!;
  const roleNames: Record<string, string> = { werewolf: '狼人', villager: '村民', seer: '预言家', witch: '女巫' };
  const discussion = game.currentDiscussion.map(d => `${d.player}: "${d.text}"`).join("\n");
  const sys = `你在玩狼人杀。你的真实身份是${roleNames[p.role]}。${p.role === 'werewolf' ? '你要伪装成好人，发言要自然。' : p.role === 'seer' ? '必要时可以跳身份公布查验结果。' : '正常发言，帮助找出狼人。'}用一句话发言，限20字。只输出发言内容。`;
  const reply = await llm(sys, `前面发言:\n${discussion || '(你是第一个发言)'}\n轮到${playerId}。`);
  if (reply) return reply;
  const fallbacks = ["我觉得我们需要仔细分析一下", "暂时没有太多头绪", "先听听后面的人怎么说", "我信任前面发言的人", "我觉得有人很可疑"];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

async function werewolfVoteBot(game: WerewolfGame, playerId: string): Promise<string> {
  const alive = game.getState().alivePlayers;
  const candidates = alive.filter(id => id !== playerId);
  if (candidates.length === 0) return "";
  const p = game.players.find(p => p.id === playerId)!;
  const roleNames: Record<string, string> = { werewolf: '狼人', villager: '村民', seer: '预言家', witch: '女巫' };
  const discussion = game.currentDiscussion.map(d => `${d.player}: "${d.text}"`).join("\n");
  const sys = `你在玩狼人杀。你的真实身份是${roleNames[p.role]}。${p.role === 'werewolf' ? '你是狼人，投掉一个好人。' : '投一个你最怀疑的人。'}只回复一个玩家名。`;
  const reply = await llm(sys, `讨论:\n${discussion}\n从 ${candidates.join("、")} 中选。`);
  if (reply) return candidates.find(c => reply.includes(c)) || candidates[Math.floor(Math.random() * candidates.length)];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function runWerewolfBots(game: WerewolfGame, agentId: string, onUpdate?: () => void): Promise<void> {
  if (wwRunning) return;
  wwRunning = true;
  try {
    while (game.phase !== 'end') {
      if ((game.phase as string) === 'night') {
        if (game.nightPhase === 'wolf_kill') {
          const wolves = game.players.filter(p => p.alive && p.role === 'werewolf');
          if (wolves.length > 0) {
            const wolfId = wolves.find(w => w.id === agentId) ? agentId : wolves[0].id;
            if (wolfId !== agentId) {
              const target = await wolfKillBot(game, wolfId);
              if (target) game.wolfKill(wolfId, target);
            } else break;
          } else {
            game.autoAdvanceNight();
            continue;
          }
        } else if (game.nightPhase === 'seer_check') {
          const seer = game.players.find(p => p.alive && p.role === 'seer');
          if (seer && seer.id !== agentId) {
            const target = await seerCheckBot(game, seer.id);
            if (target) game.seerCheck(seer.id, target);
          } else if (!seer) {
            game.autoAdvanceNight();
            continue;
          } else break;
        } else if (game.nightPhase === 'witch_action') {
          const witch = game.players.find(p => p.alive && p.role === 'witch');
          if (witch && witch.id !== agentId) {
            const action = await witchBot(game, witch.id);
            game.witchAction(witch.id, action.save, action.poison);
          } else if (!witch) {
            game.autoAdvanceNight();
            continue;
          } else break;
        } else {
          break;
        }
      } else if (game.phase === 'day') {
        if (game.dayPhase === 'discuss') {
          const alive = game.getState().alivePlayers;
          let allDone = true;
          for (const pid of alive) {
            const p = game.players.find(x => x.id === pid)!;
            if (!p.hasSpoken && p.alive && pid !== agentId) {
              const text = await werewolfSpeakBot(game, pid);
              game.speak(pid, text);
              allDone = false;
            }
          }
          const player = game.players.find(p => p.id === agentId);
          if (player && player.alive && !player.hasSpoken) break;
          if (game.dayPhase === 'discuss') game.skipDiscuss();
        } else if (game.dayPhase === 'vote') {
          const alive = game.getState().alivePlayers;
          let allDone = true;
          for (const pid of alive) {
            const p = game.players.find(x => x.id === pid)!;
            if (!p.hasVoted && p.alive && pid !== agentId) {
              const target = await werewolfVoteBot(game, pid);
              if (target) game.vote(pid, target);
              allDone = false;
            }
          }
          const player = game.players.find(p => p.id === agentId);
          if (player && player.alive && !player.hasVoted) break;
          // 投票完成后引擎会自己推进到下一轮
          if ((game.phase as string) === 'night') continue; // 下一轮夜晚，继续
          break;
        } else {
          break;
        }
      } else {
        break; // end
      }
      onUpdate?.();
    }
    onUpdate?.();
  } finally {
    wwRunning = false;
  }
}

// ── 游戏注册表 ──

const GAMES = [
  { name: "谁是卧底", desc: "和 AI 对战的推理游戏" },
  { name: "国际象棋", desc: "和 AI 对弈（minimax）" },
  { name: "贪吃蛇",   desc: "经典贪吃蛇" },
  { name: "狼人杀",   desc: "天黑请闭眼，和AI对战" },
  { name: "2048",     desc: "经典数字拼图" },
  { name: "五子棋",   desc: "15x15，和AI对弈" },
  { name: "扫雷",     desc: "经典扫雷" },
  { name: "别踩白块儿", desc: "节奏游戏 / LLM反应速度测试" },
] as const;

function menu(): string {
  const lines = ["═══ Steam 游戏平台 ═══", ""];
  for (const g of GAMES) lines.push(`  ${g.name} — ${g.desc}`);
  lines.push("", "输入游戏名，或「返回」回主屏幕");
  return lines.join("\n");
}

function matchGame(input: string): typeof GAMES[number] | null {
  return GAMES.find(g => input.includes(g.name)) || null;
}

interface SteamState {
  cur: string | null;
  spy: SpyGame | null;
  chess: ChessGame | null;
  snake: SnakeGame | null;
  werewolf: WerewolfGame | null;
  g2048: G2048;
  gomoku: GomokuGame | null;
  minesweeper: MinesweeperGame;
  pianoTiles: PianoTiles;
}

function norm(raw: any): SteamState {
  if (raw?.cur !== undefined) {
    if (raw.spy && typeof raw.spy.describe !== 'function') raw.spy = SpyGame.fromJSON(raw.spy);
    if (raw.werewolf && typeof raw.werewolf.getState !== 'function') raw.werewolf = WerewolfGame.fromJSON(raw.werewolf);
    if (raw.g2048 && typeof raw.g2048.move !== 'function') raw.g2048 = G2048.fromJSON(raw.g2048);
    if (raw.gomoku && typeof raw.gomoku.place !== 'function') raw.gomoku = GomokuGame.fromJSON(raw.gomoku);
    if (raw.minesweeper && typeof raw.minesweeper.reveal !== 'function') raw.minesweeper = MinesweeperGame.fromJSON(raw.minesweeper);
    if (raw.pianoTiles && typeof raw.pianoTiles.tap !== 'function') raw.pianoTiles = PianoTiles.fromJSON(raw.pianoTiles);
    return raw;
  }
  if (raw?.game) return { cur: '谁是卧底', spy: raw.game, chess: null, snake: null, werewolf: null, g2048: null as any, gomoku: null, minesweeper: null as any, pianoTiles: null as any };
  return { cur: null, spy: null, chess: null, snake: null, werewolf: null, g2048: null as any, gomoku: null, minesweeper: null as any, pianoTiles: null as any };
}

export const app: MobileApp = {
  name: "steam",
  icon: "",
  messageDescription: "游戏平台",

  onOpen(state: any, personDir: string) {
    const s = norm(state);
    if (s.cur === "谁是卧底" && s.spy && s.spy.phase !== "end") return { screen: s.spy.getPlayerView("你"), state: s };
    if (s.cur === "国际象棋") {
      if (!s.chess || s.chess.s.over) s.chess = loadPersisted(personDir) || new ChessGame();
      return { screen: s.chess.screen(), state: s };
    }
    if (s.cur === "贪吃蛇" && s.snake && !s.snake.over) return { screen: s.snake.screen(), state: s };
    if (s.cur === "狼人杀" && s.werewolf && s.werewolf.phase !== "end") return { screen: s.werewolf.getPlayerView("你"), state: s };
    if (s.cur === "2048" && s.g2048 && !s.g2048.over) return { screen: s.g2048.screen(), state: s };
    if (s.cur === "五子棋" && s.gomoku && !s.gomoku.over) return { screen: s.gomoku.screen(), state: s };
    if (s.cur === "扫雷" && s.minesweeper && !s.minesweeper.over) return { screen: s.minesweeper.screen(), state: s };
    if (s.cur === "别踩白块儿" && s.pianoTiles && !s.pianoTiles.over) return { screen: s.pianoTiles.screen(), state: s };
    s.cur = null;
    return { screen: menu(), state: s };
  },

  async onAction(input: string, rawState: any, personDir: string) {
    const s = norm(rawState);
    const trimmed = input.trim();
    let agentId = "你";

    if (/^(菜单|menu|返回|back)$/i.test(trimmed)) { s.cur = null; s.spy = null; s.werewolf = null; return { screen: menu(), state: s }; }

    // ── 游戏选择 ──
    if (!s.cur) {
      const hit = matchGame(trimmed);
      if (!hit) return { screen: menu() + "\n\n请选择游戏。", state: s };
      s.cur = hit.name;
      if (hit.name === "国际象棋") {
        s.chess = loadPersisted(personDir) || new ChessGame();
        return { screen: s.chess.screen(), state: s };
      }
      if (hit.name === "贪吃蛇") {
        s.snake = newSnake();
        return { screen: s.snake.screen(), state: s };
      }
      if (hit.name === "谁是卧底") {
        if (s.spy && s.spy.phase !== "end") return { screen: s.spy.getPlayerView(agentId), state: s };
        return { screen: "═══ 谁是卧底 ═══\n\n输入「新游戏」或「新游戏 5」开始\n「菜单」回 Steam", state: s };
      }
      if (hit.name === "狼人杀") {
        if (s.werewolf && s.werewolf.phase !== "end") return { screen: s.werewolf.getPlayerView(agentId), state: s };
        return { screen: "═══ 狼人杀 ═══\n\n输入「新游戏」开始\n「菜单」回 Steam", state: s };
      }
      if (hit.name === "2048") {
        G2048.setPersonId(personDir.match(/memory\/([a-f0-9]+)/)?.[1] || '');
        s.g2048 = G2048.load() || new G2048();
        return { screen: s.g2048.screen(), state: s };
      }
      if (hit.name === "五子棋") {
        return { screen: GomokuGame.subMenu(), state: s };
      }
      if (hit.name === "扫雷") {
        s.minesweeper = new MinesweeperGame();
        return { screen: s.minesweeper.screen(), state: s };
      }
      if (hit.name === "别踩白块儿") {
        s.pianoTiles = null as any;  // 清旧局，等选难度
        return { screen: PianoTiles.subMenu(), state: s };
      }
    }

    // ── 谁是卧底 ──
    if (s.cur === "谁是卧底") {
      const newMatch = trimmed.match(/^新游戏\s*(\d+)?$/) || trimmed.match(/^new\s*(\d+)?$/i);
      if (newMatch) {
        const count = Math.max(3, Math.min(7, parseInt(newMatch[1] || "5")));
        const botNames = ["甲", "乙", "丙", "丁", "戊", "己"].slice(0, count - 1);
        s.spy = new SpyGame([agentId, ...botNames]);
        // 非阻塞：bot 后台运行，不卡 UI
        runBots(s.spy, agentId);
        return { screen: s.spy.getPlayerView(agentId) + "\nAI 玩家思考中...", state: s };
      }
      if (!s.spy || s.spy.phase === "end") {
        if (s.spy?.phase === "end") return { screen: s.spy.getPlayerView(agentId) + "\n\n输入「新游戏」再来一局，或「菜单」回 Steam。", state: s };
        return { screen: "没有进行中的游戏。输入「新游戏」开始。", state: s };
      }
      const game = s.spy;
      if (game.phase === "vote") {
        const alive = game.getState().alivePlayers.filter((id: string) => id !== agentId);
        const target = alive.find((name: string) => trimmed.includes(name));
        if (target) {
          const result = game.vote(agentId, target);
          if (!result.ok) return { screen: `${result.error}`, state: s };
          runBots(game, agentId);
          return { screen: `${result.message}\n\n${game.getPlayerView(agentId)}`, state: s };
        }
        return { screen: `请投票: ${alive.join(", ")}`, state: s };
      }
      if (game.phase === "describe" && game.getState().currentTurn === agentId) {
        const desc = trimmed.replace(/^(describe|描述)\s*/i, "").trim();
        if (!desc) return { screen: "描述不能为空。输入你对词语的描述。", state: s };
        const result = game.describe(agentId, desc);
        if (!result.ok) return { screen: `${result.error}`, state: s };
        runBots(game, agentId);
        return { screen: `${result.message}\n\n${game.getPlayerView(agentId)}`, state: s };
      }
      // 默认返回当前状态
      let screen = game.getPlayerView(agentId);
      if (botRunning) screen += "\nAI 玩家思考中...";
      return { screen, state: s };
    }

    // ── 贪吃蛇 ──
    if (s.cur === "贪吃蛇") {
      if (!s.snake) s.snake = newSnake();
      if (/^(新局|new)$/i.test(trimmed)) { s.snake = newSnake(); return { screen: s.snake.screen(), state: s }; }
      const dirMap: Record<string, 'u'|'d'|'l'|'r'> = { w: 'u', s: 'd', a: 'l', d: 'r', up: 'u', down: 'd', left: 'l', right: 'r' };
      const dir = dirMap[trimmed.toLowerCase()];
      if (dir) s.snake.input(dir);
      return { screen: s.snake.screen(), state: s };
    }

    // ── 国际象棋 ──
    if (s.cur === "国际象棋") {
      if (!s.chess) s.chess = loadPersisted(personDir) || new ChessGame();
      const diffMatch = trimmed.match(/^(新局|new)\s*(简单|中等|困难|easy|medium|hard)?$/i);
      if (diffMatch) {
        const diffMap: Record<string, 'easy'|'medium'|'hard'> = { '简单': 'easy', '中等': 'medium', '困难': 'hard', 'easy': 'easy', 'medium': 'medium', 'hard': 'hard' };
        const diff = diffMatch[2] ? (diffMap[diffMatch[2]] || s.chess.difficulty) : s.chess.difficulty;
        s.chess = new ChessGame(diff);
        clearPersisted(personDir);
        return { screen: s.chess.screen(), state: s };
      }
      if (/^(新局|new)$/i.test(trimmed)) { s.chess = new ChessGame(s.chess.difficulty); clearPersisted(personDir); return { screen: s.chess.screen(), state: s }; }
      if (/^(认输|resign)$/i.test(trimmed)) { s.chess.resign(); persist(s.chess, personDir); return { screen: s.chess.screen(), state: s }; }
      const r = s.chess.move(trimmed);
      if (!r.ok) return { screen: s.chess.screen() + `\n\n${r.error}`, state: s };
      persist(s.chess, personDir);
      return { screen: s.chess.screen() + (r.ai ? `\n\n对手走: ${r.ai}` : ""), state: s };
    }

    // ── 狼人杀 ──
    if (s.cur === "狼人杀") {
      if (!s.werewolf || s.werewolf.phase === "end") {
        if (s.werewolf?.phase === "end") return { screen: s.werewolf.getPlayerView(agentId) + "\n\n输入「新游戏」再来一局，或「菜单」回 Steam。", state: s };
        if (/^(新游戏|新局|new)$/i.test(trimmed)) {
          const botNames = ["张三", "李四", "王五", "赵六", "孙七"];
          s.werewolf = new WerewolfGame([agentId, ...botNames]);
          const view = s.werewolf.getPlayerView(agentId);
          runWerewolfBots(s.werewolf, agentId);
          return { screen: view + "\n\nAI 玩家思考中...", state: s };
        }
        return { screen: "没有进行中的游戏。输入「新游戏」开始。", state: s };
      }
      const ww = s.werewolf;
      const st = ww.getState();
      if (st.phase === 'night') {
        const player = ww.players.find(p => p.id === agentId)!;
        if (st.nightPhase === 'wolf_kill' && player.role === 'werewolf') {
          const killMatch = trimmed.match(/^kill\s+(.+)$/i);
          if (killMatch) {
            const target = ww.players.find(p => p.alive && p.id.includes(killMatch[1]));
            if (target) {
              const res = ww.wolfKill(agentId, target.id);
              if (!res.ok) return { screen: res.error!, state: s };
              runWerewolfBots(ww, agentId);
              return { screen: res.message + "\n\n" + ww.getPlayerView(agentId), state: s };
            }
            return { screen: "找不到该玩家。", state: s };
          }
        }
        if (st.nightPhase === 'seer_check' && player.role === 'seer') {
          const checkMatch = trimmed.match(/^check\s+(.+)$/i);
          if (checkMatch) {
            const target = ww.players.find(p => p.alive && p.id.includes(checkMatch[1]));
            if (target) {
              const res = ww.seerCheck(agentId, target.id);
              if (!res.ok) return { screen: res.error!, state: s };
              runWerewolfBots(ww, agentId);
              return { screen: res.message + "\n\n" + ww.getPlayerView(agentId), state: s };
            }
            return { screen: "找不到该玩家。", state: s };
          }
        }
        if (st.nightPhase === 'witch_action' && player.role === 'witch') {
          if (/^save$/i.test(trimmed)) {
            const res = ww.witchAction(agentId, true);
            if (!res.ok) return { screen: res.error!, state: s };
            runWerewolfBots(ww, agentId);
            return { screen: res.message + "\n\n" + ww.getPlayerView(agentId), state: s };
          }
          const poisonMatch = trimmed.match(/^poison\s+(.+)$/i);
          if (poisonMatch) {
            const target = ww.players.find(p => p.alive && p.id.includes(poisonMatch[1]));
            if (target) {
              const res = ww.witchAction(agentId, false, target.id);
              if (!res.ok) return { screen: res.error!, state: s };
              runWerewolfBots(ww, agentId);
              return { screen: res.message + "\n\n" + ww.getPlayerView(agentId), state: s };
            }
            return { screen: "找不到该玩家。", state: s };
          }
          if (/^skip$/i.test(trimmed)) {
            const res = ww.witchAction(agentId, false);
            if (!res.ok) return { screen: res.error!, state: s };
            runWerewolfBots(ww, agentId);
            return { screen: res.message + "\n\n" + ww.getPlayerView(agentId), state: s };
          }
        }
        return { screen: ww.getPlayerView(agentId) + (wwRunning ? "\n\nAI 玩家思考中..." : ""), state: s };
      }
      if (st.phase === 'day' && st.dayPhase === 'discuss') {
        const player = ww.players.find(p => p.id === agentId)!;
        if (/^skip$/i.test(trimmed)) {
          const res = ww.skipDiscuss();
          if (res.ok) runWerewolfBots(ww, agentId);
          return { screen: (res.message ?? '') + "\n\n" + ww.getPlayerView(agentId), state: s };
        }
        const sayMatch = trimmed.match(/^say\s+(.+)$/i);
        if (sayMatch) {
          if (player.alive && !player.hasSpoken) {
            const res = ww.speak(agentId, sayMatch[1]);
            if (!res.ok) return { screen: res.error!, state: s };
            runWerewolfBots(ww, agentId);
            return { screen: ww.getPlayerView(agentId) + "\n\nAI 玩家思考中...", state: s };
          }
        }
      }
      if (st.phase === 'day' && st.dayPhase === 'vote') {
        const player = ww.players.find(p => p.id === agentId)!;
        if (player.alive && !player.hasVoted) {
          const voteMatch = trimmed.match(/^vote\s+(.+)$/i);
          if (voteMatch) {
            const target = ww.players.find(p => p.alive && p.id.includes(voteMatch[1]));
            if (target) {
              const res = ww.vote(agentId, target.id);
              if (!res.ok) return { screen: res.error!, state: s };
              runWerewolfBots(ww, agentId);
              return { screen: (res.message ?? '') + "\n\n" + ww.getPlayerView(agentId), state: s };
            }
            return { screen: "找不到该玩家。", state: s };
          }
        }
      }
      return { screen: ww.getPlayerView(agentId) + (wwRunning ? "\n\nAI 玩家思考中..." : ""), state: s };
    }

    // ── 2048 ──
    if (s.cur === "2048") {
      if (!s.g2048) {
        G2048.setPersonId(personDir.match(/memory\/([a-f0-9]+)/)?.[1] || '');
        s.g2048 = G2048.load() || new G2048();
      }
      if (/^(新局|new|restart)$/i.test(trimmed)) { s.g2048 = new G2048(); s.g2048.save(); return { screen: s.g2048.screen(), state: s }; }
      if (/^(撤回|撤销|undo)$/i.test(trimmed)) {
        const msg = s.g2048.undo();
        s.g2048.save();
        return { screen: s.g2048.screen() + '\n' + msg, state: s };
      }
      // save [slot]
      const sm = trimmed.match(/^(保存|存档|save)\s*(\S*)$/i);
      if (sm) { const msg = s.g2048.save(sm[2] || 'auto'); return { screen: s.g2048.screen() + '\n' + msg, state: s }; }
      // load [slot]
      const lm = trimmed.match(/^(读档|load)\s*(\S*)$/i);
      if (lm) {
        const slot = lm[2] || 'auto';
        const loaded = G2048.load(slot);
        if (loaded) { s.g2048 = loaded; s.g2048.save(); return { screen: s.g2048.screen() + `\n已读档「${slot}」。`, state: s }; }
        return { screen: s.g2048.screen() + `\n没有存档「${slot}」。`, state: s };
      }
      // slots
      if (/^slots$/i.test(trimmed)) {
        const list = G2048.listSlots();
        if (!list.length) return { screen: s.g2048.screen() + '\n(无存档)', state: s };
        const lines = list.map(l => `  ${l.slot}  得分${l.score}  ${l.ts?.slice(0,16) || ''}`);
        return { screen: s.g2048.screen() + '\n存档:\n' + lines.join('\n'), state: s };
      }
      const dirMap: Record<string, 'u'|'d'|'l'|'r'> = { w: 'u', s: 'd', a: 'l', d: 'r', up: 'u', down: 'd', left: 'l', right: 'r' };
      const dir = dirMap[trimmed.toLowerCase()];
      if (dir) { s.g2048.move(dir); s.g2048.save(); }
      return { screen: s.g2048.screen(), state: s };
    }

    // ── 五子棋 ──
    if (s.cur === "五子棋") {
      // ── 子菜单：新局 → AI 对战 ──
      if (/^(新局|new|ai)$/i.test(trimmed) && !s.gomoku) {
        s.gomoku = new GomokuGame();
        return { screen: s.gomoku.screen(), state: s };
      }
      // ── 大厅 ──
      if (/^(联机|online|大厅|lobby)$/i.test(trimmed)) {
        try {
          const { matches } = await gomokuOnline.list();
          return { screen: GomokuGame.lobbyScreen(matches || []), state: s };
        } catch (e: any) {
          return { screen: `联机失败: ${e.message}`, state: s };
        }
      }
      // ── 创建房间 ──
      if (/^(创建|newroom)$/i.test(trimmed)) {
        try {
          const agentId = process.env.PAIMON_AGENT_ID?.slice(0,8) || 'unknown';
          const { matchId, token } = await gomokuOnline.create(agentId);
          s.gomoku = GomokuGame.onlineNew(matchId, token);
          return { screen: s.gomoku.screen(), state: s };
        } catch (e: any) {
          return { screen: `创建失败: ${e.message}`, state: s };
        }
      }
      // ── 加入房间 ──
      const joinMatch = trimmed.match(/^(加入|join)\s+(\S+)$/i);
      if (joinMatch) {
        try {
          const agentId = process.env.PAIMON_AGENT_ID?.slice(0,8) || 'unknown';
          const result = await gomokuOnline.join(joinMatch[2], agentId);
          if (!result.ok) return { screen: `加入失败: ${result.error}`, state: s };
          s.gomoku = GomokuGame.onlineJoin(joinMatch[2], result.token!);
          return { screen: s.gomoku.screen(), state: s };
        } catch (e: any) {
          return { screen: `加入失败: ${e.message}`, state: s };
        }
      }
      // ── 联机刷新 ──
      if (/^(刷新|refresh)$/i.test(trimmed) && s.gomoku?.mode === 'online') {
        try {
          const state = await gomokuOnline.get(s.gomoku.matchId);
          if (!state.ok) return { screen: `${state.error}`, state: s };
          s.gomoku.syncFromServer(state.board, state.turn, state.winner, state.lastMove, state.moves, state.players);
          return { screen: s.gomoku.screen(), state: s };
        } catch (e: any) {
          return { screen: `刷新失败: ${e.message}`, state: s };
        }
      }
      // ── 联机走棋 ──
      const coordMatch = trimmed.match(/^(\d{1,2})\s+(\d{1,2})$/);
      if (coordMatch && s.gomoku?.mode === 'online') {
        const row = parseInt(coordMatch[1]), col = parseInt(coordMatch[2]);
        try {
          const result = await gomokuOnline.move(s.gomoku.matchId, s.gomoku.token, row, col);
          if (!result.ok) return { screen: `${result.error}\n\n${s.gomoku.screen()}`, state: s };
          s.gomoku.syncFromServer(result.board, result.turn, result.winner, result.lastMove, result.moves, result.players);
          return { screen: s.gomoku.screen(), state: s };
        } catch (e: any) {
          return { screen: `走棋失败: ${e.message}`, state: s };
        }
      }
      // ── AI 模式 ──
      if (!s.gomoku || s.gomoku.mode !== 'online') {
        if (!s.gomoku) s.gomoku = new GomokuGame();
        const diffMatch = trimmed.match(/^(新局|new)\s*(简单|中等|困难|easy|medium|hard)?$/i);
        if (diffMatch) {
          const diffMap: Record<string, GomokuDifficulty> = { '简单': 'easy', '中等': 'medium', '困难': 'hard', 'easy': 'easy', 'medium': 'medium', 'hard': 'hard' };
          const diff = diffMatch[2] ? (diffMap[diffMatch[2]] || s.gomoku.difficulty) : s.gomoku.difficulty;
          s.gomoku = new GomokuGame(diff);
          return { screen: s.gomoku.screen(), state: s };
        }
        if (/^(新局|new)$/i.test(trimmed)) { s.gomoku = new GomokuGame(s.gomoku.difficulty); return { screen: s.gomoku.screen(), state: s }; }
        if (coordMatch) {
          const row = parseInt(coordMatch[1]), col = parseInt(coordMatch[2]);
          const r = s.gomoku.place(row, col);
          if (!r.ok) return { screen: s.gomoku.screen() + `\n\n${r.error}`, state: s };
          return { screen: s.gomoku.screen() + (r.ai ? `\n\nAI: (${r.ai})` : ""), state: s };
        }
      }
      return { screen: s.gomoku ? s.gomoku.screen() : menu(), state: s };
    }

    // ── 扫雷 ──
    if (s.cur === "扫雷") {
      if (!s.minesweeper) s.minesweeper = new MinesweeperGame();
      if (/^(新局|new)$/i.test(trimmed)) { s.minesweeper = new MinesweeperGame(); return { screen: s.minesweeper.screen(), state: s }; }
      const revealMatch = trimmed.match(/^(\d{1,2})\s+(\d{1,2})$/);
      const flagMatch = trimmed.match(/^f\s+(\d{1,2})\s+(\d{1,2})$/i);
      if (revealMatch) {
        const row = parseInt(revealMatch[1]), col = parseInt(revealMatch[2]);
        const r = s.minesweeper.action(row, col, false);
        if (!r.ok) return { screen: s.minesweeper.screen() + `\n\n${r.error}`, state: s };
        return { screen: s.minesweeper.screen(), state: s };
      }
      if (flagMatch) {
        const row = parseInt(flagMatch[1]), col = parseInt(flagMatch[2]);
        const r = s.minesweeper.action(row, col, true);
        if (!r.ok) return { screen: s.minesweeper.screen() + `\n\n${r.error}`, state: s };
        return { screen: s.minesweeper.screen(), state: s };
      }
      return { screen: s.minesweeper.screen(), state: s };
    }

    // ── 别踩白块儿 ──
    if (s.cur === "别踩白块儿") {
      if (!s.pianoTiles) {
        PianoTiles.setPersonId(personDir.match(/memory\/([a-f0-9]+)/)?.[1] || '');
        s.pianoTiles = new PianoTiles();
        s.pianoTiles.bestScore = PianoTiles.loadBest();
      }
      if (/^(新局|new)$/i.test(trimmed)) {
        const prevDiff = s.pianoTiles.difficulty;
        PianoTiles.setPersonId(personDir.match(/memory\/([a-f0-9]+)/)?.[1] || '');
        s.pianoTiles = new PianoTiles(prevDiff);
        s.pianoTiles.bestScore = PianoTiles.loadBest();
        return { screen: s.pianoTiles.screen(), state: s };
      }
      s.pianoTiles.tap(trimmed);
      return { screen: s.pianoTiles.screen(), state: s };
    }

    return { screen: menu(), state: s };
  },
};

// ── 持久化 ──
function persist(game: ChessGame, personDir: string) {
  try { mkdirSync(personDir, { recursive: true }); writeFileSync(join(personDir, "steam.json"), JSON.stringify({ chess: game.toJSON() })); } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam.ts] " + ((e as any)?.message || e)); }
}
function loadPersisted(personDir: string): ChessGame | null {
  try { const raw = JSON.parse(readFileSync(join(personDir, "steam.json"), "utf8")); return raw?.chess ? ChessGame.fromJSON(raw.chess) : null; } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam.ts] " + ((e as any)?.message || e)); return null; }
}
function clearPersisted(personDir: string) { try { writeFileSync(join(personDir, "steam.json"), "{}"); } catch (e) { console.error("[universe.infotech/local.mobile/apps/steam/steam.ts] " + ((e as any)?.message || e)); } }

function newSnake(): SnakeGame {
  return new SnakeGame();
}
