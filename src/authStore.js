const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,24}$/;
const PASSWORD_MIN_LENGTH = 8;

class AuthStore {
  constructor(databasePath, legacyJsonPath = null) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        elo INTEGER NOT NULL DEFAULT 100,
        games INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        winner_id TEXT NOT NULL,
        loser_id TEXT NOT NULL,
        winner_elo_before INTEGER NOT NULL,
        winner_elo_after INTEGER NOT NULL,
        loser_elo_before INTEGER NOT NULL,
        loser_elo_after INTEGER NOT NULL,
        elo_change INTEGER NOT NULL,
        mode TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS matches_winner_idx ON matches (winner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS matches_loser_idx ON matches (loser_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
    `);
    this.migrateLegacyUsers(legacyJsonPath);
    this.deleteExpiredSessions();
  }

  migrateLegacyUsers(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    const count = this.database.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    if (count > 0) return;
    try {
      const users = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(users)) return;
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO users
        (id, username, password_hash, elo, games, wins, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const user of users) {
        insert.run(
          user.id || crypto.randomUUID(),
          user.username,
          user.passwordHash,
          this.numberOrDefault(user.elo, 100),
          this.numberOrDefault(user.games, 0),
          this.numberOrDefault(user.wins, 0),
          user.createdAt || new Date().toISOString()
        );
      }
    } catch (error) {
      console.error('Không thể migrate tài khoản cũ:', error.message);
    }
  }

  numberOrDefault(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  validateCredentials(username, password) {
    if (!USERNAME_PATTERN.test(username)) return 'Tên tài khoản dài 3-24 ký tự, chỉ gồm chữ, số, _ hoặc -.';
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
      return 'Mật khẩu phải dài từ 8 đến 128 ký tự.';
    }
    return null;
  }

  hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  }

  verifyPassword(password, storedHash) {
    const [salt, expected] = String(storedHash).split(':');
    if (!salt || !expected) return false;
    const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'), 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
  }

  rowToUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      elo: this.numberOrDefault(row.elo, 100),
      games: this.numberOrDefault(row.games, 0),
      wins: this.numberOrDefault(row.wins, 0),
      createdAt: row.created_at,
      isAdmin: Boolean(row.is_admin)
    };
  }

  publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      isAdmin: Boolean(user.isAdmin),
      elo: this.numberOrDefault(user.elo, 100),
      games: this.numberOrDefault(user.games, 0),
      wins: this.numberOrDefault(user.wins, 0),
      rank: this.getRank(user.elo)
    };
  }

  getRank(elo) {
    const value = this.numberOrDefault(elo, 100);
    if (value >= 1600) return 'Kim cương';
    if (value >= 1200) return 'Vàng';
    if (value >= 800) return 'Bạc';
    return 'Đồng';
  }

  createUser(username, password) {
    const normalized = username.trim();
    const error = this.validateCredentials(normalized, password);
    if (error) return { error };
    const user = {
      id: crypto.randomUUID(),
      username: normalized,
      passwordHash: this.hashPassword(password),
      elo: 100,
      games: 0,
      wins: 0,
      createdAt: new Date().toISOString()
    };
    try {
      this.database.prepare(`
        INSERT INTO users (id, username, password_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(user.id, user.username, user.passwordHash, user.createdAt);
    } catch (dbError) {
      if (String(dbError.message).includes('UNIQUE')) return { error: 'Tên tài khoản đã được sử dụng.' };
      throw dbError;
    }
    return { user: this.publicUser(user) };
  }

  provisionAdminAccount(username, password) {
    const normalized = String(username || '').trim();
    const error = this.validateCredentials(normalized, password);
    if (error) return { error };

    const existing = this.database.prepare('SELECT * FROM users WHERE username = ?').get(normalized);
    if (existing && !existing.is_admin) {
      return { error: 'Tên tài khoản Admin đã thuộc về tài khoản người dùng. Hãy chọn tên Admin khác.' };
    }

    if (existing) {
      if (!this.verifyPassword(password, existing.password_hash)) {
        this.database.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .run(this.hashPassword(password), existing.id);
      }
      return { user: this.publicUser(this.rowToUser(this.database.prepare('SELECT * FROM users WHERE id = ?').get(existing.id))) };
    }

    const user = {
      id: crypto.randomUUID(),
      username: normalized,
      passwordHash: this.hashPassword(password),
      elo: 100,
      games: 0,
      wins: 0,
      createdAt: new Date().toISOString()
    };
    this.database.prepare(`
      INSERT INTO users (id, username, password_hash, created_at, is_admin)
      VALUES (?, ?, ?, ?, 1)
    `).run(user.id, user.username, user.passwordHash, user.createdAt);
    return { user: this.publicUser({ ...user, isAdmin: true }) };
  }

  authenticate(username, password) {
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.trim()) ||
        typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
      return null;
    }
    const row = this.database.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    if (!row || !this.verifyPassword(password, row.password_hash)) return null;
    return this.publicUser(this.rowToUser(row));
  }

  createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    this.database.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, user.id, expiresAt);
    return token;
  }

  getSession(token) {
    if (typeof token !== 'string' || !token) return null;
    const session = this.database.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
    if (!session) return null;
    if (session.expires_at <= Date.now()) {
      this.destroySession(token);
      return null;
    }
    const row = this.database.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!row) {
      this.destroySession(token);
      return null;
    }
    return this.publicUser(this.rowToUser(row));
  }

  destroySession(token) {
    if (typeof token === 'string' && token) {
      this.database.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
  }

  deleteExpiredSessions() {
    this.database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }

  getUser(userId) {
    return this.rowToUser(this.database.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  }

  getLeaderboard(limit = 50) {
    return this.database.prepare('SELECT * FROM users ORDER BY elo DESC, wins DESC, username ASC LIMIT ?')
      .all(limit).map((row, index) => ({ ...this.publicUser(this.rowToUser(row)), position: index + 1 }));
  }

  getProfile(userId) {
    const user = this.getUser(userId);
    if (!user) return null;
    const matches = this.database.prepare(`
      SELECT m.*, wu.username AS winner_username, lu.username AS loser_username
      FROM matches m
      JOIN users wu ON wu.id = m.winner_id
      JOIN users lu ON lu.id = m.loser_id
      WHERE m.winner_id = ? OR m.loser_id = ?
      ORDER BY m.created_at DESC LIMIT 30
    `).all(userId, userId).map(match => ({
      id: match.id,
      opponent: match.winner_id === userId ? match.loser_username : match.winner_username,
      result: match.winner_id === userId ? 'win' : 'loss',
      eloBefore: match.winner_id === userId ? match.winner_elo_before : match.loser_elo_before,
      eloAfter: match.winner_id === userId ? match.winner_elo_after : match.loser_elo_after,
      change: match.winner_id === userId ? match.elo_change : -match.elo_change,
      mode: match.mode,
      reason: match.reason,
      createdAt: match.created_at
    }));
    return { ...this.publicUser(user), createdAt: user.createdAt, matches };
  }

  recordMatch(winnerId, loserId, mode = 'army', reason = '') {
    if (!winnerId || !loserId || winnerId === loserId) return null;
    const winner = this.getUser(winnerId);
    const loser = this.getUser(loserId);
    if (!winner || !loser) return null;
    const winnerBefore = winner.elo;
    const loserBefore = loser.elo;
    const expected = 1 / (1 + (10 ** ((loserBefore - winnerBefore) / 400)));
    const change = Math.max(1, Math.round(32 * (1 - expected)));
    const winnerAfter = winnerBefore + change;
    const loserAfter = Math.max(0, loserBefore - change);
    const matchId = crypto.randomUUID();
    try {
      this.database.exec('BEGIN');
      this.database.prepare('UPDATE users SET elo = ?, games = games + 1, wins = wins + 1 WHERE id = ?').run(winnerAfter, winnerId);
      this.database.prepare('UPDATE users SET elo = ?, games = games + 1 WHERE id = ?').run(loserAfter, loserId);
      this.database.prepare(`
        INSERT INTO matches
        (id, winner_id, loser_id, winner_elo_before, winner_elo_after, loser_elo_before, loser_elo_after, elo_change, mode, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(matchId, winnerId, loserId, winnerBefore, winnerAfter, loserBefore, loserAfter, change, mode, reason, new Date().toISOString());
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return {
      winner: this.publicUser(this.getUser(winnerId)),
      loser: this.publicUser(this.getUser(loserId)),
      change,
      matchId
    };
  }

  listUsers() {
    return this.database.prepare('SELECT id, username, elo, games, wins, created_at, is_admin FROM users ORDER BY created_at DESC')
      .all().map(row => ({ ...this.publicUser(this.rowToUser(row)), createdAt: row.created_at, isAdmin: Boolean(row.is_admin) }));
  }

  isAdmin(userId) {
    const user = this.getUser(userId);
    return Boolean(user?.isAdmin);
  }

  close() {
    this.database.close();
  }
}

module.exports = { AuthStore, USERNAME_PATTERN, PASSWORD_MIN_LENGTH };
