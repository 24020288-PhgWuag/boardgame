class BoardRenderer {
  constructor(element) { this.element = element; }
  render(state) {
    this.element.innerHTML = '';
    state.board.forEach((row, rowIndex) => row.forEach((piece, colIndex) => {
      const cell = document.createElement('button'); cell.className = 'board-cell'; cell.dataset.row = rowIndex; cell.dataset.col = colIndex; cell.type = 'button';
      if (rowIndex === 0 && colIndex === 0) cell.classList.add('base-a1'); if (rowIndex === 8 && colIndex === 8) cell.classList.add('base-i9');
      if (piece) { const token = document.createElement('span'); token.className = `piece ${piece.player} ${piece.type}`; token.title = `${piece.player} ${piece.type}`; cell.append(token); }
      this.element.append(cell);
    }));
  }
}
window.BoardRenderer = BoardRenderer;
