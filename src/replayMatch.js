const path = require('path');
const { loadReplay, playReplay } = require('./replay');

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: npm run replay -- matches/<file>.json');
  process.exitCode = 1;
} else {
  try {
    const replay = loadReplay(filePath);
    const state = playReplay(replay);
    const expected = replay.result || {};
    const matchesResult = state.winner === (expected.winner || null)
      && state.history.length === replay.moves.length;

    console.log(`Replay: ${path.resolve(filePath)}`);
    console.log(`Mode: ${replay.mode}`);
    console.log(`Moves: ${state.history.length}`);
    console.log(`Winner: ${state.winner || 'draw'}`);
    console.log(`Reason: ${state.winReason || expected.reason || 'Draw'}`);
    console.log(`Validation: ${matchesResult ? 'OK' : 'RESULT MISMATCH'}`);

    if (!matchesResult) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Replay failed: ${error.message}`);
    process.exitCode = 1;
  }
}
