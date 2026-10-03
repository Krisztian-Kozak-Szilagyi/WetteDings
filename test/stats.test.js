process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { diffSettings, configValues } = require('../src/stats/settingsLog');

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
