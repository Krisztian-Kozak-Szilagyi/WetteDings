// Shop-Demo: Laden einrichten in 2:1-Isometrie (Phaser). Möbel sind Platzhalter-Klötze in Gruppenfarbe
// (Daten: GET /api/shop-demo, Regeln: window.ShopLayout = src/shop/layout.js). Jede Aktion wird sofort lokal
// geprüft und gezeichnet und dann an POST /api/shop-demo geschickt; lehnt der Server ab, gilt sein Stand.
// Raster: Zelle (x, y) → Bildschirm ((x − y)·32, (x + y)·16); Wand 'n' liegt bei y = 0, Wand 'w' bei x = 0.
(function () {
  const root = document.querySelector('[data-shop-root]');
  if (!root || !window.Phaser || !window.ShopLayout) return;
  const L = window.ShopLayout;
  const $ = (sel) => document.querySelector(sel);

  const TW = 32; // halbe Kachelbreite
  const TH = 16; // halbe Kachelhöhe
  const WALL_H = 96;
  const fmt = (n) => Number(n).toLocaleString('de-DE');
  const iso = (x, y, z) => ({ x: (x - y) * TW, y: (x + y) * TH - (z || 0) });

  let state = null;
  let catalog = {};
  let list = [];
  let groups = {};
  let unitPrice = 0;
  let showNames = true;

  // Modus: null | { kind: 'place', id, rot } | { kind: 'move', uid, id, rot }
  let mode = null;
  let selected = null; // uid
  let hover = null; // { x, y } Zelle unter der Maus (Bruchteile)
  let scene = null;

  // ---------- Server ----------
  function send(action) {
    const body = new URLSearchParams({ _csrf: root.dataset.csrf, aktion: JSON.stringify(action) });
    return fetch('/api/shop-demo', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then((r) => r.json().catch(() => ({ error: 'Fehler beim Speichern.' })))
      .then((res) => {
        if (res.error) toast(res.error);
        if (res.state) { state = res.state; refresh(); }
      })
      .catch(() => toast('Keine Verbindung – Änderung nicht gespeichert.'));
  }

  /** Lokal prüfen + zeichnen, dann speichern */
  function act(action) {
    const r = L.apply(state, catalog, Object.assign({ price: unitPrice }, action));
    if (r.error) { toast(r.error); return false; }
    state = r.state;
    refresh();
    send(action);
    return true;
  }

  // ---------- Hinweise ----------
  let toastTimer = 0;
  function toast(msg) {
    const el = $('[data-shop-toast]');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function ask(text, withInput, value) {
    const dlg = $('[data-shop-dialog]');
    const input = $('[data-shop-dialog-input]');
    $('[data-shop-dialog-text]').textContent = text;
    input.hidden = !withInput;
    if (withInput) input.value = value;
    dlg.returnValue = '';
    dlg.showModal();
    if (withInput) input.select();
    return new Promise((resolve) => {
      dlg.addEventListener('close', function done() {
        dlg.removeEventListener('close', done);
        resolve(dlg.returnValue === 'ok' ? (withInput ? input.value : true) : null);
      });
    });
  }

  // ---------- Seitenleiste ----------
  function buildList() {
    const box = $('[data-shop-list]');
    box.textContent = '';
    let last = '';
    list.forEach((d) => {
      if (d.group !== last) {
        last = d.group;
        const h = document.createElement('div');
        h.className = 'sd-group';
        h.textContent = groups[d.group].name;
        box.appendChild(h);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sd-item';
      b.dataset.id = d.id;
      b.title = d.utility + (d.capacity ? ' · ' + d.capacity : '');
      const sw = document.createElement('span');
      sw.className = 'sd-swatch';
      sw.style.background = '#' + groups[d.group].color.toString(16).padStart(6, '0');
      const name = document.createElement('span');
      name.className = 'sd-item-name';
      name.textContent = d.name;
      const price = document.createElement('span');
      price.className = 'sd-item-price';
      price.textContent = fmt(d.price);
      const meta = document.createElement('span');
      meta.className = 'sd-item-meta';
      meta.textContent = d.layer === 'wand' ? 'Wand · ' + d.w + ' breit' : d.layer === 'theke' ? 'auf eine Theke' : d.w + '×' + d.d + ' Felder';
      b.append(sw, name, price, meta);
      b.addEventListener('click', () => {
        if (mode && mode.kind === 'place' && mode.id === d.id) return setMode(null);
        select(null);
        setMode({ kind: 'place', id: d.id, rot: 0 });
      });
      box.appendChild(b);
    });
  }

  function refreshSide() {
    $('[data-shop-coins-value]').textContent = fmt(state.coins);
    document.querySelectorAll('.sd-item').forEach((b) => {
      b.disabled = catalog[b.dataset.id].price > state.coins;
      b.classList.toggle('is-active', !!(mode && mode.kind === 'place' && mode.id === b.dataset.id));
    });
    const panel = $('[data-shop-panel]');
    const it = selected && state.items.find((i) => i.uid === selected);
    if (!it) { selected = null; panel.hidden = true; return; }
    const d = catalog[it.id];
    $('[data-shop-panel-name]').textContent = d.name;
    $('[data-shop-panel-info]').textContent = d.utility + (d.capacity ? ' · ' + d.capacity : '');
    $('[data-shop-panel-refund]').textContent = '(+' + fmt(d.price) + ')';
    panel.querySelector('[data-shop-do="rotate"]').hidden = d.layer !== 'boden' || d.w === d.d;
    panel.hidden = !!mode;
  }

  function setMode(m) {
    mode = m;
    refresh();
  }

  function select(uid) {
    selected = uid;
    refresh();
  }

  // ---------- Kandidat unter der Maus ----------
  function candidate() {
    if (!mode || !hover) return null;
    const d = catalog[mode.id];
    if (d.layer === 'wand') {
      const onN = hover.y <= hover.x;
      const pos = Math.floor((onN ? hover.x : hover.y) - d.w / 2 + 0.5);
      return onN ? { id: d.id, x: pos, y: 0, wall: 'n', rot: 0 } : { id: d.id, x: 0, y: pos, wall: 'w', rot: 0 };
    }
    const s = L.size(d, mode.rot);
    return { id: d.id, x: Math.floor(hover.x - s.w / 2 + 0.5), y: Math.floor(hover.y - s.d / 2 + 0.5), rot: mode.rot };
  }

  function commit() {
    const c = candidate();
    if (!c) return;
    if (mode.kind === 'place') {
      if (act(Object.assign({ type: 'place' }, c)) && !(scene && scene.shiftDown)) setMode(null);
    } else if (act(Object.assign({ type: 'move', uid: mode.uid }, c))) {
      const uid = mode.uid;
      mode = null;
      select(uid);
    }
  }

  // ---------- Zeichnen ----------
  function shade(color, f) {
    const c = Phaser.Display.Color.IntegerToColor(color);
    const k = (v) => Math.max(0, Math.min(255, Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f))));
    return Phaser.Display.Color.GetColor(k(c.red), k(c.green), k(c.blue));
  }

  function poly(g, pts, color, alpha, line) {
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach((p) => g.lineTo(p.x, p.y));
    g.closePath();
    g.fillPath();
    if (line) {
      g.lineStyle(1, line, alpha);
      g.strokePath();
    }
  }

  /** Klotz mit Grundfläche w×d ab Zelle (x, y), Höhe h, von Höhe z0 aus */
  function box(g, x, y, w, d, h, z0, color, alpha, outline) {
    const m = 0.06;
    const x0 = x + m, y0 = y + m, x1 = x + w - m, y1 = y + d - m;
    const P = (px, py, z) => iso(px, py, z0 + z);
    const top = [P(x0, y0, h), P(x1, y0, h), P(x1, y1, h), P(x0, y1, h)];
    poly(g, [P(x0, y1, 0), P(x1, y1, 0), P(x1, y1, h), P(x0, y1, h)], color, alpha, outline);
    poly(g, [P(x1, y1, 0), P(x1, y0, 0), P(x1, y0, h), P(x1, y1, h)], shade(color, -0.3), alpha, outline);
    poly(g, top, shade(color, 0.25), alpha, outline);
    return [P(x0, y0, h), P(x1, y0, h), P(x1, y0, 0), P(x1, y1, 0), P(x0, y1, 0), P(x0, y1, h)];
  }

  /** Bild an der Wand: Rechteck auf der Wandfläche */
  function wallBox(g, it, d, color, alpha, outline) {
    const z0 = 34;
    const z1 = z0 + d.height;
    const a = it.wall === 'n' ? [it.x + 0.1, 0] : [0, it.y + 0.1];
    const b = it.wall === 'n' ? [it.x + d.w - 0.1, 0] : [0, it.y + d.w - 0.1];
    const pts = [iso(a[0], a[1], z0), iso(b[0], b[1], z0), iso(b[0], b[1], z1), iso(a[0], a[1], z1)];
    poly(g, pts, it.wall === 'n' ? shade(color, 0.1) : color, alpha, outline);
    return pts;
  }

  function counterUnder(it) {
    const key = it.x + ',' + it.y;
    return state.items.find((o) => catalog[o.id].counter && L.cells(catalog[o.id], o).includes(key));
  }

  /** Zeichnet ein Teil, gibt Umriss (für die Maus) und Tiefe zurück */
  function drawItem(g, it, color, alpha, outline) {
    const d = catalog[it.id];
    if (d.layer === 'wand') return { hull: wallBox(g, it, d, color, alpha, outline), depth: -5000 + (it.wall === 'n' ? it.x : it.y) };
    const s = L.size(d, it.rot);
    let z0 = 0;
    let depth = (it.x + s.w / 2 + it.y + s.d / 2) * 10;
    if (d.layer === 'theke') {
      const base = counterUnder(it);
      if (base) {
        z0 = catalog[base.id].height;
        const bs = L.size(catalog[base.id], base.rot);
        depth = (base.x + bs.w / 2 + base.y + bs.d / 2) * 10 + 1;
      }
    }
    if (d.layer === 'flach') depth = -8000 + it.x + it.y;
    return { hull: box(g, it.x, it.y, s.w, s.d, d.height, z0, color, alpha, outline), depth: depth, top: iso(it.x + s.w / 2, it.y + s.d / 2, z0 + d.height) };
  }

  const GameScene = {
    key: 'shop',
    create: function () {
      scene = this;
      this.cameras.main.setBackgroundColor('#14161f');
      this.floor = this.add.graphics().setDepth(-10000);
      this.walls = this.add.graphics().setDepth(-9000);
      this.ghost = this.add.graphics().setDepth(20000);
      this.items = [];
      this.labels = [];
      this.extra = [];
      this.hulls = [];
      this.cameras.main.centerOn(0, L.UNIT_D * TH);
      this.cameras.main.setZoom(window.innerWidth < 900 ? 0.9 : 1.3);

      const keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SHIFT,R,ESC,DELETE', false); // false: Tasten im Dialog-Eingabefeld nicht schlucken
      this.keys = keys;
      keys.R.on('down', rotate);
      keys.ESC.on('down', () => { if (mode) setMode(null); else select(null); });
      keys.DELETE.on('down', () => { if (selected && !mode) giveBack(); });

      let drag = null;
      this.input.mouse && this.input.mouse.disableContextMenu();
      const setHover = (p) => { hover = { x: (p.worldX / TW + p.worldY / TH) / 2, y: (p.worldY / TH - p.worldX / TW) / 2 }; };
      this.input.on('pointerdown', (p) => {
        setHover(p);
        if (p.rightButtonDown()) { if (mode) setMode(null); else drag = { x: p.x, y: p.y, cam: true }; return; }
        if (mode) { drag = { x: p.x, y: p.y, cam: false, place: true }; return; }
        const hit = pick(p.worldX, p.worldY);
        drag = { x: p.x, y: p.y, cam: !hit, uid: hit, moved: false };
      });
      this.input.on('pointermove', (p) => {
        setHover(p);
        if (drag && p.isDown) {
          const dist = Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y);
          if (drag.cam && dist > 3) {
            const cam = this.cameras.main;
            cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
            cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
            drag.moved = true;
          } else if (drag.uid && !drag.moved && dist > 6) {
            drag.moved = true;
            startMove(drag.uid);
          }
        }
        drawGhost();
      });
      this.input.on('pointerup', (p) => {
        const d = drag;
        drag = null;
        if (!d) return;
        if (d.place || (mode && mode.kind === 'move' && d.uid)) { commit(); return; }
        if (d.cam && !d.moved && !p.rightButtonReleased()) {
          const unit = Math.floor(hover.x / L.UNIT_W);
          if (unit === state.units && unit < L.MAX_UNITS && hover.y >= 0 && hover.y < L.UNIT_D) buyUnit();
          else select(null);
        }
        if (d.uid && !d.moved) select(d.uid);
      });
      this.input.on('wheel', (p, objs, dx, dy) => {
        const cam = this.cameras.main;
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.4, 2.5));
      });

      drawAll();
    },
    update: function (time, dt) {
      const k = this.keys;
      this.shiftDown = k.SHIFT.isDown;
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      const cam = this.cameras.main;
      const v = (0.6 * dt) / cam.zoom;
      if (k.A.isDown || k.LEFT.isDown) cam.scrollX -= v;
      if (k.D.isDown || k.RIGHT.isDown) cam.scrollX += v;
      if (k.W.isDown || k.UP.isDown) cam.scrollY -= v;
      if (k.S.isDown || k.DOWN.isDown) cam.scrollY += v;
    },
  };

  function pick(wx, wy) {
    for (let i = scene.hulls.length - 1; i >= 0; i--) {
      const h = scene.hulls[i];
      if (Phaser.Geom.Polygon.Contains(new Phaser.Geom.Polygon(h.hull), wx, wy)) return h.uid;
    }
    return null;
  }

  function drawFloor() {
    const g = scene.floor;
    const w = scene.walls;
    g.clear();
    w.clear();
    for (let u = 0; u < L.MAX_UNITS; u++) {
      const owned = u < state.units;
      const next = u === state.units;
      for (let x = u * L.UNIT_W; x < (u + 1) * L.UNIT_W; x++) {
        for (let y = 0; y < L.UNIT_D; y++) {
          const door = owned && L.DOOR.some((c) => c.x === x && c.y === y);
          const col = door ? 0x5a4632 : owned ? ((x + y) % 2 ? 0x8a6a48 : 0x93724f) : next ? 0x2c3040 : 0x23262f;
          poly(g, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], col, 1, owned ? 0x6e5236 : 0x1a1c24);
        }
        // Gehweg vor dem Laden
        for (let y = L.UNIT_D; y < L.UNIT_D + 2; y++) {
          poly(g, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], 0x3a3d47, 1, 0x30333c);
        }
        // Rückwand rechts ('n')
        const wc = owned ? 0xc9bfae : 0x4a4d58;
        poly(w, [iso(x, 0), iso(x + 1, 0), iso(x + 1, 0, WALL_H), iso(x, 0, WALL_H)], wc, 1, shade(wc, -0.2));
      }
      if (!owned) {
        // Rollladen zur Nachbar-Einheit
        const sx = u * L.UNIT_W;
        for (let y = 0; y < L.UNIT_D; y++) {
          poly(w, [iso(sx, y), iso(sx, y + 1), iso(sx, y + 1, 54), iso(sx, y, 54)], next ? 0x6d717e : 0x55585f, 0.92, 0x3b3e46);
        }
      }
    }
    // Rückwand links ('w')
    for (let y = 0; y < L.UNIT_D; y++) {
      poly(w, [iso(0, y), iso(0, y + 1), iso(0, y + 1, WALL_H), iso(0, y, WALL_H)], 0xb3a998, 1, 0x948a7a);
    }
  }

  function drawAll() {
    if (!scene) return;
    drawFloor();
    scene.items.forEach((o) => o.destroy());
    scene.labels.forEach((o) => o.destroy());
    scene.extra.forEach((o) => o.destroy());
    scene.items = [];
    scene.labels = [];
    scene.extra = [];
    scene.hulls = [];

    // Eingang + Zu-verkaufen-Schild
    const door = iso(L.DOOR[1].x, L.UNIT_D + 0.6);
    scene.extra.push(scene.add.text(door.x, door.y, 'Eingang', { fontSize: '12px', color: '#c9c4b8' }).setOrigin(0.5).setDepth(-7000));
    if (state.units < L.MAX_UNITS) {
      const c = iso(state.units * L.UNIT_W + L.UNIT_W / 2, L.UNIT_D / 2);
      const t = scene.add.text(c.x, c.y, 'Zu verkaufen\n' + fmt(unitPrice) + ' Kanacoin\n(klicken)', {
        fontSize: '14px', color: state.coins >= unitPrice ? '#f0d48a' : '#8a8f9c', align: 'center', backgroundColor: '#1c1f2bcc', padding: { x: 8, y: 6 },
      });
      scene.extra.push(t.setOrigin(0.5).setDepth(-6000));
    }

    const drawn = state.items.map((it) => {
      const g = scene.add.graphics();
      const color = groups[catalog[it.id].group].color;
      const moving = mode && mode.kind === 'move' && mode.uid === it.uid;
      const r = drawItem(g, it, color, moving ? 0.25 : 1, it.uid === selected ? 0xffffff : shade(color, -0.55));
      g.setDepth(r.depth);
      scene.items.push(g);
      if (!moving) scene.hulls.push({ uid: it.uid, hull: r.hull, depth: r.depth });
      return { it, r };
    });
    scene.hulls.sort((a, b) => a.depth - b.depth);

    if (showNames) {
      drawn.forEach(({ it, r }) => {
        const d = catalog[it.id];
        const p = r.top || r.hull[0];
        const t = scene.add.text(p.x, p.y - 4, d.name, { fontSize: '10px', color: '#ffffff', backgroundColor: '#00000088', padding: { x: 3, y: 1 } });
        scene.labels.push(t.setOrigin(0.5, 1).setDepth(15000).setResolution(2));
      });
    }
    drawGhost();
  }

  function drawGhost() {
    if (!scene) return;
    const g = scene.ghost;
    g.clear();
    const c = candidate();
    if (!c) return;
    const ok = L.check(state, catalog, c, mode.kind === 'move' ? mode.uid : undefined).ok && (mode.kind === 'move' || state.coins >= catalog[c.id].price);
    const col = ok ? 0x4fd17a : 0xe0525a;
    const d = catalog[c.id];
    if (d.layer !== 'wand' && d.layer !== 'theke') {
      L.cells(d, c).forEach((k) => {
        const [x, y] = k.split(',').map(Number);
        poly(g, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], col, 0.35);
      });
    }
    drawItem(g, c, col, 0.55, col);
  }

  function refresh() {
    refreshSide();
    drawAll();
  }

  // ---------- Aktionen ----------
  function rotate() {
    if (mode) {
      const d = catalog[mode.id];
      if (d.layer === 'boden' || d.layer === 'flach') { mode.rot = mode.rot ? 0 : 1; drawGhost(); }
      return;
    }
    const it = selected && state.items.find((i) => i.uid === selected);
    if (!it) return;
    act({ type: 'move', uid: it.uid, x: it.x, y: it.y, rot: it.rot ? 0 : 1, wall: it.wall });
  }

  function startMove(uid) {
    const it = state.items.find((i) => i.uid === uid);
    if (!it) return;
    selected = uid;
    setMode({ kind: 'move', uid: uid, id: it.id, rot: it.rot });
  }

  function giveBack() {
    const it = state.items.find((i) => i.uid === selected);
    if (!it) return;
    selected = null;
    act({ type: 'remove', uid: it.uid });
  }

  function buyUnit() {
    if (state.coins < unitPrice) return toast('Nicht genug Kanacoin.');
    ask('Nachbar-Fläche für ' + fmt(unitPrice) + ' Kanacoin kaufen?').then((ok) => { if (ok) act({ type: 'buyUnit' }); });
  }

  document.querySelectorAll('[data-shop-do]').forEach((b) => {
    b.addEventListener('click', () => {
      const what = b.dataset.shopDo;
      if (what === 'rotate') rotate();
      else if (what === 'move') startMove(selected);
      else giveBack();
    });
  });

  $('[data-shop-coins]').addEventListener('click', () => {
    ask('Kanacoin festlegen (Demo-Geld):', true, state.coins).then((v) => {
      if (v === null || v === '') return;
      act({ type: 'setCoins', amount: Math.floor(Number(v)) });
    });
  });

  $('[data-shop-reset]').addEventListener('click', () => {
    ask('Laden leeren und mit ' + fmt(L.START_COINS) + ' Kanacoin neu starten?').then((ok) => {
      if (!ok) return;
      mode = null;
      selected = null;
      act({ type: 'reset' });
    });
  });

  $('[data-shop-names]').addEventListener('change', (e) => {
    showNames = e.target.checked;
    drawAll();
  });

  // ---------- Start ----------
  fetch('/api/shop-demo', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then((r) => r.json())
    .then((data) => {
      state = data.state;
      list = data.catalog;
      groups = data.groups;
      unitPrice = data.unitPrice;
      catalog = Object.fromEntries(list.map((d) => [d.id, d]));
      buildList();
      refreshSide();
      new Phaser.Game({
        type: Phaser.AUTO,
        parent: document.querySelector('[data-shop-stage]'),
        backgroundColor: '#14161f',
        scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
        banner: false,
        scene: GameScene,
      });
    })
    .catch(() => toast('Laden konnte nicht geladen werden.'));
})();
