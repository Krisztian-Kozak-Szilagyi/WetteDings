process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/dungeon/liveTower');
const { TOWER } = require('../src/dungeon/tower');
const league = require('../src/esports/league');

const W = 180;
const F = 20;
// einfache Takte: alle 10 Spiel-Sekunden 10 Punkte
const sim = (n = 18, p = 10) => ({ ticks: Array.from({ length: n }, (_, i) => ({ t: (i + 1) * 10, p })), freeze: 0, extend: 0, speed: 0 });
const opts = (o = {}) => ({ required: 10000, trait: null, boostUntil: [0, 0, 0], ext: 0, rand: L.seeded('x'), workTime: W, fightSeconds: F, ...o });

test('Live-Turm: Wochenplan ist für alle gleich, wechselt die Woche, erstes Stockwerk ohne Eigenschaft', () => {
  const a = L.weekPlan('2026-10-04', TOWER.floors);
  const b = L.weekPlan('2026-10-04', TOWER.floors);
  const c = L.weekPlan('2026-10-11', TOWER.floors);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a[0].trait, null);
  for (let i = 1; i < a.length; i++) {
    assert.notEqual(a[i].key, a[i - 1].key);
    assert.ok(L.traitByKey[a[i].trait]);
    assert.equal(TOWER.floors.find((f) => f.key === a[i].key).stat, a[i].stat);
  }
  // alle Eigenschaften kommen in der Woche vor
  assert.equal(new Set(a.slice(1).map((x) => x.trait)).size, L.TRAITS.length);
});

test('Live-Turm: Bock-Abzug am Kampfbeginn und zur Halbzeit; bei 0 % zählt die Karte nicht', () => {
  const r = L.playFight([sim(), sim(), sim()], [100, 100, 17.5], [10, 10, 10], opts({ rand: () => 0.99 }));
  assert.equal(r.drains.length, 2);
  assert.deepEqual(r.drains.map((d) => d.t), [0, W / 2]);
  assert.equal(r.drains[0].amount, L.DRAIN);
  // rand 0.99 → letzter lebender Spieler (Index 2) verliert zuerst und fällt auf 0
  assert.equal(r.bock[2], 0);
  assert.ok(!r.ticks.some((t) => t.m === 2));
  assert.equal(r.success, false);
});

test('Live-Turm: Boost +20 % nur im Zeitfenster, Bannkreis hebt ihn auf, Fluch trifft die stärkste Karte', () => {
  const base = L.playFight([sim(), sim(), sim()], [100, 100, 100], [10, 10, 10], opts({ rand: () => 0.5 }));
  const boosted = L.playFight([sim(), sim(), sim()], [100, 100, 100], [10, 10, 10], opts({ rand: () => 0.5, boostUntil: [40, 40, 40] }));
  assert.ok(boosted.total > base.total);
  assert.ok(boosted.ticks.every((t) => t.boost));
  const half = L.playFight([sim(), sim(), sim()], [100, 100, 100], [10, 10, 10], opts({ rand: () => 0.5, boostUntil: [10, 0, 0] }));
  assert.ok(half.ticks.filter((t) => t.m === 0 && t.boost).every((t) => (t.t * F) / W < 10));
  const bann = L.playFight([sim(), sim(), sim()], [100, 100, 100], [10, 10, 10], opts({ rand: () => 0.5, boostUntil: [40, 40, 40], trait: 'bannkreis' }));
  assert.equal(bann.total, base.total);
  const fluch = L.playFight([sim(), sim(), sim()], [100, 100, 100], [30, 10, 10], opts({ rand: () => 0.5, trait: 'fluch' }));
  assert.ok(fluch.ticks.filter((t) => t.m === 0).every((t) => t.p === 8));
});

test('Live-Turm: Dieb trifft die stärkste Karte, Blutdurst doppelt, Panzer erhöht das Ziel, Wut kürzt die Zeit', () => {
  const dieb = L.playFight([sim(), sim(), sim()], [100, 100, 100], [10, 50, 20], opts({ trait: 'dieb' }));
  assert.ok(dieb.drains.every((d) => d.m === 1));
  const blut = L.playFight([sim(), sim(), sim()], [100, 100, 100], [10, 10, 10], opts({ trait: 'blutdurst', rand: () => 0 }));
  assert.equal(blut.drains[0].amount, L.DRAIN * 2);
  assert.equal(L.effectiveRequired(1000, 'panzer'), 1150);
  assert.equal(L.effectiveRequired(1000, 'dieb'), 1000);
  const wut = L.playFight([sim(), sim(), sim()], [100, 100, 100], [10, 10, 10], opts({ trait: 'wut', rand: () => 0.5 }));
  assert.ok(wut.limit < W);
  assert.ok(wut.ticks.every((t) => t.t <= wut.limit));
});

test('Live-Turm: Verlängerung bringt mehr Takte, Zeitfresser halbiert sie', () => {
  const s = () => [sim(17), sim(17), sim(17)];
  const none = L.playFight(s(), [100, 100, 100], [10, 10, 10], opts({ rand: () => 0.5 }));
  const ext = L.playFight(s(), [100, 100, 100], [10, 10, 10], opts({ rand: () => 0.5, ext: 7 }));
  const eat = L.playFight(s(), [100, 100, 100], [10, 10, 10], opts({ rand: () => 0.5, ext: 7, trait: 'zeitfresser' }));
  assert.ok(ext.ticks.length > eat.ticks.length);
  assert.ok(eat.ticks.length >= none.ticks.length);
  assert.ok(ext.limit > none.limit);
});

test('Live-Turm: Fähigkeiten – Kosten mit Überladung, Boost-Varianten schließen sich aus, Energie reicht nicht', () => {
  let r = L.toggleChoice([], 8, { key: 'boost', by: 0 });
  assert.equal(L.spentOf(r.chosen), 3);
  r = L.toggleChoice(r.chosen, 8, { key: 'verl', by: 1 });
  assert.equal(L.spentOf(r.chosen), 3 + 3 + 1);
  // Einzel-Boost ersetzt den Boost für alle
  r = L.toggleChoice(r.chosen, 8, { key: 'einzel', by: 2, target: 1 });
  assert.deepEqual(r.chosen.map((c) => c.key), ['verl', 'einzel']);
  assert.equal(L.spentOf(r.chosen), 3 + 1 + 1);
  // gleiche Wahl noch einmal = abwählen
  r = L.toggleChoice(r.chosen, 8, { key: 'einzel', by: 0, target: 1 });
  assert.deepEqual(r.chosen.map((c) => c.key), ['verl']);
  assert.equal(L.toggleChoice([], 2, { key: 'boost', by: 0 }).error, 'Zu wenig Energie.');
  assert.ok(L.toggleChoice([], 8, { key: 'einzel', by: 0 }).error);
  assert.ok(L.toggleChoice([], 8, { key: 'quatsch', by: 0 }).error);
  // Kartenwechsel: einmal pro Spieler und Pause
  const sw = L.addSwitch([], 8, 1);
  assert.equal(L.spentOf(sw.chosen), 2);
  assert.ok(L.addSwitch(sw.chosen, 8, 1).error);
});

test('Live-Turm: Boost beginnt mit dem Kampf und bleibt, Verlängerung und Energie danach', () => {
  const chosen = [{ key: 'einzel', by: 0, target: 2 }, { key: 'verl', by: 1 }];
  const a = L.applyChoices(chosen, 8, [0, 5000, 0], 1000);
  assert.deepEqual(a.boostUntil, [0, 5000, 1000 + L.BOOST_SECONDS * 1000]);
  assert.equal(a.ext, L.EXT_SECONDS);
  assert.equal(a.energy, 8 - (1 + 3 + 1));
});

test('eSports-Liga: Gleichstand bei den Stockwerken – die Punkte entscheiden', () => {
  const rows = league.rankWeek([
    { id: 'a', prevRank: null, runs: [{ rounds: 13, points: 30000 }, { rounds: 14, points: 38000 }, { rounds: 2, points: 99999 }] },
    { id: 'b', prevRank: null, runs: [{ rounds: 14, points: 36000 }, { rounds: 13, points: 29000 }] },
    { id: 'c', prevRank: null, runs: [{ rounds: 10, points: 1000 }] },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.rank, r.score]), [['a', 1, 27], ['b', 2, 27], ['c', 3, 10]]);
  assert.equal(rows[0].points, 68000);
  // gleiche Stockwerke und Punkte: Platz geteilt
  const tie = league.rankWeek([{ id: 'x', runs: [{ rounds: 5, points: 10 }] }, { id: 'y', runs: [{ rounds: 5, points: 10 }] }]);
  assert.deepEqual(tie.map((r) => r.rank), [1, 1]);
  // alte Form (nur Runden) geht weiter
  assert.equal(league.rankWeek([{ id: 'z', rounds: [3, 4, 1] }])[0].score, 7);
});
