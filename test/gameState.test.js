const assert = require('node:assert/strict');
const test = require('node:test');
const { applyMove, createInitialState, validateMove } = require('../src/gameState');

function emptyState() {
  const state = createInitialState('classic');
  state.board = Array.from({ length: 9 }, () => Array(9).fill(null));
  state.turn = 'p1';
  return state;
}

test('validates ownership, bounds, adjacency, and occupied friendly cells', () => {
  const state = createInitialState('classic');
  assert.equal(validateMove(state, 'p1', { row: 0, col: 0 }, { row: 1, col: 1 }).ok, true);
  assert.equal(validateMove(state, 'p1', { row: 0, col: 0 }, { row: 2, col: 0 }).ok, false);
  assert.equal(validateMove(state, 'p2', { row: 0, col: 0 }, { row: 1, col: 1 }).ok, false);
  assert.equal(validateMove(state, 'p1', { row: 0, col: 0 }, { row: -1, col: 0 }).ok, false);
  assert.equal(validateMove(state, 'p1', { row: 0, col: 0 }, { row: 0, col: 1 }).ok, false);
  const sameTypeState = emptyState();
  sameTypeState.board[3][3] = { player: 'p1', type: 'rock' };
  sameTypeState.board[3][4] = { player: 'p2', type: 'rock' };
  assert.equal(validateMove(sameTypeState, 'p1', { row: 3, col: 3 }, { row: 3, col: 4 }).ok, false);
});

test('applies rock-paper-scissors capture and attacker defeat correctly', () => {
  const captureState = emptyState();
  captureState.board[3][3] = { player: 'p1', type: 'rock' };
  captureState.board[3][4] = { player: 'p2', type: 'scissors' };
  const capture = applyMove(captureState, 'p1', { row: 3, col: 3 }, { row: 3, col: 4 });
  assert.equal(capture.result, 'capture');
  assert.equal(captureState.board[3][4].player, 'p1');
  assert.equal(captureState.board[3][3], null);

  const defeatState = emptyState();
  defeatState.board[3][3] = { player: 'p1', type: 'rock' };
  defeatState.board[0][0] = { player: 'p1', type: 'paper' };
  defeatState.board[0][1] = { player: 'p1', type: 'scissors' };
  defeatState.board[4][3] = { player: 'p2', type: 'scissors' };
  defeatState.board[8][8] = { player: 'p2', type: 'rock' };
  defeatState.board[8][7] = { player: 'p2', type: 'paper' };
  defeatState.turn = 'p2';
  const defeat = applyMove(defeatState, 'p2', { row: 4, col: 3 }, { row: 3, col: 3 });
  assert.equal(defeat.result, 'defeat');
  assert.equal(defeatState.board[4][3], null);
  assert.equal(defeatState.board[3][3].player, 'p1');
  assert.equal(defeatState.winner, 'p1');
});

test('awards a win for reaching the opposing base', () => {
  const state = emptyState();
  state.board[7][7] = { player: 'p1', type: 'rock' };
  const result = applyMove(state, 'p1', { row: 7, col: 7 }, { row: 8, col: 8 });
  assert.equal(result.ok, true);
  assert.equal(state.winner, 'p1');
});

test('awards a win when the opponent loses its last piece of a type', () => {
  const state = emptyState();
  state.board[3][3] = { player: 'p1', type: 'rock' };
  state.board[0][0] = { player: 'p1', type: 'paper' };
  state.board[0][1] = { player: 'p1', type: 'scissors' };
  state.board[3][4] = { player: 'p2', type: 'scissors' };
  state.board[8][8] = { player: 'p2', type: 'rock' };
  state.board[8][7] = { player: 'p2', type: 'paper' };

  const result = applyMove(state, 'p1', { row: 3, col: 3 }, { row: 3, col: 4 });
  assert.equal(result.result, 'capture');
  assert.equal(state.winner, 'p1');
});

test('does not change game state after an invalid move', () => {
  const state = createInitialState('classic');
  const originalBoard = JSON.stringify(state.board);
  const result = applyMove(state, 'p1', { row: 0, col: 0 }, { row: 3, col: 3 });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(state.board), originalBoard);
  assert.equal(state.history.length, 0);
});
