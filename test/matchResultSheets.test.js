const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const TournamentManager = require('../src/tournamentManager');
const { router, validateRecord } = require('../src/matchResultSheets');

test('normalizes valid match result rows', () => {
  assert.deepEqual(validateRecord({
    matchId: 'match-1',
    bot1: ' Alpha ',
    bot2: 'Beta',
    winner: 'bot1',
    playedAt: '2026-10-25T12:00:00Z'
  }), {
    matchId: 'match-1',
    bot1: 'Alpha',
    bot2: 'Beta',
    winner: 'bot1',
    playedAt: '2026-10-25T12:00:00.000Z'
  });
});

test('rejects invalid bot names, outcomes, and match IDs', () => {
  const valid = {
    matchId: 'match-1',
    bot1: 'Alpha',
    bot2: 'Beta',
    winner: 'draw'
  };
  assert.equal(validateRecord({ ...valid, winner: 'unknown' }), null);
  assert.equal(validateRecord({ ...valid, matchId: 'contains spaces' }), null);
  assert.equal(validateRecord({ ...valid, bot1: '' }), null);
});

test('ingestion endpoint authenticates and validates before enqueueing', async () => {
  process.env.MATCH_INGEST_TOKEN = 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/match-results', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/api/match-results`;

  try {
    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matchId: 'm1' })
    });
    assert.equal(unauthorized.status, 401);

    const invalid = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ matchId: 'm1', winner: 'invalid' })
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete process.env.MATCH_INGEST_TOKEN;
  }
});

test('completed tournament matches are forwarded to the result queue callback', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-tournament-test-'));
  const reported = [];
  const p1 = { id: 'bot-a', name: 'Alpha', script: 'alpha.py' };
  const p2 = { id: 'bot-b', name: 'Beta', script: 'beta.py' };
  const manager = new TournamentManager(directory, {
    resolveBot: () => null,
    runMatch: async () => ({ winner: 'p2', turns: 8, reason: 'Won' }),
    onMatchComplete: result => reported.push(result)
  });
  const tournamentId = 'a3be77cd-098b-42f3-a4a2-68e58bb649b2';
  const tournament = { id: tournamentId, mode: 'classic', maxTurns: 20, matches: [] };
  const match = {
    id: `${tournamentId}-001`,
    p1BotId: p1.id,
    p2BotId: p2.id,
    p1BotName: p1.name,
    p2BotName: p2.name,
    status: 'queued'
  };

  try {
    await manager.playMatch(tournament, match, new Map([[p1.id, p1], [p2.id, p2]]));
    assert.equal(reported.length, 1);
    assert.deepEqual(
      { matchId: reported[0].matchId, bot1: reported[0].bot1, bot2: reported[0].bot2, winner: reported[0].winner },
      { matchId: match.id, bot1: 'Alpha', bot2: 'Beta', winner: 'bot2' }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
