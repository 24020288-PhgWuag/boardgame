const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function renameWithRetry(source, destination, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) sleepSync(50 * (attempt + 1));
    }
  }
  throw lastError;
}

class TournamentManager {
  constructor(directory, options) {
    this.directory = directory;
    this.resolveBot = options.resolveBot;
    this.runMatch = options.runMatch;
    this.onMatchComplete = options.onMatchComplete || (() => {});
    this.maxBots = options.maxBots ?? 20;
    this.autoStart = options.autoStart ?? true;
    this.maxConcurrentMatches = Math.max(1, Math.min(64, Number(options.maxConcurrentMatches) || 1));
    this.running = new Set();
    this.paused = new Set();
    this.cancelled = new Set();
    this.resumeResolvers = new Map();
    this.persistedMatches = new Map();
    fs.mkdirSync(directory, { recursive: true });
  }

  file(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    return path.join(this.directory, `${id}.json`);
  }

  read(id) {
    const file = this.file(id);
    if (!file || !fs.existsSync(file)) return null;
    const tournament = JSON.parse(fs.readFileSync(file, 'utf8'));
    const botsFile = path.join(this.directory, `${id}.bots.json`);
    const matchesFile = path.join(this.directory, `${id}.matches.jsonl`);
    if (fs.existsSync(botsFile)) tournament.bots = JSON.parse(fs.readFileSync(botsFile, 'utf8'));
    if (fs.existsSync(matchesFile)) {
      const matches = new Map();
      for (const line of fs.readFileSync(matchesFile, 'utf8').split('\n')) {
        if (!line) continue;
        const match = JSON.parse(line);
        matches.set(match.id, match);
      }
      tournament.matches = [...matches.values()];
      this.persistedMatches.set(id, new Map([...matches].map(([key, match]) => [key, JSON.stringify(match)])));
    }
    if (tournament.completedMatches == null) {
      tournament.completedMatches = (tournament.matches || []).filter(match => match.status === 'completed' && !match.result?.bye).length;
    }
    return tournament;
  }

  write(tournament) {
    const file = this.file(tournament.id);
    if (!file) throw new Error('Invalid tournament id.');
    const botsFile = path.join(this.directory, `${tournament.id}.bots.json`);
    if (!fs.existsSync(botsFile)) {
      const tempBots = `${botsFile}.tmp`;
      fs.writeFileSync(tempBots, `${JSON.stringify(tournament.bots || [])}\n`, 'utf8');
      renameWithRetry(tempBots, botsFile);
    }

    const known = this.persistedMatches.get(tournament.id) || new Map();
    const changed = [];
    const changedMatches = [];
    for (const match of tournament.matches || []) {
      const serialized = JSON.stringify(match);
      if (known.get(match.id) !== serialized) {
        changed.push(serialized);
        changedMatches.push([match.id, serialized]);
      }
    }
    if (changed.length) {
      fs.appendFileSync(path.join(this.directory, `${tournament.id}.matches.jsonl`), `${changed.join('\n')}\n`, 'utf8');
      for (const [matchId, serialized] of changedMatches) known.set(matchId, serialized);
    }
    this.persistedMatches.set(tournament.id, known);

    const { bots = [], matches = [], ...metadata } = tournament;
    metadata.botCount = bots.length;
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(metadata)}\n`, 'utf8');
    renameWithRetry(temp, file);
  }

  list() {
    return fs.readdirSync(this.directory)
      .filter(file => /^[a-f0-9-]{36}\.json$/i.test(file))
      .map(file => this.read(file.slice(0, -5)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listSummaries() {
    return fs.readdirSync(this.directory)
      .filter(file => /^[a-f0-9-]{36}\.json$/i.test(file))
      .map(file => {
        const metadata = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'));
        return { ...metadata, botCount: metadata.botCount ?? metadata.bots?.length ?? 0 };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  freezeBot(tournamentId, bot) {
    const current = bot.script ? null : this.resolveBot(bot.id);
    const sourcePath = bot.script ? path.resolve(this.directory, bot.script) : current?.script;
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error(`Không tìm thấy tệp bot ${bot.name || bot.id}.`);
    const source = fs.readFileSync(sourcePath);
    const sha256 = crypto.createHash('sha256').update(source).digest('hex');
    const snapshotPath = path.join(this.directory, 'snapshots', tournamentId, `${sha256}.py`);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    if (!fs.existsSync(snapshotPath)) fs.writeFileSync(snapshotPath, source, { flag: 'wx' });
    return {
      ...bot,
      untrusted: current?.untrusted ?? bot.untrusted ??
        /^(submission:|uploaded:)/.test(bot.id || ''),
      sha256,
      script: path.relative(this.directory, snapshotPath)
    };
  }

  create({ name, botIds, mode, maxTurns, format = 'swiss' }) {
    if (!Array.isArray(botIds) || botIds.length < 2 || botIds.length > this.maxBots) {
      throw new Error(`Hãy chọn từ 2 đến ${this.maxBots} bot.`);
    }
    if (!['swiss', 'swiss-playoff', 'single-elimination', 'round-robin-two-legs'].includes(format)) {
      throw new Error('Thể thức giải đấu không hợp lệ.');
    }
    if (new Set(botIds).size !== botIds.length) throw new Error('Mỗi bot chỉ được chọn một lần.');
    const tournamentId = crypto.randomUUID();
    const bots = botIds.map(id => {
      const bot = this.resolveBot(id);
      if (!bot) throw new Error(`Không tìm thấy bot: ${id}`);
      return this.freezeBot(tournamentId, { id: bot.id, name: bot.name, sha256: bot.sha256 });
    });

    const id = tournamentId;
    const tournament = {
      id,
      name: String(name || '').trim().slice(0, 60) || (['swiss', 'swiss-playoff'].includes(format) ? 'Swiss Bot Tournament' : 'Bot Round Robin'),
      format,
      mode,
      maxTurns,
      bots,
      matches: [],
      completedMatches: 0,
      totalRounds: ['swiss', 'swiss-playoff'].includes(format) ? Math.max(1, Math.ceil(Math.log2(bots.length))) : null,
      currentRound: ['swiss', 'swiss-playoff'].includes(format) ? 1 : null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    tournament.matches = ['swiss', 'swiss-playoff'].includes(format)
      ? this.createSwissRound(tournament, 1)
      : format === 'single-elimination'
        ? this.createKnockoutMatches(id, bots)
        : this.createRoundRobinMatches(id, bots);
    this.write(tournament);
    if (this.autoStart) this.start(id);
    return tournament;
  }

  createRoundRobinMatches(id, bots) {
    const matches = [];
    for (let a = 0; a < bots.length; a++) {
      for (let b = a + 1; b < bots.length; b++) {
        for (const [p1, p2] of [[bots[a], bots[b]], [bots[b], bots[a]]]) {
          matches.push(this.matchRecord(id, matches.length, p1, p2, 0));
        }
      }
    }
    return matches;
  }

  matchRecord(id, index, p1, p2, round, status = 'queued', stage = 'swiss') {
    return {
      id: `${id}-${String(index + 1).padStart(3, '0')}`,
      round,
      stage,
      p1BotId: p1?.id || null,
      p2BotId: p2?.id || null,
      p1BotName: p1?.name || 'Bye',
      p2BotName: p2?.name || 'Bye',
      status,
      result: null
    };
  }

  createSwissRound(tournament, round) {
    const standings = this.standings(tournament).sort((a, b) =>
      b.points - a.points || b.buchholz - a.buchholz || b.headToHeadPoints - a.headToHeadPoints ||
      b.wins - a.wins || a.botId.localeCompare(b.botId)
    );
    const byId = new Map(tournament.bots.map(bot => [bot.id, bot]));
    const botById = new Map(standings.map(row => [row.botId, row]));
    const previousOpponents = new Set();
    const sideCounts = new Map(tournament.bots.map(bot => [bot.id, { p1: 0, p2: 0 }]));

    for (const match of tournament.matches) {
      if (match.stage && match.stage !== 'swiss') continue;
      if (match.p1BotId && match.p2BotId) {
        previousOpponents.add(this.pairKey(match.p1BotId, match.p2BotId));
      }
      if (match.p1BotId && sideCounts.has(match.p1BotId)) sideCounts.get(match.p1BotId).p1++;
      if (match.p2BotId && sideCounts.has(match.p2BotId)) sideCounts.get(match.p2BotId).p2++;
    }

    const remaining = standings.map(row => byId.get(row.botId)).filter(Boolean);
    const roundMatches = [];
    if (remaining.length % 2 === 1) {
      const byeBot = [...remaining].reverse().find(bot => (botById.get(bot.id)?.byes || 0) === 0) || remaining[remaining.length - 1];
      remaining.splice(remaining.findIndex(bot => bot.id === byeBot.id), 1);
      roundMatches.push(this.matchRecord(tournament.id, tournament.matches.length, byeBot, null, round));
    }

    const count = remaining.length;
    if (!count) return roundMatches;
    const paired = new Uint8Array(count);
    const pairingWindow = 64;

    const sideAssignment = (a, b) => {
      const aSides = sideCounts.get(a.id);
      const bSides = sideCounts.get(b.id);
      const aFirst = Math.abs(aSides.p1 + 1 - aSides.p2) + Math.abs(bSides.p1 - (bSides.p2 + 1));
      const bFirst = Math.abs(aSides.p1 - (aSides.p2 + 1)) + Math.abs(bSides.p1 + 1 - bSides.p2);
      return aFirst <= bFirst ? [a, b, aFirst] : [b, a, bFirst];
    };

    const pairCost = (i, j) => {
      const a = remaining[i];
      const b = remaining[j];
      const repeated = previousOpponents.has(this.pairKey(a.id, b.id));
      const scoreGap = Math.abs((botById.get(a.id)?.points || 0) - (botById.get(b.id)?.points || 0));
      const [, , sideGap] = sideAssignment(a, b);
      return (repeated ? 1_000_000_000 : 0) + scoreGap * 10_000 + sideGap * 100 + Math.abs(i - j);
    };

    for (let first = 0; first < count; first++) {
      if (paired[first]) continue;
      paired[first] = 1;

      let bestPartner = -1;
      let bestCost = Number.POSITIVE_INFINITY;
      let foundNonRepeat = false;
      const windowEnd = Math.min(count, first + pairingWindow + 1);
      for (let partner = first + 1; partner < windowEnd; partner++) {
        if (paired[partner]) continue;
        const repeated = previousOpponents.has(this.pairKey(remaining[first].id, remaining[partner].id));
        if (!repeated) foundNonRepeat = true;
        const cost = pairCost(first, partner);
        if (cost < bestCost) {
          bestCost = cost;
          bestPartner = partner;
        }
      }

      // Previous rounds can occupy the local window in small fields. Search the
      // rest only when needed so large events stay close to linear time.
      if (!foundNonRepeat) {
        for (let partner = windowEnd; partner < count; partner++) {
          if (paired[partner]) continue;
          const repeated = previousOpponents.has(this.pairKey(remaining[first].id, remaining[partner].id));
          if (!repeated) foundNonRepeat = true;
          const cost = pairCost(first, partner);
          if (cost < bestCost) {
            bestCost = cost;
            bestPartner = partner;
          }
        }
      }

      if (bestPartner < 0 || (!foundNonRepeat && !Number.isFinite(bestCost))) {
        throw new Error('Không thể ghép cặp vòng Swiss.');
      }
      paired[bestPartner] = 1;
      const [p1, p2] = sideAssignment(remaining[first], remaining[bestPartner]);
      roundMatches.push(this.matchRecord(tournament.id, tournament.matches.length + roundMatches.length, p1, p2, round));
    }
    return roundMatches;
  }

  pairKey(a, b) {
    return [a, b].sort().join('::');
  }

  createKnockoutMatches(id, bots) {
    const bracketSize = 2 ** Math.ceil(Math.log2(bots.length));
    const seeded = [...bots];
    while (seeded.length < bracketSize) seeded.push(null);
    const matches = [];
    for (let index = 0; index < bracketSize / 2; index++) {
      matches.push(this.matchRecord(id, matches.length, seeded[index], seeded[bracketSize - 1 - index], 1));
    }
    return matches;
  }

  standings(tournament) {
    const rows = tournament.bots.map(bot => ({
      botId: bot.id, name: bot.name, played: 0, wins: 0, draws: 0, losses: 0,
      byes: 0, points: 0, buchholz: 0, opponents: [], headToHead: []
    }));
    const byId = new Map(rows.map(row => [row.botId, row]));
    for (const match of tournament.matches) {
      if ((match.stage && match.stage !== 'swiss') || match.status !== 'completed' || !match.result) continue;
      const p1 = byId.get(match.p1BotId);
      const p2 = byId.get(match.p2BotId);
      if (!p1) continue;
      if (match.result.bye || !p2) {
        p1.byes++;
        p1.points++;
        continue;
      }
      p1.played++;
      p2.played++;
      p1.opponents.push(p2.botId);
      p2.opponents.push(p1.botId);
      if (!match.result.winnerBotId) {
        p1.draws++; p2.draws++;
        p1.points += 0.5; p2.points += 0.5;
        p1.headToHead.push({ opponentBotId: p2.botId, points: 0.5 });
        p2.headToHead.push({ opponentBotId: p1.botId, points: 0.5 });
      } else {
        const winner = byId.get(match.result.winnerBotId);
        const loser = winner === p1 ? p2 : p1;
        winner.wins++; winner.points++;
        loser.losses++;
        p1.headToHead.push({ opponentBotId: p2.botId, points: winner === p1 ? 1 : 0 });
        p2.headToHead.push({ opponentBotId: p1.botId, points: winner === p2 ? 1 : 0 });
      }
    }
    for (const row of rows) {
      row.buchholz = row.opponents.reduce((total, opponentId) => total + (byId.get(opponentId)?.points || 0), 0);
    }
    const tiedGroups = new Map();
    for (const row of rows) {
      const key = `${row.points}:${row.buchholz}`;
      if (!tiedGroups.has(key)) tiedGroups.set(key, new Set());
      tiedGroups.get(key).add(row.botId);
    }
    for (const row of rows) {
      const tiedIds = tiedGroups.get(`${row.points}:${row.buchholz}`);
      row.headToHeadPoints = row.headToHead.reduce(
        (total, result) => total + (tiedIds.has(result.opponentBotId) ? result.points : 0), 0
      );
      delete row.opponents;
      delete row.headToHead;
    }
    return rows.sort((a, b) => b.points - a.points || b.buchholz - a.buchholz ||
      b.headToHeadPoints - a.headToHeadPoints || b.wins - a.wins || a.name.localeCompare(b.name));
  }

  start(id) {
    if (this.running.has(id)) return;
    this.running.add(id);
    this.play(id).catch(error => {
      const tournament = this.read(id);
      if (tournament) {
        tournament.status = 'failed';
        tournament.error = error.message;
        tournament.updatedAt = new Date().toISOString();
        this.write(tournament);
      }
    }).finally(() => this.running.delete(id));
  }

  pause(id) {
    const tournament = this.read(id);
    if (!tournament) throw new Error('Không tìm thấy giải đấu.');
    if (tournament.status !== 'running') throw new Error('Chỉ có thể tạm dừng giải đang chạy.');
    this.paused.add(id);
    tournament.status = 'paused';
    tournament.updatedAt = new Date().toISOString();
    this.write(tournament);
  }

  resumeRun(id) {
    const tournament = this.read(id);
    if (!tournament) throw new Error('Không tìm thấy giải đấu.');
    if (tournament.status !== 'paused') throw new Error('Giải không đang tạm dừng.');
    this.paused.delete(id);
    const resolve = this.resumeResolvers.get(id);
    if (resolve) {
      this.resumeResolvers.delete(id);
      resolve();
    } else {
      // Not suspended in-memory (e.g. after restart); just mark running and start.
      tournament.status = 'queued';
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
      this.start(id);
    }
  }

  cancel(id) {
    const tournament = this.read(id);
    if (!tournament) throw new Error('Không tìm thấy giải đấu.');
    if (tournament.status === 'completed' || tournament.status === 'cancelled') return;
    this.cancelled.add(id);
    if (this.paused.has(id)) {
      this.paused.delete(id);
      const resolve = this.resumeResolvers.get(id);
      if (resolve) {
        this.resumeResolvers.delete(id);
        resolve();
      }
    }
    tournament.status = 'cancelled';
    tournament.updatedAt = new Date().toISOString();
    this.write(tournament);
  }

  async checkPauseOrCancel(tournament) {
    const id = tournament.id;
    if (this.cancelled.has(id)) {
      tournament.status = 'cancelled';
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
      return 'cancelled';
    }
    if (this.paused.has(id)) {
      tournament.status = 'paused';
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
      await new Promise(resolve => {
        this.resumeResolvers.set(id, resolve);
      });
      if (this.cancelled.has(id)) {
        tournament.status = 'cancelled';
        tournament.updatedAt = new Date().toISOString();
        this.write(tournament);
        return 'cancelled';
      }
      this.paused.delete(id);
      this.resumeResolvers.delete(id);
      tournament.status = 'running';
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
    }
    return 'ok';
  }

  async play(id) {
    const tournament = this.read(id);
    if (!tournament || tournament.status === 'completed') return;
    tournament.status = 'running';
    delete tournament.error;
    tournament.updatedAt = new Date().toISOString();
    this.write(tournament);

    const byId = new Map(tournament.bots.map(bot => [bot.id, bot]));
    this.cancelled.delete(id);
    if (this.cancelled.has(id)) return;
    if (['swiss', 'swiss-playoff'].includes(tournament.format)) {
      await this.playSwiss(tournament, byId);
      if (this.cancelled.has(id)) return;
      if (tournament.format === 'swiss-playoff') await this.playPlayoff(tournament, byId, 32);
    } else if (tournament.format === 'single-elimination') {
      await this.playKnockout(tournament, byId);
    } else {
      await this.playRoundRobin(tournament, byId);
    }
    if (this.cancelled.has(id)) {
      tournament.status = 'cancelled';
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
      return;
    }
    tournament.status = 'completed';
    tournament.completedAt = new Date().toISOString();
    tournament.updatedAt = tournament.completedAt;
    this.write(tournament);
  }

  async playRoundRobin(tournament, byId) {
    await this.playMatchBatch(tournament.matches, tournament, byId);
  }

  async playMatchBatch(matches, tournament, byId) {
    const pending = matches.filter(match => match.status !== 'completed');
    for (let offset = 0; offset < pending.length; offset += this.maxConcurrentMatches) {
      if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
      await Promise.all(pending.slice(offset, offset + this.maxConcurrentMatches)
        .map(match => this.playMatch(tournament, match, byId)));
    }
  }

  async playSwiss(tournament, byId) {
    for (let round = 1; round <= tournament.totalRounds; round++) {
      if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
      let roundMatches = tournament.matches.filter(match => match.round === round);
      if (!roundMatches.length) {
        roundMatches = this.createSwissRound(tournament, round);
        tournament.matches.push(...roundMatches);
        tournament.currentRound = round;
        tournament.updatedAt = new Date().toISOString();
        this.write(tournament);
      }
      await this.playMatchBatch(roundMatches, tournament, byId);
      if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
      if (round < tournament.totalRounds) {
        tournament.currentRound = round + 1;
        if (!tournament.matches.some(match => match.round === round + 1)) {
          tournament.matches.push(...this.createSwissRound(tournament, round + 1));
        }
        tournament.updatedAt = new Date().toISOString();
        this.write(tournament);
      }
    }
    if (tournament.format === 'swiss') tournament.champion = this.standings(tournament)[0]?.name || null;
  }

  async playPlayoff(tournament, byId, qualifierCount = 32) {
    const existing = tournament.matches.some(match => match.stage === 'winners' || match.stage === 'losers' || match.stage === 'grand-final');
    if (existing) {
      return;
    }
    if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;

    const qualified = this.standings(tournament).slice(0, qualifierCount).map(row => byId.get(row.botId));
    const bracketSize = 2 ** Math.ceil(Math.log2(Math.max(2, qualified.length)));
    const seeded = [...qualified];
    while (seeded.length < bracketSize) seeded.push(null);

    const runRound = async (bots, roundNumber, stage) => {
      const roundMatches = [];
      for (let index = 0; index < bots.length; index += 2) {
        roundMatches.push(this.matchRecord(tournament.id, tournament.matches.length + roundMatches.length,
          bots[index], bots[index + 1], roundNumber, 'queued', stage));
      }
      tournament.matches.push(...roundMatches);
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
      await this.playMatchBatch(roundMatches, tournament, byId);
      const winners = [];
      const losers = [];
      for (const match of roundMatches) {
        if (!match.p1BotId && !match.p2BotId) continue;
        if (!match.p2BotId || match.result?.bye) {
          const winnerId = match.p1BotId || match.p2BotId;
          winners.push(byId.get(winnerId));
          continue;
        }
        const winnerId = match.result?.winnerBotId;
        const winner = winnerId ? byId.get(winnerId) : null;
        const loserId = winnerId === match.p1BotId ? match.p2BotId : match.p1BotId;
        const loser = loserId ? byId.get(loserId) : null;
        if (winner) winners.push(winner);
        if (loser) losers.push(loser);
      }
      return { winners, losers, matches: roundMatches };
    };

    const interleave = (a, b) => {
      const result = [];
      const length = Math.max(a.length, b.length);
      for (let index = 0; index < length; index++) {
        if (a[index]) result.push(a[index]);
        if (b[index]) result.push(b[index]);
      }
      return result;
    };

    const wbRounds = Math.log2(bracketSize);
    let round = tournament.totalRounds + 1;

    const wb1 = await runRound(seeded, round++, 'winners');
    if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
    const lb1 = await runRound(wb1.losers, round++, 'losers');
    if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;

    let wbWinners = wb1.winners;
    let lbWinners = lb1.winners;

    for (let i = 2; i <= wbRounds; i++) {
      const wbRound = await runRound(wbWinners, round++, 'winners');
      if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
      const wbLosers = wbRound.losers;
      wbWinners = wbRound.winners;

      const merge = await runRound(interleave(lbWinners, wbLosers), round++, 'losers');
      if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
      lbWinners = merge.winners;

      if (i < wbRounds) {
        const internal = await runRound(lbWinners, round++, 'losers');
        if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
        lbWinners = internal.winners;
      }
    }

    const gfParticipants = [wbWinners[0], lbWinners[0]].filter(Boolean);
    if (gfParticipants.length >= 2) {
      const gf = await runRound(gfParticipants, round++, 'grand-final');
      if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
      tournament.champion = gf.winners[0] ? gf.winners[0].name : (wbWinners[0] ? wbWinners[0].name : null);
    } else {
      tournament.champion = wbWinners[0] ? wbWinners[0].name : (lbWinners[0] ? lbWinners[0].name : null);
    }
    tournament.updatedAt = new Date().toISOString();
    this.write(tournament);
  }

  async playTopEightPlayoff(tournament, byId) {
    return this.playPlayoff(tournament, byId, 8);
  }

  async playKnockout(tournament, byId) {
    let round = 1;
    while (true) {
      if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
      const current = tournament.matches.filter(match => match.round === round);
      if (!current.length) break;
      await this.playMatchBatch(current, tournament, byId);
      if (await this.checkPauseOrCancel(tournament) === 'cancelled') return;
      const winners = current.map(match => match.result?.winnerBotId).filter(Boolean);
      if (winners.length <= 1) {
        tournament.champion = winners[0] ? byId.get(winners[0]).name : null;
        break;
      }
      const nextRound = round + 1;
      const nextMatches = [];
      for (let index = 0; index < winners.length; index += 2) {
        const p1 = byId.get(winners[index]);
        const p2 = byId.get(winners[index + 1]);
        nextMatches.push(this.matchRecord(tournament.id, tournament.matches.length + nextMatches.length, p1, p2, nextRound));
      }
      tournament.matches.push(...nextMatches);
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
      round = nextRound;
    }
  }

  async playMatch(tournament, match, byId) {
    if (!match.p1BotId || !match.p2BotId) {
      const winnerBotId = match.p1BotId || match.p2BotId;
      match.status = 'completed';
      match.result = { winnerBotId, winnerBotName: byId.get(winnerBotId)?.name || null, bye: true, draw: false };
      this.write(tournament);
      return;
    }
    match.status = 'running';
    tournament.updatedAt = new Date().toISOString();
    this.write(tournament);
    const frozenP1 = byId.get(match.p1BotId);
    const frozenP2 = byId.get(match.p2BotId);
    const botP1 = frozenP1 && { ...frozenP1, script: path.resolve(this.directory, frozenP1.script) };
    const botP2 = frozenP2 && { ...frozenP2, script: path.resolve(this.directory, frozenP2.script) };
    if (!botP1 || !botP2) throw new Error('Không tìm thấy bản bot đã lưu cho giải này.');
    let result;
    const requiresWinner = tournament.format === 'single-elimination' ||
      ['winners', 'losers', 'grand-final', 'playoff'].includes(match.stage);
    const attempts = requiresWinner ? 10 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      result = await this.runMatch({
        mode: tournament.mode,
        maxTurns: tournament.maxTurns,
        botP1,
        botP2,
        matchId: `${match.id}-tie${attempt}`,
        replayPath: path.join(this.directory, 'replays', `${match.id}-tie${attempt}.json.gz`)
      });
      if (result.winner) break;
    }
    if (!result.winner && !requiresWinner) {
      // A Swiss or round-robin draw is a scored result; no tiebreak replay is needed.
    } else if (!result.winner) {
      throw new Error(`Trận ${match.id} hòa sau ${attempts} lượt phân định.`);
    }
    match.status = 'completed';
    const winnerBotId = result.winner === 'p1' ? match.p1BotId : result.winner === 'p2' ? match.p2BotId : null;
    match.result = {
      winnerBotId,
      winnerBotName: winnerBotId ? byId.get(winnerBotId).name : null,
      turns: result.turns,
      draw: !winnerBotId,
      reason: result.reason,
      replayFile: result.replayFile ? path.basename(result.replayFile) : null
    };
    if (!match.result.bye) tournament.completedMatches = (tournament.completedMatches || 0) + 1;
    tournament.updatedAt = new Date().toISOString();
    this.write(tournament);
    this.onMatchComplete({
      matchId: match.id,
      bot1: botP1.name || botP1.id,
      bot2: botP2.name || botP2.id,
      winner: result.winner === 'p1' ? 'bot1' : result.winner === 'p2' ? 'bot2' : 'draw',
      playedAt: new Date().toISOString()
    });
  }

  resume() {
    for (const summary of this.listSummaries()) {
      if (summary.status !== 'queued' && summary.status !== 'running' && summary.status !== 'failed') continue;
      const tournament = this.read(summary.id);
      if (!tournament) continue;
      const completedMatches = tournament.matches.filter(match => match.status === 'completed').length;
      const recoverableOldFailure = tournament.status === 'failed' &&
        tournament.error === 'Both bots need script paths.' && completedMatches === 0;
      if (recoverableOldFailure) {
        try {
          tournament.bots = tournament.bots.map(bot => this.freezeBot(tournament.id, bot));
          tournament.status = 'queued';
          delete tournament.error;
          this.write(tournament);
        } catch (error) {
          tournament.error = error.message;
          tournament.updatedAt = new Date().toISOString();
          this.write(tournament);
        }
      }
      if (tournament.status === 'queued' || tournament.status === 'running') this.start(tournament.id);
    }
  }
}

module.exports = TournamentManager;
