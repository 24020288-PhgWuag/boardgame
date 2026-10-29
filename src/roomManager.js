const crypto = require('crypto');
const { createInitialState } = require('./gameState');

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(mode = 'army', password = '') {
    let code;
    do {
      code = crypto.randomBytes(5).toString('hex').toUpperCase();
    } while (this.rooms.has(code));

    const room = {
      code,
      mode,
      createdAt: Date.now(),
      matchResultId: crypto.randomUUID(),
      state: createInitialState(mode),
      sockets: new Map(), // socket -> 'p1' | 'p2' | 'spectator'
      spectators: new Set(),
      disconnectedPlayers: new Set(),
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

    let role = null;
    const username = socket.user?.username;
    if (requestedRole === 'spectator') {
      role = 'spectator';
      room.spectators.add(socket);
    } else {
      const occupied = new Set(room.sockets.values());
      const returningRole = ['p1', 'p2'].find(player =>
        username && room.state.players[player] === username &&
        room.disconnectedPlayers.has(player) && !occupied.has(player)
      );
      const alreadySeated = username && ['p1', 'p2'].some(player =>
        room.state.players[player] === username
      );
      const availableRole = alreadySeated ? null : ['p1', 'p2'].find(player =>
        !occupied.has(player) && !room.state.players[player]
      );
      if (returningRole) role = returningRole;
      else if (availableRole) role = availableRole;
      else role = 'spectator';
      if (role === 'spectator') room.spectators.add(socket);
    }

    room.sockets.set(socket, role);
    if (role === 'p1' || role === 'p2') {
      room.state.players[role] ||= username || role;
      room.disconnectedPlayers.delete(role);
    }

    return { room, player: role };
  }

  restoreRoom(snapshot, { assumeDisconnected = false } = {}) {
    if (!snapshot || typeof snapshot.code !== 'string' ||
        !snapshot.state?.players || !snapshot.state.board) return null;
    const disconnectedPlayers = assumeDisconnected
      ? ['p1', 'p2'].filter(player => snapshot.state.players[player])
      : (Array.isArray(snapshot.disconnectedPlayers) ? snapshot.disconnectedPlayers : [])
        .filter(player => player === 'p1' || player === 'p2');
    const existing = this.getRoom(snapshot.code);
    if (existing) {
      existing.mode = snapshot.mode;
      existing.createdAt = snapshot.createdAt;
      existing.matchResultId = snapshot.matchResultId;
      existing.passwordHash = snapshot.passwordHash || null;
      existing.state = snapshot.state;
      existing.turnDeadline = snapshot.turnDeadline || null;
      existing.ratingUpdated = Boolean(snapshot.ratingUpdated);
      existing.resultQueued = Boolean(snapshot.resultQueued);
      existing.disconnectedPlayers = new Set(disconnectedPlayers);
      return existing;
    }

    const room = {
      ...snapshot,
      sockets: new Map(),
      spectators: new Set(),
      disconnectedPlayers: new Set(disconnectedPlayers),
      bot: null,
      botMatch: null,
      turnTimer: null
    };
    this.rooms.set(room.code, room);
    return room;
  }

  resetRoom(code, mode = null) {
    const room = this.getRoom(code);
    if (!room) return null;
    const currentMode = mode || room.mode || 'army';
    room.mode = currentMode;
    room.matchResultId = crypto.randomUUID();
    room.resultQueued = false;
    const newState = createInitialState(currentMode);
    newState.players = { ...room.state.players };
    room.state = newState;
    return room;
  }

  getPublicRooms() {
    const list = [];
    for (const [code, room] of this.rooms.entries()) {
      let p1 = Boolean(room.state.players.p1);
      let p2 = Boolean(room.state.players.p2 || room.bot || room.botMatch);
      let spectators = 0;
      for (const [, role] of room.sockets.entries()) {
        if (role === 'p1') p1 = true;
        if (role === 'p2') p2 = true;
        if (role === 'spectator') spectators++;
      }
      if ((p1 && p2) || room.state.history.length || room.bot || room.botMatch) continue;
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
        if (role === 'p1' || role === 'p2') room.disconnectedPlayers.add(role);

        // Keep the seat identity so the same authenticated player can reconnect.
        if (room.sockets.size === 0) {
          clearTimeout(room.turnTimer);
          if (room.bot || room.botMatch) this.deleteRoom(code);
          return { code, room, disconnectedRole: role, empty: true };
        }

        return { code, room, disconnectedRole: role, empty: false };
      }
    }
    return null;
  }

  deleteRoom(code) {
    const room = this.getRoom(code);
    if (!room || room.sockets.size) return false;
    room.bot?.stop();
    room.botMatch?.p1?.stop();
    room.botMatch?.p2?.stop();
    clearTimeout(room.turnTimer);
    this.rooms.delete(room.code);
    return true;
  }
}

module.exports = RoomManager;
