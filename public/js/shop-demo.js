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
  let licenseList = [];
  let serviceList = [];
  let packs = [];
  let more = { licenses: {}, services: {} };
  let clothesList = [];
  let posterTypes = [];
  let posterSpots = [];
  let clothesSlots = [];
  let rufCfg = { levels: [0], unlock: {} };
  const lockedFor = (lv) => (lv || 1) > (state.level || 1); // ab dieser Ruf-Stufe frei
  const licensePrices = () => Object.fromEntries(licenseList.map((l) => [l.id, l.price]));

  const doAct = (type, extra) => Object.assign({ type }, extra);
  // Platzhalter-Töne (public/js/shop-sound.js)
  const snd = (name) => { if (window.ShopSound) window.ShopSound.play(name); };
  let stepT = 0;

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
    const r = L.apply(state, catalog, goods, Object.assign({ price: unitPrice }, action), more);
    if (r.error) { toast(r.error); snd('error'); return false; }
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

  let gameRef = null;
  // Minispiel-Szenen über dem Laden (Kasse, Arbeitstisch): solange eine offen ist, ruht die Steuerung im Laden
  const kasseOpen = () => !!(gameRef && ((window.ShopKasse && window.ShopKasse.isOpen(gameRef)) || (window.ShopWerkbank && window.ShopWerkbank.isOpen(gameRef))));
  const dialogOpen = () => !!document.querySelector('dialog[open]') || kasseOpen();
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
    handEl.hidden = !h && held === 'hand';
    if (h) handEl.textContent = 'In der Hand: Karton ' + boxName(h) + (h.kind === 'moebel' ? ' · E aufbauen' : '');
    else if (held === 'mop') handEl.textContent = 'In der Hand: Wischmopp · Tab/1 = Hände';
    const panel = $('[data-shop-panel]');
    const it = selected && state.items.find((i) => i.uid === selected);
    if (!it) { selected = null; panel.hidden = true; return; }
    const d = catalog[it.id];
    $('[data-shop-panel-name]').textContent = d.name;
    $('[data-shop-panel-info]').textContent = d.utility + (d.capacity ? ' · ' + d.capacity : '');
    $('[data-shop-panel-refund]').textContent = '(+' + fmt(d.price) + ')';
    panel.querySelector('[data-shop-do="rotate"]').hidden = d.layer === 'wand' || !!d.secret;
    panel.querySelector('[data-shop-do="move"]').hidden = !!d.secret;
    panel.querySelector('[data-shop-do="remove"]').hidden = !!d.secret;
    panel.querySelector('[data-shop-do="inhalt"]').hidden = !d.holds;
    panel.hidden = !!mode;
  }

  // ---------- PC ----------
  const PC_TABS = [
    ['moebel', 'Möbel bestellen'],
    ['bauen', 'Bauen'],
    ['ware', 'Ware bestellen'],
    ['preise', 'Preise'],
    ['bestand', 'Bestand'],
    ['lizenzen', 'Lizenzen'],
    ['werkzeug', 'Werkzeug'],
    ['verkauf', 'Verkäufe / Tag'],
    ['bewertungen', 'Bewertungen'],
    ['belege', 'Belege'],
    '–',
    ['ruf', 'Ruf'],
    ['kleidung', 'Kleidung'],
    ['propaganda', 'Propaganda drucken'],
    ['turnier', 'Turniere'],
    ['level', 'Level'],
  ];
  const LATER = ['level'];

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
    else if (pcTab === 'bauen') pcBauen(body);
    else if (pcTab === 'ware') pcWare(body);
    else if (pcTab === 'preise') pcPreise(body);
    else if (pcTab === 'bestand') pcBestand(body);
    else if (pcTab === 'lizenzen') pcLizenzen(body);
    else if (pcTab === 'werkzeug') pcWerkzeug(body);
    else if (pcTab === 'ruf') pcRuf(body);
    else if (pcTab === 'kleidung') pcKleidung(body);
    else if (pcTab === 'propaganda') pcPropaganda(body);
    else if (pcTab === 'turnier') pcTurnier(body);
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
    list.filter((d) => !d.secret).forEach((d) => {
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
      b.disabled = d.price > state.coins || lockedFor(d.level);
      if (lockedFor(d.level)) b.textContent = 'ab Stufe ' + d.level;
      b.addEventListener('click', () => { if (act(doAct('orderMoebel', { id: d.id }))) renderPc(); });
      td.appendChild(b);
      tr.appendChild(td);
      tb.appendChild(tr);
    });
  }

  function pcWare(body) {
    ['ware', 'material'].forEach((kind) => {
      body.appendChild(el('div', 'sd-group', kind === 'ware' ? 'Ware zum Verkaufen' : 'Material für Aufträge (in den Arbeitstisch einräumen)'));
      pcWareTable(body, goodsList.filter((g) => (g.kind || 'ware') === kind));
    });
    body.appendChild(el('p', 'sd-later', 'Bestelltes landet als Karton auf dem Gehweg vor dem Eingang.'));
  }

  function pcWareTable(body, rows) {
    const { t, tb } = table([['Ware'], ['Karton', 1], ['Einkauf/Stück', 1], ['Karton-Preis', 1], ['']]);
    rows.forEach((g) => {
      const tr = el('tr');
      const name = el('td');
      const sw = el('span', 'sd-swatch');
      sw.style.background = hex(g.color);
      name.append(sw, g.name);
      const lic = g.license && !state.licenses.includes(g.license) ? more.licenses[g.license] : null;
      const fits = Array.from(new Set(list.filter((d) => (d.holds || []).includes(g.id)).map((d) => d.name))).join(', ');
      name.appendChild(el('span', 'sub', (lic ? 'braucht die ' + lic.name : g.kind === 'material' ? 'wird bei Aufträgen verbraucht' : 'Marktpreis ' + marketLabel(g.id)) + (fits ? ' · passt in: ' + fits : '')));
      tr.appendChild(name);
      tr.appendChild(el('td', 'num', g.perBox + ' Stück'));
      tr.appendChild(el('td', 'num', fmt(g.buy)));
      const boxCost = g.buy * g.perBox;
      tr.appendChild(el('td', 'num', fmt(boxCost)));
      const td = el('td', 'num');
      const b = el('button', 'sd-btn', '1 Karton');
      b.type = 'button';
      b.disabled = boxCost > state.coins || !!lic || lockedFor(g.level);
      if (lockedFor(g.level)) b.textContent = 'ab Stufe ' + g.level;
      b.addEventListener('click', () => { if (act(doAct('orderWare', { id: g.id, n: 1 }))) renderPc(); });
      td.appendChild(b);
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  /** Räume bauen (Krisztian, 2026-10-16): Lager / Geheimraum – Rechteck ziehen, dann Tür wählen */
  function pcBauen(body) {
    body.appendChild(el('div', 'sd-group', 'Bauen'));
    const row = el('p', 'sd-later');
    [['lager', 'Lager bauen'], ['geheim', 'Geheimraum bauen']].forEach(([kind, label]) => {
      const need = rufCfg.unlock[kind] || 1;
      const b = el('button', 'sd-btn', lockedFor(need) ? label + ' (ab Stufe ' + need + ')' : label);
      b.type = 'button';
      b.style.marginRight = '6px';
      b.disabled = lockedFor(need);
      b.addEventListener('click', () => {
        $('[data-shop-pc]').close();
        selected = null;
        mode = { kind: 'room', room: kind, stage: 'rect', a: null, b: null };
        toast(kind === 'lager' ? 'Lager: Fläche mit der Maus aufziehen, dann eine Wand für die Tür anklicken (Esc = abbrechen).' : 'Geheimraum: Fläche aufziehen, dann die Wand anklicken, vor die der Schrank kommt (Esc = abbrechen).');
        refresh();
      });
      row.appendChild(b);
    });
    const del = el('button', 'sd-btn', 'Abreißen');
    del.type = 'button';
    del.disabled = !(state.rooms || []).length;
    del.addEventListener('click', () => {
      $('[data-shop-pc]').close();
      selected = null;
      mode = { kind: 'demolish' };
      toast('Abreißen: Raum mit der Maus anklicken (Esc = abbrechen).');
      refresh();
    });
    row.appendChild(del);
    body.appendChild(row);
    body.appendChild(el('p', 'sd-later', 'Wand ' + fmt(L.ROOM.wall) + ' je Feld · Tür ' + fmt(L.ROOM.door) + ' · Schrank ' + fmt(L.ROOM.cabinet) + ' (beim Geheimraum statt Tür)'));
    if (!(state.rooms || []).length) return;
    // Räume: Name (zum Umbenennen), Größe, beim Lager die Luftentfeuchter
    const { t, tb } = table([['Name'], ['Art'], ['Größe'], ['Luftentfeuchter']]);
    state.rooms.forEach((r) => {
      const tr = el('tr');
      const tdn = el('td');
      const inp = el('input');
      inp.type = 'text';
      inp.maxLength = L.ROOM.nameMax;
      inp.value = r.name || '';
      inp.className = 'sd-name-input';
      inp.addEventListener('change', () => { if (!act(doAct('renameRoom', { rid: r.rid, name: inp.value }))) inp.value = r.name || ''; });
      tdn.appendChild(inp);
      tr.appendChild(tdn);
      tr.appendChild(el('td', '', r.kind === 'lager' ? 'Lager' : 'Geheimraum'));
      tr.appendChild(el('td', '', r.w + '×' + r.d));
      if (r.kind === 'lager') {
        const st = L.dampStatus(state, r);
        const td = el('td', st.have >= st.need ? '' : 'is-down', st.have + ' / ' + st.need + (st.have >= st.need ? '' : ' – Karten verderben nachts'));
        tr.appendChild(td);
      } else tr.appendChild(el('td', '', '–'));
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  /** Ruf-Stufe: Stand, nächste Schwelle, was wo frei wird (Platzhalter-Tabelle, Krisztian 2026-10-16) */
  function pcRuf(body) {
    const lv = state.level || 1;
    const next = rufCfg.levels[lv];
    body.appendChild(el('p', '', 'Ruf-Stufe ' + lv + ' · ' + fmt(state.ruf || 0) + ' Ruf' + (next !== undefined ? ' – Stufe ' + (lv + 1) + ' ab ' + fmt(next) : ' – höchste Stufe')));
    body.appendChild(el('p', 'sd-later', 'Ruf gibt es für Umsatz (je ' + rufCfg.perCoins + ' Kanacoin +1) und Bewertungen (5★ +' + rufCfg.stars[5] + ', 4★ +' + rufCfg.stars[4] + ', 2★ ' + rufCfg.stars[2] + ', 1★ ' + rufCfg.stars[1] + '). Eine erreichte Stufe geht nie verloren.'));
    const unlocks = {};
    const addU = (lvl, txt) => { (unlocks[lvl] = unlocks[lvl] || []).push(txt); };
    list.filter((d) => (d.level || 1) > 1).forEach((d) => addU(d.level, d.name));
    goodsList.filter((g) => (g.level || 1) > 1).forEach((g) => addU(g.level, g.name));
    licenseList.filter((l) => (l.level || 1) > 1).forEach((l) => addU(l.level, l.name));
    if (rufCfg.unlock.lager) addU(rufCfg.unlock.lager, 'Lager bauen');
    if (rufCfg.unlock.geheim) addU(rufCfg.unlock.geheim, 'Geheimraum bauen');
    if (rufCfg.unlock.unit) addU(rufCfg.unlock.unit, 'Nachbarfläche kaufen');
    const { t, tb } = table([['Stufe'], ['ab Ruf', 1], ['Wird frei']]);
    rufCfg.levels.forEach((min, i) => {
      const tr = el('tr');
      tr.appendChild(el('td', i + 1 <= lv ? 'is-up' : '', 'Stufe ' + (i + 1) + (i + 1 <= lv ? ' ✓' : '')));
      tr.appendChild(el('td', 'num', fmt(min)));
      tr.appendChild(el('td', '', i === 0 ? 'Grundausstattung' : (unlocks[i + 1] || []).join(', ') || '–'));
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  /** Kleidung: kaufen = anziehen; nochmal klicken = ausziehen (Verdacht in der Stadt: später) */
  function pcKleidung(body) {
    clothesSlots.forEach((slot) => {
      body.appendChild(el('div', 'sd-group', slot.name));
      const { t, tb } = table([['Kleidung'], ['Preis', 1], ['']]);
      clothesList.filter((c) => c.slot === slot.id).forEach((c) => {
        const tr = el('tr');
        const name = el('td');
        const sw = el('span', 'sd-swatch');
        sw.style.background = hex(c.color);
        name.append(sw, c.name);
        tr.appendChild(name);
        tr.appendChild(el('td', 'num', fmt(c.price)));
        const td = el('td', 'num');
        const owned = state.wardrobe.includes(c.id);
        const worn = state.outfit[c.slot] === c.id;
        const b = el('button', 'sd-btn', !owned ? 'Kaufen' : worn ? 'Ausziehen' : 'Anziehen');
        b.type = 'button';
        b.disabled = !owned && c.price > state.coins;
        b.addEventListener('click', () => { if (act(doAct(owned ? 'wear' : 'buyClothes', { id: c.id }))) renderPc(); });
        td.appendChild(b);
        tr.appendChild(td);
        tb.appendChild(tr);
      });
      body.appendChild(t);
    });
  }

  /**
   * Propaganda-Plakate (Krisztian, 2026-10-17): drucken, an Orten aufhängen – sie bleiben dort. Jedes bringt mehr Kunden,
   * gezielte erhöhen die Nachfrage nach ihrer Warengruppe. Geheimes Zeichen: vorbereitet (Schwarzmarkt/Verdacht mit der Stadt).
   * Die Orte sind Platzhalter bis zur Stadtkarte.
   */
  function pcPropaganda(body) {
    const P = more.poster || { price: 10, customers: 2, wishBoost: 2 };
    body.appendChild(el('div', 'sd-group', 'Drucken (' + fmt(P.price) + ' je Plakat)'));
    const secretBox = el('label', 'sd-check');
    const secret = el('input');
    secret.type = 'checkbox';
    secretBox.append(secret, ' mit geheimem Zeichen (für den Schwarzmarkt – wirkt später in der Stadt)');
    const print = table([['Plakat'], ['Gezielt auf'], ['Auf Lager', 1], ['']]);
    posterTypes.forEach((pt) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', pt.name));
      tr.appendChild(el('td', '', pt.goods.length ? pt.goods.map((g) => (goods[g] || {}).name).filter(Boolean).join(', ') : 'alle Kunden'));
      tr.appendChild(el('td', 'num', String((state.posters[pt.id] || 0) + (state.posters[pt.id + ':geheim'] || 0))));
      const td = el('td', 'num');
      const b = el('button', 'sd-btn', 'Drucken');
      b.type = 'button';
      b.disabled = P.price > state.coins || L.invUsed(state) >= L.INVENTORY.slots;
      b.addEventListener('click', () => { if (act(doAct('printPoster', { id: pt.id, n: 1, secret: secret.checked }))) renderPc(); });
      td.appendChild(b);
      tr.appendChild(td);
      print.tb.appendChild(tr);
    });
    body.appendChild(print.t);
    body.appendChild(secretBox);
    body.appendChild(el('p', 'sd-later', 'Gedruckte Plakate trägst du im Inventar (Taste I, ' + L.invUsed(state) + ' / ' + L.INVENTORY.slots +
      ' Plätze) – lagern kannst du sie im Safe, aufhängen später in der Stadt.'));
  }

  function pcTurnier(body) {
    const tables = L.gameTables(state, catalog);
    body.appendChild(el('p', '', 'Turniere laufen am Spieltisch (Möbel bestellen) – mit ' + L.TABLE.chairs + ' Stühlen direkt daneben, sonst ist niemand zum Mitspielen da.'));
    if (!tables.length) body.appendChild(el('p', 'sd-later', 'Noch kein Spieltisch im Laden.'));
    else {
      const { t, tb } = table([['Spieltisch'], ['Stühle daneben', 1], ['']]);
      tables.forEach((x, i) => {
        const tr = el('tr');
        tr.appendChild(el('td', '', 'Tisch ' + (i + 1)));
        tr.appendChild(el('td', 'num', Math.min(x.chairs, L.TABLE.chairs) + ' / ' + L.TABLE.chairs));
        const miss = L.TABLE.chairs - x.chairs;
        tr.appendChild(el('td', 'num', x.ready ? 'bereit' : 'noch ' + miss + (miss === 1 ? ' Stuhl' : ' Stühle')));
        tb.appendChild(tr);
      });
      body.appendChild(t);
    }
    const btns = el('div', 'sd-pc-btns');
    ['Turnier starten', 'Turnier bewerben'].forEach((txt) => {
      const b = el('button', 'sd-btn', txt);
      b.type = 'button';
      b.disabled = true;
      btns.appendChild(b);
    });
    body.appendChild(btns);
    body.appendChild(el('p', 'sd-later', 'Starten und Bewerben kommen, sobald die Turnier-Regeln stehen (Startgeld, Mitspieler, Preise).'));
  }

  function pcWerkzeug(body) {
    const { t, tb } = table([['Werkzeug'], ['Preis', 1], ['']]);
    L.TOOLS.forEach((w) => {
      const tr = el('tr');
      const name = el('td', '', w.name);
      name.appendChild(el('span', 'sub', w.text));
      tr.appendChild(name);
      tr.appendChild(el('td', 'num', fmt(w.price)));
      const td = el('td', 'num');
      if (state.tools.includes(w.id)) td.appendChild(el('span', 'sd-later', 'Gekauft'));
      else {
        const b = el('button', 'sd-btn', 'Kaufen');
        b.type = 'button';
        b.disabled = w.price > state.coins;
        b.addEventListener('click', () => { if (act(doAct('buyTool', { id: w.id }))) renderPc(); });
        td.appendChild(b);
      }
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    body.appendChild(t);
    body.appendChild(el('p', 'sd-later', 'Werkzeug wählen: Tab gedrückt halten (Werkzeug-Rad) oder 1 = Hände, 2 = Wischmopp.'));
  }

  function pcLizenzen(body) {
    const { t, tb } = table([['Lizenz'], ['Preis', 1], ['']]);
    licenseList.forEach((l) => {
      const tr = el('tr');
      const name = el('td', '', l.name);
      name.appendChild(el('span', 'sub', l.text));
      tr.appendChild(name);
      tr.appendChild(el('td', 'num', fmt(l.price)));
      const td = el('td', 'num');
      if (state.licenses.includes(l.id)) td.appendChild(el('span', 'sd-later', 'Gekauft'));
      else {
        const b = el('button', 'sd-btn', 'Kaufen');
        b.type = 'button';
        b.disabled = l.price > state.coins || lockedFor(l.level);
        if (lockedFor(l.level)) b.textContent = 'ab Stufe ' + l.level;
        b.addEventListener('click', () => { if (act(doAct('buyLicense', { id: l.id }))) renderPc(); });
        td.appendChild(b);
      }
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    body.appendChild(t);
    body.appendChild(el('p', 'sd-later', 'Ohne Lizenz: Boosterpacks, Kartenhüllen, Toploader, Getränke, Material.'));
  }

  /**
   * Preisfeld mit Knöpfen (Krisztian, 2026-10-14): „+5 %“ immer vom Marktpreis aus (100 → 105 → 110),
   * „Runden“ (unter 20 auf 0,50, sonst auf 5), „= Markt“. get/market/set: aktueller Preis, Marktpreis, speichern
   */
  function priceControl(get, market, set) {
    const box = el('span', 'sd-price');
    const inp = el('input');
    inp.type = 'number';
    inp.min = '0';
    inp.step = '0.01';
    inp.value = get();
    const save = (v) => { if (set(Math.round(v * 100) / 100)) inp.value = get(); };
    inp.addEventListener('change', () => save(Number(String(inp.value).replace(',', '.'))));
    const btn = (label, title, fn) => {
      const b = el('button', 'sd-price-btn', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    box.append(
      inp,
      btn('+5 %', 'Marktpreis + 5 % (noch einmal: +10 %, …)', () => save(L.priceStepUp(get(), market()))),
      btn('≈', 'Runden (unter 20 auf 0,50, sonst auf 5)', () => save(L.roundPrice(get()))),
      btn('=', 'Zurück auf den Marktpreis', () => save(market()))
    );
    return box;
  }

  function priceInput(id) {
    return priceControl(() => L.price(state, goods, id), () => L.marketPrice(state, goods, id), (v) => act(doAct('setPrice', { ware: id, price: v })));
  }

  /** Marktpreis mit Pfeil, wenn er sich beim letzten Mal bewegt hat */
  function marketLabel(id) {
    const m = (state.marketMoves || []).find((x) => x.id === id);
    const txt = fmt(L.marketPrice(state, goods, id));
    if (!m) return txt;
    const pct = Math.round((m.to / m.from - 1) * 100);
    return txt + (pct > 0 ? ' ↑' + pct : ' ↓' + Math.abs(pct)) + ' %';
  }

  /** Stückzahl im Laden: in Regalen / in Kartons */
  function counts(id) {
    const shelf = state.items.reduce((a, it) => a + ((it.stock && it.stock[id]) || 0), 0);
    const boxes = state.boxes.reduce((a, b) => a + (b.kind === 'ware' && b.id === id ? b.qty : 0), 0);
    return { shelf, boxes };
  }

  function pcPreise(body) {
    body.appendChild(el('div', 'sd-group', 'Ware'));
    const { t, tb } = table([['Ware'], ['Einkauf', 1], ['Marktpreis', 1], ['Dein Preis', 1]]);
    goodsList.filter((g) => (g.kind || 'ware') === 'ware').forEach((g) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', g.name));
      tr.appendChild(el('td', 'num', fmt(g.buy)));
      const mk = el('td', 'num', marketLabel(g.id));
      const mv = (state.marketMoves || []).find((x) => x.id === g.id);
      if (mv) mk.classList.add(mv.to > mv.from ? 'is-up' : 'is-down');
      tr.appendChild(mk);
      const td = el('td', 'num');
      td.appendChild(priceInput(g.id));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    body.appendChild(t);
    body.appendChild(el('div', 'sd-group', 'Dienstleistungen (Kunden-Aufträge)'));
    const sv = table([['Dienst'], ['Arbeitstisch'], ['Marktpreis', 1], ['Dein Preis', 1]]);
    serviceList.forEach((x) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', x.name));
      tr.appendChild(el('td', '', (catalog[x.station] || {}).name || ''));
      tr.appendChild(el('td', 'num', fmt(x.market)));
      const td = el('td', 'num');
      td.appendChild(priceControl(() => L.servicePrice(state, more, x.id), () => x.market, (v) => act(doAct('setServicePrice', { service: x.id, price: v }))));
      tr.appendChild(td);
      sv.tb.appendChild(tr);
    });
    body.appendChild(sv.t);
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
    if (d.guestOk) {
      const box = el('label', 'sd-check sd-guest');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = !!it.guest;
      c.addEventListener('change', () => { act(doAct('setGuest', { uid: it.uid, on: c.checked })); renderShelf(); });
      box.append(c, ' Gäste-Kühlschrank: wartende Kunden (Aufträge) nehmen sich gratis etwas – daraus wird nichts verkauft');
      body.appendChild(box);
    }
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
    body.appendChild(el('p', 'sd-shelf-fits', 'Passt hinein: ' + d.holds.map((id) => goods[id] && goods[id].name).filter(Boolean).concat(d.holdsPosters ? ['Plakate'] : []).join(', ')));
    if (d.holdsPosters) shelfPosters(body, it, d);
  }

  // ---------- Inventar (Taste I) ----------
  const posterLabel = (key) => {
    const [id, s] = String(key).split(':');
    const pt = posterTypes.find((x) => x.id === id);
    return 'Plakat ' + (pt ? pt.name : id) + (s ? ' (geheim)' : '');
  };
  /** Safe-Fenster: Plakate hinein / heraus (immer der ganze Stapel, soweit Platz ist) */
  function shelfPosters(body, it, d) {
    const inSafe = it.posters || {};
    const keys = Array.from(new Set(Object.keys(inSafe).concat(Object.keys(state.posters).filter((k) => state.posters[k] > 0))));
    if (!keys.length) return;
    body.appendChild(el('div', 'sd-group', 'Plakate'));
    const { t, tb } = table([['Plakat'], ['Hier', 1], ['Inventar', 1], ['']]);
    keys.forEach((k) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', posterLabel(k)));
      tr.appendChild(el('td', 'num', String(inSafe[k] || 0)));
      tr.appendChild(el('td', 'num', String(state.posters[k] || 0)));
      const td = el('td', 'num');
      const nIn = Math.min(state.posters[k] || 0, d.slots - L.used(it));
      const nOut = Math.min(inSafe[k] || 0, L.INVENTORY.slots - L.invUsed(state));
      [['Hineinlegen', 'storePoster', nIn], ['Herausnehmen', 'takePoster', nOut]].forEach(([txt, type, n]) => {
        const b = el('button', 'sd-btn', txt);
        b.type = 'button';
        b.disabled = n <= 0;
        b.addEventListener('click', () => { act(doAct(type, { uid: it.uid, key: k, n })); renderShelf(); });
        td.append(b, ' ');
      });
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  function openInventory() {
    renderInventory();
    const dlg = $('[data-shop-inv]');
    if (!dlg.open) dlg.showModal();
  }
  function renderInventory() {
    $('[data-shop-inv-used]').textContent = L.invUsed(state) + ' / ' + L.INVENTORY.slots + ' Plätze belegt';
    const body = $('[data-shop-inv-body]');
    body.textContent = '';
    const keys = Object.keys(state.posters).filter((k) => state.posters[k] > 0);
    if (!keys.length) {
      body.appendChild(el('p', 'sd-later', 'Leer. Gedruckte Plakate (PC → Propaganda) landen hier – aufhängen kannst du sie später in der Stadt.'));
      return;
    }
    const { t, tb } = table([['Gegenstand'], ['Stück', 1]]);
    keys.forEach((k) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', posterLabel(k)));
      tr.appendChild(el('td', 'num', String(state.posters[k])));
      tb.appendChild(tr);
    });
    body.appendChild(t);
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
    if (d.layer === 'wandnah') {
      // Seite mit Wand: die gewählte (R), sonst die erste passende
      const x = Math.floor(hover.x);
      const y = Math.floor(hover.y);
      const rot = L.wallOnSide(state, x, y, mode.rot, walls) ? mode.rot : [0, 1, 2, 3].find((r) => L.wallOnSide(state, x, y, r, walls));
      return { id: d.id, x, y, rot: rot === undefined ? mode.rot : rot };
    }
    const s = L.size(d, mode.rot);
    return { id: d.id, x: Math.floor(hover.x - s.w / 2 + 0.5), y: Math.floor(hover.y - s.d / 2 + 0.5), rot: mode.rot };
  }

  function commit() {
    const c = candidate();
    if (!c) return;
    if (mode.kind === 'build') {
      if (act(doAct('build', c))) { mode = null; snd('place'); }
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
  /**
   * Vorderseite (rot 0–3, Krisztian 2026-10-14): heller Rahmen + Ware als Farbstreifen. Zeigt sie zum Betrachter
   * (0 = linke Seitenfläche, 1 = rechte), liegt beides auf dieser Fläche, sonst als Streifen oben an der vorderen Kante.
   * Ein kleiner Pfeil oben zeigt immer die Blickrichtung.
   */
  function drawFront(g, it, s, d, z0) {
    const m = 0.06;
    const x0 = it.x + m, x1 = it.x + s.w - m, y0 = it.y + m, y1 = it.y + s.d - m;
    const r = L.rot4(it.rot);
    const h = d.height;
    // Punkt auf der Vorderseite: t = 0…1 entlang der Seite, z = Höhe
    const along = r === 0 ? (t, z) => iso(x0 + t * (x1 - x0), y1, z) : r === 1 ? (t, z) => iso(x1, y1 - t * (y1 - y0), z) : null;
    const top = z0 + h;
    if (along) poly(g, [along(0.04, z0 + h * 0.1), along(0.96, z0 + h * 0.1), along(0.96, z0 + h * 0.9), along(0.04, z0 + h * 0.9)], 0xffffff, 0.18);
    if (d.slots && it.stock) {
      let t = 0.06;
      Object.keys(it.stock).forEach((id) => {
        const part = (it.stock[id] / d.slots) * 0.88;
        const a = t;
        const b = t + part;
        t = b;
        const col = goods[id] ? goods[id].color : 0xffffff;
        if (along) poly(g, [along(a, z0 + h * 0.2), along(b, z0 + h * 0.2), along(b, z0 + h * 0.8), along(a, z0 + h * 0.8)], col, 0.95, 0x000000);
        else {
          // hinten liegende Vorderseite: Streifen oben entlang der vorderen Kante
          const e = r === 2 ? (u, v) => iso(x0 + u * (x1 - x0), y0 + v, top) : (u, v) => iso(x0 + v, y0 + u * (y1 - y0), top);
          poly(g, [e(a, 0), e(b, 0), e(b, 0.18), e(a, 0.18)], col, 0.95, 0x000000);
        }
      });
    }
    // Pfeil zur Vorderseite
    const [fx, fy] = L.FRONT[r];
    const cx = it.x + s.w / 2;
    const cy = it.y + s.d / 2;
    const tip = iso(cx + fx * (s.w / 2 - 0.12), cy + fy * (s.d / 2 - 0.12), top);
    const back = iso(cx + fx * (s.w / 2 - 0.42), cy + fy * (s.d / 2 - 0.42), top);
    const side = iso(cx + fy * 0.14 + fx * (s.w / 2 - 0.42), cy - fx * 0.14 + fy * (s.d / 2 - 0.42), top);
    const side2 = iso(cx - fy * 0.14 + fx * (s.w / 2 - 0.42), cy + fx * 0.14 + fy * (s.d / 2 - 0.42), top);
    if (back) poly(g, [tip, side, side2], 0xffffff, 0.75);
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
    if (d.layer === 'wandnah') return drawNearWall(g, it, d, color, alpha, outline);
    const hull = box(g, it.x, it.y, s.w, s.d, d.height, z0, color, alpha, outline);
    if (d.layer === 'boden' || d.slots) drawFront(g, it, s, d, z0); // auch beim Aufstellen: der Pfeil zeigt, wo vorne ist
    const base = d.layer === 'theke' ? counterUnder(it) || it : it;
    const bs = L.size(catalog[base.id], base.rot);
    return {
      hull: hull, depth: depth, top: iso(it.x + s.w / 2, it.y + s.d / 2, z0 + d.height),
      box: { x0: base.x, y0: base.y, x1: base.x + bs.w, y1: base.y + bs.d, bias: d.layer === 'theke' ? 1 : 0 },
    };
  }

  /** Gerät an der Wand: kleiner Kasten in Brusthöhe, an die nächste Wand der Zelle gerückt */
  function drawNearWall(g, it, d, color, alpha, outline) {
    const x = it.x;
    const y = it.y;
    const side = L.rot4(it.rot);
    const bx = side === 0 ? { x: x + 0.25, y: y + 0.07, w: 0.5, d: 0.22 }
      : side === 1 ? { x: x + 0.07, y: y + 0.25, w: 0.22, d: 0.5 }
        : side === 2 ? { x: x + 0.25, y: y + 0.71, w: 0.5, d: 0.22 }
          : { x: x + 0.71, y: y + 0.25, w: 0.22, d: 0.5 };
    const hull = box(g, bx.x, bx.y, bx.w, bx.d, d.height, L.MOUNT_Z, color, alpha, outline, 0);
    return { hull: hull, depth: (bx.x + bx.y) * 10, top: iso(bx.x + bx.w / 2, bx.y + bx.d / 2, L.MOUNT_Z + d.height), box: { x0: bx.x, y0: bx.y, x1: bx.x + bx.w, y1: bx.y + bx.d, bias: 1 } };
  }

  function drawCarton(g, x, y, z, kindColor, alpha) {
    box(g, x - 0.2, y - 0.2, 0.4, 0.4, 14, z, 0xa07a4a, alpha, 0x5a4024, 0);
    poly(g, [iso(x - 0.2, y + 0.2, z + 5), iso(x + 0.2, y + 0.2, z + 5), iso(x + 0.2, y + 0.2, z + 9), iso(x - 0.2, y + 0.2, z + 9)], kindColor, alpha);
  }

  const cartonColor = (b) => (b.kind === 'moebel' ? groups[catalog[b.id].group].color : goods[b.id].color);

  /** A steht vor B, wenn A ganz rechts-vorne (x) oder ganz links-vorne (y) von B liegt */
  const inFront = (a, b) => a.x0 >= b.x1 - 1e-6 || a.y0 >= b.y1 - 1e-6;
  const mid = (b) => b.x0 + b.x1 + b.y0 + b.y1;

  /** Sortiert Möbel, Kartons, Wände und Figuren jedes Bild neu (bei Platzhalter-Mengen reicht n²) */
  function sortDepth() {
    const list = (scene.sortables || []).slice();
    // Figuren zählen als Punkt (wo sie stehen), Wände als Linie auf der Zellkante – so ist vorne/hinten immer eindeutig
    list.push({ g: scene.hero, box: { x0: player.x, y0: player.y, x1: player.x, y1: player.y, bias: 2 } });
    day.customers.forEach((c) => { if (c.g) list.push({ g: c.g, box: { x0: c.x, y0: c.y, x1: c.x, y1: c.y, bias: 2 } }); });
    const n = list.length;
    const after = list.map(() => []);
    const indeg = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = list[i].box;
        const b = list[j].box;
        const ab = inFront(a, b);
        const ba = inFront(b, a);
        if (ab && !ba) { after[j].push(i); indeg[i]++; } else if (ba && !ab) { after[i].push(j); indeg[j]++; }
      }
    }
    const key = (i) => mid(list[i].box) * 10 + list[i].box.bias;
    const ready = [];
    for (let i = 0; i < n; i++) if (!indeg[i]) ready.push(i);
    let d = 0;
    const placed = new Array(n).fill(false);
    while (ready.length) {
      ready.sort((a, b) => key(a) - key(b));
      const i = ready.shift();
      placed[i] = true;
      list[i].g.setDepth(1000 + d++);
      after[i].forEach((j) => { if (--indeg[j] === 0) ready.push(j); });
    }
    // Ring (sollte nicht vorkommen): Rest nach Mitte
    list.map((o, i) => i).filter((i) => !placed[i]).sort((a, b) => key(a) - key(b)).forEach((i) => list[i].g.setDepth(1000 + d++));
  }

  const GameScene = {
    key: 'shop',
    create: function () {
      scene = this;
      this.cameras.main.setBackgroundColor('#14161f');
      this.floor = this.add.graphics().setDepth(-10000);
      this.walls = this.add.graphics().setDepth(-9000);
      this.ghost = this.add.graphics().setDepth(20000);
      this.dirt = this.add.graphics().setDepth(-8500);
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
      const keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,R,E,Q,I,ESC,DELETE,ONE,TWO', false);
      // Tab: Werkzeug-Rad, solange gedrückt. Nur im Laden abfangen (sonst springt der Fokus) – in Fenstern bleibt Tab normal
      const tab = this.input.keyboard.addKey('TAB', false);
      window.addEventListener('keydown', (e) => { if (e.key === 'Tab' && !dialogOpen()) e.preventDefault(); });
      tab.on('down', () => { if (!dialogOpen() && !mode) openWheel(); });
      tab.on('up', closeWheel);
      keys.ONE.on('down', () => { if (!dialogOpen()) selectTool('hand'); });
      keys.TWO.on('down', () => { if (!dialogOpen()) selectTool('mop'); });
      this.keys = keys;
      const free = () => !dialogOpen();
      keys.R.on('down', () => { if (free()) rotate(); });
      keys.E.on('down', () => { if (free() && !mode && target) target.run(); });
      this.eKey = keys.E;
      keys.Q.on('down', () => { if (free() && !mode && hand()) dropHere(); });
      keys.I.on('down', () => { if (free() && !mode) openInventory(); });
      // Esc: erst Bau-Modus / Auswahl abbrechen, sonst Pause-Menü (nach dem Tastendruck, sonst schließt es Esc gleich wieder)
      keys.ESC.on('down', () => {
        if (!free()) return;
        if (mode) { mode = null; refresh(); } else if (selected) select(null);
        else setTimeout(() => { if (!dialogOpen()) openMenu(true); }, 0);
      });
      keys.DELETE.on('down', () => { if (free() && selected && !mode) giveBack(); });

      let drag = null;
      if (this.input.mouse) this.input.mouse.disableContextMenu();
      const setHover = (p) => { hover = { x: (p.worldX / TW + p.worldY / TH) / 2, y: (p.worldY / TH - p.worldX / TW) / 2 }; };
      this.input.on('pointerdown', (p) => {
        if (kasseOpen()) return;
        setHover(p);
        if (p.rightButtonDown()) { if (mode) { mode = null; refresh(); } return; }
        if (mode && mode.kind === 'room') { roomDown(); return; }
        if (mode && mode.kind === 'demolish') { demolishAt(); return; }
        if (mode) { drag = { place: true }; return; }
        drag = { x: p.x, y: p.y, uid: pick(p.worldX, p.worldY), moved: false };
      });
      this.input.on('pointermove', (p) => {
        setHover(p);
        hoverUid = mode ? null : pick(p.worldX, p.worldY);
        if (drag && drag.uid && p.isDown && !drag.moved && Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) > 6) {
          drag.moved = true;
          startMove(drag.uid);
        }
        if (mode && mode.kind === 'room' && mode.stage === 'rect' && mode.a && p.isDown) mode.b = cellOf(hover);
        drawGhost();
      });
      this.input.on('pointerup', () => {
        if (kasseOpen()) { drag = null; return; }
        if (mode && mode.kind === 'room') { roomUp(); return; }
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
      if (menuOpen()) return; // Pause
      const sec = Math.min(dt, 50) / 1000;
      walk(this.keys, sec);
      tickMop(sec, this.eKey && this.eKey.isDown);
      tickDay(sec);
      drawCustomers();
      drawHero();
      drawEtikett();
      sortDepth();
      fadeWalls();
      this.clockT = (this.clockT || 0) + sec;
      if (this.clockT > 0.5) { this.clockT = 0; refreshClock(); }
      const cam = this.cameras.main;
      const p = iso(player.x, player.y);
      cam.scrollX += (p.x - cam.width / 2 - cam.scrollX) * 0.12;
      cam.scrollY += (p.y - 40 - cam.height / 2 - cam.scrollY) * 0.12;
    },
  };

  // ---------- Werkzeug in der Hand (Krisztian, 2026-10-14: GTA-artiges Rad) ----------
  // Mit Wischmopp in der Hand wischt E Flecken (gedrückt halten), mit leeren Händen benutzt E alles andere.
  const WHEEL = [{ id: 'hand', name: 'Hände' }, { id: 'mop', name: 'Wischmopp' }]; // neue Werkzeuge: hier und in L.TOOLS
  const MOP_SECONDS = 1.5;
  let held = 'hand';
  let mopping = null; // { did, t }

  function selectTool(id) {
    if (id !== 'hand' && !state.tools.includes(id)) { toast('Den ' + ((L.TOOLS.find((t) => t.id === id) || {}).name || 'Gegenstand') + ' gibt es am PC (Werkzeug).'); return; }
    if (id !== 'hand' && hand()) { toast('Erst den Karton abstellen (Q).'); return; }
    held = id;
    mopping = null;
    refreshHud();
    if (scene) findTarget();
  }

  const wheelEl = () => $('[data-shop-wheel]');
  let wheelPick = null;
  function openWheel() {
    const w = wheelEl();
    if (!w || !w.hidden) return;
    w.textContent = '';
    WHEEL.forEach((t, i) => {
      const a = -Math.PI / 2 + (i / WHEEL.length) * Math.PI * 2;
      const b = el('div', 'sd-wheel-slot' + (t.id === held ? ' is-held' : '') + (t.id !== 'hand' && !state.tools.includes(t.id) ? ' is-locked' : ''), t.name);
      b.style.left = 50 + Math.cos(a) * 34 + '%';
      b.style.top = 50 + Math.sin(a) * 34 + '%';
      b.dataset.tool = t.id;
      w.appendChild(b);
    });
    wheelPick = held;
    w.hidden = false;
    markWheel();
  }
  function markWheel() {
    wheelEl().querySelectorAll('.sd-wheel-slot').forEach((b) => b.classList.toggle('is-pick', b.dataset.tool === wheelPick));
  }
  window.addEventListener('mousemove', (e) => {
    const w = wheelEl();
    if (!w || w.hidden) return;
    const dx = e.clientX - window.innerWidth / 2;
    const dy = e.clientY - window.innerHeight / 2;
    if (Math.hypot(dx, dy) < 30) return;
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    wheelPick = WHEEL[Math.round(a / ((Math.PI * 2) / WHEEL.length)) % WHEEL.length].id;
    markWheel();
  });
  function closeWheel() {
    const w = wheelEl();
    if (!w || w.hidden) return;
    w.hidden = true;
    if (wheelPick && wheelPick !== held) selectTool(wheelPick);
  }

  /** Nächster Fleck in Reichweite (für den Wischmopp) */
  function nearDirt() {
    return (state.dirt || [])
      .map((d) => ({ d, dist: Math.hypot(d.x - player.x, d.y - player.y) }))
      .filter((o) => o.dist <= 0.9)
      .sort((a, b) => a.dist - b.dist)[0] || null;
  }

  function tickMop(sec, eDown) {
    if (!mopping) return;
    const still = (state.dirt || []).some((d) => d.did === mopping.did);
    if (!eDown || !still || held !== 'mop') { mopping = null; return; }
    mopping.t += sec;
    if (mopping.t >= MOP_SECONDS) {
      const did = mopping.did;
      mopping = null;
      if (act(doAct('mop', { did: did }))) snd('mop');
    }
  }

  /** Flecken auf dem Boden (unter Möbeln und Figuren) */
  function drawDirt() {
    const g = scene.dirt;
    g.clear();
    (state.dirt || []).forEach((d, i) => {
      const p = iso(d.x, d.y);
      const k = (d.did * 37) % 5;
      g.fillStyle(0x4a3220, 0.55);
      g.fillEllipse(p.x, p.y, 26 + k * 2, 12 + k);
      g.fillStyle(0x3a2616, 0.5);
      g.fillEllipse(p.x + 6 - k, p.y + 2, 12, 6);
      g.fillEllipse(p.x - 8 + k, p.y - 2, 9, 5);
    });
  }

  /** Bewertung an die Sauberkeit des Ladens anpassen (ShopCustomers.dirtCap) */
  const capDirt = (rev) => C.dirtCap(rev, state.dirt, Date.now());

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
  const isWare = (id) => !!goods[id] && (goods[id].kind || 'ware') === 'ware';
  /** Verkäufliche Ware im ganzen Laden (Material an den Arbeitstischen zählt nicht) */
  function shopStock() {
    return state.items.filter((it) => !it.guest).reduce((a, it) => a + Object.keys(it.stock || {}).filter(isWare).reduce((n, w) => n + it.stock[w], 0), 0);
  }
  // Möbel, an denen Kunden sich Ware ansehen (nicht die Arbeitstische mit Material)
  // Regale, an die Kunden kommen: nicht in Räumen (Lager, Geheimraum), nicht der Geheimschrank
  // … und nicht der Gäste-Kühlschrank (daraus wird nichts verkauft)
  const holders = () => state.items.filter((it) => (catalog[it.id].holds || []).some(isWare) && !catalog[it.id].secret && !it.guest && !L.roomAt(state, it.x, it.y));
  const counter = () => state.items.find((it) => it.id === L.PC_ID);

  /** Nachfrage-Daten für heute (Bekanntheit, Sterne, Wochentag, Plakate) */
  const demandCtx = () => ({ level: state.level || 1, rating: C.rating(state.reviews), day: state.day, extra: L.posterEffect(state, more).customers });

  function openDay() {
    if (state.open) return;
    if (!act(doAct('openDay'))) return;
    day.t = 0;
    day.rng = C.rngFrom((Date.now() ^ (state.day * 7919)) >>> 0);
    day.queue = C.arrivals(C.customersToday(demandCtx(), day.rng), day.rng);
    day.customers = [];
    day.line = [];
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

  const pendingJobs = () => state.jobs.length + day.customers.filter((o) => o.services && !o.jid && !o.gone && o.phase !== 'leave').length;

  /** force (nur Test-Knöpfe): 'kunde' = sicher ohne Karte, 'auftrag' = sicher mit Karte (sonst Zufall wie im Spiel) */
  function spawn(force) {
    const c = C.newCustomer(day.rng, goodsList, { boost: L.posterEffect(state, more).boost, tier: 1, level: state.level || 1, licenses: state.licenses, coins: state.coins, prices: licensePrices() });
    // Bringt er eine Karte? Nur mit passenden Tischen und höchstens 2 Aufträge (auch die, die noch an der Kasse stehen)
    const stations = new Set(state.items.map((it) => it.id));
    c.services = force === 'kunde' ? null : C.serviceWish(force === 'auftrag' ? () => 0 : day.rng, stations, pendingJobs(), packs, serviceList);
    if (force === 'auftrag' && c.services) {
      // Test: Paket zufällig unter denen, für die die Tische stehen (serviceWish nimmt mit rng = 0 immer das erste)
      const ok = packs.filter((p) => p.services.every((id) => more.services[id] && stations.has(more.services[id].station)));
      c.services = ok[Math.floor(day.rng() * ok.length)].services.slice();
    }
    if (c.services) c.wish = null;
    const sx = Math.floor(day.rng() * state.units * L.UNIT_W);
    Object.assign(c, {
      id: day.nextId++, x: sx + 0.5, y: L.UNIT_D + L.SIDEWALK - 0.4, path: [], phase: 'enter', wait: 0,
      color: COLORS[Math.floor(day.rng() * COLORS.length)], seen: [], visit: [], bubble: '', bubbleT: 0, basket: [],
      dirty: day.rng() < C.DIRT_CHANCE, // hinterlässt irgendwo im Laden einen Fleck
    });
    const door = L.DOOR[Math.floor(day.rng() * L.DOOR.length)];
    goTo(c, new Set([door.x + ',' + door.y]));
    // Regale, die er ansehen will: mit Wunschware zuerst, dann zufällige, höchstens 3
    const all = holders();
    const withWish = all.filter((it) => c.wish && freeStock(it, c.wish) > 0);
    const rest = all.filter((it) => !withWish.includes(it)).sort(() => day.rng() - 0.5);
    c.visit = c.services ? [] : withWish.slice(0, 2).concat(rest).slice(0, 3).map((it) => it.uid);
    day.customers.push(c);
    snd('door');
  }

  function goTo(c, goals) {
    const start = { x: Math.floor(c.x), y: Math.floor(c.y) };
    const p = goals.size ? C.path(state, catalog, start, goals, custBlock) : null;
    c.path = p || [];
    return !!p;
  }

  function say(c, text, sec) {
    c.bubble = text;
    c.bubbleT = sec || 2.5;
  }

  function nextLeg(c) {
    if (c.services) { c.phase = 'queue'; c.wait = 0; queueUp(c); say(c, 'Ich hab eine Karte für euch!', 2.5); return; }
    while (c.visit.length) {
      const it = state.items.find((i) => i.uid === c.visit[0]);
      if (it && goTo(c, C.approach(state, catalog, it, custBlock))) { c.phase = 'look'; c.lookAt = it.uid; return; }
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
      Object.keys(it.stock).forEach((w) => offers.push({ uid: uid, ware: w, qty: freeStock(it, w), price: L.price(state, goods, w), market: L.marketPrice(state, goods, w) }));
    });
    const r = C.shop(c, offers, goods, day.rng);
    c.result = r;
    c.basket = r.basket;
    c.basket.forEach((b) => { reserved[resKey(b.uid, b.ware)] = (reserved[resKey(b.uid, b.ware)] || 0) + b.qty; });
    if (r.missWish) say(c, 'Habt ihr ' + goods[c.wish].name + '?', 3);
    else if (r.tooExpensive.length && !r.basket.length) say(c, 'Viel zu teuer!', 2.5);
    else if (r.stars < 5 && r.basket.length) say(c, 'Hmm, teuer …', 2);
    if (r.basket.length) { c.phase = 'queue'; c.wait = 0; queueUp(c); }
    else leave(c, capDirt(C.review(r, shopStock(), day.rng)));
  }

  /** Warteplätze an der Kasse: freie Zellen neben der Theke, dann dahinter */
  /** Plätze in der Schlange: gerade vor der Kassentheke (ShopCustomers.queueLine) */
  function queueSpots() {
    const pc = counter();
    return pc ? C.queueLine(state, catalog, pc, custBlock, 12) : [];
  }

  /** Wer steht an (in Ankunfts-Reihenfolge) – rückt nach, wenn vorne jemand fertig ist */
  function reflowLine() {
    day.line = (day.line || []).filter((o) => o.phase === 'queue' && !o.gone);
    const spots = queueSpots();
    day.line.forEach((o, i) => {
      const spot = spots[Math.min(i, spots.length - 1)];
      if (!spot) return;
      if (o.spot !== spot) { o.spot = spot; goTo(o, new Set([spot])); }
    });
  }

  function queueUp(c) {
    if (!queueSpots().length) { release(c); leave(c, null); return; }
    day.line = day.line || [];
    if (!day.line.includes(c)) day.line.push(c);
    c.spot = null;
    reflowLine();
  }

  function dequeue(c) {
    if (!day.line || !day.line.includes(c)) return;
    day.line = day.line.filter((o) => o !== c);
    c.spot = null;
    reflowLine();
  }

  function leave(c, rev, kind) {
    c.phase = 'leave';
    dequeue(c);
    const miss = c.result && c.result.missWish ? c.wish : '';
    if (kind !== 'paid') act(doAct('leave', Object.assign({ miss: miss }, rev || {})));
    const exits = new Set();
    for (let x = 0; x < state.units * L.UNIT_W; x++) exits.add(x + ',' + (L.UNIT_D + L.SIDEWALK - 1));
    if (!goTo(c, exits)) c.gone = true;
  }

  function firstInLine() {
    const c = (day.line || [])[0];
    return c && c.phase === 'queue' && !c.path.length && !c.serving ? c : null;
  }

  /** Auftrag annehmen (Preis prüfen, Server würfelt die Karte), Kunde setzt sich und wartet */
  function acceptJob(c) {
    const price = c.services.reduce((a, id) => a + L.servicePrice(state, more, id), 0);
    const market = c.services.reduce((a, id) => a + ((more.services[id] || {}).market || 0), 0);
    const j = C.judge(price, market, c.tol);
    if (!j.buy) {
      say(c, 'Viel zu teuer!', 2.5);
      leave(c, null);
      return;
    }
    c.priceStars = j.stars;
    c.phase = 'taking';
    dequeue(c);
    const body = new URLSearchParams({ _csrf: root.dataset.csrf, aktion: JSON.stringify({ type: 'takeJob', services: c.services, cid: c.id }) });
    fetch('/api/shop-demo', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then((r) => r.json())
      .then((res) => {
        if (res.state) state = res.state;
        if (res.error || !res.jid) {
          toast(res.error || 'Auftrag nicht angenommen.');
          refresh();
          leave(c, null);
          return;
        }
        c.jid = res.jid;
        setTimeout(prefetchBenches, 0);
        const job = state.jobs.find((x) => x.jid === c.jid);
        c.services = job.services; // evtl. mit Bügeln
        const tables = new Set(job.services.map((id) => more.services[id].station));
        c.patience = C.SERVICE_PATIENCE * tables.size;
        c.phase = 'wait';
        c.wait = 0;
        say(c, 'Danke! Ich warte dort.', 2.5);
        goTo(c, waitSpot(c));
        refresh();
      })
      .catch(() => { toast('Keine Verbindung.'); leave(c, null); });
  }

  /** Wo ein Kunde mit Auftrag wartet: neben einem freien Stuhl, sonst irgendwo frei im Laden */
  function waitSpot(c) {
    const taken = new Set(day.customers.filter((o) => o !== c && o.phase === 'wait' && o.seat).map((o) => o.seat));
    for (const it of state.items.filter((i) => i.id === 'chair' || i.id === 'beanbag')) {
      const spots = Array.from(C.approach(state, catalog, it, custBlock)).filter((k) => !taken.has(k));
      if (spots.length) { c.seat = spots[0]; c.chair = true; return new Set([spots[0]]); }
    }
    c.chair = false;
    const line = new Set(queueSpots());
    const free = [];
    for (let y = 0; y < L.UNIT_D - 1; y++) {
      for (let x = 0; x < state.units * L.UNIT_W; x++) {
        const k = x + ',' + y;
        if (!line.has(k) && !taken.has(k) && C.walkableCell(state, custBlock, x, y)) free.push(k);
      }
    }
    c.seat = free[0] || null;
    return new Set(free.slice(0, 1));
  }

  function jobOf(c) {
    return c.jid ? state.jobs.find((x) => x.jid === c.jid) : null;
  }

  /** Kassen-Minispiel öffnen (public/js/shop-kasse.js); done() bucht, Abbrechen lässt den Kunden weiter warten */
  /**
   * Kassen-Minispiel (public/js/shop-kasse.js): Feilschen (nur bei Waren, selten, großer Einkauf), Scannen, Bezahlen
   * (Karte/bar, Falschgeld nur bei Kunden mit Illegalem). done(res) mit { deal, method, lost, short, walk }
   */
  function scanThen(c, title, lines, done, opts) {
    const o = opts || {};
    const total = lines.reduce((a, l) => a + l.qty * l.price, 0);
    if (!window.ShopKasse || !gameRef) { done({ method: 'card', lost: 0 }); return; }
    c.serving = true;
    window.ShopKasse.open(gameRef, {
      title: title,
      lines: lines,
      total: total,
      haggle: o.haggle ? C.haggle(total, day.rng) : null,
      answer: (h, counter, t) => C.haggleAnswer(h, counter, t, day.rng),
      pay: { method: C.payMethod(day.rng) },
      customer: { illegal: !!c.illegal },
      rng: day.rng,
      onDone: (res) => { c.serving = false; done(res || {}); },
      onCancel: () => { c.serving = false; },
    });
  }

  function serveJob(c) {
    const job = jobOf(c);
    if (!job) { leave(c, null); return; }
    const lines = job.services.map((id) => ({ name: (more.services[id] || {}).name || id, qty: 1, price: L.servicePrice(state, more, id), color: 0xffffff }));
    scanThen(c, 'Auftrag Kunde ' + job.jid, lines, (res) => {
      const stars0 = Math.min(c.priceStars || 5, C.workStars(job.services, job.results), C.comfortStars(c.chair, c.drink), res.short ? 3 : 5);
      const capped = capDirt({ stars: stars0, why: 'job' + stars0 });
      const stars = capped.stars;
      const total = job.services.reduce((a, id) => a + L.servicePrice(state, more, id), 0);
      snd('kaching');
      act(doAct('serviceCheckout', { jid: job.jid, stars: stars, why: capped.why === 'dirty' ? 'dirty' : 'job' + stars, method: res.method, lost: res.lost }));
      say(c, '+' + fmt(total) + ' Kanacoin', 2);
      leave(c, null, 'paid');
    });
  }

  function serve(c) {
    if (c.services && !c.jid) { acceptJob(c); return; }
    if (c.jid) { serveJob(c); return; }
    const scan = c.basket.map((b) => ({ name: goods[b.ware].name, qty: b.qty, price: L.price(state, goods, b.ware), color: goods[b.ware].color }));
    c.illegal = c.basket.some((b) => goods[b.ware] && goods[b.ware].illegal); // Falschgeld versuchen nur diese (vorbereitet)
    scanThen(c, 'Kunde', scan, (res) => {
      release(c);
      // Feilschen abgelehnt und der Kunde geht: kein Kauf, keine schlechte Bewertung (Krisztian, 2026-10-17)
      if (res.walk) { leave(c, { miss: c.result.missWish ? c.wish : '' }); return; }
      const lines = c.basket.map((b) => ({ uid: b.uid, ware: b.ware, qty: b.qty }));
      let rev = capDirt(C.review(c.result, shopStock(), day.rng));
      if (res.short && rev && rev.stars > 3) rev = { stars: 3, why: '3' }; // zu wenig Wechselgeld
      const full = c.basket.reduce((a, b) => a + b.qty * L.price(state, goods, b.ware), 0);
      const paid = res.deal || full;
      snd('kaching');
      act(doAct('checkout', Object.assign({ lines: lines, miss: c.result.missWish ? c.wish : '', method: res.method, deal: res.deal || undefined, lost: res.lost || 0 }, rev || {})));
      say(c, '+' + fmt(paid - (res.lost || 0)) + ' Kanacoin', 2);
      leave(c, null, 'paid');
    }, { haggle: true });
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
    if (c.dirty && c.y < L.UNIT_D - 0.5 && c.phase !== 'enter') {
      c.dirty = false;
      act(doAct('dirt', { x: Math.round((c.x + (day.rng() - 0.5) * 0.4) * 100) / 100, y: Math.round((c.y + (day.rng() - 0.5) * 0.4) * 100) / 100, at: Date.now() }));
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
      if (c.serving) return;
      c.wait += sec;
      if (c.wait >= C.PATIENCE) {
        release(c);
        say(c, 'Zu lange gewartet!', 2.5);
        if (c.jid && jobOf(c)) { act(doAct('jobCancel', Object.assign({ jid: c.jid }, C.angryReview()))); leave(c, null, 'paid'); }
        else leave(c, C.angryReview());
      }
      return;
    }
    if (c.phase === 'wait') {
      c.wait += sec;
      // am Stuhl angekommen: steht auf, holt sich gratis etwas aus dem Gäste-Kühlschrank (einmal) und setzt sich wieder
      if (c.chair && !c.path.length) {
        const guestFridge = (uid) => state.items.find((it) => it.guest && (!uid || it.uid === uid) && Object.keys(it.stock || {}).some((w) => it.stock[w] > 0));
        if (!c.drinkTried) {
          c.drinkTried = true;
          const f = guestFridge();
          if (f && goTo(c, C.approach(state, catalog, f, custBlock))) { c.fetch = f.uid; say(c, 'Ich hol mir was zu trinken.', 2); }
        } else if (c.fetch) {
          const f = guestFridge(c.fetch);
          const w = f && Object.keys(f.stock).find((x) => f.stock[x] > 0);
          c.fetch = null;
          if (w && act(doAct('guestTake', { uid: f.uid, ware: w }))) { c.drink = true; say(c, 'Danke für ' + goods[w].name + '!', 2.5); }
          else say(c, 'Schon leer …', 2);
          if (c.seat) goTo(c, new Set([c.seat]));
        }
      }
      const job = jobOf(c);
      if (job && !L.nextService(job)) { c.phase = 'queue'; c.wait = 0; say(c, 'Ist meine Karte fertig?', 2.5); queueUp(c); return; }
      if (!job || c.wait >= c.patience) {
        say(c, 'Das dauert mir zu lange!', 2.5);
        if (job) act(doAct('jobCancel', { jid: job.jid, stars: 2, why: 'jobwait' }));
        leave(c, null, 'paid'); // jobCancel zählt den Besuch schon
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
      if (c.services && c.phase !== 'leave') { g.fillStyle(0xffffff, 1); g.fillRect(p.x + 6, p.y - 24, 6, 9); g.lineStyle(1, 0x5aa0e0, 1); g.strokeRect(p.x + 6, p.y - 24, 6, 9); }
      if ((c.phase === 'queue' || c.phase === 'wait') && !c.path.length) {
        const left = Math.max(0, 1 - c.wait / (c.phase === 'wait' ? c.patience : C.PATIENCE));
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

  let seenLevel = null;
  function refreshClock() {
    const elc = $('[data-shop-clock]');
    if (!elc) return;
    const r = C.rating(state.reviews);
    const stars = '★ ' + r.toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
    if (state.open && day.rng) {
      const frac = day.t / C.DAY_SECONDS;
      elc.textContent = 'Tag ' + state.day + ' (' + C.weekday(state.day).name + ') · ' + (frac >= 1 ? 'Ladenschluss' : C.clock(frac) + ' · geöffnet') + ' · ' + stars;
    } else elc.textContent = 'Tag ' + state.day + ' (' + C.weekday(state.day).name + ') · geschlossen · ' + stars;
    elc.textContent += ' · Stufe ' + (state.level || 1);
    if (seenLevel !== null && (state.level || 1) > seenLevel) note('Ruf-Stufe ' + state.level + ' erreicht! Am PC (Reiter Ruf) siehst du, was neu frei ist.');
    seenLevel = state.level || 1;
  }

  let noteTimer = 0;
  function note(msg) {
    snd(/Ruf-Stufe/.test(msg) ? 'level' : 'note');
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
    if (last.cash || last.card) {
      body.appendChild(el('div', 'sd-group', 'Bezahlt'));
      body.appendChild(el('p', 'sd-later', 'Bar ' + fmt(last.cash || 0) + ' · Karte ' + fmt(last.card || 0) + (last.lost ? ' · Verlust (Falschgeld/Wechselgeld) ' + fmt(last.lost) : '')));
    }
    const wet = Object.keys(last.spoiled || {});
    if (wet.length) {
      body.appendChild(el('div', 'sd-group', 'Feuchtigkeit im Lager – verdorben'));
      body.appendChild(el('p', 'sd-later', wet.map((w) => last.spoiled[w] + '× ' + goods[w].name).join(', ')));
    }
    const done = Object.keys(last.services || {});
    if (done.length) {
      body.appendChild(el('div', 'sd-group', 'Aufträge erledigt'));
      body.appendChild(el('p', 'sd-later', done.map((id) => last.services[id] + '× ' + ((more.services[id] || {}).name || id)).join(', ')));
    }
    const miss = Object.keys(last.misses || {});
    if (miss.length) {
      body.appendChild(el('div', 'sd-group', 'Gesucht, aber nicht gefunden'));
      body.appendChild(el('p', 'sd-later', miss.map((w) => goods[w].name + ' (' + last.misses[w] + '×)').join(', ')));
    }
  }

  function pcBewertungen(body) {
    const list2 = state.reviews.slice().reverse();
    if (!list2.length) { body.appendChild(el('p', 'sd-later', 'Noch keine Bewertungen.')); return; }
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
      tr.appendChild(el('td', '', r.lines.map((l) => (l.service ? (more.services[l.service] || {}).name || l.service : l.qty + '× ' + goods[l.ware].name) + ' à ' + fmt(l.price)).join(', ')));
      tr.appendChild(el('td', 'num', fmt(r.total)));
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }

  // ---------- Figur ----------
  let blockSet = new Set();
  let custBlock = new Set(); // für Kunden zusätzlich alle Raum-Zellen
  let walls = new Set(); // Wände der Räume (Zellkanten, L.wallSet)

  /** Zellen, die die Figur gerade berührt (der Geheimschrank darf dort nicht hin) */
  function bodyCells() {
    const r = 0.18;
    return Array.from(new Set([[-r, -r], [r, -r], [-r, r], [r, r]].map(([ox, oy]) => Math.floor(player.x + ox) + ',' + Math.floor(player.y + oy))));
  }

  /** Abstand eines Punkts zu einem Wandstück (Kante 'h:x,y' bzw. 'v:x,y') */
  function wallDist(key, px, py) {
    const [t, rest] = key.split(':');
    const [a, b] = rest.split(',').map(Number);
    const cx = t === 'h' ? Math.max(a, Math.min(a + 1, px)) : a;
    const cy = t === 'h' ? b : Math.max(b, Math.min(b + 1, py));
    return Math.hypot(px - cx, py - cy);
  }
  /**
   * Läuft die Figur in eine Raumwand? Körper = Kreis (Radius 0,2): blockiert nur, wenn er einer Wand näher als der
   * Radius kommt UND sich ihr dabei nähert – wegbewegen geht immer (so kann man nie festklemmen)
   */
  function throughWall(fx, fy, tx, ty) {
    const R = 0.2;
    for (const key of walls) {
      const dTo = wallDist(key, tx, ty);
      if (dTo >= R) continue;
      if (dTo < wallDist(key, fx, fy)) return true;
    }
    // die Kante selbst überqueren (sehr schnelle Schritte)
    const ax = Math.floor(fx);
    const ay = Math.floor(fy);
    const bx = Math.floor(tx);
    const by = Math.floor(ty);
    return (ax !== bx || ay !== by) && Math.abs(ax - bx) + Math.abs(ay - by) === 1 && L.wallBetween(walls, ax, ay, bx, by);
  }

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
      if (canStand(player.x + gx, player.y, fromY) && !throughWall(player.x, player.y, player.x + gx, player.y)) player.x += gx;
      if (canStand(player.x, player.y + gy, fromY) && !throughWall(player.x, player.y, player.x, player.y + gy)) player.y += gy;
      stepT += sec;
      if (stepT >= 0.3) { stepT = 0; snd('step'); }
    } else stepT = 0.25; // erster Schritt kommt gleich
    findTarget();
  }

  function drawHero() {
    const g = scene.hero;
    g.clear();
    const p = iso(player.x, player.y);
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(p.x, p.y, 26, 12);
    // Kleidung (PC → Kleidung): Oberteil, Hose, Kopf
    const wear = (slot) => clothesList.find((c) => c.id === (state.outfit || {})[slot]) || null;
    const top = wear('oberteil');
    const legs = wear('hose');
    const head = wear('kopf');
    g.fillStyle(legs ? legs.color : 0x2a3550, 1);
    g.fillRect(p.x - 8, p.y - 14, 7, 12);
    g.fillRect(p.x + 1, p.y - 14, 7, 12);
    g.fillStyle(top ? top.color : 0x2f6fd0, 1);
    g.fillRoundedRect(p.x - 9, p.y - 34, 18, 22, 7);
    g.fillStyle(0xf0c8a0, 1);
    g.fillCircle(p.x, p.y - 42, 9);
    g.lineStyle(1.5, 0x0e1a33, 1);
    g.strokeRoundedRect(p.x - 9, p.y - 34, 18, 22, 7);
    g.strokeCircle(p.x, p.y - 42, 9);
    if (head) {
      g.fillStyle(head.color, 1);
      if (head.shape === 'kappe') { g.fillEllipse(p.x, p.y - 47, 20, 10); g.fillRect(p.x, p.y - 47, 13, 3); }
      else if (head.shape === 'muetze') { g.fillEllipse(p.x, p.y - 48, 20, 13); g.fillCircle(p.x, p.y - 56, 3); }
      else { g.fillRoundedRect(p.x - 11, p.y - 53, 22, 20, 8); g.fillStyle(0xf0c8a0, 1); g.fillCircle(p.x, p.y - 41, 7); }
    }
    if (held === 'mop') {
      const wob = mopping ? Math.sin(mopping.t * 18) * 5 : 0;
      g.lineStyle(3, 0x8a6a3a, 1);
      g.lineBetween(p.x + 10, p.y - 30, p.x + 16 + wob, p.y + 2);
      g.fillStyle(0xd8d0c0, 1);
      g.fillEllipse(p.x + 17 + wob, p.y + 3, 16, 6);
      if (mopping) {
        g.lineStyle(4, 0x4fd17a, 1);
        g.beginPath();
        g.arc(p.x, p.y - 62, 9, -Math.PI / 2, -Math.PI / 2 + (mopping.t / MOP_SECONDS) * Math.PI * 2);
        g.strokePath();
      }
    }
    const h = hand();
    if (h) {
      g.fillStyle(0xa07a4a, 1);
      g.fillRect(p.x - 12, p.y - 30, 24, 16);
      g.lineStyle(1.5, 0x5a4024, 1);
      g.strokeRect(p.x - 12, p.y - 30, 24, 16);
      g.fillStyle(cartonColor(h), 1);
      g.fillRect(p.x - 12, p.y - 24, 24, 4);
    }
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

  /** Auftrag, der jetzt an diesem Möbel dran ist */
  function jobAt(it) {
    return state.jobs.find((j) => {
      const n = L.nextService(j);
      return n && more.services[n] && more.services[n].station === it.id;
    }) || null;
  }

  function benchTarget(near) {
    for (const o of near) {
      const job = jobAt(o.it);
      if (!job) continue;
      const n = L.nextService(job);
      const label = n === 'foil' ? 'E: Karte von Kunde ' + job.jid + ' in TCG Sleeve stecken' : 'E: ' + more.services[n].name + ' – Karte von Kunde ' + job.jid;
      return { label: label, run: () => openBench(job, o.it.id) };
    }
    return null;
  }

  function openBench(job, station) {
    if (job.services.includes('foil') && station === 'pack_opening_counter' && !L.supplier(state, 'mat_sleeve')) { toast('Kein TCG Sleeve – erst am PC bestellen und in die Öffnungstheke einräumen.'); return; }
    const needsSlab = job.services.includes('slab') && !job.done.includes('slab') && station === 'card_grading_table';
    if (needsSlab && !L.supplier(state, 'mat_slab')) { toast('Kein leerer Slab – erst am PC bestellen und in den Tisch einräumen.'); return; }
    const q = '?auftrag=' + encodeURIComponent(job.jid) + '&tisch=' + encodeURIComponent(station);
    const oldTable = () => {
      $('[data-shop-bench-frame]').src = '/shop-demo/werkbank' + q;
      $('[data-shop-bench]').showModal();
    };
    // Phaser-Tisch im Spiel (public/js/shop-werkbank-phaser.js), solange er die Schritte kann – sonst der Tisch der Seite
    if (!window.ShopWerkbank || !gameRef) { oldTable(); return; }
    const start = (jobData) => {
      if (!window.ShopWerkbank.handles(jobData.steps)) { oldTable(); return; }
      window.ShopWerkbank.open(gameRef, {
        job: jobData, station: station, csrf: root.dataset.csrf,
        // fertig: der Server schickt den neuen Stand mit; Esc: nichts geändert, nichts nachladen
        onDone: (res) => {
          if (!res || !res.state) { reload(); return; }
          state = res.state;
          benchCache.clear();
          refresh();
          prefetchBenches();
        },
        onCancel: () => { if (scene) findTarget(); },
      });
    };
    const key = job.jid + '|' + station;
    const ready = benchCache.get(key);
    if (ready) { benchCache.delete(key); start(ready); return; }
    fetchBench(job.jid, station).then((res) => (res.error ? toast(res.error) : start(res.jobData))).catch(() => toast('Keine Verbindung.'));
  }

  // Vorab laden (Krisztian, 2026-10-14: der Tisch ging zu langsam auf): sobald klar ist, welcher Tisch als Nächstes
  // dran ist, Tischdaten holen und Kartenbilder schon in Phaser legen – E öffnet dann ohne Wartezeit
  const benchCache = new Map();
  function fetchBench(jid, station) {
    return fetch('/api/shop-demo/werkbank?auftrag=' + encodeURIComponent(jid) + '&tisch=' + encodeURIComponent(station), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => r.json());
  }
  function preloadImage(url) {
    if (!url || !gameRef || gameRef.textures.exists('wb:' + url)) return;
    const img = new Image();
    img.onload = () => { if (!gameRef.textures.exists('wb:' + url)) gameRef.textures.addImage('wb:' + url, img); };
    img.src = url;
  }
  function prefetchBenches() {
    if (!window.ShopWerkbank || !state) return;
    state.jobs.forEach((job) => {
      const n = L.nextService(job);
      const station = n && more.services[n] ? more.services[n].station : null;
      if (!station) return;
      const key = job.jid + '|' + station;
      if (benchCache.has(key)) return;
      benchCache.set(key, null); // läuft schon
      fetchBench(job.jid, station)
        .then((res) => {
          if (res.error || !res.jobData || !window.ShopWerkbank.handles(res.jobData.steps)) { benchCache.delete(key); return; }
          benchCache.set(key, res.jobData);
          preloadImage(res.jobData.card && res.jobData.card.image);
          preloadImage(res.jobData.back);
        })
        .catch(() => benchCache.delete(key));
    });
  }

  /** Neuer Stand vom Server (nach dem Arbeitstisch) */
  function reload() {
    return fetch('/api/shop-demo', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((data) => { if (data.state) { state = data.state; benchCache.clear(); refresh(); prefetchBenches(); } });
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin || !e.data || e.data.type !== 'shop-werkbank') return;
    const dlg = $('[data-shop-bench]');
    if (dlg.open) dlg.close();
    reload();
  });
  $('[data-shop-bench]').addEventListener('close', () => {
    $('[data-shop-bench-frame]').src = 'about:blank';
    reload();
  });

  /** Was würde E jetzt tun? */
  function findTarget() {
    const h = hand();
    const near = state.items.map((it) => ({ it, dist: itemDist(it) })).filter((o) => o.dist <= REACH).sort((a, b) => a.dist - b.dist);
    const pc = near.find((o) => o.it.id === 'cashier_counter');
    const holders = near.filter((o) => catalog[o.it.id].holds);
    let t = null;
    const waiting = pc && state.open ? firstInLine() : null;
    const atDoor = !state.open && L.DOOR.some((d) => Math.hypot(d.x + 0.5 - player.x, d.y + 1 - player.y) < 1.3);
    if (held === 'mop') {
      const d = nearDirt();
      target = d ? { label: mopping ? 'Wischen …' : 'E halten: Fleck wegwischen', run: () => { mopping = { did: d.d.did, t: 0 }; } } : null;
      return;
    }
    if (waiting) {
      t = { label: 'E: Kunde kassieren', run: () => serve(waiting) };
    } else if (atDoor && !h) {
      t = { label: 'E: Laden öffnen (Tag ' + state.day + ')', run: openDay };
    } else if (!h && benchTarget(near)) {
      t = benchTarget(near);
    } else if (h && h.kind === 'moebel') {
      t = { label: 'E: ' + catalog[h.id].name + ' aufbauen', run: () => { mode = { kind: 'build', id: h.id, rot: 0 }; selected = null; refresh(); } };
    } else if (h) {
      const fit = holders.find((o) => catalog[o.it.id].holds.includes(h.id) && L.used(o.it) < catalog[o.it.id].slots);
      if (fit) t = { label: 'E: in ' + catalog[fit.it.id].name + ' einräumen', run: () => { if (act(doAct('stock', { uid: fit.it.uid }))) snd('stock'); } };
      else if (pc) t = { label: 'E: PC benutzen', run: openPc };
      else t = { label: 'E: Karton abstellen', run: dropHere };
    } else {
      const box = state.boxes
        .filter((b) => b.bid !== state.carry)
        .map((b) => ({ b, dist: Math.hypot(b.x - player.x, b.y - player.y) }))
        .filter((o) => o.dist <= 0.75)
        .sort((a, b) => a.dist - b.dist)[0];
      const first = near.find((o) => o.it.id === 'cashier_counter' || catalog[o.it.id].holds);
      const cab = near.find((o) => catalog[o.it.id].secret);
      if (cab && (!box || cab.dist <= box.dist)) t = { label: 'E: Schrank schieben', run: () => act(doAct('slideCabinet', { uid: cab.it.uid, avoid: bodyCells() })) };
      else if (box && (!first || box.dist <= first.dist)) t = { label: 'E: Karton aufheben (' + boxName(box.b) + ')', run: () => { if (act(doAct('pick', { bid: box.b.bid }))) snd('pickup'); } };
      else if (first && first.it.id === 'cashier_counter') t = { label: 'E: PC benutzen', run: openPc };
      else if (first) t = { label: 'E: ' + catalog[first.it.id].name + ' ansehen', run: () => openShelf(first.it.uid) };
    }
    target = t;
  }

  function dropHere() {
    if (act(doAct('drop', { x: Math.round(player.x * 100) / 100, y: Math.round(player.y * 100) / 100 }))) snd('drop');
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
    }
    for (let y = 0; y < L.UNIT_D; y++) {
      poly(w, [iso(0, y), iso(0, y + 1), iso(0, y + 1, WALL_H), iso(0, y, WALL_H)], 0xb3a998, 1, 0x948a7a);
    }
  }

  const ROOM_WALL_H = 56;

  /** Wandstücke vor der Figur (näher am Betrachter, auf dem Bildschirm in der Nähe) durchsichtig machen */
  function fadeWalls() {
    if (!scene || !scene.sortables) return;
    const p = { x0: player.x, y0: player.y, x1: player.x, y1: player.y };
    const ps = iso(player.x, player.y, 24);
    scene.sortables.forEach((o) => {
      if (!o.wall) return;
      const front = inFront(o.box, p) && !inFront(p, o.box);
      const near = Math.abs(o.mid.x - ps.x) < 70 && o.mid.y - ps.y > -20 && o.mid.y - ps.y < 90;
      const target = front && near ? 0.28 : 1;
      o.g.alpha += (target - o.g.alpha) * 0.25;
    });
  }
  function drawRooms() {
    const g = scene.floor;
    (state.rooms || []).forEach((r) => {
      const col = r.kind === 'lager' ? 0x6a707c : 0x5a2434;
      for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.d; y++) poly(g, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], col, 0.55);
    });
    // Wand hinten (Nord/West des Raums) hoch, vorne (Süd/Ost) niedrig – sonst verdeckt sie Raum und Figur
    L.wallPieces(state).forEach((p) => {
      const [t, rest] = p.key.split(':');
      const [a, b] = rest.split(',').map(Number);
      // Krisztian (2026-10-16): Wände nicht niedriger machen (später eine ganze Stadt) – voll hoch, und wer davor steht,
      // sieht durch: steht die Figur dahinter, wird das Wandstück durchsichtig (fadeWalls)
      const T = 0.12;
      const bx = t === 'h' ? { x: a - T / 2, y: b - T / 2, w: 1 + T, d: T } : { x: a - T / 2, y: b - T / 2, w: T, d: 1 + T };
      const wg = scene.add.graphics();
      box(wg, bx.x, bx.y, bx.w, bx.d, ROOM_WALL_H, 0, p.near ? 0xc9bfae : 0xb8ad9a, 1, 0x8a7f6c, 0);
      scene.items.push(wg);
      // Sortier-Box = genau die Kante (nicht die gezeichnete Dicke)
      const line = t === 'h' ? { x0: a, y0: b, x1: a + 1, y1: b } : { x0: a, y0: b, x1: a, y1: b + 1 };
      const entry = { g: wg, box: Object.assign(line, { bias: 0 }), wall: true, mid: iso(t === 'h' ? a + 0.5 : a, t === 'h' ? b : b + 0.5, ROOM_WALL_H / 2) };
      scene.sortables.push(entry);
    });
    // Raumnamen auf dem Boden
    if (showNames) {
      (state.rooms || []).forEach((r) => {
        const c = iso(r.x + r.w / 2, r.y + r.d / 2);
        const t = scene.add.text(c.x, c.y, r.name || '', { fontSize: '11px', color: '#f0e6d0', backgroundColor: '#00000066', padding: { x: 4, y: 1 } });
        scene.labels.push(t.setOrigin(0.5).setDepth(-7900).setResolution(2));
      });
    }
  }

  /** Vorder- und rechte Seitenwand nur niedrig (wie abgeschnitten), damit nichts dahinter verschwindet */
  const LOW_WALL = 16;
  function drawLowWalls() {
    const front = state.units * L.UNIT_W;
    const d0 = L.DOOR[0].x;
    const d1 = L.DOOR[L.DOOR.length - 1].x + 1;
    const add = (x, y, w, d) => {
      const g = scene.add.graphics();
      box(g, x, y, w, d, LOW_WALL, 0, 0xc9bfae, 1, 0x948a7a, 0);
      scene.items.push(g);
      scene.sortables.push({ g: g, box: { x0: x, y0: y, x1: x + w, y1: y + d, bias: 0 } });
    };
    // Vorderwand außen an y = UNIT_D, Lücke an der Tür; Seitenwand außen an x = Ende des Ladens
    [[0, d0], [d1, front]].forEach(([a, b]) => { if (b > a) add(a, L.UNIT_D, b - a, 0.12); });
    add(front, 0, 0.12, L.UNIT_D + 0.12);
  }

  // ---------- Regal-Etikett (Krisztian, 2026-10-18): was drin ist – am Möbel in der Nähe oder unter der Maus ----------
  // Egal wie das Möbel gedreht ist: über ihm erscheint ein Schild mit Ware, Stückzahl und Füllstand.
  const LOW_STOCK = 0.2; // bis 20 % belegt = fast leer (gelbes Warnzeichen)
  let hoverUid = null;
  let etikettKey = '';
  const holdsWare = (it) => !!catalog[it.id] && (catalog[it.id].holds || []).some(isWare);
  function etikettFor() {
    if (!state || mode || dialogOpen()) return null;
    const h = hoverUid && state.items.find((i) => i.uid === hoverUid && holdsWare(i));
    if (h) return h;
    let best = null;
    let bd = 1.3;
    state.items.forEach((it) => {
      if (!holdsWare(it)) return;
      L.cells(catalog[it.id], it).forEach((k) => {
        const [x, y] = k.split(',').map(Number);
        const dd = Math.hypot(Math.max(x - player.x, 0, player.x - (x + 1)), Math.max(y - player.y, 0, player.y - (y + 1)));
        if (dd < bd) { bd = dd; best = it; }
      });
    });
    return best;
  }
  function drawEtikett() {
    const it = etikettFor();
    const top = it && scene.tops && scene.tops[it.uid];
    const key = top ? it.uid + '|' + JSON.stringify(it.stock || {}) + '|' + top.x + ',' + top.y + '|' + showNames : '';
    if (key === etikettKey) return;
    etikettKey = key;
    if (scene.etikett) { scene.etikett.destroy(); scene.etikett = null; }
    if (!key) return;
    const d = catalog[it.id];
    const ids = Object.keys(it.stock || {}).filter((w) => it.stock[w] > 0);
    const lines = ids.slice(0, 5);
    const w = 160;
    const h = 32 + Math.max(1, lines.length) * 14 + (ids.length > 5 ? 14 : 0);
    const c = scene.add.container(top.x, top.y - (showNames ? 20 : 6)).setDepth(31000);
    const g = scene.add.graphics();
    g.fillStyle(0x1c1f2b, 0.94);
    g.fillRoundedRect(-w / 2, -h, w, h, 6);
    g.lineStyle(1, 0x5a6078, 1);
    g.strokeRoundedRect(-w / 2, -h, w, h, 6);
    const used = L.used(it);
    const frac = d.slots ? Math.min(1, used / d.slots) : 0;
    g.fillStyle(0x000000, 0.5);
    g.fillRect(-w / 2 + 8, -h + 21, w - 16, 4);
    g.fillStyle(frac === 0 ? 0xe0525a : frac <= LOW_STOCK ? 0xe0b040 : 0x4fd17a, 1);
    g.fillRect(-w / 2 + 8, -h + 21, (w - 16) * frac, 4);
    c.add(g);
    const txt = (x, y, s, col) => c.add(scene.add.text(x, y, s, { fontSize: '10px', color: col || '#e6e1d6' }).setResolution(2));
    txt(-w / 2 + 8, -h + 5, (it.guest ? 'Gäste · ' : '') + used + ' / ' + d.slots + ' belegt');
    if (!lines.length) txt(-w / 2 + 8, -h + 30, 'leer', '#e0525a');
    lines.forEach((wid, i) => {
      const y = -h + 30 + i * 14;
      g.fillStyle(goods[wid] ? goods[wid].color : 0xffffff, 1);
      g.fillRect(-w / 2 + 8, y + 2, 8, 8);
      txt(-w / 2 + 20, y, (goods[wid] ? goods[wid].name : wid) + '  ×' + it.stock[wid]);
    });
    if (ids.length > 5) txt(-w / 2 + 8, -h + 30 + 5 * 14, '+' + (ids.length - 5) + ' weitere', '#8a90a4');
    scene.etikett = c;
  }

  function drawAll() {
    if (!scene) return;
    blockSet = L.blocked(state, catalog);
    walls = L.wallSet(state);
    custBlock = new Set(blockSet);
    L.roomCells(state).forEach((k) => custBlock.add(k));
    drawFloor();
    scene.items.forEach((o) => o.destroy());
    scene.labels.forEach((o) => o.destroy());
    scene.extra.forEach((o) => o.destroy());
    scene.items = [];
    scene.labels = [];
    scene.extra = [];
    scene.hulls = [];
    scene.sortables = [];
    drawLowWalls();
    drawRooms();
    drawDirt();

    if (state.units < L.MAX_UNITS) {
      const c = iso(state.units * L.UNIT_W + L.UNIT_W / 2, L.UNIT_D / 2);
      const t = scene.add.text(c.x, c.y, 'Zu verkaufen\n' + fmt(unitPrice) + ' Kanacoin\n' + (lockedFor(rufCfg.unlock.unit) ? '(ab Ruf-Stufe ' + rufCfg.unlock.unit + ')' : '(klicken)'), {
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
      const layer = catalog[it.id].layer;
      if (r.box && (layer === 'boden' || layer === 'theke' || layer === 'wandnah')) scene.sortables.push({ g: g, box: r.box });
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
      scene.sortables.push({ g: g, box: { x0: b.x - 0.2, y0: b.y - 0.2, x1: b.x + 0.2, y1: b.y + 0.2, bias: 0 } });
      if (showNames) {
        const p = iso(b.x, b.y, 18);
        const t = scene.add.text(p.x, p.y, b.kind === 'moebel' ? catalog[b.id].name : '×' + b.qty, { fontSize: '9px', color: '#ffe9c0', backgroundColor: '#00000088', padding: { x: 2, y: 0 } });
        scene.labels.push(t.setOrigin(0.5, 1).setDepth(14000).setResolution(2));
      }
    });

    scene.tops = {};
    drawn.forEach(({ it, r }) => { scene.tops[it.uid] = r.top || r.hull[0]; });
    etikettKey = '';
    // Warnzeichen über leeren (rot) / fast leeren (gelb) Verkaufsmöbeln – Krisztian, 2026-10-18
    drawn.forEach(({ it, r }) => {
      const d = catalog[it.id];
      if (!holdsWare(it) || d.secret || d.lagerOnly || !d.slots || L.roomAt(state, it.x, it.y)) return;
      const frac = L.used(it) / d.slots;
      if (frac > LOW_STOCK) return;
      const p = r.top || r.hull[0];
      const y = p.y - (showNames ? 30 : 16);
      const g = scene.add.graphics().setDepth(15500);
      g.fillStyle(frac === 0 ? 0xe0525a : 0xe0b040, 1);
      g.fillCircle(p.x, y, 8);
      g.lineStyle(2, 0x1c1f2b, 1);
      g.strokeCircle(p.x, y, 8);
      scene.extra.push(g);
      scene.extra.push(scene.add.text(p.x, y, '!', { fontSize: '12px', color: '#1c1f2b', fontStyle: 'bold' }).setOrigin(0.5).setDepth(15501).setResolution(2));
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

  // ---------- Raum bauen: Rechteck aufziehen, dann Tür-Kante wählen ----------
  const cellOf = (h) => ({ x: Math.floor(h.x), y: Math.floor(h.y) });
  function roomRect() {
    if (!mode || !mode.a || !mode.b) return null;
    const x = Math.min(mode.a.x, mode.b.x);
    const y = Math.min(mode.a.y, mode.b.y);
    return { kind: mode.room, x, y, w: Math.abs(mode.a.x - mode.b.x) + 1, d: Math.abs(mode.a.y - mode.b.y) + 1 };
  }
  function roomDown() {
    if (!hover) return;
    if (mode.stage === 'rect') { mode.a = cellOf(hover); mode.b = mode.a; return; }
    const r = roomRect();
    const e = nearestEdge(r);
    if (!e) return;
    if (act(doAct('buildRoom', { kind: r.kind, x: r.x, y: r.y, w: r.w, d: r.d, door: { side: e.side, i: e.i } }))) { mode = null; refresh(); }
  }
  function roomUp() {
    if (mode.stage !== 'rect' || !mode.a) return;
    const r = roomRect();
    if (r.w < L.ROOM.minW || r.d < L.ROOM.minD) { toast('Mindestens ' + L.ROOM.minW + '×' + L.ROOM.minD + ' Felder.'); mode.a = null; mode.b = null; return; }
    mode.stage = 'door';
  }
  /** Kante des Rechtecks, die der Maus am nächsten ist (Außenwände des Ladens gehen nicht) */
  function nearestEdge(r) {
    if (!r || !hover) return null;
    const mid = (e) => {
      if (e.side === 'n') return { x: r.x + e.i + 0.5, y: r.y };
      if (e.side === 's') return { x: r.x + e.i + 0.5, y: r.y + r.d };
      if (e.side === 'w') return { x: r.x, y: r.y + e.i + 0.5 };
      return { x: r.x + r.w, y: r.y + e.i + 0.5 };
    };
    return L.roomEdges(r).filter((e) => !L.outerEdge(state, e.key))
      .map((e) => Object.assign({ m: mid(e) }, e))
      .sort((a, b) => Math.hypot(a.m.x - hover.x, a.m.y - hover.y) - Math.hypot(b.m.x - hover.x, b.m.y - hover.y))[0] || null;
  }
  /** Kante als Linie am Boden (für Wände, Tür-Markierung) */
  function edgePts(e, r, z) {
    if (e.side === 'n') return [iso(r.x + e.i, r.y, z), iso(r.x + e.i + 1, r.y, z)];
    if (e.side === 's') return [iso(r.x + e.i, r.y + r.d, z), iso(r.x + e.i + 1, r.y + r.d, z)];
    if (e.side === 'w') return [iso(r.x, r.y + e.i, z), iso(r.x, r.y + e.i + 1, z)];
    return [iso(r.x + r.w, r.y + e.i, z), iso(r.x + r.w, r.y + e.i + 1, z)];
  }
  function hoverRoom() {
    return hover ? L.roomAt(state, Math.floor(hover.x), Math.floor(hover.y)) : null;
  }
  function drawDemolishGhost(g) {
    const r = hoverRoom();
    if (!r) return;
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.d; y++) poly(g, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], 0xe0525a, 0.35);
  }
  function demolishAt() {
    const r = hoverRoom();
    if (!r) return;
    ask('„' + (r.name || 'Raum') + '“ wirklich abreißen? (+' + fmt(L.roomCost(state, r)) + ' Kanacoin zurück)').then((ok) => {
      if (ok && act(doAct('removeRoom', { rid: r.rid }))) { mode = null; refresh(); }
    });
  }

  function drawRoomGhost(g) {
    const r = roomRect();
    if (!r) return;
    const cost = L.roomCost(state, r);
    const col = r.w >= L.ROOM.minW && r.d >= L.ROOM.minD && state.coins >= cost ? 0x4fd17a : 0xe0525a;
    for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.d; y++) poly(g, [iso(x, y), iso(x + 1, y), iso(x + 1, y + 1), iso(x, y + 1)], col, 0.25);
    L.roomEdges(r).forEach((e) => {
      if (L.outerEdge(state, e.key)) return;
      const [p, q] = edgePts(e, r, 0);
      g.lineStyle(3, col, 0.9).lineBetween(p.x, p.y, q.x, q.y);
    });
    if (mode.stage === 'door') {
      const e = nearestEdge(r);
      if (e) {
        const [p, q] = edgePts(e, r, 0);
        g.lineStyle(6, 0xffd84a, 1).lineBetween(p.x, p.y, q.x, q.y);
      }
    }
    const c = iso(r.x + r.w / 2, r.y + r.d / 2);
    if (!scene.roomLabel) scene.roomLabel = scene.add.text(0, 0, '', { fontSize: '12px', color: '#fff', backgroundColor: '#000000aa', padding: { x: 6, y: 3 } }).setOrigin(0.5).setDepth(21000).setResolution(2);
    scene.roomLabel.setText((r.kind === 'lager' ? 'Lager ' : 'Geheimraum ') + r.w + '×' + r.d + ' · ' + fmt(cost) + ' Kanacoin' + (mode.stage === 'door' ? '\n' + (r.kind === 'lager' ? 'Wand für die Tür anklicken' : 'Wand für den Schrank anklicken') : '')).setPosition(c.x, c.y).setVisible(true);
  }

  function drawGhost() {
    if (!scene) return;
    const g = scene.ghost;
    g.clear();
    if (scene.roomLabel) scene.roomLabel.setVisible(false);
    if (mode && mode.kind === 'room') { drawRoomGhost(g); return; }
    if (mode && mode.kind === 'demolish') { drawDemolishGhost(g); return; }
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

  /** Nach Ladenschluss: neue Marktpreise melden (einmal je Tag) */
  let seenMarketDay = null;
  function noteMarket() {
    if (!state || seenMarketDay === null) { seenMarketDay = state ? state.marketDay : null; return; }
    if (state.marketDay === seenMarketDay) return;
    seenMarketDay = state.marketDay;
    const last = state.reports[state.reports.length - 1];
    const wet = last && last.spoiled ? Object.keys(last.spoiled) : [];
    if (wet.length) setTimeout(() => note('Feuchtigkeit im Lager: ' + wet.map((w) => last.spoiled[w] + '× ' + goods[w].name).join(', ') + ' verdorben – Luftentfeuchter aufstellen.'), 6200);
    const moves = state.marketMoves || [];
    if (!moves.length) return;
    setTimeout(() => note('Neue Marktpreise: ' + moves.map((m) => goods[m.id].name + ' ' + (m.to > m.from ? '↑' : '↓') + Math.abs(Math.round((m.to / m.from - 1) * 100)) + ' %').join(', ') + ' – am PC neu auspreisen.'), 6200);
  }

  function refresh() {
    noteMarket();
    refreshHud();
    if (window.ShopSound) window.ShopSound.radio(state.items.some((it) => it.id === 'radio')); // Musik nur mit Radio
    refreshClock();
    drawAll();
    if (state && state.open && day.rng) reflowLine();
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
    if (mode && (mode.kind === 'room' || mode.kind === 'demolish')) return; // Bauen/Abreißen: nichts zu drehen
    if (mode) {
      const d = catalog[mode.id];
      if (d.layer === 'wandnah' && hover) {
        // nächste Seite der Zelle, an der eine Wand ist
        const c = candidate();
        for (let k = 1; k <= 4; k++) {
          const r = (c.rot + k) % 4;
          if (L.wallOnSide(state, c.x, c.y, r, walls)) { mode.rot = r; break; }
        }
        drawGhost();
      } else if (d.layer !== 'wand') { mode.rot = (mode.rot + 1) % 4; drawGhost(); }
      return;
    }
    const it = selected && state.items.find((i) => i.uid === selected);
    if (!it) return;
    act(doAct('move', { uid: it.uid, x: it.x, y: it.y, rot: (it.rot + 1) % 4, wall: it.wall }));
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
      else if (what === 'inhalt') openShelf(selected);
      else giveBack();
    });
  });

  $('[data-shop-coins]').addEventListener('click', () => {
    ask('Kanacoin festlegen (Demo-Geld):', true, Math.floor(state.coins)).then((v) => {
      if (v === null || v === '') return;
      act(doAct('setCoins', { amount: Math.floor(Number(v)) }));
    });
  });

  // ---------- TEST-KNÖPFE (nur Shop-Demo – im fertigen Spiel entfernen: Markup data-shop-dev, CSS .sd-dev, dieser Block) ----------
  document.querySelectorAll('[data-shop-dev]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.shopDev === 'ruf') { act(doAct('devRuf', { amount: 100 })); return; }
      if (!state.open || !day.rng) { toast('Erst den Laden an der Tür öffnen.'); return; }
      if (b.dataset.shopDev === 'auftrag') {
        const stations = new Set(state.items.map((it) => it.id));
        const any = packs.some((p) => p.services.every((id) => more.services[id] && stations.has(more.services[id].station)));
        if (!any) { toast('Dafür fehlt ein Arbeitstisch (Reinigung, Bewertung oder Öffnungstheke).'); return; }
        if (pendingJobs() >= L.MAX_JOBS) { toast('Es laufen schon ' + L.MAX_JOBS + ' Aufträge.'); return; }
      }
      spawn(b.dataset.shopDev);
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
  // ---------- Menü (Hauptmenü beim Start, Pause mit Esc) ----------
  // Solange es offen ist, steht das Spiel (update() läuft nicht). Einstellungen wirken sofort und bleiben im Browser.
  const SETTINGS_KEY = 'sd-settings';
  const settings = { master: 80, music: 60, sfx: 80, test: true };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); } catch (e) { /* ohne Speicher: Standard */ }
  const settingsFns = [];
  // für spätere Töne: window.ShopSettings.get().sfx (0–100), .on(fn) = bei jeder Änderung sofort
  window.ShopSettings = { get: () => Object.assign({}, settings), on: (fn) => settingsFns.push(fn) };
  function applySettings() {
    document.body.classList.toggle('sd-no-dev', !settings.test);
  }
  function setSetting(k, v) {
    settings[k] = v;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* egal */ }
    applySettings();
    settingsFns.forEach((fn) => fn(Object.assign({}, settings)));
  }
  const KEYS = [
    ['W A S D', 'laufen'], ['E', 'benutzen'], ['Q', 'Karton abstellen'], ['R', 'drehen'], ['Tab (halten)', 'Werkzeug-Rad'],
    ['1 / 2', 'Hände / Wischmopp'], ['I', 'Inventar'], ['Esc', 'Pause / Menü'], ['Entf', 'Möbel zurückgeben'], ['Mausrad', 'Zoom'],
  ];
  let menuScreen = 'haupt';
  let menuPause = false;
  let menuMsg = '';
  let slotInfo = null;
  const menuOpen = () => !!document.querySelector('[data-shop-menu][open]');
  function openMenu(pause) {
    menuPause = !!pause;
    menuScreen = 'haupt';
    menuMsg = '';
    renderMenu();
    const dlg = $('[data-shop-menu]');
    if (!dlg.open) dlg.showModal();
    fetchSlots();
  }
  function fetchSlots() {
    fetch('/api/shop-demo/spielstaende', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((j) => { if (j.slots) { slotInfo = j; renderMenu(); } })
      .catch(() => {});
  }
  // kein laufendes Spiel (gelöscht): das Hauptmenü bleibt offen, bis Neues Spiel / Laden gewählt ist
  const noGame = () => !!slotInfo && slotInfo.active === 0;
  function closeMenu() {
    const dlg = $('[data-shop-menu]');
    if (dlg.open && !noGame()) dlg.close();
  }
  function menuBtn(parent, label, fn, opts) {
    const b = el('button', 'sd-menu-btn' + (opts && opts.main ? ' is-main' : ''), label);
    b.type = 'button';
    b.disabled = !!(opts && opts.disabled);
    b.addEventListener('click', fn);
    parent.appendChild(b);
    return b;
  }
  const slotText = (s) => (s.summary ? 'Tag ' + s.summary.day + ' · Stufe ' + s.summary.level + ' · ' + fmt(s.summary.coins) + ' Kanacoin' : 'leer');
  function switchSlot(aktion, slot) {
    const body = new URLSearchParams({ _csrf: root.dataset.csrf, aktion, slot: String(slot) });
    fetch('/api/shop-demo/spielstand', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { menuMsg = j.error; renderMenu(); return; }
        if (aktion === 'loeschen' && !j.reload) { fetchSlots(); return; } // anderer Platz: nur die Liste neu
        // laufenden Spielstand gelöscht → neu laden ins Hauptmenü; sonst gleich ins Spiel
        if (aktion !== 'loeschen') try { sessionStorage.setItem('sd-skip-menu', '1'); } catch (e) { /* dann eben wieder das Menü */ }
        location.reload();
      })
      .catch(() => { menuMsg = 'Keine Verbindung.'; renderMenu(); });
  }
  function renderMenu() {
    const body = $('[data-shop-menu-body]');
    body.textContent = '';
    const back = () => { menuScreen = 'haupt'; menuMsg = ''; renderMenu(); };
    if (menuScreen === 'haupt') {
      body.appendChild(el('h2', 'sd-menu-title', menuPause ? 'Pause' : 'Grading Shop'));
      if (!menuPause) body.appendChild(el('p', 'sd-menu-sub', 'Demo · Platzhalter-Grafik'));
      const cur = slotInfo && slotInfo.slots.find((s) => s.slot === slotInfo.active);
      menuBtn(body, 'Weiter' + (cur && cur.summary ? ' (Platz ' + cur.slot + ', Tag ' + cur.summary.day + ')' : ''), closeMenu, { main: true, disabled: !slotInfo || noGame() });
      menuBtn(body, 'Neues Spiel', () => { menuScreen = 'neu'; renderMenu(); });
      menuBtn(body, 'Laden', () => { menuScreen = 'laden'; renderMenu(); });
      menuBtn(body, 'Einstellungen', () => { menuScreen = 'einst'; renderMenu(); });
      const site = el('a', 'sd-menu-btn', 'Zurück zur Seite');
      site.href = '/';
      body.appendChild(site);
      return;
    }
    const head = el('div', 'sd-menu-head');
    const bk = el('button', 'sd-btn', '← Zurück');
    bk.type = 'button';
    bk.addEventListener('click', back);
    head.append(bk, el('h2', 'sd-menu-title', { neu: 'Neues Spiel', laden: 'Laden', einst: 'Einstellungen' }[menuScreen]));
    body.appendChild(head);
    if (menuScreen === 'einst') { menuSettings(body); return; }
    if (!slotInfo) { body.appendChild(el('p', 'sd-later', 'Lädt …')); return; }
    slotInfo.slots.forEach((s) => {
      const cur = s.slot === slotInfo.active;
      const label = 'Platz ' + s.slot + (cur ? ' (läuft gerade)' : '') + ' – ' + slotText(s);
      if (menuScreen === 'laden') {
        const row = el('div', 'sd-menu-slot');
        menuBtn(row, label, () => { if (cur) closeMenu(); else switchSlot('laden', s.slot); }, { disabled: !s.summary });
        const del = el('button', 'sd-btn sd-menu-del', 'Löschen');
        del.type = 'button';
        del.disabled = !s.summary;
        del.addEventListener('click', () => {
          ask(cur ? 'Den laufenden Spielstand auf Platz ' + s.slot + ' löschen? Danach geht es ins Hauptmenü.'
            : 'Platz ' + s.slot + ' löschen? Das lässt sich nicht rückgängig machen.').then((ok) => { if (ok) switchSlot('loeschen', s.slot); });
        });
        row.appendChild(del);
        body.appendChild(row);
      } else {
        menuBtn(body, label, () => {
          if (!s.summary) { switchSlot('neu', s.slot); return; }
          ask('Platz ' + s.slot + ' überschreiben? Der Spielstand dort ist dann weg.').then((ok) => { if (ok) switchSlot('neu', s.slot); });
        });
      }
    });
    body.appendChild(el('p', 'sd-later', menuScreen === 'neu' ? (noGame() ? 'Wähle einen Platz für dein neues Spiel.' : 'Dein jetziger Spielstand bleibt auf seinem Platz gespeichert.') : 'Gespeichert wird von selbst. Ein offener Tag wird beim Wechseln abgebrochen.'));
    if (menuMsg) body.appendChild(el('p', 'sd-menu-msg', menuMsg));
  }
  function menuSettings(body) {
    [['master', 'Gesamtlautstärke'], ['music', 'Musik'], ['sfx', 'Geräusche']].forEach(([k, name]) => {
      const row = el('label', 'sd-menu-row');
      const r = el('input');
      r.type = 'range';
      r.min = '0';
      r.max = '100';
      r.value = String(settings[k]);
      const v = el('span', 'sd-menu-val', settings[k] + ' %');
      r.addEventListener('input', () => { setSetting(k, Number(r.value)); v.textContent = r.value + ' %'; });
      row.append(el('span', '', name), r, v);
      body.appendChild(row);
    });
    body.appendChild(el('p', 'sd-later', 'Platzhalter-Töne und -Musik (im Browser erzeugt) – echte Aufnahmen kommen später. Musik läuft nur, wenn im Laden ein Radio hängt. Wirkt sofort, auch mitten im Spiel über Esc.'));
    const box = el('label', 'sd-check');
    const c = el('input');
    c.type = 'checkbox';
    c.checked = !!settings.test;
    c.addEventListener('change', () => setSetting('test', c.checked));
    box.append(c, ' TEST-Knöpfe zeigen');
    body.appendChild(box);
    body.appendChild(el('div', 'sd-group', 'Tasten'));
    const { t, tb } = table([['Taste'], ['Was']]);
    KEYS.forEach(([k, w]) => {
      const tr = el('tr');
      tr.append(el('td', '', k), el('td', '', w));
      tb.appendChild(tr);
    });
    body.appendChild(t);
  }
  applySettings();
  // Klick-Ton für alle Knöpfe (Menü, PC, Fenster)
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('button')) snd('click'); }, true);
  // Esc schließt das Menü nicht, solange kein Spiel läuft
  $('[data-shop-menu]').addEventListener('cancel', (e) => { if (noGame()) e.preventDefault(); });
  // Hauptmenü beim Öffnen – außer direkt nach einem Spielstand-Wechsel
  let skipMenu = false;
  try { skipMenu = !!sessionStorage.getItem('sd-skip-menu'); sessionStorage.removeItem('sd-skip-menu'); } catch (e) { /* egal */ }
  if (!skipMenu) openMenu(false);

  fetch('/api/shop-demo', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then((r) => r.json())
    .then((data) => {
      state = data.state;
      list = data.catalog;
      goodsList = data.goods;
      groups = data.groups;
      unitPrice = data.unitPrice;
      licenseList = data.licenses || [];
      serviceList = data.services || [];
      packs = data.packs || [];
      clothesList = data.clothes || [];
      clothesSlots = data.clothesSlots || [];
      rufCfg = data.ruf || { levels: [0], unlock: {} };
      posterTypes = data.posterTypes || [];
      posterSpots = data.posterSpots || [];
      more.poster = data.poster;
      more.posterTypes = posterTypes;
      more.posterSpots = posterSpots;
      more = { licenses: Object.fromEntries(licenseList.map((l) => [l.id, l])), services: Object.fromEntries(serviceList.map((x) => [x.id, x])), clothes: clothesList, poster: data.poster, posterTypes: data.posterTypes || [], posterSpots: data.posterSpots || [] };
      catalog = Object.fromEntries(list.map((d) => [d.id, d]));
      goods = Object.fromEntries(goodsList.map((g) => [g.id, g]));
      refreshHud();
      // Ein offener Tag kann nach dem Neuladen nicht weiterlaufen (die Kunden leben nur im Browser)
      if (state.open && act(doAct('closeDay', { aborted: true }))) note('Der letzte Tag wurde beim Neuladen abgebrochen.');
      gameRef = new Phaser.Game({
        type: Phaser.AUTO,
        parent: document.querySelector('[data-shop-stage]'),
        backgroundColor: '#14161f',
        scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
        banner: false,
        // Bilder per <img> laden statt per XHR/Blob – die CSP der Seite erlaubt keine blob:-Bilder
        loader: { imageLoadType: 'HTMLImageElement' },
        scene: GameScene,
      });
    })
    .catch(() => toast('Laden konnte nicht geladen werden.'));
})();
