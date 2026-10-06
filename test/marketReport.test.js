process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { METRICS, evaluate, reportText, MIN_LOG, MAX_LOG, PER_USER_CAP } = require('../src/coin/marketReport');
const { mulberry32 } = require('../src/coin/model');
const { tally, dueOf } = require('../src/coin/reportService');

const day = (v) => Object.fromEntries(METRICS.map((m) => [m.key, v]));
const week = (v) => Array.from({ length: 7 }, () => day(v));
const half = () => 0.5; // Rauschen = 0

test('Börsenbericht: normaler Tag ≈ 0, guter Tag deutlich, Rekordtag stark, schwacher Tag negativ', () => {
  const flat = evaluate(day(10), week(10), half);
  assert.ok(Math.abs(flat.log) < 1e-9, `gleich wie die Woche ${flat.log}`);
  assert.equal(flat.mood, 'seitwaerts');

  const good = evaluate(day(14), [...week(10), ...week(20)], half); // +40 %, aber kein Rekord
  assert.ok(good.change > 0.08 && good.change < 0.2, `guter Tag ${good.change}`);
  assert.equal(good.records, 0);

  const best = evaluate(day(25), week(10), half); // überall mehr als doppelt so viel und Rekord
  assert.ok(best.change > 0.5 && best.log <= MAX_LOG, `Rekordtag ${best.change}`);
  assert.equal(best.records, METRICS.length);
  assert.equal(best.mood, 'euphorie');

  const bad = evaluate(day(6), week(10), half);
  assert.ok(bad.change < -0.1 && bad.log >= MIN_LOG, `schwacher Tag ${bad.change}`);
});

test('Börsenbericht: das Ausmaß zählt nicht unbegrenzt – zehnmal so viel ist nicht mehr als doppelt so viel', () => {
  const twice = evaluate(day(21), [...week(10), ...week(30)], half);
  const tenfold = evaluate(day(100), [...week(10), ...week(300)], half);
  assert.ok(Math.abs(twice.log - tenfold.log) < 0.02, `${twice.log} / ${tenfold.log}`);
});

test('Börsenbericht: ohne Vortage kein Sprung, Rekorde erst ab 3 Vortagen', () => {
  assert.equal(evaluate(day(50), [], Math.random).log, 0);
  assert.equal(evaluate(day(50), [day(1), day(1)], half).records, 0);
  assert.ok(evaluate(day(50), [day(1), day(1), day(1)], half).records > 0);
});

test('Börsenbericht: Zufall nur als kleines Rauschen, gleicher Seed → gleiches Ergebnis', () => {
  const a = evaluate(day(12), week(10), mulberry32(7));
  const b = evaluate(day(12), week(10), mulberry32(7));
  assert.deepEqual(a, b);
  const base = evaluate(day(12), week(10), half).log;
  assert.ok(Math.abs(a.log - base) <= 0.03 + 1e-9);
});

test('Börsenbericht: Text nennt Kennzahlen und Rekorde, aber keine Kurse', () => {
  const res = evaluate({ ...day(10), wetten: 30 }, week(10), half);
  const { title, body } = reportText(res, '06.10.2026', mulberry32(3));
  assert.equal(title, 'Börsenbericht vom 06.10.2026');
  assert.ok(body.includes('Wettgeschäft: 30 Einsätze'));
  assert.ok(body.includes('**Rekord**'));
  assert.ok(!/ETF|BTCG|Kurs/.test(body), body);
});

test('Börsenbericht: Kennzahlen je Mitglied gedeckelt, Aktivität aus den Stunden', () => {
  const rows = [
    { i: 0, key: 'wetten', u: 'a', n: 500 }, // ein Einzelner kann nicht hochtreiben
    { i: 0, key: 'wetten', u: 'b', n: 3 },
    { i: 1, key: 'broker', u: 'a', n: 4 },
    { i: 1, key: 'broker', u: 'a', n: 2 }, // Kauf + Verkauf zählen zusammen
    { i: 40, key: 'broker', u: 'a', n: 9 }, // außerhalb
  ];
  const pulses = [
    { i: 0, n: 10, users: ['a', 'b'] },
    { i: 0, n: 5, users: ['a'] },
    { i: 2, n: 4, users: ['c'] },
  ];
  const { today, history } = tally(rows, pulses, 2);
  assert.equal(today.wetten, PER_USER_CAP + 3);
  assert.deepEqual([today.anleger, today.aktionen], [2, 15]);
  assert.equal(history.length, 2); // nur Tage, an denen schon gezählt wurde
  assert.equal(history[0].broker, 6);
  assert.deepEqual([history[1].anleger, history[1].aktionen], [1, 4]);
});

test('Börsenbericht: fällig um 18:45 deutscher Zeit (Sommer- und Winterzeit)', () => {
  assert.equal(dueOf(new Date('2026-10-06T12:00:00Z')).due.toISOString(), '2026-10-06T16:45:00.000Z');
  assert.equal(dueOf(new Date('2026-12-06T12:00:00Z')).due.toISOString(), '2026-12-06T17:45:00.000Z');
  assert.equal(dueOf(new Date('2026-10-06T22:30:00Z')).day, '2026-10-07'); // nach Mitternacht deutscher Zeit
});
