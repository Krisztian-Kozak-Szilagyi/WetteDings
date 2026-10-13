// Shop-Demo: reine Logik des Ladens (ohne Datenbank/Express) – läuft auf dem Server UND im Browser
// (/js/shop-layout.js liefert genau diese Datei aus, im Browser als window.ShopLayout).
// Raster: Zelle (x, y), x läuft entlang der rechten Rückwand ('n'), y entlang der linken Rückwand ('w').
// Der Laden besteht aus Einheiten zu UNIT_W×UNIT_D Zellen nebeneinander in x-Richtung; die erste gehört einem,
// die Nachbar-Einheiten kann man kaufen. Vorne in der ersten Einheit liegt der Eingang (DOOR, bleibt frei),
// davor der Gehweg (y = UNIT_D … UNIT_D+2), wo bestellte Kartons abgestellt werden.
// Zustand: { coins, units, nextUid, nextBid, items, boxes, carry, prices }
//   items: [{ uid, id, x, y, rot, wall, stock }] – rot 0/1 (gedreht = w/d getauscht), wall 'n'/'w' nur bei Wand-Sachen,
//          stock { wareId: Stück } bei Regalen & Co. (gemischt, jedes Stück braucht einen Platz)
//   boxes: [{ bid, kind: 'ware'|'moebel', id, qty, x, y }] – Kartons; carry = bid des Kartons in der Hand (oder null)
//   prices: { wareId: Verkaufspreis } – fehlt einer, gilt der Marktpreis
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

  const cents = (n) => Math.round(n * 100) / 100;

  function fresh() {
    return { coins: START_COINS, units: 1, nextUid: 1, nextBid: 1, items: [], boxes: [], carry: null, prices: {} };
  }

  /** Fehlende Felder (ältere Stände) ergänzen */
  function normalize(s) {
    const f = fresh();
    const out = Object.assign({}, f, s);
    out.items = (out.items || []).map((it) => Object.assign({}, it));
    out.boxes = (out.boxes || []).map((b) => Object.assign({}, b));
    out.prices = Object.assign({}, out.prices || {});
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

  /** Grundfläche in Zellen, gedreht = Breite/Tiefe getauscht */
  function size(def, rot) {
    return rot ? { w: def.d, d: def.w } : { w: def.w, d: def.d };
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

  function price(state, goods, id) {
    const p = state.prices[id];
    return typeof p === 'number' ? p : goods[id] ? goods[id].market : 0;
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
    const out = { id: cand.id, x: cand.x | 0, y: cand.y | 0, rot: cand.rot ? 1 : 0 };
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
  function apply(state, cat, goods, a) {
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
    fresh, normalize, ensureCounter, PC_ID, size, cells, check, apply, wallLength, blocked, walkable, used, price,
  };
});
