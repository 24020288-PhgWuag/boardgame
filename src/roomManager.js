const crypto = require('crypto');
const { createInitialState } = require('./gameState');

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(mode = 'army', password = '') {
    let code;
    do {
      code = crypto.randomBytes(3).toString('hex').toUpperCase();
    } while (this.rooms.has(code));

    const room = {
      code,
      mode,
      createdAt: Date.now(),
      matchResultId: crypto.randomUUID(),
      state: createInitialState(mode),
      sockets: new Map(), // socket -> 'p1' | 'p2' | 'spectator'
      spectators: new Set(),
      bot: null,
      botMatch: null,
      ratingUpdated: false,
      passwordHash: password ? this.hashRoomPassword(password) : null
    };
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase());
  }

  hashRoomPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  verifyRoomPassword(room, password) {
    if (!room.passwordHash) return true;
    const [salt, expected] = room.passwordHash.split(':');
    if (!salt || !expected || typeof password !== 'string') return false;
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    const actualBuffer = Buffer.from(actual, 'hex');
    return actualBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  joinRoom(code, socket, requestedRole = null) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Không tìm thấy phòng đấu với mã này.' };

    // Rejoining the same socket should keep its current seat instead of creating duplicates.
    const existingRole = room.sockets.get(socket);
    if (existingRole) {
      return { room, player: existingRole };
    }

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
    const currentMode = mode || room.mode || 'army';
    room.mode = currentMode;
    room.matchResultId = crypto.randomUUID();
    room.resultQueued = false;
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
      let p2 = Boolean(room.bot || room.botMatch);
      let spectators = 0;
      for (const [, role] of room.sockets.entries()) {
        if (role === 'p1') p1 = true;
        if (role === 'p2') p2 = true;
        if (role === 'spectator') spectators++;
      }
      if (p1 && p2 || room.state.history.length || room.bot || room.botMatch) continue;
      list.push({
        code,
        mode: room.mode || 'army',
        players: (p1 ? 1 : 0) + (p2 ? 1 : 0),
        spectators,
        passwordProtected: Boolean(room.passwordHash),
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
          room.bot?.stop();
          room.botMatch?.p1?.stop();
          room.botMatch?.p2?.stop();
          clearTimeout(room.turnTimer);
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
