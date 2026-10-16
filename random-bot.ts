/**
 * Tactical bot with controlled variety.
 * It is no longer random: it scores captures, safety, mobility and throne pressure,
 * then chooses randomly among near-best moves so repeated matches are less predictable.
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

interface TurnMessage {
  type: 'TURN';
  pieces: PieceData[];
  history?: unknown[];
}

type Move = { piece: PieceData; target: [number, number]; score: number };

const DIRECTIONS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]
];
const BEATS: Record<string, string> = { ROCK: 'SCISSORS', SCISSORS: 'PAPER', PAPER: 'ROCK' };
let mySide: 'WHITE' | 'BLACK' = 'WHITE';
let enemyThrone: [number, number] = [0, 0];
const validTiles = new Set<string>();

function distance(a: [number, number], b: [number, number]) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

function key(x: number, y: number) {
  return `${x},${y}`;
}

function legalMoves(pieces: PieceData[]): Move[] {
  const grid = new Map<string, PieceData>();
  for (const piece of pieces) if (piece.is_alive) grid.set(key(piece.x, piece.y), piece);
  const mine = pieces.filter((piece) => piece.is_alive && piece.owner === mySide);
  const moves: Move[] = [];

  for (const piece of mine) {
    for (const [dx, dy] of DIRECTIONS) {
      const x = piece.x + dx;
      const y = piece.y + dy;
      if (!validTiles.has(key(x, y))) continue;
      const target = grid.get(key(x, y));
      if (target && target.owner === mySide) continue;

      let score = 0;
      const nextDistance = distance([x, y], enemyThrone);
      const currentDistance = distance([piece.x, piece.y], enemyThrone);
      score += (currentDistance - nextDistance) * 18;

      if (x === enemyThrone[0] && y === enemyThrone[1]) score += 10000;
      if (target) {
        if (target.type === piece.type) continue;
        if (BEATS[piece.type] === target.type) score += 650;
        else score -= 500;
        score += target.type === 'ROCK' || target.type === 'PAPER' || target.type === 'SCISSORS' ? 20 : 0;
      }

      // Prefer positions that cannot be immediately captured by a nearby enemy.
      for (const enemy of pieces) {
        if (!enemy.is_alive || enemy.owner === mySide) continue;
        if (distance([enemy.x, enemy.y], [x, y]) !== 1) continue;
        if (BEATS[enemy.type] === piece.type) score -= 180;
        if (BEATS[piece.type] === enemy.type) score += 35;
      }

      // Keep options open instead of moving a piece into a dead corner.
      let mobility = 0;
      for (const [mx, my] of DIRECTIONS) {
        if (validTiles.has(key(x + mx, y + my)) && !grid.has(key(x + mx, y + my))) mobility++;
      }
      score += mobility * 8;
      moves.push({ piece, target: [x, y], score });
    }
  }
  return moves;
}

function sendMove(move: Move) {
  ws.send(JSON.stringify({
    type: 'bot_move',
    from: { row: move.piece.y, col: move.piece.x },
    to: { row: move.target[1], col: move.target[0] }
  }));
}

const ws = new WebSocket(process.env.BOT_URL || 'ws://localhost:3000');
ws.on('open', () => ws.send(JSON.stringify({
  type: 'bot_join',
  code: process.env.BOT_ROOM || '',
  name: process.env.BOT_NAME || 'tactical-bot'
})));
ws.on('message', (raw: Buffer) => {
  let message: InitMessage | TurnMessage;
  try {
    message = JSON.parse(raw.toString()) as InitMessage | TurnMessage;
  } catch {
    return;
  }
  if (message.type === 'INIT') {
    mySide = message.my_side;
    enemyThrone = mySide === 'WHITE' ? message.map.black_throne : message.map.white_throne;
    validTiles.clear();
    for (const tile of message.map.valid_tiles) validTiles.add(key(tile[0], tile[1]));
    ws.send(JSON.stringify({ type: 'bot_ready' }));
    return;
  }
  if (message.type !== 'TURN') return;
  const moves = legalMoves(message.pieces);
  if (!moves.length) return ws.send(JSON.stringify({ type: 'bot_move', from: null, to: null }));
  moves.sort((a, b) => b.score - a.score);
  const bestScore = moves[0].score;
  const shortlist = moves.filter((move) => move.score >= bestScore - 35).slice(0, 5);
  sendMove(shortlist[Math.floor(Math.random() * shortlist.length)]);
});
