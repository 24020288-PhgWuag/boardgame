const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const TournamentManager = require('../src/tournamentManager');

test('plans a 10,000-bot, 14-round Swiss event without running bot code', { timeout: 60_000 }, () => {
  const botCount = 10_000;
  const roundCount = 14;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-swiss-scale-'));
  const botScript = path.join(__dirname, '..', 'bots', 'random_bot.py');
  const manager = new TournamentManager(directory, {
    resolveBot: id => ({ id, name: id, script: botScript }),
    runMatch: async () => { throw new Error('Scale test must not execute bot code.'); },
    maxBots: botCount,
    autoStart: false
  });
  const botIds = Array.from({ length: botCount }, (_, index) => `synthetic-${String(index).padStart(5, '0')}`);
  const opponentPairs = new Set();
  const sideCounts = new Map(botIds.map(id => [id, { p1: 0, p2: 0, played: 0 }]));
  const startedAt = performance.now();

  try {
    const tournament = manager.create({
      name: 'Synthetic 10k Swiss scale test',
      botIds,
      mode: 'classic',
      maxTurns: 20,
      format: 'swiss-playoff'
    });

    assert.equal(tournament.bots.length, botCount);
    assert.equal(tournament.totalRounds, roundCount);
    assert.equal(tournament.format, 'swiss-playoff');
    assert.equal(tournament.matches.length, botCount / 2);
    assert.equal(tournament.status, 'queued');
    assert.ok(fs.existsSync(manager.file(tournament.id)));
    const metadata = JSON.parse(fs.readFileSync(manager.file(tournament.id), 'utf8'));
    assert.equal(metadata.matches, undefined, 'large match data is stored separately from tournament metadata');
    assert.equal(metadata.bots, undefined, 'bot snapshots are stored separately from tournament metadata');

    for (let round = 1; round <= roundCount; round++) {
      const matches = round === 1
        ? tournament.matches
        : manager.createSwissRound(tournament, round);
      assert.equal(matches.length, botCount / 2, `round ${round} match count`);
      const roundParticipants = new Set();

      for (const match of matches) {
        assert.ok(match.p1BotId && match.p2BotId, `round ${round} contains no byes`);
        assert.ok(!roundParticipants.has(match.p1BotId), `round ${round} repeats P1`);
        assert.ok(!roundParticipants.has(match.p2BotId), `round ${round} repeats P2`);
        roundParticipants.add(match.p1BotId);
        roundParticipants.add(match.p2BotId);

        const pair = manager.pairKey(match.p1BotId, match.p2BotId);
        assert.ok(!opponentPairs.has(pair), `rematch found in round ${round}`);
        opponentPairs.add(pair);

        sideCounts.get(match.p1BotId).p1++;
        sideCounts.get(match.p2BotId).p2++;
        match.status = 'completed';
        match.result = { winnerBotId: null, draw: true, bye: false };
      }

      assert.equal(roundParticipants.size, botCount, `round ${round} pairs every bot once`);
      if (round > 1) tournament.matches.push(...matches);
    }

    const standings = manager.standings(tournament);
    assert.equal(tournament.matches.length, botCount / 2 * roundCount);
    assert.equal(standings.length, botCount);
    for (const row of standings) {
      assert.equal(row.played, roundCount);
      assert.equal(row.points, roundCount / 2);
    }
    for (const sides of sideCounts.values()) {
      assert.ok(Math.abs(sides.p1 - sides.p2) <= 1, 'first-player assignments stay balanced');
    }

    console.log(`10k synthetic Swiss schedule: ${tournament.matches.length.toLocaleString()} matches across ${roundCount} rounds in ${(performance.now() - startedAt).toFixed(0)} ms; bot code not executed.`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Swiss playoff advances eight seeded bots through a replayable three-round bracket', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-swiss-playoff-'));
  const botScript = path.join(__dirname, '..', 'bots', 'random_bot.py');
  const manager = new TournamentManager(directory, {
    resolveBot: id => ({ id, name: id, script: botScript }),
    runMatch: async () => ({ winner: 'p1', turns: 4, reason: 'Synthetic winner' }),
    maxBots: 8,
    autoStart: false
  });
  try {
    const tournament = manager.create({
      name: 'Synthetic playoff', botIds: Array.from({ length: 8 }, (_, i) => `bot-${i}`),
      mode: 'classic', maxTurns: 20, format: 'swiss-playoff'
    });
    tournament.totalRounds = 1;
    for (const match of tournament.matches) {
      match.status = 'completed';
      match.result = { winnerBotId: match.p1BotId, winnerBotName: match.p1BotName, draw: false };
    }
    manager.write(tournament);
    await manager.playTopEightPlayoff(tournament, new Map(tournament.bots.map(bot => [bot.id, bot])));

    const playoff = tournament.matches.filter(match => match.stage === 'winners' || match.stage === 'losers' || match.stage === 'grand-final');
    assert.equal(playoff.length, 14);
    assert.equal(new Set(playoff.map(match => match.round)).size, 8);
    assert.equal(tournament.champion, tournament.bots[0].name);
    assert.equal(manager.standings(tournament).reduce((sum, row) => sum + row.played, 0), 8,
      'playoff matches do not alter Swiss standings');
    assert.equal(manager.read(tournament.id).matches.length, 18, 'match log reconstructs across restarts');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('playoff draws are replayed until a winner emerges', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boardgame-playoff-draw-'));
  const botScript = path.join(__dirname, '..', 'bots', 'random_bot.py');
  let attempts = 0;
  const manager = new TournamentManager(directory, {
    resolveBot: id => ({ id, name: id, script: botScript }),
    runMatch: async () => {
      attempts++;
      return attempts < 3
        ? { winner: null, turns: 4, reason: 'Synthetic draw' }
        : { winner: 'p1', turns: 5, reason: 'Synthetic winner' };
    },
    maxBots: 4,
    autoStart: false
  });
  try {
    const tournament = manager.create({
      name: 'Playoff draw retry', botIds: ['bot-a', 'bot-b'],
      mode: 'classic', maxTurns: 20, format: 'swiss-playoff'
    });
    const match = {
      id: `${tournament.id}-draw`, stage: 'winners', round: 2,
      p1BotId: 'bot-a', p2BotId: 'bot-b',
      p1BotName: 'bot-a', p2BotName: 'bot-b',
      status: 'queued', result: null
    };
    tournament.matches.push(match);
    await manager.playMatch(tournament, match, new Map(tournament.bots.map(bot => [bot.id, bot])));

    assert.equal(attempts, 3, 'playoff match retries after each draw');
    assert.equal(match.status, 'completed');
    assert.equal(match.result.draw, false);
    assert.equal(match.result.winnerBotId, 'bot-a');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
