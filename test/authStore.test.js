const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AuthStore } = require('../src/authStore');

test('session survives store restart and can be revoked', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-auth-'));
  const databasePath = path.join(directory, 'users.sqlite');
  let store = new AuthStore(databasePath);
  try {
    const created = store.createUser('reconnect-user', 'test-password-123');
    assert.ok(created.user);
    const token = store.createSession(created.user);
    store.close();

    store = new AuthStore(databasePath);
    assert.equal(store.getSession(token).username, 'reconnect-user');
    store.destroySession(token);
    assert.equal(store.getSession(token), null);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
