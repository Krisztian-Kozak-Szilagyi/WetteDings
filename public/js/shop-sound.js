// Shop-Demo: Platzhalter-Töne und -Musik, alles synthetisch erzeugt (Web Audio, keine Dateien).
// Lautstärke aus window.ShopSettings (Menü → Einstellungen): Gesamt × Geräusche bzw. Gesamt × Musik, wirkt sofort.
// Später durch echte Aufnahmen ersetzen – die Schnittstelle bleibt: ShopSound.play('kaching') usw.
// Browser spielen Ton erst nach der ersten Taste/Maus: dann startet auch die Musik.
(function () {
  let ac = null;
  let sfxBus = null;
  let musicBus = null;
  let hooked = false;

  function volumes() {
    const s = window.ShopSettings ? window.ShopSettings.get() : { master: 80, music: 60, sfx: 80 };
    return { sfx: (s.master / 100) * (s.sfx / 100), music: (s.master / 100) * (s.music / 100) };
  }
  function applyVolume() {
    if (!ac) return;
    const v = volumes();
    sfxBus.gain.setTargetAtTime(v.sfx, ac.currentTime, 0.02);
    musicBus.gain.setTargetAtTime(v.music, ac.currentTime, 0.05);
  }
  function ensure() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      sfxBus = ac.createGain();
      musicBus = ac.createGain();
      sfxBus.connect(ac.destination);
      musicBus.connect(ac.destination);
      applyVolume();
    }
    if (!hooked && window.ShopSettings) {
      hooked = true;
      window.ShopSettings.on(applyVolume);
      applyVolume();
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  /** Ein Ton: freq Hz, ms Länge; opts = { delay s, at (Zeitpunkt), to (Gleiten nach Hz), flat (ohne Ausklingen), bus } */
  function tone(freq, ms, type, vol, opts) {
    const a = ensure();
    if (!a) return;
    const o = opts || {};
    const t0 = o.at || a.currentTime + (o.delay || 0);
    const t1 = t0 + ms / 1000;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t1);
    g.gain.setValueAtTime(vol || 0.03, t0);
    if (!o.flat) g.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(g).connect(o.bus || sfxBus);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }

  /** Gefiltertes Rauschen (Schritte, Karton, Wischen): opts = { type: Filter, freq, to, delay } */
  function noise(ms, vol, opts) {
    const a = ensure();
    if (!a) return;
    const o = opts || {};
    const t0 = a.currentTime + (o.delay || 0);
    const t1 = t0 + ms / 1000;
    const len = Math.max(1, Math.ceil((a.sampleRate * ms) / 1000));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = o.type || 'lowpass';
    f.frequency.setValueAtTime(o.freq || 1000, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t1);
    const g = a.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t1);
    src.connect(f).connect(g).connect(sfxBus);
    src.start(t0);
  }

  // ---------- Geräusche (Platzhalter) ----------
  const SOUNDS = {
    step: () => noise(55, 0.05, { freq: 350 + Math.random() * 250 }),
    door: () => { tone(988, 700, 'sine', 0.06); tone(784, 1000, 'sine', 0.06, { delay: 0.28 }); }, // Ladenglocke
    kaching: () => {
      noise(90, 0.06, { type: 'highpass', freq: 2500 });
      tone(2093, 450, 'triangle', 0.045, { delay: 0.07 });
      tone(2637, 600, 'triangle', 0.045, { delay: 0.14 });
    },
    pickup: () => { tone(200, 120, 'sine', 0.08, { to: 130 }); noise(90, 0.04, { freq: 700 }); },
    drop: () => { tone(140, 170, 'sine', 0.1, { to: 70 }); noise(120, 0.05, { freq: 500 }); },
    place: () => { tone(110, 220, 'sine', 0.12, { to: 55 }); noise(160, 0.06, { freq: 400 }); },
    stock: () => { noise(80, 0.04, { freq: 2200 }); tone(620, 70, 'triangle', 0.02, { delay: 0.05 }); },
    click: () => tone(1800, 25, 'square', 0.012),
    error: () => tone(150, 170, 'square', 0.03, { flat: true }),
    note: () => { tone(660, 180, 'sine', 0.05); tone(990, 280, 'sine', 0.05, { delay: 0.14 }); },
    level: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 320, 'triangle', 0.05, { delay: i * 0.1 })),
    mop: () => noise(450, 0.05, { type: 'bandpass', freq: 500, to: 2200 }),
  };
  function play(name) {
    try {
      const f = Object.prototype.hasOwnProperty.call(SOUNDS, name) ? SOUNDS[name] : null;
      if (f) f();
    } catch (e) { /* ohne Ton */ }
  }

  // ---------- Musik: ruhiger Platzhalter-Loop (Am – F – C – G, 84 BPM), Flächen + leises Arpeggio ----------
  const CHORDS = [[220, 261.63, 329.63], [174.61, 220, 261.63], [130.81, 196, 261.63], [196, 246.94, 293.66]];
  const EIGHTH = 60 / 84 / 2;
  let musicTimer = null;
  let nextAt = 0;
  let step = 0;
  function schedule() {
    if (!ac) return;
    try {
      while (nextAt < ac.currentTime + 0.6) {
        const chord = CHORDS[Math.floor(step / 8) % CHORDS.length];
        if (step % 8 === 0) chord.forEach((f) => tone(f / 2, EIGHTH * 8000, 'triangle', 0.03, { bus: musicBus, at: nextAt }));
        if (step % 2 === 0 || Math.random() < 0.35) tone(chord[[0, 1, 2, 1][(step >> 1) % 4]] * 2, EIGHTH * 1400, 'sine', 0.018, { bus: musicBus, at: nextAt });
        nextAt += EIGHTH;
        step++;
      }
    } catch (e) { /* ohne Musik */ }
  }
  function startMusic() {
    const a = ensure();
    if (!a || musicTimer) return;
    nextAt = a.currentTime + 0.15;
    musicTimer = setInterval(schedule, 200);
  }

  // erst nach der ersten Taste/Maus darf der Browser Ton abspielen
  function unlock() {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    try { startMusic(); } catch (e) { /* ohne Ton */ }
  }
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  window.ShopSound = {
    play,
    tone: (freq, ms, type, vol, opts) => { try { tone(freq, ms, type, vol, opts); } catch (e) { /* ohne Ton */ } },
    startMusic,
  };
})();
