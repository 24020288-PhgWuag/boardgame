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

    // Move piece
    if (message.type === 'move') {
      const room = rooms.getRoom(socket.roomCode);
      const player = room?.sockets.get(socket);
      if (!room || !player) {
        return send(socket, 'error', { message: 'Bạn chưa ở trong phòng đấu.' });
      }
      if (player === 'spectator') {
        return send(socket, 'error', { message: 'Khán giả không thể thực hiện nước đi.' });
      }

      const outcome = applyMove(room.state, player, message.from, message.to);
      if (!outcome.ok) {
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

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`OTT V2 Server is running at http://localhost:${port}`);
  console.log(`Multiplayer available at http://localhost:${port}/playfull.html`);
});
