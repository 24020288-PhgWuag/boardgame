const crypto = require('crypto');
const { createInitialState } = require('./gameState');

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(mode = 'classic') {
    let code;
    do {
      code = crypto.randomBytes(3).toString('hex').toUpperCase();
    } while (this.rooms.has(code));

    const room = {
      code,
      mode,
      createdAt: Date.now(),
      state: createInitialState(mode),
      sockets: new Map(), // socket -> 'p1' | 'p2' | 'spectator'
      spectators: new Set()
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase());
  }

  joinRoom(code, socket, requestedRole = null) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Không tìm thấy phòng đấu với mã này.' };

    // Check existing players in room
    let p1Taken = false;
    let p2Taken = false;

    for (const [s, role] of room.sockets.entries()) {
      if (s !== socket) {
        if (role === 'p1') p1Taken = true;
        if (role === 'p2') p2Taken = true;
      }
    }

    let role = null;
    if (requestedRole === 'spectator' || (p1Taken && p2Taken)) {
      role = 'spectator';
      room.spectators.add(socket);
    } else if (!p1Taken) {
      role = 'p1';
    } else if (!p2Taken) {
      role = 'p2';
    }

    room.sockets.set(socket, role);
    if (role === 'p1' || role === 'p2') {
      room.state.players[role] = role;
    }

    return { room, player: role };
  }

  resetRoom(code, mode = null) {
    const room = this.getRoom(code);
    if (!room) return null;
    const currentMode = mode || room.mode || 'classic';
    room.mode = currentMode;
    const newState = createInitialState(currentMode);
    
    // Retain connected player slots
    for (const [, role] of room.sockets.entries()) {
      if (role === 'p1' || role === 'p2') {
        newState.players[role] = role;
      }
    }
    room.state = newState;
    return room;
  }

  getPublicRooms() {
    const list = [];
    for (const [code, room] of this.rooms.entries()) {
      let p1 = false;
      let p2 = false;
      let spectators = 0;
      for (const [, role] of room.sockets.entries()) {
        if (role === 'p1') p1 = true;
        if (role === 'p2') p2 = true;
        if (role === 'spectator') spectators++;
      }
      list.push({
        code,
        mode: room.mode || 'classic',
        players: (p1 ? 1 : 0) + (p2 ? 1 : 0),
        spectators,
        started: Boolean(room.state.history.length),
        winner: room.state.winner
      });
    }
    return list;
  }

  remove(socket) {
    for (const [code, room] of this.rooms) {
      if (room.sockets.has(socket)) {
        const role = room.sockets.get(socket);
        room.sockets.delete(socket);
        room.spectators.delete(socket);

        if (role === 'p1' || role === 'p2') {
          room.state.players[role] = null;
        }

        // If room is completely empty, clean up
        if (room.sockets.size === 0) {
          this.rooms.delete(code);
          return { code, empty: true };
        }

        return { code, room, disconnectedRole: role, empty: false };
      }
    }
    return null;
  }
}

module.exports = RoomManager;
