require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const RoomManager = require('./roomManager');
const BotProcess = require('./botProcess');
const { applyMove, createBotSnapshot } = require('./gameState');
const { createReplay, saveReplay } = require('./replay');
const { runMatch } = require('./matchRunner');
const TournamentManager = require('./tournamentManager');
const { AuthStore } = require('./authStore');
const CommunityTournamentManager = require('./communityTournamentManager');
const matchResultSheets = require('./matchResultSheets');
const RoomStateStore = require('./roomStateStore');
const BotUploadRateLimiter = require('./botUploadRateLimiter');
const { createSubmission } = require('./botSubmissions');
const AdminLoginRateLimiter = require('./adminLoginRateLimiter');

const app = express();
const defaultJsonParser = express.json({ limit: '256kb' });
const botUploadJsonParser = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  const isBotUpload = req.method === 'POST' &&
    (/^\/api\/bots$/.test(req.path) || /^\/api\/community-tournaments\/[^/]+\/bot$/.test(req.path));
  (isBotUpload ? botUploadJsonParser : defaultJsonParser)(req, res, next);
});
app.use('/api/match-results', matchResultSheets.router);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new RoomManager();
const roomStateStore = process.env.ROOM_STATE_REDIS_URL
  ? new RoomStateStore(process.env.ROOM_STATE_REDIS_URL)
  : null;
const auth = new AuthStore(
  path.join(__dirname, '..', 'data', 'boardgame.sqlite'),
  path.join(__dirname, '..', 'data', 'users.json')
);
const requestWindows = new Map();
const botUploadRateLimiter = new BotUploadRateLimiter();
const adminLoginRateLimiter = new AdminLoginRateLimiter();
let lastCpuSample = { usage: process.cpuUsage(), sampledAt: Date.now() };
const matchmakingQueue = [];
const TURN_LIMIT_MS = 30 * 1000;
const MAX_INTERACTIVE_BOT_PROCESSES = 8;
const BOT_MATCH_SPEEDS = {
  slow: 1500,
  medium: 900,
  fast: 250
};
const BOT_MATCH_SCRIPTS = {
  random: 'bots/random_bot.py',
  minimax: 'bots/minimax_bot.py',
  guardian: 'bots/guardian_bot.py'
};
const UPLOAD_DIR = path.join(__dirname, '..', 'bots', 'uploads');
const SUBMISSION_DIR = path.join(__dirname, '..', 'bots', 'submissions');
const TOURNAMENT_DIR = path.join(__dirname, '..', 'matches', 'tournaments');
const pendingMatchResults = new Map();
const MAX_PENDING_MATCH_RESULTS = 100000;
let matchResultPump;
let matchResultPumpActive = false;
let reportedMissingMatchResultConfig = false;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(SUBMISSION_DIR, { recursive: true });

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    return cookies;
  }, {});
}

function getRequestUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const playerUser = auth.getSession(cookies.ott_session);
  if (playerUser) return playerUser;
  const adminUser = auth.getSession(cookies.ott_admin_session);
  return adminUser && auth.isAdmin(adminUser.id) ? adminUser : null;
}

function getAdminRequestUser(req) {
  return auth.getSession(parseCookies(req.headers.cookie).ott_admin_session);
}

function appendCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  const cookies = current ? (Array.isArray(current) ? current : [current]) : [];
  res.setHeader('Set-Cookie', [...cookies, cookie]);
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `ott_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`);
}

function setAdminSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `ott_admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `ott_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}

function clearAdminSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `ott_admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}

function getUploadedBot(botId) {
  if (typeof botId !== 'string' || !botId.startsWith('uploaded:')) return null;
  const filename = botId.slice('uploaded:'.length);
  if (!/^[a-zA-Z0-9_-]+\.py$/.test(filename)) return null;
  const filePath = path.join(UPLOAD_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

function getBotDefinition(botId) {
  let script = null;
  let name = null;
  let sha256 = null;
  let untrusted = false;
  if (Object.prototype.hasOwnProperty.call(BOT_MATCH_SCRIPTS, botId)) {
    script = path.join(__dirname, '..', BOT_MATCH_SCRIPTS[botId]);
    name = getBotDisplayName(botId);
  } else if (typeof botId === 'string' && /^submission:[a-f0-9-]{36}$/i.test(botId)) {
    const id = botId.slice('submission:'.length);
    script = path.join(SUBMISSION_DIR, `${id}.py`);
    const metaPath = path.join(SUBMISSION_DIR, `${id}.json`);
    if (!fs.existsSync(script) || !fs.existsSync(metaPath)) return null;
    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    name = metadata.name;
    sha256 = metadata.sha256;
    untrusted = true;
  } else {
    script = getUploadedBot(botId);
    if (!script) return null;
    name = getBotDisplayName(botId);
    untrusted = true;
  }
  if (!fs.existsSync(script)) return null;
  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  if (sha256 && sha256 !== actualSha256) {
    console.error(`Bot submission checksum mismatch: ${botId}`);
    return null;
  }
  sha256 ||= actualSha256;
  return { id: botId, name, script, sha256, untrusted };
}

function enforceBotUploadLimits(req, res, user) {
  const retryAfter = botUploadRateLimiter.consume(req.socket.remoteAddress || 'unknown', user.id);
  if (!retryAfter) return true;
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({ error: 'Bạn tải bot quá nhanh. Vui lòng thử lại sau.', retryAfter });
  return false;
}

function interactiveBotProcessCount() {
  let count = 0;
  for (const room of rooms.rooms.values()) {
    if (room.bot) count++;
    if (room.botMatch) count += 2;
  }
  return count;
}

const tournaments = new TournamentManager(TOURNAMENT_DIR, {
  resolveBot: getBotDefinition,
  runMatch,
  onMatchComplete: recordMatchResult
});
const communityTournaments = new CommunityTournamentManager(
  path.join(TOURNAMENT_DIR, 'community-events.json'),
  {
    startTournament: event => tournaments.create({
      name: event.name,
      botIds: event.players.map(player => player.botId),
      mode: event.mode,
      maxTurns: event.maxTurns,
      format: 'single-elimination'
    })
  }
);
communityTournaments.startTournament.read = id => tournaments.read(id);

function getBotDisplayName(botId) {
  if (botId === 'minimax') return 'Minimax Bot';
  if (botId === 'random') return 'Random Bot';
  return botId.replace(/^uploaded:/, '').replace(/\.py$/, '');
}

function replayNamePart(name) {
  return String(name || 'bot')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'bot';
}

function replayTimestamp(date = new Date()) {
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}Z$/, '');
}

function saveBotMatchReplay(room) {
  if (!room?.botMatch || room.botMatch.replaySaved || !room.state.winner) return;
  const result = {
    winner: room.state.winner,
    reason: room.state.winReason,
    bot_p1: room.botMatch.botP1Name,
    bot_p2: room.botMatch.botP2Name
  };
  const replay = createReplay(room.mode, room.botMatch.initialState, room.state.history, result);
  replay.players = { p1: room.botMatch.botP1Name, p2: room.botMatch.botP2Name };
  replay.speed = room.botMatch.speed;
  const filename = `${replayNamePart(room.botMatch.botP1Name)}-${replayNamePart(room.botMatch.botP2Name)}-${replayTimestamp()}.json`;
  room.botMatch.replayFile = saveReplay(replay, path.join(__dirname, '..', 'matches', filename));
  room.botMatch.replaySaved = true;
  queueRoomMatchResult(room);
  console.log(`Saved bot match replay: ${room.botMatch.replayFile}`);
}

app.get('/admin.html', (req, res) => {
  const user = getAdminRequestUser(req);
  if (!user || !auth.isAdmin(user.id)) return res.redirect('/admin-login.html');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/auth/me', (req, res) => {
  res.json({ user: getRequestUser(req) });
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: auth.getLeaderboard() });
});

app.get('/api/profile/:id', (req, res) => {
  const profile = auth.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Không tìm thấy người chơi.' });
  res.json({ profile });
});

function requireAdmin(req, res, next) {
  const user = getAdminRequestUser(req);
  if (!user || !auth.isAdmin(user.id)) return res.status(403).json({ error: 'Bạn không có quyền quản trị.' });
  req.user = user;
  next();
}

app.get('/api/admin/metrics', requireAdmin, (req, res) => {
  const memory = process.memoryUsage();
  const latencies = [...wss.clients]
    .map(socket => socket.lastRttMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const sampledAt = Date.now();
  const elapsedMicros = (sampledAt - lastCpuSample.sampledAt) * 1000;
  const cpu = process.cpuUsage(lastCpuSample.usage);
  lastCpuSample = { usage: process.cpuUsage(), sampledAt };
  const uptimeSeconds = process.uptime();
  res.json({
    uptimeSeconds,
    connections: wss.clients.size,
    rooms: rooms.rooms.size,
    botProcesses: interactiveBotProcessCount(),
    roomsWithPlayers: [...rooms.rooms.values()].filter(room =>
      room.state.players.p1 || room.state.players.p2
    ).length,
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external
    },
    cpu: {
      userMicros: cpu.user,
      systemMicros: cpu.system,
      percent: elapsedMicros > 0 ? ((cpu.user + cpu.system) / elapsedMicros) * 100 : 0
    },
    latencyMs: {
      p50: latencies.length ? latencies[Math.floor((latencies.length - 1) * 0.5)] : null,
      p95: latencies.length ? latencies[Math.ceil((latencies.length - 1) * 0.95)] : null,
      max: latencies.length ? latencies[latencies.length - 1] : null
    },
    rateLimitBuckets: requestWindows.size
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: auth.listUsers() });
});

app.get('/api/community-tournaments', (req, res) => {
  communityTournaments.sync();
  res.json({ tournaments: communityTournaments.list() });
});

app.post('/api/community-tournaments', requireAdmin, (req, res) => {
  const mode = req.body?.mode;
  const maxTurns = Number(req.body?.maxTurns || 300);
  if (!['classic', 'tactical', 'army'].includes(mode)) {
    return res.status(400).json({ error: 'Hãy chọn chế độ chơi hợp lệ.' });
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 20 || maxTurns > 2000) {
    return res.status(400).json({ error: 'Giới hạn lượt phải từ 20 đến 2000.' });
  }
  const maxPlayers = Number(req.body?.maxPlayers ?? 12);
  if (!Number.isInteger(maxPlayers) || maxPlayers < CommunityTournamentManager.MIN_PLAYERS ||
    maxPlayers > CommunityTournamentManager.MAX_PLAYERS) {
    return res.status(400).json({
      error: `Số người tham gia phải từ ${CommunityTournamentManager.MIN_PLAYERS} đến ${CommunityTournamentManager.MAX_PLAYERS}.`
    });
  }
  res.status(201).json({ tournament: communityTournaments.create({ name: req.body?.name, mode, maxTurns, maxPlayers }) });
});

app.post('/api/community-tournaments/:id/register', (req, res) => {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: 'Bạn cần đăng nhập để đăng ký bot.' });
  const result = communityTournaments.register(req.params.id, {
    userId: user.id,
    username: user.username
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json({ tournament: result.event });
});

app.post('/api/community-tournaments/:id/bot', (req, res) => {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: 'Bạn cần đăng nhập để tải bot lên.' });
  const registration = communityTournaments.canSubmitBot(req.params.id, user.id);
  if (registration.error) return res.status(400).json({ error: registration.error });
  if (!enforceBotUploadLimits(req, res, user)) return;

  const submission = createSubmission(SUBMISSION_DIR, {
    filename: String(req.body?.filename || ''),
    source: req.body?.source,
    name: req.body?.name || 'Community Bot',
    user
  });
  if (submission.error) return res.status(submission.status).json({ error: submission.error });
  const result = communityTournaments.submitBot(req.params.id, user.id, {
    botId: `submission:${submission.id}`,
    botName: submission.name
  });
  if (result.error) {
    fs.rmSync(path.join(SUBMISSION_DIR, `${submission.id}.py`), { force: true });
    fs.rmSync(path.join(SUBMISSION_DIR, `${submission.id}.json`), { force: true });
    return res.status(400).json({ error: result.error });
  }
  res.status(201).json({ tournament: result.event, bot: submission });
});

app.post('/api/community-tournaments/:id/start', requireAdmin, (req, res) => {
  try {
    const result = communityTournaments.start(req.params.id);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ tournament: result.event });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/register', (req, res) => {
  const result = auth.createUser(String(req.body?.username || ''), req.body?.password);
  if (result.error) return res.status(400).json({ error: result.error });
  const cookies = parseCookies(req.headers.cookie);
  auth.destroySession(cookies.ott_admin_session);
  setSessionCookie(res, auth.createSession(result.user));
  clearAdminSessionCookie(res);
  res.status(201).json({ user: result.user });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const ip = req.socket.remoteAddress || 'unknown';
  const retryAfter = adminLoginRateLimiter.retryAfter(ip, username);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Đăng nhập thất bại quá nhiều lần. Hãy thử lại sau.', retryAfter });
  }
  const user = auth.authenticate(username, req.body?.password);
  if (!user) {
    adminLoginRateLimiter.recordFailure(ip, username);
    return res.status(401).json({ error: 'Tên tài khoản hoặc mật khẩu không đúng.' });
  }
  adminLoginRateLimiter.clear(ip, username);
  if (auth.isAdmin(user.id)) {
    auth.destroySession(parseCookies(req.headers.cookie).ott_session);
    setAdminSessionCookie(res, auth.createSession(user));
    clearSessionCookie(res);
    return res.json({ user });
  }
  auth.destroySession(parseCookies(req.headers.cookie).ott_admin_session);
  setSessionCookie(res, auth.createSession(user));
  clearAdminSessionCookie(res);
  res.json({ user });
});

app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const ip = req.socket.remoteAddress || 'unknown';
  const retryAfter = adminLoginRateLimiter.retryAfter(ip, username);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Đăng nhập Admin thất bại quá nhiều lần. Hãy thử lại sau.', retryAfter });
  }
  const password = req.body?.password;
  const user = username.length <= 24 && typeof password === 'string'
    ? auth.authenticate(username, password)
    : null;
  if (!user || !auth.isAdmin(user.id)) {
    adminLoginRateLimiter.recordFailure(ip, username);
    return res.status(401).json({ error: 'Thông tin đăng nhập Admin không đúng.' });
  }
  adminLoginRateLimiter.clear(ip, username);
  auth.destroySession(parseCookies(req.headers.cookie).ott_session);
  setAdminSessionCookie(res, auth.createSession(user));
  clearSessionCookie(res);
  res.json({ user });
});

app.post('/api/admin/logout', (req, res) => {
  auth.destroySession(parseCookies(req.headers.cookie).ott_admin_session);
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  auth.destroySession(cookies.ott_session);
  auth.destroySession(cookies.ott_admin_session);
  clearSessionCookie(res);
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

// Specific route aliases for playfull.html / playful.html
app.get('/playfull.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'playfull.html'));
});
app.get('/playful.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'playfull.html'));
});

// JSON API endpoint for room list
app.get('/api/rooms', (req, res) => {
  res.json({ rooms: rooms.getPublicRooms() });
});

app.get('/api/bots', (req, res) => {
  const bots = [
    ...Object.keys(BOT_MATCH_SCRIPTS).map(id => ({ id, name: getBotDisplayName(id), builtin: true })),
    ...fs.readdirSync(UPLOAD_DIR)
    .filter(file => /^[a-zA-Z0-9_-]+\.py$/.test(file))
    .map(file => ({ id: `uploaded:${file}`, name: file.replace(/\.py$/i, ''), legacy: true })),
    ...fs.readdirSync(SUBMISSION_DIR)
      .filter(file => /^[a-f0-9-]{36}\.json$/i.test(file))
      .map(file => {
        const metadata = JSON.parse(fs.readFileSync(path.join(SUBMISSION_DIR, file), 'utf8'));
        return { id: `submission:${file.slice(0, -5)}`, name: metadata.name, sha256: metadata.sha256 };
      })
  ];
  res.json({ bots });
});

app.post('/api/bots', (req, res) => {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: 'Bạn cần đăng nhập để tải bot lên.' });
  if (!enforceBotUploadLimits(req, res, user)) return;
  const submission = createSubmission(SUBMISSION_DIR, {
    filename: String(req.body?.filename || ''),
    source: req.body?.source,
    name: req.body?.name,
    user
  });
  if (submission.error) return res.status(submission.status).json({ error: submission.error });
  res.status(201).json({
    bot: { id: `submission:${submission.id}`, name: submission.name, sha256: submission.sha256 }
  });
});

app.get('/api/tournaments', (req, res) => {
  res.json({ tournaments: tournaments.list().map(({ bots, matches, ...item }) => ({
    ...item,
    matches,
    botCount: bots.length,
    matchCount: matches.length,
    completedMatches: matches.filter(match => match.status === 'completed').length,
    standings: tournaments.standings({ bots, matches })
  })) });
});

app.post('/api/tournaments', (req, res) => {
  const mode = req.body?.mode;
  const maxTurns = Number(req.body?.maxTurns || 300);
  if (!['classic', 'tactical', 'army'].includes(mode)) {
    return res.status(400).json({ error: 'Hãy chọn chế độ chơi hợp lệ.' });
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 20 || maxTurns > 2000) {
    return res.status(400).json({ error: 'Giới hạn lượt phải từ 20 đến 2000.' });
  }
  try {
    const tournament = tournaments.create({
      name: req.body?.name,
      botIds: req.body?.botIds,
      mode,
      maxTurns,
      format: req.body?.format === 'single-elimination' ? 'single-elimination' : 'round-robin-two-legs'
    });
    const { bots, ...publicTournament } = tournament;
    res.status(201).json({ tournament: {
      ...publicTournament,
      bots: bots.map(({ script, ...bot }) => bot),
      standings: tournaments.standings(tournament)
    } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/tournaments/:id', (req, res) => {
  const tournament = tournaments.read(req.params.id);
  if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
  const { bots, ...publicTournament } = tournament;
  res.json({ tournament: {
    ...publicTournament,
    bots: bots.map(({ script, ...bot }) => bot),
    standings: tournaments.standings(tournament)
  } });
});

app.get('/api/replays', (req, res) => {
  const replayDir = path.join(__dirname, '..', 'matches');
  if (!fs.existsSync(replayDir)) return res.json({ replays: [] });
  const tournamentReplayDir = path.join(TOURNAMENT_DIR, 'replays');
  const files = fs.readdirSync(replayDir).filter(file => file.endsWith('.json'));
  if (fs.existsSync(tournamentReplayDir)) files.push(...fs.readdirSync(tournamentReplayDir).filter(file => file.endsWith('.json')));
  const replays = [...new Set(files)]
    .map(file => ({ file, path: `/api/replays/${encodeURIComponent(file)}` }));
  res.json({ replays });
});

app.get('/api/replays/:file', (req, res) => {
  const file = path.basename(req.params.file);
  if (!file.endsWith('.json')) {
    return res.status(400).json({ error: 'Replay file không hợp lệ.' });
  }
  const replayPath = path.join(__dirname, '..', 'matches', file);
  const tournamentReplayPath = path.join(TOURNAMENT_DIR, 'replays', file);
  const resolvedReplayPath = fs.existsSync(replayPath) ? replayPath : tournamentReplayPath;
  if (!fs.existsSync(resolvedReplayPath)) {
    return res.status(404).json({ error: 'Không tìm thấy replay.' });
  }
  res.sendFile(resolvedReplayPath);
});

function send(socket, type, payload = {}) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ type, ...payload }));
  }
}

function saveRoomState(room) {
  if (!roomStateStore || !room || room.bot || room.botMatch) return;
  roomStateStore.save(room).catch(error => {
    console.error(`Could not persist room ${room.code} to Redis:`, error.message);
  });
}

async function loadRoomState(code) {
  if (!roomStateStore) return rooms.getRoom(code);
  const snapshot = await roomStateStore.get(code);
  return snapshot ? rooms.restoreRoom(snapshot) : rooms.getRoom(code);
}

function deliverMatchedPlayer(event) {
  if (event.targetInstance !== roomStateStore?.instanceId) return;
  const socket = [...wss.clients].find(client => client.id === event.socketId);
  if (!socket) return;
  const room = rooms.restoreRoom(event.snapshot);
  const joined = rooms.joinRoom(room.code, socket);
  if (joined.error) {
    send(socket, 'error', { message: joined.error });
    return;
  }
  socket.roomCode = room.code;
  clearTimeout(room.cleanupTimer);
  setTurnDeadline(room);
  saveRoomState(room);
  send(socket, 'joined', {
    code: room.code,
    player: joined.player,
    state: room.state,
    mode: room.mode,
    host: room.host || null,
    turnDeadline: room.turnDeadline || null
  });
  broadcast(room, 'room-update', {
    state: room.state,
    event: 'player_joined',
    player: joined.player,
    host: room.host || null,
    turnDeadline: room.turnDeadline || null
  });
  broadcastRooms();
}

function broadcast(room, type, payload = {}) {
  if (!room || !room.sockets) return;
  for (const socket of room.sockets.keys()) {
    send(socket, type, payload);
  }
  if (roomStateStore) {
    roomStateStore.publish({ kind: 'room-event', code: room.code, type, payload })
      .catch(error => console.error(`Could not publish room ${room.code} event:`, error.message));
  }
}

function broadcastRooms() {
  const payload = { rooms: rooms.getPublicRooms() };
  for (const socket of wss.clients) send(socket, 'rooms_list', payload);
  if (roomStateStore) {
    roomStateStore.publish({ kind: 'rooms', rooms: payload.rooms })
      .catch(error => console.error('Could not publish room list:', error.message));
  }
}

if (roomStateStore) {
  roomStateStore.subscribe(event => {
    if (event.kind === 'snapshot') {
      rooms.restoreRoom(event.snapshot);
    } else if (event.kind === 'room-event') {
      const room = rooms.getRoom(event.code);
      if (room) {
        for (const socket of room.sockets.keys()) send(socket, event.type, event.payload);
      }
    } else if (event.kind === 'room-removed') {
      const room = rooms.getRoom(event.code);
      if (room) {
        for (const socket of room.sockets.keys()) {
          socket.roomCode = null;
          send(socket, 'room-closed', { code: event.code });
        }
      }
      rooms.deleteRoom(event.code, { force: true });
      broadcastRooms();
    } else if (event.kind === 'rooms') {
      for (const socket of wss.clients) send(socket, 'rooms_list', { rooms: event.rooms });
    } else if (event.kind === 'match-found') {
      deliverMatchedPlayer(event);
    }
  });
}

function broadcastState(room, outcome, from, to, player) {
  saveRoomState(room);
  broadcast(room, 'state', {
    state: room.state,
    result: outcome.result,
    capturedPiece: outcome.capturedPiece,
    from,
    to,
    lastPlayer: player,
    host: room.host || null,
    turnDeadline: room.turnDeadline || null
  });
}

function recordMatchResult(result) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (!reportedMissingMatchResultConfig) {
      reportedMissingMatchResultConfig = true;
      console.error('Match result reporting is disabled: configure GOOGLE_APPLICATION_CREDENTIALS to enable it.');
    }
    return false;
  }
  const record = matchResultSheets.validateRecord(result);
  if (!record) {
    console.error('Refusing to queue an invalid completed match result.');
    return false;
  }
  if (!pendingMatchResults.has(record.matchId) &&
      pendingMatchResults.size >= MAX_PENDING_MATCH_RESULTS) {
    console.error(`Completed match result queue is full (${MAX_PENDING_MATCH_RESULTS}); result ${record.matchId} was not queued.`);
    return false;
  }

  pendingMatchResults.set(record.matchId, record);
  if (!matchResultPump) {
    matchResultPump = setInterval(pumpMatchResults, 1000);
    matchResultPump.unref();
  }
  if (pendingMatchResults.size >= 100) void pumpMatchResults();
  return true;
}

async function pumpMatchResults() {
  if (matchResultPumpActive || !pendingMatchResults.size) return;
  matchResultPumpActive = true;
  const batch = [...pendingMatchResults.entries()].slice(0, 100);
  try {
    await matchResultSheets.enqueueMatchResults(batch.map(([, record]) => record));
    for (const [matchId, record] of batch) {
      if (pendingMatchResults.get(matchId) === record) pendingMatchResults.delete(matchId);
    }
  } catch (error) {
    console.error(`Could not queue completed match results; will retry: ${error.message}`);
  } finally {
    matchResultPumpActive = false;
    if (!pendingMatchResults.size && matchResultPump) {
      clearInterval(matchResultPump);
      matchResultPump = null;
    }
  }
}

function queueRoomMatchResult(room) {
  if (!room?.state?.winner || room.resultQueued) return;
  const isBotMatch = Boolean(room.botMatch);
  const bot1 = isBotMatch
    ? room.botMatch.botP1Name
    : room.state.players.p1 || 'P1';
  const bot2 = isBotMatch
    ? room.botMatch.botP2Name
    : room.state.players.p2 || 'P2';
  recordMatchResult({
    matchId: room.matchResultId || crypto.randomUUID(),
    bot1: String(bot1).slice(0, 100),
    bot2: String(bot2).slice(0, 100),
    winner: room.state.winner === 'p1' ? 'bot1' : 'bot2',
    playedAt: new Date().toISOString()
  });
  room.resultQueued = true;
}

function settleOnlineRating(room) {
  if (!room || room.ratingUpdated || room.bot || room.botMatch || !room.state.winner) return null;
  const users = {};
  for (const [socket, role] of room.sockets.entries()) {
    if ((role === 'p1' || role === 'p2') && socket.user) users[role] = socket.user;
  }
  if (!users.p1 || !users.p2) return null;

  const winner = users[room.state.winner];
  const loser = users[room.state.winner === 'p1' ? 'p2' : 'p1'];
  const result = auth.recordMatch(winner.id, loser.id, room.mode, room.state.winReason);
  if (!result) return null;
  room.ratingUpdated = true;
  broadcast(room, 'rating-updated', {
    winner: result.winner,
    loser: result.loser,
    change: result.change
  });
  return result;
}

function setTurnDeadline(room) {
  clearTimeout(room.turnTimer);
  const bothPlayersPresent = room?.state.players.p1 && room?.state.players.p2;
  if (!room) return;
  if (room.state.winner || room.bot || room.botMatch || !bothPlayersPresent ||
      room.disconnectedPlayers.has('p1') || room.disconnectedPlayers.has('p2')) {
    room.turnDeadline = null;
    return;
  }
  room.turnDeadline = Date.now() + TURN_LIMIT_MS;
  room.turnTimer = setTimeout(async () => {
    let releaseLock;
    try {
      if (roomStateStore) {
        releaseLock = await roomStateStore.lock(room.code);
        await loadRoomState(room.code);
      }
      if (!room.state.winner && room.turnDeadline && room.turnDeadline <= Date.now()) {
        room.state.winner = room.state.turn === 'p1' ? 'p2' : 'p1';
        room.state.winReason = 'Đối thủ hết thời gian lượt đi.';
        room.state.turn = room.state.winner;
        if (roomStateStore) await roomStateStore.save(room);
        broadcastState(room, { result: 'timeout' }, null, null, null);
        settleOnlineRating(room);
        queueRoomMatchResult(room);
      }
    } catch (error) {
      console.error(`Could not process timeout for room ${room.code}:`, error.message);
    } finally {
      if (releaseLock) {
        try {
          await releaseLock();
        } catch (error) {
          console.error(`Could not release timeout lock for room ${room.code}:`, error.message);
        }
      }
    }
  }, TURN_LIMIT_MS + 100);
}

function hasConnectedPlayer(room) {
  return !room.bot && !room.botMatch &&
    ['p1', 'p2'].some(player =>
      room.state.players[player] && !room.disconnectedPlayers.has(player)
    );
}

function rateLimitSocket(socket, type) {
  const now = Date.now();
  const key = `${socket.user?.id || socket._socket?.remoteAddress || 'anonymous'}:${type}`;
  const previous = requestWindows.get(key) || [];
  const recent = previous.filter(timestamp => now - timestamp < 1000);
  const limit = type === 'move' ? 8 : 30;
  if (recent.length >= limit) return false;
  recent.push(now);
  if (!requestWindows.has(key) && requestWindows.size >= 10000) {
    const oldestKey = requestWindows.keys().next().value;
    requestWindows.delete(oldestKey);
  }
  requestWindows.set(key, recent);
  return true;
}

const requestWindowCleanup = setInterval(() => {
  const cutoff = Date.now() - 1000;
  for (const [key, timestamps] of requestWindows) {
    const recent = timestamps.filter(timestamp => timestamp > cutoff);
    if (recent.length) requestWindows.set(key, recent);
    else requestWindows.delete(key);
  }
}, 60_000);
requestWindowCleanup.unref();

function forfeitBot(room, reason) {
  if (!room || room.state.winner) return;
  room.bot?.stop();
  room.state.winner = 'p1';
  room.state.winReason = `Bot đã bị xử thua: ${reason}`;
  room.state.turn = 'p1';
  queueRoomMatchResult(room);
  broadcast(room, 'state', {
    state: room.state,
    result: 'forfeit',
    lastPlayer: 'p2'
  });
}

function forfeitBotMatch(room, player, reason) {
  if (!room || room.state.winner) return;
  room.botMatch?.p1?.stop();
  room.botMatch?.p2?.stop();
  room.state.winner = player === 'p1' ? 'p2' : 'p1';
  room.state.winReason = `${player === 'p1' ? 'Bot P1' : 'Bot P2'} bị xử thua: ${reason}`;
  room.state.turn = room.state.winner;
  queueRoomMatchResult(room);
  broadcast(room, 'state', {
    state: room.state,
    result: 'forfeit',
    lastPlayer: player
  });
  saveBotMatchReplay(room);
}

async function requestBotTurn(room) {
  if (!room?.bot || room.state.winner || room.state.turn !== 'p2') return;

  try {
    const response = await room.bot.request({
      protocol_version: 1,
      type: 'your_turn',
      match_id: room.code,
      player: 'p2',
      turn: room.state.history.length + 1,
      ruleset: `${room.mode}-v1`,
      state: createBotSnapshot(room.state),
      time_limit_ms: room.bot.timeoutMs
    });

    const action = response?.action;
    if (!action || action.type !== 'move') {
      return forfeitBot(room, response?.message || 'Bot không trả về một nước đi hợp lệ.');
    }

    const from = action.from;
    const to = action.to;
    const outcome = applyMove(room.state, 'p2', from, to);
    if (!outcome.ok) {
      return forfeitBot(room, outcome.reason);
    }

    broadcastState(room, outcome, from, to, 'p2');
    if (room.state.winner) queueRoomMatchResult(room);
  } catch (error) {
    console.error(`Bot failure in room ${room.code}:`, error.message);
    forfeitBot(room, error.message);
  }
}

async function requestBotMatchTurn(room) {
  if (!room?.botMatch || room.state.winner) return;
  const player = room.state.turn;
  const bot = room.botMatch[player];
  if (!bot) return;

  try {
    const response = await bot.request({
      protocol_version: 1,
      type: 'your_turn',
      match_id: room.code,
      player,
      turn: room.state.history.length + 1,
      ruleset: `${room.mode}-v1`,
      state: createBotSnapshot(room.state),
      time_limit_ms: bot.timeoutMs
    });
    const action = response?.action;
    if (!action || action.type !== 'move') {
      return forfeitBotMatch(room, player, response?.message || 'Bot không trả về nước đi.');
    }

    const outcome = applyMove(room.state, player, action.from, action.to);
    if (!outcome.ok) return forfeitBotMatch(room, player, outcome.reason);

    broadcastState(room, outcome, action.from, action.to, player);
    if (!room.state.winner) {
      scheduleBotMatchTurn(room);
    } else {
      saveBotMatchReplay(room);
    }
  } catch (error) {
    console.error(`Bot match failure in room ${room.code}:`, error.message);
    forfeitBotMatch(room, player, error.message);
  }
}

function scheduleBotMatchTurn(room) {
  if (!room?.botMatch || room.state.winner) return;
  clearTimeout(room.botMatch.timer);
  room.botMatch.timer = setTimeout(() => {
    room.botMatch.timer = null;
    requestBotMatchTurn(room);
  }, room.botMatch.delayMs);
}

wss.on('connection', (socket, req) => {
  socket.isAlive = true;
  socket.user = getRequestUser(req);
  socket.rateLimited = false;
  socket.id = crypto.randomUUID();
  socket.on('pong', () => {
    socket.isAlive = true;
    if (socket.pingSentAt) socket.lastRttMs = Date.now() - socket.pingSentAt;
    socket.pingSentAt = null;
  });

  socket.on('message', raw => {
    let roomLock;
    let lockCode;
    void (async () => {
      try {
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return send(socket, 'error', { message: 'Gói tin không hợp lệ.' });
        }
        if (!rateLimitSocket(socket, message.type || 'unknown')) {
          return send(socket, 'error', { message: 'Bạn gửi yêu cầu quá nhanh. Hãy thử lại sau.' });
        }

        if (roomStateStore && socket.user &&
            ['join', 'move', 'rematch', 'chat', 'leave_room'].includes(message.type)) {
          lockCode = message.type === 'join'
            ? String(message.code || '').trim().toUpperCase()
            : socket.roomCode;
          if (lockCode) {
            roomLock = await roomStateStore.lock(lockCode);
            await loadRoomState(lockCode);
          }
        }

        // Ping / Pong for latency
        if (message.type === 'ping') {
          return send(socket, 'pong', { time: message.time });
        }

        // Request rooms list
        if (message.type === 'list_rooms') {
          return send(socket, 'rooms_list', { rooms: rooms.getPublicRooms() });
        }

        if (message.type === 'leave_room') {
          const result = rooms.leave(socket);
          if (result?.room) {
            const { room } = result;
            socket.roomCode = null;
            if (['p1', 'p2'].includes(result.disconnectedRole)) setTurnDeadline(room);

            if (!hasConnectedPlayer(room)) {
              for (const roomSocket of room.sockets.keys()) {
                roomSocket.roomCode = null;
                send(roomSocket, 'room-closed', { code: result.code });
              }
              rooms.deleteRoom(result.code, { force: true });
              // Notify clients before the slower Redis cleanup so the room vanishes instantly.
              broadcastRooms();
              send(socket, 'room-left');
              if (roomStateStore) await roomStateStore.deleteRoom(result.code);
              return;
            } else {
              if (roomStateStore) await roomStateStore.save(room);
              else saveRoomState(room);
              broadcast(room, 'room-update', {
                state: room.state,
                event: 'player_left',
                disconnectedRole: result.disconnectedRole,
                host: room.host || null,
                turnDeadline: room.turnDeadline || null
              });
            }
            broadcastRooms();
          }
          return send(socket, 'room-left');
        }

        if (message.type === 'quick_match') {
          if (!socket.user) return send(socket, 'auth_required', { message: 'Bạn cần đăng nhập để tìm trận.' });
          if (roomStateStore) {
            const mode = ['classic', 'tactical', 'army'].includes(message.mode) ? message.mode : 'army';
            const candidate = await roomStateStore.findMatchOrEnqueue({
              socketId: socket.id,
              instanceId: roomStateStore.instanceId,
              userId: socket.user.id,
              username: socket.user.username,
              elo: socket.user.elo,
              mode
            });
            if (!candidate) {
              return send(socket, 'matchmaking', { waiting: true, message: 'Đang tìm đối thủ có ELO gần bạn...' });
            }

            const room = rooms.createRoom(mode);
            room.state.players = { p1: candidate.username, p2: socket.user.username };
            room.host = 'p1';
            room.disconnectedPlayers.add('p1');
            room.disconnectedPlayers.add('p2');
            const joined = rooms.joinRoom(room.code, socket);
            socket.roomCode = room.code;
            await roomStateStore.save(room);
            send(socket, 'joined', {
              code: room.code,
              player: joined.player,
              state: room.state,
              mode: room.mode,
              host: room.host,
              turnDeadline: room.turnDeadline || null
            });
            const event = {
              kind: 'match-found',
              targetInstance: candidate.instanceId,
              socketId: candidate.socketId,
              snapshot: roomStateStore.snapshot(room)
            };
            if (candidate.instanceId === roomStateStore.instanceId) deliverMatchedPlayer(event);
            else await roomStateStore.publish(event);
            broadcastRooms();
            return;
          }
          const existing = matchmakingQueue.find(item => item.socket !== socket && Math.abs(item.elo - socket.user.elo) <= 250);
          if (existing) {
            matchmakingQueue.splice(matchmakingQueue.indexOf(existing), 1);
            const room = rooms.createRoom(message.mode || 'army');
            const first = rooms.joinRoom(room.code, existing.socket);
            const second = rooms.joinRoom(room.code, socket);
            room.state.players.p1 = existing.socket.user.username;
            room.state.players.p2 = socket.user.username;
            existing.socket.roomCode = room.code;
            socket.roomCode = room.code;
            setTurnDeadline(room);
            send(existing.socket, 'joined', {
              code: room.code,
              player: first.player,
              state: room.state,
              mode: room.mode,
              host: room.host,
              turnDeadline: room.turnDeadline || null
            });
            send(socket, 'joined', {
              code: room.code,
              player: second.player,
              state: room.state,
              mode: room.mode,
              host: room.host,
              turnDeadline: room.turnDeadline || null
            });
            saveRoomState(room);
            return;
          }
          matchmakingQueue.push({ socket, elo: socket.user.elo, mode: message.mode || 'army' });
          return send(socket, 'matchmaking', { waiting: true, message: 'Đang tìm đối thủ có ELO gần bạn...' });
        }

        if (['create', 'join', 'create_bot_match'].includes(message.type) && !socket.user) {
          return send(socket, 'auth_required', { message: 'Bạn cần đăng nhập để chơi online.' });
        }

        // Create room
        if (message.type === 'create') {
          const mode = message.mode || 'army';
          const password = typeof message.password === 'string' ? message.password.trim() : '';
          if (password.length > 64) {
            return send(socket, 'error', { message: 'Mật khẩu phòng tối đa 64 ký tự.' });
          }
          if (message.bot === true &&
              interactiveBotProcessCount() >= MAX_INTERACTIVE_BOT_PROCESSES) {
            return send(socket, 'error', { message: 'Server đã đạt giới hạn bot đang chạy. Vui lòng thử lại sau.' });
          }
          const room = rooms.createRoom(mode, password);
          const joined = rooms.joinRoom(room.code, socket);
          room.state.players[joined.player] = socket.user.username;
          socket.roomCode = room.code;
          if (message.bot === true) {
            room.bot = new BotProcess({
              cwd: path.join(__dirname, '..'),
              onError: error => console.error(`Bot process error in room ${room.code}:`, error.message)
            });
            room.bot.start();
            room.state.players.p2 = 'p2';
          }
          send(socket, 'joined', {
            code: room.code,
            player: joined.player,
            state: room.state,
            mode: room.mode,
            bot: Boolean(room.bot),
            host: room.host || null,
            turnDeadline: room.turnDeadline || null
          });
          saveRoomState(room);
          broadcastRooms();
          setTurnDeadline(room);
          return;
        }

        if (message.type === 'create_bot_match') {
          if (interactiveBotProcessCount() + 2 > MAX_INTERACTIVE_BOT_PROCESSES) {
            return send(socket, 'error', { message: 'Server đã đạt giới hạn bot đang chạy. Vui lòng thử lại sau.' });
          }
          const mode = message.mode || 'army';
          const botP1Definition = getBotDefinition(message.botP1) || getBotDefinition('minimax');
          const botP2Definition = getBotDefinition(message.botP2) || getBotDefinition('random');
          const botP1 = botP1Definition.id;
          const botP2 = botP2Definition.id;
          const speed = Object.prototype.hasOwnProperty.call(BOT_MATCH_SPEEDS, message.speed)
            ? message.speed
            : 'medium';
          const room = rooms.createRoom(mode);
          const joined = rooms.joinRoom(room.code, socket, 'spectator');
          socket.roomCode = room.code;
          room.state.players = { p1: 'bot-p1', p2: 'bot-p2' };
          room.botMatch = {
            botP1,
            botP2,
            botP1Name: botP1Definition.name,
            botP2Name: botP2Definition.name,
            speed,
            delayMs: BOT_MATCH_SPEEDS[speed],
            timer: null,
            initialState: JSON.parse(JSON.stringify(room.state)),
            replaySaved: false,
            p1: new BotProcess({
              cwd: path.join(__dirname, '..'),
              script: botP1Definition.script,
              sandboxed: botP1Definition.untrusted,
              onError: error => console.error(`Bot P1 error in room ${room.code}:`, error.message)
            }),
            p2: new BotProcess({
              cwd: path.join(__dirname, '..'),
              script: botP2Definition.script,
              sandboxed: botP2Definition.untrusted,
              onError: error => console.error(`Bot P2 error in room ${room.code}:`, error.message)
            })
          };
          room.botMatch.p1.start();
          room.botMatch.p2.start();
          send(socket, 'joined', {
            code: room.code,
            player: joined.player,
            state: room.state,
            mode: room.mode,
            host: room.host || null,
            botMatch: true,
            botMatchOptions: {
              botP1,
              botP2,
              speed,
              botP1Name: room.botMatch.botP1Name,
              botP2Name: room.botMatch.botP2Name
            }
          });
          requestBotMatchTurn(room);
          return;
        }

        if (message.type === 'set_bot_match_speed') {
          const room = rooms.getRoom(socket.roomCode);
          if (!room?.botMatch || room.sockets.get(socket) !== 'spectator') return;
          if (!Object.prototype.hasOwnProperty.call(BOT_MATCH_SPEEDS, message.speed)) {
            return send(socket, 'error', { message: 'Tốc độ bot không hợp lệ.' });
          }
          room.botMatch.speed = message.speed;
          room.botMatch.delayMs = BOT_MATCH_SPEEDS[message.speed];
          broadcast(room, 'bot-speed-updated', { speed: message.speed });
          if (room.state.winner) return;
          scheduleBotMatchTurn(room);
          return;
        }

        // Join room
        if (message.type === 'join') {
          const code = String(message.code || '').trim().toUpperCase();
          const room = rooms.getRoom(code);
          if (!room) return send(socket, 'error', { message: 'Không tìm thấy phòng đấu với mã này.' });
          const returningPlayer = socket.user && ['p1', 'p2'].some(player =>
            room.state.players[player] === socket.user.username
          );
          if (!returningPlayer && !rooms.verifyRoomPassword(room, message.password)) {
            return send(socket, 'error', { message: 'Mật khẩu phòng không đúng.' });
          }
          const joined = rooms.joinRoom(code, socket, message.role);
          if (joined.error) {
            return send(socket, 'error', { message: joined.error });
          }
          socket.roomCode = joined.room.code;
          if (joined.player === 'p1' || joined.player === 'p2') {
            joined.room.state.players[joined.player] = socket.user.username;
          }
          if (joined.player === 'p1' || joined.player === 'p2') {
            setTurnDeadline(joined.room);
          }
          send(socket, 'joined', {
            code: joined.room.code,
            player: joined.player,
            state: joined.room.state,
            mode: joined.room.mode,
            host: joined.room.host || null,
            turnDeadline: joined.room.turnDeadline || null
          });
          broadcast(joined.room, 'room-update', {
            state: joined.room.state,
            event: 'player_joined',
            player: joined.player,
            host: joined.room.host || null,
            turnDeadline: joined.room.turnDeadline || null
          });
          broadcastRooms();
          return;
        }

        // Move piece
        if (message.type === 'move') {
          const room = rooms.getRoom(socket.roomCode);
          const player = room?.sockets.get(socket);
          if (!room || !player) {
            return send(socket, 'error', { message: 'Bạn chưa ở trong phòng đấu.' });
          }
          if (player === 'spectator') {
            return send(socket, 'error', { message: 'Khán giả không thể thực hiện nước đi.' });
          }
          if (room.turnDeadline && Date.now() > room.turnDeadline) {
            room.state.winner = room.state.turn === 'p1' ? 'p2' : 'p1';
            room.state.winReason = 'Đối thủ hết thời gian lượt đi.';
            room.state.turn = room.state.winner;
            broadcastState(room, { result: 'timeout' }, null, null, null);
            settleOnlineRating(room);
            queueRoomMatchResult(room);
            return;
          }

          const outcome = applyMove(
            room.state,
            player,
            message.from || message.action?.from,
            message.to || message.action?.to
          );
          if (!outcome.ok) {
            return send(socket, 'error', { message: outcome.reason });
          }

          const from = message.from || message.action?.from;
          const to = message.to || message.action?.to;
          setTurnDeadline(room);
          broadcastState(room, outcome, from, to, player);
          if (room.state.winner) {
            settleOnlineRating(room);
            queueRoomMatchResult(room);
          }
          requestBotTurn(room);
          return;
        }

        // Rematch / Restart game in current room
        if (message.type === 'rematch') {
          const room = rooms.getRoom(socket.roomCode);
          const player = room?.sockets.get(socket);
          if (!room || !player) return;

          rooms.resetRoom(room.code, message.mode);
          room.ratingUpdated = false;
          setTurnDeadline(room);
          if (room.bot) {
            room.state.players.p2 = 'p2';
          }
          if (room.botMatch) {
            clearTimeout(room.botMatch.timer);
            room.botMatch.timer = null;
            room.botMatch.initialState = JSON.parse(JSON.stringify(room.state));
            room.botMatch.replaySaved = false;
            room.state.players = { p1: 'bot-p1', p2: 'bot-p2' };
            requestBotMatchTurn(room);
          }
          broadcast(room, 'rematch', {
            state: room.state,
            by: player,
            message: `${player === 'p1' ? 'Đội Đỏ' : 'Đội Xanh'} đã khởi động lại ván đấu!`,
            host: room.host || null,
            turnDeadline: room.turnDeadline || null
          });
          return;
        }

        // In-game quick chat / emote
        if (message.type === 'chat') {
          const room = rooms.getRoom(socket.roomCode);
          const player = room?.sockets.get(socket);
          if (!room || !player) return;

          const text = String(message.text || '').trim().slice(0, 100);
          if (text) {
            broadcast(room, 'chat', {
              sender: player,
              text,
              time: Date.now()
            });
          }
        }
      } catch (error) {
        console.error('WebSocket message processing failed:', error.message);
        send(socket, 'error', { message: 'Không thể xử lý yêu cầu. Vui lòng thử lại.' });
      } finally {
        if (roomLock) {
          try {
            const room = rooms.getRoom(lockCode);
            if (room) await roomStateStore.save(room);
          } catch (error) {
            console.error(`Could not persist locked room ${lockCode}:`, error.message);
            socket.close(1011, 'Room state persistence failed');
          } finally {
            try {
              await roomLock();
            } catch (error) {
              console.error(`Could not release room lock ${lockCode}:`, error.message);
              socket.close(1011, 'Room lock release failed');
            }
          }
        }
      }
    })();
  });

  socket.on('close', () => {
    void (async () => {
      let releaseLock;
      try {
        if (roomStateStore && socket.roomCode) {
          try {
            releaseLock = await roomStateStore.lock(socket.roomCode);
            await loadRoomState(socket.roomCode);
          } catch (error) {
            console.error(`Could not lock room ${socket.roomCode} during disconnect:`, error.message);
          }
        }
        const queued = matchmakingQueue.findIndex(item => item.socket === socket);
        if (queued >= 0) matchmakingQueue.splice(queued, 1);
        if (roomStateStore) {
          try {
            await roomStateStore.removeMatchmakingPlayer(socket.id);
          } catch (error) {
            console.error('Could not remove disconnected player from matchmaking:', error.message);
          }
        }
        const result = rooms.remove(socket);
        if (result?.room && ['p1', 'p2'].includes(result.disconnectedRole)) {
          setTurnDeadline(result.room);
        }
        if (result?.room && rooms.getRoom(result.code) === result.room &&
            !hasConnectedPlayer(result.room)) {
          clearTimeout(result.room.cleanupTimer);
          result.room.cleanupTimer = setTimeout(() => {
            const room = rooms.getRoom(result.code);
            if (!room) return;
            if (hasConnectedPlayer(room)) {
              room.cleanupTimer = null;
              return;
            }
            for (const roomSocket of room.sockets.keys()) {
              roomSocket.roomCode = null;
              send(roomSocket, 'room-closed', { code: result.code });
            }
            if (rooms.deleteRoom(result.code, { force: true })) {
              if (roomStateStore) {
                roomStateStore.deleteRoom(result.code).catch(error => {
                  console.error(`Could not delete persisted room ${result.code}:`, error.message);
                });
              }
              broadcastRooms();
            }
          }, 60_000);
          result.room.cleanupTimer.unref();
        }
        if (result?.room) {
          if (releaseLock) await roomStateStore.save(result.room);
          else saveRoomState(result.room);
          broadcast(result.room, 'room-update', {
            state: result.room.state,
            event: 'player_left',
            disconnectedRole: result.disconnectedRole,
            host: result.room.host || null,
            turnDeadline: result.room.turnDeadline || null,
            message: `${result.disconnectedRole === 'p1' ? 'Đội Đỏ (P1)' : 'Đội Xanh (P2)'} đã thoát phòng.`
          });
        }
        broadcastRooms();
      } catch (error) {
        console.error('Could not process WebSocket disconnect:', error.message);
      } finally {
        if (releaseLock) {
          try {
            await releaseLock();
          } catch (error) {
            console.error(`Could not release disconnect lock for room ${socket.roomCode}:`, error.message);
          }
        }
      }
    })();
  });
});

const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.readyState !== 1) continue;
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.pingSentAt = Date.now();
    socket.ping();
  }
}, 30_000);
heartbeatTimer.unref();

const port = process.env.PORT || 3000;
async function startServer() {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (Boolean(adminUsername) !== Boolean(adminPassword)) {
    throw new Error('Phải cấu hình đồng thời ADMIN_USERNAME và ADMIN_PASSWORD để tạo tài khoản Admin.');
  }
  if (adminUsername && adminPassword) {
    const result = auth.provisionAdminAccount(adminUsername, adminPassword);
    if (result.error) throw new Error(result.error);
    console.info(`Admin account ready: ${result.user.username}`);
  } else {
    console.warn('Admin account is not configured; set ADMIN_USERNAME and ADMIN_PASSWORD.');
  }
  if (roomStateStore) {
    await roomStateStore.connect();
    const snapshots = await roomStateStore.loadRooms();
    let restoredRooms = 0;
    for (const snapshot of snapshots) {
      if (rooms.restoreRoom(snapshot, { assumeDisconnected: true })) restoredRooms++;
    }
    console.info(`Restored ${restoredRooms} room(s) from Redis.`);
  } else {
    console.warn('Room persistence is disabled; set ROOM_STATE_REDIS_URL to enable recovery and shared room state.');
  }
  server.listen(port, () => {
    console.log(`OTT V2 Server is running at http://localhost:${port}`);
    console.log(`Multiplayer available at http://localhost:${port}/playfull.html`);
    tournaments.resume();
    matchResultSheets.startWorker();
  });
}

startServer().catch(error => {
  console.error('Could not start the game server:', error.message);
  auth.close();
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forcedExit = setTimeout(() => process.exit(1), 10000);
  forcedExit.unref();
  clearInterval(heartbeatTimer);
  clearInterval(requestWindowCleanup);
  wss.clients.forEach(socket => socket.close(1001, 'Server shutting down'));
  server.close(async () => {
    await matchResultSheets.stopWorker();
    if (roomStateStore) await roomStateStore.close();
    auth.close();
    clearTimeout(forcedExit);
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
