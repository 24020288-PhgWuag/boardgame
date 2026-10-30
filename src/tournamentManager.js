const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ROUND_ROBIN_BOTS = 12;
const MAX_KNOCKOUT_BOTS = 10000;

class TournamentManager {
  constructor(directory, options) {
    this.directory = directory;
    this.resolveBot = options.resolveBot;
    this.runMatch = options.runMatch;
    this.onMatchComplete = options.onMatchComplete || (() => {});
    this.running = new Set();
    fs.mkdirSync(directory, { recursive: true });
  }

  file(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    return path.join(this.directory, `${id}.json`);
  }

  read(id) {
    const file = this.file(id);
    return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  write(tournament) {
    const file = this.file(tournament.id);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(tournament, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  }

  list() {
    return fs.readdirSync(this.directory)
      .filter(file => /^[a-f0-9-]{36}\.json$/i.test(file))
      .map(file => JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8')))
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

  create({ name, botIds, mode, maxTurns, format = 'round-robin-two-legs' }) {
    const maxBots = format === 'single-elimination' ? MAX_KNOCKOUT_BOTS : MAX_ROUND_ROBIN_BOTS;
    if (!Array.isArray(botIds) || botIds.length < 2 || botIds.length > maxBots) {
      throw new Error(`Hãy chọn từ 2 đến ${maxBots} bot.`);
    }
    if (new Set(botIds).size !== botIds.length) throw new Error('Mỗi bot chỉ được chọn một lần.');
    const tournamentId = crypto.randomUUID();
    const bots = botIds.map(id => {
      const bot = this.resolveBot(id);
      if (!bot) throw new Error(`Không tìm thấy bot: ${id}`);
      return this.freezeBot(tournamentId, { id: bot.id, name: bot.name, sha256: bot.sha256 });
    });

    const id = tournamentId;
    const matches = format === 'single-elimination'
      ? this.createKnockoutMatches(id, bots)
      : this.createRoundRobinMatches(id, bots);

    const tournament = {
      id,
      name: String(name || '').trim().slice(0, 60) || 'Bot Round Robin',
      format,
      mode,
      maxTurns,
      bots,
      matches,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.write(tournament);
    this.start(id);
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

  matchRecord(id, index, p1, p2, round, status = 'queued') {
    return {
      id: `${id}-${String(index + 1).padStart(3, '0')}`,
      round,
      p1BotId: p1?.id || null,
      p2BotId: p2?.id || null,
      p1BotName: p1?.name || 'Bye',
      p2BotName: p2?.name || 'Bye',
      status,
      result: null
    };
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
      botId: bot.id, name: bot.name, played: 0, wins: 0, draws: 0, losses: 0, points: 0
    }));
    const byId = new Map(rows.map(row => [row.botId, row]));
    for (const match of tournament.matches) {
      if (match.status !== 'completed' || !match.result) continue;
      const p1 = byId.get(match.p1BotId);
      const p2 = byId.get(match.p2BotId);
      if (!p1 || !p2) continue;
      p1.played++;
      p2.played++;
      if (!match.result.winnerBotId) {
        p1.draws++; p2.draws++;
        p1.points += 0.5; p2.points += 0.5;
      } else {
        const winner = byId.get(match.result.winnerBotId);
        const loser = winner === p1 ? p2 : p1;
        winner.wins++; winner.points++;
        loser.losses++;
      }
    }
    return rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name));
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

  async play(id) {
    const tournament = this.read(id);
    if (!tournament || tournament.status === 'completed') return;
    tournament.status = 'running';
    delete tournament.error;
    tournament.updatedAt = new Date().toISOString();
    this.write(tournament);

    const byId = new Map(tournament.bots.map(bot => [bot.id, bot]));
    if (tournament.format === 'single-elimination') {
      await this.playKnockout(tournament, byId);
    } else {
      await this.playRoundRobin(tournament, byId);
    }
    tournament.status = 'completed';
    tournament.completedAt = new Date().toISOString();
    tournament.updatedAt = tournament.completedAt;
    this.write(tournament);
  }

  async playRoundRobin(tournament, byId) {
    for (const match of tournament.matches) {
      if (match.status === 'completed') continue;
      await this.playMatch(tournament, match, byId);
    }
  }

  async playKnockout(tournament, byId) {
    let round = 1;
    while (true) {
      const current = tournament.matches.filter(match => match.round === round);
      if (!current.length) break;
      for (const match of current) {
        if (match.status !== 'completed') await this.playMatch(tournament, match, byId);
      }
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
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await this.runMatch({
        mode: tournament.mode,
        maxTurns: tournament.maxTurns,
        botP1,
        botP2,
        matchId: `${match.id}-tie${attempt}`,
        replayPath: path.join(this.directory, 'replays', `${match.id}-tie${attempt}.json`)
      });
      if (result.winner) break;
    }
    if (!result.winner) throw new Error(`Trận ${match.id} hòa sau 3 lượt phân định.`);
    match.status = 'completed';
    match.result = {
      winnerBotId: result.winner === 'p1' ? match.p1BotId : match.p2BotId,
      winnerBotName: byId.get(result.winner === 'p1' ? match.p1BotId : match.p2BotId).name,
      turns: result.turns,
      draw: false,
      reason: result.reason,
      replayFile: result.replayFile ? path.basename(result.replayFile) : null
    };
    tournament.updatedAt = new Date().toISOString();
    this.write(tournament);
    this.onMatchComplete({
      matchId: match.id,
      bot1: botP1.name || botP1.id,
      bot2: botP2.name || botP2.id,
      winner: result.winner === 'p1' ? 'bot1' : 'bot2',
      playedAt: new Date().toISOString()
    });
  }

  resume() {
    for (const tournament of this.list()) {
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
