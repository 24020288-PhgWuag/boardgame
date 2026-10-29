const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { applyMove, createInitialState } = require('./gameState');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createReplay(mode, initialState, moves, result) {
  return {
    replay_version: 1,
    created_at: new Date().toISOString(),
    ruleset: `${mode}-v1`,
    mode,
    initial_state: clone(initialState),
    moves: clone(moves),
    result: clone(result)
  };
}

function saveReplay(replay, filePath) {
  const resolvedPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const serialized = `${JSON.stringify(replay)}\n`;
  if (resolvedPath.endsWith('.gz')) fs.writeFileSync(resolvedPath, zlib.gzipSync(serialized));
  else fs.writeFileSync(resolvedPath, `${JSON.stringify(replay, null, 2)}\n`, 'utf8');
  return resolvedPath;
}

function loadReplay(filePath) {
  const resolvedPath = path.resolve(filePath);
  const content = resolvedPath.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(resolvedPath)).toString('utf8')
    : fs.readFileSync(resolvedPath, 'utf8');
  return JSON.parse(content);
}

function playReplay(replay) {
  if (replay.replay_version !== 1) {
    throw new Error(`Unsupported replay version: ${replay.replay_version}`);
  }

  const state = clone(replay.initial_state);
  for (const move of replay.moves) {
    const outcome = applyMove(state, move.player, move.from, move.to);
    if (!outcome.ok) {
      throw new Error(`Replay move ${state.history.length + 1} is invalid: ${outcome.reason}`);
    }
  }
  return state;
}

module.exports = {
  createReplay,
  saveReplay,
  loadReplay,
  playReplay
};
