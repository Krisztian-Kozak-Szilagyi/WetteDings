// Shop-Demo: Kassieren als Minispiel (Phaser-Szene über dem Laden). Der Kunde legt seine Sachen auf die Theke,
// man scannt jedes Stück per Klick (Piep), die Summe läuft mit, am Ende wird kassiert.
// Aufbau in Schritten (STEPS + ORDER), damit später weitere dazukommen können – z. B. Bar/Karte, Wechselgeld,
// Tüte packen: ein neuer Schritt = ein Eintrag in STEPS mit start(ctx) und ein Name in ORDER.
// Aufruf: ShopKasse.open(game, { title, lines: [{ name, qty, price, color }], onDone, onCancel })
(function () {
  if (!window.Phaser) return;
  const KEY = 'kasse';
  const fmt = (n) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MAX_PIECES = 24; // so viele Stücke liegen einzeln auf der Theke, der Rest als Stapel

  // ---------- Ton ----------
  let audio = null;
  function beep(freq, ms) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'square';
      o.frequency.value = freq || 1400;
      g.gain.value = 0.04;
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + (ms || 70) / 1000);
    } catch (e) { /* ohne Ton */ }
  }

  // ---------- Schritte ----------
  const STEPS = {
    // Jedes Stück anklicken → gescannt
    scan: {
      start(ctx) {
        const { scene, pieces } = ctx;
        ctx.hint('Klicke jedes Teil an, um es zu scannen');
        let left = pieces.length;
        if (!left) return ctx.next();
        pieces.forEach((p) => {
          p.box.setInteractive({ useHandCursor: true });
          p.box.on('pointerdown', () => {
            if (p.done) return;
            p.done = true;
            beep(1500, 60);
            ctx.addToTotal(p.price * p.count);
            scene.tweens.add({ targets: [p.box, p.label], x: ctx.bagX, y: ctx.bagY, alpha: 0, scale: 0.4, duration: 260, ease: 'Quad.easeIn' });
            left -= 1;
            if (!left) scene.time.delayedCall(280, () => ctx.next());
          });
        });
      },
    },
    // Bezahlen – vorerst ein Knopf (später: Bar mit Wechselgeld, Karte …)
    pay: {
      start(ctx) {
        ctx.hint('Alles gescannt');
        ctx.button('Kassieren (' + fmt(ctx.total) + ' Kanacoin)', () => { beep(900, 120); ctx.next(); });
      },
    },
  };
  const ORDER = ['scan', 'pay'];

  const KasseScene = {
    key: KEY,
    init(data) { this.data_ = data; },
    create() {
      const d = this.data_;
      this.closed = false;
      const W = this.scale.width;
      const H = this.scale.height;
      const cx = W / 2;
      const cy = H / 2;
      const pw = Math.min(760, W - 40);
      const ph = Math.min(420, H - 80);
      const left = cx - pw / 2;
      const top = cy - ph / 2;
      const objs = [];
      const add = (o) => { objs.push(o); return o; };

      add(this.add.rectangle(0, 0, W, H, 0x000000, 0.55).setOrigin(0).setInteractive()); // fängt Klicks ab
      // Theke (Holz) und Kasse mit Anzeige
      add(this.add.rectangle(cx, cy, pw, ph, 0x7a5a3a).setStrokeStyle(3, 0x3a2a1a));
      add(this.add.rectangle(cx, cy - ph / 2 + 4, pw, 8, 0x9a7a52).setOrigin(0.5, 0));
      const regX = left + pw - 130;
      add(this.add.rectangle(regX, top + 70, 210, 90, 0x22262f).setStrokeStyle(2, 0x111318));
      add(this.add.text(regX, top + 40, d.title || 'Kasse', { fontSize: '13px', color: '#9aa0b4' }).setOrigin(0.5));
      const totalText = add(this.add.text(regX, top + 78, '0,00', { fontSize: '30px', color: '#7dffa6', fontFamily: 'monospace' }).setOrigin(0.5));
      const bagX = regX;
      const bagY = top + ph - 70;
      add(this.add.rectangle(bagX, bagY, 120, 80, 0xe8dcc0).setStrokeStyle(2, 0x9a8a6a)); // Tüte
      add(this.add.text(bagX, bagY, 'Tüte', { fontSize: '12px', color: '#6a5a3a' }).setOrigin(0.5));
      const hintText = add(this.add.text(cx, top - 18, '', { fontSize: '15px', color: '#fff3c8' }).setOrigin(0.5));
      add(this.add.text(left + 8, top + ph + 10, 'Esc = abbrechen', { fontSize: '12px', color: '#9aa0b4' }));

      // Stücke auf der Theke (links), große Mengen gestapelt
      const pieces = [];
      const area = { x: left + 30, y: top + 40, w: pw - 300, h: ph - 80 };
      const all = [];
      d.lines.forEach((l) => {
        const n = Math.max(1, l.qty);
        const single = Math.min(n, Math.max(1, Math.floor(MAX_PIECES / d.lines.length)));
        for (let i = 0; i < single; i++) all.push({ line: l, count: i === single - 1 ? n - (single - 1) : 1 });
      });
      const cols = Math.max(1, Math.floor(area.w / 70));
      all.forEach((a, i) => {
        const x = area.x + 30 + (i % cols) * 70;
        const y = area.y + 30 + Math.floor(i / cols) * 70;
        const box = add(this.add.rectangle(x, y, 52, 52, a.line.color || 0xcccccc).setStrokeStyle(2, 0x1c1f2b));
        const label = add(this.add.text(x, y, (a.count > 1 ? '×' + a.count + '\n' : '') + a.line.name.slice(0, 10), {
          fontSize: '9px', color: '#111', align: 'center', wordWrap: { width: 50 },
        }).setOrigin(0.5));
        pieces.push({ box, label, price: a.line.price, count: a.count });
      });

      let total = 0;
      let step = -1;
      let btn = null;
      const scene = this;
      const ctx = {
        scene, pieces, bagX, bagY,
        get total() { return total; },
        addToTotal(v) { total += v; totalText.setText(fmt(total)); },
        hint(t) { hintText.setText(t); },
        button(label, fn) {
          if (btn) btn.forEach((o) => o.destroy());
          const bx = regX;
          const by = top + 150;
          const r = add(this.scene.add.rectangle(bx, by, 220, 40, 0x2f9a5a).setStrokeStyle(2, 0x1c5a34).setInteractive({ useHandCursor: true }));
          const t = add(this.scene.add.text(bx, by, label, { fontSize: '13px', color: '#fff' }).setOrigin(0.5));
          r.on('pointerdown', fn);
          btn = [r, t];
          scene.input.keyboard.once('keydown-ENTER', fn);
        },
        next() {
          step += 1;
          if (step >= ORDER.length) { scene.close(true); return; }
          STEPS[ORDER[step]].start(ctx);
        },
      };
      this.close = (done) => {
        if (this.closed) return;
        this.closed = true;
        this.scene.stop();
        if (done && d.onDone) d.onDone({ total });
        if (!done && d.onCancel) d.onCancel();
      };
      this.input.keyboard.on('keydown-ESC', () => this.close(false));
      ctx.next();
    },
  };

  window.ShopKasse = {
    STEPS, ORDER,
    isOpen(game) { return !!(game && game.scene.isActive(KEY)); },
    open(game, data) {
      if (!game.scene.getScene(KEY)) game.scene.add(KEY, KasseScene, false);
      game.scene.start(KEY, data);
      game.scene.bringToTop(KEY);
    },
  };
})();
