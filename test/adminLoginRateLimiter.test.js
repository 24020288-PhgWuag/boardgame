const assert = require('node:assert/strict');
const test = require('node:test');
const AdminLoginRateLimiter = require('../src/adminLoginRateLimiter');

test('blocks repeated failures by IP and username, then expires them', () => {
  let now = 0;
  const limiter = new AdminLoginRateLimiter(() => now);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(limiter.retryAfter('192.0.2.1', 'admin'), 0);
    limiter.recordFailure('192.0.2.1', 'admin');
  }

  assert.ok(limiter.retryAfter('192.0.2.1', 'another-admin') > 0);
  assert.ok(limiter.retryAfter('192.0.2.2', 'ADMIN') > 0);

  now += 15 * 60 * 1000;
  assert.equal(limiter.retryAfter('192.0.2.1', 'admin'), 0);
});

test('clears failure counters after successful authentication', () => {
  const limiter = new AdminLoginRateLimiter(() => 1000);
  for (let attempt = 0; attempt < 4; attempt++) {
    limiter.recordFailure('192.0.2.3', 'admin');
  }
  limiter.clear('192.0.2.3', 'ADMIN');

  assert.equal(limiter.retryAfter('192.0.2.3', 'admin'), 0);
});
