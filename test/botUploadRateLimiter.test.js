const assert = require('node:assert/strict');
const test = require('node:test');
const BotUploadRateLimiter = require('../src/botUploadRateLimiter');

test('limits upload rates by both IP and account and expires requests', () => {
  let now = 0;
  const limiter = new BotUploadRateLimiter(() => now);

  for (let index = 0; index < 5; index++) {
    assert.equal(limiter.consume('192.0.2.1', 'user-1'), 0);
  }
  assert.ok(limiter.consume('192.0.2.1', 'user-1') > 0);
  assert.equal(limiter.consume('192.0.2.1', 'user-2'), 0);

  now += 60 * 1000;
  assert.equal(limiter.consume('192.0.2.1', 'user-1'), 0);
});

test('limits upload bursts from an IP across multiple accounts', () => {
  const limiter = new BotUploadRateLimiter(() => 1000);
  for (let index = 0; index < 10; index++) {
    assert.equal(limiter.consume('192.0.2.2', `user-${index}`), 0);
  }
  assert.ok(limiter.consume('192.0.2.2', 'another-user') > 0);
});
