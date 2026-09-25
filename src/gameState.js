const BOARD_SIZE = 9;
const TYPES = ['rock', 'paper', 'scissors'];
const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

function createInitialState() {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  board[0][0] = { player: 'p1', type: 'rock' };
  board[0][1] = { player: 'p1', type: 'paper' };
  board[1][0] = { player: 'p1', type: 'scissors' };
  board[8][8] = { player: 'p2', type: 'rock' };
  board[8][7] = { player: 'p2', type: 'paper' };
  board[7][8] = { player: 'p2', type: 'scissors' };
  return {
    board,
    turn: 'p1',
    winner: null,
    history: [],
    players: { p1: null, p2: null }
  };
}

function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function validateMove(state, player, from, to) {
  if (state.winner) return { ok: false, reason: 'Trận đấu đã kết thúc.' };
  if (state.turn !== player) return { ok: false, reason: 'Chưa đến lượt bạn.' };
  if (!from || !to || !inBounds(from.row, from.col) || !inBounds(to.row, to.col)) return { ok: false, reason: 'Tọa độ không hợp lệ.' };
  const piece = state.board[from.row][from.col];
  if (!piece || piece.player !== player) return { ok: false, reason: 'Đó không phải quân của bạn.' };
  if (state.board[to.row][to.col]?.player === player) return { ok: false, reason: 'Không thể đi vào quân cùng phe.' };
  const distance = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));
  if (distance !== 1) return { ok: false, reason: 'Chỉ được đi một ô theo 8 hướng.' };
  return { ok: true, piece };
}

function applyMove(state, player, from, to) {
  const validation = validateMove(state, player, from, to);
  if (!validation.ok) return validation;
  const attacker = validation.piece;
  const defender = state.board[to.row][to.col];
  let result = 'move';
  if (defender) {
    result = attacker.type === defender.type ? 'block' : beats[attacker.type] === defender.type ? 'capture' : 'defeat';
    if (result === 'defeat') {
      state.board[from.row][from.col] = null;
      state.turn = player === 'p1' ? 'p2' : 'p1';
      state.history.push({ player, from, to, result, type: attacker.type });
      return { ok: true, result, state };
    }
  }
  state.board[to.row][to.col] = attacker;
  state.board[from.row][from.col] = null;
  state.history.push({ player, from, to, result, type: attacker.type });
  if ((player === 'p1' && to.row === 8 && to.col === 8) || (player === 'p2' && to.row === 0 && to.col === 0)) state.winner = player;
  state.turn = player === 'p1' ? 'p2' : 'p1';
  return { ok: true, result, state };
}

module.exports = { BOARD_SIZE, TYPES, createInitialState, applyMove };
