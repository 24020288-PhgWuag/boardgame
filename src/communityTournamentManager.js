const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 10000;
const DEFAULT_MAX_PLAYERS = 12;

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
    fs.renameSync(temporary, this.filePath);
  }

  create({ name, mode, maxTurns, maxPlayers = DEFAULT_MAX_PLAYERS }) {
    const event = {
      id: crypto.randomUUID(),
      name: String(name || '').trim().slice(0, 60) || 'Giải vô địch cộng đồng',
      mode,
      maxTurns,
      maxPlayers,
      status: 'registration',
      players: [],
      tournamentId: null,
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
    if (event.players.length >= event.maxPlayers) return { error: `Giải đã đủ ${event.maxPlayers} người chơi.` };
    event.players.push({ ...player, botId: null, botName: null, registeredAt: new Date().toISOString() });
    event.updatedAt = new Date().toISOString();
    this.save();
    return { event };
  }

  canSubmitBot(id, userId) {
    const event = this.get(id);
    if (!event) return { error: 'Không tìm thấy giải cộng đồng.' };
    if (event.status !== 'registration') return { error: 'Giải này đã đóng đăng ký.' };
    const player = event.players.find(item => item.userId === userId);
    if (!player) return { error: 'Hãy bấm Tham gia giải trước khi tải bot lên.' };
    if (player.botId) return { error: 'Bạn đã tải bot cho giải này rồi.' };
    return { event, player };
  }

  submitBot(id, userId, bot) {
    const registration = this.canSubmitBot(id, userId);
    if (registration.error) return registration;
    if (registration.event.players.some(item => item.botId === bot.botId)) {
      return { error: 'Bot này đã được đăng ký trong giải.' };
    }
    Object.assign(registration.player, {
      botId: bot.botId,
      botName: bot.botName,
      submittedAt: new Date().toISOString()
    });
    registration.event.updatedAt = new Date().toISOString();
    this.save();
    return { event: registration.event };
  }

  start(id) {
    const event = this.get(id);
    if (!event) return { error: 'Không tìm thấy giải cộng đồng.' };
    if (event.status !== 'registration') return { error: 'Giải đã được bắt đầu hoặc đã kết thúc.' };
    if (event.players.length < 2) return { error: 'Cần ít nhất 2 bot để bắt đầu giải.' };
    if (event.players.some(player => !player.botId)) {
      return { error: 'Tất cả người tham gia phải tải bot lên trước khi bắt đầu giải.' };
    }
    event.status = 'starting';
    event.updatedAt = new Date().toISOString();
    this.save();
    const tournament = this.startTournament(event);
    event.tournamentId = tournament.id;
    event.status = 'running';
    event.updatedAt = new Date().toISOString();
    this.save();
    return { event, tournament };
  }

  sync() {
    let changed = false;
    for (const event of this.events) {
      if (!event.tournamentId || event.status === 'completed') continue;
      const tournament = this.startTournament.read(event.tournamentId);
      if (!tournament) continue;
      if (tournament.status === 'completed') {
        event.status = 'completed';
        event.champion = tournament.champion || null;
        event.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

module.exports = CommunityTournamentManager;
module.exports.MIN_PLAYERS = MIN_PLAYERS;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
