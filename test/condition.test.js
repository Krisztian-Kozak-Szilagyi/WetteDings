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
    assert.deepEqual(Object.keys(c.defects.centering), ['lr']); // nur links/rechts (Version 2)
    assert.ok(c.defects.centering.lr >= 50 && c.defects.centering.lr <= 80);
    // passt 1:1 in einen Grading-Auftrag (Grundlage für "eigene Karte in den Shop schicken")
    const job = new GradingJob({ user: '64b000000000000000000000', day: '2026-10-05', level: 1, card: 'x', customer: 'K', grade: c.grade, defects: c.defects });
    assert.equal(job.validateSync(), undefined);
    assert.deepEqual(job.defects.toObject(), c.defects);
  }
});

test('Zustand: frisch aus dem Pack – nie Kratzer oder Knick (#204), die entstehen erst im Spiel', () => {
  for (let i = 0; i < 5000; i++) {
    const { defects } = rollCondition();
    assert.equal(defects.scratches.length, 0);
    assert.equal(defects.crease, false);
  }
});

test('Zustand: frisch aus dem Pack – Note 10 am häufigsten, im Schnitt besser als gebrauchte Kundenkarten', () => {
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
  // exakt: 10 ≈ 35,9 %, 9 ≈ 34,5 %, 8 ≈ 18,0 %, Ø ≈ 8,88
  assert.ok(frisch.share(10) > frisch.share(8) && frisch.share(9) > frisch.share(8), 'Note 10 und 9 vor der 8');
  assert.ok(frisch.share(10) > 0.32 && frisch.share(10) < 0.40, `frisch 10: ${frisch.share(10)}`);
  assert.ok(frisch.avg > 8.8 && frisch.avg < 8.96, `Ø frisch: ${frisch.avg}`);
  assert.ok(frisch.avg > kunde.avg, `Ø frisch ${frisch.avg} > kunde ${kunde.avg}`);
  assert.ok(kunde.share(10) > 0.05 && kunde.share(10) < 0.12, `kunde 10: ${kunde.share(10)}`); // exakt ≈ 8,5 %
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
  const a = centerShift({ lr: 80, tb: 60 }, '6abf00'); // Bit 0 aus: nach rechts; oben/unten (alte Zustände) zählt nicht
  assert.deepEqual(a, { x: 0.6, y: 0 });
  const b = centerShift({ lr: 80, tb: 60 }, '6abf03'); // Bit 0 an: nach links
  assert.deepEqual(b, { x: -0.6, y: 0 });
  assert.deepEqual(centerShift({ lr: 80, tb: 60 }, '6abf00'), a); // dasselbe Exemplar sieht immer gleich aus
  for (let i = 0; i < 200; i++) {
    const s = centerShift(rollCondition().defects.centering, i.toString(16));
    assert.ok(Math.abs(s.x) <= 0.6 && s.y === 0); // höchstens 80/20, nur waagerecht
  }
});

test('Erst Obergrenze (Knick, Zentrierung – nur links/rechts zählt), dann je Mangel −1', () => {
  const { centeringCap } = condition;
  const none = { scratches: [], corners: [], edges: [], crease: false };
  assert.equal(centeringCap(undefined), 10); // alte Aufträge ohne Zentrierung
  assert.equal(centeringCap({ lr: 55, tb: 50 }), 10);
  assert.equal(centeringCap({ lr: 52, tb: 58 }), 10); // oben/unten (alte Zustände) zählt nicht mehr
  assert.equal(centeringCap({ lr: 58 }), 9);
  assert.equal(centeringCap({ lr: 65, tb: 50 }), 8);
  assert.equal(centeringCap({ lr: 70, tb: 80 }), 7);
  assert.equal(centeringCap({ lr: 80, tb: 50 }), 6);
  assert.equal(gradeFor({ ...none, centering: { lr: 62, tb: 51 } }), 8); // makellos, aber 62/38
  assert.equal(gradeFor({ ...none, scratches: [{}, {}, {}], centering: { lr: 62, tb: 51 } }), 5); // erst Obergrenze 8, dann −3
  assert.equal(gradeFor({ ...none, scratches: [{}], centering: { lr: 64, tb: 50 } }), 7); // 64/36 → 8, −1 Kratzer
  assert.equal(gradeFor({ ...none, crease: true, centering: { lr: 75, tb: 50 } }), 4); // Knick (4) liegt unter der Zentrierungs-Grenze (6)
  assert.deepEqual(condition.gradeCap({ ...none, crease: true, centering: { lr: 75, tb: 50 } }), { cap: 4, by: 'knick' });
  assert.deepEqual(condition.gradeCap({ ...none, centering: { lr: 75, tb: 50 } }), { cap: 6, by: 'zentrierung' });
  assert.deepEqual(condition.gradeCap(none), { cap: 10, by: null });
  assert.equal(gradeFor({ ...none, crease: true, scratches: [{}], centering: { lr: 50, tb: 50 } }), 3);
});

test('Schaden (#204): Kratzer kommt dazu, Knick nur einmal – ein zweiter wird zum Kratzer; das Original bleibt', () => {
  const { addDamage } = condition;
  const base = { scratches: [], corners: [1], edges: [], crease: false, centering: { lr: 50 } };
  const k = addDamage(base, 'kratzer');
  assert.equal(k.scratches.length, 1);
  assert.equal(base.scratches.length, 0);
  assert.equal(gradeFor(k), 8); // 10 − Ecke − Kratzer
  const knick = addDamage(base, 'knick');
  assert.equal(knick.crease, true);
  assert.equal(gradeFor(knick), 3); // Obergrenze 4 − Ecke
  const twice = addDamage(knick, 'knick');
  assert.equal(twice.crease, true);
  assert.equal(twice.scratches.length, 1);
  // gebügelter Knick, dann neuer Knick: Bügeln ist aufgehoben
  const ironed = { ...base, crease: true, creaseCap: 8, ironed: true };
  const fresh = addDamage({ ...ironed, crease: false }, 'knick');
  assert.equal(fresh.creaseCap, undefined);
  assert.equal(fresh.ironed, undefined);
});

test('Migration auf Version 3: unfoliert ohne Kratzer und Knick, foliert unverändert, zweimal = einmal', () => {
  const { conditionV3 } = condition;
  const defects = { scratches: [{ x: 1, y: 1, len: 1, angle: 0 }], corners: [0], edges: [], crease: true, centering: { lr: 58 } };
  const old = { v: 2, grade: gradeFor(defects), defects };
  assert.equal(old.grade, 2); // Knick 4 − Kratzer − Ecke
  const free = conditionV3(old, false);
  assert.deepEqual(free, { v: 3, grade: 8, defects: { scratches: [], corners: [0], edges: [], crease: false, centering: { lr: 58 } } });
  assert.equal(old.defects.scratches.length, 1); // Original unverändert
  assert.deepEqual(conditionV3(free, false), free);
  const foiled = conditionV3(old, true);
  assert.deepEqual(foiled, { ...old, v: 3 });
  // ein späterer Schaden (schon v3) bleibt erhalten
  const damaged = { v: 3, grade: 7, defects: { ...free.defects, scratches: [{}] } };
  assert.equal(conditionV3(damaged, false), damaged);
});

test('Bügeln (#204): je 20 % glatt eine Note mehr, höchstens 9; Brandflecken zählen als Kratzer', () => {
  const { ironCap, applyIron, creaseLine, gradeCap } = condition;
  assert.deepEqual([0, 19, 20, 59, 80, 100, 150, -5].map(ironCap), [4, 4, 5, 6, 8, 9, 9, 4]);
  const knick = { scratches: [], corners: [], edges: [], crease: true, centering: { lr: 50 } };
  const smooth = applyIron(knick, { smooth: 100, burns: 0 });
  assert.deepEqual(gradeCap(smooth), { cap: 9, by: 'knick' });
  assert.equal(gradeFor(smooth), 9);
  assert.equal(knick.ironed, undefined); // Original unverändert
  const burnt = applyIron(knick, { smooth: 60, burns: 2 }, creaseLine('6abf00'));
  assert.equal(gradeFor(burnt), 7 - 2);
  // nur einmal: ein gebügelter Knick bleibt, wie er ist; ohne Knick passiert nichts
  assert.deepEqual(applyIron(smooth, { smooth: 0, burns: 5 }), smooth);
  assert.deepEqual(applyIron({ ...knick, crease: false }, { smooth: 100, burns: 3 }), { ...knick, crease: false });
  // Werte vom Browser werden geklemmt
  assert.equal(applyIron(knick, { smooth: 100, burns: 99 }).scratches.length, condition.CREASE_SEGMENTS);
  assert.equal(applyIron(knick, { smooth: 'x', burns: -3 }).scratches.length, 0);
  // Zentrierung bleibt die Obergrenze, wenn sie schlechter ist als der gebügelte Knick
  assert.deepEqual(gradeCap({ ...smooth, centering: { lr: 75 } }), { cap: 6, by: 'zentrierung' });
  // Knicklinie: fest je ID, auf der Karte
  assert.deepEqual(creaseLine('6abf00'), creaseLine('6abf00'));
  for (let i = 0; i < 300; i++) {
    const l = creaseLine(i.toString(16).padStart(4, '0'));
    assert.ok(l.y >= 30 && l.y <= 70 && Math.abs(l.angle) <= 12);
  }
});
