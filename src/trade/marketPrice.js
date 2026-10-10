// Ø-Marktpreis (#204): Was Karten wert sind, bestimmen die Spieler. Gezählt werden nur saubere Verkäufe – eine Seite
// gibt nur Karten derselben Art im selben Zustand, die andere zahlt nur Geld. Daraus ergibt sich ein Stückpreis.
// Tausche, Pakete aus verschiedenen Karten und Gegenstände zählen nicht (dort lässt sich kein Einzelpreis ablesen).
// Der Schlüssel wird beim Abschluss am Angebot gespeichert (Trade.priceRef), gerechnet wird über die letzten DAYS Tage.
const { Trade } = require('../models/Trade');
const { isItemId, payerRole } = require('./lines');

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
  return { key, n: side.length, unit: Math.floor(t.price / side.length) };
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
    { $group: { _id: '$priceRef.key', sum: { $sum: { $multiply: ['$priceRef.unit', '$priceRef.n'] } }, n: { $sum: '$priceRef.n' }, deals: { $sum: 1 } } },
  ]);
  const map = new Map(rows.map((r) => [r._id, { avg: Math.round(r.sum / r.n), n: r.n, deals: r.deals }]));
  cache = { at: now, map };
  return map;
}

/**
 * Ø-Preis für Positionen einer Seite, wenn alle denselben Schlüssel haben: { key, state, avg, n, deals, count }
 * (count = Stück in dieser Seite) – avg null, wenn es noch keinen Verkauf gab. Gemischte Seiten: null.
 */
function summary(lines, prices) {
  const list = (lines || []).filter((l) => !isItemId(l.card));
  if (!list.length || list.length !== (lines || []).length) return null;
  const key = keyOf(list[0]);
  if (list.some((l) => keyOf(l) !== key)) return null;
  const p = prices && prices.get(key);
  return { key, state: stateKey(list[0]), avg: p ? p.avg : null, n: p ? p.n : 0, deals: p ? p.deals : 0, count: list.length };
}

module.exports = { DAYS, stateKey, keyOf, stateText, priceRefOf, invalidate, all, summary };
