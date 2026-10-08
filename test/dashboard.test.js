process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const dash = require('../src/services/dashboardService');

test('Dashboard: Tage zurückrechnen (auch über Monats- und Jahresgrenzen)', () => {
  assert.equal(dash.dayBefore('2026-10-04', 6), '2026-09-28');
  assert.equal(dash.dayBefore('2026-01-01', 1), '2025-12-31');
  assert.equal(dash.dayBefore('2026-03-01', 1), '2026-02-28');
});

test('Dashboard: Kurve skaliert zwischen Minimum und Maximum', () => {
  assert.equal(dash.curve([5]), null);
  assert.equal(dash.curve([]), null);
  const c = dash.curve([100, 300, 200], 100, 40, 0);
  assert.equal(c.line, 'M0.0,40.0 L50.0,0.0 L100.0,20.0');
  assert.match(c.area, /L100,40 L0,40 Z$/);
  assert.deepEqual([c.min, c.max], [100, 300]);
  // gleichbleibende Werte: flache Linie ohne Division durch null
  assert.equal(dash.curve([7, 7], 10, 10, 0).line, 'M0.0,10.0 L10.0,10.0');
});

test('Dashboard: Veränderung über den Zeitraum', () => {
  assert.equal(dash.change([1]), null);
  assert.deepEqual(dash.change([10000, 12500]), { diff: 2500, pct: 0.25 });
  assert.deepEqual(dash.change([0, 500]), { diff: 500, pct: null });
});

test('Dashboard: Gruß nach deutscher Uhrzeit', () => {
  assert.equal(dash.greeting(new Date('2026-10-04T06:00:00Z')), 'Guten Morgen'); // 08:00 MESZ
  assert.equal(dash.greeting(new Date('2026-10-04T12:00:00Z')), 'Guten Tag');
  assert.equal(dash.greeting(new Date('2026-10-04T19:00:00Z')), 'Guten Abend');
  assert.equal(dash.greeting(new Date('2026-10-04T01:00:00Z')), 'Gute Nacht');
});

test('Dashboard: Termine sortiert, vergangene fallen weg', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const at = (h) => new Date(now + h * 3600000);
  const list = dash.upcoming([{ key: 'b', at: at(5) }, { key: 'old', at: at(-1) }, { key: 'a', at: at(1) }, null], now);
  assert.deepEqual(list.map((e) => e.key), ['a', 'b']);
});

test('Dashboard: Album-Fächer zeigt die seltensten eigenen Karten, sonst Beispielkarten, nie geheime', () => {
  const rar = { gold: { rank: 2 }, holo: { rank: 3 }, glitch: { rank: 5 }, sith: { rank: 7, hidden: true }, crumpled: { rank: 0 } };
  const cards = [
    { id: 'a', rarity: 'crumpled' },
    { id: 'b', rarity: 'gold' },
    { id: 'c', rarity: 'holo' },
    { id: 'd', rarity: 'glitch' },
    { id: 's', rarity: 'sith' },
  ];
  assert.deepEqual(dash.albumFan(cards, { a: 1, b: 1, c: 2, d: 1, s: 1 }, rar).map((f) => f.card.id), ['d', 'c', 'b']);
  const empty = dash.albumFan(cards, {}, rar);
  assert.deepEqual(empty.map((f) => [f.card.id, f.sample]), [['b', true], ['d', true], ['c', true]]);
  assert.deepEqual(dash.albumFan(cards, { s: 1, a: 1 }, rar).map((f) => f.card.id), ['a', 'b', 'd']);
});

test('zufällige Favoriten: nur eigene, nicht folierte, keine geheimen, höchstens max, ohne Doppelte', () => {
  const byId = { a: { id: 'a', rarity: 'common' }, b: { id: 'b', rarity: 'holo' }, s: { id: 's', rarity: 'sith' }, c: { id: 'c', rarity: 'gold' } };
  const rar = { common: {}, holo: {}, gold: {}, sith: { hidden: true } };
  const plain = { a: 2, b: 1, s: 1, c: 0, x: 3 }; // c nur foliert, x gibt es nicht im Katalog
  const ids = dash.randomFavorites(plain, byId, rar, 4).map((f) => f.card.id).sort();
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(dash.randomFavorites(plain, byId, rar, 1).length, 1);
  assert.deepEqual(dash.randomFavorites({}, byId, rar, 4), []);
  assert.ok(dash.randomFavorites(plain, byId, rar, 4).every((f) => f.foiledAt === null));
});

test('Heute: ausgegraute Punkte (Tagesbonus während des Grading-Jobs bzw. Grading ohne Job) zählen nicht mit', () => {
  const items = [
    { key: 'bonus', done: false, off: true },
    { key: 'ihk', done: true },
    { key: 'grading', done: true },
    { key: 'dungeon', done: true },
    { key: 'lotto', done: true },
  ];
  assert.deepEqual({ done: dash.tally(items).done, total: dash.tally(items).total }, { done: 4, total: 4 });
  // umgekehrt: Tagesbonus bekommen, Grading ohne Job ausgegraut
  const other = items.map((i) => (i.key === 'bonus' ? { ...i, done: true, off: false } : i.key === 'grading' ? { ...i, done: false, off: true } : i));
  assert.deepEqual({ done: dash.tally(other).done, total: dash.tally(other).total }, { done: 4, total: 4 });
  // ein ausgegrauter Punkt, der als erledigt gilt, zählt trotzdem nicht
  assert.equal(dash.tally([{ done: true, off: true }, { done: false }]).done, 0);
  assert.equal(dash.tally([]).total, 0);
});
