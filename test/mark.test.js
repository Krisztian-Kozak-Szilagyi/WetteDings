// Mark, the Suntouched: Fähigkeit „Sonnendurchbruch“ zur Halbzeit – Quest und Dungeon mehr Zeit, Mage Tower Bock,
// danach alle Werte +5 für die ganze Gruppe. Dazu: alle Charaktere gleich schnell, keine Speed-Plakette mehr.
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';
const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const cardSvg = require('../src/tcg/cardSvg');
const { simulate, WORK_TIME } = require('../src/ihk/ihkService');
const { resolve, MARK } = require('../src/ihk/abilities');
const dungeon = require('../src/dungeon/dungeonService');
const L = require('../src/dungeon/liveTower');

const avg = () => 0.5;
const card = (id) => catalog.cardById[id];
const RARITIES = ['crumpled', 'bfwler', 'gold', 'holo', 'bockhaber', 'glitch'];

test('Mark, the Suntouched: sechs Seltenheiten, Season 1, Vollbild-Layout, gleicher Titel', () => {
  RARITIES.forEach((r, i) => {
    const c = card(`mark-${i + 1}-${r}`);
    assert.ok(c && catalog.CARDS.includes(c), r);
    assert.equal(c.name, 'Mark');
    assert.equal(c.title, 'Mark, the Suntouched');
    assert.equal(c.season, 'season-1');
    assert.equal(c.frame, `rar-${r}`);
    assert.equal(c.abilityName, 'Sonnendurchbruch');
    assert.ok(c.isCharacter);
    const svg = cardSvg.render(c).replace(/<image[^>]*\/>/, '');
    for (const t of ['Mark, the Suntouched', 'Sonnendurchbruch', 'Bock', '>FIA<']) assert.ok(svg.includes(t), `${r}: ${t}`);
  });
});

test('Einheitliches Tempo: jeder Charakter hat SPEED, Items behalten ihren Wert, keine Speed-Plakette', () => {
  for (const c of catalog.CARDS.filter((x) => x.isCharacter)) assert.equal(c.stats.speed, catalog.SPEED, c.id);
  assert.ok(card('casino-kaffee-3-gold').stats.speed > 0 && !card('casino-kaffee-3-gold').isCharacter);
  const svg = cardSvg.render(card('omer-3-gold')).replace(/<image[^>]*\/>/, '');
  assert.ok(!svg.includes(`>${catalog.SPEED}<`), 'Speed steht nicht mehr auf der Karte');
});

test('Quest: zur Halbzeit 50 % der Gesamtzeit mehr und alle Werte +5', () => {
  const mark = card('mark-3-gold');
  const plain = simulate(mark.stats, 'fia', 1e9, avg);
  const sun = simulate(mark.stats, 'fia', 1e9, avg, resolve(mark, null));
  assert.equal(plain.freeze, 0);
  assert.equal(sun.freeze, MARK.time * WORK_TIME);
  const st = sun.ticks.find((t) => t.ability).st;
  assert.deepEqual(st.slice(1), [mark.stats.fia + 5, mark.stats.fis + 5, mark.stats.bwl + 5]);
  assert.ok(sun.ticks.length > plain.ticks.length, 'mehr Zeit = mehr Takte');
});

test('Dungeon: Mark als Hauptkarte stärkt die ganze Gruppe und verlängert die Zeit', () => {
  const members = [{ card: card('mark-3-gold'), boost: null }, { card: card('luca-3-gold'), boost: null }, { card: card('aleks-3-gold'), boost: null }];
  for (let m = 0; m < 3; m++) assert.ok(dungeon.teamEffects(members, m).some((e) => e.key === 'sonnendurchbruch' && e.from === 0), `Spieler ${m}`);
  const without = dungeon.fight(members.map((x, i) => (i === 0 ? { card: card('luca-1-crumpled'), boost: null } : x)), 'fis', 1e9, avg);
  const withMark = dungeon.fight(members, 'fis', 1e9, avg);
  assert.equal(without.limit, WORK_TIME);
  assert.equal(withMark.limit, WORK_TIME * (1 + MARK.time));
  assert.ok(withMark.abilities.filter((a) => a.label === 'Sonnendurchbruch').length === 3);
});

test('Mage Tower: keine Zeitverlängerung, aber Werte +5 (simulierter Turm)', () => {
  const mark = card('mark-3-gold');
  const r = simulate(mark.stats, 'fia', 1e9, avg, resolve(mark, null), 'tower');
  assert.equal(r.freeze, 0);
  assert.equal(r.ticks.find((t) => t.ability).st[1], mark.stats.fia + 5);
  const members = [{ card: mark, boost: null }, { card: card('luca-3-gold'), boost: null }, { card: card('aleks-3-gold'), boost: null }];
  const runs = dungeon.playTower(members, avg, undefined, 1);
  assert.equal(runs[0].limit, WORK_TIME);
});

test('Live-Turm: zur Halbzeit nach dem Boss-Treffer +30 % Bock für alle – nicht, wenn Marks Karte keinen Bock mehr hat', () => {
  const sims = [0, 1, 2].map(() => ({ ticks: [{ t: 30, p: 1 }, { t: 120, p: 1 }], freeze: 0, extend: 0, speed: catalog.SPEED }));
  const o = { required: 1e9, trait: null, boostUntil: [], ext: 0, rand: () => 0, workTime: WORK_TIME, fightSeconds: 30, refills: [{ from: 0, pct: MARK.refill }] };
  const r = L.playFight(sims, [100, 50, 10], [10, 10, 10], o);
  // rand = 0 → Boss trifft beide Male Spieler 0 (−17,5), danach +30 für alle (höchstens 100)
  assert.deepEqual(r.bock, [95, 80, 40]);
  const refills = r.drains.filter((d) => d.refill);
  assert.equal(refills.length, 3);
  assert.ok(refills.every((d) => d.t === WORK_TIME / 2 && d.amount === MARK.refill));
  // Spieler 0 (Mark) hat zur Halbzeit keinen Bock mehr → kein Auffüllen
  const dead = L.playFight(sims, [17.5, 50, 0], [10, 10, 10], o);
  assert.ok(!dead.drains.some((d) => d.refill));
  // auch ein Spieler ohne Bock (0 %) kommt mit dem Auffüllen zurück
  const revive = L.playFight(sims, [100, 50, 0], [10, 10, 10], o);
  assert.equal(revive.bock[2], 30);
});
