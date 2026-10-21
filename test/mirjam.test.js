// Mirjam, the Gracebringer: Fähigkeit „Alles Pink!“ – zur Halbzeit verdoppelt sich der niedrigste Wert, bei ihr und
// (im Dungeon und Turm) bei jedem Gruppenmitglied.
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';
const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const cardSvg = require('../src/tcg/cardSvg');
const { simulate } = require('../src/ihk/ihkService');
const { resolve } = require('../src/ihk/abilities');
const dungeon = require('../src/dungeon/dungeonService');

const avg = () => 0.5;
const card = (id) => catalog.cardById[id];

test('Mirjam, the Gracebringer: sechs Seltenheiten, Season 1, Vollbild-Layout', () => {
  ['crumpled', 'bfwler', 'gold', 'holo', 'bockhaber', 'glitch'].forEach((r, i) => {
    const c = card(`mirjam-${i + 1}-${r}`);
    assert.ok(c && catalog.CARDS.includes(c), r);
    assert.equal(c.name, 'Mirjam');
    assert.equal(c.title, 'Mirjam, the Gracebringer');
    assert.equal(c.season, 'season-1');
    assert.equal(c.abilityName, 'Alles Pink!');
    assert.ok(c.isCharacter);
    const svg = cardSvg.render(c).replace(/<image[^>]*\/>/, '');
    for (const t of ['Mirjam, the Gracebringer', 'Alles Pink!', 'niedrigsten']) assert.ok(svg.includes(t), `${r}: ${t}`);
  });
});

test('Alles Pink!: der niedrigste Wert verdoppelt sich zur Halbzeit (bei Gleichstand der erste)', () => {
  const [a] = resolve(card('mirjam-3-gold'), null).filter((e) => e.key === 'alles-pink');
  const s = { stats: { fia: 30, fis: 12, bwl: 40 } };
  a.apply(s);
  assert.deepEqual(s.stats, { fia: 30, fis: 24, bwl: 40 });
  const tie = { stats: { fia: 20, fis: 20, bwl: 20 } };
  a.apply(tie);
  assert.deepEqual(tie.stats, { fia: 40, fis: 20, bwl: 20 });
  const mirjam = card('mirjam-3-gold');
  const r = simulate(mirjam.stats, 'fia', 1e9, avg, resolve(mirjam, null));
  assert.deepEqual(r.ticks.find((t) => t.ability).st.slice(1), [50, 25, 25]);
});

test('Dungeon: Mirjam als Hauptkarte verdoppelt bei jedem Gruppenmitglied dessen niedrigsten Wert', () => {
  const luca = card('luca-3-gold'); // BWL ist sein höchster, FIS der niedrigste
  const members = [{ card: card('mirjam-3-gold'), boost: null }, { card: luca, boost: null }, { card: card('aleks-3-gold'), boost: null }];
  for (let m = 0; m < 3; m++) assert.ok(dungeon.teamEffects(members, m).some((e) => e.key === 'alles-pink' && e.from === 0), `Spieler ${m}`);
  const r = simulate(luca.stats, 'fis', 1e9, avg, dungeon.teamEffects(members, 1), 'dungeon');
  const low = Math.min(luca.stats.fia, luca.stats.fis, luca.stats.bwl);
  const st = r.ticks.find((t) => t.ability).st;
  assert.ok(st.slice(1).includes(low * 2));
});
