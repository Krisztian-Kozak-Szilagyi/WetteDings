process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { CHANCE, chanceFor, rollDamage, shortfall, ihkSeverity, dungeonSeverity, damageCards, damageText } = require('../src/grading/damage');

test('#204: Schaden – je schwerer verloren, desto wahrscheinlicher; immer in den Grenzen', () => {
  for (const kind of ['kratzer', 'knick']) {
    assert.equal(chanceFor(kind, 0), CHANCE[kind][0]);
    assert.equal(chanceFor(kind, 1), CHANCE[kind][1]);
    assert.equal(chanceFor(kind, 5), CHANCE[kind][1]); // geklemmt
    assert.equal(chanceFor(kind, NaN), CHANCE[kind][0]);
    assert.ok(chanceFor(kind, 0.3) < chanceFor(kind, 0.7));
  }
  assert.ok(CHANCE.knick[1] < CHANCE.kratzer[0], 'ein Knick bleibt selten');
});

test('#204: ein Wurf – erst der Knick, dann der Kratzer, sonst nichts', () => {
  const k = chanceFor('knick', 1);
  assert.equal(rollDamage(1, 0), 'knick');
  assert.equal(rollDamage(1, k - 1e-9), 'knick');
  assert.equal(rollDamage(1, k), 'kratzer');
  assert.equal(rollDamage(1, k + chanceFor('kratzer', 1) - 1e-9), 'kratzer');
  assert.equal(rollDamage(1, k + chanceFor('kratzer', 1)), null);
  assert.equal(rollDamage(0, 0.5), null);
  // Verteilung: im Mittel etwa die Summe der Chancen
  let n = 0;
  for (let i = 0; i < 20000; i++) if (rollDamage(0.5)) n += 1;
  const want = chanceFor('knick', 0.5) + chanceFor('kratzer', 0.5);
  assert.ok(Math.abs(n / 20000 - want) < 0.02, `${n / 20000} ≈ ${want}`);
});

test('#204: Schwere – wie weit unter dem Ziel, Hybrid zählt der schwächere Balken', () => {
  assert.equal(shortfall(50, 100), 0.5);
  assert.equal(shortfall(150, 100), 0);
  assert.equal(shortfall(-5, 100), 1);
  assert.equal(shortfall(undefined, 100), 0.5);
  assert.equal(ihkSeverity({ success: true, total: 0, required: 100 }), 0);
  assert.ok(Math.abs(ihkSeverity({ success: false, total: 80, required: 100 }) - 0.2) < 1e-9);
  assert.ok(Math.abs(ihkSeverity({ success: false, total: 120, total2: 30, required: 100 }) - 0.7) < 1e-9);
  assert.equal(ihkSeverity({ success: false, required: 100 }), 0.5);
  assert.equal(dungeonSeverity({ success: true, fights: [] }), 0);
  assert.equal(dungeonSeverity({ success: false, fights: [{ success: true, total: 90, required: 50 }, { success: false, total: 25, required: 100 }] }), 0.75);
  assert.equal(dungeonSeverity({ success: false, fights: [] }), 0.5);
});

test('#204: ohne Niederlage oder ohne Karten wird nichts geladen', async () => {
  assert.deepEqual(await damageCards({ userId: 'x', docs: [null], severity: 1 }), []);
  assert.deepEqual(await damageCards({ userId: 'x', docs: ['a'], severity: 0 }), []);
});

test('#204: Meldung nennt jede beschädigte Karte und erinnert an die Folie', () => {
  const name = (id) => ({ a: 'St. Ivan', b: 'Kaffee' })[id];
  assert.equal(damageText([], name, 'IHK'), null);
  assert.equal(damageText([{ card: 'a', kind: 'kratzer' }], name, 'IHK'), 'IHK: Deine Karte hat etwas abbekommen – „St. Ivan“ einen Kratzer. Folierte Karten sind geschützt.');
  assert.equal(
    damageText([{ card: 'a', kind: 'knick' }, { card: 'b', kind: 'kratzer' }], name, 'Mage Tower'),
    'Mage Tower: Deine Karten haben etwas abbekommen – „St. Ivan“ einen Knick und „Kaffee“ einen Kratzer. Folierte Karten sind geschützt.'
  );
});
