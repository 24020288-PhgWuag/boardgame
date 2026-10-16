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
      return Array.isArray(users) ? users : [];
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
    return { id: session.id, username: session.username };
  }

  destroySession(token) {
    if (token) this.sessions.delete(token);
  }

  publicUser(user) {
    return { id: user.id, username: user.username };
  }
}

module.exports = { AuthStore, USERNAME_PATTERN, PASSWORD_MIN_LENGTH };
