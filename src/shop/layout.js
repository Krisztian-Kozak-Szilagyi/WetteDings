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
//   rooms: [{ rid, kind: 'lager'|'geheim', x, y, w, d, door: { side: 'n'|'s'|'w'|'e', i } }] – Räume mit Wänden auf den
//          Zellkanten; Lager: nur Lagerregale, Geheimraum: der Eingang wird vom Schrank (Teil 'geheimschrank') verdeckt
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
  // Ruf & Stufen (Krisztian, 2026-10-16): Ruf aus Umsatz (je 10 Kanacoin +1) und Bewertungen (5★ +5 … 1★ −5).
  // Die Stufe fällt nie zurück; der Ruf kann bis zur Schwelle der erreichten Stufe sinken, nicht darunter.
  // Schwellen und Freischaltungen = Platzhalter (erste Stufe nach etwa einem guten Tag)
  const RUF = { perCoins: 10, stars: { 5: 5, 4: 2, 3: 0, 2: -2, 1: -5 }, levels: [0, 150, 500, 1200, 2500] };
  // Freischaltungen außerhalb des Katalogs: Räume und die Nachbarfläche
  const UNLOCK = { lager: 2, geheim: 4, unit: 5 };
  // Räume (Krisztian, 2026-10-16): Wand je Zellkante 20, Tür 50, Geheimschrank 300 (ersetzt beim Geheimraum die Tür)
  const ROOM = { minW: 2, minD: 2, wall: 20, door: 50, cabinet: 300, kinds: ['lager', 'geheim'], nameMax: 24 };
  // Feuchtigkeit (Krisztian, 2026-10-16): je angefangene 16 Felder Lager ein Luftentfeuchter; fehlt er, verdirbt nachts
  // ein Teil der Papier-Ware (5 % × Anteil der fehlenden Geräte, mindestens 1 Stück, wenn etwas da ist)
  const DAMP = { cellsPer: 16, rate: 0.05, devices: ['dehumidifier', 'dehumidifier_wall'] };
  const CABINET_ID = 'geheimschrank';
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
    return { revenue: 0, sold: {}, visitors: 0, buyers: 0, misses: {}, receipts: [], reviews: 0, starSum: 0, cash: 0, card: 0, lost: 0 };
  }

  function fresh() {
    return {
      coins: START_COINS, units: 1, nextUid: 1, nextBid: 1, items: [], boxes: [], carry: null, prices: {},
      day: 1, open: false, today: freshDay(), reviews: [], reports: [],
      licenses: [], servicePrices: {}, jobs: [], nextJid: 1, dirt: [], nextDid: 1, tools: [], market: {}, marketMoves: [], marketDay: 0, rooms: [], nextRid: 1, ruf: 0, level: 1, wardrobe: [], outfit: {}, posters: {}, hung: {},
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
    out.wardrobe = (out.wardrobe || []).slice();
    out.posters = Object.assign({}, out.posters || {});
    out.hung = Object.assign({}, out.hung || {});
    out.outfit = Object.assign({}, out.outfit || {});
    out.rooms = (out.rooms || []).map((r) => Object.assign({}, r, { door: r.door ? Object.assign({}, r.door) : null }));
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

  const inside_ = (state, key) => inside(state, key);

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
    const sum = (o) => Object.values(o || {}).reduce((a, n) => a + n, 0);
    return sum(it.stock) + sum(it.posters); // Plakate im Safe belegen auch Plätze
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

  // ---------- Inventar (Taste I) ----------
  // Was die Figur bei sich trägt – jetzt: gedruckte Plakate (state.posters), aufgehängt werden sie später in der Stadt.
  // Platzhalter: 20 Plätze, ein Plakat = ein Platz. Lagern geht im Safe (holdsPosters).
  const INVENTORY = { slots: 20 };
  function invUsed(state) {
    return Object.values(state.posters || {}).reduce((a, n) => a + n, 0);
  }
  const POSTER_KEY = /^[a-z]{1,20}(:geheim)?$/;

  // ---------- Spieltisch (Turniere) ----------
  // Krisztian (2026-10-17): Turniere am Spieltisch, dafür braucht er 2 Stühle direkt daneben (allein spielt keiner)
  const TABLE = { id: 'playmat_table', chairs: 2 };
  /** Spieltische mit den Stühlen direkt daneben → [{ uid, chairs, ready }] */
  function gameTables(state, cat) {
    const chairs = new Set(state.items.filter((c) => c.id === 'chair').map((c) => c.x + ',' + c.y));
    return state.items.filter((it) => it.id === TABLE.id && cat[it.id]).map((it) => {
      const own = new Set(cells(cat[it.id], it));
      const near = new Set();
      own.forEach((k) => {
        const [x, y] = k.split(',').map(Number);
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const n = x + dx + ',' + (y + dy);
          if (!own.has(n) && chairs.has(n)) near.add(n);
        });
      });
      return { uid: it.uid, chairs: near.size, ready: near.size >= TABLE.chairs };
    });
  }

  // ---------- Plakate ----------
  /** Wirkung der aufgehängten Plakate → { customers: zusätzliche Kunden pro Tag, boost: { wareId: Wunsch-Gewicht }, secret: Anzahl } */
  function posterEffect(state, more) {
    const P = (more && more.poster) || { customers: 2, wishBoost: 2 };
    const types = Object.fromEntries(((more && more.posterTypes) || []).map((t) => [t.id, t]));
    const out = { customers: 0, boost: {}, secret: 0 };
    Object.values(state.hung || {}).forEach((key) => {
      const [id, secret] = String(key).split(':');
      out.customers += P.customers;
      if (secret) out.secret += 1;
      ((types[id] && types[id].goods) || []).forEach((g) => { out.boost[g] = (out.boost[g] || 0) + P.wishBoost; });
    });
    return out;
  }

  // ---------- Ruf ----------
  function levelFor(ruf) {
    let lv = 1;
    RUF.levels.forEach((min, i) => { if (ruf >= min) lv = i + 1; });
    return lv;
  }
  /** Ruf ändern: Stufe steigt mit, fällt aber nie; Ruf nicht unter die Schwelle der erreichten Stufe */
  function addRuf(s, pts) {
    if (!pts) return;
    const floor = RUF.levels[(s.level || 1) - 1] || 0;
    s.ruf = Math.max(floor, Math.round(((s.ruf || 0) + pts) * 100) / 100);
    s.level = Math.max(s.level || 1, levelFor(s.ruf));
  }
  const rufForStars = (stars) => RUF.stars[stars] || 0;
  /** Nächste Schwelle (oder null auf der höchsten Stufe) */
  function nextLevelAt(s) {
    return RUF.levels[s.level] === undefined ? null : RUF.levels[s.level];
  }
  const needLevel = (s, lv) => (lv || 1) > (s.level || 1);

  // ---------- Räume ----------
  const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.d;
  function roomAt(state, x, y) {
    return (state.rooms || []).find((r) => inRect(r, x, y)) || null;
  }
  /** Alle Zellen in Räumen (Kunden gehen dort nicht hin) */
  function roomCells(state) {
    const set = new Set();
    (state.rooms || []).forEach((r) => { for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.d; y++) set.add(x + ',' + y); });
    return set;
  }
  /** Kanten des Rands: { side, i, key } – key 'h:x,y' = waagrechte Kante über Zelle (x, y), 'v:x,y' = senkrechte links davon */
  function roomEdges(r) {
    const out = [];
    for (let i = 0; i < r.w; i++) {
      out.push({ side: 'n', i, key: 'h:' + (r.x + i) + ',' + r.y });
      out.push({ side: 's', i, key: 'h:' + (r.x + i) + ',' + (r.y + r.d) });
    }
    for (let i = 0; i < r.d; i++) {
      out.push({ side: 'w', i, key: 'v:' + r.x + ',' + (r.y + i) });
      out.push({ side: 'e', i, key: 'v:' + (r.x + r.w) + ',' + (r.y + i) });
    }
    return out;
  }
  /** Liegt die Kante auf dem Außenrand des Ladens (dort ist schon Wand bzw. Vorderfront)? */
  function outerEdge(state, key) {
    const [t, rest] = key.split(':');
    const [a, b] = rest.split(',').map(Number);
    return t === 'h' ? b === 0 || b === UNIT_D : a === 0 || a === state.units * UNIT_W;
  }
  /** Wände (ohne Türen, ohne Außenrand) als Menge von Kanten */
  function wallSet(state) {
    const set = new Set();
    (state.rooms || []).forEach((r) => {
      roomEdges(r).forEach((e) => {
        if (outerEdge(state, e.key)) return;
        if (r.door && r.door.side === e.side && r.door.i === e.i) return;
        set.add(e.key);
      });
    });
    return set;
  }
  /** Wand zwischen zwei Nachbarzellen? */
  function wallBetween(walls, ax, ay, bx, by) {
    if (ax === bx && Math.abs(ay - by) === 1) return walls.has('h:' + ax + ',' + Math.max(ay, by));
    if (ay === by && Math.abs(ax - bx) === 1) return walls.has('v:' + Math.max(ax, bx) + ',' + ay);
    return false;
  }
  /** Zelle vor der Tür (außen) – dort steht beim Geheimraum der Schrank */
  function outsideOfDoor(r) {
    const { side, i } = r.door;
    if (side === 'n') return { x: r.x + i, y: r.y - 1, rot: 2 };
    if (side === 's') return { x: r.x + i, y: r.y + r.d, rot: 0 };
    if (side === 'w') return { x: r.x - 1, y: r.y + i, rot: 3 };
    return { x: r.x + r.w, y: r.y + i, rot: 1 };
  }
  /** Hat die Zelle eine Wand an einer ihrer Seiten (Raumwand oder hintere Ladenwand)? */
  function hasWallNext(state, x, y) {
    return [0, 1, 2, 3].some((side) => wallOnSide(state, x, y, side));
  }

  // Wandgeräte (Krisztian, 2026-10-16): rot = an welcher Seite der Zelle es hängt – 0 Nord, 1 West, 2 Süd, 3 Ost
  // (in Ecken mit R wählbar). Höhe der Halterung: höhere Möbel passen nicht darunter.
  const MOUNT_Z = 26;
  function wallOnSide(state, x, y, side, ws) {
    const walls = ws || wallSet(state);
    if (side === 0) return y === 0 || walls.has('h:' + x + ',' + y);
    if (side === 1) return x === 0 || walls.has('v:' + x + ',' + y);
    if (side === 2) return walls.has('h:' + x + ',' + (y + 1));
    return walls.has('v:' + (x + 1) + ',' + y);
  }
  /** Zellen mit Wandgerät (darunter passt kein hohes Möbel) */
  function mountCells(state, cat) {
    return new Set(state.items.filter((it) => cat[it.id] && cat[it.id].layer === 'wandnah').map((it) => it.x + ',' + it.y));
  }

  /** Wandstücke zum Zeichnen: { key, side, near } – near = zum Betrachter (Süd/Ost), wird niedrig gezeichnet */
  function wallPieces(state) {
    const out = new Map();
    const walls = wallSet(state);
    (state.rooms || []).forEach((r) => {
      roomEdges(r).forEach((e) => {
        if (!walls.has(e.key)) return;
        const near = e.side === 's' || e.side === 'e';
        const prev = out.get(e.key);
        if (!prev || (prev.near && !near)) out.set(e.key, { key: e.key, side: e.side, near });
      });
    });
    return Array.from(out.values());
  }

  /** Luftentfeuchter im Lager: { need, have } */
  function dampStatus(state, r) {
    const need = Math.ceil((r.w * r.d) / DAMP.cellsPer);
    const have = state.items.filter((it) => DAMP.devices.includes(it.id) && inRect(r, it.x, it.y)).length;
    return { need, have };
  }

  /**
   * Nachts verdirbt Papier-Ware in Lagern ohne genug Luftentfeuchter → { state, spoiled: { wareId: Stück } }
   * (rng = () => 0…1; nur der Server würfelt)
   */
  function spoilStorage(state, cat, goods, rng) {
    const s = normalize(JSON.parse(JSON.stringify(state)));
    const spoiled = {};
    s.rooms.filter((r) => r.kind === 'lager').forEach((r) => {
      const st = dampStatus(s, r);
      if (st.have >= st.need) return;
      const rate = DAMP.rate * (st.need - st.have) / st.need;
      const units = [];
      s.items.filter((it) => it.stock && inRect(r, it.x, it.y)).forEach((it) => {
        Object.keys(it.stock).forEach((w) => { if (goods[w] && goods[w].paper) for (let k = 0; k < it.stock[w]; k++) units.push([it, w]); });
      });
      if (!units.length) return;
      let lose = Math.max(1, Math.round(units.length * rate));
      while (lose-- > 0 && units.length) {
        const [it, w] = units.splice(Math.floor(rng() * units.length), 1)[0];
        it.stock = Object.assign({}, it.stock);
        it.stock[w] -= 1;
        if (!it.stock[w]) delete it.stock[w];
        spoiled[w] = (spoiled[w] || 0) + 1;
      }
    });
    if (Object.keys(spoiled).length && s.reports.length) s.reports[s.reports.length - 1].spoiled = spoiled;
    return { state: s, spoiled };
  }

  function roomCost(state, r) {
    const walls = roomEdges(r).filter((e) => !outerEdge(state, e.key)).length;
    return walls * ROOM.wall + (r.kind === 'geheim' ? ROOM.cabinet : ROOM.door);
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

    if (def.layer === 'wandnah') {
      if (!wallOnSide(state, cand.x, cand.y, rot4(cand.rot))) return { ok: false, reason: hasWallNext(state, cand.x, cand.y) ? 'Auf dieser Seite ist keine Wand (R = andere Seite).' : 'Das gehört an eine Wand.' };
      if (same('wandnah').some((it) => it.x === cand.x && it.y === cand.y)) return { ok: false, reason: 'Da hängt schon etwas.' };
      if (same('boden').some((it) => cat[it.id].height > MOUNT_Z && cells(cat[it.id], it).includes(cand.x + ',' + cand.y))) return { ok: false, reason: 'Davor steht ein hohes Möbel.' };
      return { ok: true };
    }

    if (def.layer === 'theke') {
      const base = same('boden').find((it) => cat[it.id].counter && cells(cat[it.id], it).includes(mine[0]));
      if (mine.length !== 1 || !base) return { ok: false, reason: 'Das gehört auf eine Theke.' };
      if (same('theke').some((it) => overlap(cells(cat[it.id], it), mine))) return { ok: false, reason: 'Da steht schon etwas.' };
      return { ok: true };
    }

    if (mine.some(isDoor)) return { ok: false, reason: 'Der Eingang muss frei bleiben.' };
    if (same(def.layer).some((it) => overlap(cells(cat[it.id], it), mine))) return { ok: false, reason: 'Da steht schon etwas.' };
    if (def.layer === 'boden' && def.height > MOUNT_Z && same('wandnah').some((it) => mine.includes(it.x + ',' + it.y))) return { ok: false, reason: 'Da hängt ein Gerät an der Wand – das Möbel ist zu hoch.' };
    // Räume: ein Teil steht ganz drinnen oder ganz draußen; im Lager nur Lagerregale, Lagerregale nur im Lager
    const rooms = mine.map((k) => { const [x, y] = k.split(',').map(Number); return roomAt(state, x, y); });
    if (rooms.some((r) => r !== rooms[0])) return { ok: false, reason: 'Das stünde auf einer Wand.' };
    const room = rooms[0];
    if (def.lagerOnly && (!room || room.kind !== 'lager')) return { ok: false, reason: 'Lagerregale gehören ins Lager.' };
    if (room && room.kind === 'lager' && !def.lagerOnly && !def.lagerOk && def.layer === 'boden') return { ok: false, reason: 'Im Lager stehen nur Lagerregale.' };
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
        if (needLevel(s, g.level)) return fail('Ab Ruf-Stufe ' + g.level + '.');
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
        if (def.secret) return fail('Das gibt es nur mit dem Geheimraum.');
        if (needLevel(s, def.level)) return fail('Ab Ruf-Stufe ' + def.level + '.');
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
        if (it.id === CABINET_ID) return fail('Der Schrank gehört zum Geheimraum – E schiebt ihn.');
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
        if (it.id === CABINET_ID) return fail('Der Schrank gehört zum Geheimraum (am PC: Bauen → abreißen).');
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
            const full = cents(lines.reduce((sum, l) => sum + l.qty * l.price, 0));
            // Feilschen: höchstens 30 % Nachlass; Verlust = Falschgeld/zu viel Wechselgeld, höchstens der Betrag selbst
            const deal = Number(a.deal);
            const total = Number.isFinite(deal) && deal > 0 && deal < full ? cents(Math.max(deal, full * 0.7)) : full;
            const lost = Math.max(0, Math.min(total, Number(a.lost) || 0));
            s.coins = cents(s.coins + total - lost);
            t.revenue = cents(t.revenue + total - lost);
            t.lost = cents((t.lost || 0) + lost);
            if (a.method === 'cash') t.cash = cents((t.cash || 0) + total);
            else t.card = cents((t.card || 0) + total);
            t.buyers += 1;
            lines.forEach((l) => { t.sold[l.ware] = (t.sold[l.ware] || 0) + l.qty; });
            t.receipts = t.receipts.concat({ lines: lines, total: total }).slice(-KEEP_RECEIPTS);
            addRuf(s, Math.floor(total / RUF.perCoins));
          }
        }
        if (a.miss && goods[a.miss]) t.misses[a.miss] = (t.misses[a.miss] || 0) + 1;
        const stars = Number(a.stars);
        const text = Object.prototype.hasOwnProperty.call(REVIEW_TEXTS, a.why) ? REVIEW_TEXTS[a.why] : null;
        if (Number.isInteger(stars) && stars >= 1 && stars <= 5 && text) {
          s.reviews = s.reviews.concat({ day: s.day, stars: stars, text: text }).slice(-KEEP_REVIEWS);
          t.reviews += 1;
          t.starSum += stars;
          addRuf(s, rufForStars(stars));
        }
        return { state: s };
      }
      case 'closeDay': {
        if (!s.open) return fail('Der Laden ist schon zu.');
        const t = s.today;
        s.reports = s.reports.concat({
          day: s.day, revenue: t.revenue, sold: t.sold, visitors: t.visitors, buyers: t.buyers, misses: t.misses,
          receipts: t.receipts, stars: t.reviews ? Math.round((t.starSum / t.reviews) * 10) / 10 : null, reviews: t.reviews, services: t.services || {},
          cash: t.cash || 0, card: t.card || 0, lost: t.lost || 0,
          aborted: !!a.aborted,
        }).slice(-KEEP_REPORTS);
        s.open = false;
        s.jobs = []; // wer bis Ladenschluss nicht bedient wurde, ist gegangen
        s.day += 1;
        s.today = freshDay();
        return { state: s };
      }
      // Raum bauen: Rechteck + Tür auf dem Rand (Geheimraum: davor kommt der Schrank)
      case 'buildRoom': {
        const kind = ROOM.kinds.find((k) => k === a.kind);
        const r = { x: Number(a.x), y: Number(a.y), w: Number(a.w), d: Number(a.d), kind };
        if (!kind || ![r.x, r.y, r.w, r.d].every(Number.isInteger)) return fail('Ungültiger Raum.');
        if (needLevel(s, UNLOCK[kind])) return fail('Ab Ruf-Stufe ' + UNLOCK[kind] + '.');
        if (r.w < ROOM.minW || r.d < ROOM.minD) return fail('Ein Raum braucht mindestens ' + ROOM.minW + '×' + ROOM.minD + ' Felder.');
        if (r.x < 0 || r.y < 0 || r.x + r.w > s.units * UNIT_W || r.y + r.d > UNIT_D) return fail('Der Raum muss in deinen Laden passen.');
        if (s.rooms.some((o) => o.x < r.x + r.w && r.x < o.x + o.w && o.y < r.y + r.d && r.y < o.y + o.d)) return fail('Da ist schon ein Raum.');
        if (DOOR.some((c) => inRect(r, c.x, c.y))) return fail('Der Eingang muss frei bleiben.');
        const inside = s.items.filter((it) => cat[it.id] && cat[it.id].layer !== 'wand' && cells(cat[it.id], it).some((k) => { const [x, y] = k.split(',').map(Number); return inRect(r, x, y); }));
        if (inside.length) return fail('Der Platz muss leer sein (' + cat[inside[0].id].name + ').');
        const door = a.door || {};
        const edge = roomEdges(r).find((e) => e.side === door.side && e.i === Number(door.i));
        if (!edge) return fail('Wähle eine Stelle für die Tür.');
        if (outerEdge(s, edge.key)) return fail('Die Tür kann nicht in die Außenwand.');
        r.door = { side: edge.side, i: edge.i };
        let cab = null;
        if (kind === 'geheim') {
          cab = outsideOfDoor(r);
          const key = cab.x + ',' + cab.y;
          if (!inside_(s, key) || roomAt(s, cab.x, cab.y) || isDoor(key) || blocked(s, cat).has(key)) return fail('Vor der Tür muss Platz für den Schrank sein.');
        }
        const cost = roomCost(s, r);
        if (s.coins < cost) return fail('Nicht genug Kanacoin.');
        s.coins = cents(s.coins - cost);
        r.rid = s.nextRid++;
        r.name = (kind === 'lager' ? 'Lager ' : 'Geheimraum ') + (s.rooms.filter((o) => o.kind === kind).length + 1);
        s.rooms.push(r);
        if (cab) s.items.push({ uid: s.nextUid++, id: CABINET_ID, x: cab.x, y: cab.y, rot: cab.rot, rid: r.rid, home: { x: cab.x, y: cab.y } });
        return { state: s };
      }
      case 'renameRoom': {
        const r = s.rooms.find((o) => o.rid === a.rid);
        if (!r) return fail('Den Raum gibt es nicht mehr.');
        const name = String(a.name || '').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, ROOM.nameMax);
        if (!name) return fail('Gib dem Raum einen Namen.');
        r.name = name;
        return { state: s };
      }
      case 'removeRoom': {
        const r = s.rooms.find((o) => o.rid === a.rid);
        if (!r) return fail('Den Raum gibt es nicht mehr.');
        const cab = s.items.find((it) => it.id === CABINET_ID && it.rid === r.rid);
        if (cab && used(cab) > 0) return fail('Erst den Schrank ausräumen.');
        const inside = s.items.filter((it) => it !== cab && cat[it.id] && cat[it.id].layer !== 'wand' && cells(cat[it.id], it).some((k) => { const [x, y] = k.split(',').map(Number); return inRect(r, x, y); }));
        if (inside.length) return fail('Erst den Raum leer räumen.');
        s.coins = cents(s.coins + roomCost(s, r));
        s.rooms = s.rooms.filter((o) => o !== r);
        s.items = s.items.filter((it) => it !== cab);
        return { state: s };
      }
      // Geheimschrank zur Seite schieben (öffnet den Eingang) bzw. zurück
      case 'slideCabinet': {
        const it = find(a.uid);
        if (!it || it.id !== CABINET_ID) return fail('Das ist kein Geheimschrank.');
        const r = s.rooms.find((o) => o.rid === it.rid);
        if (!r || !it.home) return fail('Der Schrank gehört zu keinem Raum.');
        const atHome = it.x === it.home.x && it.y === it.home.y;
        const taken = blocked(Object.assign({}, s, { items: s.items.filter((o) => o !== it) }), cat);
        // Zellen, auf denen jemand steht (der Browser schickt die Figur mit) – der Schrank klemmt niemanden ein
        (Array.isArray(a.avoid) ? a.avoid.slice(0, 8) : []).forEach((k) => { if (typeof k === 'string') taken.add(k); });
        const mounts = mountCells(s, cat);
        const free = (x, y) => inside_(s, x + ',' + y) && !roomAt(s, x, y) && !isDoor(x + ',' + y) && !taken.has(x + ',' + y) && !mounts.has(x + ',' + y);
        if (!atHome) {
          if (!free(it.home.x, it.home.y)) return fail('Da steht etwas oder jemand im Weg.');
          it.x = it.home.x;
          it.y = it.home.y;
          return { state: s };
        }
        const along = r.door.side === 'n' || r.door.side === 's' ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
        const to = along.map(([dx, dy]) => ({ x: it.x + dx, y: it.y + dy })).find((p) => free(p.x, p.y));
        if (!to) return fail('Neben dem Schrank ist kein Platz zum Schieben.');
        it.x = to.x;
        it.y = to.y;
        return { state: s };
      }
      case 'printPoster': {
        const type = (more.posterTypes || []).find((x) => x.id === a.id);
        const price = (more.poster && more.poster.price) || 10;
        if (!type) return fail('Unbekanntes Plakat.');
        const n = Math.max(1, Math.min(10, Number(a.n) || 1));
        if (invUsed(s) + n > INVENTORY.slots) return fail('Inventar voll.');
        if (s.coins < price * n) return fail('Nicht genug Kanacoin.');
        s.coins = cents(s.coins - price * n);
        const key = type.id + (a.secret ? ':geheim' : '');
        s.posters[key] = (s.posters[key] || 0) + n;
        return { state: s };
      }
      case 'hangPoster': {
        const spot = (more.posterSpots || []).find((x) => x.id === a.spot);
        const key = typeof a.key === 'string' ? a.key : '';
        if (!spot) return fail('Unbekannter Ort.');
        if (!s.posters[key]) return fail('Davon hast du kein Plakat.');
        s.posters[key] -= 1;
        if (!s.posters[key]) delete s.posters[key];
        s.hung[spot.id] = key; // ersetzt ein altes Plakat an diesem Ort
        return { state: s };
      }
      case 'setGuest': {
        // Gäste-Kühlschrank: wartende Auftrags-Kunden dürfen sich gratis etwas nehmen, verkauft wird daraus nichts
        const it = find(a.uid);
        if (!it || !cat[it.id] || !cat[it.id].guestOk) return fail('Das geht nur beim Kühlschrank.');
        if (a.on) it.guest = true;
        else delete it.guest;
        return { state: s };
      }
      case 'guestTake': {
        const it = find(a.uid);
        if (!it || !it.guest) return fail('Das ist kein Gäste-Kühlschrank.');
        if (!it.stock || !(it.stock[a.ware] > 0)) return fail('Der Kühlschrank ist leer.');
        it.stock = Object.assign({}, it.stock);
        it.stock[a.ware] -= 1;
        if (!it.stock[a.ware]) delete it.stock[a.ware];
        s.today.guest = (s.today.guest || 0) + 1;
        return { state: s };
      }
      case 'storePoster':
      case 'takePoster': {
        // Plakate zwischen Inventar und Safe bewegen
        const it = find(a.uid);
        const d = it && cat[it.id];
        const key = typeof a.key === 'string' && POSTER_KEY.test(a.key) ? a.key : '';
        if (!d || !d.holdsPosters) return fail('Hier passen keine Plakate hinein.');
        if (!key) return fail('Unbekanntes Plakat.');
        const n = Math.max(1, Math.min(100, Math.floor(Number(a.n)) || 1));
        it.posters = Object.assign({}, it.posters);
        const store = a.type === 'storePoster';
        const from = store ? s.posters : it.posters;
        const to = store ? it.posters : s.posters;
        if ((from[key] || 0) < n) return fail('So viele Plakate sind nicht da.');
        if (store && used(it) + n > d.slots) return fail('Kein Platz mehr.');
        if (!store && invUsed(s) + n > INVENTORY.slots) return fail('Inventar voll.');
        from[key] -= n;
        if (!from[key]) delete from[key];
        to[key] = (to[key] || 0) + n;
        if (!Object.keys(it.posters).length) delete it.posters;
        return { state: s };
      }
      case 'buyClothes': {
        const c = (more.clothes || []).find((x) => x.id === a.id);
        if (!c) return fail('Unbekanntes Kleidungsstück.');
        if (s.wardrobe.includes(c.id)) return fail('Das hast du schon.');
        if (s.coins < c.price) return fail('Nicht genug Kanacoin.');
        s.coins = cents(s.coins - c.price);
        s.wardrobe.push(c.id);
        s.outfit[c.slot] = c.id; // gleich anziehen
        return { state: s };
      }
      case 'wear': {
        const c = (more.clothes || []).find((x) => x.id === a.id);
        if (!c || !s.wardrobe.includes(c.id)) return fail('Das hast du nicht.');
        if (s.outfit[c.slot] === c.id) delete s.outfit[c.slot]; // nochmal = ausziehen
        else s.outfit[c.slot] = c.id;
        return { state: s };
      }
      // TEST-KNOPF (nur Demo, im fertigen Spiel entfernen): Ruf dazugeben
      case 'devRuf': {
        addRuf(s, Math.max(-1000, Math.min(5000, Number(a.amount) || 0)));
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
        if (needLevel(s, lic.level)) return fail('Ab Ruf-Stufe ' + lic.level + '.');
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
        if (steps.includes('foil')) {
          const from = supplier(s, 'mat_sleeve');
          if (!from) return fail('Kein TCG Sleeve mehr an der Booster-Öffnungstheke.');
          takeOne(from, 'mat_sleeve');
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
          const lost = Math.max(0, Math.min(total, Number(a.lost) || 0));
          s.coins = cents(s.coins + total - lost);
          t.revenue = cents(t.revenue + total - lost);
          t.lost = cents((t.lost || 0) + lost);
          if (a.method === 'cash') t.cash = cents((t.cash || 0) + total);
          else t.card = cents((t.card || 0) + total);
          t.buyers += 1;
          t.services = Object.assign({}, t.services);
          job.services.forEach((id) => { t.services[id] = (t.services[id] || 0) + 1; });
          t.receipts = t.receipts.concat({ lines: lines, total: total }).slice(-KEEP_RECEIPTS);
          addRuf(s, Math.floor(total / RUF.perCoins));
        }
        s.jobs = s.jobs.filter((x) => x !== job);
        const stars = Number(a.stars);
        const text = Object.prototype.hasOwnProperty.call(REVIEW_TEXTS, a.why) ? REVIEW_TEXTS[a.why] : null;
        if (Number.isInteger(stars) && stars >= 1 && stars <= 5 && text) {
          s.reviews = s.reviews.concat({ day: s.day, stars: stars, text: text }).slice(-KEEP_REVIEWS);
          t.reviews += 1;
          t.starSum += stars;
          addRuf(s, rufForStars(stars));
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
        if (needLevel(s, UNLOCK.unit)) return fail('Ab Ruf-Stufe ' + UNLOCK.unit + '.');
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
    posterEffect, INVENTORY, invUsed, TABLE, gameTables, RUF, UNLOCK, levelFor, nextLevelAt, DAMP, MOUNT_Z, wallOnSide, mountCells, hasWallNext, wallPieces, dampStatus, spoilStorage, ROOM, CABINET_ID, roomAt, roomCells, roomEdges, outerEdge, wallSet, wallBetween, outsideOfDoor, roomCost, MARKET, marketPrice, roundPrice, priceStepUp, moveMarket, TOOLS, MAX_DIRT, FRONT, rot4, frontCells, REVIEW_TEXTS, MAX_JOBS, SERVICE_ORDER, servicePrice, nextService, supplier, fresh, normalize, ensureCounter, PC_ID, size, cells, check, apply, wallLength, blocked, walkable, used, price,
  };
});
