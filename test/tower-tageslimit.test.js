process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const tower = require('../src/dungeon/tower');
const d = require('../src/dungeon/dungeonService');

test('Mage Tower: Kontingent pro Tag – eSports-Läufe zählen mit (gemeinsames Kontingent)', () => {
  const opts = { dailyRuns: 2, esportsRuns: 1 };
  assert.deepEqual(tower.towerQuota(undefined, opts), { left: 2, esportsLeft: 1 });
  assert.deepEqual(tower.towerQuota({ total: 1, esports: 1 }, opts), { left: 1, esportsLeft: 0 });
  assert.deepEqual(tower.towerQuota({ total: 1, esports: 0 }, opts), { left: 1, esportsLeft: 1 });
  assert.deepEqual(tower.towerQuota({ total: 2, esports: 0 }, opts), { left: 0, esportsLeft: 0 });
  // mehr eSports erlaubt als Läufe insgesamt: begrenzt durch die Läufe
  assert.deepEqual(tower.towerQuota({ total: 0, esports: 0 }, { dailyRuns: 1, esportsRuns: 3 }), { left: 1, esportsLeft: 1 });
});

test('Mage Tower: Standard bleibt ein Lauf pro Tag, Grenzen 1–10', () => {
  assert.equal(d.DEFAULTS.tower.dailyRuns, 1);
  assert.equal(d.DEFAULTS.tower.esportsRuns, 1);
});

test('Mage Tower: mindestens sechs Stockwerke je Wert, eindeutige Schlüssel', () => {
  const keys = tower.TOWER.floors.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const stat of ['fia', 'fis', 'bwl']) assert.ok(tower.TOWER.floors.filter((f) => f.stat === stat).length >= 6, stat);
});

test('Mage Tower: Stockwerk-Texte – nur Abweichungen, leer = Standard, unbekannte Schlüssel ignoriert', () => {
  const key = tower.TOWER.floors[0].key;
  const def = tower.FLOOR_DEFAULTS[key];
  const { texts } = tower.cleanFloorTexts({ [key]: { title: '  Neuer   Name ', text: def.text, success: '' }, unbekannt: { title: 'x' }, __proto__: { title: 'y' } });
  assert.deepEqual(texts, { [key]: { title: 'Neuer Name' } });
  assert.match(tower.cleanFloorTexts({ [key]: { title: 'x'.repeat(81) } }).error, /höchstens 80 Zeichen/);
  assert.deepEqual(tower.cleanFloorTexts(null).texts, {});

  tower.applyFloorTexts(texts);
  assert.equal(tower.floorByKey[key].title, 'Neuer Name');
  assert.equal(tower.floorByKey[key].text, def.text);
  tower.applyFloorTexts({});
  assert.equal(tower.floorByKey[key].title, def.title);
});
