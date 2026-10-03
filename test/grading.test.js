process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const { LEVELS, PAY, levelInfo, rollSpots, rollDefects, gradeFor, payFor } = require('../src/grading/gradingService');

test('Note: 10 minus Mängel, Knick −3, mindestens 1', () => {
  const none = { scratches: [], corners: [], edges: [], crease: false };
  assert.equal(gradeFor(none), 10);
  assert.equal(gradeFor({ ...none, scratches: [{}, {}], corners: [1] }), 7);
  assert.equal(gradeFor({ ...none, edges: [{}], crease: true }), 6);
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

test('Lohn je Stufe: Reinigen fest, Note exakt/±1, Versiegeln nach Qualität', () => {
  assert.equal(payFor({ level: 1, grade: 8, guess: NaN, seal: null }), PAY.clean);
  assert.equal(payFor({ level: 2, grade: 8, guess: 8 }), PAY.clean + PAY.grade);
  assert.equal(payFor({ level: 2, grade: 8, guess: 7 }), PAY.clean + PAY.grade / 2);
  assert.equal(payFor({ level: 2, grade: 8, guess: 5 }), PAY.clean);
  assert.equal(payFor({ level: 3, grade: 8, guess: 8, seal: 100 }), PAY.clean + PAY.grade + PAY.slab);
  assert.equal(payFor({ level: 3, grade: 8, guess: 8, seal: 500 }), PAY.clean + PAY.grade + PAY.slab); // gedeckelt
  assert.equal(payFor({ level: 4, grade: 8, guess: 8, seal: 100 }), Math.round((PAY.clean + PAY.grade + PAY.slab) * 1.3));
});

test('Stufen: aufsteigende Kosten, jede Stufe mindestens so viele Schritte wie die vorige', () => {
  LEVELS.forEach((l, i) => {
    assert.equal(l.level, i + 1);
    if (i) {
      assert.ok(l.cost > LEVELS[i - 1].cost);
      assert.ok(l.steps.length >= LEVELS[i - 1].steps.length);
    }
  });
  assert.equal(levelInfo(99).level, LEVELS.length);
  assert.equal(levelInfo(0).level, 1);
});
