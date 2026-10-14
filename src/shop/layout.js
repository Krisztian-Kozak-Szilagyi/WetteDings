// Shop-Demo: reine Logik des Ladens (ohne Datenbank/Express) – läuft auf dem Server UND im Browser
// (/js/shop-layout.js liefert genau diese Datei aus, im Browser als window.ShopLayout).
// Raster: Zelle (x, y), x läuft entlang der rechten Rückwand ('n'), y entlang der linken Rückwand ('w').
// Der Laden besteht aus Einheiten zu UNIT_W×UNIT_D Zellen nebeneinander in x-Richtung; die erste gehört einem,
// die Nachbar-Einheiten kann man kaufen. Vorne in der ersten Einheit liegt der Eingang (DOOR, bleibt frei),
// davor der Gehweg (y = UNIT_D … UNIT_D+2), wo bestellte Kartons abgestellt werden.
// Zustand: { coins, units, nextUid, nextBid, items, boxes, carry, prices }
//   items: [{ uid, id, x, y, rot, wall, stock }] – rot 0–3 = Blickrichtung der Vorderseite (FRONT: 0 → +y, 1 → +x, 2 → −y,
//          3 → −x; ungerade = w/d getauscht), Kunden nehmen nur von vorne; wall 'n'/'w' nur bei Wand-Sachen,
//          stock { wareId: Stück } bei Regalen & Co. (gemischt, jedes Stück braucht einen Platz)
//   boxes: [{ bid, kind: 'ware'|'moebel', id, qty, x, y }] – Kartons; carry = bid des Kartons in der Hand (oder null)
//   prices: { wareId: Verkaufspreis } – fehlt einer, gilt der Marktpreis
//   day (laufender Tag), open (Laden geöffnet), today (Zahlen des laufenden Tages), reviews (letzte Bewertungen),
//   reports (Tagesberichte, neueste zuletzt) – die Kunden selbst laufen im Browser (src/shop/customers.js)
//   licenses: [lizenzId] – gekaufte Lizenzen · servicePrices: { dienstId: Preis } · jobs: Kunden-Aufträge (Karte
//   reinigen/benoten/versiegeln/in Sleeve) mit { jid, services, done: [dienstId], results, card, defects, spots, seed }
//   market: { wareId: Marktpreis } – fehlt einer, gilt der Grundpreis; marketMoves: letzte Änderung [{ id, from, to }], marketDay
//   dirt: [{ did, x, y, at }] – Flecken auf dem Boden (at = Zeitpunkt in ms, s. ShopCustomers.dirtCap) · tools: [werkzeugId]
// more = { licenses: { id: def }, services: { id: def } } (src/shop/catalog.js LICENSES/SERVICES)
// Kataloge kommen von außen: cat = { möbelId: def }, goods = { wareId: def } (src/shop/catalog.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShopLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const UNIT_W = 8;
  const UNIT_D = 8;
  const MAX_UNITS = 3;
  const START_COINS = 10000;
  const MAX_COINS = 10000000;
  const MAX_ITEMS = 300;
  const MAX_BOXES = 60;
  const MAX_PRICE = 1000000;
  const DOOR = [{ x: 3, y: UNIT_D - 1 }, { x: 4, y: UNIT_D - 1 }];
  const SIDEWALK = 2; // Gehweg-Tiefe in Zellen

  const MAX_DIRT = 40;
  // Marktpreise (Krisztian, 2026-10-14): nach Ladenschluss mit 50 % Chance: 2 Waren teurer, 2 billiger (je 5–15 %),
  // immer zwischen 70 % und 150 % des Grundpreises – der Einkauf bleibt beim Grundpreis × 50 %, also nie Verlust
  const MARKET = { chance: 0.5, up: 2, down: 2, min: 0.05, max: 0.15, floor: 0.7, ceil: 1.5 };
  // Werkzeuge (Krisztian, 2026-10-14): am PC kaufen, im Werkzeug-Rad (Tab) wählen. Preis = Platzhalter
  const TOOLS = [{ id: 'mop', name: 'Wischmopp', price: 50, text: 'Flecken vom Boden wischen (Werkzeug-Rad: Tab oder 2)' }];
  const MAX_JOBS = 2; // so viele Aufträge gleichzeitig (Krisztian, 2026-10-14)
  const SERVICE_ORDER = ['clean', 'iron', 'grade', 'slab', 'foil'];
  const KEEP_REVIEWS = 60;
  const KEEP_REPORTS = 14;
  const KEEP_RECEIPTS = 60;
  // Bewertungstexte: der Browser schickt nur den Schlüssel, der Text steht hier
  const REVIEW_TEXTS = {
    5: 'Faire Preise, gerne wieder!',
    4: 'Etwas teuer, aber okay.',
    3: 'Ganz schön teuer hier.',
    nothing: 'Nichts Passendes gefunden.',
    empty: 'Der Laden ist ja fast leer!',
    waited: 'Ewig an der Kasse gewartet.',
    job5: 'Top Arbeit an meiner Karte!',
    job4: 'Karte gut gemacht, kleine Mängel.',
    job3: 'Mit meiner Karte bin ich nicht ganz zufrieden.',
    jobwait: 'Meine Karte hat ewig gedauert.',
    dirty: 'Ziemlich schmutzig hier.',
  };

  const cents = (n) => Math.round(n * 100) / 100;

  function freshDay() {
    return { revenue: 0, sold: {}, visitors: 0, buyers: 0, misses: {}, receipts: [], reviews: 0, starSum: 0 };
  }

  function fresh() {
    return {
      coins: START_COINS, units: 1, nextUid: 1, nextBid: 1, items: [], boxes: [], carry: null, prices: {},
      day: 1, open: false, today: freshDay(), reviews: [], reports: [],
      licenses: [], servicePrices: {}, jobs: [], nextJid: 1, dirt: [], nextDid: 1, tools: [], market: {}, marketMoves: [], marketDay: 0,
    };
  }

  /** Fehlende Felder (ältere Stände) ergänzen */
  function normalize(s) {
    const f = fresh();
    const out = Object.assign({}, f);
    Object.keys(s || {}).forEach((k) => { if (s[k] !== undefined && s[k] !== null) out[k] = s[k]; });
    out.items = (out.items || []).map((it) => Object.assign({}, it));
    out.boxes = (out.boxes || []).map((b) => Object.assign({}, b));
    out.prices = Object.assign({}, out.prices || {});
    out.today = Object.assign(freshDay(), out.today || {});
    out.reviews = (out.reviews || []).slice(-KEEP_REVIEWS);
    out.reports = (out.reports || []).slice(-KEEP_REPORTS);
    out.licenses = (out.licenses || []).slice();
    out.dirt = (out.dirt || []).map((d) => Object.assign({}, d));
    out.market = Object.assign({}, out.market || {});
    out.marketMoves = (out.marketMoves || []).map((m) => Object.assign({}, m));
    out.tools = (out.tools || []).slice();
    out.servicePrices = Object.assign({}, out.servicePrices || {});
    out.jobs = (out.jobs || []).map((j) => Object.assign({}, j, { done: (j.done || []).slice(), results: Object.assign({}, j.results) }));
    if (!out.boxes.some((b) => b.bid === out.carry)) out.carry = null;
    return out;
  }

  /** Ohne PC kann man nichts bestellen: fehlt die Kassentheke, wird sie an den ersten freien Platz gestellt (kostenlos) */
  const PC_ID = 'cashier_counter';
  const PC_SPOTS = [[1, 5, 0], [1, 2, 0], [5, 2, 0], [1, 0, 0], [5, 5, 0], [0, 0, 1], [6, 0, 1]];
  function ensureCounter(state, cat) {
    if (!cat[PC_ID] || state.items.some((it) => it.id === PC_ID)) return state;
    const spot = PC_SPOTS.map(([x, y, rot]) => ({ id: PC_ID, x, y, rot })).find((c) => check(state, cat, c).ok);
    if (spot) state.items.push(Object.assign({ uid: state.nextUid++ }, spot));
    return state;
  }

  const FRONT = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const rot4 = (r) => (((Math.floor(Number(r)) || 0) % 4) + 4) % 4;

  /** Grundfläche in Zellen, quer gedreht (1, 3) = Breite/Tiefe getauscht */
  function size(def, rot) {
    return rot4(rot) % 2 ? { w: def.d, d: def.w } : { w: def.w, d: def.d };
  }

  /** Zellen direkt vor der Vorderseite eines Möbels (von dort nehmen Kunden Ware, dort steht man an der Kasse) */
  function frontCells(def, it) {
    const s = size(def, it.rot);
    const r = rot4(it.rot);
    const out = [];
    const n = r % 2 ? s.d : s.w;
    for (let i = 0; i < n; i++) {
      if (r === 0) out.push({ x: it.x + i, y: it.y + s.d });
      else if (r === 1) out.push({ x: it.x + s.w, y: it.y + i });
      else if (r === 2) out.push({ x: it.x + i, y: it.y - 1 });
      else out.push({ x: it.x - 1, y: it.y + i });
    }
    return out;
  }

  function cells(def, it) {
    const s = size(def, it.rot);
    const out = [];
    for (let dx = 0; dx < s.w; dx++) for (let dy = 0; dy < s.d; dy++) out.push(it.x + dx + ',' + (it.y + dy));
    return out;
  }

  function wallLength(state, wall) {
    return wall === 'n' ? state.units * UNIT_W : UNIT_D;
  }

  function isDoor(key) {
    return DOOR.some((c) => c.x + ',' + c.y === key);
  }

  function inside(state, key) {
    const [x, y] = key.split(',').map(Number);
    return x >= 0 && y >= 0 && x < state.units * UNIT_W && y < UNIT_D;
  }

  function overlap(a, b) {
    return a.some((k) => b.includes(k));
  }

  /** Zellen, auf denen ein Möbel steht (für Laufen/Abstellen) */
  function blocked(state, cat) {
    const set = new Set();
    state.items.forEach((it) => {
      const d = cat[it.id];
      if (d && d.layer === 'boden') cells(d, it).forEach((k) => set.add(k));
    });
    return set;
  }

  /** Darf man an Punkt (px, py) stehen / einen Karton abstellen? (Laden ohne Möbel oder Gehweg davor) */
  function walkable(state, cat, px, py, blockSet) {
    if (px < 0 || py < 0 || px >= state.units * UNIT_W || py >= UNIT_D + SIDEWALK) return false;
    if (py >= UNIT_D) return true;
    return !(blockSet || blocked(state, cat)).has(Math.floor(px) + ',' + Math.floor(py));
  }

  function used(it) {
    return Object.values(it.stock || {}).reduce((a, n) => a + n, 0);
  }

  /** Aktueller Marktpreis (bewegt sich, s. moveMarket) */
  function marketPrice(state, goods, id) {
    const m = state.market && state.market[id];
    return typeof m === 'number' ? m : goods[id] ? goods[id].market : 0;
  }

  /** Verkaufspreis: eigener Preis, sonst der aktuelle Marktpreis */
  function price(state, goods, id) {
    const p = state.prices[id];
    return typeof p === 'number' ? p : marketPrice(state, goods, id);
  }

  /** Runden (Krisztian): unter 20 auf 0,50, sonst auf die nächste 5 (103 → 105, 106 → 105, 102 → 100) */
  function roundPrice(p) {
    return p < 20 ? Math.round(p * 2) / 2 : Math.round(p / 5) * 5;
  }

  /** Knopf „+5 %“: immer vom Marktpreis aus – 100 → 105 → 110 … */
  function priceStepUp(current, market) {
    const k = Math.round((current / market - 1) / 0.05);
    return cents(market * (1 + (k + 1) * 0.05));
  }

  /** Neue Marktpreise nach Ladenschluss (rng = () => 0…1) → neuer Zustand, marketMoves = was sich geändert hat */
  function moveMarket(state, goods, rng) {
    const s = normalize(JSON.parse(JSON.stringify(state)));
    s.marketMoves = [];
    s.marketDay = s.day;
    if (rng() >= MARKET.chance) return s;
    const ids = Object.keys(goods).filter((id) => (goods[id].kind || 'ware') === 'ware');
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    ids.slice(0, MARKET.up + MARKET.down).forEach((id, i) => {
      const base = goods[id].market;
      const from = marketPrice(s, goods, id);
      const pct = MARKET.min + rng() * (MARKET.max - MARKET.min);
      const to = cents(Math.min(base * MARKET.ceil, Math.max(base * MARKET.floor, from * (i < MARKET.up ? 1 + pct : 1 - pct))));
      if (to === from) return;
      s.market[id] = to;
      s.marketMoves.push({ id, from, to });
    });
    return s;
  }

  function servicePrice(state, more, id) {
    const p = state.servicePrices[id];
    const def = more && more.services && more.services[id];
    return typeof p === 'number' ? p : def ? def.market : 0;
  }

  /** Nächster offener Dienst eines Auftrags (in fester Reihenfolge) oder null, wenn alles erledigt ist */
  function nextService(job) {
    return SERVICE_ORDER.find((id) => job.services.includes(id) && !job.done.includes(id)) || null;
  }

  /** Aus welchem Möbel ein Material genommen wird (erstes mit Vorrat) */
  function supplier(state, ware) {
    return state.items.find((it) => it.stock && it.stock[ware] > 0) || null;
  }

  function takeOne(it, ware) {
    it.stock = Object.assign({}, it.stock);
    it.stock[ware] -= 1;
    if (!it.stock[ware]) delete it.stock[ware];
  }

  /** Darf das Teil so stehen? → { ok, reason } (ignore = uid, die beim Verschieben nicht mitzählt) */
  function check(state, cat, cand, ignore) {
    const def = cat[cand.id];
    if (!def) return { ok: false, reason: 'Unbekanntes Teil.' };
    if (!Number.isInteger(cand.x) || !Number.isInteger(cand.y)) return { ok: false, reason: 'Ungültige Position.' };
    const others = state.items.filter((it) => it.uid !== ignore && cat[it.id]);
    const same = (layer) => others.filter((it) => cat[it.id].layer === layer);

    if (def.layer === 'wand') {
      if (cand.wall !== 'n' && cand.wall !== 'w') return { ok: false, reason: 'Das hängt an der Wand.' };
      const pos = cand.wall === 'n' ? cand.x : cand.y;
      if (pos < 0 || pos + def.w > wallLength(state, cand.wall)) return { ok: false, reason: 'Passt nicht an die Wand.' };
      const hit = same('wand').some((it) => {
        if (it.wall !== cand.wall) return false;
        const p = it.wall === 'n' ? it.x : it.y;
        return p < pos + def.w && pos < p + cat[it.id].w;
      });
      return hit ? { ok: false, reason: 'Da hängt schon etwas.' } : { ok: true };
    }

    const mine = cells(def, cand);
    if (!mine.every((k) => inside(state, k))) return { ok: false, reason: 'Außerhalb deines Ladens.' };

    if (def.layer === 'theke') {
      const base = same('boden').find((it) => cat[it.id].counter && cells(cat[it.id], it).includes(mine[0]));
      if (mine.length !== 1 || !base) return { ok: false, reason: 'Das gehört auf eine Theke.' };
      if (same('theke').some((it) => overlap(cells(cat[it.id], it), mine))) return { ok: false, reason: 'Da steht schon etwas.' };
      return { ok: true };
    }

    if (mine.some(isDoor)) return { ok: false, reason: 'Der Eingang muss frei bleiben.' };
    if (same(def.layer).some((it) => overlap(cells(cat[it.id], it), mine))) return { ok: false, reason: 'Da steht schon etwas.' };
    return { ok: true };
  }

  function clean(cand, def) {
    const out = { id: cand.id, x: cand.x | 0, y: cand.y | 0, rot: rot4(cand.rot) };
    if (def.layer === 'wand') {
      out.rot = 0;
      out.wall = cand.wall;
      if (out.wall === 'n') out.y = 0;
      else out.x = 0;
    }
    return out;
  }

  /** Was auf einer Theke steht */
  function onTop(state, cat, base) {
    const bc = cells(cat[base.id], base);
    return state.items.filter((it) => cat[it.id] && cat[it.id].layer === 'theke' && bc.includes(cells(cat[it.id], it)[0]));
  }

  /** Abstellplatz für neue Lieferungen: Gehweg vor dem Eingang, nebeneinander */
  function deliverySpot(state) {
    const n = state.boxes.filter((b) => b.bid !== state.carry && b.y >= UNIT_D).length;
    return { x: 2.4 + (n % 6) * 0.55, y: UNIT_D + 0.35 + (Math.floor(n / 6) % 3) * 0.55 };
  }

  /**
   * Eine Aktion ausführen → { state } (neuer Zustand) oder { error }.
   * orderWare {id, n} · orderMoebel {id} · pick {bid} · drop {x, y} · stock {uid} · unstock {uid, ware} ·
   * build {x, y, rot, wall} (Möbel aus dem Karton in der Hand) · move {uid, x, y, rot, wall} · remove {uid} ·
   * setPrice {ware, price} · buyUnit {price} · setCoins {amount} · reset
   */
  function apply(state, cat, goods, a, more) {
    more = more || { licenses: {}, services: {} };
    const s = normalize(JSON.parse(JSON.stringify(state)));
    const fail = (error) => ({ error });
    const find = (uid) => s.items.find((it) => it.uid === uid);
    const hand = () => s.boxes.find((b) => b.bid === s.carry) || null;
    const newBox = (kind, id, qty) => {
      const spot = deliverySpot(s);
      const b = { bid: s.nextBid++, kind, id, qty, x: spot.x, y: spot.y };
      s.boxes.push(b);
      return b;
    };

    switch (a && a.type) {
      case 'orderWare': {
        const g = goods[a.id];
        const n = Number(a.n) || 1;
        if (!g) return fail('Unbekannte Ware.');
        if (g.license && !s.licenses.includes(g.license)) {
          const lic = more.licenses[g.license];
          return fail('Dafür brauchst du die ' + (lic ? lic.name : 'passende Lizenz') + '.');
        }
        if (!Number.isInteger(n) || n < 1 || n > 10) return fail('Ungültige Menge.');
        if (s.boxes.length + n > MAX_BOXES) return fail('Zu viele Kartons – erst etwas einräumen.');
        const cost = cents(g.buy * g.perBox * n);
        if (s.coins < cost) return fail('Nicht genug Kanacoin.');
        s.coins = cents(s.coins - cost);
        for (let i = 0; i < n; i++) newBox('ware', g.id, g.perBox);
        return { state: s };
      }
      case 'orderMoebel': {
        const def = cat[a.id];
        if (!def) return fail('Unbekanntes Teil.');
        if (s.boxes.length >= MAX_BOXES) return fail('Zu viele Kartons – erst etwas aufbauen.');
        if (s.coins < def.price) return fail('Nicht genug Kanacoin.');
        s.coins = cents(s.coins - def.price);
        newBox('moebel', def.id, 1);
        return { state: s };
      }
      case 'pick': {
        if (s.carry) return fail('Du hast schon einen Karton in der Hand.');
        const b = s.boxes.find((x) => x.bid === a.bid);
        if (!b) return fail('Den Karton gibt es nicht mehr.');
        s.carry = b.bid;
        return { state: s };
      }
      case 'drop': {
        const b = hand();
        if (!b) return fail('Du trägst nichts.');
        const x = Number(a.x);
        const y = Number(a.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !walkable(s, cat, x, y)) return fail('Hier kann der Karton nicht stehen.');
        b.x = cents(x);
        b.y = cents(y);
        s.carry = null;
        return { state: s };
      }
      case 'stock': {
        const b = hand();
        const it = find(a.uid);
        if (!b || b.kind !== 'ware') return fail('Du trägst keine Ware.');
        if (!it) return fail('Das Möbel gibt es nicht mehr.');
        const def = cat[it.id];
        if (!def.holds || !def.holds.includes(b.id)) return fail('Das passt hier nicht hinein.');
        const free = def.slots - used(it);
        if (free <= 0) return fail('Kein Platz mehr.');
        const n = Math.min(free, b.qty);
        it.stock = Object.assign({}, it.stock);
        it.stock[b.id] = (it.stock[b.id] || 0) + n;
        b.qty -= n;
        if (b.qty <= 0) {
          s.boxes = s.boxes.filter((x) => x !== b);
          s.carry = null;
        }
        return { state: s };
      }
      case 'unstock': {
        const it = find(a.uid);
        if (!it || !it.stock || !it.stock[a.ware]) return fail('Davon liegt hier nichts.');
        let b = hand();
        if (b && (b.kind !== 'ware' || b.id !== a.ware)) return fail('Du hast schon einen anderen Karton in der Hand.');
        if (!b) {
          if (s.boxes.length >= MAX_BOXES) return fail('Zu viele Kartons.');
          b = newBox('ware', a.ware, 0);
          s.carry = b.bid;
        }
        b.qty += it.stock[a.ware];
        it.stock = Object.assign({}, it.stock);
        delete it.stock[a.ware];
        return { state: s };
      }
      case 'build': {
        const b = hand();
        if (!b || b.kind !== 'moebel') return fail('Du trägst kein Möbel.');
        const def = cat[b.id];
        if (s.items.length >= MAX_ITEMS) return fail('Der Laden ist voll.');
        const cand = clean(Object.assign({}, a, { id: b.id }), def);
        const c = check(s, cat, cand);
        if (!c.ok) return fail(c.reason);
        s.items.push(Object.assign({ uid: s.nextUid++ }, cand));
        s.boxes = s.boxes.filter((x) => x !== b);
        s.carry = null;
        return { state: s };
      }
      case 'move': {
        const it = find(a.uid);
        if (!it) return fail('Das Teil gibt es nicht mehr.');
        const def = cat[it.id];
        const cand = clean(Object.assign({}, a, { id: it.id }), def);
        const c = check(s, cat, cand, it.uid);
        if (!c.ok) return fail(c.reason);
        const riders = def.counter ? onTop(s, cat, it) : [];
        if (riders.length && cand.rot !== it.rot) return fail('Erst die Sachen auf der Theke wegräumen, dann drehen.');
        const dx = cand.x - it.x;
        const dy = cand.y - it.y;
        Object.assign(it, cand);
        riders.forEach((r) => { r.x += dx; r.y += dy; });
        return { state: s };
      }
      case 'remove': {
        const it = find(a.uid);
        if (!it) return fail('Das Teil gibt es nicht mehr.');
        const gone = [it].concat(cat[it.id] && cat[it.id].counter ? onTop(s, cat, it) : []);
        if (gone.some((g) => used(g) > 0)) return fail('Erst die Ware herausnehmen.');
        if (it.id === PC_ID && s.items.filter((x) => x.id === PC_ID).length === 1) return fail('Die Kasse mit dem PC brauchst du – verschieben geht.');
        gone.forEach((g) => { s.coins = cents(s.coins + ((cat[g.id] && cat[g.id].price) || 0)); });
        s.items = s.items.filter((x) => !gone.includes(x));
        return { state: s };
      }
      case 'openDay': {
        if (s.open) return fail('Der Laden ist schon offen.');
        s.open = true;
        s.today = freshDay();
        return { state: s };
      }
      case 'checkout':
      case 'leave': {
        if (!s.open) return fail('Der Laden ist zu.');
        const t = s.today;
        t.visitors += 1;
        if (a.type === 'checkout') {
          const lines = [];
          (Array.isArray(a.lines) ? a.lines : []).slice(0, 10).forEach((l) => {
            let want = Math.max(0, Math.min(50, Math.floor(Number(l.qty)) || 0));
            if (!goods[l.ware] || goods[l.ware].kind === 'material' || !want) return;
            const p = price(s, goods, l.ware);
            // zuerst aus dem Regal, aus dem der Kunde genommen hat, sonst aus einem anderen
            const from = s.items.filter((it) => it.stock && it.stock[l.ware]).sort((x, y) => (y.uid === l.uid) - (x.uid === l.uid));
            let got = 0;
            from.forEach((it) => {
              if (!want) return;
              const n = Math.min(want, it.stock[l.ware]);
              it.stock = Object.assign({}, it.stock);
              it.stock[l.ware] -= n;
              if (!it.stock[l.ware]) delete it.stock[l.ware];
              want -= n;
              got += n;
            });
            if (got) lines.push({ ware: l.ware, qty: got, price: p });
          });
          if (lines.length) {
            const total = cents(lines.reduce((sum, l) => sum + l.qty * l.price, 0));
            s.coins = cents(s.coins + total);
            t.revenue = cents(t.revenue + total);
            t.buyers += 1;
            lines.forEach((l) => { t.sold[l.ware] = (t.sold[l.ware] || 0) + l.qty; });
            t.receipts = t.receipts.concat({ lines: lines, total: total }).slice(-KEEP_RECEIPTS);
          }
        }
        if (a.miss && goods[a.miss]) t.misses[a.miss] = (t.misses[a.miss] || 0) + 1;
        const stars = Number(a.stars);
        const text = Object.prototype.hasOwnProperty.call(REVIEW_TEXTS, a.why) ? REVIEW_TEXTS[a.why] : null;
        if (Number.isInteger(stars) && stars >= 1 && stars <= 5 && text) {
          s.reviews = s.reviews.concat({ day: s.day, stars: stars, text: text }).slice(-KEEP_REVIEWS);
          t.reviews += 1;
          t.starSum += stars;
        }
        return { state: s };
      }
      case 'closeDay': {
        if (!s.open) return fail('Der Laden ist schon zu.');
        const t = s.today;
        s.reports = s.reports.concat({
          day: s.day, revenue: t.revenue, sold: t.sold, visitors: t.visitors, buyers: t.buyers, misses: t.misses,
          receipts: t.receipts, stars: t.reviews ? Math.round((t.starSum / t.reviews) * 10) / 10 : null, reviews: t.reviews, services: t.services || {},
          aborted: !!a.aborted,
        }).slice(-KEEP_REPORTS);
        s.open = false;
        s.jobs = []; // wer bis Ladenschluss nicht bedient wurde, ist gegangen
        s.day += 1;
        s.today = freshDay();
        return { state: s };
      }
      case 'buyTool': {
        const tool = TOOLS.find((t) => t.id === a.id);
        if (!tool) return fail('Unbekanntes Werkzeug.');
        if (s.tools.includes(tool.id)) return fail('Das hast du schon.');
        if (s.coins < tool.price) return fail('Nicht genug Kanacoin.');
        s.coins = cents(s.coins - tool.price);
        s.tools.push(tool.id);
        return { state: s };
      }
      // Kunde hinterlässt einen Fleck (der Browser würfelt, wo und ob)
      case 'dirt': {
        const x = Number(a.x);
        const y = Number(a.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= s.units * UNIT_W || y >= UNIT_D) return fail('Ungültiger Fleck.');
        if (s.dirt.length >= MAX_DIRT) return { state: s };
        const at = Number(a.at);
        s.dirt.push({ did: s.nextDid++, x: cents(x), y: cents(y), at: Number.isFinite(at) ? at : 0 });
        return { state: s };
      }
      case 'mop': {
        if (!s.tools.includes('mop')) return fail('Dafür brauchst du einen Wischmopp.');
        const d = s.dirt.find((x) => x.did === a.did);
        if (!d) return fail('Der Fleck ist schon weg.');
        s.dirt = s.dirt.filter((x) => x !== d);
        return { state: s };
      }
      case 'buyLicense': {
        const lic = more.licenses[a.id];
        if (!lic) return fail('Unbekannte Lizenz.');
        if (s.licenses.includes(lic.id)) return fail('Die hast du schon.');
        if (s.coins < lic.price) return fail('Nicht genug Kanacoin.');
        s.coins = cents(s.coins - lic.price);
        s.licenses.push(lic.id);
        return { state: s };
      }
      case 'setServicePrice': {
        const p = Number(a.price);
        if (!more.services[a.service]) return fail('Unbekannter Dienst.');
        if (!Number.isFinite(p) || p < 0 || p > MAX_PRICE) return fail('Ungültiger Preis.');
        s.servicePrices[a.service] = cents(p);
        return { state: s };
      }
      // Auftrag annehmen – nur der Server ruft das auf (er würfelt Karte und Zustand: a.job)
      case 'takeJob': {
        if (!s.open) return fail('Der Laden ist zu.');
        if (s.jobs.length >= MAX_JOBS) return fail('Erst die offenen Aufträge erledigen.');
        const j = a.job || {};
        const services = SERVICE_ORDER.filter((id) => (j.services || []).includes(id) && more.services[id]);
        if (!services.length) return fail('Kein Auftrag.');
        const missing = services.find((id) => !s.items.some((it) => it.id === more.services[id].station));
        if (missing) return fail('Dafür fehlt dir noch: ' + (cat[more.services[missing].station] || {}).name + '.');
        s.jobs.push({ jid: s.nextJid++, services, done: [], results: {}, card: j.card, defects: j.defects, spots: j.spots, seed: j.seed, cid: Number(a.cid) || 0 });
        return { state: s };
      }
      // Ergebnis eines Arbeitstisches – nur der Server (Werkbank) ruft das auf
      case 'benchDone': {
        const job = s.jobs.find((x) => x.jid === a.jid);
        if (!job) return fail('Den Auftrag gibt es nicht mehr.');
        const steps = (a.steps || []).filter((id) => job.services.includes(id) && !job.done.includes(id));
        if (!steps.length) return fail('Hier ist nichts mehr zu tun.');
        if (steps.includes('slab')) {
          const from = supplier(s, 'mat_slab');
          if (!from) return fail('Kein leerer Slab mehr am Kartenbewertungstisch.');
          takeOne(from, 'mat_slab');
        }
        job.done = job.done.concat(steps);
        Object.assign(job.results, a.results || {});
        if (a.defects) job.defects = a.defects;
        return { state: s };
      }
      case 'foil': {
        const job = s.jobs.find((x) => x.jid === a.jid);
        if (!job || nextService(job) !== 'foil') return fail('Hier ist nichts zu tun.');
        const from = supplier(s, 'mat_sleeve');
        if (!from) return fail('Kein TCG Sleeve mehr an der Booster-Öffnungstheke.');
        takeOne(from, 'mat_sleeve');
        job.done = job.done.concat('foil');
        job.results.foil = true;
        return { state: s };
      }
      case 'serviceCheckout':
      case 'jobCancel': {
        const job = s.jobs.find((x) => x.jid === a.jid);
        if (!job) return fail('Den Auftrag gibt es nicht mehr.');
        if (!s.open) return fail('Der Laden ist zu.');
        const t = s.today;
        t.visitors += 1;
        if (a.type === 'serviceCheckout') {
          if (nextService(job)) return fail('Der Auftrag ist noch nicht fertig.');
          const lines = job.services.map((id) => ({ service: id, qty: 1, price: servicePrice(s, more, id) }));
          const total = cents(lines.reduce((sum, l) => sum + l.price, 0));
          s.coins = cents(s.coins + total);
          t.revenue = cents(t.revenue + total);
          t.buyers += 1;
          t.services = Object.assign({}, t.services);
          job.services.forEach((id) => { t.services[id] = (t.services[id] || 0) + 1; });
          t.receipts = t.receipts.concat({ lines: lines, total: total }).slice(-KEEP_RECEIPTS);
        }
        s.jobs = s.jobs.filter((x) => x !== job);
        const stars = Number(a.stars);
        const text = Object.prototype.hasOwnProperty.call(REVIEW_TEXTS, a.why) ? REVIEW_TEXTS[a.why] : null;
        if (Number.isInteger(stars) && stars >= 1 && stars <= 5 && text) {
          s.reviews = s.reviews.concat({ day: s.day, stars: stars, text: text }).slice(-KEEP_REVIEWS);
          t.reviews += 1;
          t.starSum += stars;
        }
        return { state: s };
      }
      case 'setPrice': {
        const p = Number(a.price);
        if (!goods[a.ware]) return fail('Unbekannte Ware.');
        if (!Number.isFinite(p) || p < 0 || p > MAX_PRICE) return fail('Ungültiger Preis.');
        s.prices[a.ware] = cents(p);
        return { state: s };
      }
      case 'buyUnit': {
        if (s.units >= MAX_UNITS) return fail('Mehr Platz gibt es nicht.');
        if (s.coins < a.price) return fail('Nicht genug Kanacoin.');
        s.coins = cents(s.coins - a.price);
        s.units += 1;
        return { state: s };
      }
      case 'setCoins': {
        const n = Number(a.amount);
        if (!Number.isInteger(n) || n < 0 || n > MAX_COINS) return fail('Ungültiger Betrag.');
        s.coins = n;
        return { state: s };
      }
      case 'reset':
        return { state: ensureCounter(fresh(), cat) };
      default:
        return fail('Unbekannte Aktion.');
    }
  }

  return {
    UNIT_W, UNIT_D, MAX_UNITS, START_COINS, MAX_COINS, MAX_ITEMS, DOOR, SIDEWALK,
    MARKET, marketPrice, roundPrice, priceStepUp, moveMarket, TOOLS, MAX_DIRT, FRONT, rot4, frontCells, REVIEW_TEXTS, MAX_JOBS, SERVICE_ORDER, servicePrice, nextService, supplier, fresh, normalize, ensureCounter, PC_ID, size, cells, check, apply, wallLength, blocked, walkable, used, price,
  };
});
