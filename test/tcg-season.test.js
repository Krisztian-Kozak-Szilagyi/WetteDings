process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const cardSvg = require('../src/tcg/cardSvg');
const CARD_DATA = require('../src/tcg/cardData');
const FRAMES = require('../src/tcg/frames');

const boss = () => catalog.cardById['st-ivan-boss'];

test('Boss-Seltenheit: nur Beute, nie aus Packs, die Bank kauft sie nicht', () => {
  const r = catalog.rarityByKey.boss;
  assert.ok(r && r.dropOnly && r.noBank);
  assert.ok(!catalog.RARITIES.includes(r), 'gehört nicht zu den Pack-Seltenheiten');
  assert.equal(catalog.RARITIES.reduce((s, x) => s + x.weight, 0), catalog.TOTAL_WEIGHT);
  assert.ok(r.rank > catalog.rarityByKey.sith.rank, 'seltener als Sith');
  assert.ok(catalog.visibleRarities().includes(r), 'im Album-Filter sichtbar');
  // auch der höchste Wurf landet in einer Pack-Seltenheit
  assert.notEqual(catalog.rarityForRoll(catalog.TOTAL_WEIGHT - 1), 'boss');
  for (let i = 0; i < 2000; i++) assert.notEqual(catalog.drawCard().rarity, 'boss');
});

test('St. Ivan (Boss): Season 1, Rahmen-Karte mit Werten aus cardData.js', () => {
  const c = boss();
  assert.ok(c, 'Bild public/img/tcg/st-ivan-boss.webp fehlt');
  assert.equal(c.rarity, 'boss');
  assert.equal(c.season, 'season-1');
  assert.equal(c.name, 'St. Ivan, the Forsaken');
  assert.equal(c.frame, 'gilded');
  assert.deepEqual(c.stats, { speed: 96, fia: 95, fis: 99, bwl: 90 });
  assert.ok(c.isCharacter, 'kann auf Quests und in den Dungeon');
  assert.match(c.image, /^\/img\/tcg\/karte\/st-ivan-boss\.svg\?v=[0-9a-f]{10}$/);
  assert.ok(catalog.cardsBySeason['season-1'].includes(c));
});

test('Alle anderen Karten gehören zur Pre-Season', () => {
  const others = catalog.CARDS.filter((c) => !CARD_DATA[c.id]);
  assert.ok(others.length > 50);
  assert.ok(others.every((c) => c.season === 'pre-season' && !c.frame));
  assert.equal(catalog.cardsBySeason['pre-season'].length + catalog.cardsBySeason['season-1'].length, catalog.CARDS.length);
});

test('cardData.js: jede Karte hat Bild, gültige Season, Rahmen und vier Werte', () => {
  for (const [id, d] of Object.entries(CARD_DATA)) {
    assert.ok(catalog.cardById[id], `${id}: kein passendes Bild in public/img/tcg`);
    assert.ok(catalog.seasonByKey[d.season], `${id}: unbekannte Season`);
    assert.ok(FRAMES[d.frame], `${id}: unbekannter Rahmen`);
    assert.ok(Array.isArray(d.stats) && d.stats.length === 4 && d.stats.every((v) => Number.isInteger(v) && v >= 0 && v <= 999), `${id}: Werte`);
  }
});

test('Bild-URL mit abweichenden Werten (Boost): nur geänderte, begrenzt auf 0 … 999', () => {
  const c = boss();
  const plain = catalog.cardImage(c);
  assert.equal(catalog.cardImage(c, { fia: 95 }), plain, 'gleicher Wert = gleiche URL');
  assert.match(catalog.cardImage(c, { fia: 110, bwl: 80 }), /\?fia=110&bwl=80&v=/);
  assert.match(catalog.cardImage(c, { speed: 5000 }), /\?speed=999&/);
});

test('SVG: Werte im Rahmen, Boost farbig, Text maskiert', () => {
  const c = boss();
  const base = cardSvg.render(c);
  assert.ok(base.startsWith('<svg') && base.includes('data:image/webp;base64,'));
  for (const v of ['>96<', '>95<', '>99<', '>90<', '>FIA<', '>FIS<', '>BWL<']) assert.ok(base.includes(v), v);
  const { colors } = FRAMES.gilded;
  assert.ok(!base.includes(colors.up) && !base.includes(colors.down));
  const boosted = cardSvg.render(c, { fia: 110, bwl: 80 });
  assert.ok(boosted.includes(`fill="${colors.up}" stroke-width="4" font-family="Georgia`) && boosted.includes('>110<'));
  assert.ok(boosted.includes(colors.down) && boosted.includes('>80<'));
  const evil = cardSvg.render({ ...c, name: '<x>', ability: 'a <script>"&' });
  assert.ok(!evil.includes('<script>') && !evil.includes('<x>') && evil.includes('&lt;script&gt;&quot;&amp;'));
});

test('SVG: langer Fähigkeitstext wird kleiner und umbrochen, bis er ins Fenster passt', () => {
  const box = FRAMES.gilded.text;
  const short = cardSvg.fitText('Kurz.', box);
  assert.equal(short.size, box.size);
  assert.equal(short.lines.length, 1);
  const long = cardSvg.fitText('Wort '.repeat(80), box);
  assert.ok(long.size < box.size && long.size >= box.minSize);
  assert.ok(long.lines.length > 2);
  assert.ok(long.size === box.minSize || long.lines.length * long.size * box.lineHeight <= box.h);
});

test('SVG-Werte aus der Query: nur ganze Zahlen bis 999', () => {
  assert.deepEqual(cardSvg.valuesFromQuery({ fia: '110', fis: '-3', bwl: '1e3', speed: '1000' }), { fia: 110 });
  assert.deepEqual(cardSvg.valuesFromQuery({ fia: ['1', '2'] }), {});
  assert.deepEqual(cardSvg.valuesFromQuery(undefined), {});
});
