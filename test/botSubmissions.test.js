const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_SUBMISSIONS_PER_USER,
  countUserSubmissions,
  createSubmission
} = require('../src/botSubmissions');

test('stores a submission with owner and source checksum', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-bots-'));
  try {
    const user = { id: 'user-1', username: 'test-user' };
    const source = 'print("hello")';
    const result = createSubmission(directory, {
      filename: 'test.py',
      source,
      name: 'Test Bot',
      user
    });
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, `${result.id}.json`), 'utf8'));

    assert.equal(result.name, 'Test Bot');
    assert.equal(metadata.ownerId, user.id);
    assert.equal(metadata.sha256, crypto.createHash('sha256').update(source).digest('hex'));
    assert.equal(fs.readFileSync(path.join(directory, `${result.id}.py`), 'utf8'), source);
    assert.equal(countUserSubmissions(directory, user.id), 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects invalid files and caps submissions per account', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-bots-'));
  const user = { id: 'user-1', username: 'test-user' };
  try {
    assert.equal(createSubmission(directory, {
      filename: '../test.py', source: 'pass', user
    }).status, 400);
    assert.equal(createSubmission(directory, {
      filename: 'empty.py', source: '  ', user
    }).status, 400);
    assert.equal(createSubmission(directory, {
      filename: 'large.py', source: 'x'.repeat(256 * 1024 + 1), user
    }).status, 413);

    for (let index = 0; index < MAX_SUBMISSIONS_PER_USER; index++) {
      const result = createSubmission(directory, {
        filename: `bot-${index}.py`, source: 'pass', user
      });
      assert.ok(result.id);
    }
    assert.equal(countUserSubmissions(directory, user.id), MAX_SUBMISSIONS_PER_USER);
    assert.equal(createSubmission(directory, {
      filename: 'one-too-many.py', source: 'pass', user
    }).status, 409);
    assert.equal(countUserSubmissions(directory, 'other-user'), 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts a source exactly at the 256 KiB limit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-bots-'));
  try {
    const result = createSubmission(directory, {
      filename: 'maximum.py',
      source: 'x'.repeat(256 * 1024),
      user: { id: 'user-1', username: 'test-user' }
    });

    assert.ok(result.id);
    assert.equal(fs.statSync(path.join(directory, `${result.id}.py`)).size, 256 * 1024);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
