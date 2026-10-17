// Shop-Demo: Kunden – reine Logik (ohne Datenbank/Express), läuft auf dem Server UND im Browser
// (/js/shop-customers.js, im Browser als window.ShopCustomers). Zufall immer als Parameter (rng = () => 0…1).
// Regeln (Krisztian, 2026-10-13):
// - Öffnungszeit 7:45–16:45 = DAY_SECONDS echte Sekunden; geöffnet wird an der Tür, danach kommen keine neuen Kunden.
// - Preis gegenüber dem Marktpreis: bis +15 % zufrieden (5★), bis +35 % kauft er mit Murren (4★/3★), darüber kauft er nicht.
//   Jeder Kunde hat dazu eine eigene Toleranz von ±5 Prozentpunkten (TOL_SPREAD), damit es keine harte Kante gibt.
// - Findet er nichts: selten 2★; ist der Laden (fast) leer: 1★. Zu lange an der Kasse: geht verärgert, 2★.
// - Mehr Sterne = mehr Kunden; es zählen nur die letzten REVIEW_WINDOW Bewertungen, ein neuer Laden startet mit 3★.
// - Wünsche: Kunden suchen gezielt eine Ware (wishPool) – nur, was der Spieler schon haben kann: ohne Lizenz, mit
//   gekaufter Lizenz oder mit einer Lizenz, die er sich leisten könnte. Finden sie sie nicht, fragen sie danach
//   (Hinweis für den Spieler, landet im Tagesbericht).
// - Großeinkäufer (2026-10-14): 5 % der Kunden nehmen 3–6× so viel.
// - Aufträge (2026-10-14): 10 % bringen eine Karte (reinigen, benoten + Slab, Sleeve …), höchstens 2 gleichzeitig,
//   nur wenn die Tische dafür stehen. Sie warten SERVICE_PATIENCE Sekunden je Arbeitstisch.
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

  const WISH_CHANCE = 0.7;
  const IMPULSE_CHANCE = 0.25;
  const BUYER_REVIEWS = 0.8;
  const NOTHING_REVIEW = 0.15;
  const EMPTY_SHOP = 5; // so wenig Ware im ganzen Laden = „leer“
  const PATIENCE = 30; // Sekunden an der Kasse
  const BIG_CHANCE = 0.05;
  const SERVICE_CHANCE = 0.1;
  const SERVICE_PATIENCE = 90; // je Arbeitstisch, den der Auftrag braucht
  // Sauberkeit (Krisztian, 2026-10-14): 10 % der Kunden hinterlassen einen Fleck; ab 3 Flecken, die älter als 30 s
  // sind (ein frischer Fleck soll nicht sofort zählen), gibt es höchstens 3★
  // Bezahlen (Krisztian, 2026-10-17): halb Karte, halb bar. Falschgeld nur bei Kunden, die Illegales kaufen (10 %).
  // Feilschen: selten und nur bei großen Einkäufen; nie eine schlechtere Bewertung deswegen
  const PAY = { cardShare: 0.5, fakeChance: 0.1, bills: [100, 50, 20, 10, 5], change: [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.01] };
  const HAGGLE = { minTotal: 150, chance: 0.2, minOff: 0.1, maxOff: 0.25, walkAway: 0.5 };
  const DIRT_CHANCE = 0.1;
  const DIRT_LIMIT = 3;
  const DIRT_GRACE_MS = 30000;
  const DIRT_MAX_STARS = 3;

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

  // ---------- Nachfrage: wie viele Kunden heute kommen (Krisztian, 2026-10-17: keine feste Zahl) ----------
  // Bekanntheit (Ruf-Stufe) × Stimmung (Sterne) × Wochentag × Tagesschwankung × Ereignis, dazu die Plakate.
  // Alle Zahlen = Platzhalter. Kein Deckel: wer nichts findet, kauft einfach nichts.
  const DEMAND = {
    base: [14, 18, 22, 26, 30], // nach Ruf-Stufe 1–5 (darüber: letzter Wert)
    stars: [0.6, 0.8, 1, 1.15, 1.3], // nach Sternen 1–5, dazwischen linear
    week: [
      { name: 'Mo', f: 0.8 }, { name: 'Di', f: 0.9 }, { name: 'Mi', f: 1 }, { name: 'Do', f: 1 },
      { name: 'Fr', f: 1.15 }, { name: 'Sa', f: 1.35 }, { name: 'So', f: 1.2 },
    ],
    spread: 0.2, // ±20 % von Tag zu Tag
    peak: 0.47, // Tagesanteil um 12 Uhr: da kommen die meisten
  };
  /** Wochentag zu Tag n (Tag 1 = Montag) */
  function weekday(n) {
    return DEMAND.week[(Math.max(1, Math.floor(n) || 1) - 1) % 7];
  }
  function starFactor(r) {
    const c = Math.max(1, Math.min(5, r)) - 1;
    const i = Math.min(3, Math.floor(c));
    return DEMAND.stars[i] + (c - i) * (DEMAND.stars[i + 1] - DEMAND.stars[i]);
  }
  /** Erwartete Kunden (ohne Zufall): ctx = { level, rating, day, extra (Plakate), event (Faktor, später) } */
  function expectedCustomers(ctx) {
    const b = DEMAND.base[Math.min(DEMAND.base.length, Math.max(1, ctx.level || 1)) - 1];
    const f = starFactor(ctx.rating == null ? START_RATING : ctx.rating) * weekday(ctx.day).f * (ctx.event || 1);
    return Math.max(1, Math.round(b * f)) + (ctx.extra || 0);
  }
  /** Kunden heute: wie erwartet, aber mit Tagesschwankung */
  function customersToday(ctx, rng) {
    const b = DEMAND.base[Math.min(DEMAND.base.length, Math.max(1, ctx.level || 1)) - 1];
    const f = starFactor(ctx.rating == null ? START_RATING : ctx.rating) * weekday(ctx.day).f * (ctx.event || 1);
    const swing = 1 + (rng() * 2 - 1) * DEMAND.spread;
    return Math.max(1, Math.round(b * f * swing)) + (ctx.extra || 0);
  }

  // ---------- Bezahlen ----------
  const c2 = (n) => Math.round(n * 100) / 100;
  /** Karte oder bar? */
  function payMethod(rng) {
    return rng() < PAY.cardShare ? 'card' : 'cash';
  }
  /** Was der Kunde bar hinlegt: ein, zwei Scheine, mindestens die Summe (wie im echten Leben, mal passend, mal groß) */
  function cashGiven(total, rng) {
    const big = PAY.bills.filter((b) => b >= total);
    if (big.length && rng() < 0.6) return [big[big.length - 1 - Math.floor(rng() * Math.min(2, big.length))]];
    const out = [];
    let sum = 0;
    while (sum < total) {
      const b = PAY.bills.find((x) => x <= total - sum + 0.0001) || PAY.bills[PAY.bills.length - 1];
      out.push(b);
      sum += b;
    }
    if (rng() < 0.5 && sum - total < 5) out.push(5);
    return out;
  }
  /** Falschgeld: nur wer Illegales kauft, versucht es (10 %) – Index des falschen Scheins oder -1 */
  function fakeBill(customer, given, rng) {
    if (!customer || !customer.illegal || !given.length) return -1;
    return rng() < PAY.fakeChance ? Math.floor(rng() * given.length) : -1;
  }
  /** Wechselgeld auswerten: { due, gave, short, over } (short = zu wenig herausgegeben, over = zu viel) */
  function changeResult(total, given, change) {
    const due = c2(given.reduce((a, b) => a + b, 0) - total);
    const gave = c2(change.reduce((a, b) => a + b, 0));
    return { due, gave, short: c2(Math.max(0, due - gave)), over: c2(Math.max(0, gave - due)) };
  }

  // ---------- Feilschen ----------
  /** Will der Kunde feilschen? → { offer, max } (max = was er insgeheim höchstens zahlt) oder null */
  function haggle(total, rng) {
    if (total < HAGGLE.minTotal || rng() >= HAGGLE.chance) return null;
    const off = HAGGLE.minOff + rng() * (HAGGLE.maxOff - HAGGLE.minOff);
    const offer = c2(total * (1 - off));
    return { offer, max: c2(offer + rng() * (total - offer)) };
  }
  /** Antwort auf ein Gegenangebot (oder null = abgelehnt): { deal: Preis } oder { walk: true } / { full: true } */
  function haggleAnswer(h, counter, total, rng) {
    if (counter !== null && counter <= h.max) return { deal: c2(counter) };
    return rng() < HAGGLE.walkAway ? { walk: true } : { full: true, deal: total };
  }

  /** Ankunftszeiten als Anteil des Tages (0…LAST_ARRIVAL), sortiert – mittags die meisten, morgens/abends weniger */
  function arrivals(n, rng) {
    const w = (x) => 0.35 + Math.exp(-Math.pow((x - DEMAND.peak) / 0.2, 2)); // höchstens 1,35
    const out = [];
    for (let i = 0; i < n; i++) {
      let x = rng() * LAST_ARRIVAL;
      for (let k = 0; k < 20 && rng() * 1.35 > w(x); k++) x = rng() * LAST_ARRIVAL;
      out.push(x);
    }
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

  /**
   * Waren, die sich Kunden wünschen dürfen: nur verkäufliche Ware der Stufe, und nur ohne Lizenz, mit gekaufter
   * Lizenz oder mit einer, die sich der Spieler gerade leisten könnte. ctx = { tier, licenses: [id], coins, prices: { id: Preis } }
   */
  function wishPool(goodsList, ctx) {
    const c = ctx || {};
    const owned = c.licenses || [];
    const prices = c.prices || {};
    return goodsList.filter((g) => (g.kind || 'ware') === 'ware' && (g.tier || 1) <= (c.tier || 1) && (g.level || 1) <= (c.level || 99) &&
      (!g.license || owned.includes(g.license) || (prices[g.license] !== undefined && prices[g.license] <= (c.coins || 0))));
  }

  function newCustomer(rng, goodsList, ctx) {
    const pool = wishPool(goodsList, ctx);
    // Plakate (ctx.boost = { wareId: Gewicht }) machen ihre Waren als Wunsch wahrscheinlicher
    const weights = pool.map((g) => 1 + ((ctx && ctx.boost && ctx.boost[g.id]) || 0));
    let pick = rng() * weights.reduce((a, b) => a + b, 0);
    const idx = Math.max(0, weights.findIndex((w) => (pick -= w) < 0));
    const wish = pool.length && rng() < WISH_CHANCE ? pool[idx].id : null;
    return { tol: (rng() * 2 - 1) * TOL_SPREAD, wish: wish, big: rng() < BIG_CHANCE };
  }

  function quantity(g, avail, rng, big) {
    const max = g.perBox >= 10 ? 3 : 1;
    const n = (1 + Math.floor(rng() * max)) * (big ? 3 + Math.floor(rng() * 4) : 1);
    return Math.max(1, Math.min(avail, n));
  }

  /**
   * Bringt der Kunde eine Karte mit? → [dienstId] oder null. stations = Set der Möbel-IDs im Laden,
   * openJobs = laufende Aufträge, packs/services aus src/shop/catalog.js
   */
  function serviceWish(rng, stations, openJobs, packs, services) {
    if (openJobs >= 2 || rng() >= SERVICE_CHANCE) return null;
    const byId = Object.fromEntries(services.map((x) => [x.id, x]));
    const ok = packs.filter((p) => p.services.every((id) => byId[id] && stations.has(byId[id].station)));
    if (!ok.length) return null;
    let r = rng() * ok.reduce((a, p) => a + p.weight, 0);
    const pack = ok.find((p) => (r -= p.weight) < 0) || ok[ok.length - 1];
    return pack.services.slice();
  }

  /** Wie zufrieden mit der Arbeit an der Karte? results = { clean %, iron %, guess, grade, seal % } → 3–5★ */
  function workStars(services, results) {
    const r = results || {};
    const pct = (v) => (v >= 90 ? 5 : v >= 70 ? 4 : 3);
    let stars = 5;
    if (services.includes('clean')) stars = Math.min(stars, r.clean >= 95 ? 5 : r.clean >= 80 ? 4 : 3);
    if (services.includes('iron')) stars = Math.min(stars, pct(r.iron || 0));
    if (services.includes('grade')) {
      const diff = Math.abs((r.guess || 0) - (r.grade || 0));
      stars = Math.min(stars, diff === 0 ? 5 : diff === 1 ? 4 : 3);
    }
    if (services.includes('slab')) stars = Math.min(stars, pct(r.seal || 0));
    if (services.includes('foil') && typeof r.foil === 'number') stars = Math.min(stars, pct(r.foil));
    return stars;
  }

  /**
   * Einkauf: offers = [{ uid, ware, qty, price }] (was in den Regalen liegt, Preis = Verkaufspreis).
   * → { basket: [{ uid, ware, qty, price }], stars (schlechteste Laune, 5 wenn nichts), missWish, tooExpensive: [ware] }
   */
  function shop(customer, offers, goods, rng) {
    const avail = offers.filter((o) => o.qty > 0 && goods[o.ware] && (goods[o.ware].kind || 'ware') === 'ware');
    const wares = Array.from(new Set(avail.map((o) => o.ware)));
    const basket = [];
    const tooExpensive = [];
    let stars = 5;
    let missWish = false;

    const tryBuy = (ware) => {
      const o = avail.filter((x) => x.ware === ware).sort((a, b) => a.price - b.price || b.qty - a.qty)[0];
      const j = judge(o.price, o.market || goods[ware].market, customer.tol); // o.market = aktueller Marktpreis
      if (!j.buy) { tooExpensive.push(ware); return; }
      basket.push({ uid: o.uid, ware: ware, qty: quantity(goods[ware], o.qty, rng, customer.big), price: o.price });
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

  /** Flecken, die ein Kunde beim Gehen bemerkt (älter als DIRT_GRACE_MS) */
  function dirtCount(dirt, now) {
    return (dirt || []).filter((d) => now - (d.at || 0) >= DIRT_GRACE_MS).length;
  }

  /** Bewertung an die Sauberkeit anpassen: zu schmutzig → höchstens 3★ (Text „schmutzig“) */
  function dirtCap(rev, dirt, now) {
    if (!rev || dirtCount(dirt, now) < DIRT_LIMIT || rev.stars <= DIRT_MAX_STARS) return rev;
    return { stars: DIRT_MAX_STARS, why: 'dirty' };
  }

  /** Möbel, auf dem etwas steht (Booster-Display auf der Theke → die Theke), sonst das Möbel selbst */
  function baseOf(state, cat, it) {
    if (cat[it.id].layer !== 'theke') return it;
    const key = it.x + ',' + it.y;
    return state.items.find((o) => cat[o.id].counter && L.cells(cat[o.id], o).includes(key)) || it;
  }

  /**
   * Freie Zellen VOR einem Möbel (Krisztian, 2026-10-14: Kunden nehmen nur von vorne). Sachen auf der Theke
   * (Booster-Display) haben ihre eigene Vorderseite – zeigt sie in die Theke hinein, kommt man nicht heran.
   */
  function approach(state, cat, it, blockSet) {
    const blocks = blockSet || L.blocked(state, cat);
    const out = new Set();
    L.frontCells(cat[it.id], it).forEach((c) => {
      if (c.y < L.UNIT_D && walkableCell(state, blocks, c.x, c.y)) out.add(c.x + ',' + c.y);
    });
    return out;
  }

  /**
   * Warteschlange vor der Kasse: erst die Mitte vor der Theke, dann gerade nach vorne weg, danach freie Zellen daneben.
   * → ["x,y", …], Platz 0 = wer als Nächster dran ist
   */
  function queueLine(state, cat, counterItem, blockSet, max) {
    const blocks = blockSet || L.blocked(state, cat);
    const limit = max || 10;
    const front = L.frontCells(cat[counterItem.id], counterItem).filter((c) => c.y < L.UNIT_D && walkableCell(state, blocks, c.x, c.y));
    if (!front.length) return [];
    const [dx, dy] = L.FRONT[L.rot4(counterItem.rot)];
    const start = front[Math.floor((front.length - 1) / 2)];
    const out = [];
    const seen = new Set();
    for (let k = 0; out.length < limit; k++) {
      const x = start.x + dx * k;
      const y = start.y + dy * k;
      if (y >= L.UNIT_D || !walkableCell(state, blocks, x, y)) break;
      out.push(x + ',' + y);
      seen.add(x + ',' + y);
    }
    // reicht die Gerade nicht: freie Nachbarzellen der bisherigen Plätze
    for (let i = 0; i < out.length && out.length < limit; i++) {
      const [x, y] = out[i].split(',').map(Number);
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([ax, ay]) => {
        const k = x + ax + ',' + (y + ay);
        if (out.length < limit && !seen.has(k) && y + ay < L.UNIT_D && walkableCell(state, blocks, x + ax, y + ay)) { seen.add(k); out.push(k); }
      });
    }
    return out;
  }

  return {
    OPEN_MIN, CLOSE_MIN, DAY_SECONDS, LAST_ARRIVAL, HAPPY, OK, TOL_SPREAD, REVIEW_WINDOW, START_RATING,
    EMPTY_SHOP, PATIENCE, BIG_CHANCE, SERVICE_CHANCE, SERVICE_PATIENCE, serviceWish, workStars,
    PAY, HAGGLE, payMethod, cashGiven, fakeBill, changeResult, haggle, haggleAnswer, rngFrom, rating, DEMAND, weekday, expectedCustomers, customersToday, arrivals, clock, judge, wishPool, newCustomer, shop, review, angryReview,
    walkableCell, path, approach, baseOf, queueLine, DIRT_CHANCE, DIRT_LIMIT, DIRT_GRACE_MS, dirtCount, dirtCap,
  };
});
