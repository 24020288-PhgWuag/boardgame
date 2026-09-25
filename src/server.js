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
app.use(express.static(path.join(__dirname, '..', 'public')));

function send(socket, type, payload) { socket.send(JSON.stringify({ type, ...payload })); }
function broadcast(room, type, payload) { for (const socket of room.sockets.keys()) send(socket, type, payload); }

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return send(socket, 'error', { message: 'Gói tin không hợp lệ.' }); }
    if (message.type === 'create') {
      const room = rooms.createRoom();
      const joined = rooms.joinRoom(room.code, socket);
      socket.roomCode = room.code;
      send(socket, 'joined', { code: room.code, player: joined.player, state: room.state });
      return;
    }
    if (message.type === 'join') {
      const joined = rooms.joinRoom(message.code, socket);
      if (joined.error) return send(socket, 'error', { message: joined.error });
      socket.roomCode = joined.room.code;
      send(socket, 'joined', { code: joined.room.code, player: joined.player, state: joined.room.state });
      broadcast(joined.room, 'room-update', { state: joined.room.state });
      return;
    }
    if (message.type === 'move') {
      const room = rooms.getRoom(socket.roomCode);
      const player = room?.sockets.get(socket);
      if (!room || !player) return send(socket, 'error', { message: 'Bạn chưa ở trong phòng.' });
      const outcome = applyMove(room.state, player, message.from, message.to);
      if (!outcome.ok) return send(socket, 'error', { message: outcome.reason });
      broadcast(room, 'state', { state: room.state, result: outcome.result });
    }
  });
  socket.on('close', () => rooms.remove(socket));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`OTT V2 running at http://localhost:${port}`));
