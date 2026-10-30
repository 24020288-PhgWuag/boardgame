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
    assert.equal(created.user.isAdmin, false);
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

test('provisions a separate Admin account and rotates its configured password', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-admin-'));
  const store = new AuthStore(path.join(directory, 'users.sqlite'));
  try {
    const result = store.provisionAdminAccount('site-admin', 'admin-password-1');
    assert.ok(result.user);
    assert.equal(result.user.isAdmin, true);
    assert.equal(store.isAdmin(result.user.id), true);
    assert.ok(store.authenticate('site-admin', 'admin-password-1'));
    assert.equal(store.authenticate('site-admin', 'x'.repeat(10000)), null);

    const rotated = store.provisionAdminAccount('site-admin', 'admin-password-2');
    assert.ok(rotated.user);
    assert.equal(store.authenticate('site-admin', 'admin-password-1'), null);
    assert.ok(store.authenticate('site-admin', 'admin-password-2'));
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not promote a normal account to Admin during provisioning', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-admin-'));
  const store = new AuthStore(path.join(directory, 'users.sqlite'));
  try {
    const regular = store.createUser('reserved-admin', 'regular-password');
    const result = store.provisionAdminAccount('reserved-admin', 'admin-password');

    assert.match(result.error, /đã thuộc về tài khoản người dùng/);
    assert.equal(store.isAdmin(regular.user.id), false);
    assert.equal(store.authenticate('reserved-admin', 'wrong'), null);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not grant Admin by username alone', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-admin-'));
  const store = new AuthStore(path.join(directory, 'users.sqlite'));
  const previousAdminUsername = process.env.ADMIN_USERNAME;
  try {
    const regular = store.createUser('username-only', 'regular-password');
    process.env.ADMIN_USERNAME = 'username-only';

    assert.equal(store.isAdmin(regular.user.id), false);
  } finally {
    if (previousAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previousAdminUsername;
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
