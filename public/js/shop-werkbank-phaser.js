// Shop-Demo: Arbeitstisch direkt im Spiel (Phaser-Szene über dem Laden, Krisztian 2026-10-14): man sieht nur die
// Tischplatte mit der Karte – kein Fenster, kein Rahmen. Esc = aufstehen (der Auftrag bleibt am Tisch liegen).
// Die Minispiele sind Nachbauten des Grading-Tisches der Seite (public/js/grading.js) mit denselben Werten:
//   clean – Flecken mit dem Schwamm wegreiben (vorne und hinten, R = Karte umdrehen), Sauberkeit in % wie cleanliness()
//   iron  – Bügeleisen über den Knick ziehen: Stücke werden glatt, zu lange auf einer Stelle = Brandfleck
// Weitere Schritte (grade, slab) kommen als Einträge in STEPS dazu; bis dahin öffnet der Laden dafür den alten Tisch.
// Ergebnisse gehen an dieselben Adressen wie dort (/shop-demo/werkbank/buegeln, …/fertig).
// Aufruf: ShopWerkbank.open(game, { job, csrf, onDone, onCancel }) – job = jobData von GET /api/shop-demo/werkbank
// WICHTIG: Phaser übernimmt bei Szenen als Objekt nur init/preload/create/update – eigene Methoden gehören in "extend"
// (test/shop-scenes.test.js spielt die Szene ohne Browser durch).
(function () {
  if (!window.Phaser) return;
  const KEY = 'werkbank';
  const CARD_RATIO = 1008 / 720;
  const CORNER = 0.055; // Eckenradius der Karte (Anteil der Breite, wie die Kartenbilder)
  const WEB_CARD_W = 290; // Kartenbreite am Tisch der Seite – Reib-Strecken werden darauf umgerechnet

  // wie public/js/grading.js
  const BRUSH = 16;
  const SPOT_EASE = { kaffee: 0.7 };
  const SPOT_COLOR = { fleck: 0x6b4423, staub: 0x8a8a80, finger: 0xb8a888, kaffee: 0x3b2412 };
  const IRON_SEGMENTS = 10;
  const IRON_R = 26;
  const FLAT_RATE = 1.5;
  const HEAT_RATE = 0.9;
  const COOL_RATE = 0.6;

  /** Nur diese Schritte laufen hier – der Rest am alten Tisch */
  const STEPS = ['clean', 'iron'];
  const LABEL = { clean: 'Putzen', iron: 'Bügeln' };
  const HINT = {
    clean: 'Mit gedrückter Maus schrubben · R = Karte umdrehen',
    iron: 'Mit gedrückter Maus langsam über den Knick fahren – nicht stehen bleiben',
  };

  // ---------- Ton (leise, optional) ----------
  let audio = null;
  function tone(freq, ms, type, vol) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type || 'triangle';
      o.frequency.value = freq;
      g.gain.value = vol || 0.03;
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + ms / 1000);
    } catch (e) { /* ohne Ton */ }
  }

  function post(url, csrf, fields) {
    const body = new URLSearchParams(Object.assign({ _csrf: csrf }, fields));
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then((r) => r.json())
      .then((res) => { if (res.error) throw new Error(res.error); return res; });
  }

  /** Bild mit abgerundeten Ecken als neue Textur (Rückseiten haben schwarze statt durchsichtige Ecken) */
  function roundedTexture(scene, key) {
    const out = key + '-rund';
    if (scene.textures.exists(out)) return out;
    if (!scene.textures.exists(key)) return null;
    const src = scene.textures.get(key).getSourceImage();
    const w = src.width;
    const h = src.height;
    const tex = scene.textures.createCanvas(out, w, h);
    if (!tex) return key;
    const ctx = tex.getContext();
    const r = w * CORNER;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    ctx.arcTo(0, 0, w, 0, r);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(src, 0, 0, w, h);
    tex.refresh();
    return out;
  }

  /** Fleck als unregelmäßiger Klecks: ein paar überlappende Kreise, fest je Fleck */
  function blobsFor(i) {
    const out = [];
    for (let k = 0; k < 5; k++) {
      const a = (i * 7 + k * 2.4) % (Math.PI * 2);
      const d = k === 0 ? 0 : 0.35 + ((i * 13 + k * 5) % 10) / 30;
      out.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d, rr: k === 0 ? 0.85 : 0.45 + ((i + k * 3) % 5) / 14 });
    }
    return out;
  }

  const BenchScene = {
    key: KEY,
    init(data) { this.opts = data; },
    preload() {
      const job = this.opts.job;
      // Schlüssel = Bildadresse (nicht die Auftragsnummer – die beginnt nach „Neu starten“ wieder bei 1)
      // schon vorab geladen (Laden: prefetchBenches)? dann nichts laden
      [job.card && job.card.image, job.back].forEach((url) => { if (url && !this.textures.exists('wb:' + url)) this.load.image('wb:' + url, url); });
    },
    create() {
      const job = this.opts.job;
      const W = this.scale.width;
      const H = this.scale.height;
      this.closed = false;
      this.busy = false;
      this.flipping = false;
      this.foam = [];
      this.sparks = [];
      this.t = 0;

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

      // ---------- Karte: alles in einem Container (dreht sich beim Umdrehen als Ganzes) ----------
      const cx = W / 2;
      const cy = H / 2;
      const scale = cardW / WEB_CARD_W;
      this.card = { x: cx - cardW / 2, y: cy - cardH / 2, w: cardW, h: cardH, scale, cx, cy };
      this.cardC = this.add.container(cx, cy);
      const shadow = this.add.graphics();
      shadow.fillStyle(0x000000, 0.35).fillRoundedRect(-cardW / 2 + 6, -cardH / 2 + 10, cardW, cardH, cardW * CORNER);
      const frontKey = job.card && job.card.image ? roundedTexture(this, 'wb:' + job.card.image) : null;
      const backKey = job.back ? roundedTexture(this, 'wb:' + job.back) : null;
      this.front = frontKey ? this.add.image(0, 0, frontKey).setDisplaySize(cardW, cardH) : this.add.rectangle(0, 0, cardW, cardH, 0xdddddd);
      this.back = backKey ? this.add.image(0, 0, backKey).setDisplaySize(cardW, cardH) : this.add.rectangle(0, 0, cardW, cardH, 0x2a2440);
      this.back.setVisible(false);
      this.marks = this.add.graphics(); // Flecken, Knick (Container-Koordinaten)
      this.cardC.add([shadow, this.front, this.back, this.marks]);
      this.facingFront = true;
      this.fx = this.add.graphics(); // Schaum, Funken, Schwamm, Bügeleisen (Bildschirm-Koordinaten)

      // ---------- Flecken (wie grading.js: hp 1 → 0, need in Pixeln Reibweg) ----------
      this.spots = (job.spots || []).map((s, i) => ({
        side: s.side, kind: s.kind, x: s.x / 100, y: s.y / 100, r: (s.r * 1.6) / 100 / 2, hp: 1,
        need: (90 + s.r * 8) * scale, ease: SPOT_EASE[s.kind] || 1, blobs: blobsFor(i),
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

      // ---------- Eingabe ----------
      this.pointer = null;
      this.input.on('pointerdown', (p) => { this.pointer = { x: p.x, y: p.y }; this.hover = this.pointer; });
      this.input.on('pointermove', (p) => {
        if (!p.isDown) { this.hover = { x: p.x, y: p.y }; return; }
        const last = this.pointer || { x: p.x, y: p.y };
        const dist = Math.hypot(p.x - last.x, p.y - last.y);
        this.pointer = { x: p.x, y: p.y };
        this.hover = this.pointer;
        if (this.step() === 'clean' && !this.flipping) this.rub(p.x, p.y, dist);
      });
      this.input.on('pointerup', () => { this.pointer = null; });
      this.input.keyboard.on('keydown-ESC', () => this.close(false));
      this.input.keyboard.on('keydown-R', () => this.flip()); // wie Möbel drehen im Laden
      this.input.keyboard.on('keydown-F', () => this.flip());

      if (!this.steps.length) { this.send(); return; }
      this.showStep();
    },

    extend: {
      step() { return this.steps[this.stepIndex]; },

      showStep() {
        const s = this.step();
        this.stepText.setText(this.steps.map((x, i) => (i < this.stepIndex ? '✓ ' : i === this.stepIndex ? '● ' : '○ ') + LABEL[x]).join('    '));
        this.hint.setText(HINT[s] || '');
        this.btn.setText(s === 'clean' ? 'Fertig geputzt' : 'Fertig gebügelt');
        if (s === 'iron' && !this.facingFront) this.flip(true); // gebügelt wird vorne
      },

      /** Karte umdrehen – mit Animation: zusammenklappen, Seite wechseln, aufklappen */
      flip(force) {
        if (this.flipping || this.busy || (!force && this.step() !== 'clean')) return;
        this.flipping = true;
        this.pointer = null;
        tone(520, 90, 'sine', 0.02);
        const c = this.cardC;
        this.tweens.add({
          targets: c, scaleX: 0, y: this.card.cy - 14, duration: 130, ease: 'Sine.easeIn',
          onComplete: () => {
            this.setFacing(!this.facingFront);
            this.tweens.add({
              targets: c, scaleX: 1, y: this.card.cy, duration: 150, ease: 'Sine.easeOut',
              onComplete: () => { this.flipping = false; },
            });
          },
        });
      },

      setFacing(front) {
        this.facingFront = front;
        this.front.setVisible(front);
        this.back.setVisible(!front);
      },

      /** Kartenkoordinaten (0…1) → Bildschirm; die Rückseite ist gespiegelt */
      toScreen(fx, fy) {
        const c = this.card;
        return { x: c.x + (this.facingFront ? fx : 1 - fx) * c.w, y: c.y + fy * c.h };
      },

      onCard(x, y) {
        const c = this.card;
        return x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h;
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
          if (!s.hp) this.sparkle(p.x, p.y);
        });
        if (this.onCard(x, y) && dist > 0) {
          // Schaum beim Schrubben – mehr, wenn er auf Schmutz trifft
          const n = hit ? 3 : 1;
          for (let i = 0; i < n; i++) {
            this.foam.push({ x: x + (Math.random() - 0.5) * 26 * this.card.scale, y: y + (Math.random() - 0.5) * 18 * this.card.scale, r: 2 + Math.random() * 5, t: 0.6 + Math.random() * 0.4 });
          }
          if (this.foam.length > 160) this.foam.splice(0, this.foam.length - 160);
        }
      },

      sparkle(x, y) {
        tone(1700, 160, 'triangle', 0.03);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          this.sparks.push({ x, y, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90, t: 0.45 });
        }
      },

      cleanliness() {
        if (!this.spots.length) return 100;
        return Math.round((this.spots.reduce((a, s) => a + (1 - s.hp), 0) / this.spots.length) * 100);
      },

      ironTick(dt) {
        const p = this.step() === 'iron' && this.pointer && this.facingFront && !this.flipping ? this.pointer : null;
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
        if (this.busy || this.flipping) return;
        const s = this.step();
        if (s === 'iron') {
          this.busy = true;
          const r = this.ironResult();
          post('/shop-demo/werkbank/buegeln', this.opts.csrf, { job: this.opts.job.id, tisch: this.opts.station || '', smooth: String(r.smooth), burns: String(r.burns) })
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
        post('/shop-demo/werkbank/fertig', this.opts.csrf, { job: this.opts.job.id, tisch: this.opts.station || '', clean: String(this.cleanliness()), seal: '' })
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

      /** Flecken und Knick in Container-Koordinaten zeichnen */
      drawMarks() {
        const m = this.marks;
        const c = this.card;
        m.clear();
        const local = (p) => ({ x: p.x - c.cx, y: p.y - c.cy });
        this.spots.forEach((s) => {
          if (s.hp <= 0 || (s.side === 'f') !== this.facingFront) return;
          const p = local(this.toScreen(s.x, s.y));
          const a = 0.12 + 0.7 * Math.pow(s.hp, 0.8); // Reste bleiben lange sichtbar, werden aber deutlich blasser
          const r = s.r * c.w * (0.55 + 0.45 * s.hp) * (s.kind === 'fleck' ? 1 + 0.6 * s.hp * (1 - s.hp) : 1);
          const col = SPOT_COLOR[s.kind] || 0x6b4423;
          s.blobs.forEach((b) => { m.fillStyle(col, a * (b.dx || b.dy ? 0.55 : 0.8)); m.fillCircle(p.x + b.dx * r, p.y + b.dy * r, r * b.rr); });
          if (s.kind === 'finger') { m.lineStyle(1.2, 0x7a6a50, 0.55 * a); for (let k = 0.3; k < 1; k += 0.18) m.strokeEllipse(p.x, p.y, r * k * 1.6, r * k * 2); }
        });
        if (this.facingFront && this.segs.length) {
          const segLen = c.w / IRON_SEGMENTS;
          const first = this.segs[0];
          const last = this.segs[this.segs.length - 1];
          const ang = Math.atan2((last.y - first.y) * c.h, (last.x - first.x) * c.w);
          const dx = (Math.cos(ang) * segLen) / 2;
          const dy = (Math.sin(ang) * segLen) / 2;
          this.segs.forEach((s) => {
            const p = local(this.toScreen(s.x, s.y));
            m.lineStyle(3, Phaser.Display.Color.GetColor(60 + 150 * s.flat, 50 + 150 * s.flat, 50 + 150 * s.flat), 0.9 - 0.6 * s.flat);
            m.lineBetween(p.x - dx, p.y - dy, p.x + dx, p.y + dy);
            if (s.heat > 0.3) { m.fillStyle(0xff4020, Math.min(0.6, s.heat * 0.5)); m.fillCircle(p.x, p.y, 7 * c.scale); }
            if (s.burnt) { m.fillStyle(0x1a1008, 0.9); m.fillCircle(p.x, p.y, 4 * c.scale); }
          });
        }
      },
    },

    update(time, delta) {
      if (this.closed || !this.card) return;
      const dt = Math.min(0.05, delta / 1000);
      this.t += dt;
      this.ironTick(dt);
      this.drawMarks();
      const f = this.fx;
      const c = this.card;
      f.clear();
      // Schaum: steigt leicht auf und vergeht
      this.foam = this.foam.filter((b) => (b.t -= dt) > 0);
      this.foam.forEach((b) => {
        b.y -= dt * 6;
        f.fillStyle(0xffffff, Math.min(0.85, b.t));
        f.fillCircle(b.x, b.y, b.r);
        f.lineStyle(1, 0xd8e8f0, Math.min(0.6, b.t)).strokeCircle(b.x, b.y, b.r);
      });
      // Funken, wenn ein Fleck ganz weg ist
      this.sparks = this.sparks.filter((s) => (s.t -= dt) > 0);
      this.sparks.forEach((s) => {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const L = 5 * s.t * 2;
        f.lineStyle(2, 0xfff6c0, s.t * 2);
        f.lineBetween(s.x - L, s.y, s.x + L, s.y);
        f.lineBetween(s.x, s.y - L, s.x, s.y + L);
      });
      // Werkzeug an der Maus: Schwamm beim Putzen, Bügeleisen beim Bügeln
      if (this.hover && !this.flipping) {
        const h = this.hover;
        if (this.step() === 'clean') {
          const wob = this.pointer ? Math.sin(this.t * 40) * 2 : 0;
          const sw = 30 * Math.max(0.8, Math.sqrt(c.scale));
          const sh = sw * 0.68;
          f.fillStyle(0x000000, 0.18).fillRoundedRect(h.x - sw / 2 + 3, h.y - sh / 2 + 4, sw, sh, 6);
          f.fillStyle(0xf2d24b, 1).fillRoundedRect(h.x - sw / 2 + wob, h.y - sh / 2, sw, sh, 6);
          f.fillStyle(0x3f8a5a, 1).fillRoundedRect(h.x - sw / 2 + wob, h.y + sh / 2 - sh * 0.3, sw, sh * 0.3, { tl: 0, tr: 0, bl: 6, br: 6 });
          f.fillStyle(0xc9a832, 1);
          for (let i = 0; i < 6; i++) f.fillCircle(h.x - sw / 3 + (i % 3) * (sw / 3) + wob, h.y - sh / 4 + Math.floor(i / 3) * (sh / 4), 1.6);
        } else if (this.step() === 'iron') {
          const R = IRON_R * c.scale;
          f.fillStyle(this.hottest > 0.75 ? 0xff5030 : 0xd0d4dc, this.pointer ? 0.55 : 0.3);
          f.fillCircle(h.x, h.y, R);
          f.lineStyle(2, 0x30343c, 0.8).strokeCircle(h.x, h.y, R);
        }
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
