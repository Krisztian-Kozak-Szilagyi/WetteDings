// Shop-Demo: Kassieren als Minispiel (Phaser-Szene über dem Laden). Schritte (ORDER, erweiterbar):
//   haggle – nur manchmal: der Kunde will weniger zahlen; annehmen, Gegenangebot oder ablehnen (nie eine schlechtere
//            Bewertung deswegen – Krisztian, 2026-10-17). Antwort aus ShopCustomers.haggleAnswer
//   scan   – jedes Teil anklicken (Piep), die Summe läuft mit
//   pay    – Karte: Betrag am Terminal eintippen · Bar: Wechselgeld aus der Lade zusammenklicken; Falschgeld (nur bei
//            Kunden mit Illegalem) mit der UV-Lampe prüfen und ablehnen
// Aufruf: ShopKasse.open(game, { title, lines: [{ name, qty, price, color }], total, haggle, pay: { method, given, fake },
//   rng, answer, onDone, onCancel }) → onDone({ deal, method, lost, short, walk })
// WICHTIG: Phaser übernimmt bei Szenen als Objekt nur init/preload/create/update – hier läuft alles in create (Closures).
(function () {
  if (!window.Phaser) return;
  const KEY = 'kasse';
  const fmt = (n) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const c2 = (n) => Math.round(n * 100) / 100;
  const MAX_PIECES = 24;
  const DENOMS = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.01];

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

  const STEPS = {
    // ---------- Feilschen ----------
    haggle: {
      start(ctx) {
        const h = ctx.data.haggle;
        const total = ctx.full;
        ctx.say('„' + fmt(total) + '? Machst du mir ' + fmt(h.offer) + '?“');
        ctx.hint('Annehmen, Gegenangebot oder ablehnen');
        let counter = c2((h.offer + total) / 2);
        const finish = (ans) => {
          ctx.clearPanel();
          if (ans.walk) { ctx.say('„Dann lass ich es.“'); ctx.scene.time.delayedCall(900, () => ctx.done({ walk: true })); return; }
          ctx.deal = ans.deal;
          ctx.say(ans.full ? '„Na gut, dann eben so.“' : '„Abgemacht!“');
          ctx.scene.time.delayedCall(700, () => ctx.next());
        };
        ctx.panelButton('Annehmen (' + fmt(h.offer) + ')', 0, () => finish({ deal: h.offer }));
        const val = ctx.panelText('Gegenangebot: ' + fmt(counter), 1);
        ctx.panelButton('−', 2, () => { counter = Math.max(h.offer, c2(counter - Math.max(1, total * 0.02))); val.setText('Gegenangebot: ' + fmt(counter)); }, 60);
        ctx.panelButton('+', 2, () => { counter = Math.min(total, c2(counter + Math.max(1, total * 0.02))); val.setText('Gegenangebot: ' + fmt(counter)); }, 60, 70);
        ctx.panelButton('Anbieten', 3, () => finish(ctx.data.answer(h, counter, total)));
        ctx.panelButton('Ablehnen', 4, () => finish(ctx.data.answer(h, null, total)));
      },
    },
    // ---------- Scannen ----------
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
    // ---------- Bezahlen ----------
    pay: {
      start(ctx) {
        const pay = Object.assign({ method: 'card' }, ctx.data.pay);
        const due = ctx.deal !== null ? ctx.deal : ctx.full;
        const C = window.ShopCustomers;
        if (pay.method === 'cash' && !pay.given) {
          pay.given = C.cashGiven(due, ctx.data.rng || Math.random);
          pay.fake = C.fakeBill(ctx.data.customer, pay.given, ctx.data.rng || Math.random);
        }
        ctx.setTotal(due);
        if (pay.method === 'card') STEPS.pay.card(ctx, due);
        else STEPS.pay.cash(ctx, due, pay);
      },
      card(ctx, due) {
        ctx.say('„Mit Karte, bitte.“');
        ctx.hint('Betrag am Terminal eintippen (auch Tastatur) und OK');
        let typed = '';
        const show = ctx.panelText('Terminal: ' + (typed || '0'), 0);
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'];
        const press = (k) => {
          if (k === '⌫') typed = typed.slice(0, -1);
          else if (k === ',') { if (!typed.includes(',')) typed += ','; } else if (typed.length < 9) typed += k;
          show.setText('Terminal: ' + (typed || '0'));
        };
        keys.forEach((k, i) => ctx.panelButton(k, 1 + Math.floor(i / 3), () => press(k), 52, (i % 3) * 58));
        const ok = () => {
          const v = Number(typed.replace(',', '.'));
          if (Math.abs(v - due) < 0.005) { beep(900, 120); ctx.result.method = 'card'; ctx.clearPanel(); ctx.next(); return; }
          beep(200, 200);
          typed = '';
          show.setText('Terminal: falscher Betrag – nochmal');
        };
        ctx.panelButton('OK', 5, ok);
        ctx.keys((e) => {
          if (/^[0-9]$/.test(e.key)) press(e.key);
          else if (e.key === ',' || e.key === '.') press(',');
          else if (e.key === 'Backspace') press('⌫');
          else if (e.key === 'Enter') ok();
        });
      },
      cash(ctx, due, pay) {
        const scene = ctx.scene;
        let given = pay.given.slice();
        let fake = pay.fake;
        let uv = false;
        const change = [];
        ctx.say('„Bar, bitte.“');
        ctx.hint('Wechselgeld aus der Lade zusammenklicken · UV prüft die Scheine');
        // Geld des Kunden auf der Theke
        const money = [];
        const drawGiven = () => {
          money.forEach((o) => o.destroy());
          money.length = 0;
          given.forEach((b, i) => {
            const x = ctx.area.x + 40 + i * 80;
            const y = ctx.area.y + ctx.area.h - 40;
            const r = scene.add.rectangle(x, y, 70, 36, 0x7fb07a).setStrokeStyle(2, 0x2e5a2a).setInteractive({ useHandCursor: true });
            const t = scene.add.text(x, y, fmt(b), { fontSize: '13px', color: '#102010' }).setOrigin(0.5);
            r.on('pointerdown', () => {
              if (!uv) return;
              if (i === fake) {
                r.setFillStyle(0xd05050);
                t.setText('FALSCH');
                ctx.panelButton('Schein ablehnen', 6, () => {
                  beep(500, 120);
                  ctx.say('„Oh … dann den hier.“');
                  fake = -1; // gibt einen echten
                  drawGiven();
                });
              } else { r.setFillStyle(0x9fe0a0); }
            });
            money.push(r, t);
          });
        };
        drawGiven();
        const sumGiven = () => c2(given.reduce((a, b) => a + b, 0));
        const changeDue = () => c2(sumGiven() - due);
        const info = ctx.panelText('', 0);
        const showInfo = () => info.setText('Gegeben ' + fmt(sumGiven()) + ' · Rückgeld ' + fmt(changeDue()) + '\nIn der Hand: ' + fmt(c2(change.reduce((a, b) => a + b, 0))));
        showInfo();
        DENOMS.forEach((d, i) => ctx.panelButton(fmt(d), 1 + Math.floor(i / 4), () => { change.push(d); beep(1100, 30); showInfo(); }, 62, (i % 4) * 66));
        ctx.panelButton('↺ Zurück', 4, () => { change.length = 0; showInfo(); }, 100);
        ctx.panelButton('UV', 4, () => { uv = !uv; ctx.hint(uv ? 'UV an: Schein anklicken' : 'Wechselgeld aus der Lade zusammenklicken · UV prüft die Scheine'); }, 60, 110);
        ctx.panelButton('Herausgeben', 5, () => {
          const r = window.ShopCustomers.changeResult(due, given, change);
          ctx.result.method = 'cash';
          ctx.result.lost = c2(r.over + (fake >= 0 ? given[fake] : 0));
          ctx.result.short = r.short > 0;
          beep(r.short || r.over ? 300 : 900, 150);
          if (r.short > 0) ctx.say('„Da fehlen ' + fmt(r.short) + '!“');
          else if (r.over > 0) ctx.say('„Oh, danke!“ (' + fmt(r.over) + ' zu viel)');
          ctx.clearPanel();
          scene.time.delayedCall(700, () => ctx.next());
        });
      },
    },
  };

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
      const pw = Math.min(860, W - 40);
      const ph = Math.min(460, H - 80);
      const left = cx - pw / 2;
      const top = cy - ph / 2;
      const scene = this;

      this.add.rectangle(0, 0, W, H, 0x000000, 0.55).setOrigin(0).setInteractive();
      this.add.rectangle(cx, cy, pw, ph, 0x7a5a3a).setStrokeStyle(3, 0x3a2a1a);
      const regX = left + pw - 170;
      this.add.rectangle(regX, top + 60, 290, 80, 0x22262f).setStrokeStyle(2, 0x111318);
      this.add.text(regX, top + 34, d.title || 'Kasse', { fontSize: '13px', color: '#9aa0b4' }).setOrigin(0.5);
      const totalText = this.add.text(regX, top + 68, '0,00', { fontSize: '30px', color: '#7dffa6', fontFamily: 'monospace' }).setOrigin(0.5);
      const bagX = left + 70;
      const bagY = top + 60;
      this.add.rectangle(bagX, bagY, 100, 70, 0xe8dcc0).setStrokeStyle(2, 0x9a8a6a);
      this.add.text(bagX, bagY, 'Tüte', { fontSize: '12px', color: '#6a5a3a' }).setOrigin(0.5);
      const hintText = this.add.text(cx, top - 18, '', { fontSize: '15px', color: '#fff3c8' }).setOrigin(0.5);
      const sayText = this.add.text(left + 140, top + 30, '', { fontSize: '14px', color: '#1c1f2b', backgroundColor: '#fff3c8', padding: { x: 8, y: 4 }, wordWrap: { width: pw - 470 } });
      this.add.text(left + 8, top + ph + 10, 'Esc = abbrechen (der Kunde wartet weiter)', { fontSize: '12px', color: '#9aa0b4' });

      // Waren auf der Theke (links), große Mengen gestapelt
      const area = { x: left + 30, y: top + 110, w: pw - 360, h: ph - 140 };
      const pieces = [];
      const all = [];
      d.lines.forEach((l) => {
        const n = Math.max(1, l.qty);
        const single = Math.min(n, Math.max(1, Math.floor(MAX_PIECES / d.lines.length)));
        for (let i = 0; i < single; i++) all.push({ line: l, count: i === single - 1 ? n - (single - 1) : 1 });
      });
      const cols = Math.max(1, Math.floor(area.w / 70));
      all.forEach((a, i) => {
        const x = area.x + 30 + (i % cols) * 70;
        const y = area.y + 20 + Math.floor(i / cols) * 70;
        const box = this.add.rectangle(x, y, 52, 52, a.line.color || 0xcccccc).setStrokeStyle(2, 0x1c1f2b);
        const label = this.add.text(x, y, (a.count > 1 ? '×' + a.count + '\n' : '') + a.line.name.slice(0, 10), { fontSize: '9px', color: '#111', align: 'center', wordWrap: { width: 50 } }).setOrigin(0.5);
        pieces.push({ box, label, price: a.line.price, count: a.count });
      });

      // Bedienfeld rechts (Knöpfe des aktuellen Schritts)
      const panelX = regX - 135;
      const panelY = top + 116;
      let panel = [];
      let keyHandler = null;
      let total = 0;
      let step = -1;
      const full = d.total !== undefined ? d.total : d.lines.reduce((a, l) => a + l.qty * l.price, 0);
      const order = (d.haggle ? ['haggle'] : []).concat(['scan', 'pay']);
      const ctx = {
        scene, pieces, bagX, bagY, area, data: d, full: c2(full), deal: null,
        result: { method: 'card', lost: 0, short: false },
        addToTotal(v) { total += v; totalText.setText(fmt(total)); },
        setTotal(v) { total = v; totalText.setText(fmt(total)); },
        hint(t) { hintText.setText(t); },
        say(t) { sayText.setText(t); },
        clearPanel() { panel.forEach((o) => o.destroy()); panel = []; if (keyHandler) { scene.input.keyboard.off('keydown', keyHandler); keyHandler = null; } },
        panelText(t, row) { const o = scene.add.text(panelX, panelY + row * 40, t, { fontSize: '13px', color: '#fff', backgroundColor: '#00000088', padding: { x: 6, y: 4 } }); panel.push(o); return o; },
        panelButton(label, row, fn, w, dx) {
          const o = scene.add.text(panelX + (dx || 0), panelY + row * 40, label, { fontSize: '14px', color: '#fff', backgroundColor: '#2f6f5a', padding: { x: 8, y: 6 }, fixedWidth: w || 0, align: 'center' })
            .setInteractive({ useHandCursor: true });
          o.on('pointerdown', fn);
          panel.push(o);
          return o;
        },
        keys(fn) { keyHandler = fn; scene.input.keyboard.on('keydown', fn); },
        next() {
          step += 1;
          if (step >= order.length) { ctx.done({}); return; }
          STEPS[order[step]].start(ctx);
        },
        done(extra) {
          scene.close(true, Object.assign({ deal: ctx.deal, method: ctx.result.method, lost: ctx.result.lost, short: ctx.result.short, walk: false }, extra));
        },
      };
      this.close = (ok, res) => {
        if (this.closed) return;
        this.closed = true;
        ctx.clearPanel();
        this.scene.stop();
        if (ok && d.onDone) d.onDone(res);
        if (!ok && d.onCancel) d.onCancel();
      };
      this.input.keyboard.on('keydown-ESC', () => this.close(false));
      ctx.next();
    },
  };

  window.ShopKasse = {
    STEPS, DENOMS,
    isOpen(game) { return !!(game && game.scene.isActive(KEY)); },
    open(game, data) {
      if (!game.scene.getScene(KEY)) game.scene.add(KEY, KasseScene, false);
      game.scene.start(KEY, data);
      game.scene.bringToTop(KEY);
    },
  };
})();
