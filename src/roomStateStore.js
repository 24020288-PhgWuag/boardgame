const crypto = require('crypto');
const Redis = require('ioredis');

const ROOM_PREFIX = 'boardgame:room:';
const ROOM_EVENTS = 'boardgame:room-events';
const ROOM_TTL_SECONDS = 24 * 60 * 60;
const MATCHMAKING_QUEUE = 'boardgame:matchmaking:queue';
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

class RoomStateStore {
  constructor(url, options = {}) {
    if (!url) throw new Error('A Redis URL is required for room state persistence.');
    this.redis = options.redis || new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: attempt => Math.min(attempt * 250, 2000)
    });
    this.subscriber = options.subscriber || this.redis.duplicate();
    this.instanceId = options.instanceId || crypto.randomUUID();
    this.connected = false;
    this.redis.on('error', error => console.error('Room-state Redis error:', error.message));
    this.subscriber.on('error', error => console.error('Room-state Redis subscriber error:', error.message));
  }

  async connect() {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      if (this.subscriber.status === 'wait') await this.subscriber.connect();
      await this.subscriber.subscribe(ROOM_EVENTS);
      this.connected = true;
    } catch (error) {
      this.redis.disconnect();
      this.subscriber.disconnect();
      throw error;
    }
  }

  async loadRooms() {
    const rooms = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${ROOM_PREFIX}??????????`,
        'COUNT',
        100
      );
      cursor = nextCursor;
      if (keys.length) {
        const values = await this.redis.mget(...keys);
        for (const value of values) {
          if (!value) continue;
          try {
            rooms.push(JSON.parse(value));
          } catch (error) {
            console.error('Skipping invalid persisted room state:', error.message);
          }
        }
      }
    } while (cursor !== '0');
    return rooms;
  }

  snapshot(room) {
    return {
      code: room.code,
      mode: room.mode,
      createdAt: room.createdAt,
      matchResultId: room.matchResultId,
      passwordHash: room.passwordHash,
      state: room.state,
      disconnectedPlayers: [...(room.disconnectedPlayers || [])],
      turnDeadline: room.turnDeadline || null,
      ratingUpdated: Boolean(room.ratingUpdated),
      resultQueued: Boolean(room.resultQueued)
    };
  }

  async save(room) {
    const snapshot = this.snapshot(room);
    const results = await this.redis
      .multi()
      .set(`${ROOM_PREFIX}${room.code}`, JSON.stringify(snapshot), 'EX', ROOM_TTL_SECONDS)
      .exec();
    const failed = results?.find(([error]) => error);
    if (failed) throw failed[0];
    await this.publish({ kind: 'snapshot', snapshot });
  }

  async get(code) {
    const value = await this.redis.get(`${ROOM_PREFIX}${String(code).toUpperCase()}`);
    return value ? JSON.parse(value) : null;
  }

  async lock(code, timeoutMs = 3000) {
    const key = `${ROOM_PREFIX}${String(code).toUpperCase()}:lock`;
    const token = crypto.randomUUID();
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.redis.set(key, token, 'PX', 10000, 'NX') === 'OK') {
        return async () => {
          await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
        };
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(`Timed out acquiring room lock for ${code}.`);
  }

  async findMatchOrEnqueue(player) {
    const release = await this.lock('MATCHMAKING');
    try {
      const rawEntries = await this.redis.lrange(MATCHMAKING_QUEUE, 0, -1);
      const queued = rawEntries.flatMap(raw => {
        try {
          const entry = JSON.parse(raw);
          return entry.expiresAt > Date.now() && entry.userId !== player.userId
            ? [{ raw, entry }]
            : [];
        } catch {
          return [];
        }
      });
      const candidate = queued.find(({ entry }) =>
        entry.userId !== player.userId &&
        entry.mode === player.mode &&
        Math.abs(entry.elo - player.elo) <= 250
      );
      if (!candidate && queued.length >= 10000) {
        throw new Error('Matchmaking queue is full.');
      }

      await this.redis.del(MATCHMAKING_QUEUE);
      const remaining = candidate
        ? queued.filter(item => item.entry.userId !== candidate.entry.userId)
        : queued;
      const nextQueue = candidate
        ? remaining.map(item => item.raw)
        : [...remaining.map(item => item.raw), JSON.stringify({
          ...player,
          expiresAt: Date.now() + 10 * 60 * 1000
        })];
      if (nextQueue.length) {
        await this.redis.rpush(MATCHMAKING_QUEUE, ...nextQueue);
        await this.redis.expire(MATCHMAKING_QUEUE, 10 * 60);
      }
      return candidate?.entry || null;
    } finally {
      await release();
    }
  }

  async removeMatchmakingPlayer(socketId) {
    const release = await this.lock('MATCHMAKING');
    try {
      const entries = await this.redis.lrange(MATCHMAKING_QUEUE, 0, -1);
      const remaining = entries.filter(raw => {
        try {
          return JSON.parse(raw).socketId !== socketId;
        } catch {
          return false;
        }
      });
      await this.redis.del(MATCHMAKING_QUEUE);
      if (remaining.length) {
        await this.redis.rpush(MATCHMAKING_QUEUE, ...remaining);
        await this.redis.expire(MATCHMAKING_QUEUE, 10 * 60);
      }
    } finally {
      await release();
    }
  }

  async publish(event) {
    await this.redis.publish(ROOM_EVENTS, JSON.stringify({
      ...event,
      source: this.instanceId
    }));
  }

  subscribe(handler) {
    this.subscriber.on('message', (channel, raw) => {
      if (channel !== ROOM_EVENTS) return;
      try {
        const event = JSON.parse(raw);
        if (event.source !== this.instanceId) handler(event);
      } catch (error) {
        console.error('Could not process Redis room event:', error.message);
      }
    });
  }

  async close() {
    this.connected = false;
    await Promise.all([this.subscriber.quit(), this.redis.quit()]);
  }
}

module.exports = RoomStateStore;
