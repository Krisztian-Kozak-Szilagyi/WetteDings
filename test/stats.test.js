process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { diffSettings, configValues } = require('../src/stats/settingsLog');
const { soldMeta } = require('../src/tcg/tcgService');
const { areaOf, dayAndHour, isPageRequest } = require('../src/stats/activity');
const { quantile, distribution } = require('../src/stats/snapshot');

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
