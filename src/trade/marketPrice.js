// Ø-Marktpreis (#204): Was Karten wert sind, bestimmen die Spieler. Gezählt werden nur saubere Verkäufe – eine Seite
// gibt nur Karten derselben Art im selben Zustand, die andere zahlt nur Geld. Daraus ergibt sich ein Stückpreis.
// Tausche, Pakete aus verschiedenen Karten und Gegenstände zählen nicht (dort lässt sich kein Einzelpreis ablesen).
// Der Schlüssel wird beim Abschluss am Angebot gespeichert (Trade.priceRef), gerechnet wird über die letzten DAYS Tage.
// Etappe C: Bei Slabs zählt zusätzlich das Kürzel (Ø je Shop daneben). Gibt es noch keinen Verkauf, wird der Marktpreis
// geschätzt (estimate) – aus dem Händlerpreis, dem Verhältnis Markt/Händler der Seltenheit, Verbreitung, Population,
// Note und dem Vertrauen in den Shop. Der gemessene Preis bleibt reine Messung.
const { Trade } = require('../models/Trade');
const { isItemId, payerRole } = require('./lines');
const catalog = require('../tcg/catalog');
const { slabsAtLeast } = require('../tcg/population');

const DAYS = 30;
const CACHE_MS = 60 * 1000;

/**
 * Zustand einer Position für den Preis: 'slab-<Note>' | 'folie' | 'beschaedigt' | 'lose' (unfoliert, unbeschädigt).
 * Alte Positionen mit Note, aber ohne slab, waren Folien mit Etikett – also BfW-Slabs.
 */
function stateKey(l) {
  const grade = l.slab ? l.slab.grade : l.foiledAt && l.grade ? l.grade : null;
  if (grade) return `slab-${grade}`;
  if (l.foiledAt) return 'folie';
  if (l.damaged) return 'beschaedigt';
  return 'lose';
}

/** Schlüssel einer Position: "<Karte>|<Zustand>" */
const keyOf = (l) => `${l.card}|${stateKey(l)}`;

/** Kürzel des Slabs einer Position (alte Folie mit Note: BfW) – oder null */
const slabCodeOf = (l) => (l.slab ? l.slab.code || null : l.foiledAt && l.grade ? 'BfW' : null);

/** Zustand als Text für die Anzeige */
const STATE_LABELS = { lose: 'ohne Folie', folie: 'in Folie', beschaedigt: 'mit Spuren' };
const stateText = (state) => (state.startsWith('slab-') ? `Slab, Note ${state.slice(5)}` : STATE_LABELS[state] || state);

/**
 * Preisbezug eines (abgeschlossenen) Angebots: { key, n, unit } – oder null, wenn es kein sauberer Verkauf ist.
 * unit = Preis je Stück in Cent (abgerundet).
 */
function priceRefOf(t) {
  if (!t || !(t.price > 0)) return null;
  const give = t.give || [];
  const want = t.want || [];
  if (!give.length === !want.length) return null; // Tausch oder gar keine Karten
  const cardsFrom = give.length ? 'seller' : 'to';
  if (payerRole(t) === cardsFrom) return null; // wer die Karten gibt, zahlt nicht auch noch
  const side = give.length ? give : want;
  if (side.some((l) => isItemId(l.card))) return null;
  const key = keyOf(side[0]);
  if (side.some((l) => keyOf(l) !== key)) return null;
  const ref = { key, n: side.length, unit: Math.floor(t.price / side.length) };
  // Slabs: Kürzel dazu, wenn alle vom selben Shop sind (Ø je Shop)
  const code = slabCodeOf(side[0]);
  if (code && side.every((l) => slabCodeOf(l) === code)) ref.code = code;
  return ref;
}

let cache = null; // { at, map }

/** Cache leeren – nach jedem Abschluss (tradeService) */
const invalidate = () => {
  cache = null;
};

/**
 * Ø-Preise der letzten DAYS Tage: Map key → { avg, n (Stück), deals (Abschlüsse) }. avg = Summe aller Stückpreise
 * geteilt durch die Stückzahl (Cent, gerundet). Für einen kurzen Moment zwischengespeichert.
 */
async function all(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.map;
  const since = new Date(now - DAYS * 864e5);
  const rows = await Trade.aggregate([
    { $match: { status: 'verkauft', closedAt: { $gte: since }, 'priceRef.key': { $type: 'string' } } },
    { $group: { _id: { key: '$priceRef.key', code: '$priceRef.code' }, sum: { $sum: { $multiply: ['$priceRef.unit', '$priceRef.n'] } }, n: { $sum: '$priceRef.n' }, deals: { $sum: 1 } } },
  ]);
  // je Schlüssel über alle Kürzel, dazu je "<Schlüssel>#<Kürzel>"
  const acc = new Map();
  const add = (k, r) => {
    const a = acc.get(k) || { sum: 0, n: 0, deals: 0 };
    acc.set(k, { sum: a.sum + r.sum, n: a.n + r.n, deals: a.deals + r.deals });
  };
  for (const r of rows) {
    add(r._id.key, r);
    if (r._id.code) add(`${r._id.key}#${r._id.code}`, r);
  }
  const map = new Map([...acc].map(([k, a]) => [k, { avg: Math.round(a.sum / a.n), n: a.n, deals: a.deals }]));
  cache = { at: now, map };
  return map;
}

// ---------- Schätzung (Etappe C) ----------
const MIN_RATIO_SALES = 3; // Verhältnis Markt/Händler einer Seltenheit erst ab so vielen verkauften Stück
const DEFAULT_RATIO = { lose: 1, beschaedigt: 0.75, folie: 1 };
// Aufschlag je Note eines Slabs gegenüber der Karte ohne Folie
const GRADE_FACTOR = { 10: 3, 9: 2, 8: 1.5, 7: 1.25, 6: 1.1 };
const gradeFactor = (g) => GRADE_FACTOR[g] || 1;
const SCARCITY = 0.5; // Knappheit: 1 + 0,5 × (1 − Verbreitung)
const POP_STEP = 0.25; // Pop-Knappheit: +25 % je fehlendem Slab bis 3 mit mindestens dieser Note
const POP_SCARCE = 3;
const TRUST_MIN_GRADED = 5; // Vertrauen in einen Shop erst ab so vielen benoteten Aufträgen
const sellOfCard = (cardId) => {
  const c = catalog.cardById[cardId];
  const r = c && catalog.rarityByKey[c.rarity];
  return { rarity: c ? c.rarity : null, sell: r ? r.sell || 0 : 0 };
};
const baseState = (state) => (state.startsWith('slab-') ? 'lose' : state);

/**
 * Verhältnis Marktpreis/Händlerpreis je "<Seltenheit>|<Zustand>" (lose, beschaedigt, folie) aus den gemessenen Preisen
 * (prices aus all()). Erst ab MIN_RATIO_SALES verkauften Stück, sonst fehlt der Eintrag (dann DEFAULT_RATIO).
 */
function ratiosFrom(prices) {
  const acc = new Map();
  for (const [k, p] of prices || []) {
    if (k.includes('#')) continue;
    const [card, state] = k.split('|');
    if (!DEFAULT_RATIO[state]) continue;
    const { rarity, sell } = sellOfCard(card);
    if (!rarity || !sell) continue;
    const key = `${rarity}|${state}`;
    const a = acc.get(key) || { market: 0, sell: 0, n: 0 };
    acc.set(key, { market: a.market + p.avg * p.n, sell: a.sell + sell * p.n, n: a.n + p.n });
  }
  return new Map([...acc].filter(([, a]) => a.n >= MIN_RATIO_SALES && a.sell > 0).map(([k, a]) => [k, a.market / a.sell]));
}

/** Vertrauen in einen Shop (Faktor 0,8–1,2) aus der Treffsicherheit – erst ab TRUST_MIN_GRADED Noten, sonst 1 */
function trustOf(hits) {
  if (!hits || (hits.n || 0) < TRUST_MIN_GRADED) return 1;
  return Math.round((0.8 + 0.4 * ((hits.exact || 0) / hits.n)) * 1000) / 1000;
}

/**
 * Geschätzter Marktpreis einer Position (Cent) – nur, wenn es keinen gemessenen gibt. ctx = { ratios, population,
 * trust: Map Kürzel → Faktor }. Händlerpreis × Verhältnis der Seltenheit × Knappheit (Verbreitung); bei Slabs
 * zusätzlich × Note × Pop-Knappheit × Vertrauen in den Shop. Ohne Händlerpreis (Gegenstände): null.
 */
function estimate(line, ctx = {}) {
  const { rarity, sell } = sellOfCard(line.card);
  if (!sell) return null;
  const state = stateKey(line);
  const base = baseState(state);
  const ratio = (ctx.ratios && ctx.ratios.get(`${rarity}|${base}`)) || DEFAULT_RATIO[base] || 1;
  const data = ctx.population;
  const spread = data && data.active ? (data.spread.get(line.card) || { share: 0 }).share : null;
  let v = sell * ratio * (spread == null ? 1 : 1 + SCARCITY * (1 - spread));
  if (state.startsWith('slab-')) {
    const grade = Number(state.slice(5));
    const pop = data ? data.pop.get(line.card) : null;
    const code = slabCodeOf(line);
    v *= gradeFactor(grade) * (1 + POP_STEP * Math.max(0, POP_SCARCE - slabsAtLeast(pop, grade)));
    v *= code === 'BfW' ? 1 : (ctx.trust && ctx.trust.get(code)) || 1;
  }
  return Math.round(v);
}

/**
 * Marktpreis für Positionen einer Seite, wenn alle denselben Schlüssel haben:
 * { key, state, avg, n, deals, count, est, estimated, code, codeAvg, codeN } – avg = gemessener Ø (null ohne Verkauf),
 * est = Schätzung (nur ohne Verkauf und mit ctx), codeAvg = Ø genau dieses Shop-Kürzels (nur Slabs desselben Shops).
 * count = Stück in dieser Seite. Gemischte Seiten: null.
 */
function summary(lines, prices, ctx = null) {
  const list = (lines || []).filter((l) => !isItemId(l.card));
  if (!list.length || list.length !== (lines || []).length) return null;
  const key = keyOf(list[0]);
  if (list.some((l) => keyOf(l) !== key)) return null;
  const p = prices && prices.get(key);
  const code = slabCodeOf(list[0]);
  const sameCode = code && list.every((l) => slabCodeOf(l) === code);
  const pc = sameCode && prices ? prices.get(`${key}#${code}`) : null;
  const est = !p && ctx ? estimate(list[0], ctx) : null;
  return {
    key,
    state: stateKey(list[0]),
    avg: p ? p.avg : null,
    n: p ? p.n : 0,
    deals: p ? p.deals : 0,
    count: list.length,
    est,
    estimated: est != null,
    code: sameCode ? code : null,
    codeAvg: pc ? pc.avg : null,
    codeN: pc ? pc.n : 0,
  };
}

/**
 * Alles für die Anzeige in einem Rutsch: { prices, ratios, population, trust } – trust aus den Treffsicherheiten der
 * Grading-Shops. Lädt Shops und Population erst hier (Kreisbezüge beim Laden vermeiden).
 */
async function context() {
  const { GradingShop } = require('../models/Grading');
  const population = require('../tcg/population');
  const [prices, pop, shops] = await Promise.all([all(), population.all(), GradingShop.find({ code: { $type: 'string' } }).select('code hits').lean()]);
  return { prices, ratios: ratiosFrom(prices), population: pop, trust: new Map(shops.map((s) => [s.code, trustOf(s.hits)])) };
}

/**
 * Letzte saubere Verkäufe einzelner Exemplare: Map Exemplar → [{ unit, at }] (neueste zuerst, höchstens max).
 * Wie die Kartenhistorie (moderation/cardHistory), aber ohne Namen – zur Anzeige bei Slabs, Folien und Exemplaren.
 */
async function copySales(docIds, max = 3) {
  const ids = [...new Set((docIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const { Types } = require('mongoose');
  const oids = ids.map((id) => new Types.ObjectId(id));
  const trades = await Trade.find({ status: 'verkauft', 'priceRef.key': { $type: 'string' }, $or: [{ 'give.doc': { $in: oids } }, { 'want.doc': { $in: oids } }] })
    .select('give.doc want.doc priceRef closedAt')
    .sort({ closedAt: -1 })
    .limit(ids.length * max * 2)
    .lean();
  const out = new Map();
  for (const t of trades) {
    for (const l of [...(t.give || []), ...(t.want || [])]) {
      const id = l.doc && String(l.doc);
      if (!id || !ids.includes(id)) continue;
      const list = out.get(id) || [];
      if (list.length < max) list.push({ unit: t.priceRef.unit, at: t.closedAt });
      out.set(id, list);
    }
  }
  return out;
}

module.exports = { DAYS, GRADE_FACTOR, DEFAULT_RATIO, stateKey, keyOf, slabCodeOf, stateText, priceRefOf, invalidate, all, ratiosFrom, trustOf, estimate, summary, context, copySales };
