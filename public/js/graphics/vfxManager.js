window.VfxManager = class { play(result, cell) { if (result === 'block' && cell) { cell.classList.remove('clash'); void cell.offsetWidth; cell.classList.add('clash'); } } };
