const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const RoomManager = require('./roomManager');
const { applyMove } = require('./gameState');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new RoomManager();
const BOT_TURN_LIMIT_MS = 1000;
const BOT_MOVE_DELAY_MS = Number(process.env.BOT_MOVE_DELAY_MS || 1000);
const port = process.env.PORT || 3000;

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// Specific route aliases for playfull.html / playful.html
app.get('/playfull.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'playfull.html'));
});
app.get('/playful.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'playfull.html'));
});

// JSON API endpoint for room list
app.get('/api/rooms', (req, res) => {
  res.json({ rooms: rooms.getPublicRooms() });
});

function send(socket, type, payload = {}) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}) {
  if (!room || !room.sockets) return;
  for (const socket of room.sockets.keys()) {
    send(socket, type, payload);
  }
}

function getBotPieces(state) {
    const pieces = [];
    let id = 1;
    for (let row = 0; row < state.board.length; row++) {
      for (let col = 0; col < state.board[row].length; col++) {
        const piece = state.board[row][col];
        if (piece) {
          pieces.push({
            id: id++,
            owner: piece.player === 'p1' ? 'WHITE' : 'BLACK',
            type: piece.type.toUpperCase(),
            x: col,
            y: row,
            is_alive: true
          });
        }
      }
    }
    return pieces;
}

function sendBotTurn(room) {
    if (!room || room.state.winner) return;
    for (const [socket, role] of room.sockets.entries()) {
      if (!socket.isBot || role !== room.state.turn) continue;
      send(socket, 'TURN', {
        turn_number: room.state.history.length + 1,
        time_remaining_ms: BOT_TURN_LIMIT_MS,
        pieces: getBotPieces(room.state),
        history: room.state.history
      });
      clearTimeout(room.botTimer);
      room.botTimer = setTimeout(() => {
        if (room.state.winner || room.state.turn !== role) return;
        const winner = role === 'p1' ? 'p2' : 'p1';
        room.state.winner = winner;
        room.state.winReason = `${role === 'p1' ? 'Bot P1' : 'Bot P2'} hết thời gian lượt đi.`;
        broadcast(room, 'state', { state: room.state, result: 'timeout', lastPlayer: role });
      }, BOT_TURN_LIMIT_MS);
    }

}

function scheduleBotTurn(room) {
  if (!room || room.state.winner) return;
  clearTimeout(room.botTurnDelay);
  room.botTurnDelay = setTimeout(() => {
    room.botTurnDelay = null;
    sendBotTurn(room);
  }, BOT_MOVE_DELAY_MS);
}

function sendBotInit(socket, room, role) {
    send(socket, 'INIT', {
      match_id: room.code,
      my_side: role === 'p1' ? 'WHITE' : 'BLACK',
      map: {
        name: 'OTT V2 9x9',
        width: 9,
        height: 9,
        valid_tiles: Array.from({ length: 9 }, (_, y) =>
          Array.from({ length: 9 }, (_, x) => [x, y])
        ).flat(),
        white_throne: [8, 8],
        black_throne: [0, 0]
      },
      pieces: getBotPieces(room.state),
      turn_time_limit_ms: BOT_TURN_LIMIT_MS,
      max_turns: 0
    });
    scheduleBotTurn(room);
}

wss.on('connection', (socket) => {
  socket.isAlive = true;

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(socket, 'error', { message: 'Gói tin không hợp lệ.' });
    }

    // Ping / Pong for latency
    if (message.type === 'ping') {
      return send(socket, 'pong', { time: message.time });
    }

    // Request rooms list
    if (message.type === 'list_rooms') {
      return send(socket, 'rooms_list', { rooms: rooms.getPublicRooms() });
    }

    // Create room
    if (message.type === 'create') {
      const mode = message.mode || 'classic';
      const room = rooms.createRoom(mode);
      const joined = rooms.joinRoom(room.code, socket);
      socket.roomCode = room.code;
      send(socket, 'joined', {
        code: room.code,
        player: joined.player,
        state: room.state,
        mode: room.mode
      });
      return;
    }

    // Join room
    if (message.type === 'join') {
      const code = String(message.code || '').trim().toUpperCase();
      const joined = rooms.joinRoom(code, socket, message.role);
      if (joined.error) {
        return send(socket, 'error', { message: joined.error });
      }
      socket.roomCode = joined.room.code;
      send(socket, 'joined', {
        code: joined.room.code,
        player: joined.player,
        state: joined.room.state,
        mode: joined.room.mode
      });
      broadcast(joined.room, 'room-update', {
        state: joined.room.state,
        event: 'player_joined',
        player: joined.player
      });
      return;
    }

    if (message.type === 'bot_join') {
      const code = String(message.code || '').trim().toUpperCase();
      const joined = rooms.joinRoom(code, socket, 'bot');
      if (joined.error) return send(socket, 'error', { message: joined.error });
      if (joined.player === 'spectator') {
        rooms.remove(socket);
        return send(socket, 'error', { message: 'Phòng đã đủ hai người chơi bot.' });
      }
      socket.roomCode = joined.room.code;
      socket.isBot = true;
      joined.room.botNames.set(socket, String(message.name || 'bot').slice(0, 80));
      send(socket, 'bot_joined', { code: joined.room.code, player: joined.player });
      broadcast(joined.room, 'room-update', {
        state: joined.room.state,
        event: 'bot_joined',
        player: joined.player
      });
      sendBotInit(socket, joined.room, joined.player);
      return;
    }

    if (message.type === 'bot_vs_bot') {
      const room = rooms.createRoom(message.mode || 'classic');
      room.botProcesses = [];
      send(socket, 'bot_match', { code: room.code, mode: room.mode });

      const botScript = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const botEnv = {
        ...process.env,
        BOT_URL: `ws://localhost:${port}`,
        BOT_ROOM: room.code
      };
      const bots = [
        { file: 'random-bot.ts', name: 'random-bot' },
        { file: 'greedy-bot.ts', name: 'greedy-bot' }
      ];
      for (const bot of bots) {
        const child = require('child_process').spawn(
          process.execPath,
          [botScript, path.join(__dirname, '..', bot.file)],
          { env: { ...botEnv, BOT_NAME: bot.name }, stdio: 'ignore' }
        );
        room.botProcesses.push(child);
      }
      return;
    }

    // Move piece
    if (message.type === 'move' || message.type === 'bot_move') {
      const room = rooms.getRoom(socket.roomCode);
      const player = room?.sockets.get(socket);
      if (!room || !player) {
        return send(socket, 'error', { message: 'Bạn chưa ở trong phòng đấu.' });
      }
      if (player === 'spectator') {
        return send(socket, 'error', { message: 'Khán giả không thể thực hiện nước đi.' });
      }

      if (message.type === 'bot_move' && !socket.isBot) {
        return send(socket, 'error', { message: 'Chỉ bot mới được dùng bot_move.' });
      }
      if (message.type === 'bot_move') clearTimeout(room.botTimer);
      const outcome = applyMove(room.state, player, message.from, message.to);
      if (!outcome.ok) {
        if (message.type === 'bot_move') scheduleBotTurn(room);
        return send(socket, 'error', { message: outcome.reason });
      }

      broadcast(room, 'state', {
        state: room.state,
        result: outcome.result,
        capturedPiece: outcome.capturedPiece,
        from: message.from,
        to: message.to,
        lastPlayer: player
      });
      scheduleBotTurn(room);
      return;
    }

    // Rematch / Restart game in current room
    if (message.type === 'rematch') {
      const room = rooms.getRoom(socket.roomCode);
      const player = room?.sockets.get(socket);
      if (!room || !player) return;

      rooms.resetRoom(room.code, message.mode);
      broadcast(room, 'rematch', {
        state: room.state,
        by: player,
        message: `${player === 'p1' ? 'Đội Đỏ' : 'Đội Xanh'} đã khởi động lại ván đấu!`
      });
      return;
    }

    // In-game quick chat / emote
    if (message.type === 'chat') {
      const room = rooms.getRoom(socket.roomCode);
      const player = room?.sockets.get(socket);
      if (!room || !player) return;

      const text = String(message.text || '').trim().slice(0, 100);
      if (text) {
        broadcast(room, 'chat', {
          sender: player,
          text,
          time: Date.now()
        });
      }
    }
  });

  socket.on('close', () => {
    const result = rooms.remove(socket);
    if (result && result.room) {
      clearTimeout(result.room.botTimer);
      clearTimeout(result.room.botTurnDelay);
      if (result.empty && result.room.botProcesses) {
        for (const child of result.room.botProcesses) {
          if (!child.killed) child.kill();
        }
      }
    }
    if (result && !result.empty && result.room) {
      broadcast(result.room, 'room-update', {
        state: result.room.state,
        event: 'player_left',
        disconnectedRole: result.disconnectedRole,
        message: `${result.disconnectedRole === 'p1' ? 'Đội Đỏ (P1)' : 'Đội Xanh (P2)'} đã thoát phòng.`
      });
    }
  });
});

server.listen(port, () => {
  console.log(`OTT V2 Server is running at http://localhost:${port}`);
  console.log(`Multiplayer available at http://localhost:${port}/playfull.html`);
});
