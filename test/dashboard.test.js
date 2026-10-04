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
