const crypto = require('crypto');
const { createInitialState } = require('./gameState');

class RoomManager {
  constructor() { this.rooms = new Map(); }
  createRoom() {
    let code;
    do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (this.rooms.has(code));
    const room = { code, state: createInitialState(), sockets: new Map() };
    this.rooms.set(code, room);
    return room;
  }
  getRoom(code) { return this.rooms.get(String(code || '').toUpperCase()); }
  joinRoom(code, socket) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Không tìm thấy phòng.' };
    if (room.sockets.size >= 2) return { error: 'Phòng đã đủ người.' };
    const player = room.sockets.size === 0 ? 'p1' : 'p2';
    room.sockets.set(socket, player);
    room.state.players[player] = player;
    return { room, player };
  }
  remove(socket) {
    for (const [code, room] of this.rooms) {
      if (room.sockets.delete(socket)) {
        if (room.sockets.size === 0) this.rooms.delete(code);
        return room;
      }
    }
    return null;
  }
}
module.exports = RoomManager;
