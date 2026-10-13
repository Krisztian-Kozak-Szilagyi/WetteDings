// Shop-Demo: eigener Laden in 2:1-Isometrie (Phaser) mit Figur. WASD laufen, E benutzen (PC, Regal, Karton),
// Q Karton abstellen. Am PC (Kassentheke) werden Möbel und Ware bestellt und Preise gesetzt; Bestelltes kommt als
// Karton auf den Gehweg vor dem Eingang und muss hineingetragen, eingeräumt bzw. aufgebaut werden.
// Möbel/Ware sind Platzhalter-Klötze in Gruppenfarbe (Daten: GET /api/shop-demo, Regeln: window.ShopLayout =
// src/shop/layout.js). Jede Aktion wird sofort lokal geprüft und gezeichnet und dann an POST /api/shop-demo
// geschickt; lehnt der Server ab, gilt sein Stand.
// Raster: Zelle (x, y) → Bildschirm ((x − y)·32, (x + y)·16); Wand 'n' liegt bei y = 0, Wand 'w' bei x = 0.
(function () {
  const root = document.querySelector('[data-shop-root]');
  if (!root || !window.Phaser || !window.ShopLayout || !window.ShopCustomers) return;
  const L = window.ShopLayout;
  const C = window.ShopCustomers;
  const $ = (sel) => document.querySelector(sel);

  const TW = 32; // halbe Kachelbreite
  const TH = 16; // halbe Kachelhöhe
  const WALL_H = 96;
  const SPEED = 3.6; // Zellen pro Sekunde
  const REACH = 0.85; // so nah muss man an einem Möbel stehen
  const fmt = (n) => Number(n).toLocaleString('de-DE', { maximumFractionDigits: 2 });
  const iso = (x, y, z) => ({ x: (x - y) * TW, y: (x + y) * TH - (z || 0) });
  const hex = (c) => '#' + c.toString(16).padStart(6, '0');

  let state = null;
  let catalog = {};
  let list = [];
  let goods = {};
  let goodsList = [];
  let groups = {};
  let unitPrice = 0;
  let showNames = true;

  // Modus: null | { kind: 'build', id, rot } (Möbel aus dem Karton) | { kind: 'move', uid, id, rot }
  let mode = null;
  let selected = null; // uid
  let hover = null; // Zelle unter der Maus (Bruchteile)
  let scene = null;
  const player = { x: 4, y: L.UNIT_D + 0.8 };
  let target = null; // { label, run } – was E gerade tun würde
  let shelfUid = null; // offenes Regal-Fenster
  let pcTab = 'moebel';

  const doAct = (type, extra) => Object.assign({ type }, extra);

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
    const r = L.apply(state, catalog, goods, Object.assign({ price: unitPrice }, action));
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

  const dialogOpen = () => !!document.querySelector('dialog[open]');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const hand = () => (state && state.carry ? state.boxes.find((b) => b.bid === state.carry) : null);
  const boxName = (b) => (b.kind === 'moebel' ? catalog[b.id].name : goods[b.id].name + ' ×' + b.qty);

  // ---------- HUD ----------
  function refreshHud() {
    $('[data-shop-coins-value]').textContent = fmt(state.coins);
    const h = hand();
    const handEl = $('[data-shop-hand]');
    handEl.hidden = !h;
    if (h) handEl.textContent = 'In der Hand: Karton ' + boxName(h) + (h.kind === 'moebel' ? ' · E aufbauen' : '');
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

  // ---------- PC ----------
  const PC_TABS = [
    ['moebel', 'Möbel bestellen'],
    ['ware', 'Ware bestellen'],
    ['preise', 'Preise'],
    ['bestand', 'Bestand'],
    ['verkauf', 'Verkäufe / Tag'],
    ['bewertungen', 'Bewertungen'],
    ['belege', 'Belege'],
    '–',
    ['ruf', 'Ruf'],
    ['lizenzen', 'Lizenzen'],
    ['kleidung', 'Kleidung'],
    ['propaganda', 'Propaganda drucken'],
    ['level', 'Level'],
  ];
  const LATER = ['ruf', 'lizenzen', 'kleidung', 'propaganda', 'level'];

  function openPc() {
    const dlg = $('[data-shop-pc]');
    renderPc();
    if (!dlg.open) dlg.showModal();
  }

  function renderPc() {
    const dlg = $('[data-shop-pc]');
    $('[data-shop-pc-coins]').textContent = fmt(state.coins);
    const tabs = $('[data-shop-tabs]');
    tabs.textContent = '';
    PC_TABS.forEach((t) => {
      if (t === '–') { tabs.appendChild(el('div', 'sd-tab-sep', 'Kommt später')); return; }
      const b = el('button', 'sd-tab' + (t[0] === pcTab ? ' is-active' : '') + (LATER.includes(t[0]) ? ' is-later' : ''), t[1]);
      b.type = 'button';
      b.addEventListener('click', () => { pcTab = t[0]; renderPc(); });
      tabs.appendChild(b);
    });
    const body = $('[data-shop-tab-body]');
    const keep = body.scrollTop;
    body.textContent = '';
    if (pcTab === 'moebel') pcMoebel(body);
    else if (pcTab === 'ware') pcWare(body);
    else if (pcTab === 'preise') pcPreise(body);
    else if (pcTab === 'bestand') pcBestand(body);
    else if (pcTab === 'verkauf') pcVerkauf(body);
    else if (pcTab === 'bewertungen') pcBewertungen(body);
    else if (pcTab === 'belege') pcBelege(body);
    else body.appendChild(el('p', 'sd-later', 'Kommt später – hier ist erst der Platz vorgesehen.'));
    body.scrollTop = keep;
    return dlg;
  }

  function table(head) {
    const t = el('table', 'sd-table');
    const tr = el('tr');
    head.forEach(([txt, num]) => tr.appendChild(el('th', num ? 'num' : '', txt)));
    t.appendChild(el('thead')).appendChild(tr);
    return { t, tb: t.appendChild(el('tbody')) };
  }

  function pcMoebel(body) {
    let last = '';
    let tb = null;
    list.forEach((d) => {
      if (d.group !== last) {
        last = d.group;
        body.appendChild(el('div', 'sd-group', groups[d.group].name));
        const t = table([['Möbel'], ['Größe'], ['Preis', 1], ['']]);
        body.appendChild(t.t);
        tb = t.tb;
      }
      const tr = el('tr');
      const name = el('td');
      const sw = el('span', 'sd-swatch');
      sw.style.background = hex(groups[d.group].color);
      name.append(sw, d.name);
      name.appendChild(el('span', 'sub', d.utility));
      tr.appendChild(name);
      tr.appendChild(el('td', '', d.layer === 'wand' ? 'Wand, ' + d.w + ' breit' : d.layer === 'theke' ? 'auf Theke' : d.w + '×' + d.d + (d.slots ? ' · ' + d.slots + ' Plätze' : '')));
      tr.appendChild(el('td', 'num', fmt(d.price)));
      const td = el('td', 'num');
      const b = el('button', 'sd-btn', 'Bestellen');
      b.type = 'button';
      b.disabled = d.price > state.coins;
      b.addEventListener('click', () => { if (act(doAct('orderMoebel', { id: d.id }))) renderPc(); });
      td.appendChild(b);
      tr.appendChild(td);
      tb.appendChild(tr);
    });
  }

  function pcWare(body) {
    const { t, tb } = table([['Ware'], ['Karton', 1], ['Einkauf/Stück', 1], ['Karton-Preis', 1], ['']]);
    goodsList.forEach((g) => {
      const tr = el('tr');
      const name = el('td');
      const sw = el('span', 'sd-swatch');
      sw.style.background = hex(g.color);
      name.append(sw, g.name);
      name.appendChild(el('span', 'sub', 'Marktpreis ' + fmt(g.market)));
      tr.appendChild(name);
      tr.appendChild(el('td', 'num', g.perBox + ' Stück'));
      tr.appendChild(el('td', 'num', fmt(g.buy)));
      const boxCost = g.buy * g.perBox;
      tr.appendChild(el('td', 'num', fmt(boxCost)));
      const td = el('td', 'num');
      const b = el('button', 'sd-btn', '1 Karton');
      b.type = 'button';
      b.disabled = boxCost > state.coins;
      b.addEventListener('click', () => { if (act(doAct('orderWare', { id: g.id, n: 1 }))) renderPc(); });
      td.appendChild(b);
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    body.appendChild(t);
    body.appendChild(el('p', 'sd-later', 'Bestelltes landet als Karton auf dem Gehweg vor dem Eingang.'));
  }

  function priceInput(id) {
    const inp = el('input');
    inp.type = 'number';
    inp.min = '0';
    inp.step = '0.01';
    inp.value = L.price(state, goods, id);
    inp.addEventListener('change', () => {
      const v = Number(String(inp.value).replace(',', '.'));
      if (act(doAct('setPrice', { ware: id, price: v }))) inp.value = L.price(state, goods, id);
    });
    return inp;
  }

  /** Stückzahl im Laden: in Regalen / in Kartons */
  function counts(id) {
    const shelf = state.items.reduce((a, it) => a + ((it.stock && it.stock[id]) || 0), 0);
    const boxes = state.boxes.reduce((a, b) => a + (b.kind === 'ware' && b.id === id ? b.qty : 0), 0);
    return { shelf, boxes };
  }

  function pcPreise(body) {
    const { t, tb } = table([['Ware'], ['Einkauf', 1], ['Marktpreis', 1], ['Dein Preis', 1]]);
    goodsList.forEach((g) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', g.name));
      tr.appendChild(el('td', 'num', fmt(g.buy)));
      tr.appendChild(el('td', 'num', fmt(g.market)));
      const td = el('td', 'num');
      td.appendChild(priceInput(g.id));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  function pcBestand(body) {
    const { t, tb } = table([['Ware'], ['In Regalen', 1], ['In Kartons', 1], ['Dein Preis', 1]]);
    goodsList.forEach((g) => {
      const c = counts(g.id);
      const tr = el('tr');
      tr.appendChild(el('td', '', g.name));
      tr.appendChild(el('td', 'num', String(c.shelf)));
      tr.appendChild(el('td', 'num', String(c.boxes)));
      tr.appendChild(el('td', 'num', fmt(L.price(state, goods, g.id))));
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  // ---------- Regal ----------
  function openShelf(uid) {
    shelfUid = uid;
    renderShelf();
    const dlg = $('[data-shop-shelf]');
    if (!dlg.open) dlg.showModal();
  }

  function renderShelf() {
    const dlg = $('[data-shop-shelf]');
    const it = state.items.find((i) => i.uid === shelfUid);
    if (!it) { if (dlg.open) dlg.close(); return; }
    const d = catalog[it.id];
    $('[data-shop-shelf-name]').textContent = d.name;
    $('[data-shop-shelf-used]').textContent = L.used(it) + ' / ' + d.slots + ' Plätze belegt';
    const body = $('[data-shop-shelf-body]');
    body.textContent = '';
    const ids = Object.keys(it.stock || {});
    if (!ids.length) body.appendChild(el('p', 'sd-later', 'Leer. Bring einen Karton und drück E.'));
    else {
      const { t, tb } = table([['Ware'], ['Stück', 1], ['Preis', 1], ['']]);
      const h = hand();
      ids.forEach((id) => {
        const tr = el('tr');
        tr.appendChild(el('td', '', goods[id].name));
        tr.appendChild(el('td', 'num', String(it.stock[id])));
        const tdp = el('td', 'num');
        tdp.appendChild(priceInput(id));
        tr.appendChild(tdp);
        const td = el('td', 'num');
        const b = el('button', 'sd-btn', 'Herausnehmen');
        b.type = 'button';
        b.disabled = !!(h && (h.kind !== 'ware' || h.id !== id));
        b.addEventListener('click', () => { act(doAct('unstock', { uid: it.uid, ware: id })); renderShelf(); });
        td.appendChild(b);
        tr.appendChild(td);
        tb.appendChild(tr);
      });
      body.appendChild(t);
    }
    body.appendChild(el('p', 'sd-shelf-fits', 'Passt hinein: ' + d.holds.map((id) => goods[id] && goods[id].name).filter(Boolean).join(', ')));
  }

  // ---------- Kandidat unter der Maus (Aufbauen/Verschieben) ----------
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
    if (mode.kind === 'build') {
      if (act(doAct('build', c))) mode = null;
      refresh();
    } else if (act(doAct('move', Object.assign({ uid: mode.uid }, c)))) {
      const uid = mode.uid;
      mode = null;
      selected = uid;
      refresh();
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

  /** Klotz mit Grundfläche w×d ab (x, y), Höhe h, von Höhe z0 aus; m = Rand */
  function box(g, x, y, w, d, h, z0, color, alpha, outline, m) {
    m = m === undefined ? 0.06 : m;
    const x0 = x + m, y0 = y + m, x1 = x + w - m, y1 = y + d - m;
    const P = (px, py, z) => iso(px, py, z0 + z);
    poly(g, [P(x0, y1, 0), P(x1, y1, 0), P(x1, y1, h), P(x0, y1, h)], color, alpha, outline);
    poly(g, [P(x1, y1, 0), P(x1, y0, 0), P(x1, y0, h), P(x1, y1, h)], shade(color, -0.3), alpha, outline);
    poly(g, [P(x0, y0, h), P(x1, y0, h), P(x1, y1, h), P(x0, y1, h)], shade(color, 0.25), alpha, outline);
    return [P(x0, y0, h), P(x1, y0, h), P(x1, y0, 0), P(x1, y1, 0), P(x0, y1, 0), P(x0, y1, h)];
  }

  /** Inhalt eines Regals als farbige Streifen auf der Vorderseite (später: Bilder der Ware) */
  function drawStock(g, it, s, d, z0) {
    if (!d.slots || !it.stock) return;
    const m = 0.06;
    const x0 = it.x + m, x1 = it.x + s.w - m, y1 = it.y + s.d - m, y0 = it.y + m;
    const front = s.w >= s.d; // Ware auf der längeren sichtbaren Seite
    const len = front ? x1 - x0 : y1 - y0;
    let t = 0;
    const za = z0 + d.height * 0.2;
    const zb = z0 + d.height * 0.8;
    Object.keys(it.stock).forEach((id) => {
      const part = (it.stock[id] / d.slots) * len;
      const a = t;
      const b = t + part;
      t = b;
      const pts = front
        ? [iso(x0 + a, y1, za), iso(x0 + b, y1, za), iso(x0 + b, y1, zb), iso(x0 + a, y1, zb)]
        : [iso(x1, y1 - a, za), iso(x1, y1 - b, za), iso(x1, y1 - b, zb), iso(x1, y1 - a, zb)];
      poly(g, pts, goods[id] ? goods[id].color : 0xffffff, 0.95, 0x000000);
    });
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

  /** Zeichnet ein Teil, gibt Umriss (für die Maus), Tiefe und Oberkante zurück */
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
    const hull = box(g, it.x, it.y, s.w, s.d, d.height, z0, color, alpha, outline);
    if (alpha === 1) drawStock(g, it, s, d, z0);
    return { hull: hull, depth: depth, top: iso(it.x + s.w / 2, it.y + s.d / 2, z0 + d.height) };
  }

  function drawCarton(g, x, y, z, kindColor, alpha) {
    box(g, x - 0.2, y - 0.2, 0.4, 0.4, 14, z, 0xa07a4a, alpha, 0x5a4024, 0);
    poly(g, [iso(x - 0.2, y + 0.2, z + 5), iso(x + 0.2, y + 0.2, z + 5), iso(x + 0.2, y + 0.2, z + 9), iso(x - 0.2, y + 0.2, z + 9)], kindColor, alpha);
  }

  const cartonColor = (b) => (b.kind === 'moebel' ? groups[catalog[b.id].group].color : goods[b.id].color);

  const GameScene = {
    key: 'shop',
    create: function () {
      scene = this;
      this.cameras.main.setBackgroundColor('#14161f');
      this.floor = this.add.graphics().setDepth(-10000);
      this.walls = this.add.graphics().setDepth(-9000);
      this.ghost = this.add.graphics().setDepth(20000);
      this.hero = this.add.graphics();
      this.prompt = this.add.text(0, 0, '', { fontSize: '12px', color: '#fff3c8', backgroundColor: '#1c1f2bdd', padding: { x: 6, y: 3 } })
        .setOrigin(0.5, 1).setDepth(30000).setResolution(2);
      this.items = [];
      this.bubbles = [];
      this.labels = [];
      this.extra = [];
      this.hulls = [];
      const start = iso(player.x, player.y);
      this.cameras.main.centerOn(start.x, start.y - 60);
      this.cameras.main.setZoom(window.innerWidth < 900 ? 1 : 1.4);

      // false: Tasten in Eingabefeldern (Preise, Dialog) nicht schlucken
      const keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,R,E,Q,ESC,DELETE', false);
      this.keys = keys;
      const free = () => !dialogOpen();
      keys.R.on('down', () => { if (free()) rotate(); });
      keys.E.on('down', () => { if (free() && !mode && target) target.run(); });
      keys.Q.on('down', () => { if (free() && !mode && hand()) dropHere(); });
      keys.ESC.on('down', () => { if (!free()) return; if (mode) { mode = null; refresh(); } else select(null); });
      keys.DELETE.on('down', () => { if (free() && selected && !mode) giveBack(); });

      let drag = null;
      if (this.input.mouse) this.input.mouse.disableContextMenu();
      const setHover = (p) => { hover = { x: (p.worldX / TW + p.worldY / TH) / 2, y: (p.worldY / TH - p.worldX / TW) / 2 }; };
      this.input.on('pointerdown', (p) => {
        setHover(p);
        if (p.rightButtonDown()) { if (mode) { mode = null; refresh(); } return; }
        if (mode) { drag = { place: true }; return; }
        drag = { x: p.x, y: p.y, uid: pick(p.worldX, p.worldY), moved: false };
      });
      this.input.on('pointermove', (p) => {
        setHover(p);
        if (drag && drag.uid && p.isDown && !drag.moved && Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) > 6) {
          drag.moved = true;
          startMove(drag.uid);
        }
        drawGhost();
      });
      this.input.on('pointerup', () => {
        const d = drag;
        drag = null;
        if (!d) return;
        if (d.place || (d.moved && mode && mode.kind === 'move')) { commit(); return; }
        if (d.uid) { select(d.uid); return; }
        const unit = Math.floor(hover.x / L.UNIT_W);
        if (unit === state.units && unit < L.MAX_UNITS && hover.y >= 0 && hover.y < L.UNIT_D) buyUnit();
        else select(null);
      });
      this.input.on('wheel', (p, objs, dx, dy) => {
        const cam = this.cameras.main;
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.5, 2.5));
      });

      drawAll();
    },
    update: function (time, dt) {
      const sec = Math.min(dt, 50) / 1000;
      walk(this.keys, sec);
      tickDay(sec);
      drawCustomers();
      drawHero();
      this.clockT = (this.clockT || 0) + sec;
      if (this.clockT > 0.5) { this.clockT = 0; refreshClock(); }
      const cam = this.cameras.main;
      const p = iso(player.x, player.y);
      cam.scrollX += (p.x - cam.width / 2 - cam.scrollX) * 0.12;
      cam.scrollY += (p.y - 40 - cam.height / 2 - cam.scrollY) * 0.12;
    },
  };

  // ---------- Öffnungstag & Kunden ----------
  // Der Tag läuft nur im Browser: Kunden kommen zu festen Zeitpunkten, laufen auf Rasterwegen (ShopCustomers.path)
  // zu Regalen, entscheiden (ShopCustomers.shop), stellen sich an die Kasse und warten, bis man sie mit E kassiert.
  // Jeder Abschluss/Abgang geht sofort an den Server (checkout/leave); nach Ladenschluss und wenn alle weg sind: closeDay.
  const CUSTOMER_SPEED = 2.4;
  const LOOK_SECONDS = 1.2;
  const COLORS = [0xd0503a, 0x3aa0a0, 0x9a5ad0, 0xd09a2a, 0x5a8a3a, 0xc05a8a, 0x4a6ad0];
  const day = { t: 0, rng: null, queue: [], customers: [], nextId: 1, closing: false };
  const reserved = {}; // "uid|ware" → Stück, die Kunden schon im Korb haben

  const resKey = (uid, ware) => uid + '|' + ware;
  function freeStock(it, ware) {
    return Math.max(0, ((it.stock && it.stock[ware]) || 0) - (reserved[resKey(it.uid, ware)] || 0));
  }
  function release(c) {
    (c.basket || []).forEach((b) => {
      const k = resKey(b.uid, b.ware);
      reserved[k] = Math.max(0, (reserved[k] || 0) - b.qty);
    });
  }
  function shopStock() {
    return state.items.reduce((a, it) => a + L.used(it), 0);
  }
  const holders = () => state.items.filter((it) => catalog[it.id].holds);
  const counter = () => state.items.find((it) => it.id === L.PC_ID);

  function openDay() {
    if (state.open) return;
    if (!act(doAct('openDay'))) return;
    day.t = 0;
    day.rng = C.rngFrom((Date.now() ^ (state.day * 7919)) >>> 0);
    day.queue = C.arrivals(C.customersPerDay(C.rating(state.reviews)), day.rng);
    day.customers = [];
    day.closing = false;
    Object.keys(reserved).forEach((k) => delete reserved[k]);
  }

  function tickDay(sec) {
    if (!state || !state.open || !day.rng) return;
    day.t += sec;
    const frac = day.t / C.DAY_SECONDS;
    while (day.queue.length && day.queue[0] <= frac) {
      day.queue.shift();
      spawn();
    }
    day.customers.forEach((c) => tickCustomer(c, sec));
    day.customers.forEach((c) => { if (c.gone && c.g) c.g.destroy(); });
    day.customers = day.customers.filter((c) => !c.gone);
    if (frac >= 1 && !day.customers.length && !day.closing) {
      day.closing = true;
      const n = state.day;
      if (act(doAct('closeDay'))) note('Tag ' + n + ' ist vorbei – der Bericht liegt am PC.');
    }
  }

  function spawn() {
    const c = C.newCustomer(day.rng, goodsList, 1);
    const sx = Math.floor(day.rng() * state.units * L.UNIT_W);
    Object.assign(c, {
      id: day.nextId++, x: sx + 0.5, y: L.UNIT_D + L.SIDEWALK - 0.4, path: [], phase: 'enter', wait: 0,
      color: COLORS[Math.floor(day.rng() * COLORS.length)], seen: [], visit: [], bubble: '', bubbleT: 0, basket: [],
    });
    const door = L.DOOR[Math.floor(day.rng() * L.DOOR.length)];
    goTo(c, new Set([door.x + ',' + door.y]));
    // Regale, die er ansehen will: mit Wunschware zuerst, dann zufällige, höchstens 3
    const all = holders();
    const withWish = all.filter((it) => c.wish && freeStock(it, c.wish) > 0);
    const rest = all.filter((it) => !withWish.includes(it)).sort(() => day.rng() - 0.5);
    c.visit = withWish.slice(0, 2).concat(rest).slice(0, 3).map((it) => it.uid);
    day.customers.push(c);
  }

  function goTo(c, goals) {
    const start = { x: Math.floor(c.x), y: Math.floor(c.y) };
    const p = goals.size ? C.path(state, catalog, start, goals, blockSet) : null;
    c.path = p || [];
    return !!p;
  }

  function say(c, text, sec) {
    c.bubble = text;
    c.bubbleT = sec || 2.5;
  }

  function nextLeg(c) {
    while (c.visit.length) {
      const it = state.items.find((i) => i.uid === c.visit[0]);
      if (it && goTo(c, C.approach(state, catalog, it, blockSet))) { c.phase = 'look'; c.lookAt = it.uid; return; }
      c.visit.shift();
    }
    decide(c);
  }

  function decide(c) {
    // Angebote aus den angesehenen Regalen (ohne schon reservierte Stücke)
    const offers = [];
    c.seen.forEach((uid) => {
      const it = state.items.find((i) => i.uid === uid);
      if (!it || !it.stock) return;
      Object.keys(it.stock).forEach((w) => offers.push({ uid: uid, ware: w, qty: freeStock(it, w), price: L.price(state, goods, w) }));
    });
    const r = C.shop(c, offers, goods, day.rng);
    c.result = r;
    c.basket = r.basket;
    c.basket.forEach((b) => { reserved[resKey(b.uid, b.ware)] = (reserved[resKey(b.uid, b.ware)] || 0) + b.qty; });
    if (r.missWish) say(c, 'Habt ihr ' + goods[c.wish].name + '?', 3);
    else if (r.tooExpensive.length && !r.basket.length) say(c, 'Viel zu teuer!', 2.5);
    else if (r.stars < 5 && r.basket.length) say(c, 'Hmm, teuer …', 2);
    if (r.basket.length) { c.phase = 'queue'; c.wait = 0; queueUp(c); }
    else leave(c, C.review(r, shopStock(), day.rng));
  }

  /** Warteplätze an der Kasse: freie Zellen neben der Theke, dann dahinter */
  function queueSpots() {
    const pc = counter();
    if (!pc) return [];
    const first = Array.from(C.approach(state, catalog, pc, blockSet));
    const spots = first.slice();
    const seen = new Set(first);
    for (let i = 0; i < spots.length && spots.length < 12; i++) {
      const [x, y] = spots[i].split(',').map(Number);
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
        const k = x + dx + ',' + (y + dy);
        if (!seen.has(k) && y + dy < L.UNIT_D && C.walkableCell(state, blockSet, x + dx, y + dy)) { seen.add(k); spots.push(k); }
      });
    }
    return spots;
  }

  function queueUp(c) {
    const waiting = day.customers.filter((o) => o.phase === 'queue' && o !== c);
    const spots = queueSpots();
    const spot = spots[Math.min(waiting.length, spots.length - 1)];
    if (!spot) { release(c); leave(c, null); return; }
    goTo(c, new Set([spot]));
  }

  function leave(c, rev, kind) {
    c.phase = 'leave';
    const miss = c.result && c.result.missWish ? c.wish : '';
    if (kind !== 'paid') act(doAct('leave', Object.assign({ miss: miss }, rev || {})));
    const exits = new Set();
    for (let x = 0; x < state.units * L.UNIT_W; x++) exits.add(x + ',' + (L.UNIT_D + L.SIDEWALK - 1));
    if (!goTo(c, exits)) c.gone = true;
  }

  function firstInLine() {
    return day.customers
      .filter((c) => c.phase === 'queue' && !c.path.length)
      .sort((a, b) => b.wait - a.wait)[0] || null;
  }

  function serve(c) {
    const lines = c.basket.map((b) => ({ uid: b.uid, ware: b.ware, qty: b.qty }));
    const rev = C.review(c.result, shopStock(), day.rng);
    release(c);
    const total = c.basket.reduce((a, b) => a + b.qty * L.price(state, goods, b.ware), 0);
    act(doAct('checkout', Object.assign({ lines: lines, miss: c.result.missWish ? c.wish : '' }, rev || {})));
    say(c, '+' + fmt(total) + ' Kanacoin', 2);
    leave(c, null, 'paid');
  }

  function tickCustomer(c, sec) {
    if (c.bubbleT > 0) { c.bubbleT -= sec; if (c.bubbleT <= 0) c.bubble = ''; }
    if (c.path.length) {
      const n = c.path[0];
      const tx = n.x + 0.5;
      const ty = n.y + 0.5;
      const dx = tx - c.x;
      const dy = ty - c.y;
      const d = Math.hypot(dx, dy);
      const stepLen = CUSTOMER_SPEED * sec;
      if (d <= stepLen) { c.x = tx; c.y = ty; c.path.shift(); } else { c.x += (dx / d) * stepLen; c.y += (dy / d) * stepLen; }
      return;
    }
    if (c.phase === 'enter') { nextLeg(c); return; }
    if (c.phase === 'look') {
      c.wait += sec;
      if (c.wait >= LOOK_SECONDS) {
        c.wait = 0;
        c.seen.push(c.lookAt);
        c.visit.shift();
        nextLeg(c);
      }
      return;
    }
    if (c.phase === 'queue') {
      c.wait += sec;
      if (c.wait >= C.PATIENCE) {
        release(c);
        say(c, 'Zu lange gewartet!', 2.5);
        leave(c, C.angryReview());
      }
      return;
    }
    if (c.phase === 'leave') c.gone = true;
  }

  function drawCustomers() {
    scene.bubbles.forEach((b) => b.setVisible(false));
    day.customers.forEach((c, i) => {
      if (!c.g) c.g = scene.add.graphics();
      const g = c.g;
      g.clear();
      g.setDepth((c.x + c.y) * 10 + 0.4);
      const p = iso(c.x, c.y);
      g.fillStyle(0x000000, 0.25);
      g.fillEllipse(p.x, p.y, 22, 10);
      g.fillStyle(c.color, 1);
      g.fillRoundedRect(p.x - 8, p.y - 30, 16, 26, 6);
      g.fillStyle(0xe8c09a, 1);
      g.fillCircle(p.x, p.y - 37, 8);
      if (c.basket.length && c.phase !== 'leave') { g.fillStyle(0xf0d48a, 1); g.fillRect(p.x + 6, p.y - 20, 8, 7); }
      if (c.phase === 'queue' && !c.path.length) {
        const left = Math.max(0, 1 - c.wait / C.PATIENCE);
        g.fillStyle(0x000000, 0.6);
        g.fillRect(p.x - 12, p.y - 52, 24, 4);
        g.fillStyle(left > 0.5 ? 0x4fd17a : left > 0.25 ? 0xe0b040 : 0xe0525a, 1);
        g.fillRect(p.x - 12, p.y - 52, 24 * left, 4);
      }
      if (c.bubble) {
        let b = scene.bubbles[i];
        if (!b) {
          b = scene.add.text(0, 0, '', { fontSize: '11px', color: '#1c1f2b', backgroundColor: '#fff3c8', padding: { x: 5, y: 2 } })
            .setOrigin(0.5, 1).setDepth(29000).setResolution(2);
          scene.bubbles[i] = b;
        }
        b.setText(c.bubble).setPosition(p.x, p.y - 56).setVisible(true);
      }
    });
  }

  function refreshClock() {
    const elc = $('[data-shop-clock]');
    if (!elc) return;
    const r = C.rating(state.reviews);
    const stars = '★ ' + r.toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    if (state.open && day.rng) {
      const frac = day.t / C.DAY_SECONDS;
      elc.textContent = 'Tag ' + state.day + ' · ' + (frac >= 1 ? 'Ladenschluss' : C.clock(frac) + ' · geöffnet') + ' · ' + stars;
    } else elc.textContent = 'Tag ' + state.day + ' · geschlossen · ' + stars;
  }

  let noteTimer = 0;
  function note(msg) {
    const n = $('[data-shop-note]');
    n.textContent = msg;
    n.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { n.hidden = true; }, 6000);
  }

  // ---------- PC: Berichte ----------
  function stars(n) {
    return n === null || n === undefined ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' ★';
  }

  function pcVerkauf(body) {
    const reps = state.reports.slice().reverse();
    if (!reps.length) { body.appendChild(el('p', 'sd-later', 'Noch kein Tag abgeschlossen. Öffne den Laden an der Tür.')); return; }
    const { t, tb } = table([['Tag'], ['Kunden', 1], ['Käufer', 1], ['Einnahmen', 1], ['Bewertung', 1]]);
    reps.forEach((r) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', 'Tag ' + r.day + (r.aborted ? ' (abgebrochen)' : '')));
      tr.appendChild(el('td', 'num', String(r.visitors)));
      tr.appendChild(el('td', 'num', String(r.buyers)));
      tr.appendChild(el('td', 'num', fmt(r.revenue)));
      tr.appendChild(el('td', 'num', stars(r.stars)));
      tb.appendChild(tr);
    });
    body.appendChild(t);
    const last = reps[0];
    body.appendChild(el('div', 'sd-group', 'Tag ' + last.day + ': verkauft'));
    const sold = Object.keys(last.sold || {});
    body.appendChild(el('p', 'sd-later', sold.length ? sold.map((w) => last.sold[w] + '× ' + goods[w].name).join(', ') : 'Nichts.'));
    const miss = Object.keys(last.misses || {});
    if (miss.length) {
      body.appendChild(el('div', 'sd-group', 'Gesucht, aber nicht gefunden'));
      body.appendChild(el('p', 'sd-later', miss.map((w) => goods[w].name + ' (' + last.misses[w] + '×)').join(', ')));
    }
  }

  function pcBewertungen(body) {
    const r = C.rating(state.reviews);
    const n = state.reviews.slice(-C.REVIEW_WINDOW).length;
    body.appendChild(el('p', '', 'Durchschnitt: ' + stars(Math.round(r * 10) / 10) + (n ? ' aus den letzten ' + n + ' Bewertungen' : ' (neuer Laden)') +
      ' · erwartet ca. ' + C.customersPerDay(r) + ' Kunden pro Tag'));
    const list2 = state.reviews.slice().reverse();
    if (!list2.length) return;
    const { t, tb } = table([['Tag'], ['Sterne'], ['Kommentar']]);
    list2.forEach((v) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', 'Tag ' + v.day));
      tr.appendChild(el('td', '', '★'.repeat(v.stars) + '☆'.repeat(5 - v.stars)));
      tr.appendChild(el('td', '', v.text));
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  function pcBelege(body) {
    const src = state.open ? { day: state.day, receipts: state.today.receipts } : state.reports[state.reports.length - 1];
    if (!src || !src.receipts || !src.receipts.length) { body.appendChild(el('p', 'sd-later', 'Noch keine Belege.')); return; }
    body.appendChild(el('div', 'sd-group', 'Tag ' + src.day));
    const { t, tb } = table([['#'], ['Waren'], ['Summe', 1]]);
    src.receipts.slice().reverse().forEach((r, i) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', String(src.receipts.length - i)));
      tr.appendChild(el('td', '', r.lines.map((l) => l.qty + '× ' + goods[l.ware].name + ' à ' + fmt(l.price)).join(', ')));
      tr.appendChild(el('td', 'num', fmt(r.total)));
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  // ---------- Figur ----------
  let blockSet = new Set();

  /** Darf die Figur bei (x, y) stehen? (Rand mit kleinem Körper-Radius, Tür als einziger Durchgang zum Gehweg) */
  function canStand(x, y, fromY) {
    const r = 0.18;
    const pts = [[x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r]];
    if (!pts.every(([px, py]) => L.walkable(state, catalog, px, py, blockSet))) return false;
    const crossing = (fromY < L.UNIT_D) !== (y < L.UNIT_D) || (y - r < L.UNIT_D && y + r >= L.UNIT_D);
    if (crossing) {
      const d0 = L.DOOR[0].x;
      const d1 = L.DOOR[L.DOOR.length - 1].x + 1;
      if (x - r < d0 || x + r > d1) return false;
    }
    return true;
  }

  function walk(k, sec) {
    if (dialogOpen() || !state) return;
    // Bildschirm-Richtung → Raster: oben = (−1, −1), rechts = (+1, −1)
    let sx = 0;
    let sy = 0;
    if (k.A.isDown || k.LEFT.isDown) sx -= 1;
    if (k.D.isDown || k.RIGHT.isDown) sx += 1;
    if (k.W.isDown || k.UP.isDown) sy -= 1;
    if (k.S.isDown || k.DOWN.isDown) sy += 1;
    if (sx || sy) {
      let gx = sx + sy;
      let gy = sy - sx;
      const len = Math.hypot(gx, gy) || 1;
      gx = (gx / len) * SPEED * sec;
      gy = (gy / len) * SPEED * sec;
      const fromY = player.y;
      if (canStand(player.x + gx, player.y, fromY)) player.x += gx;
      if (canStand(player.x, player.y + gy, fromY)) player.y += gy;
    }
    findTarget();
  }

  function drawHero() {
    const g = scene.hero;
    g.clear();
    const p = iso(player.x, player.y);
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(p.x, p.y, 26, 12);
    g.fillStyle(0x2f6fd0, 1);
    g.fillRoundedRect(p.x - 9, p.y - 34, 18, 30, 7);
    g.fillStyle(0xf0c8a0, 1);
    g.fillCircle(p.x, p.y - 42, 9);
    g.lineStyle(1.5, 0x0e1a33, 1);
    g.strokeRoundedRect(p.x - 9, p.y - 34, 18, 30, 7);
    g.strokeCircle(p.x, p.y - 42, 9);
    const h = hand();
    if (h) {
      g.fillStyle(0xa07a4a, 1);
      g.fillRect(p.x - 12, p.y - 30, 24, 16);
      g.lineStyle(1.5, 0x5a4024, 1);
      g.strokeRect(p.x - 12, p.y - 30, 24, 16);
      g.fillStyle(cartonColor(h), 1);
      g.fillRect(p.x - 12, p.y - 24, 24, 4);
    }
    g.setDepth((player.x + player.y) * 10 + 0.5);
    scene.prompt.setPosition(p.x, p.y - 56);
    scene.prompt.setText(target && !mode ? target.label : '');
    scene.prompt.setVisible(!!(target && !mode));
  }

  /** Abstand der Figur zu einem Rechteck in Zellen */
  function distRect(x, y, w, d) {
    const dx = Math.max(x - player.x, 0, player.x - (x + w));
    const dy = Math.max(y - player.y, 0, player.y - (y + d));
    return Math.hypot(dx, dy);
  }

  function itemDist(it) {
    const d = catalog[it.id];
    if (d.layer === 'wand') return Infinity;
    const s = L.size(d, it.rot);
    return distRect(it.x, it.y, s.w, s.d);
  }

  /** Was würde E jetzt tun? */
  function findTarget() {
    const h = hand();
    const near = state.items.map((it) => ({ it, dist: itemDist(it) })).filter((o) => o.dist <= REACH).sort((a, b) => a.dist - b.dist);
    const pc = near.find((o) => o.it.id === 'cashier_counter');
    const holders = near.filter((o) => catalog[o.it.id].holds);
    let t = null;
    const waiting = pc && state.open ? firstInLine() : null;
    const atDoor = !state.open && L.DOOR.some((d) => Math.hypot(d.x + 0.5 - player.x, d.y + 1 - player.y) < 1.3);
    if (waiting) {
      t = { label: 'E: Kunde kassieren', run: () => serve(waiting) };
    } else if (atDoor && !h) {
      t = { label: 'E: Laden öffnen (Tag ' + state.day + ')', run: openDay };
    } else if (h && h.kind === 'moebel') {
      t = { label: 'E: ' + catalog[h.id].name + ' aufbauen', run: () => { mode = { kind: 'build', id: h.id, rot: 0 }; selected = null; refresh(); } };
    } else if (h) {
      const fit = holders.find((o) => catalog[o.it.id].holds.includes(h.id) && L.used(o.it) < catalog[o.it.id].slots);
      if (fit) t = { label: 'E: in ' + catalog[fit.it.id].name + ' einräumen', run: () => act(doAct('stock', { uid: fit.it.uid })) };
      else if (pc) t = { label: 'E: PC benutzen', run: openPc };
      else t = { label: 'E: Karton abstellen', run: dropHere };
    } else {
      const box = state.boxes
        .filter((b) => b.bid !== state.carry)
        .map((b) => ({ b, dist: Math.hypot(b.x - player.x, b.y - player.y) }))
        .filter((o) => o.dist <= 0.75)
        .sort((a, b) => a.dist - b.dist)[0];
      const first = near.find((o) => o.it.id === 'cashier_counter' || catalog[o.it.id].holds);
      if (box && (!first || box.dist <= first.dist)) t = { label: 'E: Karton aufheben (' + boxName(box.b) + ')', run: () => act(doAct('pick', { bid: box.b.bid })) };
      else if (first && first.it.id === 'cashier_counter') t = { label: 'E: PC benutzen', run: openPc };
      else if (first) t = { label: 'E: ' + catalog[first.it.id].name + ' ansehen', run: () => openShelf(first.it.uid) };
    }
    target = t;
  }

  function dropHere() {
    act(doAct('drop', { x: Math.round(player.x * 100) / 100, y: Math.round(player.y * 100) / 100 }));
  }

  function pick(wx, wy) {
    for (let i = scene.hulls.length - 1; i >= 0; i--) {
      const h = scene.hulls[i];
      if (Phaser.Geom.Polygon.Contains(new Phaser.Geom.Polygon(h.hull), wx, wy)) return h.uid;
    }
    return null;
  }

  // ---------- Laden zeichnen ----------
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
        for (let y = L.UNIT_D; y < L.UNIT_D + L.SIDEWALK; y++) {
          poly(g, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], owned ? 0x464a55 : 0x33363e, 1, 0x30333c);
        }
        const wc = owned ? 0xc9bfae : 0x4a4d58;
        poly(w, [iso(x, 0), iso(x + 1, 0), iso(x + 1, 0, WALL_H), iso(x, 0, WALL_H)], wc, 1, shade(wc, -0.2));
      }
      if (!owned) {
        const sx = u * L.UNIT_W;
        for (let y = 0; y < L.UNIT_D; y++) {
          poly(w, [iso(sx, y), iso(sx, y + 1), iso(sx, y + 1, 54), iso(sx, y, 54)], next ? 0x6d717e : 0x55585f, 0.92, 0x3b3e46);
        }
      }
    }
    for (let y = 0; y < L.UNIT_D; y++) {
      poly(w, [iso(0, y), iso(0, y + 1), iso(0, y + 1, WALL_H), iso(0, y, WALL_H)], 0xb3a998, 1, 0x948a7a);
    }
    // Vorderwand nur als Linie (sonst verdeckt sie den Laden), Lücke an der Tür
    const front = state.units * L.UNIT_W;
    const d0 = L.DOOR[0].x;
    const d1 = L.DOOR[L.DOOR.length - 1].x + 1;
    g.lineStyle(4, 0xc9bfae, 0.9);
    [[0, d0], [d1, front]].forEach(([a, b]) => {
      const p = iso(a, L.UNIT_D);
      const q = iso(b, L.UNIT_D);
      g.lineBetween(p.x, p.y, q.x, q.y);
    });
  }

  function drawAll() {
    if (!scene) return;
    blockSet = L.blocked(state, catalog);
    drawFloor();
    scene.items.forEach((o) => o.destroy());
    scene.labels.forEach((o) => o.destroy());
    scene.extra.forEach((o) => o.destroy());
    scene.items = [];
    scene.labels = [];
    scene.extra = [];
    scene.hulls = [];

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

    state.boxes.forEach((b) => {
      if (b.bid === state.carry) return;
      const g = scene.add.graphics();
      drawCarton(g, b.x, b.y, 0, cartonColor(b), 1);
      g.setDepth((b.x + b.y) * 10);
      scene.items.push(g);
      if (showNames) {
        const p = iso(b.x, b.y, 18);
        const t = scene.add.text(p.x, p.y, b.kind === 'moebel' ? catalog[b.id].name : '×' + b.qty, { fontSize: '9px', color: '#ffe9c0', backgroundColor: '#00000088', padding: { x: 2, y: 0 } });
        scene.labels.push(t.setOrigin(0.5, 1).setDepth(14000).setResolution(2));
      }
    });

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
    const ok = L.check(state, catalog, c, mode.kind === 'move' ? mode.uid : undefined).ok;
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
    refreshHud();
    refreshClock();
    drawAll();
    if (scene) findTarget();
    if ($('[data-shop-pc]').open) renderPc();
    if ($('[data-shop-shelf]').open) renderShelf();
  }

  // ---------- Aktionen ----------
  function select(uid) {
    selected = uid;
    refresh();
  }

  function rotate() {
    if (mode) {
      const d = catalog[mode.id];
      if (d.layer === 'boden' || d.layer === 'flach') { mode.rot = mode.rot ? 0 : 1; drawGhost(); }
      return;
    }
    const it = selected && state.items.find((i) => i.uid === selected);
    if (!it) return;
    act(doAct('move', { uid: it.uid, x: it.x, y: it.y, rot: it.rot ? 0 : 1, wall: it.wall }));
  }

  function startMove(uid) {
    const it = state.items.find((i) => i.uid === uid);
    if (!it) return;
    selected = uid;
    mode = { kind: 'move', uid: uid, id: it.id, rot: it.rot };
    refresh();
  }

  function giveBack() {
    const it = state.items.find((i) => i.uid === selected);
    if (!it) return;
    selected = null;
    act(doAct('remove', { uid: it.uid }));
  }

  function buyUnit() {
    if (state.coins < unitPrice) return toast('Nicht genug Kanacoin.');
    ask('Nachbar-Fläche für ' + fmt(unitPrice) + ' Kanacoin kaufen?').then((ok) => { if (ok) act(doAct('buyUnit')); });
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
    ask('Kanacoin festlegen (Demo-Geld):', true, Math.floor(state.coins)).then((v) => {
      if (v === null || v === '') return;
      act(doAct('setCoins', { amount: Math.floor(Number(v)) }));
    });
  });

  $('[data-shop-reset]').addEventListener('click', () => {
    ask('Laden leeren und mit ' + fmt(L.START_COINS) + ' Kanacoin neu starten?').then((ok) => {
      if (!ok) return;
      mode = null;
      selected = null;
      player.x = 4;
      player.y = L.UNIT_D + 0.8;
      day.customers.forEach((c) => { if (c.g) c.g.destroy(); });
      day.customers = [];
      day.rng = null;
      act(doAct('reset'));
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
      goodsList = data.goods;
      groups = data.groups;
      unitPrice = data.unitPrice;
      catalog = Object.fromEntries(list.map((d) => [d.id, d]));
      goods = Object.fromEntries(goodsList.map((g) => [g.id, g]));
      refreshHud();
      // Ein offener Tag kann nach dem Neuladen nicht weiterlaufen (die Kunden leben nur im Browser)
      if (state.open && act(doAct('closeDay', { aborted: true }))) note('Der letzte Tag wurde beim Neuladen abgebrochen.');
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
