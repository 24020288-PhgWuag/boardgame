class BoardView {
  constructor(renderer, onMove) { this.renderer = renderer; this.onMove = onMove; this.selected = null; this.state = null; renderer.element.addEventListener('click', event => this.handleClick(event)); }
  setState(state, player) { this.state = state; this.player = player; this.selected = null; }
  handleClick(event) { const cell = event.target.closest('.board-cell'); if (!cell || !this.state) return; const position = { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }; const piece = this.state.board[position.row][position.col]; if (piece?.player === this.player) { this.selected = position; this.renderer.element.querySelectorAll('.selected').forEach(item => item.classList.remove('selected')); cell.classList.add('selected'); return; } if (this.selected) { this.onMove(this.selected, position); this.selected = null; } }
}
window.BoardView = BoardView;
