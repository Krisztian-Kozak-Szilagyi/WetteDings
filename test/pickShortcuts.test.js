process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { pickShortcuts } = require('../src/lib/pickShortcuts');

const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({ id }));

test('Favoriten stehen vorn, die übrige Reihenfolge bleibt; häufig Verwendete entfallen dann', () => {
  const sc = pickShortcuts(list, ['d', 'b', 'x', 'f:123'], ['a', 'c']);
  assert.deepEqual(sc.list.map((c) => c.id), ['b', 'd', 'a', 'c', 'e', 'f', 'g', 'h']);
  assert.deepEqual([...sc.favs], ['b', 'd']);
  assert.equal(sc.freq.size, 0);
});

test('Ohne Favoriten: häufigste Karten aus der Liste, höchstens sechs, Liste unverändert', () => {
  const sc = pickShortcuts(list, [], ['z', 'c', 'a', 'h', 'b', 'd', 'e', 'f', 'g']);
  assert.equal(sc.favs.size, 0);
  assert.deepEqual(sc.list, list);
  assert.deepEqual([...sc.freq.keys()], ['c', 'a', 'h', 'b', 'd', 'e']);
  assert.equal(sc.freq.get('c'), 0);
});

test('Ohne Favoriten und ohne Verlauf: nichts hervorgehoben', () => {
  const sc = pickShortcuts(list, undefined, undefined);
  assert.equal(sc.favs.size + sc.freq.size, 0);
  assert.deepEqual(sc.list, list);
});
