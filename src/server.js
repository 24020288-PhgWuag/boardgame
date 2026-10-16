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

const app = express();
app.use(express.json({ limit: '256kb' }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new RoomManager();
const auth = new AuthStore(
  path.join(__dirname, '..', 'data', 'boardgame.sqlite'),
  path.join(__dirname, '..', 'data', 'users.json')
);
const requestWindows = new Map();
const matchmakingQueue = [];
const TURN_LIMIT_MS = 30 * 1000;
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
  res.setHeader('Set-Cookie', `ott_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'ott_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
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
  } else {
    script = getUploadedBot(botId);
    if (!script) return null;
    name = getBotDisplayName(botId);
  }
  if (!fs.existsSync(script)) return null;
  sha256 ||= crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  return { id: botId, name, script, sha256 };
}

const tournaments = new TournamentManager(TOURNAMENT_DIR, {
  resolveBot: getBotDefinition,
  runMatch
});

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

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: auth.listUsers() });
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

function broadcast(room, type, payload = {}) {
  if (!room || !room.sockets) return;
  for (const socket of room.sockets.keys()) {
    send(socket, type, payload);
  }
}

function broadcastRooms() {
  const payload = { rooms: rooms.getPublicRooms() };
  for (const socket of wss.clients) send(socket, 'rooms_list', payload);
}

function broadcastState(room, outcome, from, to, player) {
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
  if (!room || room.state.winner || room.bot || room.botMatch || room.sockets.size < 2) return;
  room.turnDeadline = Date.now() + TURN_LIMIT_MS;
  room.turnTimer = setTimeout(() => {
    if (!room.state.winner && room.turnDeadline <= Date.now()) {
      room.state.winner = room.state.turn === 'p1' ? 'p2' : 'p1';
      room.state.winReason = 'Đối thủ hết thời gian lượt đi.';
      room.state.turn = room.state.winner;
      broadcastState(room, { result: 'timeout' }, null, null, null);
      settleOnlineRating(room);
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
  requestWindows.set(key, recent);
  return true;
}

function forfeitBot(room, reason) {
  if (!room || room.state.winner) return;
  room.bot?.stop();
  room.state.winner = 'p1';
  room.state.winReason = `Bot đã bị xử thua: ${reason}`;
  room.state.turn = 'p1';
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

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(socket, 'error', { message: 'Gói tin không hợp lệ.' });
    }
    if (!rateLimitSocket(socket, message.type || 'unknown')) {
      return send(socket, 'error', { message: 'Bạn gửi yêu cầu quá nhanh. Hãy thử lại sau.' });
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
      broadcastRooms();
      setTurnDeadline(room);
      return;
    }

    if (message.type === 'create_bot_match') {
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
          onError: error => console.error(`Bot P1 error in room ${room.code}:`, error.message)
        }),
        p2: new BotProcess({
          cwd: path.join(__dirname, '..'),
          script: botP2Definition.script,
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
      if (!rooms.verifyRoomPassword(room, message.password)) {
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
      if (room.state.winner) settleOnlineRating(room);
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
  });

  socket.on('close', () => {
    const queued = matchmakingQueue.findIndex(item => item.socket === socket);
    if (queued >= 0) matchmakingQueue.splice(queued, 1);
    const result = rooms.remove(socket);
    if (result && !result.empty && result.room) {
      broadcast(result.room, 'room-update', {
        state: result.room.state,
        event: 'player_left',
        disconnectedRole: result.disconnectedRole,
        message: `${result.disconnectedRole === 'p1' ? 'Đội Đỏ (P1)' : 'Đội Xanh (P2)'} đã thoát phòng.`
      });
    }
    broadcastRooms();
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`OTT V2 Server is running at http://localhost:${port}`);
  console.log(`Multiplayer available at http://localhost:${port}/playfull.html`);
  tournaments.resume();
});
