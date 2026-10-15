/**
 * Greedy Capture Bot for OanTuTi Arena
 * Heuristic priority:
 * 1. Immediate Throne Breach
 * 2. Dominant Capture (Omega = +1)
 * 3. Throne Proximity Advance (minimizing Chebyshev distance to enemy throne)
 * 4. Any legal move fallback
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
  match_id: string;
  my_side: 'WHITE' | 'BLACK';
  map: {
    name: string;
    width: number;
    height: number;
    valid_tiles: [number, number][];
    white_throne: [number, number];
    black_throne: [number, number];
  };
  pieces: PieceData[];
  turn_time_limit_ms: number;
  max_turns: number;
}

interface TurnMessage {
  type: 'TURN';
  turn_number: number;
  time_remaining_ms: number;
  pieces: PieceData[];
  history?: unknown[];
}

const KING_DIRECTIONS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

const RPS_BEATS: Record<string, 'ROCK' | 'SCISSORS' | 'PAPER'> = {
  ROCK: 'SCISSORS',
  SCISSORS: 'PAPER',
  PAPER: 'ROCK',
};

let mySide: 'WHITE' | 'BLACK' = 'WHITE';
let enemyThrone: [number, number] = [0, 0];
const validTiles = new Set<string>();

const ws = new WebSocket(process.env.BOT_URL || 'ws://localhost:3000');
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'bot_join',
    code: process.env.BOT_ROOM || '',
    name: process.env.BOT_NAME || 'greedy-bot'
  }));
});
ws.on('message', (raw: Buffer) => {
  const line = raw.toString().trim();
  if (!line) return;
  let msg: InitMessage | TurnMessage;
  try {
    msg = JSON.parse(line) as InitMessage | TurnMessage;
  } catch {
    return;
  }

  if (msg.type === 'INIT') {
    mySide = msg.my_side;
    enemyThrone = mySide === 'WHITE' ? msg.map.black_throne : msg.map.white_throne;
    validTiles.clear();
    for (const [x, y] of msg.map.valid_tiles) {
      validTiles.add(`${x},${y}`);
    }
    ws.send(JSON.stringify({ type: 'bot_ready' }));
  } else if (msg.type === 'TURN') {
    const pieces = msg.pieces;
    const myLivingPieces = pieces.filter((p) => p.owner === mySide && p.is_alive);
    const grid = new Map<string, PieceData>();

    for (const p of pieces) {
      if (p.is_alive) {
        grid.set(`${p.x},${p.y}`, p);
      }
    }

    interface EvaluatedMove {
      pieceId: number;
      target: [number, number];
      isThroneBreach: boolean;
      isCapture: boolean;
      distanceToEnemyThrone: number;
      distanceDelta: number; // positive means moved closer
    }

    const candidateMoves: EvaluatedMove[] = [];

    for (const p of myLivingPieces) {
      const curDistToThrone = Math.max(
        Math.abs(p.x - enemyThrone[0]),
        Math.abs(p.y - enemyThrone[1])
      );

      for (const [dx, dy] of KING_DIRECTIONS) {
        const tx = p.x + dx;
        const ty = p.y + dy;
        const targetKey = `${tx},${ty}`;

        if (!validTiles.has(targetKey)) continue;

        const occupant = grid.get(targetKey);
        const isThroneBreach = tx === enemyThrone[0] && ty === enemyThrone[1];
        const newDistToThrone = Math.max(
          Math.abs(tx - enemyThrone[0]),
          Math.abs(ty - enemyThrone[1])
        );
        const distanceDelta = curDistToThrone - newDistToThrone;

        if (!occupant) {
          candidateMoves.push({
            pieceId: p.id,
            target: [tx, ty],
            isThroneBreach,
            isCapture: false,
            distanceToEnemyThrone: newDistToThrone,
            distanceDelta,
          });
        } else if (occupant.owner !== mySide) {
          if (RPS_BEATS[p.type] === occupant.type) {
            candidateMoves.push({
              pieceId: p.id,
              target: [tx, ty],
              isThroneBreach,
              isCapture: true,
              distanceToEnemyThrone: newDistToThrone,
              distanceDelta,
            });
          }
        }
      }
    }

    if (candidateMoves.length === 0) {
      ws.send(JSON.stringify({ type: 'bot_move', from: null, to: null }));
      return;
    }

    // Sort moves by heuristic tiers:
    // 1. Instant Throne Breach
    // 2. Capture move
    // 3. Distance Delta (higher positive delta = moved closer to enemy throne)
    // 4. Absolute Distance to Enemy Throne (lower = closer)
    candidateMoves.sort((a, b) => {
      if (a.isThroneBreach !== b.isThroneBreach) {
        return a.isThroneBreach ? -1 : 1;
      }
      if (a.isCapture !== b.isCapture) {
        return a.isCapture ? -1 : 1;
      }
      if (a.distanceDelta !== b.distanceDelta) {
        return b.distanceDelta - a.distanceDelta;
      }
      return a.distanceToEnemyThrone - b.distanceToEnemyThrone;
    });

    const chosen = candidateMoves[0];
    const piece = pieces.find((item) => item.id === chosen.pieceId);
    if (!piece) return;
    ws.send(JSON.stringify({
      type: 'bot_move',
      from: { row: piece.y, col: piece.x },
      to: { row: chosen.target[1], col: chosen.target[0] }
    }));
  }
});
