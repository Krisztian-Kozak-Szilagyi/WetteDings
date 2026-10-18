// Shop-Demo: Arbeitstisch direkt im Spiel (Phaser-Szene über dem Laden, Krisztian 2026-10-14): man sieht nur die
// Tischplatte mit der Karte – kein Fenster, kein Rahmen. Esc = aufstehen (der Auftrag bleibt am Tisch liegen).
// Die Minispiele sind Nachbauten des Grading-Tisches der Seite (public/js/grading.js) mit denselben Werten:
//   clean – Flecken mit dem Schwamm wegreiben (vorne und hinten, R = Karte umdrehen), Sauberkeit in % wie cleanliness()
//   iron  – Bügeleisen über den Knick ziehen: Stücke werden glatt, zu lange auf einer Stelle = Brandfleck
//   grade – Karte prüfen: Licht (D) über die Karte ziehen – Kratzer blitzen im Lichtfleck auf, Messen (M) zwei Linien an die Bildkanten →
//           Zentrierung, UV-Lampe (U) zeigt Ecken-/Kantenmacken; dann Note 1–10 (Server sagt die echte)
//   slab  – Zeiger pendelt, Leertaste/Klick stoppt ihn: je näher an der Mitte, desto sauberer versiegelt
//   foil  – Karte gerade in den TCG Sleeve schieben (schief = sie hakt), dann die zwei oberen Ecken umklappen
// Ergebnisse gehen an dieselben Adressen wie am Tisch der Seite (/shop-demo/werkbank/buegeln, …/benoten, …/fertig).
// Aufruf: ShopWerkbank.open(game, { job, station, csrf, onDone, onCancel }) – job = jobData von GET /api/shop-demo/werkbank
// WICHTIG: Phaser übernimmt bei Szenen als Objekt nur init/preload/create/update – eigene Methoden gehören in "extend"
// (test/shop-scenes.test.js spielt die Szene ohne Browser durch).
(function () {
  if (!window.Phaser) return;
  const KEY = 'werkbank';
  const CARD_RATIO = 1008 / 720;
  const CORNER = 0.055; // Eckenradius der Karte (Anteil der Breite, wie die Kartenbilder)
  const WEB_CARD_W = 290; // Kartenbreite am Tisch der Seite – Reib-Strecken werden darauf umgerechnet
  const CARD_MM = 63; // Kartenbreite in mm (Messen)
  // Vorderseite wie am Tisch der Seite: Bild 94 % × 95,72 % im Rand in Seltenheitsfarbe, seitlich verschoben (Zentrierung)
  const IMG_W = 0.94;
  const IMG_H = 0.9572;
  const RARITY_COLOR = { crumpled: 0xb8a07e, bfwler: 0x8fa3c7, gold: 0xe3b341, holo: 0xa8d8ff, bockhaber: 0xb48cf2, glitch: 0x4ade80, icon: 0xf3f5fe, boss: 0xd9a441, sith: 0x7a1915 };

  // wie public/js/grading.js
  const BRUSH = 16;
  const SPOT_EASE = { kaffee: 0.7 };
  const SPOT_COLOR = { fleck: 0x6b4423, staub: 0x8a8a80, finger: 0xb8a888, kaffee: 0x3b2412 };
  const IRON_SEGMENTS = 10;
  const IRON_R = 26;
  const FLAT_RATE = 1.5;
  const HEAT_RATE = 0.9;
  const COOL_RATE = 0.6;
  const UV_R = 64;
  const METER_MS = 850;
  const GRADE_NAMES = { 10: 'GEM MINT', 9: 'MINT', 8: 'NM-MT', 7: 'NEAR MINT', 6: 'EX-MT', 5: 'EXCELLENT', 4: 'VG-EX', 3: 'VERY GOOD', 2: 'GOOD', 1: 'POOR' };

  const STEPS = ['clean', 'iron', 'grade', 'slab', 'foil'];
  const LABEL = { clean: 'Putzen', iron: 'Bügeln', grade: 'Benoten', slab: 'Versiegeln', foil: 'Sleeve' };
  const HINT = {
    clean: 'Mit gedrückter Maus schrubben · R = Karte umdrehen',
    iron: 'Mit gedrückter Maus langsam über den Knick fahren – nicht stehen bleiben',
    grade: 'D Licht über die Karte ziehen (Kratzer blitzen auf) · M messen · U UV-Lampe · dann Note wählen',
    slab: 'Leertaste oder Klick: Zeiger in der Mitte stoppen',
    foil: 'Karte nach unten in den Sleeve ziehen – gerade halten',
  };
  const FOIL_TOL = 0.07; // so weit (Anteil der Kartenbreite) darf die Karte seitlich daneben sein, sonst hakt sie

  // ---------- Ton (leise, optional) ----------
  function tone(freq, ms, type, vol) {
    if (window.ShopSound) window.ShopSound.tone(freq, ms, type, vol || 0.03); // public/js/shop-sound.js
  }

  function post(url, csrf, fields) {
    const body = new URLSearchParams(Object.assign({ _csrf: csrf }, fields));
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then((r) => r.json())
      .then((res) => { if (res.error) throw new Error(res.error); return res; });
  }

  /** Bild mit abgerundeten Ecken als neue Textur (Rückseiten haben schwarze statt durchsichtige Ecken) */
  function roundedTexture(scene, key, cornerPart) {
    const out = key + '-rund';
    if (scene.textures.exists(out)) return out;
    if (!scene.textures.exists(key)) return null;
    const src = scene.textures.get(key).getSourceImage();
    const w = src.width;
    const h = src.height;
    const tex = scene.textures.createCanvas(out, w, h);
    if (!tex) return key;
    const ctx = tex.getContext();
    const r = w * (cornerPart || CORNER);
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

  const fmtMm = (v) => v.toFixed(1).replace('.', ',') + ' mm';

  /** Kleiner Knopf (Text mit Hintergrund) – gibt das Text-Objekt zurück */
  function button(scene, x, y, label, fn, opts) {
    const o = opts || {};
    const t = scene.add.text(x, y, label, {
      fontSize: o.size || '14px', color: o.color || '#ffffff', backgroundColor: o.bg || '#2a2f3c', padding: { x: o.px || 10, y: o.py || 6 },
    }).setOrigin(o.ox === undefined ? 0.5 : o.ox, o.oy === undefined ? 0.5 : o.oy).setInteractive({ useHandCursor: true });
    t.on('pointerdown', (p, lx, ly, ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); fn(); });
    return t;
  }

  const BenchScene = {
    key: KEY,
    init(data) { this.opts = data; },
    preload() {
      const job = this.opts.job;
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
      this.light = null; // Lichtfleck (Kartenanteile 0…1) beim Prüfen auf Kratzer
      this.mode = 'rotate';
      this.cameras.main.fadeIn(140, 0, 0, 0);

      // ---------- Tischplatte ----------
      const g = this.add.graphics();
      g.fillStyle(0x5b3d24, 1).fillRect(0, 0, W, H);
      const rnd = new Phaser.Math.RandomDataGenerator(['bank']);
      for (let i = 0; i < 60; i++) {
        g.lineStyle(rnd.between(1, 3), rnd.pick([0x4e331e, 0x684629, 0x553820]), 0.6);
        const y = rnd.between(0, H);
        g.lineBetween(0, y, W, y + rnd.between(-20, 20));
      }
      const cardH = Math.min(H * 0.74, (W - 40) * CARD_RATIO * 0.6);
      const cardW = cardH / CARD_RATIO;
      const mw = cardW * 2.1;
      const mh = cardH * 1.2;
      g.fillStyle(0x1f4f45, 1).fillRoundedRect(W / 2 - mw / 2, H / 2 - mh / 2, mw, mh, 14);
      g.lineStyle(1, 0x2f6a5c, 0.7);
      for (let x = W / 2 - mw / 2 + 20; x < W / 2 + mw / 2; x += 24) g.lineBetween(x, H / 2 - mh / 2, x, H / 2 + mh / 2);
      for (let y = H / 2 - mh / 2 + 20; y < H / 2 + mh / 2; y += 24) g.lineBetween(W / 2 - mw / 2, y, W / 2 + mw / 2, y);

      // ---------- Karte: alles in einem Container (Umdrehen/Kippen bewegen sie als Ganzes) ----------
      const cx = W / 2;
      const cy = H / 2;
      const scale = cardW / WEB_CARD_W;
      this.card = { x: cx - cardW / 2, y: cy - cardH / 2, w: cardW, h: cardH, scale, cx, cy };
      this.cardC = this.add.container(cx, cy);
      const shadow = this.add.graphics();
      shadow.fillStyle(0x000000, 0.35).fillRoundedRect(-cardW / 2 + 6, -cardH / 2 + 10, cardW, cardH, cardW * CORNER);
      // Vorderseite: Rand in Seltenheitsfarbe, Bild darin – seitlich verschoben um center.x (wie --cx am Tisch der Seite)
      const shift = job.center ? Number(job.center.x) || 0 : 0;
      this.imgEdge = { l: 0.03 * (1 + shift), r: 1 - 0.03 * (1 - shift) };
      this.front = this.add.container(0, 0);
      const border = this.add.graphics();
      border.fillStyle(RARITY_COLOR[job.card && job.card.rarity] || 0x1a1a1a, 1).fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, cardW * CORNER);
      this.front.add(border);
      const frontKey = job.card && job.card.image ? roundedTexture(this, 'wb:' + job.card.image) : null;
      const iw = cardW * IMG_W;
      const ih = cardH * IMG_H;
      const ix = -cardW / 2 + this.imgEdge.l * cardW + iw / 2;
      const iy = -cardH / 2 + cardH * 0.0214 + ih / 2;
      this.front.add(frontKey ? this.add.image(ix, iy, frontKey).setDisplaySize(iw, ih) : this.add.rectangle(ix, iy, iw, ih, 0xdddddd));
      const backKey = job.back ? roundedTexture(this, 'wb:' + job.back) : null;
      this.back = backKey ? this.add.image(0, 0, backKey).setDisplaySize(cardW, cardH) : this.add.rectangle(0, 0, cardW, cardH, 0x2a2440);
      this.back.setVisible(false);
      this.marks = this.add.graphics(); // Flecken, Knick, Mängel (Container-Koordinaten)
      this.glare = this.add.graphics(); // Lichtreflex beim Kippen
      this.slabG = this.add.graphics(); // Slab nach dem Versiegeln
      this.cardC.add([shadow, this.front, this.back, this.marks, this.glare, this.slabG]);
      if (this.make) {
        // Lichtfleck nur auf der Karte
        const mask = this.make.graphics({ add: false });
        mask.fillStyle(0xffffff, 1).fillRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, cardW * CORNER);
        this.glare.setMask(mask.createGeometryMask());
      }
      this.facingFront = true;
      this.uvShade = this.add.graphics(); // dunkelt beim UV-Licht alles außer dem Kegel ab
      this.fx = this.add.graphics(); // Schaum, Funken, Werkzeug, Messlinien (Bildschirm-Koordinaten)

      // ---------- Flecken (wie grading.js: hp 1 → 0, need in Pixeln Reibweg) ----------
      this.spots = (job.spots || []).map((s, i) => ({
        side: s.side, kind: s.kind, x: s.x / 100, y: s.y / 100, r: (s.r * 1.6) / 100 / 2, hp: 1,
        need: (90 + s.r * 8) * scale, ease: SPOT_EASE[s.kind] || 1, blobs: blobsFor(i),
      }));
      // ---------- Knick: 10 Stücke entlang der Linie (y in %, Winkel) ----------
      this.segs = [];
      if (job.crease) {
        const a = (job.crease.angle * Math.PI) / 180;
        for (let i = 0; i < IRON_SEGMENTS; i++) {
          const fx = (i + 0.5) / IRON_SEGMENTS;
          const fy = job.crease.y / 100 + (Math.tan(a) * (fx - 0.5) * cardW) / cardH;
          const done = !!job.iron;
          this.segs.push({ x: fx, y: fy, flat: done ? 1 : 0, heat: 0, burnt: false });
        }
      }
      this.defects = job.defects || {};
      this.guess = job.guess || null;
      this.grade = job.grade || null;
      this.guides = { l: 0.09, r: 0.91 }; // Messlinien (nicht an der Bildkante – messen muss man selbst)
      this.steps = (job.steps || []).filter((s) => STEPS.includes(s) && (s !== 'iron' || (this.segs.length && !job.iron)) && (s !== 'grade' || !job.guess));
      this.stepIndex = 0;

      // ---------- Anzeige (wenig Text) ----------
      this.ui = []; // Knöpfe des aktuellen Schritts
      this.stepText = this.add.text(W / 2, 18, '', { fontSize: '15px', color: '#fff3c8', backgroundColor: '#00000066', padding: { x: 10, y: 5 } }).setOrigin(0.5, 0);
      this.hint = this.add.text(W / 2, H - 16, '', { fontSize: '13px', color: '#e8dcc0', backgroundColor: '#00000066', padding: { x: 8, y: 4 } }).setOrigin(0.5, 1);
      this.info = this.add.text(W / 2, cy + cardH / 2 + 18, '', { fontSize: '14px', color: '#ffffff', backgroundColor: '#000000aa', padding: { x: 8, y: 4 }, align: 'center' }).setOrigin(0.5, 0).setVisible(false);
      this.add.text(14, 14, 'Esc = aufstehen', { fontSize: '12px', color: '#d8c8a8' });
      this.btn = this.add.text(W - 20, H - 20, '', { fontSize: '16px', color: '#ffffff', backgroundColor: '#2f9a5a', padding: { x: 14, y: 8 } })
        .setOrigin(1, 1).setInteractive({ useHandCursor: true });
      this.btn.on('pointerdown', () => this.finishStep());

      // ---------- Eingabe ----------
      this.pointer = null;
      this.input.on('pointerdown', (p) => this.down(p));
      this.input.on('pointermove', (p) => this.move(p));
      this.input.on('pointerup', (p) => this.up(p));
      this.input.keyboard.on('keydown-ESC', () => this.close(false));
      this.input.keyboard.on('keydown-R', () => this.flip()); // wie Möbel drehen im Laden
      this.input.keyboard.on('keydown-F', () => this.flip());
      this.input.keyboard.on('keydown-D', () => this.setMode('rotate'));
      this.input.keyboard.on('keydown-M', () => this.setMode('measure'));
      this.input.keyboard.on('keydown-U', () => this.setMode('uv'));
      this.input.keyboard.on('keydown-SPACE', () => { if (this.step() === 'slab') this.seal(); });

      if (!this.steps.length) { this.send(); return; }
      this.showStep();
    },

    extend: {
      step() { return this.steps[this.stepIndex]; },

      clearUi() {
        this.ui.forEach((o) => o.destroy());
        this.ui = [];
      },

      showStep() {
        const s = this.step();
        this.clearUi();
        this.info.setVisible(false);
        this.stepText.setText(this.steps.map((x, i) => (i < this.stepIndex ? '✓ ' : i === this.stepIndex ? '● ' : '○ ') + LABEL[x]).join('    '));
        this.hint.setText(HINT[s] || '');
        this.btn.setVisible(s === 'clean' || s === 'iron');
        this.btn.setText(s === 'clean' ? 'Fertig geputzt' : 'Fertig gebügelt');
        if ((s === 'iron' || s === 'grade' || s === 'slab') && !this.facingFront) this.flip(true); // vorne
        if (s === 'grade') this.buildGrade();
        if (s === 'slab') this.buildSlab();
        if (s === 'foil') this.buildFoil();
      },

      // ---------- Benoten ----------
      buildGrade() {
        const W = this.scale.width;
        const H = this.scale.height;
        const c = this.card;
        // Werkzeuge links neben der Karte
        const lx = c.x - 70;
        [['rotate', '💡 Licht (D)'], ['measure', '📏 Messen (M)'], ['uv', '🔦 UV (U)']].forEach(([m, label], i) => {
          const b = button(this, lx, c.cy - 50 + i * 44, label, () => this.setMode(m), { ox: 1 });
          b.modeKey = m;
          this.ui.push(b);
        });
        // Noten 1–10 unten
        const bw = Math.min(46, (W - 60) / 10);
        for (let n = 1; n <= 10; n++) {
          const b = button(this, W / 2 + (n - 5.5) * (bw + 4), H - 62, String(n), () => this.pickGrade(n), { size: '16px', px: 0, py: 8 });
          b.setFixedSize(bw, 0).setAlign('center');
          b.grade = n;
          this.ui.push(b);
        }
        this.okBtn = button(this, W - 20, H - 20, 'Note abgeben', () => this.submitGrade(), { bg: '#2f9a5a', size: '16px', ox: 1, oy: 1, px: 14, py: 8 });
        this.okBtn.setAlpha(0.4);
        this.ui.push(this.okBtn);
        this.chosen = null;
        this.setMode('rotate');
      },

      setMode(m) {
        if (this.step() !== 'grade' || this.guess) return;
        this.mode = m;
        this.ui.forEach((b) => { if (b.modeKey) b.setBackgroundColor(b.modeKey === m ? '#5a4a8a' : '#2a2f3c'); });
        this.measureText();
      },

      pickGrade(n) {
        if (this.guess || this.busy) return;
        this.chosen = n;
        this.ui.forEach((b) => { if (b.grade) b.setBackgroundColor(b.grade === n ? '#5a4a8a' : '#2a2f3c'); });
        this.okBtn.setAlpha(1);
      },

      submitGrade() {
        if (!this.chosen || this.guess || this.busy) return;
        this.busy = true;
        post('/shop-demo/werkbank/benoten', this.opts.csrf, { job: this.opts.job.id, tisch: this.opts.station || '', grade: String(this.chosen) })
          .then((res) => {
            this.busy = false;
            this.guess = res.guess;
            this.grade = res.grade;
            this.mode = 'rotate';
            const diff = Math.abs(res.guess - res.grade);
            tone(diff === 0 ? 1300 : diff === 1 ? 900 : 300, 220, 'triangle', 0.04);
            this.ui.forEach((b) => {
              if (!b.grade) return;
              b.setBackgroundColor(b.grade === res.grade ? '#2f9a5a' : b.grade === res.guess ? '#8a3a3a' : '#2a2f3c');
            });
            this.info.setText((diff === 0 ? 'Genau richtig! ' : diff === 1 ? 'Knapp daneben. ' : 'Daneben. ') + 'Note ' + res.grade + ' – ' + (GRADE_NAMES[res.grade] || '')).setVisible(true);
            this.okBtn.setText('Weiter');
            this.okBtn.removeAllListeners('pointerdown');
            this.okBtn.on('pointerdown', () => this.next());
          })
          .catch((err) => { this.busy = false; this.hint.setText(err.message); });
      },

      /** Rand in mm und Obergrenze aus den Messlinien */
      measureText() {
        if (this.step() !== 'grade' || this.mode !== 'measure') { if (!this.guess) this.info.setVisible(false); return; }
        const l = this.guides.l * CARD_MM;
        const r = (1 - this.guides.r) * CARD_MM;
        const big = Math.max(l, r) / Math.max(0.001, l + r) * 100;
        const scaleRow = (this.opts.job.centerScale || []).find((s) => big >= s.from - 0.5 && big <= s.to + 0.5);
        const ratio = Math.round(big) + '/' + (100 - Math.round(big));
        this.info.setText('Links ' + fmtMm(l) + ' · Rechts ' + fmtMm(r) + ' · ' + ratio + (scaleRow ? ' → höchstens ' + scaleRow.cap : '')).setVisible(true);
      },

      // ---------- Folieren ----------
      buildFoil() {
        const c = this.card;
        const side = Math.random() < 0.5 ? -1 : 1;
        this.foil = { phase: 'slide', dx: side * c.w * (0.1 + Math.random() * 0.12), dy: -c.h * 0.62, corners: {}, slideQ: null };
        this.cardC.setPosition(c.cx + this.foil.dx, c.cy + this.foil.dy);
        if (!this.foilG) this.foilG = this.add.graphics();
      },

      /** Ecken des Sleeves (Bildschirm) */
      sleeveRect() {
        const c = this.card;
        const sw = c.w * 1.06;
        const sh = c.h * 1.04;
        return { x: c.cx - sw / 2, y: c.cy - sh / 2, w: sw, h: sh, f: c.w * 0.14 };
      },

      foilDown(p) {
        const fo = this.foil;
        const c = this.card;
        if (fo.phase === 'slide') {
          const x0 = c.cx + fo.dx - c.w / 2;
          const y0 = c.cy + fo.dy - c.h / 2;
          if (p.x >= x0 && p.x <= x0 + c.w && p.y >= y0 && p.y <= y0 + c.h) fo.grab = true;
          return;
        }
        if (fo.phase === 'fold') {
          const r = this.sleeveRect();
          const hit = [['l', r.x, r.y], ['r', r.x + r.w, r.y]].find(([k, x, y]) => !(k in fo.corners) && Math.hypot(p.x - x, p.y - y) < r.f * 1.3);
          if (hit) fo.drag = { k: hit[0], x: p.x, y: p.y };
        }
      },

      foilMove(p, last) {
        const fo = this.foil;
        const c = this.card;
        if (fo.phase !== 'slide' || !fo.grab) return;
        fo.dx = Phaser.Math.Clamp(fo.dx + (p.x - last.x), -c.w * 0.4, c.w * 0.4);
        fo.dy = Phaser.Math.Clamp(fo.dy + (p.y - last.y), -c.h * 0.75, 0);
        // schief am Sleeve-Rand: hakt, kommt nicht tiefer
        if (fo.dy > -c.h * 0.12 && Math.abs(fo.dx) > c.w * FOIL_TOL) {
          fo.dy = -c.h * 0.12;
          this.hint.setText('Hakt – gerade halten!');
        }
        if (fo.dy >= -1) {
          fo.dy = 0;
          fo.grab = false;
          fo.phase = 'fold';
          fo.slideQ = Math.max(0, Math.round(100 - (Math.abs(fo.dx) / (c.w * FOIL_TOL)) * 100));
          tone(900, 120, 'triangle', 0.03);
          this.hint.setText('Jetzt die zwei oberen Ecken des Sleeves nach innen umklappen (ziehen)');
        }
        this.cardC.setPosition(c.cx + fo.dx, c.cy + fo.dy);
      },

      foilUp(p) {
        const fo = this.foil;
        if (!fo || !fo.drag) { if (fo) fo.grab = false; return; }
        const d = fo.drag;
        fo.drag = null;
        const vx = p.x - d.x;
        const vy = p.y - d.y;
        const len = Math.hypot(vx, vy);
        if (len < this.card.w * 0.06) return;
        // ideal: nach unten innen (links: ↘, rechts: ↙)
        const ideal = d.k === 'l' ? Math.atan2(1, 1) : Math.atan2(1, -1);
        let err = Math.abs(Math.atan2(vy, vx) - ideal) * (180 / Math.PI);
        if (err > 180) err = 360 - err;
        fo.corners[d.k] = Math.max(0, Math.round(100 - err * 2.2));
        tone(1200, 90, 'triangle', 0.03);
        if ('l' in fo.corners && 'r' in fo.corners) {
          fo.phase = 'done';
          this.foilQ = Math.round((fo.slideQ + fo.corners.l + fo.corners.r) / 3);
          this.info.setText(this.foilQ >= 90 ? 'Sauber eingesleevt! (' + this.foilQ + ' %)' : this.foilQ >= 70 ? 'Gut eingesleevt. (' + this.foilQ + ' %)' : 'Etwas schief … (' + this.foilQ + ' %)').setVisible(true);
          this.time.delayedCall(800, () => this.next());
        }
      },

      drawFoil() {
        const g = this.foilG;
        if (!g) return;
        g.clear();
        if (this.step() !== 'foil' || !this.foil) return;
        const r = this.sleeveRect();
        const fo = this.foil;
        g.fillStyle(0xdff0ff, 0.16).fillRect(r.x, r.y, r.w, r.h);
        g.lineStyle(2, 0xeaf6ff, 0.85);
        g.lineBetween(r.x, r.y, r.x, r.y + r.h);
        g.lineBetween(r.x, r.y + r.h, r.x + r.w, r.y + r.h);
        g.lineBetween(r.x + r.w, r.y + r.h, r.x + r.w, r.y);
        g.lineStyle(1, 0xeaf6ff, 0.4).lineBetween(r.x, r.y, r.x + r.w, r.y); // offene Oberkante
        [['l', r.x, 1], ['r', r.x + r.w, -1]].forEach(([k, x, dir]) => {
          if (k in fo.corners) {
            g.fillStyle(0xcfe6ff, 0.55).fillTriangle(x, r.y, x + dir * r.f, r.y, x, r.y + r.f);
            g.lineStyle(1.5, 0xffffff, 0.9).strokeTriangle(x, r.y, x + dir * r.f, r.y, x, r.y + r.f);
          } else if (fo.phase === 'fold') {
            const pulse = 0.5 + 0.5 * Math.sin(this.t * 6);
            g.lineStyle(2, 0xffd84a, 0.5 + 0.5 * pulse).strokeTriangle(x, r.y, x + dir * r.f, r.y, x, r.y + r.f);
          }
        });
      },

      // ---------- Versiegeln ----------
      buildSlab() {
        const W = this.scale.width;
        const H = this.scale.height;
        this.meter = { x: W / 2 - 160, y: H - 70, w: 320, on: true, t0: this.t, pos: 0 };
        this.ui.push(button(this, W - 20, H - 20, 'Versiegeln (Leertaste)', () => this.seal(), { bg: '#2f9a5a', size: '16px', ox: 1, oy: 1, px: 14, py: 8 }));
      },

      seal() {
        const m = this.meter;
        if (!m || !m.on || this.busy) return;
        m.on = false;
        const q = Math.max(0, Math.round(100 - Math.abs(m.pos - 50) * 4));
        this.sealQ = q;
        tone(q >= 90 ? 1500 : q >= 60 ? 1000 : 400, 200, 'triangle', 0.04);
        this.info.setText(q >= 90 ? 'Perfekt versiegelt! (' + q + ' %)' : q >= 60 ? 'Sauber versiegelt. (' + q + ' %)' : q > 0 ? 'Eine kleine Luftblase … (' + q + ' %)' : 'Schief eingeschweißt! (0 %)').setVisible(true);
        this.drawSlab();
        this.clearUi();
        this.time.delayedCall(900, () => this.next());
      },

      /** Slab um die Karte mit Etikett (Kürzel, Name, Notenwort, Note) */
      drawSlab() {
        const s = this.slabG;
        const c = this.card;
        const job = this.opts.job;
        s.clear();
        const pad = c.w * 0.06;
        const top = c.h * 0.2;
        s.fillStyle(0xdfeaf5, 0.22).fillRoundedRect(-c.w / 2 - pad, -c.h / 2 - top, c.w + pad * 2, c.h + top + pad, 10);
        s.lineStyle(3, 0xeaf2fa, 0.9).strokeRoundedRect(-c.w / 2 - pad, -c.h / 2 - top, c.w + pad * 2, c.h + top + pad, 10);
        s.fillStyle(0xf5f0e6, 1).fillRect(-c.w / 2, -c.h / 2 - top + pad * 0.6, c.w, top - pad * 1.2);
        const g = this.guess || 0;
        const ly = -c.h / 2 - top / 2;
        const t1 = this.add.text(-c.w / 2 + 8, ly, ((job.shop && job.shop.code) || 'SD') + ' GRADING\n' + (job.card ? job.card.name : ''), { fontSize: Math.round(11 * c.scale) + 'px', color: '#2a2a2a' }).setOrigin(0, 0.5);
        const t2 = this.add.text(c.w / 2 - 8, ly, (GRADE_NAMES[g] || '') + '\n' + (g || '–'), { fontSize: Math.round(13 * c.scale) + 'px', color: '#7a1915', align: 'right', fontStyle: 'bold' }).setOrigin(1, 0.5);
        this.cardC.add([t1, t2]);
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

      // ---------- Maus ----------
      down(p) {
        this.pointer = { x: p.x, y: p.y };
        this.hover = this.pointer;
        if (this.step() === 'grade' && this.mode === 'measure' && !this.guess) {
          // nächste Messlinie greifen (mit Versatz, kein Springen)
          const c = this.card;
          const fx = (p.x - c.x) / c.w;
          const k = Math.abs(fx - this.guides.l) <= Math.abs(fx - this.guides.r) ? 'l' : 'r';
          this.grab = Math.abs(fx - this.guides[k]) < 0.08 ? { k, off: this.guides[k] - fx } : null;
        }
        if (this.step() === 'slab' && this.meter && this.meter.on && !this.onCard(p.x, p.y)) this.seal();
        if (this.step() === 'foil' && this.foil) this.foilDown(p);
      },

      move(p) {
        const last = this.pointer || { x: p.x, y: p.y };
        this.hover = { x: p.x, y: p.y };
        if (!p.isDown) return;
        const dist = Math.hypot(p.x - last.x, p.y - last.y);
        this.pointer = { x: p.x, y: p.y };
        const s = this.step();
        if (s === 'foil' && this.foil) this.foilMove(p, last);
        if (s === 'clean' && !this.flipping) this.rub(p.x, p.y, dist);
        if (s === 'grade' && !this.guess) {
          if (this.mode === 'rotate') {
            // Licht über die Karte ziehen (Krisztian, 2026-10-14: Kippen per Stauchen sah falsch aus)
            const c = this.card;
            this.light = { fx: Phaser.Math.Clamp((p.x - c.x) / c.w, 0, 1), fy: Phaser.Math.Clamp((p.y - c.y) / c.h, 0, 1) };
          } else if (this.mode === 'measure' && this.grab) {
            const c = this.card;
            let v = Phaser.Math.Clamp((p.x - c.x) / c.w + this.grab.off, 0, 1);
            const edge = this.grab.k === 'l' ? this.imgEdge.l : this.imgEdge.r;
            if (Math.abs(v - edge) < 0.004) v = edge; // leichter Magnet an der Bildkante
            if (this.grab.k === 'l') v = Math.min(v, this.guides.r - 0.2);
            else v = Math.max(v, this.guides.l + 0.2);
            this.guides[this.grab.k] = v;
            this.measureText();
          }
        }
      },

      up(p) {
        if (this.step() === 'foil' && this.foil && p) this.foilUp(p);
        this.pointer = null;
        this.grab = null;
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
        if (this.step() !== 'iron') return;
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
              if (res.defects) this.defects = res.defects;
              this.hint.setText('Zu ' + res.smooth + ' % glatt' + (res.burns ? ' · ' + res.burns + ' Brandfleck' + (res.burns === 1 ? '' : 'e') : ''));
              this.time.delayedCall(1100, () => { this.busy = false; this.next(); });
            })
            .catch((err) => { this.busy = false; this.hint.setText(err.message); });
          return;
        }
        if (s === 'clean') this.next();
      },

      next() {
        this.stepIndex += 1;
        if (this.stepIndex >= this.steps.length) this.send();
        else this.showStep();
      },

      send() {
        this.busy = true;
        this.btn.setVisible(false);
        this.clearUi();
        this.hint.setText('Fertig!');
        post('/shop-demo/werkbank/fertig', this.opts.csrf, {
          job: this.opts.job.id, tisch: this.opts.station || '',
          clean: String(this.cleanliness()), seal: this.sealQ === undefined ? '' : String(this.sealQ),
          foil: this.foilQ === undefined ? '' : String(this.foilQ),
        })
          .then((res) => this.time.delayedCall(500, () => this.close(true, res)))
          .catch((err) => { this.busy = false; this.btn.setVisible(true); this.hint.setText(err.message); });
      },

      /** Aufstehen: kurz abblenden, dann zurück in den Laden (erst danach baut der Laden sein Bild neu auf) */
      close(done, res) {
        if (this.closed) return;
        this.closed = true;
        const o = this.opts;
        const cam = this.cameras.main;
        cam.once('camerafadeoutcomplete', () => {
          this.scene.stop();
          if (done && o.onDone) o.onDone(res);
          if (!done && o.onCancel) o.onCancel();
        });
        cam.fadeOut(150, 0, 0, 0);
      },

      /** Flecken, Knick und Mängel in Container-Koordinaten zeichnen */
      drawMarks() {
        const m = this.marks;
        const c = this.card;
        m.clear();
        const local = (p) => ({ x: p.x - c.cx, y: p.y - c.cy });
        this.spots.forEach((s) => {
          if (s.hp <= 0 || (s.side === 'f') !== this.facingFront) return;
          const p = local(this.toScreen(s.x, s.y));
          const a = 0.12 + 0.7 * Math.pow(s.hp, 0.8);
          const r = s.r * c.w * (0.55 + 0.45 * s.hp) * (s.kind === 'fleck' ? 1 + 0.6 * s.hp * (1 - s.hp) : 1);
          const col = SPOT_COLOR[s.kind] || 0x6b4423;
          s.blobs.forEach((b) => { m.fillStyle(col, a * (b.dx || b.dy ? 0.55 : 0.8)); m.fillCircle(p.x + b.dx * r, p.y + b.dy * r, r * b.rr); });
          if (s.kind === 'finger') { m.lineStyle(1.2, 0x7a6a50, 0.55 * a); for (let k = 0.3; k < 1; k += 0.18) m.strokeEllipse(p.x, p.y, r * k * 1.6, r * k * 2); }
        });
        if (!this.facingFront) return;
        // Knick
        if (this.segs.length && (this.step() === 'iron' || !this.defects.ironed || this.segs.some((s) => s.flat < 1))) {
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
        if (this.step() !== 'grade' && this.step() !== 'slab') return;
        const d = this.defects;
        const revealed = !!this.guess;
        // Kratzer: blitzen auf, wo der Lichtfleck darüber liegt (nach dem Benoten rot); immer innerhalb der Karte
        const LR = 0.24; // Radius des Lichtflecks (Anteil der Kartenbreite)
        (d.scratches || []).forEach((sc) => {
          const a = (sc.angle * Math.PI) / 180;
          const x0 = Phaser.Math.Clamp(sc.x / 100, 0.03, 0.97);
          const y0 = Phaser.Math.Clamp(sc.y / 100, 0.03, 0.97);
          const endX = (k) => x0 + Math.cos(a) * (sc.len / 100) * k;
          const endY = (k) => y0 + (Math.sin(a) * (sc.len / 100) * k * c.w) / c.h;
          let t = 1;
          while (t > 0 && (endX(t) < 0.03 || endX(t) > 0.97 || endY(t) < 0.03 || endY(t) > 0.97)) t -= 0.05;
          if (t <= 0) return;
          let vis = revealed ? 1 : 0;
          if (!revealed && this.light && this.mode === 'rotate') {
            const dist = Math.hypot(((x0 + endX(t)) / 2 - this.light.fx) * c.w, ((y0 + endY(t)) / 2 - this.light.fy) * c.h) / (LR * c.w);
            vis = Phaser.Math.Clamp(1.4 - dist * 1.4, 0, 1);
          }
          if (!vis) return;
          const p = local(this.toScreen(x0, y0));
          const q = local(this.toScreen(endX(t), endY(t)));
          m.lineStyle(2, revealed ? 0xef4444 : 0xffffff, vis);
          m.lineBetween(p.x, p.y, q.x, q.y);
        });
        // Ecken- und Kantenmacken: leicht hell, unter der UV-Lampe grün
        const uv = this.mode === 'uv' && this.hover && !revealed ? this.hover : null;
        const R = UV_R * c.scale;
        const dent = (fx, fy, rw, rh) => {
          const sp = this.toScreen(fx, fy);
          const lit = uv && Math.hypot(uv.x - sp.x, uv.y - sp.y) <= R + Math.max(rw, rh);
          const p = local(sp);
          m.fillStyle(revealed ? 0xef4444 : lit ? 0x4dff8a : 0xffffff, revealed || lit ? 0.9 : 0.35);
          m.fillEllipse(p.x, p.y, rw, rh);
        };
        // Ecken/Kanten: knapp innerhalb des Kartenrands (nicht darüber hinaus)
        (d.corners || []).forEach((k) => dent(k === 1 || k === 2 ? 0.96 : 0.04, k >= 2 ? 0.972 : 0.028, c.w * 0.05, c.w * 0.05));
        (d.edges || []).forEach((n) => {
          const pos = Phaser.Math.Clamp(n.pos / 100, 0.06, 0.94);
          if (n.side === 0) dent(pos, 0.01, c.w * 0.05, c.h * 0.012);
          else if (n.side === 2) dent(pos, 0.99, c.w * 0.05, c.h * 0.012);
          else if (n.side === 1) dent(0.986, pos, c.w * 0.018, c.h * 0.036);
          else dent(0.014, pos, c.w * 0.018, c.h * 0.036);
        });
      },
    },

    update(time, delta) {
      if (this.closed || !this.card) return;
      const dt = Math.min(0.05, delta / 1000);
      this.t += dt;
      this.ironTick(dt);
      this.drawMarks();
      this.drawFoil();
      const c = this.card;
      const gl = this.glare;
      gl.clear();
      // Lichtfleck beim Prüfen: weicher heller Kreis, nur auf der Karte (Maske in create)
      if (this.step() === 'grade' && this.mode === 'rotate' && this.light && !this.guess) {
        const lx = (this.light.fx - 0.5) * c.w;
        const ly = (this.light.fy - 0.5) * c.h;
        for (let k = 6; k >= 1; k--) {
          gl.fillStyle(0xffffff, 0.05);
          gl.fillCircle(lx, ly, c.w * 0.24 * (k / 6));
        }
      }
      const f = this.fx;
      f.clear();
      // UV-Lampe: alles dunkel außer dem Lichtkegel
      const us = this.uvShade;
      us.clear();
      if (this.step() === 'grade' && this.mode === 'uv' && !this.guess && this.hover) {
        const R = UV_R * c.scale;
        // dunkel nur AUSSERHALB des Kegels: dicker Ring statt Fläche (im Kegel bleibt die Karte klar)
        us.lineStyle(4000, 0x0a0420, 0.5).strokeCircle(this.hover.x, this.hover.y, R + 2000);
        f.fillStyle(0x8a5cff, 0.08).fillCircle(this.hover.x, this.hover.y, R);
        f.lineStyle(2, 0xb48cf2, 0.7).strokeCircle(this.hover.x, this.hover.y, R);
      }
      // Messlinien
      if (this.step() === 'grade' && this.mode === 'measure' && !this.guess) {
        ['l', 'r'].forEach((k) => {
          const x = c.x + this.guides[k] * c.w;
          const snapped = Math.abs(this.guides[k] - (k === 'l' ? this.imgEdge.l : this.imgEdge.r)) < 1e-6;
          f.lineStyle(2, snapped ? 0x4fd17a : 0xffd84a, 0.95);
          f.lineBetween(x, c.y - 14, x, c.y + c.h + 14);
          f.fillStyle(snapped ? 0x4fd17a : 0xffd84a, 1).fillTriangle(x - 7, c.y + c.h + 26, x + 7, c.y + c.h + 26, x, c.y + c.h + 14);
        });
      }
      // Versiegeln: pendelnder Zeiger
      const mt = this.meter;
      if (this.step() === 'slab' && mt) {
        if (mt.on) {
          const p = (((this.t - mt.t0) * 1000) / METER_MS) % 2;
          mt.pos = (p < 1 ? p : 2 - p) * 100;
        }
        f.fillStyle(0x1c1f2b, 0.9).fillRoundedRect(mt.x - 6, mt.y - 14, mt.w + 12, 28, 8);
        f.fillStyle(0x3a3f52, 1).fillRect(mt.x, mt.y - 6, mt.w, 12);
        f.fillStyle(0x4fd17a, 1).fillRect(mt.x + mt.w * 0.45, mt.y - 6, mt.w * 0.1, 12);
        f.fillStyle(0xffffff, 1).fillRect(mt.x + (mt.pos / 100) * mt.w - 2, mt.y - 12, 4, 24);
      }
      // Schaum und Funken
      this.foam = this.foam.filter((b) => (b.t -= dt) > 0);
      this.foam.forEach((b) => {
        b.y -= dt * 6;
        f.fillStyle(0xffffff, Math.min(0.85, b.t));
        f.fillCircle(b.x, b.y, b.r);
        f.lineStyle(1, 0xd8e8f0, Math.min(0.6, b.t)).strokeCircle(b.x, b.y, b.r);
      });
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
