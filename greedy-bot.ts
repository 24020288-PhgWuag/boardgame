/**
 * Strong positional bot for OTT V2.
 * Uses tactical captures first, then a one-ply safety check and throne pressure.
 */
const WebSocket = require('ws');

interface PieceData {
  id: number;
  owner: 'WHITE' | 'BLACK';
  type: 'ROCK' | 'SCISSORS' | 'PAPER';
  x: number;
  y: number;
  is_alive: boolean;
}
interface InitMessage {
  type: 'INIT';
  my_side: 'WHITE' | 'BLACK';
  map: { valid_tiles: [number, number][]; white_throne: [number, number]; black_throne: [number, number] };
}
interface TurnMessage { type: 'TURN'; pieces: PieceData[]; history?: unknown[]; }
type Move = { piece: PieceData; target: [number, number]; score: number; capture: boolean };

const DIRECTIONS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]
];
const BEATS: Record<string, string> = { ROCK: 'SCISSORS', SCISSORS: 'PAPER', PAPER: 'ROCK' };
const values: Record<string, number> = { ROCK: 10, PAPER: 10, SCISSORS: 10 };
let mySide: 'WHITE' | 'BLACK' = 'WHITE';
let enemyThrone: [number, number] = [0, 0];
const validTiles = new Set<string>();

function key(x: number, y: number) { return `${x},${y}`; }
function distance(a: [number, number], b: [number, number]) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}
function isCapturable(piece: PieceData, at: [number, number], enemies: PieceData[]) {
  return enemies.some((enemy) =>
    distance([enemy.x, enemy.y], at) === 1 && BEATS[enemy.type] === piece.type
  );
}

function findMoves(pieces: PieceData[]): Move[] {
  const grid = new Map<string, PieceData>();
  for (const piece of pieces) if (piece.is_alive) grid.set(key(piece.x, piece.y), piece);
  const enemies = pieces.filter((piece) => piece.is_alive && piece.owner !== mySide);
  const moves: Move[] = [];

  for (const piece of pieces.filter((item) => item.is_alive && item.owner === mySide)) {
    for (const [dx, dy] of DIRECTIONS) {
      const target: [number, number] = [piece.x + dx, piece.y + dy];
      if (!validTiles.has(key(target[0], target[1]))) continue;
      const occupant = grid.get(key(target[0], target[1]));
      if (occupant?.owner === mySide || occupant?.type === piece.type) continue;

      const capture = Boolean(occupant);
      let score = 0;
      const progress = distance([piece.x, piece.y], enemyThrone) - distance(target, enemyThrone);
      score += progress * 45;
      score += capture && occupant ? values[occupant.type] * 100 : 0;
      if (target[0] === enemyThrone[0] && target[1] === enemyThrone[1]) score += 100000;
      if (capture && occupant && BEATS[piece.type] !== occupant.type) score -= 1800;
      if (isCapturable(piece, target, enemies)) score -= 900;

      // Defend pieces that are already close to the enemy base.
      const nearbyAllies = pieces.filter((ally) =>
        ally.is_alive && ally.owner === mySide && ally.id !== piece.id &&
        distance([ally.x, ally.y], target) <= 2
      ).length;
      score += nearbyAllies * 12;
      moves.push({ piece, target, score, capture });
    }
  }
  return moves;
}

const ws = new WebSocket(process.env.BOT_URL || 'ws://localhost:3000');
ws.on('open', () => ws.send(JSON.stringify({
  type: 'bot_join',
  code: process.env.BOT_ROOM || '',
  name: process.env.BOT_NAME || 'greedy-bot'
})));
ws.on('message', (raw: Buffer) => {
  let message: InitMessage | TurnMessage;
  try { message = JSON.parse(raw.toString()) as InitMessage | TurnMessage; } catch { return; }
  if (message.type === 'INIT') {
    mySide = message.my_side;
    enemyThrone = mySide === 'WHITE' ? message.map.black_throne : message.map.white_throne;
    validTiles.clear();
    for (const tile of message.map.valid_tiles) validTiles.add(key(tile[0], tile[1]));
    ws.send(JSON.stringify({ type: 'bot_ready' }));
    return;
  }
  if (message.type !== 'TURN') return;
  const moves = findMoves(message.pieces);
  if (!moves.length) return ws.send(JSON.stringify({ type: 'bot_move', from: null, to: null }));
  moves.sort((a, b) => b.score - a.score);
  const best = moves[0];
  ws.send(JSON.stringify({
    type: 'bot_move',
    from: { row: best.piece.y, col: best.piece.x },
    to: { row: best.target[1], col: best.target[0] }
  }));
});
