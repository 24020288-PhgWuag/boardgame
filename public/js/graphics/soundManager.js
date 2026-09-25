window.SoundManager = class {
  constructor() {
    this.muted = localStorage.getItem('ott_sound_muted') === 'true';
    this.ctx = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('ott_sound_muted', String(this.muted));
    return this.muted;
  }

  playTone(freq, type = 'sine', duration = 0.1, gainVal = 0.15, pitchDrop = 0) {
    if (this.muted) return;
    try {
      const ctx = this.ensureContext();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(freq, now);
      if (pitchDrop !== 0) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + pitchDrop), now + duration);
      }

      gain.gain.setValueAtTime(gainVal, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + duration);
    } catch {
      // Audio context not allowed before user gesture
    }
  }

  playMove() {
    // Soft wooden snap / piece placement
    this.playTone(320, 'triangle', 0.12, 0.2, -120);
  }

  playCapture() {
    // Sharp dual impact / slice
    this.playTone(520, 'sawtooth', 0.15, 0.25, -280);
    setTimeout(() => {
      this.playTone(260, 'square', 0.2, 0.2, -150);
    }, 40);
  }

  playBlocked() {
    // Heavy dull thud / shield clash
    this.playTone(160, 'square', 0.1, 0.18, -40);
    setTimeout(() => {
      this.playTone(120, 'triangle', 0.15, 0.18, -30);
    }, 80);
  }

  playTurn() {
    // Gentle crystal notification ping
    this.playTone(880, 'sine', 0.25, 0.12, -40);
  }

  playVictory() {
    // Triumphant fanfare: C5 -> E5 -> G5 -> C6
    const notes = [523.25, 659.25, 783.99, 1046.50];
    notes.forEach((freq, idx) => {
      setTimeout(() => {
        this.playTone(freq, 'triangle', 0.35, 0.22, 0);
      }, idx * 120);
    });
  }

  playDefeat() {
    // Melancholic descending tone
    const notes = [440, 392, 349.23, 293.66];
    notes.forEach((freq, idx) => {
      setTimeout(() => {
        this.playTone(freq, 'sawtooth', 0.3, 0.18, -40);
      }, idx * 140);
    });
  }

  playBaseAlert() {
    // Warning siren for base infiltration
    this.playTone(660, 'square', 0.15, 0.2, 80);
    setTimeout(() => this.playTone(880, 'square', 0.2, 0.2, 100), 120);
  }
};
