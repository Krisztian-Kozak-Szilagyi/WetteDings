// Deckbau-Regeln – reine Logik ohne Datenbank/Express (wie coin/model.js), damit sie später auch im
// eigenständigen Spiel (Steam) unverändert laufen. Speichern und Sammlung: src/game/deckService.js.
//
// Regeln (Krisztian, 2026-10-05): genau 30 Karten, höchstens 2 gleiche, Boss-Karten nur 1-mal,
// alle Karten erlaubt, aber nur aus eigenen Exemplaren.
// Eigene Exemplare werden NICHT gesperrt: Wer eine Karte verkauft, hat danach ein unvollständiges Deck.

const DECK_SIZE = 30;
const MAX_COPIES = 2;
// Seltenheiten, von denen nur 1 Exemplar ins Deck darf
const SINGLE_RARITIES = ['boss'];
// Decks pro Spieler – vorerst eins, Datenmodell und API können schon mehrere
const MAX_DECKS = 1;
const NAME_MAX = 30;

const RULES = { deckSize: DECK_SIZE, maxCopies: MAX_COPIES, singleRarities: SINGLE_RARITIES, maxDecks: MAX_DECKS, nameMax: NAME_MAX };

/** Wie oft darf diese Karte ins Deck? */
const copyLimit = (card) => (card && SINGLE_RARITIES.includes(card.rarity) ? 1 : MAX_COPIES);

/** Kartenliste (IDs, Wiederholung = mehrere Exemplare) -> [{ card, n }] in Reihenfolge des ersten Auftretens */
function countCards(ids) {
  const map = new Map();
  for (const id of ids || []) map.set(id, (map.get(id) || 0) + 1);
  return [...map].map(([card, n]) => ({ card, n }));
}

/** [{ card, n }] -> flache ID-Liste */
const expand = (entries) => (entries || []).flatMap((e) => Array(Math.max(0, e.n | 0)).fill(e.card));

/** Deckname säubern: Leerraum zusammenfassen, kürzen; leer -> Standardname */
function cleanName(name, fallback = 'Mein Deck') {
  const s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || fallback;
}

/**
 * Prüft ein Deck.
 *   ids:    Karten-IDs (Wiederholung = mehrere Exemplare)
 *   cards:  { id: Karte } (catalog.cardById)
 *   owned:  { id: Anzahl eigener Exemplare }
 * Ergebnis: { size, complete, playable, errors: [{ code, card?, n?, max? }] }
 *   errors  = Verstöße, die das Speichern verhindern (unbekannt, zu viele gleiche, mehr als 30)
 *   missing = Karten, die (nicht mehr) in der Sammlung sind – Deck bleibt gespeichert, ist aber nicht spielbereit
 */
function validateDeck(ids, cards, owned = {}) {
  const errors = [];
  const missing = [];
  const entries = countCards(ids);
  const size = entries.reduce((s, e) => s + e.n, 0);
  for (const { card: id, n } of entries) {
    const card = Object.prototype.hasOwnProperty.call(cards, id) ? cards[id] : null;
    if (!card) {
      errors.push({ code: 'unbekannt', card: id });
      continue;
    }
    const max = copyLimit(card);
    if (n > max) errors.push({ code: 'zuViele', card: id, n, max });
    const have = owned[id] || 0;
    if (n > have) missing.push({ card: id, n: n - have });
  }
  if (size > DECK_SIZE) errors.push({ code: 'zuGross', n: size, max: DECK_SIZE });
  const complete = size === DECK_SIZE;
  return { size, complete, errors, missing, playable: complete && !errors.length && !missing.length };
}

module.exports = { RULES, DECK_SIZE, MAX_COPIES, SINGLE_RARITIES, MAX_DECKS, NAME_MAX, copyLimit, countCards, expand, cleanName, validateDeck };
