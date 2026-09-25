window.GameRules = {
  boardSize: 9,
  directions: [
    { row: -1, col: -1, name: 'Tây Bắc' },
    { row: -1, col: 0,  name: 'Bắc' },
    { row: -1, col: 1,  name: 'Đông Bắc' },
    { row: 0,  col: -1, name: 'Tây' },
    { row: 0,  col: 1,  name: 'Đông' },
    { row: 1,  col: -1, name: 'Tây Nam' },
    { row: 1,  col: 0,  name: 'Nam' },
    { row: 1,  col: 1,  name: 'Đông Nam' }
  ],

  beats: {
    rock: 'scissors',
    scissors: 'paper',
    paper: 'rock'
  },

  inBounds(row, col) {
    return row >= 0 && row < this.boardSize && col >= 0 && col < this.boardSize;
  },

  canStep(from, to) {
    if (!from || !to) return false;
    if (!this.inBounds(from.row, from.col) || !this.inBounds(to.row, to.col)) return false;
    const dr = Math.abs(to.row - from.row);
    const dc = Math.abs(to.col - from.col);
    return Math.max(dr, dc) === 1;
  },

  coordToNotation(row, col) {
    const colLetter = String.fromCharCode(65 + col);
    const rowNum = row + 1;
    return `${colLetter}${rowNum}`;
  },

  classifyMove(board, player, from, to) {
    if (!this.canStep(from, to)) {
      return { valid: false, type: 'invalid', reason: 'Chỉ được di chuyển 1 ô theo 8 hướng (như quân Vua).' };
    }

    const piece = board[from.row]?.[from.col];
    if (!piece || piece.player !== player) {
      return { valid: false, type: 'invalid', reason: 'Không phải quân của bạn.' };
    }

    const targetPiece = board[to.row]?.[to.col];
    if (!targetPiece) {
      return { valid: true, type: 'move', reason: 'Nước đi hợp lệ tới ô trống.' };
    }

    if (targetPiece.player === player) {
      return { valid: false, type: 'friendly', reason: 'Ô đã có quân cùng phe chặn lối.' };
    }

    // Luật hai quân cùng loại: không thể ăn nhau mà chỉ đứng chặn đường nhau
    if (targetPiece.type === piece.type) {
      return { valid: false, type: 'blocked', reason: 'Hai quân cùng loại không thể ăn nhau (bị chặn đường).' };
    }

    // Tấn công quân yếu hơn: Ăn quân
    if (this.beats[piece.type] === targetPiece.type) {
      return { valid: true, type: 'capture', reason: `Ăn được quân ${window.OTT_CONFIG.labels[targetPiece.type]} của đối phương!` };
    }

    // Tấn công quân mạnh hơn: Bị chặn
    return { valid: true, type: 'blocked', reason: `Quân này yếu hơn quân ${window.OTT_CONFIG.labels[targetPiece.type]}!` };
  },

  getPossibleMoves(board, row, col, player) {
    const moves = [];
    const piece = board[row]?.[col];
    if (!piece || piece.player !== player) return moves;

    for (const dir of this.directions) {
      const tr = row + dir.row;
      const tc = col + dir.col;
      if (!this.inBounds(tr, tc)) continue;

      const classification = this.classifyMove(board, player, { row, col }, { row: tr, col: tc });
      moves.push({
        from: { row, col },
        to: { row: tr, col: tc },
        notation: this.coordToNotation(tr, tc),
        ...classification
      });
    }

    return moves;
  },

  countPieces(board) {
    const counts = {
      p1: { rock: 0, paper: 0, scissors: 0, total: 0 },
      p2: { rock: 0, paper: 0, scissors: 0, total: 0 }
    };
    for (let r = 0; r < this.boardSize; r++) {
      for (let c = 0; c < this.boardSize; c++) {
        const p = board[r]?.[c];
        if (p && counts[p.player]) {
          counts[p.player][p.type]++;
          counts[p.player].total++;
        }
      }
    }
    return counts;
  }
};
