const path = require('path');
const TournamentManager = require('./tournamentManager');
const { runMatch } = require('./matchRunner');

const projectRoot = path.join(__dirname, '..');
const mode = process.argv[2] || 'army';
const maxTurns = Number(process.argv[3] || 300);
const botIds = process.argv.slice(4);
const knownBots = {
  random: { id: 'random', name: 'Random Bot', script: 'bots/random_bot.py' },
  minimax: { id: 'minimax', name: 'Minimax Bot', script: 'bots/minimax_bot.py' },
  guardian: { id: 'guardian', name: 'Guardian Bot', script: 'bots/guardian_bot.py' }
};

if (!['classic', 'tactical', 'army'].includes(mode)) throw new Error('Mode must be classic, tactical, or army.');
if (!Number.isInteger(maxTurns) || maxTurns < 20 || maxTurns > 2000) throw new Error('Turn limit must be between 20 and 2000.');
const selectedIds = botIds.length ? botIds : ['random', 'minimax'];
const manager = new TournamentManager(path.join(projectRoot, 'matches', 'tournaments'), {
  resolveBot: id => {
    const bot = knownBots[id];
    return bot && { ...bot, script: path.join(projectRoot, bot.script), sha256: null };
  },
  runMatch
});
const tournament = manager.create({
  name: `CLI ${mode} bot tournament`,
  botIds: selectedIds,
  mode,
  maxTurns
});

console.log(`Tournament ${tournament.id}: ${tournament.matches.length} matches`);
const poll = setInterval(() => {
  const current = manager.read(tournament.id);
  if (!current || current.status === 'failed') {
    clearInterval(poll);
    console.error(current?.error || 'Tournament failed.');
    process.exitCode = 1;
    return;
  }
  const complete = current.matches.filter(match => match.status === 'completed').length;
  process.stdout.write(`\r${complete}/${current.matches.length} matches`);
  if (current.status === 'completed') {
    clearInterval(poll);
    process.stdout.write('\n');
    console.log(JSON.stringify(manager.standings(current), null, 2));
  }
}, 1000);
