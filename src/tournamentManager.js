const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class TournamentManager {
  constructor(directory, options) {
    this.directory = directory;
    this.resolveBot = options.resolveBot;
    this.runMatch = options.runMatch;
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
    return { ...bot, sha256, script: path.relative(this.directory, snapshotPath) };
  }

  create({ name, botIds, mode, maxTurns }) {
    if (!Array.isArray(botIds) || botIds.length < 2 || botIds.length > 12) {
      throw new Error('Hãy chọn từ 2 đến 12 bot.');
    }
    if (new Set(botIds).size !== botIds.length) throw new Error('Mỗi bot chỉ được chọn một lần.');
    const tournamentId = crypto.randomUUID();
    const bots = botIds.map(id => {
      const bot = this.resolveBot(id);
      if (!bot) throw new Error(`Không tìm thấy bot: ${id}`);
      return this.freezeBot(tournamentId, { id: bot.id, name: bot.name, sha256: bot.sha256 });
    });

    const id = tournamentId;
    const matches = [];
    for (let a = 0; a < bots.length; a++) {
      for (let b = a + 1; b < bots.length; b++) {
        for (const [p1, p2] of [[bots[a], bots[b]], [bots[b], bots[a]]]) {
          matches.push({
            id: `${id}-${String(matches.length + 1).padStart(3, '0')}`,
            p1BotId: p1.id,
            p2BotId: p2.id,
            p1BotName: p1.name,
            p2BotName: p2.name,
            status: 'queued',
            result: null
          });
        }
      }
    }

    const tournament = {
      id,
      name: String(name || '').trim().slice(0, 60) || 'Bot Round Robin',
      format: 'round-robin-two-legs',
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

  standings(tournament) {
    const rows = tournament.bots.map(bot => ({
      botId: bot.id, name: bot.name, played: 0, wins: 0, draws: 0, losses: 0, points: 0
    }));
    const byId = new Map(rows.map(row => [row.botId, row]));
    for (const match of tournament.matches) {
      if (match.status !== 'completed' || !match.result) continue;
      const p1 = byId.get(match.p1BotId);
      const p2 = byId.get(match.p2BotId);
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
    for (const match of tournament.matches) {
      if (match.status === 'completed') continue;
      match.status = 'running';
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
      const frozenP1 = byId.get(match.p1BotId);
      const frozenP2 = byId.get(match.p2BotId);
      const botP1 = frozenP1 && { ...frozenP1, script: path.resolve(this.directory, frozenP1.script) };
      const botP2 = frozenP2 && { ...frozenP2, script: path.resolve(this.directory, frozenP2.script) };
      if (!botP1 || !botP2) throw new Error('Không tìm thấy bản bot đã lưu cho giải này.');
      const replayPath = path.join(this.directory, 'replays', `${match.id}.json`);
      const result = await this.runMatch({
        mode: tournament.mode,
        maxTurns: tournament.maxTurns,
        botP1,
        botP2,
        matchId: match.id,
        replayPath
      });
      match.status = 'completed';
      match.result = {
        winnerBotId: result.winner === 'p1' ? match.p1BotId : result.winner === 'p2' ? match.p2BotId : null,
        winnerBotName: result.winner ? byId.get(result.winner === 'p1' ? match.p1BotId : match.p2BotId).name : null,
        turns: result.turns,
        draw: result.draw,
        reason: result.reason,
        replayFile: result.replayFile ? path.basename(result.replayFile) : null
      };
      tournament.updatedAt = new Date().toISOString();
      this.write(tournament);
    }
    tournament.status = 'completed';
    tournament.completedAt = new Date().toISOString();
    tournament.updatedAt = tournament.completedAt;
    this.write(tournament);
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
