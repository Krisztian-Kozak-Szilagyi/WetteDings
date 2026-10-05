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
    assert.deepEqual(Object.keys(c.defects).sort(), ['corners', 'crease', 'edges', 'scratches']);
    // passt 1:1 in einen Grading-Auftrag (Grundlage für "eigene Karte in den Shop schicken")
    const job = new GradingJob({ user: '64b000000000000000000000', day: '2026-10-05', level: 1, card: 'x', customer: 'K', grade: c.grade, defects: c.defects });
    assert.equal(job.validateSync(), undefined);
    assert.deepEqual(job.defects.toObject(), c.defects);
  }
});

test('Zustand: frisch aus dem Pack deutlich besser als gebrauchte Kundenkarten', () => {
  const N = 10000;
  const share10 = (roll) => Array.from({ length: N }, roll).filter((g) => g === 10).length / N;
  const frisch = share10(() => rollCondition().grade);
  const kunde = share10(() => gradeFor(rollDefects('kunde')));
  assert.ok(frisch > 0.25 && frisch < 0.36, `frisch: ${frisch}`);
  assert.ok(kunde > 0.07 && kunde < 0.15, `kunde: ${kunde}`);
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
