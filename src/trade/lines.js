// Positionen eines Handelsangebots (#76): Jede Seite gibt beliebig viele Karten oder Gegenstände, dazu fließt
// Geld in eine Richtung. Reine Helfer ohne Datenbank – genutzt von Handel, Protokollen, Statistik und Ansichten.
//
// Trade.give = was der Anbieter (seller) gibt, Trade.want = was er vom Empfänger (to) bekommt.
// Position: { card, copy, doc, foiledAt, grade }
//   card – Karten-ID oder "item:<Art>"
//   copy – ein bestimmtes foliertes Exemplar, das verlangt wird
//   doc  – das gesperrte Exemplar; gesetzt, sobald der Besitzer die Position selbst zugesagt hat
// Geld: price (Cent) zahlt extraFrom ('seller' | 'to'); ohne Angabe zahlt der Empfänger bzw. Käufer.
const catalog = require('../tcg/catalog');
const { euro } = require('../lib/viewHelpers');

const ITEM_PREFIX = 'item:';
const isItemId = (id) => typeof id === 'string' && id.startsWith(ITEM_PREFIX);
const otherRole = (role) => (role === 'seller' ? 'to' : 'seller');

/** Name einer Karte oder eines Gegenstands (itemService erst hier laden – es braucht selbst diese Datei) */
function cardName(id) {
  if (isItemId(id)) {
    const item = require('../items/itemService').itemByCardId(id);
    return item ? item.label : id;
  }
  return catalog.cardById[id] ? catalog.cardById[id].name : id;
}

/** Positionen einer Seite: 'seller' gibt give, 'to' gibt want */
const linesOf = (t, role) => (role === 'seller' ? t.give : t.want) || [];

/** Wer zahlt das Geld? 'seller' | 'to' | null (kein Geld) */
const payerRole = (t) => (t.price > 0 ? t.extraFrom || 'to' : null);

/**
 * Ein Angebot aus Sicht einer Rolle: was gebe ich, was bekomme ich, wie viel zahle bzw. erhalte ich (brutto).
 * Bei einem Markt-Angebot sieht ein Interessent es als 'to'.
 */
function perspective(t, role) {
  const payer = payerRole(t);
  return {
    gives: linesOf(t, role),
    gets: linesOf(t, otherRole(role)),
    pay: payer === role ? t.price : 0,
    receive: payer && payer !== role ? t.price : 0,
  };
}

/**
 * Kategorie für Steuer, Anzeige und Statistik: Karten auf beiden Seiten = Tausch, Markt-Angebot
 * (ohne Empfänger) oder Gegenangebot darauf = Markt, sonst privat (Verkauf oder Kaufanfrage)
 */
function kindOf({ give, want, to, listing }) {
  if ((give || []).length && (want || []).length) return 'tausch';
  if (listing || !to) return 'markt';
  return 'privat';
}

/**
 * Exemplare, die dieses Angebot sperrt: alle zugesagten Positionen – außer bei einem Gegenangebot auf ein
 * Markt-Angebot die Karten des Verkäufers, die sperrt schon das Markt-Angebot selbst.
 */
function lockDocsOf({ give, want, listing }) {
  return [...(listing ? [] : give || []), ...(want || [])].filter((l) => l.doc).map((l) => l.doc);
}

/** Von diesem Angebot gesperrte Exemplare, die dem Nutzer gehören (seine Seite) */
function lockedFor(t, userId) {
  const locks = new Set((t.lockDocs || []).map(String));
  const role = String(t.seller) === String(userId) ? 'seller' : t.to && String(t.to) === String(userId) ? 'to' : null;
  if (!role) return [];
  return linesOf(t, role).filter((l) => l.doc && locks.has(String(l.doc))).map((l) => l.doc);
}

/** Alle Karten-IDs beider Seiten (z. B. für die Suche im Protokoll) */
const cardIds = (t) => [...(t.give || []), ...(t.want || [])].map((l) => l.card);

/** Positionen als Text, gleiche Karten zusammengefasst: "2× Aleks (Gold), Luca (Holo, foliert)" – die Seltenheit unterscheidet gleichnamige Karten */
function lineLabel(lines) {
  const groups = new Map();
  for (const l of lines || []) {
    const key = l.card + (l.foiledAt ? ':f' : '');
    const c = catalog.cardById[l.card];
    const r = c && catalog.rarityByKey[c.rarity];
    const extra = [r && r.label, l.foiledAt && 'foliert'].filter(Boolean).join(', ');
    const g = groups.get(key) || { name: cardName(l.card) + (extra ? ` (${extra})` : ''), n: 0 };
    g.n += 1;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => (g.n > 1 ? `${g.n}× ${g.name}` : g.name)).join(', ');
}

/** Eine Seite als Text mit Geld: "Aleks + 5,00 €", "25,00 €" oder "nichts" */
function sideText(lines, cents) {
  const parts = [lineLabel(lines), cents > 0 ? euro(cents) : ''].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'nichts';
}

/** Ganzes Angebot als Satz: "anna gibt Aleks, ben gibt Luca + 5,00 €" (ohne Empfänger: "der Käufer") */
function termsText(t) {
  const payer = payerRole(t);
  const seller = sideText(t.give, payer === 'seller' ? t.price : 0);
  const to = sideText(t.want, payer === 'to' ? t.price : 0);
  return `${t.sellerName} gibt ${seller}, ${t.toName || 'der Käufer'} gibt ${to}`;
}

/** Zahl der Karten bzw. Gegenstände als Wort: "1 Karte", "3 Karten" */
const countText = (lines) => `${lines.length} ${lines.length === 1 ? 'Karte' : 'Karten'}`;

/**
 * Altes Angebot in Positionen umwandeln – zwei Vorformen: eine Karte (card, optional wantCard) und der Tausch
 * mit give/take aus der ersten Umsetzung von #76 (cardDoc dort nur Platzhalter, beim Tausch nichts gesperrt,
 * bewegte Exemplare in giveDocs/takeDocs). Erkennbar am Feld card, das es im neuen Format nicht mehr gibt.
 * Gibt das Update für die Migration zurück – oder null, wenn das Angebot schon umgestellt ist.
 */
function migrateTradeDoc(old) {
  if (!old.card) return null;
  const unset = { card: 1, cardDoc: 1, foiledAt: 1, grade: 1, wantCard: 1, wantCopy: 1, wantCardDoc: 1, wantFoiledAt: 1, wantGrade: 1, take: 1, giveDocs: 1, takeDocs: 1 };
  if (Array.isArray(old.take)) {
    const line = (docs) => (l, i) => ({ card: l.card, copy: l.copy || null, doc: (docs && docs[i]) || null, foiledAt: l.foiledAt || null, grade: l.grade == null ? null : l.grade });
    const $set = { give: (old.give || []).map(line(old.giveDocs)), want: old.take.map(line(old.takeDocs)) };
    if (old.status === 'verkauft' && !old.buyer && old.to) $set.buyer = old.to;
    return { $set, $unset: unset }; // nichts war gesperrt – belegt wird beim Annehmen
  }
  const give = [{ card: old.card, copy: null, doc: old.cardDoc || null, foiledAt: old.foiledAt || null, grade: old.grade == null ? null : old.grade }];
  const want = old.kind === 'tausch' && old.wantCard
    ? [{ card: old.wantCard, copy: old.wantCopy || null, doc: old.wantCardDoc || null, foiledAt: old.wantFoiledAt || null, grade: old.wantGrade == null ? null : old.wantGrade }]
    : [];
  const $set = { give, want };
  // Verkauf: Geld kommt immer vom Käufer bzw. Empfänger
  if (old.kind !== 'tausch' && old.price > 0) $set.extraFrom = 'to';
  // Bei alten Tauschen war nur die Karte des Anbieters gesperrt
  if (old.status === 'offen' && old.cardDoc) $set.lockDocs = [old.cardDoc];
  // Beim Verkauf ist der Empfänger bzw. Käufer die Gegenseite (Tausch hatte buyer schon = to)
  if (old.status === 'verkauft' && !old.buyer && old.to) $set.buyer = old.to;
  return { $set, $unset: unset };
}

module.exports = {
  ITEM_PREFIX,
  isItemId,
  otherRole,
  cardName,
  linesOf,
  payerRole,
  perspective,
  kindOf,
  lockDocsOf,
  lockedFor,
  cardIds,
  lineLabel,
  sideText,
  termsText,
  countText,
  migrateTradeDoc,
};
