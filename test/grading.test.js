process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { LEVELS, PAY, settings, levelInfo, rollSpots, rollDefects, gradeFor, payFor } = require('../src/grading/gradingService');

test('Note: 10 minus Mängel, mit Knick Start bei 4, mindestens 1', () => {
  const none = { scratches: [], corners: [], edges: [], crease: false };
  assert.equal(gradeFor(none), 10);
  assert.equal(gradeFor({ ...none, scratches: [{}, {}], corners: [1] }), 7);
  assert.equal(gradeFor({ ...none, crease: true }), 4); // Knick: Start bei 4
  assert.equal(gradeFor({ ...none, edges: [{}], crease: true }), 3);
  assert.equal(gradeFor({ scratches: [{}, {}, {}], corners: [0, 1, 2, 3], edges: [{}, {}], crease: true }), 1);
});

test('Ausgewürfelte Aufträge: Flecken vorne und hinten, Mängel im gültigen Bereich', () => {
  for (let i = 0; i < 300; i++) {
    const spots = rollSpots();
    assert.ok(spots.length >= 4 && spots.length <= 7);
    assert.ok(spots.some((s) => s.side === 'f') && spots.some((s) => s.side === 'b'));
    assert.ok(spots.every((s) => s.x >= 0 && s.x <= 100 && s.y >= 0 && s.y <= 100));
    const d = rollDefects();
    const g = gradeFor(d);
    assert.ok(g >= 1 && g <= 10);
    assert.ok(d.scratches.length <= 3 && d.edges.length <= 2 && d.corners.every((c) => c >= 0 && c <= 3));
  }
});

test('Standardwerte: 10 Aufträge, Stufe 1 bis 25 € pro Auftrag', () => {
  assert.equal(settings.jobs, 10);
  assert.equal(PAY.clean, 2500);
  assert.ok(LEVELS.every((l) => levelInfo(l.level).jobs === 10));
});

test('Lohn je Stufe: Putzen nach Sauberkeit, Note exakt/±1, Versiegeln nach Qualität', () => {
  assert.equal(payFor({ level: 1, grade: 8, guess: NaN, seal: null }), PAY.clean);
  assert.equal(payFor({ level: 1, clean: 60 }), Math.round(PAY.clean * 0.6));
  assert.equal(payFor({ level: 1, clean: 0 }), 0);
  assert.equal(payFor({ level: 2, grade: 8, guess: 8 }), PAY.clean + PAY.grade);
  assert.equal(payFor({ level: 2, grade: 8, guess: 7 }), PAY.clean + PAY.grade / 2);
  assert.equal(payFor({ level: 2, grade: 8, guess: 5 }), PAY.clean);
  assert.equal(payFor({ level: 3, grade: 8, guess: 8, seal: 100 }), PAY.clean + PAY.grade + PAY.slab);
  assert.equal(payFor({ level: 3, grade: 8, guess: 8, seal: 500 }), PAY.clean + PAY.grade + PAY.slab); // gedeckelt
  assert.equal(payFor({ level: 4, grade: 8, guess: 8, seal: 100 }), Math.round((PAY.clean + PAY.grade + PAY.slab) * 1.3));
});

test('Stufen: aufsteigende Kosten, jede Stufe mindestens so viele Schritte wie die vorige', () => {
  LEVELS.map((x) => levelInfo(x.level)).forEach((l, i, all) => {
    assert.equal(l.level, i + 1);
    if (i) {
      assert.ok(l.cost > all[i - 1].cost);
      assert.ok(l.steps.length >= all[i - 1].steps.length);
    }
  });
  assert.equal(levelInfo(99).level, LEVELS.length);
  assert.equal(levelInfo(0).level, 1);
});

test('Grading: Kundenkarten erst ab Holo, seltener = weniger Chance und mehr Lohn', () => {
  const { CUSTOMER_RARITIES, rarityBonus, rollCard } = require('../src/grading/gradingService');
  const catalog = require('../src/tcg/catalog');
  assert.deepStrictEqual(CUSTOMER_RARITIES.map(([k]) => k), ['holo', 'bockhaber', 'glitch', 'icon', 'boss', 'sith']);
  assert.deepStrictEqual(CUSTOMER_RARITIES.map(([, , b]) => b), [0, 5, 10, 15, 20, 50]);
  for (let i = 1; i < CUSTOMER_RARITIES.length; i++) assert.ok(CUSTOMER_RARITIES[i][1] < CUSTOMER_RARITIES[i - 1][1]);
  const allowed = new Set(CUSTOMER_RARITIES.map(([k]) => k));
  for (let i = 0; i < 500; i++) assert.ok(allowed.has(catalog.cardById[rollCard()].rarity));
  assert.strictEqual(rarityBonus('crumpled'), 0);
  assert.strictEqual(payFor({ level: 1, rarity: 'sith' }), Math.round(PAY.clean * 1.5));
  assert.strictEqual(payFor({ level: 1, rarity: 'bockhaber' }), Math.round(PAY.clean * 1.05));
  assert.strictEqual(payFor({ level: 4, grade: 8, guess: 8, seal: 100, rarity: 'boss' }), Math.round((PAY.clean + PAY.grade + PAY.slab) * 1.3 * 1.2));
});

test('#96: nach einem Ausbau gibt es am selben Tag wieder volle Aufträge', () => {
  const { usedToday } = require('../src/grading/gradingService');
  const day = '2026-10-05';
  const done = Array.from({ length: 10 }, () => ({ level: 1 }));
  assert.equal(usedToday({ done, open: null, level: 1, day }), 10); // Stufe 1: alles verbraucht
  assert.equal(usedToday({ done, open: null, level: 2, day }), 0); // nach dem Ausbau: neues Kontingent
  assert.equal(usedToday({ done: [...done, { level: 2 }], open: { day, level: 2 }, level: 2, day }), 2);
  assert.equal(usedToday({ done, open: { day, level: 1 }, level: 2, day }), 0); // offener Auftrag von vor dem Ausbau
  assert.equal(usedToday({ done: [], open: { day: '2026-10-04', level: 1 }, level: 1, day }), 0); // von gestern
});

test('#96: Shop-Wert im Vermögen = Hälfte der Ausbaukosten', () => {
  const { shopValue, shopValues } = require('../src/grading/gradingService');
  const costs = [100000, 150000, 180000];
  assert.equal(shopValue(1, costs), 0);
  assert.equal(shopValue(2, costs), 50000);
  assert.equal(shopValue(3, costs), 125000);
  assert.equal(shopValue(4, costs), 215000);
  assert.equal(shopValue(9, costs), 215000); // nie mehr als voll ausgebaut
  assert.equal(shopValue(undefined, costs), 0);
  assert.equal(shopValues().length, LEVELS.length);
});
