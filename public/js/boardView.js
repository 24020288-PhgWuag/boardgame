class BoardView {
  constructor(renderer, onMove, soundManager, vfxManager) {
    this.renderer = renderer;
    this.onMove = onMove;
    this.sound = soundManager || new window.SoundManager();
    this.vfx = vfxManager || new window.VfxManager();
    this.selected = null;
    this.possibleMoves = [];
    this.state = null;
    this.player = null;
    this.draggedFrom = null;

    this.initEvents();
  }

  initEvents() {
    const el = this.renderer.element;

    // Click selection and moves
    el.addEventListener('click', (event) => this.handleClick(event));

    // Drag and Drop
    el.addEventListener('dragstart', (event) => this.handleDragStart(event));
    el.addEventListener('dragover', (event) => this.handleDragOver(event));
    el.addEventListener('dragleave', (event) => this.handleDragLeave(event));
    el.addEventListener('drop', (event) => this.handleDrop(event));
    el.addEventListener('dragend', () => this.handleDragEnd());
  }

  setState(state, player) {
    this.state = state;
    this.player = player;
    this.selected = null;
    this.possibleMoves = [];
    this.renderer.clearHighlights();

    // Show last move if available
    if (state.history && state.history.length > 0) {
      const last = state.history[state.history.length - 1];
      this.renderer.highlightLastMove(last.from, last.to);
    }
  }

  isMyTurn() {
    if (!this.state || this.state.winner) return false;
    if (this.player === 'spectator') return false;
    // For local pass-and-play or vs bot:
    if (this.player === 'local') return true;
    return this.state.turn === this.player;
  }

  getActivePlayer() {
    if (this.player === 'local') return this.state.turn;
    return this.player;
  }

  handleClick(event) {
    if (!this.state) return;
    const cell = event.target.closest('.board-cell');
    if (!cell) return;

    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const piece = this.state.board[row]?.[col];
    const activePlayer = this.getActivePlayer();

    // Can only interact if it's our turn
    if (!this.isMyTurn()) {
      if (this.state.winner) {
        window.showMessage?.('Trận đấu đã kết thúc. Bấm "Chơi lại" để bắt đầu ván mới.', 'info');
      } else {
        window.showMessage?.('Chưa đến lượt của bạn, hãy đợi đối thủ!', 'warning');
      }
      return;
    }

    // 1. If clicking own piece: Select or switch piece
    if (piece && piece.player === activePlayer) {
      if (this.selected && this.selected.row === row && this.selected.col === col) {
        // Deselect if clicking the same piece
        this.selected = null;
        this.possibleMoves = [];
        this.renderer.clearHighlights();
        window.showMessage?.('Đã bỏ chọn quân cờ.', 'info');
        return;
      }

      this.selected = { row, col };
      this.renderer.highlightSelection(this.selected);
      this.possibleMoves = window.GameRules.getPossibleMoves(this.state.board, row, col, activePlayer);
      this.renderer.highlightMoves(this.possibleMoves);
      this.sound.playTone(400, 'sine', 0.08, 0.1);

      const pieceName = window.OTT_CONFIG.fullLabels[piece.type];
      const coord = window.GameRules.coordToNotation(row, col);
      window.showMessage?.(`Đã chọn quân ${pieceName} tại [${coord}]. Chọn ô để di chuyển (8 hướng).`, 'info');
      return;
    }

    // 2. If a piece is already selected, attempt to move to clicked cell
    if (this.selected) {
      const targetMove = this.possibleMoves.find(m => m.to.row === row && m.to.col === col);

      if (targetMove) {
        if (targetMove.type === 'blocked') {
          this.sound.playBlocked();
          this.vfx.playClash(cell);
          window.showMessage?.('Không thể ăn quân cùng loại! Hai quân chỉ chặn đường nhau.', 'error');
          return;
        }

        // Execute valid move
        const from = { ...this.selected };
        const to = { row, col };
        this.selected = null;
        this.possibleMoves = [];
        this.renderer.clearHighlights();

        this.onMove(from, to);
        return;
      }

      // Clicked cell is not adjacent / not a candidate
      this.selected = null;
      this.possibleMoves = [];
      this.renderer.clearHighlights();
      window.showMessage?.('Nước đi không hợp lệ. Chỉ được đi 1 ô theo 8 hướng!', 'warning');
    }
  }

  handleDragStart(event) {
    if (!this.isMyTurn()) {
      event.preventDefault();
      return;
    }

    const pieceEl = event.target.closest('.piece');
    if (!pieceEl) return;

    const row = Number(pieceEl.dataset.row);
    const col = Number(pieceEl.dataset.col);
    const piece = this.state.board[row]?.[col];
    const activePlayer = this.getActivePlayer();

    if (!piece || piece.player !== activePlayer) {
      event.preventDefault();
      return;
    }

    this.draggedFrom = { row, col };
    this.selected = { row, col };
    this.renderer.highlightSelection(this.selected);
    this.possibleMoves = window.GameRules.getPossibleMoves(this.state.board, row, col, activePlayer);
    this.renderer.highlightMoves(this.possibleMoves);

    pieceEl.classList.add('dragging');
    event.dataTransfer.setData('text/plain', JSON.stringify({ row, col }));
    event.dataTransfer.effectAllowed = 'move';
  }

  handleDragOver(event) {
    const cell = event.target.closest('.board-cell');
    if (!cell || !this.draggedFrom) return;
    event.preventDefault();
    cell.classList.add('drag-hover');
    event.dataTransfer.dropEffect = 'move';
  }

  handleDragLeave(event) {
    const cell = event.target.closest('.board-cell');
    if (cell) {
      cell.classList.remove('drag-hover');
    }
  }

  handleDrop(event) {
    event.preventDefault();
    const cell = event.target.closest('.board-cell');
    if (!cell || !this.draggedFrom) return;

    cell.classList.remove('drag-hover');
    const toRow = Number(cell.dataset.row);
    const toCol = Number(cell.dataset.col);

    const from = { ...this.draggedFrom };
    const to = { row: toRow, col: toCol };

    const targetMove = this.possibleMoves.find(m => m.to.row === toRow && m.to.col === toCol);

    if (targetMove && targetMove.type !== 'blocked') {
      this.selected = null;
      this.possibleMoves = [];
      this.renderer.clearHighlights();
      this.onMove(from, to);
    } else if (targetMove && targetMove.type === 'blocked') {
      this.sound.playBlocked();
      this.vfx.playClash(cell);
      window.showMessage?.('Không thể ăn quân cùng loại! Hai quân chỉ chặn đường nhau.', 'error');
    } else {
      this.sound.playBlocked();
      window.showMessage?.('Nước đi không hợp lệ!', 'warning');
    }

    this.draggedFrom = null;
  }

  handleDragEnd() {
    this.renderer.element.querySelectorAll('.dragging').forEach(p => p.classList.remove('dragging'));
    this.renderer.element.querySelectorAll('.drag-hover').forEach(c => c.classList.remove('drag-hover'));
    this.draggedFrom = null;
  }
}

window.BoardView = BoardView;
