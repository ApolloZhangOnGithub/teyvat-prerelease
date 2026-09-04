import { runtimeCacheBaseDir } from "#paths";
// system.server/game-server.ts — 手机系统级游戏联机服务器
// 本地运行，kernel 启动时自动拉起。所有联机游戏共用这一个进程。
// 端口自动分配，写入 PORT_FILE 供 agent 查询

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

const PORT = 0; // 自动分配空闲端口
const PORT_FILE = join(runtimeCacheBaseDir(), "game-server-port");

// ── JSON 工具 ──
function json(res: ServerResponse, code: number, body: any) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

// ── 五子棋引擎（内联）──
const GSIZE = 15;
const GDIRS: [number, number][] = [[0, 1], [1, 0], [1, 1], [1, -1]];

function gomokuWin(board: number[][], r: number, c: number): boolean {
  const p = board[r][c]; if (p === 0) return false;
  for (const [dr, dc] of GDIRS) {
    let count = 1;
    for (let i = 1; i < 5; i++) { const nr = r + dr * i, nc = c + dc * i; if (nr >= 0 && nr < GSIZE && nc >= 0 && nc < GSIZE && board[nr][nc] === p) count++; else break; }
    for (let i = 1; i < 5; i++) { const nr = r - dr * i, nc = c - dc * i; if (nr >= 0 && nr < GSIZE && nc >= 0 && nc < GSIZE && board[nr][nc] === p) count++; else break; }
    if (count >= 5) return true;
  }
  return false;
}
function gomokuFull(board: number[][]) { return board.every(r => r.every(c => c !== 0)); }

// ── 对局存储 ──
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
function uid(len = 8) { let s = ""; for (let i = 0; i < len; i++) s += CHARS[(Math.random() * CHARS.length) | 0]; return s; }

interface BaseMatch {
  id: string;
  game: string;
  tokens: string[];
  createdAt: number;
  updatedAt: number;
}
interface GomokuMatch extends BaseMatch {
  game: "gomoku";
  board: number[][];
  turn: 1 | 2;
  winner: 0 | 1 | 2;
  moves: [number, number][];
  players: string[];  // [黑方名, 白方名]
}

type Match = GomokuMatch;
const matches = new Map<string, Match>();

function newId(): string { let id: string; do { id = uid(4).toUpperCase(); } while (matches.has(id)); return id; }

// 10分钟过期清理
setInterval(() => {
  const now = Date.now();
  for (const [id, m] of matches) if (now - m.updatedAt > 600_000) matches.delete(id);
}, 60_000);

// ── 五子棋路由 ──
async function gomokuRoute(req: IncomingMessage, res: ServerResponse, path: string) {
  const method = req.method;

  // POST /gomoku/create
  if (method === "POST" && path === "/gomoku/create") {
    const { playerName } = await readBody(req);
    const id = newId();
    const m: GomokuMatch = {
      id, game: "gomoku",
      board: Array.from({ length: GSIZE }, () => Array(GSIZE).fill(0)),
      turn: 1, winner: 0, moves: [],
      tokens: [uid()],
      players: [playerName || "黑方", ""],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    matches.set(id, m);
    return json(res, 200, { matchId: id, token: m.tokens[0] });
  }

  // POST /gomoku/join
  if (method === "POST" && path === "/gomoku/join") {
    const { matchId, playerName } = await readBody(req);
    const m = matches.get((matchId || "").toUpperCase()) as GomokuMatch | undefined;
    if (!m) return json(res, 404, { ok: false, error: "对局不存在" });
    if (m.tokens.length >= 2) return json(res, 400, { ok: false, error: "对局已满" });
    const token = uid();
    m.tokens.push(token);
    m.players[1] = playerName || "白方";
    m.updatedAt = Date.now();
    return json(res, 200, { ok: true, token });
  }

  // POST /gomoku/move
  if (method === "POST" && path === "/gomoku/move") {
    const { matchId, token, row, col } = await readBody(req);
    const m = matches.get((matchId || "").toUpperCase()) as GomokuMatch | undefined;
    if (!m) return json(res, 404, { ok: false, error: "对局不存在" });
    const idx = m.tokens.indexOf(token);
    if (idx === -1) return json(res, 403, { ok: false, error: "鉴权失败" });
    if (m.tokens.length < 2) return json(res, 400, { ok: false, error: "等待对手加入" });
    const player = (idx + 1) as 1 | 2;
    if (m.turn !== player) return json(res, 400, { ok: false, error: "还没轮到你" });
    if (m.winner !== 0) return json(res, 400, { ok: false, error: "对局已结束" });
    if (row < 0 || row >= GSIZE || col < 0 || col >= GSIZE) return json(res, 400, { ok: false, error: "坐标超出范围" });
    if (m.board[row][col] !== 0) return json(res, 400, { ok: false, error: "该位置已有棋子" });

    m.board = m.board.map(r => [...r]);
    m.board[row][col] = player;
    m.moves.push([row, col]);
    m.updatedAt = Date.now();

    if (gomokuWin(m.board, row, col)) { m.winner = player; }
    else if (gomokuFull(m.board)) { /* 平局 winner=0 */ }
    else { m.turn = m.turn === 1 ? 2 : 1; }

    return json(res, 200, {
      ok: true,
      board: m.board, turn: m.turn, winner: m.winner,
      lastMove: m.moves.length > 0 ? m.moves[m.moves.length - 1] : null,
      moves: m.moves.length,
    });
  }

  // GET /gomoku/list
  if (method === "GET" && path === "/gomoku/list") {
    const waiting: { id: string; players: number; createdAt: number }[] = [];
    for (const [id, m] of matches) {
      if (m.game === "gomoku" && m.tokens.length < 2 && m.winner === 0) {
        waiting.push({ id, players: m.tokens.length, createdAt: m.createdAt });
      }
    }
    return json(res, 200, { ok: true, matches: waiting });
  }

  // GET /gomoku/:matchId
  if (method === "GET") {
    const matchId = path.split("/")[2]?.toUpperCase();
    if (!matchId) return json(res, 400, { ok: false, error: "缺少 matchId" });
    const m = matches.get(matchId) as GomokuMatch | undefined;
    if (!m) return json(res, 404, { ok: false, error: "对局不存在" });
    return json(res, 200, {
      ok: true,
      board: m.board, turn: m.turn, winner: m.winner,
      lastMove: m.moves.length > 0 ? m.moves[m.moves.length - 1] : null,
      moves: m.moves.length,
      tokens: m.tokens.length,
      players: m.players,
    });
  }

  json(res, 404, { ok: false, error: "not found" });
}

// ── HTTP server ──
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path.startsWith("/gomoku")) return gomokuRoute(req, res, path);
  // 后续游戏加在这里:
  // if (path.startsWith("/chess")) return chessRoute(req, res, path);

  if (path === "/") return json(res, 200, { ok: true, matches: matches.size });
  json(res, 404, { ok: false, error: "not found" });
});

export function startGameServer() {
  if (server.listening) return;
  server.listen(PORT, () => {
    const actualPort = (server.address() as any)?.port;
    const dir = runtimeCacheBaseDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(PORT_FILE, String(actualPort));
  });
}

export function stopGameServer(): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      console.log("[game-server] stopped");
      resolve();
    });
    // 强制关闭所有连接
    server.closeAllConnections?.();
  });
}

export async function reloadGameServer() {
  await stopGameServer();
  // 重新动态导入以获取新代码
  const fresh = await import(`./game-server.ts?reload=${Date.now()}`);
  fresh.startGameServer();
}
