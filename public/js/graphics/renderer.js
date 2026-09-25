class BoardRenderer {
  constructor(element) {
    this.element = element;
    this.cells = []; // 9x9 matrix of DOM elements
  }

  render(state) {
    this.element.innerHTML = '';
    this.cells = Array.from({ length: 9 }, () => Array(9).fill(null));

    state.board.forEach((row, rowIndex) => {
      row.forEach((piece, colIndex) => {
        const cell = document.createElement('button');
        cell.className = 'board-cell';
        cell.dataset.row = rowIndex;
        cell.dataset.col = colIndex;
        cell.type = 'button';
        cell.setAttribute('aria-label', `Ô ${window.GameRules.coordToNotation(rowIndex, colIndex)}`);

        // Check alternate pattern
        if ((rowIndex + colIndex) % 2 === 1) {
          cell.classList.add('cell-dark');
        } else {
          cell.classList.add('cell-light');
        }

        // Base cell highlights
        if (rowIndex === 0 && colIndex === 0) {
          cell.classList.add('base-cell', 'base-a1');
          const baseBadge = document.createElement('span');
          baseBadge.className = 'base-badge base-badge-p1';
          baseBadge.textContent = 'A1';
          cell.appendChild(baseBadge);
        } else if (rowIndex === 8 && colIndex === 8) {
          cell.classList.add('base-cell', 'base-i9');
          const baseBadge = document.createElement('span');
          baseBadge.className = 'base-badge base-badge-p2';
          baseBadge.textContent = 'I9';
          cell.appendChild(baseBadge);
        }

        // Piece token
        if (piece) {
          const pieceWrap = document.createElement('div');
          pieceWrap.className = `piece piece-${piece.player} piece-${piece.type}`;
          pieceWrap.draggable = true;
          pieceWrap.dataset.row = rowIndex;
          pieceWrap.dataset.col = colIndex;
          pieceWrap.title = `${piece.player === 'p1' ? 'Đội Đỏ' : 'Đội Xanh'} - ${window.OTT_CONFIG.fullLabels[piece.type]}`;

          const img = document.createElement('img');
          const customImage = piece.player === 'p1' && piece.type === 'rock'
            ? 'bd.png'
            : piece.player === 'p2' && piece.type === 'rock'
              ? 'bx.png'
              : piece.player === 'p1' && piece.type === 'scissors'
                ? 'kd.png'
                : piece.player === 'p2' && piece.type === 'scissors'
                  ? 'kx.png'
                : piece.player === 'p1' && piece.type === 'paper'
                  ? 'ld.png'
                : piece.player === 'p2' && piece.type === 'paper'
                  ? 'lx.png'
                : null;
          img.src = customImage
            ? `/assets/pieces/${customImage}`
            : `/assets/pieces/rps-${piece.type}.svg`;
          img.alt = piece.type;
          img.draggable = false;
          pieceWrap.appendChild(img);

          // Type badge
          const typeBadge = document.createElement('span');
          typeBadge.className = 'piece-badge';
          typeBadge.textContent = window.OTT_CONFIG.icons[piece.type] || '';
          pieceWrap.appendChild(typeBadge);

          cell.appendChild(pieceWrap);
        }

        this.element.appendChild(cell);
        this.cells[rowIndex][colIndex] = cell;
      });
    });
  }

  getCell(row, col) {
    if (this.cells[row] && this.cells[row][col]) {
      return this.cells[row][col];
    }
    return this.element.querySelector(`[data-row="${row}"][data-col="${col}"]`);
  }

  clearHighlights() {
    this.element.querySelectorAll('.board-cell').forEach(c => {
      c.classList.remove(
        'selected-cell',
        'hint-move',
        'hint-capture',
        'hint-blocked',
        'hint-defeat'
      );
      const hint = c.querySelector('.move-hint');
      if (hint) hint.remove();
    });
  }

  highlightSelection(pos) {
    this.clearHighlights();
    const cell = this.getCell(pos.row, pos.col);
    if (cell) {
      cell.classList.add('selected-cell');
    }
  }

  highlightMoves(moves) {
    moves.forEach(m => {
      const cell = this.getCell(m.to.row, m.to.col);
      if (!cell) return;

      const hint = document.createElement('div');
      hint.className = `move-hint hint-type-${m.type}`;

      if (m.type === 'move') {
        cell.classList.add('hint-move');
        hint.innerHTML = '<span class="hint-dot"></span>';
        hint.title = `Đi tới ${m.notation}`;
      } else if (m.type === 'capture') {
        cell.classList.add('hint-capture');
        hint.innerHTML = '<span class="hint-sword">⚔️</span><span class="hint-ring"></span>';
        hint.title = m.reason;
      } else if (m.type === 'blocked') {
        cell.classList.add('hint-blocked');
        hint.innerHTML = '<span class="hint-shield">🛡️</span>';
        hint.title = 'Bị chặn (Hai quân cùng loại)';
      } else if (m.type === 'defeat') {
        cell.classList.add('hint-defeat');
        hint.innerHTML = '<span class="hint-danger">⚠️</span>';
        hint.title = m.reason;
      }

      cell.appendChild(hint);
    });
  }

  highlightLastMove(from, to) {
    this.element.querySelectorAll('.last-move-cell').forEach(c => c.classList.remove('last-move-cell'));
    if (from) {
      const fromCell = this.getCell(from.row, from.col);
      if (fromCell) fromCell.classList.add('last-move-cell');
    }
    if (to) {
      const toCell = this.getCell(to.row, to.col);
      if (toCell) toCell.classList.add('last-move-cell');
    }
  }
}

window.BoardRenderer = BoardRenderer;
