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

const app = express();
app.use(express.json({ limit: '256kb' }));
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
  return auth.getSession(parseCookies(req.headers.cookie).ott_session);
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ott_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ott_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
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
  sha256 ||= crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  return { id: botId, name, script, sha256, untrusted };
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
  const user = getRequestUser(req);
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
  res.status(201).json({ tournament: communityTournaments.create({ name: req.body?.name, mode, maxTurns }) });
});

app.post('/api/community-tournaments/:id/register', (req, res) => {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ error: 'Bạn cần đăng nhập để đăng ký bot.' });
  const filename = String(req.body?.filename || '');
  const source = req.body?.source;
  const name = String(req.body?.name || filename.replace(/\.py$/i, '')).trim().slice(0, 60) || 'Community Bot';
  if (!/^[a-zA-Z0-9_-]+\.py$/.test(filename)) {
    return res.status(400).json({ error: 'Tên file bot không hợp lệ.' });
  }
  if (typeof source !== 'string' || !source.trim()) return res.status(400).json({ error: 'File bot không được để trống.' });
  if (Buffer.byteLength(source, 'utf8') > 256 * 1024) return res.status(413).json({ error: 'File bot tối đa 256 KB.' });
  const botId = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  fs.writeFileSync(path.join(SUBMISSION_DIR, `${botId}.py`), source, { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(path.join(SUBMISSION_DIR, `${botId}.json`), `${JSON.stringify({
    id: botId, name, originalFilename: filename, sha256, ownerId: user.id, ownerName: user.username,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const result = communityTournaments.register(req.params.id, { userId: user.id, username: user.username, botId: `submission:${botId}`, botName: name });
  if (result.error) {
    fs.rmSync(path.join(SUBMISSION_DIR, `${botId}.py`), { force: true });
    fs.rmSync(path.join(SUBMISSION_DIR, `${botId}.json`), { force: true });
    return res.status(400).json({ error: result.error });
  }
  res.status(201).json({ tournament: result.event });
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
  setSessionCookie(res, auth.createSession(result.user));
  res.status(201).json({ user: result.user });
});

app.post('/api/auth/login', (req, res) => {
  const user = auth.authenticate(String(req.body?.username || ''), req.body?.password);
  if (!user) return res.status(401).json({ error: 'Tên tài khoản hoặc mật khẩu không đúng.' });
  setSessionCookie(res, auth.createSession(user));
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(parseCookies(req.headers.cookie).ott_session);
  clearSessionCookie(res);
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
  const filename = String(req.body?.filename || '');
  const source = req.body?.source;
  if (!/^[a-zA-Z0-9_-]+\.py$/.test(filename)) {
    return res.status(400).json({ error: 'Tên bot phải kết thúc bằng .py và chỉ chứa chữ, số, _, -.' });
  }
  if (typeof source !== 'string' || !source.trim()) {
    return res.status(400).json({ error: 'File bot không được để trống.' });
  }
  if (Buffer.byteLength(source, 'utf8') > 256 * 1024) {
    return res.status(413).json({ error: 'File bot tối đa 256 KB.' });
  }
  const id = crypto.randomUUID();
  const sha256 = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  const safeName = String(req.body?.name || filename.replace(/\.py$/i, '')).trim().slice(0, 60) || 'Python Bot';
  const metadata = { id, name: safeName, originalFilename: filename, sha256, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(SUBMISSION_DIR, `${id}.py`), source, { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(path.join(SUBMISSION_DIR, `${id}.json`), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  res.status(201).json({ bot: { id: `submission:${id}`, name: safeName, sha256 } });
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
    turnDeadline: room.turnDeadline || null
  });
  broadcast(room, 'room-update', {
    state: room.state,
    event: 'player_joined',
    player: joined.player,
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
            ['join', 'move', 'rematch', 'chat'].includes(message.type)) {
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
            send(existing.socket, 'joined', { code: room.code, player: first.player, state: room.state, mode: room.mode });
            send(socket, 'joined', { code: room.code, player: second.player, state: room.state, mode: room.mode });
            saveRoomState(room);
            setTurnDeadline(room);
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
          setTurnDeadline(joined.room);
          send(socket, 'joined', {
            code: joined.room.code,
            player: joined.player,
            state: joined.room.state,
            mode: joined.room.mode,
            turnDeadline: joined.room.turnDeadline || null
          });
          broadcast(joined.room, 'room-update', {
            state: joined.room.state,
            event: 'player_joined',
            player: joined.player,
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
          broadcastState(room, outcome, from, to, player);
          setTurnDeadline(room);
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
            message: `${player === 'p1' ? 'Đội Đỏ' : 'Đội Xanh'} đã khởi động lại ván đấu!`
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
        if (result?.room && ['p1', 'p2'].includes(result.disconnectedRole) &&
            result.room.state.turn === result.disconnectedRole) {
          clearTimeout(result.room.turnTimer);
          result.room.turnTimer = null;
          result.room.turnDeadline = null;
        }
        if (result?.empty && result.room) {
          result.room.cleanupTimer = setTimeout(() => {
            rooms.deleteRoom(result.code);
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
