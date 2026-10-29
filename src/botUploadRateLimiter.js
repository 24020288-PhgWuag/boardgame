const WINDOW_MS = 60 * 1000;
const MAX_TRACKED_KEYS = 10000;
const IP_LIMIT = 10;
const USER_LIMIT = 5;

class BotUploadRateLimiter {
  constructor(now = Date.now) {
    this.now = now;
    this.requests = new Map();
  }

  consumeKey(key, limit, now) {
    const recent = (this.requests.get(key) || [])
      .filter(timestamp => now - timestamp < WINDOW_MS);
    if (recent.length >= limit) {
      return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    }

    if (!this.requests.has(key) && this.requests.size >= MAX_TRACKED_KEYS) {
      for (const [trackedKey, timestamps] of this.requests) {
        if (!timestamps.some(timestamp => now - timestamp < WINDOW_MS)) {
          this.requests.delete(trackedKey);
        }
      }
      if (this.requests.size >= MAX_TRACKED_KEYS) return Math.ceil(WINDOW_MS / 1000);
    }

    recent.push(now);
    this.requests.set(key, recent);
    return 0;
  }

  consume(ip, userId) {
    const now = this.now();
    const ipRetryAfter = this.consumeKey(`ip:${ip}`, IP_LIMIT, now);
    if (ipRetryAfter) return ipRetryAfter;
    return this.consumeKey(`user:${userId}`, USER_LIMIT, now);
  }
}

module.exports = BotUploadRateLimiter;
