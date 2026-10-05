const test = require('node:test');
const assert = require('node:assert');
const deck = require('../src/game/deck');

const cards = {
  a: { id: 'a', rarity: 'crumpled' },
  b: { id: 'b', rarity: 'holo' },
  boss: { id: 'boss', rarity: 'boss' },
  alt: { id: 'alt', rarity: 'gold' }, // alte Sammelkarte ohne Kampfwerte – darf auch ins Deck
};
const many = (id, n) => Array(n).fill(id);
// 15 verschiedene Karten, je 2 = 30
const full = Object.fromEntries(Array.from({ length: 15 }, (_, i) => ['k' + i, { id: 'k' + i, rarity: 'gold' }]));
const fullIds = Object.keys(full).flatMap((id) => many(id, 2));
const fullOwned = Object.fromEntries(Object.keys(full).map((id) => [id, 2]));

test('Regeln: 30 Karten, 2 gleiche, Boss 1, ein Deck', () => {
  assert.strictEqual(deck.DECK_SIZE, 30);
  assert.strictEqual(deck.MAX_COPIES, 2);
  assert.strictEqual(deck.MAX_DECKS, 1);
  assert.strictEqual(deck.copyLimit(cards.a), 2);
  assert.strictEqual(deck.copyLimit(cards.boss), 1);
});

test('alle Karten dürfen ins Deck, auch ohne Kampfwerte', () => {
  assert.deepStrictEqual(deck.validateDeck(['alt', 'a'], cards, { alt: 1, a: 1 }).errors, []);
});

test('volles, regelkonformes Deck ist spielbereit', () => {
  const r = deck.validateDeck(fullIds, full, fullOwned);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.size, 30);
  assert.ok(r.complete && r.playable);
});

test('unvollständiges Deck: kein Fehler, aber nicht spielbereit', () => {
  const r = deck.validateDeck(['a', 'b'], cards, { a: 1, b: 1 });
  assert.deepStrictEqual(r.errors, []);
  assert.ok(!r.complete && !r.playable);
});

test('Verstöße: zu viele gleiche, Boss doppelt, unbekannt, über 30', () => {
  const codes = (ids, c = cards) => deck.validateDeck(ids, c, { a: 9, b: 9, boss: 9, alt: 9 }).errors.map((e) => e.code + ':' + (e.card || ''));
  assert.deepStrictEqual(codes(many('a', 3)), ['zuViele:a']);
  assert.deepStrictEqual(codes(many('boss', 2)), ['zuViele:boss']);
  assert.deepStrictEqual(codes(['gibtsnicht']), ['unbekannt:gibtsnicht']);
  assert.deepStrictEqual(codes(['__proto__']), ['unbekannt:__proto__']);
  assert.deepStrictEqual(codes([...fullIds, 'k0'], full).sort(), ['zuGross:', 'zuViele:k0']);
});

test('Karten, die man nicht (mehr) besitzt, fehlen – Deck nicht spielbereit', () => {
  const r = deck.validateDeck(fullIds, full, { ...fullOwned, k3: 1 });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.missing, [{ card: 'k3', n: 1 }]);
  assert.ok(r.complete && !r.playable);
});

test('Zählen und Ausklappen sind umkehrbar', () => {
  const ids = ['a', 'b', 'a', 'boss'];
  const counted = deck.countCards(ids);
  assert.deepStrictEqual(counted, [{ card: 'a', n: 2 }, { card: 'b', n: 1 }, { card: 'boss', n: 1 }]);
  assert.deepStrictEqual(deck.expand(counted), ['a', 'a', 'b', 'boss']);
});

test('Deckname wird gesäubert', () => {
  assert.strictEqual(deck.cleanName('  Mein   tolles Deck '), 'Mein tolles Deck');
  assert.strictEqual(deck.cleanName(''), 'Mein Deck');
  assert.strictEqual(deck.cleanName('x'.repeat(50)).length, 30);
});
