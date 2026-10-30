const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildTournamentSheets,
  bracketRounds,
  bracketLayoutRows,
  upperRoundLabel,
  lowerRoundLabel,
  matchScore
} = require('../src/tournamentSheetReport');

function match(id, round, stage, p1, p2, result, status = 'completed') {
  return {
    id,
    round,
    stage,
    p1BotId: p1?.id || null,
    p2BotId: p2?.id || null,
    p1BotName: p1?.name || 'Bye',
    p2BotName: p2?.name || 'Bye',
    status,
    result
  };
}

function win(winner, turns = 12) {
  return {
    winnerBotId: winner.id,
    winnerBotName: winner.name,
    turns,
    draw: false,
    reason: 'Won'
  };
}

const alpha = { id: 'bot-a', name: 'Alpha' };
const beta = { id: 'bot-b', name: 'Beta' };
const gamma = { id: 'bot-c', name: 'Gamma' };
const delta = { id: 'bot-d', name: 'Delta' };

function sampleTournament() {
  return {
    id: 'a3be77cd-098b-42f3-a4a2-68e58bb649b2',
    name: 'Giải thử nghiệm',
    format: 'swiss-playoff',
    mode: 'classic',
    totalRounds: 2,
    currentRound: 7,
    status: 'completed',
    completedMatches: 10,
    champion: 'Alpha',
    updatedAt: '2026-10-30T10:00:00.000Z',
    bots: [alpha, beta, gamma, delta],
    standings: [
      { botId: 'bot-a', name: 'Alpha', played: 4, wins: 4, draws: 0, losses: 0, byes: 0, points: 4, buchholz: 3, headToHeadPoints: 1 },
      { botId: 'bot-d', name: 'Delta', played: 4, wins: 2, draws: 1, losses: 1, byes: 0, points: 2.5, buchholz: 4, headToHeadPoints: 0 },
      { botId: 'bot-c', name: 'Gamma', played: 4, wins: 2, draws: 0, losses: 2, byes: 0, points: 2, buchholz: 5, headToHeadPoints: 0 },
      { botId: 'bot-b', name: 'Beta', played: 4, wins: 0, draws: 1, losses: 3, byes: 0, points: 0.5, buchholz: 4, headToHeadPoints: 0 }
    ],
    matches: [
      match('t-001', 1, 'swiss', alpha, beta, win(alpha)),
      match('t-002', 1, 'swiss', gamma, delta, win(gamma, 9)),
      match('t-003', 2, 'swiss', alpha, gamma, win(alpha, 20)),
      match('t-004', 2, 'swiss', beta, delta, {
        winnerBotId: null, winnerBotName: null, turns: 30, draw: true, reason: 'Draw'
      }),
      match('t-005', 3, 'winners', alpha, delta, win(alpha)),
      match('t-006', 3, 'winners', gamma, beta, win(gamma)),
      match('t-007', 4, 'winners', alpha, gamma, win(alpha)),
      match('t-008', 5, 'losers', delta, beta, win(delta)),
      match('t-009', 6, 'losers', delta, gamma, win(delta)),
      match('t-010', 7, 'grand-final', alpha, delta, win(alpha))
    ]
  };
}

function overlaps(a, b) {
  return a.startRow < b.endRow && b.startRow < a.endRow &&
    a.startColumn < b.endColumn && b.startColumn < a.endColumn;
}

test('builds overview, Swiss round tabs, and a playoff bracket tab', () => {
  const specs = buildTournamentSheets(sampleTournament());
  assert.deepEqual(specs.map(spec => spec.title), ['Tổng quan', 'Vòng 1', 'Vòng 2', 'Playoff']);
  assert.deepEqual(specs.map(spec => spec.index), [0, 1, 2, 3]);

  const overview = specs[0];
  assert.equal(overview.rows[0][0], 'Giải thử nghiệm');
  assert.ok(overview.rows.some(row => row[0] === 'Bảng xếp hạng'));
  assert.ok(overview.rows.some(row => row[1] === 'Alpha' && row[7] === 4));
  assert.ok(overview.rows.some(row => row[0] === 'Các trang' && String(row[1]).includes('Vòng 2')));

  const roundOne = specs[1];
  assert.equal(roundOne.rows[0][0], 'Giải thử nghiệm · Vòng 1');
  assert.ok(roundOne.rows.some(row => row[1] === 'Alpha' && row[3] === 'Beta' && row[4] === 'Alpha thắng'));
  assert.equal(matchScore(sampleTournament().matches[1]), '1 – 0');
  assert.equal(matchScore(sampleTournament().matches[3]), '½ – ½');

  const playoff = specs[3];
  const flat = playoff.rows.flat();
  assert.ok(flat.includes('Nhánh thắng'));
  assert.ok(flat.includes('Nhánh thua'));
  assert.ok(flat.includes('Chung kết tổng'));
  assert.ok(flat.includes('🏆 Alpha'));
  assert.ok(flat.includes('Chung kết nhánh thắng'));
  assert.ok(flat.includes('Chung kết nhánh thua'));

  for (let a = 0; a < playoff.merges.length; a++) {
    for (let b = a + 1; b < playoff.merges.length; b++) {
      assert.equal(overlaps(playoff.merges[a], playoff.merges[b]), false,
        `merge ranges overlap: ${JSON.stringify(playoff.merges[a])} and ${JSON.stringify(playoff.merges[b])}`);
    }
  }
  const grandFinalHeader = playoff.styles.find(item =>
    item.format.textFormat?.bold && item.range.startColumn >= 6);
  assert.ok(grandFinalHeader);
  assert.ok(playoff.columnCount >= 8);
});

test('lays out winners rounds at feeder midpoints and labels them like the site', () => {
  const tournament = sampleTournament();
  const winners = bracketRounds(tournament.matches, 'winners');
  const layout = bracketLayoutRows(winners);
  assert.equal(winners.length, 2);
  assert.deepEqual(layout[0].map(position => position.row), [0, 6]);
  assert.deepEqual(layout[1].map(position => position.row), [3]);
  assert.equal(upperRoundLabel(0, 8), 'Tứ kết');
  assert.equal(upperRoundLabel(1, 8), 'Bán kết');
  assert.equal(upperRoundLabel(2, 8), 'Chung kết nhánh thắng');
  assert.equal(lowerRoundLabel(0, 2), 'Vòng 1');
  assert.equal(lowerRoundLabel(1, 2), 'Chung kết nhánh thua');
});

test('shows a placeholder playoff tab before the bracket exists', () => {
  const tournament = sampleTournament();
  tournament.matches = tournament.matches.filter(item => item.stage === 'swiss');
  tournament.currentRound = 2;
  const specs = buildTournamentSheets(tournament);
  const playoff = specs.find(spec => spec.title === 'Playoff');
  assert.ok(playoff.rows.flat().includes('Chưa có trận playoff.'));
});
