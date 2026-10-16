const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;
const PASSWORD_MIN_LENGTH = 8;

class AuthStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.sessions = new Map();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.users = this.loadUsers();
  }

  loadUsers() {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const users = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(users)) return [];
      let changed = false;
      const normalizedUsers = users.map(user => {
        const elo = Number(user.elo);
        const games = Number(user.games);
        const wins = Number(user.wins);
        const normalized = {
          ...user,
          elo: Number.isFinite(elo) && elo >= 0 ? elo : 100,
          games: Number.isFinite(games) && games >= 0 ? games : 0,
          wins: Number.isFinite(wins) && wins >= 0 ? wins : 0
        };
        if (normalized.elo !== user.elo || normalized.games !== user.games || normalized.wins !== user.wins) {
          changed = true;
        }
        return normalized;
      });
      if (changed) {
        this.users = normalizedUsers;
        this.saveUsers();
      }
      return normalizedUsers;
    } catch (error) {
      console.error('Không thể đọc dữ liệu tài khoản:', error.message);
      return [];
    }
  }

  saveUsers() {
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.users, null, 2)}\n`, { encoding: 'utf8' });
    fs.renameSync(temporaryPath, this.filePath);
  }

  validateCredentials(username, password) {
    if (!USERNAME_PATTERN.test(username)) {
      return 'Tên tài khoản dài 3-24 ký tự, chỉ gồm chữ, số, _ hoặc -.';
    }
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
      return 'Mật khẩu phải dài từ 8 đến 128 ký tự.';
    }
    return null;
  }

  hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  verifyPassword(password, storedHash) {
    const [salt, expected] = String(storedHash).split(':');
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    const actualBuffer = Buffer.from(actual, 'hex');
    return actualBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  createUser(username, password) {
    const normalizedUsername = username.trim();
    const validationError = this.validateCredentials(normalizedUsername, password);
    if (validationError) return { error: validationError };
    if (this.users.some(user => user.username.toLowerCase() === normalizedUsername.toLowerCase())) {
      return { error: 'Tên tài khoản đã được sử dụng.' };
    }
    const user = {
      id: crypto.randomUUID(),
      username: normalizedUsername,
      passwordHash: this.hashPassword(password),
      elo: 100,
      games: 0,
      wins: 0,
      createdAt: new Date().toISOString()
    };
    this.users.push(user);
    this.saveUsers();
    return { user: this.publicUser(user) };
  }

  authenticate(username, password) {
    const user = this.users.find(item => item.username.toLowerCase() === String(username).trim().toLowerCase());
    if (!user || !this.verifyPassword(password, user.passwordHash)) return null;
    return this.publicUser(user);
  }

  createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { ...user, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    return token;
  }

  getSession(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const user = this.users.find(item => item.id === session.id);
    if (!user) {
      this.sessions.delete(token);
      return null;
    }
    return this.publicUser(user);
  }

  destroySession(token) {
    if (token) this.sessions.delete(token);
  }

  publicUser(user) {
    const elo = Number(user.elo);
    const games = Number(user.games);
    const wins = Number(user.wins);
    return {
      id: user.id,
      username: user.username,
      elo: Number.isFinite(elo) && elo >= 0 ? elo : 100,
      games: Number.isFinite(games) && games >= 0 ? games : 0,
      wins: Number.isFinite(wins) && wins >= 0 ? wins : 0
    };
  }

  getLeaderboard(limit = 50) {
    return this.users
      .map(user => this.publicUser(user))
      .sort((a, b) => b.elo - a.elo || b.wins - a.wins || a.username.localeCompare(b.username))
      .slice(0, limit)
      .map((user, index) => ({ rank: index + 1, ...user }));
  }

  recordMatch(winnerId, loserId) {
    if (!winnerId || !loserId || winnerId === loserId) return null;
    const winner = this.users.find(user => user.id === winnerId);
    const loser = this.users.find(user => user.id === loserId);
    if (!winner || !loser) return null;

    const winnerElo = Number.isFinite(winner.elo) ? winner.elo : 100;
    const loserElo = Number.isFinite(loser.elo) ? loser.elo : 100;
    const expectedWinner = 1 / (1 + (10 ** ((loserElo - winnerElo) / 400)));
    const change = Math.max(1, Math.round(32 * (1 - expectedWinner)));

    winner.elo = winnerElo + change;
    loser.elo = Math.max(0, loserElo - change);
    winner.games = (Number.isFinite(winner.games) ? winner.games : 0) + 1;
    loser.games = (Number.isFinite(loser.games) ? loser.games : 0) + 1;
    winner.wins = (Number.isFinite(winner.wins) ? winner.wins : 0) + 1;
    this.saveUsers();
    return {
      winner: this.publicUser(winner),
      loser: this.publicUser(loser),
      change
    };
  }
}

module.exports = { AuthStore, USERNAME_PATTERN, PASSWORD_MIN_LENGTH };
