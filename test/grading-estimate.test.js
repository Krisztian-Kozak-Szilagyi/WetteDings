const test = require('node:test');
const assert = require('node:assert');
const { rarityFactor, jobPay, estimate, PROFILES } = require('../src/grading/estimate');

const LEVELS = [
  { level: 1, name: 'A', steps: ['clean'] },
  { level: 2, name: 'B', steps: ['clean', 'grade'] },
  { level: 3, name: 'C', steps: ['clean', 'grade', 'slab'] },
  { level: 4, name: 'D', steps: ['clean', 'grade', 'slab'], premium: true },
];
const SETTINGS = { jobs: 10, pay: { clean: 2500, grade: 2000, slab: 1500 }, costs: [150000, 500000, 1200000], premium: 30 };
const perfect = PROFILES[0];

test('Grading-Schätzung: Seltenheits-Faktor nur über Seltenheiten mit Karten', () => {
  assert.equal(rarityFactor([['a', 1, 0], ['b', 1, 100]]), 1.5);
  assert.equal(rarityFactor([['a', 1, 0], ['b', 1, 100]], (k) => k === 'a'), 1);
  assert.equal(rarityFactor([]), 1);
});

test('Grading-Schätzung: Lohn pro Auftrag je Stufe (perfekt, ohne Zuschlag)', () => {
  assert.equal(jobPay(LEVELS[0], SETTINGS.pay, 30, perfect, 1), 2500);
  assert.equal(jobPay(LEVELS[1], SETTINGS.pay, 30, perfect, 1), 4500);
  assert.equal(jobPay(LEVELS[2], SETTINGS.pay, 30, perfect, 1), 6000);
  assert.equal(jobPay(LEVELS[3], SETTINGS.pay, 30, perfect, 1), 7800);
  // ±1 zählt halb: 50 % exakt + 50 % daneben = 75 % des Benoten-Lohns
  assert.equal(jobPay(LEVELS[1], SETTINGS.pay, 30, { clean: 100, exact: 0.5, near: 0.5, seal: 0 }, 1), 2500 + 1500);
});

test('Grading-Schätzung: pro Tag, Folie ab Stufe 3, Amortisation', () => {
  const rows = estimate({ levels: LEVELS, settings: SETTINGS, factor: 1, foilValue: 10, profiles: [perfect] });
  assert.deepEqual(rows.map((r) => r.perDay.perfekt), [25000, 45000, 60100, 78100]);
  assert.deepEqual(rows.map((r) => r.cost), [0, 150000, 500000, 1200000]);
  assert.deepEqual(rows.map((r) => r.payback), [null, 8, 34, 67]); // 150000/20000 = 7,5 -> 8 Tage
});
