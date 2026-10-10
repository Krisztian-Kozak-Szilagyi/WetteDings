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

// Robust gegen Geschenke und Scheingeschäfte (#204, Etappe C):
//  - Verkäufe unter FLOOR_SHARE des Händlerpreises sind Geschenke bzw. Verschiebungen (die Bank zahlt mehr) – zählen nicht
//  - Geschäfte zwischen erkannten Mehrfach-Konten zählen nicht (device/deviceService.flaggedPairs)
//  - Ausreißer über OUTLIER_FACTOR × Median eines Schlüssels fallen raus
//  - als gemessen gilt ein Preis erst ab MIN_PAIRS verschiedenen Handelspaaren – sonst wird geschätzt
const FLOOR_SHARE = 0.5;
const OUTLIER_FACTOR = 5;
const MIN_PAIRS = 2;

const median = (list) => {
  const s = [...list].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * Gemessene Preise aus einzelnen Verkäufen (rein, getestet). rows: [{ key, code, n, unit, pair }] (pair = Schlüssel der
 * beiden Konten), flagged: Set der als Mehrfach-Konto erkannten Paare. Ergebnis wie all(): Map key bzw. "key#Kürzel"
 * → { avg, n, deals, pairs } – pairs = Zahl verschiedener Handelspaare.
 */
function aggregate(rows, flagged = new Set()) {
  const kept = rows.filter((r) => {
    const { sell } = sellOfCard(String(r.key).split('|')[0]);
    if (sell && r.unit < sell * FLOOR_SHARE) return false;
    return !(r.pair && flagged.has(r.pair));
  });
  const byKey = new Map();
  for (const r of kept) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const out = new Map();
  const add = (k, list) => {
    if (!list.length) return;
    const n = list.reduce((s, r) => s + r.n, 0);
    const sum = list.reduce((s, r) => s + r.unit * r.n, 0);
    out.set(k, { avg: Math.round(sum / n), n, deals: list.length, pairs: new Set(list.map((r, i) => r.pair || `#${i}`)).size }); // ohne Paar: jeder Verkauf eigen
  };
  for (const [key, list] of byKey) {
    const cap = median(list.map((r) => r.unit)) * OUTLIER_FACTOR;
    const clean = list.filter((r) => r.unit <= cap);
    add(key, clean);
    const codes = new Map();
    for (const r of clean.filter((x) => x.code)) {
      if (!codes.has(r.code)) codes.set(r.code, []);
      codes.get(r.code).push(r);
    }
    for (const [code, l] of codes) add(`${key}#${code}`, l);
  }
  return out;
}

/** Gilt dieser Eintrag als gemessener Marktpreis? (genug verschiedene Handelspaare) */
const measured = (p) => !!p && (p.pairs == null || p.pairs >= MIN_PAIRS);

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
  const deviceLogic = require('../device/deviceLogic');
  const [trades, flagged] = await Promise.all([
    Trade.find({ status: 'verkauft', closedAt: { $gte: since }, 'priceRef.key': { $type: 'string' } }).select('seller buyer to priceRef').lean(),
    require('../device/deviceService').flaggedPairs(),
  ]);
  const rows = trades.map((t) => ({ ...t.priceRef, pair: deviceLogic.pairKey(t.seller, t.buyer || t.to) }));
  const map = aggregate(rows, flagged);
  cache = { at: now, map };
  return map;
}

// ---------- Schätzung (Etappe C) ----------
const MIN_RATIO_SALES = 3; // Verhältnis Markt/Händler einer Seltenheit erst ab so vielen verkauften Stück
// Startwerte Marktpreis/Händlerpreis je Seltenheit (ohne Folie), solange eigene Daten fehlen. Gold, Holo und Bockhaber
// aus dem Gesamtprotokoll 07.–10.10.2026 (Median sauberer Verkäufe: Gold 2,5×, Holo 3×, Bockhaber 1,8×); die übrigen
// abgeleitet – je seltener und teurer, desto näher am Händlerpreis.
const RARITY_RATIO = { crumpled: 2.5, bfwler: 2.5, gold: 2.4, holo: 3, bockhaber: 1.8, glitch: 1.4, icon: 1.2, sith: 1.1, boss: 1 };
// Zustand gegenüber „ohne Folie“
const STATE_FACTOR = { lose: 1, beschaedigt: 0.75, folie: 1 };
const DEFAULT_RATIO = STATE_FACTOR; // ältere Bezeichnung (Tests, Aufrufer)
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
    if (!STATE_FACTOR[state]) continue;
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
  const ratio = (ctx.ratios && ctx.ratios.get(`${rarity}|${base}`)) || (RARITY_RATIO[rarity] || 1) * (STATE_FACTOR[base] || 1);
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
  const raw = prices && prices.get(key);
  const p = measured(raw) ? raw : null; // zu wenige Handelspaare: geschätzt
  const code = slabCodeOf(list[0]);
  const sameCode = code && list.every((l) => slabCodeOf(l) === code);
  const rawCode = sameCode && prices ? prices.get(`${key}#${code}`) : null;
  const pc = measured(rawCode) ? rawCode : null;
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
  const [prices, pop, shops] = await Promise.all([all(), population.all(), GradingShop.find({ code: { $type: 'string' } }).select('code codeHistory hits').lean()]);
  // frühere Kürzel eines Shops (ältere Slabs) bekommen dasselbe Vertrauen
  const trust = new Map(shops.flatMap((s) => [s.code, ...(s.codeHistory || [])].map((c) => [c, trustOf(s.hits)])));
  return { prices, ratios: ratiosFrom(prices), population: pop, trust };
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

module.exports = { DAYS, FLOOR_SHARE, OUTLIER_FACTOR, MIN_PAIRS, RARITY_RATIO, STATE_FACTOR, aggregate, measured, GRADE_FACTOR, DEFAULT_RATIO, stateKey, keyOf, slabCodeOf, stateText, priceRefOf, invalidate, all, ratiosFrom, trustOf, estimate, summary, context, copySales };
