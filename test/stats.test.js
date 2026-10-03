process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { diffSettings, configValues } = require('../src/stats/settingsLog');
const { soldMeta } = require('../src/tcg/tcgService');
const { areaOf, dayAndHour, isPageRequest } = require('../src/stats/activity');
const { quantile, distribution } = require('../src/stats/snapshot');
const { addDays, dayList, weekday, isoWeek, period, buckets, aggregate, delta, retention, effectiveChances, pullVerdict } = require('../src/stats/statsService');

test('Einstellungs-Verlauf: nur geänderte Werte, mit Pfad', () => {
  const before = { packPrice: 8000, weight: { gold: 1100, holo: 250 }, rewards: [1500, 2500] };
  const after = { packPrice: 9000, weight: { gold: 1000, holo: 250 }, rewards: [1500, 3000] };
  assert.deepEqual(diffSettings(before, after), [
    { path: 'packPrice', from: 8000, to: 9000 },
    { path: 'weight.gold', from: 1100, to: 1000 },
    { path: 'rewards.1', from: 2500, to: 3000 },
  ]);
  assert.deepEqual(diffSettings(after, JSON.parse(JSON.stringify(after))), []);
});

test('Einstellungs-Verlauf: neue und weggefallene Werte', () => {
  assert.deepEqual(diffSettings({}, { taxPercent: 5 }), [{ path: 'taxPercent', from: null, to: 5 }]);
  assert.deepEqual(diffSettings({ a: 1, hybrid: { rewards: [1] } }, { a: 1 }), [{ path: 'hybrid', from: { rewards: [1] }, to: null }]);
});

test('Einstellungs-Verlauf: .env-Werte beim Start', () => {
  const v = configValues();
  assert.ok(Number.isInteger(v.startBalance) && Number.isInteger(v.duelFeePercent) && Array.isArray(v.bonusTiers));
});

test('Kartenverkauf: Exemplare je Karte zusammengefasst', () => {
  const docs = [
    { card: 'anna-1', rarity: 'crumpled' },
    { card: 'ben-3', rarity: 'gold' },
    { card: 'anna-1', rarity: 'crumpled' },
  ];
  assert.deepEqual(soldMeta(docs), {
    cards: [
      { card: 'anna-1', rarity: 'crumpled', count: 2 },
      { card: 'ben-3', rarity: 'gold', count: 1 },
    ],
  });
});

test('Aktivität: Bereich aus dem Pfad', () => {
  assert.equal(areaOf('/'), 'start');
  assert.equal(areaOf('/handel/tausch'), 'handel');
  assert.equal(areaOf('/wetten/abc/entscheiden'), 'wetten');
  assert.equal(areaOf('/coin-exchange'), 'coin');
  assert.equal(areaOf('/irgendwas'), 'sonstiges');
});

test('Aktivität: Tag und Stunde in deutscher Zeit', () => {
  // 23:30 UTC im Sommer = 01:30 am Folgetag in Berlin
  assert.deepEqual(dayAndHour(new Date('2026-07-01T23:30:00Z')), { day: '2026-07-02', hour: 1 });
  assert.deepEqual(dayAndHour(new Date('2026-01-15T11:05:00Z')), { day: '2026-01-15', hour: 12 });
});

test('Aktivität: nur Seitenaufrufe und Formulare zählen', () => {
  const req = (method, headers = {}, accept = 'html') => ({
    method,
    xhr: false,
    get: (h) => headers[h.toLowerCase()],
    accepts: () => accept,
  });
  assert.equal(isPageRequest(req('GET', { 'sec-fetch-dest': 'document' })), true);
  assert.equal(isPageRequest(req('POST', { 'sec-fetch-dest': 'document' })), true);
  assert.equal(isPageRequest(req('GET', { 'sec-fetch-dest': 'empty' })), false); // fetch (Live-Stand, Chat)
  assert.equal(isPageRequest(req('GET', {}, 'json')), false);
  assert.equal(isPageRequest(req('GET')), true);
  assert.equal(isPageRequest(req('DELETE', { 'sec-fetch-dest': 'document' })), false);
});

test('Snapshot: Perzentile', () => {
  const v = [0, 10, 20, 30, 40];
  assert.equal(quantile(v, 0.5), 20);
  assert.equal(quantile(v, 0.9), 36);
  assert.equal(quantile([], 0.5), 0);
});

test('Snapshot: Vermögensverteilung', () => {
  const equal = distribution([100, 100, 100, 100]);
  assert.equal(equal.gini, 0);
  assert.equal(equal.mean, 100);
  assert.equal(equal.top10Share, 0.25); // reichste 10 % = 1 von 4

  // einer besitzt alles: Gini = (n − 1) / n
  const one = distribution([0, 0, 0, 400]);
  assert.equal(one.gini, 0.75);
  assert.equal(one.top10Share, 1);
  assert.equal(one.median, 0);
  assert.equal(one.max, 400);

  assert.deepEqual(distribution([]).count, 0);
  assert.equal(distribution([0, 0]).gini, 0);
});

test('Statistik: Tage rechnen', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.deepEqual(dayList('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(weekday('2026-10-05'), 0); // Montag
  assert.equal(weekday('2026-10-04'), 6); // Sonntag
});

test('Statistik: Zeitraum in deutscher Zeit', () => {
  const p = period(7, new Date('2026-10-03T22:30:00Z')); // in Berlin schon der 4.10.
  assert.equal(p.to, '2026-10-04');
  assert.equal(p.from, '2026-09-28');
  assert.equal(p.days.length, 7);
  assert.equal(p.since.toISOString(), '2026-09-27T22:00:00.000Z');
  assert.equal(period(12345).range, 30); // unbekannter Zeitraum -> Standard
});

test('Statistik: Retention nur für erreichte Stichtage', () => {
  const cohort = [
    { user: 'a', day: '2026-10-01' },
    { user: 'b', day: '2026-10-01' },
    { user: 'c', day: '2026-10-09' },
  ];
  const active = new Map([
    ['a', new Set(['2026-10-02', '2026-10-08'])],
    ['b', new Set(['2026-10-03'])],
    ['c', new Set(['2026-10-10'])],
  ]);
  const [d1, d7] = retention(cohort, active, [1, 7], '2026-10-10');
  assert.deepEqual(d1, { offset: 1, eligible: 3, retained: 2, rate: 2 / 3 });
  assert.deepEqual(d7, { offset: 7, eligible: 2, retained: 1, rate: 0.5 });
});

test('Statistik: Soll-Chancen fallen bei fehlenden Karten auf die nächstniedrigere Seltenheit', () => {
  const rarities = [
    { key: 'a', weight: 70 },
    { key: 'b', weight: 20 },
    { key: 'c', weight: 10 },
  ];
  assert.deepEqual(effectiveChances(rarities, [{ rarity: 'a' }, { rarity: 'b' }]), { a: 0.7, b: 0.3, c: 0 });
  assert.deepEqual(effectiveChances(rarities, [{ rarity: 'a' }, { rarity: 'c' }]), { a: 0.9, b: 0, c: 0.1 });
});

test('Statistik: Vorzeitraum und Tagesgrenzen', () => {
  const now = new Date('2026-10-03T10:00:00Z');
  const prev = period(7, now, 1);
  assert.equal(prev.to, '2026-09-26');
  assert.equal(prev.from, '2026-09-20');
  assert.equal(prev.until.toISOString(), period(7, now).since.toISOString()); // lückenlos aneinander
});

test('Statistik: Kalenderwochen nach ISO 8601', () => {
  assert.deepEqual(isoWeek('2026-10-03'), { year: 2026, week: 40 });
  assert.deepEqual(isoWeek('2027-01-01'), { year: 2026, week: 53 }); // Freitag gehört noch zur letzten Woche 2026
  assert.deepEqual(isoWeek('2024-12-30'), { year: 2025, week: 1 });
});

test('Statistik: Bündelung nach Tag, Woche, Monat', () => {
  assert.equal(buckets(dayList('2026-09-04', '2026-10-03')).unit, 'tag');
  const w = buckets(dayList('2026-09-28', '2026-10-11'));
  assert.equal(w.unit, 'tag');
  const weeks = buckets(dayList('2026-07-06', '2026-10-03'));
  assert.equal(weeks.unit, 'woche');
  assert.equal(weeks.list[0].label, 'KW 28');
  assert.equal(weeks.list[weeks.list.length - 1].days.length, 6); // Mo–Sa der laufenden Woche
  const months = buckets(dayList('2025-10-04', '2026-10-03'));
  assert.equal(months.unit, 'monat');
  assert.equal(months.list.length, 13);
  assert.equal(months.list[12].long, 'Oktober 2026');
});

test('Statistik: Werte je Abschnitt zusammenfassen', () => {
  const days = ['a', 'b', 'c', 'd'];
  const list = [{ days: ['a', 'b'] }, { days: ['c', 'd'] }];
  assert.deepEqual(aggregate([1, 2, 3, null], days, list, 'sum'), [3, 3]);
  assert.deepEqual(aggregate([1, 2, 3, null], days, list, 'last'), [2, 3]);
  assert.deepEqual(aggregate([1, 3, 4, 0], days, list, 'avg'), [2, 2]);
  assert.deepEqual(aggregate([null, null, 5, null], days, list, 'last'), [null, 5]);
});

test('Statistik: Vergleich mit dem Vorzeitraum', () => {
  assert.deepEqual(delta(120, 100, { unit: 'count' }), { dir: 'up', rel: 0.2 });
  assert.deepEqual(delta(50, 0, { unit: 'count' }), { dir: 'up', isNew: true });
  assert.deepEqual(delta(-500, 2000, { unit: 'euro', signed: true }), { dir: 'down', abs: -2500 });
  assert.equal(delta(0.42, 0.4, { unit: 'percent' }).dir, 'up');
  assert.equal(delta(null, 5, { unit: 'count' }), null);
});

test('Statistik: Drop-Raten erst ab genug Daten bewerten', () => {
  assert.equal(pullVerdict(0, 15, 0.025), 'wenig-daten'); // 0,4 erwartet
  assert.equal(pullVerdict(580, 1000, 0.58), 'im-rahmen');
  assert.equal(pullVerdict(700, 1000, 0.58), 'zu-oft');
  assert.equal(pullVerdict(10, 1000, 0.11), 'zu-selten');
});
