// Shop-Demo: Kunden – reine Logik (ohne Datenbank/Express), läuft auf dem Server UND im Browser
// (/js/shop-customers.js, im Browser als window.ShopCustomers). Zufall immer als Parameter (rng = () => 0…1).
// Regeln (Krisztian, 2026-10-13):
// - Öffnungszeit 7:45–16:45 = DAY_SECONDS echte Sekunden; geöffnet wird an der Tür, danach kommen keine neuen Kunden.
// - Preis gegenüber dem Marktpreis: bis +15 % zufrieden (5★), bis +35 % kauft er mit Murren (4★/3★), darüber kauft er nicht.
//   Jeder Kunde hat dazu eine eigene Toleranz von ±5 Prozentpunkten (TOL_SPREAD), damit es keine harte Kante gibt.
// - Findet er nichts: selten 2★; ist der Laden (fast) leer: 1★. Zu lange an der Kasse: geht verärgert, 2★.
// - Mehr Sterne = mehr Kunden; es zählen nur die letzten REVIEW_WINDOW Bewertungen, ein neuer Laden startet mit 3★.
// - Wünsche: Kunden suchen gezielt eine Ware aus dem Pool ihrer Stufe (wishPool) – später nur, was der Spieler schon
//   haben kann (tier). Finden sie sie nicht, fragen sie danach (Hinweis für den Spieler, landet im Tagesbericht).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./layout'));
  else root.ShopCustomers = factory(root.ShopLayout);
})(typeof self !== 'undefined' ? self : this, function (L) {
  const OPEN_MIN = 7 * 60 + 45;
  const CLOSE_MIN = 16 * 60 + 45;
  const DAY_SECONDS = 300;
  const LAST_ARRIVAL = 0.92; // Anteil des Tages, bis zu dem noch Kunden kommen

  const HAPPY = 0.15;
  const OK = 0.35;
  const TOL_SPREAD = 0.05;

  const REVIEW_WINDOW = 30;
  const START_RATING = 3;
  const MIN_CUSTOMERS = 8;
  const MAX_CUSTOMERS = 30;

  const WISH_CHANCE = 0.7;
  const IMPULSE_CHANCE = 0.25;
  const BUYER_REVIEWS = 0.8;
  const NOTHING_REVIEW = 0.15;
  const EMPTY_SHOP = 5; // so wenig Ware im ganzen Laden = „leer“
  const PATIENCE = 30; // Sekunden an der Kasse

  /** Fester Zufall aus einer Zahl (für Tests und Wiederholbarkeit) */
  function rngFrom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rating(reviews) {
    const last = (reviews || []).slice(-REVIEW_WINDOW);
    if (!last.length) return START_RATING;
    return last.reduce((a, r) => a + r.stars, 0) / last.length;
  }

  function customersPerDay(r) {
    const c = Math.max(1, Math.min(5, r));
    return Math.round(MIN_CUSTOMERS + ((c - 1) / 4) * (MAX_CUSTOMERS - MIN_CUSTOMERS));
  }

  /** Ankunftszeiten als Anteil des Tages (0…LAST_ARRIVAL), sortiert */
  function arrivals(n, rng) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(rng() * LAST_ARRIVAL);
    return out.sort((a, b) => a - b);
  }

  /** Uhrzeit zum Tagesanteil */
  function clock(fraction) {
    const m = Math.round(OPEN_MIN + Math.max(0, Math.min(1, fraction)) * (CLOSE_MIN - OPEN_MIN));
    return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
  }

  /** Was der Kunde zum Preis sagt: { buy, stars } (tol = eigene Abweichung in Prozentpunkten) */
  function judge(price, market, tol) {
    const over = market > 0 ? price / market - 1 : 0;
    const t = tol || 0;
    if (over <= HAPPY + t) return { buy: true, stars: 5 };
    if (over <= (HAPPY + OK) / 2 + t) return { buy: true, stars: 4 };
    if (over <= OK + t) return { buy: true, stars: 3 };
    return { buy: false, stars: 0 };
  }

  /** Waren, die sich Kunden auf dieser Stufe wünschen dürfen */
  function wishPool(goodsList, tier) {
    return goodsList.filter((g) => (g.tier || 1) <= (tier || 1));
  }

  function newCustomer(rng, goodsList, tier) {
    const pool = wishPool(goodsList, tier);
    const wish = pool.length && rng() < WISH_CHANCE ? pool[Math.floor(rng() * pool.length)].id : null;
    return { tol: (rng() * 2 - 1) * TOL_SPREAD, wish: wish };
  }

  function quantity(g, avail, rng) {
    const max = g.perBox >= 10 ? 3 : 1;
    return Math.max(1, Math.min(avail, 1 + Math.floor(rng() * max)));
  }

  /**
   * Einkauf: offers = [{ uid, ware, qty, price }] (was in den Regalen liegt, Preis = Verkaufspreis).
   * → { basket: [{ uid, ware, qty, price }], stars (schlechteste Laune, 5 wenn nichts), missWish, tooExpensive: [ware] }
   */
  function shop(customer, offers, goods, rng) {
    const avail = offers.filter((o) => o.qty > 0 && goods[o.ware]);
    const wares = Array.from(new Set(avail.map((o) => o.ware)));
    const basket = [];
    const tooExpensive = [];
    let stars = 5;
    let missWish = false;

    const tryBuy = (ware) => {
      const o = avail.filter((x) => x.ware === ware).sort((a, b) => a.price - b.price || b.qty - a.qty)[0];
      const j = judge(o.price, goods[ware].market, customer.tol);
      if (!j.buy) { tooExpensive.push(ware); return; }
      basket.push({ uid: o.uid, ware: ware, qty: quantity(goods[ware], o.qty, rng), price: o.price });
      stars = Math.min(stars, j.stars);
    };

    if (customer.wish) {
      if (wares.includes(customer.wish)) tryBuy(customer.wish);
      else missWish = true;
    }
    const others = wares.filter((w) => w !== customer.wish);
    const browse = customer.wish ? IMPULSE_CHANCE : 1; // ohne Wunsch schaut er sich auf jeden Fall um
    let picks = 0;
    others.forEach((w) => {
      if (picks >= 2) return;
      if (rng() < (customer.wish ? browse : 0.5)) { tryBuy(w); picks++; }
    });
    if (!customer.wish && !basket.length && !tooExpensive.length && others.length) tryBuy(others[Math.floor(rng() * others.length)]);
    return { basket, stars, missWish, tooExpensive };
  }

  /** Bewertung beim Gehen → { stars, why } (why = Schlüssel in ShopLayout.REVIEW_TEXTS) oder null (schreibt keine). shopStock = Ware im ganzen Laden */
  function review(result, shopStock, rng) {
    if (result.basket.length) return rng() < BUYER_REVIEWS ? { stars: result.stars, why: String(result.stars) } : null;
    if (shopStock <= EMPTY_SHOP) return { stars: 1, why: 'empty' };
    return rng() < NOTHING_REVIEW ? { stars: 2, why: 'nothing' } : null;
  }

  function angryReview() {
    return { stars: 2, why: 'waited' };
  }

  // ---------- Wege im Raster (4 Richtungen, Tür als einziger Übergang zum Gehweg) ----------
  function walkableCell(state, blockSet, x, y) {
    if (x < 0 || y < 0 || x >= state.units * L.UNIT_W || y >= L.UNIT_D + L.SIDEWALK) return false;
    return y >= L.UNIT_D || !blockSet.has(x + ',' + y);
  }

  function step(state, blockSet, ax, ay, bx, by) {
    if (!walkableCell(state, blockSet, bx, by)) return false;
    if ((ay < L.UNIT_D) !== (by < L.UNIT_D)) return L.DOOR.some((c) => c.x === bx && c.x === ax);
    return true;
  }

  /** Kürzester Weg von Zelle start zu einer der Zielzellen (Set "x,y") → [{x,y}…] ohne Start, oder null */
  function path(state, cat, start, goals, blockSet) {
    const blocks = blockSet || L.blocked(state, cat);
    const key = (x, y) => x + ',' + y;
    if (goals.has(key(start.x, start.y))) return [];
    const prev = new Map([[key(start.x, start.y), null]]);
    const queue = [start];
    for (let i = 0; i < queue.length && i < 5000; i++) {
      const c = queue[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        const k = key(nx, ny);
        if (prev.has(k) || !step(state, blocks, c.x, c.y, nx, ny)) continue;
        prev.set(k, c);
        const n = { x: nx, y: ny };
        if (goals.has(k)) {
          const out = [n];
          let p = c;
          while (p && prev.get(key(p.x, p.y))) { out.unshift(p); p = prev.get(key(p.x, p.y)); }
          return out;
        }
        queue.push(n);
      }
    }
    return null;
  }

  /** Freie Zellen direkt neben einem Möbel (bei Sachen auf der Theke: neben der Theke) */
  function approach(state, cat, it, blockSet) {
    const blocks = blockSet || L.blocked(state, cat);
    let base = it;
    if (cat[it.id].layer === 'theke') {
      const key = it.x + ',' + it.y;
      base = state.items.find((o) => cat[o.id].counter && L.cells(cat[o.id], o).includes(key)) || it;
    }
    const own = new Set(L.cells(cat[base.id], base));
    const out = new Set();
    own.forEach((k) => {
      const [x, y] = k.split(',').map(Number);
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        if (ny < L.UNIT_D && !own.has(nx + ',' + ny) && walkableCell(state, blocks, nx, ny)) out.add(nx + ',' + ny);
      });
    });
    return out;
  }

  return {
    OPEN_MIN, CLOSE_MIN, DAY_SECONDS, LAST_ARRIVAL, HAPPY, OK, TOL_SPREAD, REVIEW_WINDOW, START_RATING,
    MIN_CUSTOMERS, MAX_CUSTOMERS, EMPTY_SHOP, PATIENCE,
    rngFrom, rating, customersPerDay, arrivals, clock, judge, wishPool, newCustomer, shop, review, angryReview,
    walkableCell, path, approach,
  };
});
