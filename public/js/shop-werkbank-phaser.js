// Shop-Demo: Arbeitstisch direkt im Spiel (Phaser-Szene über dem Laden, Krisztian 2026-10-14): man sieht nur die
// Tischplatte mit der Karte – kein Fenster, kein Rahmen. Esc = aufstehen (der Auftrag bleibt am Tisch liegen).
// Die Minispiele sind Nachbauten des Grading-Tisches der Seite (public/js/grading.js) mit denselben Werten:
//   clean – Flecken wegreiben (vorne und hinten, F = umdrehen), Sauberkeit in % wie cleanliness()
//   iron  – Bügeleisen über den Knick ziehen: Stücke werden glatt, zu lange auf einer Stelle = Brandfleck
// Weitere Schritte (grade, slab) kommen als Einträge in STEPS dazu; bis dahin öffnet der Laden dafür den alten Tisch.
// Ergebnisse gehen an dieselben Adressen wie dort (/shop-demo/werkbank/buegeln, …/fertig).
// Aufruf: ShopWerkbank.open(game, { job, csrf, onDone, onCancel }) – job = jobData von GET /api/shop-demo/werkbank
(function () {
  if (!window.Phaser) return;
  const KEY = 'werkbank';
  const CARD_RATIO = 1008 / 720;
  const WEB_CARD_W = 290; // Kartenbreite am Tisch der Seite – Reib-Strecken werden darauf umgerechnet

  // wie public/js/grading.js
  const BRUSH = 16;
  const SPOT_EASE = { kaffee: 0.7 };
  const SPOT_COLOR = { fleck: 0x6b4423, staub: 0x8a8a80, finger: 0xc8b8a0, kaffee: 0x3b2412 };
  const IRON_SEGMENTS = 10;
  const IRON_R = 26;
  const FLAT_RATE = 1.5;
  const HEAT_RATE = 0.9;
  const COOL_RATE = 0.6;

  /** Nur diese Schritte laufen hier – der Rest am alten Tisch */
  const STEPS = ['clean', 'iron'];
  const LABEL = { clean: 'Putzen', iron: 'Bügeln' };
  const HINT = {
    clean: 'Flecken wegreiben – F dreht die Karte um',
    iron: 'Mit gedrückter Maus langsam über den Knick fahren – nicht stehen bleiben',
  };

  function post(url, csrf, fields) {
    const body = new URLSearchParams(Object.assign({ _csrf: csrf }, fields));
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then((r) => r.json())
      .then((res) => { if (res.error) throw new Error(res.error); return res; });
  }

  const BenchScene = {
    key: KEY,
    init(data) { this.opts = data; },
    preload() {
      const job = this.opts.job;
      if (job.card && job.card.image) this.load.image('wb-card-' + job.id, job.card.image);
      if (job.back) this.load.image('wb-back-' + job.id, job.back);
    },
    create() {
      const job = this.opts.job;
      const W = this.scale.width;
      const H = this.scale.height;
      this.closed = false;
      this.busy = false;
      this.foam = [];

      // ---------- Tischplatte ----------
      const g = this.add.graphics();
      g.fillStyle(0x5b3d24, 1).fillRect(0, 0, W, H);
      const rnd = new Phaser.Math.RandomDataGenerator(['bank']);
      for (let i = 0; i < 60; i++) {
        g.lineStyle(rnd.between(1, 3), rnd.pick([0x4e331e, 0x684629, 0x553820]), 0.6);
        const y = rnd.between(0, H);
        g.lineBetween(0, y, W, y + rnd.between(-20, 20));
      }
      // Schneidematte
      const cardH = Math.min(H * 0.78, (W - 40) * CARD_RATIO * 0.6);
      const cardW = cardH / CARD_RATIO;
      const mw = cardW * 2.1;
      const mh = cardH * 1.18;
      g.fillStyle(0x1f4f45, 1).fillRoundedRect(W / 2 - mw / 2, H / 2 - mh / 2, mw, mh, 14);
      g.lineStyle(1, 0x2f6a5c, 0.7);
      for (let x = W / 2 - mw / 2 + 20; x < W / 2 + mw / 2; x += 24) g.lineBetween(x, H / 2 - mh / 2, x, H / 2 + mh / 2);
      for (let y = H / 2 - mh / 2 + 20; y < H / 2 + mh / 2; y += 24) g.lineBetween(W / 2 - mw / 2, y, W / 2 + mw / 2, y);

      // ---------- Karte ----------
      const cx = W / 2;
      const cy = H / 2;
      const scale = cardW / WEB_CARD_W;
      this.card = { x: cx - cardW / 2, y: cy - cardH / 2, w: cardW, h: cardH, scale };
      this.add.rectangle(cx + 6, cy + 10, cardW, cardH, 0x000000, 0.35); // Schatten
      const frontKey = 'wb-card-' + job.id;
      const backKey = 'wb-back-' + job.id;
      this.front = this.textures.exists(frontKey) ? this.add.image(cx, cy, frontKey).setDisplaySize(cardW, cardH) : this.add.rectangle(cx, cy, cardW, cardH, 0xdddddd);
      this.back = this.textures.exists(backKey) ? this.add.image(cx, cy, backKey).setDisplaySize(cardW, cardH) : this.add.rectangle(cx, cy, cardW, cardH, 0x2a2440);
      this.back.setVisible(false);
      this.facingFront = true;
      this.marks = this.add.graphics(); // Flecken, Knick
      this.fx = this.add.graphics(); // Schaum, Bügeleisen

      // ---------- Flecken (wie grading.js: hp 1 → 0, need in Pixeln Reibweg) ----------
      this.spots = (job.spots || []).map((s) => ({
        side: s.side, kind: s.kind, x: s.x / 100, y: s.y / 100, r: (s.r * 1.6) / 100 / 2, hp: 1,
        need: (90 + s.r * 8) * scale, ease: SPOT_EASE[s.kind] || 1,
      }));
      // ---------- Knick: 10 Stücke entlang der Linie (y in %, Winkel) ----------
      this.segs = [];
      if (job.crease && !job.iron) {
        const a = (job.crease.angle * Math.PI) / 180;
        for (let i = 0; i < IRON_SEGMENTS; i++) {
          const fx = (i + 0.5) / IRON_SEGMENTS;
          const fy = job.crease.y / 100 + (Math.tan(a) * (fx - 0.5) * cardW) / cardH;
          this.segs.push({ x: fx, y: fy, flat: 0, heat: 0, burnt: false });
        }
      }
      this.steps = (job.steps || []).filter((s) => STEPS.includes(s) && (s !== 'iron' || this.segs.length));
      this.stepIndex = 0;

      // ---------- Anzeige (wenig Text) ----------
      this.stepText = this.add.text(W / 2, 18, '', { fontSize: '15px', color: '#fff3c8', backgroundColor: '#00000066', padding: { x: 10, y: 5 } }).setOrigin(0.5, 0);
      this.hint = this.add.text(W / 2, H - 16, '', { fontSize: '13px', color: '#e8dcc0', backgroundColor: '#00000066', padding: { x: 8, y: 4 } }).setOrigin(0.5, 1);
      this.add.text(14, 14, 'Esc = aufstehen', { fontSize: '12px', color: '#d8c8a8' });
      this.btn = this.add.text(W - 20, H - 20, '', { fontSize: '16px', color: '#ffffff', backgroundColor: '#2f9a5a', padding: { x: 14, y: 8 } })
        .setOrigin(1, 1).setInteractive({ useHandCursor: true });
      this.btn.on('pointerdown', () => this.finishStep());
      this.flipBtn = this.add.text(W - 20, 18, '↻ Umdrehen (F)', { fontSize: '13px', color: '#fff', backgroundColor: '#00000066', padding: { x: 8, y: 5 } })
        .setOrigin(1, 0).setInteractive({ useHandCursor: true });
      this.flipBtn.on('pointerdown', () => this.flip());

      // ---------- Eingabe ----------
      this.pointer = null;
      this.input.on('pointerdown', (p) => { this.pointer = { x: p.x, y: p.y }; });
      this.input.on('pointermove', (p) => {
        if (!p.isDown) { this.hover = { x: p.x, y: p.y }; return; }
        const last = this.pointer || { x: p.x, y: p.y };
        const dist = Math.hypot(p.x - last.x, p.y - last.y);
        this.pointer = { x: p.x, y: p.y };
        this.hover = this.pointer;
        if (this.step() === 'clean') this.rub(p.x, p.y, dist);
      });
      this.input.on('pointerup', () => { this.pointer = null; });
      this.input.keyboard.on('keydown-ESC', () => this.close(false));
      this.input.keyboard.on('keydown-F', () => this.flip());

      if (!this.steps.length) { this.send(); return; }
      this.showStep();
    },

    step() { return this.steps[this.stepIndex]; },

    showStep() {
      const s = this.step();
      this.stepText.setText(this.steps.map((x, i) => (i < this.stepIndex ? '✓ ' : i === this.stepIndex ? '● ' : '○ ') + LABEL[x]).join('    '));
      this.hint.setText(HINT[s] || '');
      this.btn.setText(s === 'clean' ? 'Fertig geputzt' : 'Fertig gebügelt');
      this.flipBtn.setVisible(s === 'clean');
      if (s === 'iron' && !this.facingFront) this.flip();
    },

    flip() {
      if (this.step() !== 'clean' || this.busy) return;
      this.facingFront = !this.facingFront;
      this.front.setVisible(this.facingFront);
      this.back.setVisible(!this.facingFront);
    },

    /** Kartenkoordinaten (0…1) → Bildschirm; die Rückseite ist gespiegelt */
    toScreen(fx, fy) {
      const c = this.card;
      return { x: c.x + (this.facingFront ? fx : 1 - fx) * c.w, y: c.y + fy * c.h };
    },

    rub(x, y, dist) {
      let hit = false;
      this.spots.forEach((s) => {
        if (s.hp <= 0 || (s.side === 'f') !== this.facingFront) return;
        const p = this.toScreen(s.x, s.y);
        if (Math.hypot(x - p.x, y - p.y) > s.r * this.card.w + BRUSH * this.card.scale) return;
        hit = true;
        s.hp = Math.max(0, s.hp - (dist * s.ease) / s.need);
        if (s.hp < 0.04) s.hp = 0;
      });
      if (hit) this.foam.push({ x: x + Phaser.Math.Between(-8, 8), y: y + Phaser.Math.Between(-8, 8), t: 0.5 });
    },

    cleanliness() {
      if (!this.spots.length) return 100;
      return Math.round((this.spots.reduce((a, s) => a + (1 - s.hp), 0) / this.spots.length) * 100);
    },

    ironTick(dt) {
      const p = this.step() === 'iron' && this.pointer && this.facingFront ? this.pointer : null;
      const R = IRON_R * this.card.scale;
      this.hottest = 0;
      this.segs.forEach((s) => {
        const sp = this.toScreen(s.x, s.y);
        const segLen = (this.card.w / IRON_SEGMENTS) / 2;
        if (p && Math.hypot(p.x - sp.x, p.y - sp.y) <= R + segLen) {
          s.flat = Math.min(1, s.flat + dt * FLAT_RATE);
          s.heat += dt * HEAT_RATE;
          if (s.heat >= 1) s.burnt = true;
          this.hottest = Math.max(this.hottest, s.heat);
        } else s.heat = Math.max(0, s.heat - dt * COOL_RATE);
      });
    },

    ironResult() {
      const flat = this.segs.reduce((a, s) => a + s.flat, 0);
      return { smooth: this.segs.length ? Math.round((flat / this.segs.length) * 100) : 0, burns: this.segs.filter((s) => s.burnt).length };
    },

    finishStep() {
      if (this.busy) return;
      const s = this.step();
      if (s === 'iron') {
        this.busy = true;
        const r = this.ironResult();
        post('/shop-demo/werkbank/buegeln', this.opts.csrf, { job: this.opts.job.id, smooth: String(r.smooth), burns: String(r.burns) })
          .then((res) => {
            this.hint.setText('Zu ' + res.smooth + ' % glatt' + (res.burns ? ' · ' + res.burns + ' Brandfleck' + (res.burns === 1 ? '' : 'e') : ''));
            this.time.delayedCall(1100, () => { this.busy = false; this.next(); });
          })
          .catch((err) => { this.busy = false; this.hint.setText(err.message); });
        return;
      }
      this.next();
    },

    next() {
      this.stepIndex += 1;
      if (this.stepIndex >= this.steps.length) this.send();
      else this.showStep();
    },

    send() {
      this.busy = true;
      this.btn.setVisible(false);
      this.hint.setText('Fertig!');
      post('/shop-demo/werkbank/fertig', this.opts.csrf, { job: this.opts.job.id, clean: String(this.cleanliness()), seal: '' })
        .then((res) => this.time.delayedCall(500, () => this.close(true, res)))
        .catch((err) => { this.busy = false; this.btn.setVisible(true); this.hint.setText(err.message); });
    },

    close(done, res) {
      if (this.closed) return;
      this.closed = true;
      const o = this.opts;
      this.scene.stop();
      if (done && o.onDone) o.onDone(res);
      if (!done && o.onCancel) o.onCancel();
    },

    update(time, delta) {
      if (this.closed || !this.card) return;
      const dt = Math.min(0.05, delta / 1000);
      if (!this.foam) this.foam = [];
      this.ironTick(dt);
      const m = this.marks;
      const c = this.card;
      m.clear();
      // Flecken der sichtbaren Seite (Reste bleiben lange sichtbar: hp^0,6 wie am Tisch der Seite)
      this.spots.forEach((s) => {
        if (s.hp <= 0 || (s.side === 'f') !== this.facingFront) return;
        const p = this.toScreen(s.x, s.y);
        const a = Math.pow(s.hp, 0.6);
        const r = s.r * c.w * (s.kind === 'fleck' ? 1 + 0.9 * s.hp * (1 - s.hp) : 1);
        m.fillStyle(SPOT_COLOR[s.kind] || 0x6b4423, 0.75 * a);
        m.fillCircle(p.x, p.y, r);
        if (s.kind === 'finger') { m.lineStyle(1.5, 0x8a7a60, 0.6 * a); for (let k = 0.35; k < 1; k += 0.2) m.strokeCircle(p.x, p.y, r * k); }
      });
      // Knick (nur vorne): dunkle Linie, glatte Stücke hell, Hitze rot, Brandfleck schwarz
      if (this.facingFront && this.segs.length) {
        const segLen = c.w / IRON_SEGMENTS;
        this.segs.forEach((s) => {
          const p = this.toScreen(s.x, s.y);
          const ang = Math.atan2((this.segs[this.segs.length - 1].y - this.segs[0].y) * c.h, (this.segs[this.segs.length - 1].x - this.segs[0].x) * c.w);
          const dx = Math.cos(ang) * segLen / 2;
          const dy = Math.sin(ang) * segLen / 2;
          m.lineStyle(3, Phaser.Display.Color.GetColor(60 + 150 * s.flat, 50 + 150 * s.flat, 50 + 150 * s.flat), 0.9 - 0.6 * s.flat);
          m.lineBetween(p.x - dx, p.y - dy, p.x + dx, p.y + dy);
          if (s.heat > 0.3) { m.fillStyle(0xff4020, Math.min(0.6, s.heat * 0.5)); m.fillCircle(p.x, p.y, 7 * c.scale); }
          if (s.burnt) { m.fillStyle(0x1a1008, 0.9); m.fillCircle(p.x, p.y, 4 * c.scale); }
        });
      }
      // Schaum und Bügeleisen
      const f = this.fx;
      f.clear();
      this.foam = this.foam.filter((b) => (b.t -= dt) > 0);
      this.foam.forEach((b) => { f.fillStyle(0xffffff, b.t * 1.4); f.fillCircle(b.x, b.y, 4 + (0.5 - b.t) * 10); });
      if (this.step() === 'iron' && this.hover) {
        const R = IRON_R * c.scale;
        f.fillStyle(this.hottest > 0.75 ? 0xff5030 : 0xd0d4dc, this.pointer ? 0.55 : 0.3);
        f.fillCircle(this.hover.x, this.hover.y, R);
        f.lineStyle(2, 0x30343c, 0.8).strokeCircle(this.hover.x, this.hover.y, R);
      }
    },
  };

  window.ShopWerkbank = {
    STEPS,
    /** Kann der Phaser-Tisch diese Schritte (sonst: alter Tisch im Fenster)? */
    handles(steps) { return (steps || []).every((s) => STEPS.includes(s)); },
    isOpen(game) { return !!(game && game.scene.isActive(KEY)); },
    open(game, data) {
      if (!game.scene.getScene(KEY)) game.scene.add(KEY, BenchScene, false);
      game.scene.start(KEY, data);
      game.scene.bringToTop(KEY);
    },
  };
})();
