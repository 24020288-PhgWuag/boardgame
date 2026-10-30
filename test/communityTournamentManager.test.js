const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const CommunityTournamentManager = require('../src/communityTournamentManager');

test('players join first, upload a bot later, and only complete entries can start', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-community-'));
  let startedEvent;
  const manager = new CommunityTournamentManager(path.join(directory, 'events.json'), {
    startTournament: event => {
      startedEvent = event;
      return { id: 'tournament-1' };
    }
  });
  try {
    const event = manager.create({ name: 'Community Cup', mode: 'classic', maxTurns: 100 });
    const first = { userId: 'user-1', username: 'alpha' };
    const second = { userId: 'user-2', username: 'beta' };

    assert.equal(manager.register(event.id, first).event.players[0].botId, null);
    assert.match(manager.start(event.id).error, /ít nhất 2 bot/);
    assert.match(manager.canSubmitBot(event.id, 'user-3').error, /Tham gia giải trước/);
    assert.ok(manager.register(event.id, second).event);
    assert.match(manager.start(event.id).error, /tải bot lên/);
    assert.match(manager.register(event.id, first).error, /một bot/);

    assert.ok(manager.submitBot(event.id, first.userId, {
      botId: 'submission:bot-1',
      botName: 'Alpha Bot'
    }).event);
    assert.match(manager.submitBot(event.id, first.userId, {
      botId: 'submission:bot-2',
      botName: 'Second Bot'
    }).error, /đã tải bot/);
    assert.ok(manager.submitBot(event.id, second.userId, {
      botId: 'submission:bot-2',
      botName: 'Beta Bot'
    }).event);

    const result = manager.start(event.id);
    assert.equal(result.event.status, 'running');
    assert.equal(result.event.tournamentId, 'tournament-1');
    assert.equal(startedEvent.players.every(player => player.botId), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('event capacity is configurable and enforced', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-community-'));
  const manager = new CommunityTournamentManager(path.join(directory, 'events.json'), {
    startTournament: () => ({ id: 'unused' })
  });
  try {
    const event = manager.create({ name: 'Big', mode: 'classic', maxTurns: 100, maxPlayers: 2 });
    assert.equal(event.maxPlayers, 2);
    manager.register(event.id, { userId: 'u1', username: 'a' });
    manager.register(event.id, { userId: 'u2', username: 'b' });
    assert.match(manager.register(event.id, { userId: 'u3', username: 'c' }).error, /đủ 2 người/);
    assert.equal(manager.create({ name: 'Default', mode: 'classic', maxTurns: 100 }).maxPlayers, 12);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('public event listing does not expose uploaded bot source', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-community-'));
  const manager = new CommunityTournamentManager(path.join(directory, 'events.json'), {
    startTournament: () => ({ id: 'unused' })
  });
  try {
    const event = manager.create({ name: 'Public', mode: 'classic', maxTurns: 100 });
    manager.register(event.id, { userId: 'user-1', username: 'alpha' });
    event.players[0].source = 'private source';
    manager.save();
    const listed = manager.list();

    assert.equal(Object.hasOwn(listed[0].players[0], 'source'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
