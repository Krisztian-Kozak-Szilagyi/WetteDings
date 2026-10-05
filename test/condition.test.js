process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const condition = require('../src/grading/condition');
const grading = require('../src/grading/gradingService');
const { TcgCard } = require('../src/models/Tcg');
const { GradingJob } = require('../src/models/Grading');
const { foilViewAttrs } = require('../src/lib/viewHelpers');

const { rollCondition, rollDefects, gradeFor, gradeWord, CONDITION_VERSION } = condition;

test('Zustand: Mängel im Format der Grading-Aufträge, Note folgt aus den Mängeln', () => {
  for (let i = 0; i < 500; i++) {
    const c = rollCondition();
    assert.equal(c.v, CONDITION_VERSION);
    assert.equal(c.grade, gradeFor(c.defects));
    assert.ok(c.grade >= 1 && c.grade <= 10);
    assert.deepEqual(Object.keys(c.defects).sort(), ['centering', 'corners', 'crease', 'edges', 'scratches']);
    for (const axis of ['lr', 'tb']) assert.ok(c.defects.centering[axis] >= 50 && c.defects.centering[axis] <= 80);
    // passt 1:1 in einen Grading-Auftrag (Grundlage für "eigene Karte in den Shop schicken")
    const job = new GradingJob({ user: '64b000000000000000000000', day: '2026-10-05', level: 1, card: 'x', customer: 'K', grade: c.grade, defects: c.defects });
    assert.equal(job.validateSync(), undefined);
    assert.deepEqual(job.defects.toObject(), c.defects);
  }
});

test('Zustand: frisch aus dem Pack – Note 8 am häufigsten, im Schnitt besser als gebrauchte Kundenkarten', () => {
  const N = 20000;
  const roll = (fn) => {
    const count = {};
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const g = fn();
      count[g] = (count[g] || 0) + 1;
      sum += g;
    }
    return { share: (g) => (count[g] || 0) / N, avg: sum / N };
  };
  const frisch = roll(() => rollCondition().grade);
  const kunde = roll(() => gradeFor(rollDefects('kunde')));
  // exakt: 10 ≈ 9,2 %, 9 ≈ 26,9 %, 8 ≈ 30,2 %, Ø ≈ 7,88
  assert.ok(frisch.share(8) > frisch.share(9) && frisch.share(9) > frisch.share(10), 'Note 8 am häufigsten, dann 9, dann 10');
  assert.ok(frisch.share(10) > 0.06 && frisch.share(10) < 0.13, `frisch 10: ${frisch.share(10)}`);
  assert.ok(frisch.avg > kunde.avg, `Ø frisch ${frisch.avg} > kunde ${kunde.avg}`);
  assert.ok(kunde.share(10) > 0.03 && kunde.share(10) < 0.09, `kunde 10: ${kunde.share(10)}`); // exakt ≈ 5,6 %
  assert.ok(kunde.share(8) > kunde.share(9), 'auch bei Kundenkarten ist die 8 häufiger als die 9');
  // Kundenaufträge im Grading-Shop würfeln unverändert mit dem Profil "kunde"
  assert.equal(grading.rollDefects, rollDefects);
  assert.equal(grading.gradeFor, gradeFor);
});

test('Noten-Bezeichnungen wie auf Grading-Etiketten', () => {
  assert.equal(gradeWord(10), 'GEM MINT');
  assert.equal(gradeWord(8), 'NM-MT');
  assert.equal(gradeWord(1), 'POOR');
  for (let g = 1; g <= 10; g++) assert.ok(gradeWord(g));
  assert.equal(gradeWord(0), '');
});

test('Karte: jede neue Karte bekommt einen Zustand, der standardmäßig nie geladen wird', () => {
  const path = TcgCard.schema.path('condition');
  assert.equal(path.options.select, false); // geheim: nur mit ausdrücklichem .select(…)
  const card = new TcgCard({ user: '64b000000000000000000000', card: 'x', rarity: 'crumpled' });
  assert.equal(card.condition.v, CONDITION_VERSION);
  assert.equal(card.condition.grade, gradeFor(card.condition.defects));
  // zwei Karten würfeln unabhängig (kein gemeinsames Default-Objekt)
  const other = new TcgCard({ user: '64b000000000000000000000', card: 'x', rarity: 'crumpled' });
  assert.notEqual(card.condition, other.condition);
});

test('Folie: Note nur auf dem Etikett, wenn sie mitgegeben wird', () => {
  const card = { image: '/a.webp', name: 'St. Ivan', rarity: 'glitch' };
  const without = foilViewAttrs(card, 'Glitch', new Date());
  assert.ok(!without.includes('data-grade'));
  const withGrade = foilViewAttrs(card, 'Glitch', new Date(), { grade: 8 });
  assert.match(withGrade, /data-grade="8"/);
  assert.match(withGrade, /data-grade-word="NM-MT"/);
});

test('Gegradete Karten: beste Note, wie oft, Schnitt – ohne Folie gibt es nichts zu zeigen', () => {
  const { gradeStats } = condition;
  assert.equal(gradeStats([]), null);
  assert.equal(gradeStats([undefined, null]), null); // ohne Note (z. B. vor der Migration) zählt nicht
  assert.deepEqual(gradeStats([8, 10, 7, 10]), { count: 4, best: 10, bestCount: 2, avg: 8.75, dist: [0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 2] });
  const one = gradeStats([6, undefined]);
  assert.deepEqual([one.count, one.best, one.bestCount, one.avg, one.dist[6]], [1, 6, 1, 6, 1]);
});

test('Versatz auf der Folie: Stärke aus der Zentrierung, Richtung fest aus dem Exemplar', () => {
  const { centerShift } = condition;
  assert.equal(centerShift(undefined, 'abc'), null);
  assert.deepEqual(centerShift({ lr: 50, tb: 50 }, '6abf00'), { x: 0, y: 0 });
  const a = centerShift({ lr: 80, tb: 60 }, '6abf00'); // Bits 00: beide positiv
  assert.deepEqual(a, { x: 0.6, y: 0.2 });
  const b = centerShift({ lr: 80, tb: 60 }, '6abf03'); // Bits 11: beide negativ
  assert.deepEqual(b, { x: -0.6, y: -0.2 });
  assert.deepEqual(centerShift({ lr: 80, tb: 60 }, '6abf00'), a); // dasselbe Exemplar sieht immer gleich aus
  for (let i = 0; i < 200; i++) {
    const s = centerShift(rollCondition().defects.centering, i.toString(16));
    assert.ok(Math.abs(s.x) <= 0.6 && Math.abs(s.y) <= 0.6); // höchstens 80/20
  }
});

test('Zentrierung begrenzt die Note (schlechtere Achse zählt), mit Knick Start bei 4', () => {
  const { centeringCap } = condition;
  const none = { scratches: [], corners: [], edges: [], crease: false };
  assert.equal(centeringCap(undefined), 10); // alte Aufträge ohne Zentrierung
  assert.equal(centeringCap({ lr: 55, tb: 50 }), 10);
  assert.equal(centeringCap({ lr: 52, tb: 58 }), 9);
  assert.equal(centeringCap({ lr: 65, tb: 50 }), 8);
  assert.equal(centeringCap({ lr: 70, tb: 70 }), 7);
  assert.equal(centeringCap({ lr: 80, tb: 50 }), 6);
  assert.equal(gradeFor({ ...none, centering: { lr: 62, tb: 51 } }), 8); // makellos, aber 62/38
  assert.equal(gradeFor({ ...none, scratches: [{}, {}, {}], centering: { lr: 62, tb: 51 } }), 7); // Kratzer drücken tiefer als die Grenze
  assert.equal(gradeFor({ ...none, crease: true, scratches: [{}], centering: { lr: 50, tb: 50 } }), 3);
});
