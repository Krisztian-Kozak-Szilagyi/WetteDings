process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { computeDuelPayouts } = require('../src/lib/payout');
const catalog = require('../src/tcg/catalog');
const duels = require('../src/services/duelService');
const { euro } = require('../src/lib/viewHelpers');

// Beteiligte: A (o1) und B (o2); Zuschauer: z1 … z3
const pos = (id, user, side, amount) => ({ id, user, side, amount });

test('Duell: Beteiligte und Zuschauer haben getrennte Töpfe (#67)', () => {
  const positions = [pos('a', 'A', 'o1', 10000), pos('b', 'B', 'o2', 10000), pos('z1', 'Z1', 'o1', 3000), pos('z2', 'Z2', 'o2', 1000), pos('z3', 'Z3', 'o2', 1000)];
  const r = computeDuelPayouts(positions, 'o1', 3, ['A', 'B']);
  // Beteiligte: 200 € Topf, 3 % = 6 € an den Schiedsrichter, A bekommt 194 €
  assert.equal(r.payouts.get('a'), 19400);
  assert.equal(r.payouts.get('b'), 0);
  // Zuschauer: 50 € Topf, 3 % = 1,50 €, Z1 bekommt den Rest – nichts aus dem Topf der Beteiligten
  assert.equal(r.payouts.get('z1'), 4850);
  assert.equal(r.payouts.get('z2'), 0);
  assert.equal(r.fee, 600 + 150);
  assert.equal(r.refunded, false);
  // Summe bleibt erhalten
  const paid = [...r.payouts.values()].reduce((s, v) => s + v, 0);
  assert.equal(paid + r.fee, 25000);
});

test('Duell: Zuschauer-Topf ohne Gegenseite wird erstattet, Beteiligte spielen trotzdem', () => {
  const positions = [pos('a', 'A', 'o1', 5000), pos('b', 'B', 'o2', 5000), pos('z1', 'Z1', 'o2', 2000), pos('z2', 'Z2', 'o2', 1000)];
  const r = computeDuelPayouts(positions, 'o2', 3, ['A', 'B']);
  assert.equal(r.payouts.get('b'), 9700);
  assert.equal(r.payouts.get('z1'), 2000); // erstattet
  assert.equal(r.payouts.get('z2'), 1000);
  assert.ok(r.refundedIds.has('z1') && r.refundedIds.has('z2') && !r.refundedIds.has('b'));
  assert.equal(r.spectatorsRefunded, true);
  assert.equal(r.partyRefunded, false);
  assert.equal(r.fee, 300);
});

test('Duell nur um Karten (0 €): Geld-Töpfe bleiben leer, keine Provision', () => {
  const positions = [pos('a', 'A', 'o1', 0), pos('b', 'B', 'o2', 0)];
  const r = computeDuelPayouts(positions, 'o1', 3, ['A', 'B']);
  assert.equal(r.payouts.get('a'), 0);
  assert.equal(r.fee, 0);
  assert.equal(r.partyRefunded, true);
});

test('Duell annulliert: alle bekommen ihren Einsatz zurück', () => {
  const positions = [pos('a', 'A', 'o1', 5000), pos('b', 'B', 'o2', 5000), pos('z1', 'Z1', 'o1', 700)];
  const r = computeDuelPayouts(positions, 'annulliert', 3, ['A', 'B']);
  assert.deepEqual([...r.payouts.values()], [5000, 5000, 700]);
  assert.equal(r.refunded, true);
  assert.equal(r.fee, 0);
});

test('Duell-Karten: mindestens Gold (auch Boss), Geld 0 € nur mit Karte', () => {
  const byRarity = (r) => catalog.CARDS.find((c) => c.rarity === r);
  assert.equal(duels.cardAllowed(byRarity('crumpled')), false);
  assert.equal(duels.cardAllowed(byRarity('bfwler')), false);
  for (const r of ['gold', 'holo', 'bockhaber', 'glitch']) assert.equal(duels.cardAllowed(byRarity(r)), true, r);
  if (byRarity('boss')) assert.equal(duels.cardAllowed(byRarity('boss')), true);
  assert.equal(duels.cardAllowed(null), false);
  assert.throws(() => duels.checkStake(0, false), /Geld, eine Karte oder beides/);
  assert.doesNotThrow(() => duels.checkStake(0, true));
  assert.throws(() => duels.checkStake(1, true), /mindestens/);
  assert.doesNotThrow(() => duels.checkStake(5000, false));
  const gold = byRarity('gold');
  assert.equal(duels.stakeText(5000, { card: gold.id, rarity: 'gold' }), `${euro(5000)} und ${gold.name} (Gold)`);
});
