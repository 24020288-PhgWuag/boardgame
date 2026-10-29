const assert = require('node:assert/strict');
const test = require('node:test');
const RoomManager = require('../src/roomManager');

test('restores persisted room state and reclaims a disconnected player seat', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('classic');
  const originalPlayer = { user: { username: 'alpha' } };
  manager.joinRoom(room.code, originalPlayer);
  room.state.players.p1 = 'alpha';
  room.state.history.push({ player: 'p1' });
  const snapshot = {
    code: room.code,
    mode: room.mode,
    createdAt: room.createdAt,
    matchResultId: room.matchResultId,
    state: room.state,
    passwordHash: null,
    disconnectedPlayers: ['p1']
  };

  manager.remove(originalPlayer);
  const restored = manager.restoreRoom(snapshot);
  assert.equal(restored.disconnectedPlayers.has('p1'), true);
  const returningPlayer = { user: { username: 'alpha' } };
  const joined = manager.joinRoom(room.code, returningPlayer);

  assert.equal(restored.state.history.length, 1);
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
