process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const dash = require('../src/services/dashboardService');

test('Startseite: Tage zurückrechnen (auch über Monats- und Jahresgrenzen)', () => {
  assert.equal(dash.dayBefore('2026-10-04', 6), '2026-09-28');
  assert.equal(dash.dayBefore('2026-01-01', 1), '2025-12-31');
  assert.equal(dash.dayBefore('2026-03-01', 1), '2026-02-28');
});

test('Startseite: Veränderung über den Zeitraum', () => {
  assert.equal(dash.change([1]), null);
  assert.deepEqual(dash.change([10000, 12500]), { diff: 2500, pct: 0.25 });
  assert.deepEqual(dash.change([0, 500]), { diff: 500, pct: null });
});

test('Startseite: Termine sortiert, vergangene fallen weg', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const at = (h) => new Date(now + h * 3600000);
  const list = dash.upcoming([{ key: 'b', at: at(5) }, { key: 'old', at: at(-1) }, { key: 'a', at: at(1) }, null], now);
  assert.deepEqual(list.map((e) => e.key), ['a', 'b']);
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

test('Startseite: PVE-Fenster zeigt nur sichtbare Bereiche, mit Text aus „Heute“ und Turm-Läufen', () => {
  const at = new Date('2026-10-22T18:00:00Z');
  const today = {
    items: [
      { key: 'ihk', text: 'Noch 3 offen' },
      { key: 'grading', text: 'Auftrag offen' },
      { key: 'dungeon', text: 'Noch nicht angemeldet', at },
    ],
  };
  const all = dash.pvePlaces({ today, dungeonAt: at, towerLeft: 2, show: { dungeon: true } });
  assert.deepEqual(all.map((p) => p.key), ['dungeon', 'ihk', 'tower', 'grading']);
  assert.deepEqual(all.map((p) => p.href), ['/dungeon', '/ihk', '/dungeon#mage-tower', '/grading']);
  assert.equal(all[0].at, at);
  assert.equal(all[1].text, 'Noch 3 offen');
  assert.match(all[2].text, /Heute noch 2 Läufe/);
  // ein Lauf, aufgebraucht, Turm nicht sichtbar
  assert.match(dash.pvePlaces({ today, dungeonAt: at, towerLeft: 1, show: { dungeon: true } })[2].text, /Heute noch 1 Lauf /);
  assert.match(dash.pvePlaces({ today, dungeonAt: at, towerLeft: 0, show: { dungeon: true } })[2].text, /Für heute bist du durch/);
  // gesperrte Bereiche (nicht in „Heute“, Dungeon zu, Turm unsichtbar) fehlen
  const few = dash.pvePlaces({ today: { items: [{ key: 'ihk', text: 'x' }] }, dungeonAt: null, towerLeft: null, show: { dungeon: false } });
  assert.deepEqual(few.map((p) => p.key), ['ihk']);
});
