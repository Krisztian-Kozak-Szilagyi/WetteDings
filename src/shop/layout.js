// Shop-Demo: reine Logik des Ladens (ohne Datenbank/Express) – läuft auf dem Server UND im Browser
// (/js/shop-layout.js liefert genau diese Datei aus, im Browser als window.ShopLayout).
// Raster: Zelle (x, y), x läuft entlang der rechten Rückwand ('n'), y entlang der linken Rückwand ('w').
// Der Laden besteht aus Einheiten zu UNIT_W×UNIT_D Zellen nebeneinander in x-Richtung; die erste gehört einem,
// die Nachbar-Einheiten kann man kaufen. Vorne in der ersten Einheit liegt der Eingang (DOOR, bleibt frei).
// Zustand: { coins, units, nextUid, items: [{ uid, id, x, y, rot, wall }] } – rot 0/1 (1 = gedreht, w/d getauscht),
// wall 'n'/'w' nur bei Wand-Sachen (Position entlang der Wand: x bei 'n', y bei 'w').
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
  const DOOR = [{ x: 3, y: UNIT_D - 1 }, { x: 4, y: UNIT_D - 1 }];

  function fresh() {
    return { coins: START_COINS, units: 1, nextUid: 1, items: [] };
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

  /** Darf das Teil so stehen? → { ok, reason } (ignore = uid, die beim Verschieben nicht mitzählt) */
  function check(state, catalog, cand, ignore) {
    const def = catalog[cand.id];
    if (!def) return { ok: false, reason: 'Unbekanntes Teil.' };
    if (!Number.isInteger(cand.x) || !Number.isInteger(cand.y)) return { ok: false, reason: 'Ungültige Position.' };
    const others = state.items.filter((it) => it.uid !== ignore && catalog[it.id]);
    const same = (layer) => others.filter((it) => catalog[it.id].layer === layer);

    if (def.layer === 'wand') {
      if (cand.wall !== 'n' && cand.wall !== 'w') return { ok: false, reason: 'Das hängt an der Wand.' };
      const pos = cand.wall === 'n' ? cand.x : cand.y;
      if (pos < 0 || pos + def.w > wallLength(state, cand.wall)) return { ok: false, reason: 'Passt nicht an die Wand.' };
      const hit = same('wand').some((it) => {
        if (it.wall !== cand.wall) return false;
        const p = it.wall === 'n' ? it.x : it.y;
        return p < pos + def.w && pos < p + catalog[it.id].w;
      });
      return hit ? { ok: false, reason: 'Da hängt schon etwas.' } : { ok: true };
    }

    const mine = cells(def, cand);
    if (!mine.every((k) => inside(state, k))) return { ok: false, reason: 'Außerhalb deines Ladens.' };

    if (def.layer === 'theke') {
      const base = same('boden').find((it) => catalog[it.id].counter && cells(catalog[it.id], it).includes(mine[0]));
      if (mine.length !== 1 || !base) return { ok: false, reason: 'Das gehört auf eine Theke.' };
      if (same('theke').some((it) => overlap(cells(catalog[it.id], it), mine))) return { ok: false, reason: 'Da steht schon etwas.' };
      return { ok: true };
    }

    if (mine.some(isDoor)) return { ok: false, reason: 'Der Eingang muss frei bleiben.' };
    if (same(def.layer).some((it) => overlap(cells(catalog[it.id], it), mine))) return { ok: false, reason: 'Da steht schon etwas.' };
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
  function onTop(state, catalog, base) {
    const bc = cells(catalog[base.id], base);
    return state.items.filter((it) => catalog[it.id] && catalog[it.id].layer === 'theke' && bc.includes(cells(catalog[it.id], it)[0]));
  }

  /**
   * Eine Aktion ausführen → { state } (neuer Zustand) oder { error }.
   * place {id,x,y,rot,wall} kostet den Preis · move {uid,x,y,rot,wall} kostenlos · remove {uid} gibt den Preis zurück
   * (samt Sachen auf der Theke) · buyUnit · setCoins {amount} · reset
   */
  function apply(state, catalog, a) {
    const s = JSON.parse(JSON.stringify(state));
    const fail = (error) => ({ error });
    const find = (uid) => s.items.find((it) => it.uid === uid);

    switch (a && a.type) {
      case 'place': {
        const def = catalog[a.id];
        if (!def) return fail('Unbekanntes Teil.');
        if (s.items.length >= MAX_ITEMS) return fail('Der Laden ist voll.');
        if (s.coins < def.price) return fail('Nicht genug Kanacoin.');
        const cand = clean(a, def);
        const c = check(s, catalog, cand);
        if (!c.ok) return fail(c.reason);
        s.coins -= def.price;
        s.items.push(Object.assign({ uid: s.nextUid++ }, cand));
        return { state: s };
      }
      case 'move': {
        const it = find(a.uid);
        if (!it) return fail('Das Teil gibt es nicht mehr.');
        const def = catalog[it.id];
        const cand = clean(Object.assign({}, a, { id: it.id }), def);
        const c = check(s, catalog, cand, it.uid);
        if (!c.ok) return fail(c.reason);
        const riders = def.counter ? onTop(s, catalog, it) : [];
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
        const gone = [it].concat(catalog[it.id] && catalog[it.id].counter ? onTop(s, catalog, it) : []);
        gone.forEach((g) => { s.coins += (catalog[g.id] && catalog[g.id].price) || 0; });
        s.items = s.items.filter((x) => !gone.includes(x));
        return { state: s };
      }
      case 'buyUnit': {
        if (s.units >= MAX_UNITS) return fail('Mehr Platz gibt es nicht.');
        if (s.coins < a.price) return fail('Nicht genug Kanacoin.');
        s.coins -= a.price;
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
        return { state: fresh() };
      default:
        return fail('Unbekannte Aktion.');
    }
  }

  return { UNIT_W, UNIT_D, MAX_UNITS, START_COINS, MAX_COINS, MAX_ITEMS, DOOR, fresh, size, cells, check, apply, wallLength };
});
