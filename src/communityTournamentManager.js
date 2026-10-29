const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

class CommunityTournamentManager {
  constructor(filePath, { startTournament }) {
    this.filePath = filePath;
    this.startTournament = startTournament;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.events = this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch (error) {
      console.error('Không thể đọc giải cộng đồng:', error.message);
      return [];
    }
  }

  save() {
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.events, null, 2)}\n`, 'utf8');
    let lastError;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        fs.renameSync(temporary, this.filePath);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 7) sleepSync(50 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
  }

  create({ name, mode, maxTurns }) {
    const event = {
      id: crypto.randomUUID(),
      name: String(name || '').trim().slice(0, 60) || 'Giải vô địch cộng đồng',
      format: 'swiss',
      mode,
      maxTurns,
      maxPlayers: 20,
      status: 'registration',
      players: [],
      tournamentId: null,
      currentRound: 0,
      totalRounds: null,
      completedMatches: 0,
      matchCount: 0,
      champion: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.events.unshift(event);
    this.save();
    return event;
  }

  get(id) {
    return this.events.find(event => event.id === id) || null;
  }

  list() {
    return this.events.map(event => ({
      ...event,
      players: event.players.map(({ source, ...player }) => player)
    }));
  }

  register(id, player) {
    const event = this.get(id);
    if (!event) return { error: 'Không tìm thấy giải cộng đồng.' };
    if (event.status !== 'registration') return { error: 'Giải này đã đóng đăng ký.' };
    if (event.players.some(item => item.userId === player.userId)) return { error: 'Mỗi tài khoản chỉ được đăng ký một bot.' };
    if (event.players.some(item => item.botId === player.botId)) return { error: 'Bot này đã được đăng ký trong giải.' };
    if (event.players.length >= event.maxPlayers) return { error: `Giải đã đủ ${event.maxPlayers} người chơi.` };
    event.players.push({ ...player, registeredAt: new Date().toISOString() });
    event.updatedAt = new Date().toISOString();
    this.save();
    return { event };
  }

  start(id) {
    const event = this.get(id);
    if (!event) return { error: 'Không tìm thấy giải cộng đồng.' };
    if (event.status !== 'registration') return { error: 'Giải đã được bắt đầu hoặc đã kết thúc.' };
    if (event.players.length < 2) return { error: 'Cần ít nhất 2 bot để bắt đầu giải.' };
    event.status = 'starting';
    event.updatedAt = new Date().toISOString();
    this.save();
    const tournament = this.startTournament(event);
    event.tournamentId = tournament.id;
    event.format = tournament.format;
    event.currentRound = tournament.currentRound || 1;
    event.totalRounds = tournament.totalRounds || null;
    event.matchCount = tournament.totalRounds
      ? tournament.totalRounds * Math.floor(tournament.bots.length / 2)
      : tournament.matches.length;
    event.status = 'running';
    event.updatedAt = new Date().toISOString();
    this.save();
    return { event, tournament };
  }

  sync() {
    for (const event of this.events) {
      if (!event.tournamentId) continue;
      const tournament = this.startTournament.read(event.tournamentId);
      if (!tournament) continue;
      event.format = tournament.format || event.format;
      event.currentRound = tournament.currentRound || event.currentRound;
      event.totalRounds = tournament.totalRounds || event.totalRounds;
      event.completedMatches = tournament.matches.filter(match => match.status === 'completed' &&
        (tournament.format !== 'swiss' || !match.result?.bye)).length;
      event.matchCount = tournament.totalRounds
        ? tournament.totalRounds * Math.floor(tournament.bots.length / 2)
        : tournament.matches.length;
      if (tournament.status === 'completed') {
        event.status = 'completed';
        event.champion = tournament.champion || null;
        event.updatedAt = new Date().toISOString();
      } else if (tournament.status === 'failed') {
        event.status = 'failed';
        event.error = tournament.error || 'Giải đấu gặp lỗi.';
        event.updatedAt = new Date().toISOString();
      }
    }
    this.save();
  }
}

module.exports = CommunityTournamentManager;
