const path = require('path');
const BotProcess = require('./botProcess');
const { applyMove, createBotSnapshot, createInitialState } = require('./gameState');
const { createReplay, saveReplay } = require('./replay');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function runMatch(options) {
  const {
    mode = 'army', maxTurns = 500, botP1, botP2,
    replayPath, matchId = 'bot-match', timeoutMs = 10000,
    matchTimeoutMs = Number(process.env.BOT_MATCH_TIMEOUT_MS || 30 * 60 * 1000)
  } = options;
  if (!botP1?.script || !botP2?.script) throw new Error('Both bots need script paths.');
  if (!Number.isFinite(matchTimeoutMs) || matchTimeoutMs <= 0) {
    throw new Error('Match timeout must be a positive number of milliseconds.');
  }

  const state = createInitialState(mode);
  state.players = { p1: botP1.name || botP1.id || 'Bot P1', p2: botP2.name || botP2.id || 'Bot P2' };
  const initialState = clone(state);
  const bots = {};
  const sides = { p1: botP1, p2: botP2 };
  let replayFile = null;
  let matchTimedOut = false;
  const matchTimer = setTimeout(() => {
    matchTimedOut = true;
    bots.p1?.stop();
    bots.p2?.stop();
  }, matchTimeoutMs);

  try {
    for (const player of ['p1', 'p2']) {
      bots[player] = new BotProcess({
        cwd: options.cwd || path.join(__dirname, '..'),
        script: sides[player].script,
        sandboxed: sides[player].untrusted,
        timeoutMs,
        onError: error => options.onBotError?.(player, error)
      });
      bots[player].start();
    }

    while (!state.winner && state.history.length < maxTurns) {
      const player = state.turn;
      let response;
      try {
        response = await bots[player].request({
          protocol_version: 1,
          type: 'your_turn',
          match_id: matchId,
          player,
          turn: state.history.length + 1,
          ruleset: `${mode}-v1`,
          state: createBotSnapshot(state),
          time_limit_ms: timeoutMs
        });
      } catch (error) {
        if (!matchTimedOut) throw error;
        break;
      }
      const action = response?.action;
      const outcome = action?.type === 'move'
        ? applyMove(state, player, action.from, action.to)
        : { ok: false, reason: response?.message || 'Bot did not return a move.' };

      if (!outcome.ok) {
        state.winner = player === 'p1' ? 'p2' : 'p1';
        state.winReason = `${sides[player].name || player} forfeited: ${outcome.reason}`;
        state.turn = state.winner;
        break;
      }
    }

    if (!state.winner) {
      state.winReason = matchTimedOut
        ? `Draw: match exceeded ${matchTimeoutMs} ms.`
        : `Draw: reached ${maxTurns} turns.`;
    }

    const result = {
      mode,
      turns: state.history.length,
      winner: state.winner,
      reason: state.winReason,
      draw: !state.winner
    };
    const replay = createReplay(mode, initialState, state.history, result);
    replay.players = { p1: botP1.name, p2: botP2.name };
    replay.bot_ids = { p1: botP1.id, p2: botP2.id };
    if (replayPath) replayFile = saveReplay(replay, replayPath);
    return { ...result, replayFile, state };
  } finally {
    clearTimeout(matchTimer);
    bots.p1?.stop();
    bots.p2?.stop();
  }
}

module.exports = { runMatch };
