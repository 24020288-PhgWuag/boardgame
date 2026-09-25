window.GameRules = {
  directions: [-1, 0, 1].flatMap(row => [-1, 0, 1].map(col => ({ row, col }))).filter(direction => direction.row || direction.col),
  canStep(from, to) { return Math.max(Math.abs(from.row - to.row), Math.abs(from.col - to.col)) === 1; },
  beats: { rock: 'scissors', scissors: 'paper', paper: 'rock' }
};
