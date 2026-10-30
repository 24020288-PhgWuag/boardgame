const assert = require('node:assert/strict');
const test = require('node:test');
const RoomStateStore = require('../src/roomStateStore');

class FakeRedis {
  constructor() {
    this.status = 'ready';
    this.values = new Map();
    this.published = [];
    this.lists = new Map();
  }

  duplicate() {
    return new FakeRedis();
  }

  multi() {
    const operations = [];
    const transaction = {
      set: (...args) => {
        operations.push(args);
        return transaction;
      },
      exec: async () => {
        for (const [key, value] of operations) this.values.set(key, value);
      }
    };
    return transaction;
  }

  async scan() {
    return ['0', [...this.values.keys()].filter(key => key.startsWith('boardgame:room:'))];
  }

  async mget(...keys) {
    return keys.map(key => this.values.get(key) || null);
  }

  async get(key) {
    return this.values.get(key) || null;
  }

  async publish(channel, value) {
    this.published.push({ channel, value });
  }

  async set() {
    return 'OK';
  }

  async lrange(key) {
    return this.lists.get(key) || [];
  }

  async del(key) {
    this.values.delete(key);
    this.lists.delete(key);
  }

  async rpush(key, ...items) {
    this.lists.set(key, [...(this.lists.get(key) || []), ...items]);
  }

  async expire() {}

  async eval() {
    return 1;
  }

  on() {}
}

test('persists room snapshots without process-local socket or bot objects', async () => {
  const redis = new FakeRedis();
  const store = new RoomStateStore('redis://unused', { redis, subscriber: new FakeRedis() });
  const room = {
    code: 'ABC123',
    mode: 'classic',
    createdAt: 123,
    matchResultId: 'match-1',
    host: 'p1',
    state: { players: { p1: 'alpha', p2: null }, history: [] },
    passwordHash: 'salt:hash',
    sockets: new Map([['socket', 'p1']]),
    bot: null,
    botMatch: null
  };

  await store.save(room);
  const [snapshot] = await store.loadRooms();

  assert.equal(snapshot.code, room.code);
  assert.equal(snapshot.host, 'p1');
  assert.equal(snapshot.state.players.p1, 'alpha');
  assert.equal(Object.hasOwn(snapshot, 'sockets'), false);
  assert.equal(redis.published.length, 1);
});

test('acquires and releases a Redis room lock', async () => {
  const redis = new FakeRedis();
  const store = new RoomStateStore('redis://unused', { redis, subscriber: new FakeRedis() });
  const release = await store.lock('ABC123');

  await release();
  assert.equal(redis.published.length, 0);
});

test('deletes a room snapshot and notifies other instances', async () => {
  const redis = new FakeRedis();
  const store = new RoomStateStore('redis://unused', { redis, subscriber: new FakeRedis() });
  redis.values.set('boardgame:room:ABC123', JSON.stringify({ code: 'ABC123' }));

  await store.deleteRoom('abc123');

  assert.equal(await store.get('ABC123'), null);
  assert.deepEqual(JSON.parse(redis.published[0].value), {
    kind: 'room-removed',
    code: 'ABC123',
    source: store.instanceId
  });
});

test('matches queued players across instances by mode and ELO', async () => {
  const redis = new FakeRedis();
  const store = new RoomStateStore('redis://unused', { redis, subscriber: new FakeRedis() });
  const first = {
    socketId: 'socket-1',
    instanceId: 'instance-1',
    userId: 'user-1',
    username: 'alpha',
    elo: 100,
    mode: 'classic'
  };
  const second = {
    socketId: 'socket-2',
    instanceId: 'instance-2',
    userId: 'user-2',
    username: 'beta',
    elo: 300,
    mode: 'classic'
  };

  assert.equal(await store.findMatchOrEnqueue(first), null);
  assert.equal((await store.findMatchOrEnqueue(second)).socketId, first.socketId);
  assert.deepEqual(await redis.lrange('boardgame:matchmaking:queue', 0, -1), []);
});
