const assert = require('node:assert/strict');
const test = require('node:test');
const RoomManager = require('../src/roomManager');

test('restores persisted room state and reclaims a disconnected player seat', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const originalPlayer = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, originalPlayer);
  room.state.players.p1 = 'alpha';
  room.host = 'p1';
  room.state.history.push({ player: 'p1' });
  const snapshot = {
    code: room.code,
    mode: room.mode,
    createdAt: room.createdAt,
    matchResultId: room.matchResultId,
    state: room.state,
    host: room.host,
    passwordHash: null,
    disconnectedPlayers: ['p1']
  };

  manager.remove(originalPlayer);
  const restored = manager.restoreRoom(snapshot);
  assert.equal(restored.disconnectedPlayers.has('p1'), true);
  const returningPlayer = { user: { username: 'alpha' } };
  const joined = manager.joinRoom(room.code, returningPlayer);

  assert.equal(restored.state.history.length, 1);
  assert.equal(restored.host, 'p1');
  assert.equal(joined.player, 'p1');
  assert.equal(restored.disconnectedPlayers.has('p1'), false);
  assert.equal(restored.state.players.p1, 'alpha');
});

test('does not let a different user claim a reserved disconnected seat', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const firstPlayer = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, firstPlayer);
  room.state.players.p1 = 'alpha';
  manager.remove(firstPlayer);

  const secondPlayer = { user: { username: 'beta' } };
  assert.equal(manager.joinRoom(room.code, secondPlayer).player, 'p2');
});

test('does not let one account occupy both player seats', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const firstSocket = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, firstSocket);
  room.state.players.p1 = 'alpha';

  const duplicateSocket = { user: { username: 'alpha' } };
  assert.equal(manager.joinRoom(room.code, duplicateSocket).player, 'spectator');
});

test('hides an empty room from the public list while retaining its reconnect seat', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const player = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, player);
  room.state.players.p1 = 'alpha';

  manager.remove(player);

  assert.equal(manager.getRoom(room.code), room);
  assert.deepEqual(manager.getPublicRooms(), []);

  const returningPlayer = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, returningPlayer);
  assert.equal(manager.getPublicRooms().length, 1);
});

test('hides a room with only spectators and disconnected player seats', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const player = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, player);
  room.state.players.p1 = 'alpha';
  manager.remove(player);
  manager.joinRoom(room.code, {}, 'spectator');

  assert.deepEqual(manager.getPublicRooms(), []);
});

test('keeps a room visible when its connected player is on another server instance', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  room.state.players.p1 = 'alpha';

  assert.equal(manager.getPublicRooms().length, 1);
});

test('explicitly leaving frees the player seat so the empty room can be deleted', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const player = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, player);
  room.state.players.p1 = 'alpha';

  const result = manager.leave(player);
  assert.equal(result.empty, true);
  assert.equal(room.state.players.p1, null);
  assert.equal(manager.deleteRoom(room.code), true);
  assert.equal(manager.getRoom(room.code), undefined);
  assert.deepEqual(manager.getPublicRooms(), []);
});

test('keeps the room open when another player remains after an explicit leave', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const firstPlayer = { user: { username: 'alpha' } };
  const secondPlayer = { user: { username: 'beta' } };
  manager.joinRoom(room.code, firstPlayer);
  manager.joinRoom(room.code, secondPlayer);
  room.state.players.p1 = 'alpha';
  room.state.players.p2 = 'beta';
  assert.equal(room.host, 'p1');

  const result = manager.leave(firstPlayer);

  assert.equal(result.empty, false);
  assert.equal(room.host, 'p2');
  assert.equal(manager.getRoom(room.code), room);
  assert.equal(manager.getPublicRooms()[0].players, 1);
});

test('transfers host after an unexpected disconnect when another player remains', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const firstPlayer = { user: { username: 'alpha' } };
  const secondPlayer = { user: { username: 'beta' } };
  manager.joinRoom(room.code, firstPlayer);
  manager.joinRoom(room.code, secondPlayer);
  room.state.players.p1 = 'alpha';
  room.state.players.p2 = 'beta';

  manager.remove(firstPlayer);

  assert.equal(room.host, 'p2');
});

test('restoring an explicit null host does not resurrect a stale host', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  room.host = 'p1';
  const snapshot = {
    code: room.code,
    mode: room.mode,
    createdAt: room.createdAt,
    matchResultId: room.matchResultId,
    host: null,
    state: room.state,
    disconnectedPlayers: []
  };

  assert.equal(manager.restoreRoom(snapshot), room);
  assert.equal(room.host, null);
});

test('force deletion removes a room even when remote player sockets are attached', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const player = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, player);

  assert.equal(manager.deleteRoom(room.code), false);
  assert.equal(manager.deleteRoom(room.code, { force: true }), true);
  assert.equal(manager.getRoom(room.code), undefined);
  assert.deepEqual(manager.getPublicRooms(), []);
});
