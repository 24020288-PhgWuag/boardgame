window.VfxManager = class {
  constructor() {
    this.container = document.body;
  }

  playClash(cell) {
    if (!cell) return;
    cell.classList.remove('vfx-shake');
    void cell.offsetWidth;
    cell.classList.add('vfx-shake');
    this.showFloatingText(cell, 'BỊ CHẶN!', 'warning');
  }

  playCapture(cell, attackerType, defenderType) {
    if (!cell) return;
    cell.classList.remove('vfx-impact');
    void cell.offsetWidth;
    cell.classList.add('vfx-impact');

    const attackerLabel = window.OTT_CONFIG.labels[attackerType] || 'Quân';
    const defenderLabel = window.OTT_CONFIG.labels[defenderType] || 'Quân';
    this.showFloatingText(cell, `⚔️ ${attackerLabel} ĂN ${defenderLabel}!`, 'capture');

    // Spawn sparks
    this.spawnParticles(cell, 12, '#e63946');
  }

  playBaseCapture(cell, player) {
    if (!cell) return;
    const label = player === 'p1' ? 'ĐỘI ĐỎ CHIẾM CỨ ĐIỂM!' : 'ĐỘI XANH CHIẾM CỨ ĐIỂM!';
    this.showFloatingText(cell, `🏆 ${label}`, 'victory');
    this.spawnParticles(cell, 24, '#f4a261');
  }

  showFloatingText(cell, text, type = 'info') {
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    const badge = document.createElement('div');
    badge.className = `vfx-floating-badge vfx-${type}`;
    badge.textContent = text;
    badge.style.left = `${rect.left + rect.width / 2}px`;
    badge.style.top = `${rect.top}px`;

    document.body.appendChild(badge);
    setTimeout(() => {
      badge.remove();
    }, 1100);
  }

  spawnParticles(cell, count = 10, color = '#ffd166') {
    const rect = cell.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'vfx-particle';
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = 30 + Math.random() * 50;
      const dx = Math.cos(angle) * speed;
      const dy = Math.sin(angle) * speed;

      p.style.setProperty('--dx', `${dx}px`);
      p.style.setProperty('--dy', `${dy}px`);
      p.style.backgroundColor = color;
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;

      document.body.appendChild(p);
      setTimeout(() => p.remove(), 700);
    }
  }

  triggerVictoryConfetti() {
    const colors = ['#e63946', '#457b9d', '#2a9d8f', '#e76f51', '#f4a261', '#ffd166'];
    const total = 45;

    for (let i = 0; i < total; i++) {
      const confetti = document.createElement('div');
      confetti.className = 'vfx-confetti';
      confetti.style.left = `${Math.random() * 100}vw`;
      confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      confetti.style.animationDelay = `${Math.random() * 0.6}s`;
      confetti.style.animationDuration = `${1.5 + Math.random() * 1.5}s`;
      document.body.appendChild(confetti);
      setTimeout(() => confetti.remove(), 3200);
    }
  }
};
