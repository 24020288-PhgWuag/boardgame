const BOARD_SIZE = 9;
const TYPES = ['rock', 'paper', 'scissors'];
const TYPES_VI = { rock: 'Đấm (Búa)', paper: 'Lá (Bao)', scissors: 'Kéo' };
const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

function createInitialState(mode = 'classic') {
  const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));

  if (mode === 'tactical') {
    // 6 pieces each (2 of each type)
    board[0][0] = { player: 'p1', type: 'rock' };
    board[0][1] = { player: 'p1', type: 'paper' };
    board[0][2] = { player: 'p1', type: 'scissors' };
    board[1][0] = { player: 'p1', type: 'scissors' };
    board[1][1] = { player: 'p1', type: 'rock' };
    board[1][2] = { player: 'p1', type: 'paper' };

    board[8][8] = { player: 'p2', type: 'rock' };
    board[8][7] = { player: 'p2', type: 'paper' };
    board[8][6] = { player: 'p2', type: 'scissors' };
    board[7][8] = { player: 'p2', type: 'scissors' };
    board[7][7] = { player: 'p2', type: 'rock' };
    board[7][6] = { player: 'p2', type: 'paper' };
  } else if (mode === 'army') {
    // 9 pieces each (3 of each type)
    const types = ['rock', 'paper', 'scissors', 'paper', 'scissors', 'rock', 'scissors', 'rock', 'paper'];
    for (let c = 0; c < 9; c++) {
      board[0][c] = { player: 'p1', type: types[c] };
      board[8][c] = { player: 'p2', type: types[8 - c] };
    }
  } else {
    // Classic 3v3 pieces
    board[0][0] = { player: 'p1', type: 'rock' };
    board[0][1] = { player: 'p1', type: 'paper' };
    board[1][0] = { player: 'p1', type: 'scissors' };

    board[8][8] = { player: 'p2', type: 'rock' };
    board[8][7] = { player: 'p2', type: 'paper' };
    board[7][8] = { player: 'p2', type: 'scissors' };
  }

  const initialCounts = countPieces(board);

  return {
    board,
    turn: 'p1',
    winner: null,
    winReason: null,
    history: [],
    players: { p1: null, p2: null },
    mode,
    counts: initialCounts
  };
}

function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function countPieces(board) {
  const counts = {
    p1: { rock: 0, paper: 0, scissors: 0, total: 0 },
    p2: { rock: 0, paper: 0, scissors: 0, total: 0 }
  };
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const p = board[r][c];
      if (p && counts[p.player] && counts[p.player][p.type] !== undefined) {
        counts[p.player][p.type]++;
        counts[p.player].total++;
      }
    }
  }
  return counts;
}

function validateMove(state, player, from, to) {
  if (state.winner) return { ok: false, reason: 'Trận đấu đã kết thúc.' };
  if (state.turn !== player) return { ok: false, reason: 'Chưa đến lượt bạn.' };
  if (!from || !to || !inBounds(from.row, from.col) || !inBounds(to.row, to.col)) {
    return { ok: false, reason: 'Tọa độ không hợp lệ.' };
  }
  if (from.row === to.row && from.col === to.col) {
    return { ok: false, reason: 'Quân cờ phải di chuyển sang ô khác.' };
  }

  const piece = state.board[from.row][from.col];
  if (!piece || piece.player !== player) return { ok: false, reason: 'Đó không phải quân của bạn.' };

  const targetPiece = state.board[to.row][to.col];
  if (targetPiece) {
    if (targetPiece.player === player) {
      return { ok: false, reason: 'Không thể đi vào ô có quân cùng phe.' };
    }
    // Luật OTTv2: "hai quân cùng loại thì không thể ăn nhau mà chỉ đứng chặn đường nhau"
    if (targetPiece.type === piece.type) {
      return { ok: false, reason: 'Hai quân cùng loại không thể ăn nhau mà chỉ đứng chặn đường nhau.' };
    }
  }

  // Di chuyển 1 ô theo mọi hướng (8 hướng giống quân Vua cờ vua)
  const distance = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));
  if (distance !== 1) {
    return { ok: false, reason: 'Chỉ được di chuyển 1 ô theo 8 hướng (như quân Vua).' };
  }

  return { ok: true, piece, targetPiece };
}

function checkWinner(state, player, to) {
  // Điều kiện 1: Đưa quân vào ô căn cứ đối phương (P1 vào I9 [8,8], P2 vào A1 [0,0])
  if (player === 'p1' && to.row === 8 && to.col === 8) {
    return { winner: 'p1', winReason: 'Đội Đỏ (P1) đã đưa quân xâm nhập căn cứ I9 của đối phương!' };
  }
  if (player === 'p2' && to.row === 0 && to.col === 0) {
    return { winner: 'p2', winReason: 'Đội Xanh (P2) đã đưa quân xâm nhập căn cứ A1 của đối phương!' };
  }

  // Điều kiện 2: Ăn hết sạch hoàn toàn 1 loại quân của đối phương
  const counts = countPieces(state.board);
  state.counts = counts;

  const opponent = player === 'p1' ? 'p2' : 'p1';
  const playerLabel = player === 'p1' ? 'Đội Đỏ (P1)' : 'Đội Xanh (P2)';
  const opponentLabel = opponent === 'p1' ? 'Đội Đỏ (P1)' : 'Đội Xanh (P2)';

  // Kiểm tra đối phương có bị mất sạch hoàn toàn loại quân nào không
  const opponentWipedTypes = TYPES.filter(type => counts[opponent][type] === 0);
  const playerWipedTypes = TYPES.filter(type => counts[player][type] === 0);

  if (opponentWipedTypes.length > 0 && playerWipedTypes.length === 0) {
    const wipedNames = opponentWipedTypes.map(t => TYPES_VI[t]).join(', ');
    return {
      winner: player,
      winReason: `${playerLabel} đã ăn sạch hoàn toàn quân ${wipedNames} của ${opponentLabel}!`
    };
  }

  if (playerWipedTypes.length > 0 && opponentWipedTypes.length === 0) {
    const wipedNames = playerWipedTypes.map(t => TYPES_VI[t]).join(', ');
    return {
      winner: opponent,
      winReason: `${opponentLabel} đã ăn sạch hoàn toàn quân ${wipedNames} của ${playerLabel}!`
    };
  }

  if (opponentWipedTypes.length > 0 && playerWipedTypes.length > 0) {
    return {
      winner: player,
      winReason: `${playerLabel} đã hoàn thành điều kiện ăn sạch quân đối phương trước!`
    };
  }

  return null;
}

function applyMove(state, player, from, to) {
  const validation = validateMove(state, player, from, to);
  if (!validation.ok) return validation;

  const attacker = validation.piece;
  const defender = state.board[to.row][to.col];
  let result = 'move';
  let capturedPiece = null;

  if (defender) {
    // Defender can either be beaten by attacker, or beat attacker
    if (beats[attacker.type] === defender.type) {
      // Attacker wins! Captures defender
      result = 'capture';
      capturedPiece = { ...defender };
      state.board[to.row][to.col] = attacker;
      state.board[from.row][from.col] = null;
    } else {
      // Attacker attacked a stronger piece (e.g. Rock attacked Paper) -> Attacker is defeated!
      result = 'defeat';
      capturedPiece = { ...attacker };
      state.board[from.row][from.col] = null;
      // Defender stays at to.row, to.col
    }
  } else {
    // Normal move to empty cell
    result = 'move';
    state.board[to.row][to.col] = attacker;
    state.board[from.row][from.col] = null;
  }

  state.history.push({
    player,
    from,
    to,
    result,
    type: attacker.type,
    captured: capturedPiece?.type,
    time: Date.now()
  });

  // Kiểm tra điều kiện thắng
  const winCheck = checkWinner(state, player, to);
  if (winCheck) {
    state.winner = winCheck.winner;
    state.winReason = winCheck.winReason;
  } else {
    state.counts = countPieces(state.board);
  }

  // Đổi lượt
  state.turn = player === 'p1' ? 'p2' : 'p1';

  return {
    ok: true,
    result,
    capturedPiece,
    state
  };
}

module.exports = {
  BOARD_SIZE,
  TYPES,
  TYPES_VI,
  beats,
  createInitialState,
  validateMove,
  applyMove,
  countPieces
};
