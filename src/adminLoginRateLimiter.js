const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_TRACKED_KEYS = 10000;

function normalizedUsername(username) {
  return String(username).slice(0, 24).toLowerCase();
}

class AdminLoginRateLimiter {
  constructor(now = Date.now) {
    this.now = now;
    this.failures = new Map();
  }

  retryAfter(ip, username) {
    const now = this.now();
    for (const [key, entry] of this.failures) {
      if (entry.resetAt <= now) this.failures.delete(key);
    }
    const keys = [`ip:${ip}`, `username:${normalizedUsername(username)}`];
    const missingKeys = keys.filter(key => !this.failures.has(key)).length;
    if (this.failures.size + missingKeys > MAX_TRACKED_KEYS) return Math.ceil(WINDOW_MS / 1000);
    return Math.max(
      this.retryForKey(`ip:${ip}`, now),
      this.retryForKey(`username:${normalizedUsername(username)}`, now)
    );
  }

  retryForKey(key, now) {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.delete(key);
      return 0;
    }
    return entry.count >= MAX_FAILURES
      ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      : 0;
  }

  recordFailure(ip, username) {
    const now = this.now();
    const keys = [`ip:${ip}`, `username:${normalizedUsername(username)}`];
    const missingKeys = keys.filter(key => !this.failures.has(key)).length;
    if (this.failures.size + missingKeys > MAX_TRACKED_KEYS) return;
    for (const key of keys) {
      const current = this.failures.get(key);
      const entry = current && current.resetAt > now
        ? current
        : { count: 0, resetAt: now + WINDOW_MS };
      entry.count++;
      this.failures.set(key, entry);
    }
  }

  clear(ip, username) {
    this.failures.delete(`ip:${ip}`);
    this.failures.delete(`username:${normalizedUsername(username)}`);
  }
}

module.exports = AdminLoginRateLimiter;
