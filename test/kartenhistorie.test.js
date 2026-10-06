// Kartenhistorie: Herkunft erschließen, Zeitleiste mit Haltezeiten, Exemplar-IDs beim Bank-Verkauf
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { matchOrigin, timeline, durationText } = require('../src/moderation/cardHistory');
const { soldMeta } = require('../src/tcg/tcgService');
const { dungeonByKey } = require('../src/dungeon/dungeons');

const t0 = Date.UTC(2026, 9, 5, 10, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const at = (ms) => new Date(t0 + ms);

test('Zeitleiste: nach Zeit geordnet, Haltezeit je Besitzerwechsel, Besitzer am Ende', () => {
  const events = [
    { at: at(52 * HOUR), type: 'handel', from: 'c', to: 'a' },
    { at: at(0), type: 'entstanden', order: -1, who: 'a' },
    { at: at(26 * HOUR), type: 'handel', from: 'b', to: 'c' },
    { at: at(2 * HOUR), type: 'handel', from: 'a', to: 'b' },
    { at: at(10 * HOUR), type: 'ihk', who: 'b' },
  ];
  const { events: list, owner, ownerSince } = timeline(events, 'a');
  assert.deepEqual(list.map((e) => e.type), ['entstanden', 'handel', 'ihk', 'handel', 'handel']);
  assert.deepEqual(list.filter((e) => e.to).map((e) => e.heldMs / HOUR), [2, 24, 26]);
  assert.equal(owner, 'a');
  assert.equal(ownerSince, t0 + 52 * HOUR);
  // Karte weg: kein Besitzer
  assert.equal(timeline(events, 'a', { gone: true }).owner, null);
  // Lücke in der Kette (Abgebender war nicht der bekannte Besitzer): keine Haltezeit erfinden
  const odd = timeline([{ at: at(0), type: 'handel', from: 'x', to: 'y' }], 'a');
  assert.equal(odd.events[0].heldMs, null);
  // Entstehung unbekannt: für den ersten Besitzer keine Haltezeit, danach schon
  const noOrigin = timeline([{ at: at(0), type: 'handel', from: 'a', to: 'b' }, { at: at(3 * HOUR), type: 'handel', from: 'b', to: 'c' }], 'a');
  assert.deepEqual(noOrigin.events.map((e) => e.heldMs), [null, 3 * HOUR]);
});

test('Herkunft: Vergabe, Boss-Beute, Black Market – gleiche Karte, gleicher Besitzer, fast gleiche Zeit', () => {
  const copy = { card: 'oliver-the-sigrist-sith', createdAt: at(0) };
  const grant = { type: 'oliver-the-sigrist-sith', to: 'a', all: false, byName: 'admin', reason: 'Gewinnspiel', createdAt: at(30 * 1000) };
  assert.match(matchOrigin(copy, 'a', { grants: [grant] }).text, /Vom Team vergeben \(admin\): Gewinnspiel/);
  // andere Person, andere Karte oder zu weit weg: keine Vergabe
  assert.equal(matchOrigin(copy, 'b', { grants: [grant] }), null);
  assert.equal(matchOrigin(copy, 'a', { grants: [{ ...grant, type: 'x' }] }), null);
  assert.equal(matchOrigin(copy, 'a', { grants: [{ ...grant, createdAt: at(HOUR) }] }), null);
  // Vergabe "an alle"
  assert.ok(matchOrigin(copy, 'z', { grants: [{ ...grant, to: null, all: true }] }));

  const [key, d] = Object.entries(dungeonByKey).find(([, x]) => x.bossCard) || [];
  if (key) {
    const boss = { card: d.bossCard, createdAt: at(0) };
    const run = { dungeon: key, endsAt: at(-2 * MIN), updatedAt: at(MIN), members: [{ user: 'a', bossCard: true }, { user: 'b', bossCard: false }] };
    assert.match(matchOrigin(boss, 'a', { dungeons: [run] }).text, /Boss-Beute/);
    assert.equal(matchOrigin(boss, 'b', { dungeons: [run] }), null);
  }

  const market = { offers: [{ card: 'oliver-the-sigrist-sith', buyer: 'a', price: 1700000, soldAt: at(10 * 1000) }] };
  assert.match(matchOrigin(copy, 'a', { markets: [market] }).text, /Black Market gekauft für 17\.000,00\s€/);
  assert.equal(matchOrigin(copy, 'a', {}), null);
});

test('Dauer als Text', () => {
  assert.equal(durationText(30 * MIN), '30 Min.');
  assert.equal(durationText(26 * HOUR), '26 Std.');
  assert.equal(durationText(5 * 24 * HOUR), '5 Tage');
  assert.equal(durationText(null), '');
});

test('Bank-Verkauf merkt sich die Exemplare (für die Kartenhistorie)', () => {
  const meta = soldMeta([{ _id: 'x1', card: 'a', rarity: 'gold' }, { _id: 'x2', card: 'a', rarity: 'gold' }]);
  assert.deepEqual(meta, { cards: [{ card: 'a', rarity: 'gold', count: 2 }], docs: [{ doc: 'x1', card: 'a' }, { doc: 'x2', card: 'a' }] });
});
