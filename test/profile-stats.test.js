process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { summarize } = require('../src/stats/profileStats');

test('Profil-Statistik: Gewinn ohne Startguthaben und Team-Geld, Umsatz und Ergebnis je Bereich', () => {
  const s = summarize({
    ledger: { startguthaben: 100000, team_gutschrift: 5000, team_abzug: -1000, lotto_los: -2000, lotto_gewinn: 3000, tcg_pack: -8000, tcg_verkauf: 1500, handel_kauf: -400, handel_verkauf: 900, ihk_lohn: 700, grading_ausbau: -200, bonus: 300, provision: 50 },
    stakes: { staked: 6000, settledStake: 4000, settledPayout: 5000 },
    coin: { kauf: 10000, verkauf: 4000 },
    wealth: { total: 120000, coinValue: 7000, cardValue: 9000 },
    packsOpened: 10,
  });
  assert.equal(s.profit, 120000 - 100000 - 4000);
  const area = Object.fromEntries(s.areas.map((a) => [a.key, a]));
  assert.deepEqual([area.wetten.turnover, area.wetten.result], [6000, 1000]);
  assert.deepEqual([area.broker.turnover, area.broker.result], [14000, 4000 - 10000 + 7000]);
  assert.deepEqual([area.lotterie.turnover, area.lotterie.result], [2000, 1000]);
  assert.deepEqual([area.tcg.turnover, area.tcg.result], [9500, -6500 + 9000]);
  assert.deepEqual([area.handel.turnover, area.handel.result], [1300, 500]);
  assert.deepEqual([area.jobs.turnover, area.jobs.result], [null, 500]);
  assert.equal(area.boni.result, 350);
  assert.equal(s.turnover, 6000 + 14000 + 2000 + 9500 + 1300);
  assert.deepEqual([s.packsOpened, s.packSpend], [10, 8000]);
});

test('Profil-Statistik: neues Konto ohne Buchungen', () => {
  const s = summarize({ ledger: { startguthaben: 100000 }, stakes: { staked: 0, settledStake: 0, settledPayout: 0 }, coin: { kauf: 0, verkauf: 0 }, wealth: { total: 100000, coinValue: 0, cardValue: 0 }, packsOpened: 0 });
  assert.equal(s.profit, 0);
  assert.equal(s.turnover, 0);
  assert.ok(s.areas.every((a) => a.result === 0));
});
