/**
 * Random AI Bot for OanTuTi Arena
 * Adheres strictly to docs/specs/04-BOT-RUNNER-IPC-SPEC.md STDIO NDJSON.
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
const validTiles = new Set<string>();

const ws = new WebSocket(process.env.BOT_URL || 'ws://localhost:3000');
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'bot_join',
    code: process.env.BOT_ROOM || '',
    name: process.env.BOT_NAME || 'random-bot'
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

    interface CandidateMove {
      pieceId: number;
      target: [number, number];
    }

    const legalMoves: CandidateMove[] = [];

    for (const p of myLivingPieces) {
      for (const [dx, dy] of KING_DIRECTIONS) {
        const tx = p.x + dx;
        const ty = p.y + dy;
        const targetKey = `${tx},${ty}`;

        if (!validTiles.has(targetKey)) continue;

        const occupant = grid.get(targetKey);
        if (!occupant) {
          // Empty tile: legal move
          legalMoves.push({ pieceId: p.id, target: [tx, ty] });
        } else if (occupant.owner !== mySide) {
          // Enemy piece: must dominate (attacker beats defender)
          if (RPS_BEATS[p.type] === occupant.type) {
            legalMoves.push({ pieceId: p.id, target: [tx, ty] });
          }
        }
      }
    }

    if (legalMoves.length === 0) {
      ws.send(JSON.stringify({ type: 'bot_move', from: null, to: null }));
    } else {
      const selectedIndex = Math.floor(Math.random() * legalMoves.length);
      const chosen = legalMoves[selectedIndex];
      const piece = pieces.find((item) => item.id === chosen.pieceId);
      if (!piece) return;
      ws.send(JSON.stringify({
        type: 'bot_move',
        from: { row: piece.y, col: piece.x },
        to: { row: chosen.target[1], col: chosen.target[0] }
      }));
    }
  }
});
