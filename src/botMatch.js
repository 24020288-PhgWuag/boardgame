const path = require('path');
const { runMatch } = require('./matchRunner');

const mode = process.argv[2] || 'army';
const maxTurns = Number(process.argv[3] || 500);
const p1Script = process.argv[4] || process.env.BOT_P1_SCRIPT || 'bots/random_bot.py';
const p2Script = process.argv[5] || process.env.BOT_P2_SCRIPT || 'bots/random_bot.py';
const replayPath = process.argv[6] || process.env.REPLAY_FILE ||
  path.join('matches', `bot-match-${Date.now()}.json`);
const projectRoot = path.join(__dirname, '..');

async function playMatch() {
  const result = await runMatch({
    mode,
    maxTurns,
    matchId: 'headless-bot-match',
    cwd: projectRoot,
    botP1: { id: 'bot-p1', name: 'Bot P1', script: p1Script },
    botP2: { id: 'bot-p2', name: 'Bot P2', script: p2Script },
    replayPath: path.join(projectRoot, replayPath),
    onBotError: (player, error) => console.error(`${player} bot: ${error.message}`)
  });
  console.log(JSON.stringify({
    mode: result.mode,
    turns: result.turns,
    winner: result.winner,
    reason: result.reason,
    replay: result.replayFile
  }, null, 2));
}

playMatch().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
