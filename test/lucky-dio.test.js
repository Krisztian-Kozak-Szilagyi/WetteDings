process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const { simulate, WORK_TIME } = require('../src/ihk/ihkService');
const { resolveAll, canBoost, DIO_CRIT, DIO_STACKS, DIO_STACK_SECONDS } = require('../src/ihk/abilities');
const { CHAOS } = require('../src/dungeon/dungeons');

// Fester Zufall (mulberry32), damit die Simulation im Test immer gleich ausgeht
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dio = catalog.cardById['lucky-dio-boss'];

test('Lucky Dio: Season-1-Boss-Karte mit violettem Rahmen, Beute aus Chaos & Demise', () => {
  assert.ok(dio, 'Karte fehlt im Katalog');
  assert.equal(dio.name, 'Lucky Dio');
  assert.equal(dio.rarity, 'boss');
  assert.equal(dio.season, 'season-1');
  assert.equal(dio.frame, 'violet');
  assert.deepEqual(dio.stats, { speed: 99, fia: 99, fis: 90, bwl: 95 });
  assert.ok(dio.isCharacter);
  assert.equal(dio.abilityName, 'High Stakes');
  assert.equal(CHAOS.bossCard, 'lucky-dio-boss');
  assert.ok(catalog.CARDS.includes(dio), 'erhältlich (nicht unveröffentlicht)');
  assert.deepEqual([DIO_CRIT, DIO_STACKS, DIO_STACK_SECONDS], [30, 7, 3]);
  assert.match(dio.ability, /7 Stacks/);
});

test('Lucky Dio: High Stakes wirkt von Anfang an, kein Doppelschlag mehr', () => {
  const effects = resolveAll(dio, []);
  const hs = effects.find((e) => e.key === 'high-stakes');
  assert.ok(hs && hs.passive);
  const r = simulate(dio.stats, 'fia', 99999, seeded(1), effects);
  assert.deepEqual(r.ticks[0], { t: 0, p: 0, ability: true });
  assert.ok(!r.ticks.some((x) => x.ability && x.t > 0), 'keine zweite Aktivierung zur Halbzeit');
  assert.ok(!r.ticks.some((x) => x.combo), 'Doppelschlag gibt es nicht mehr');
});

test('Lucky Dio: jeder Krit gibt einen Stack, bei 7 Stacks +3 s Deadline und wieder von vorn', () => {
  const effects = resolveAll(dio, []);
  let hits = 0;
  let crits = 0;
  let bonuses = 0;
  for (let i = 0; i < 300; i++) {
    const r = simulate(dio.stats, 'fia', 99999, seeded(i + 10), effects);
    let expect = 0;
    for (const x of r.ticks) {
      if (x.ability) continue;
      hits++;
      if (!x.crit) {
        assert.equal(x.stack, undefined, 'Stack ohne Krit');
        continue;
      }
      crits++;
      expect += 1;
      assert.equal(x.stack, expect, 'Stacks zählen je Krit hoch');
      if (expect === DIO_STACKS) {
        assert.equal(x.bonus, DIO_STACK_SECONDS);
        expect = 0;
      } else assert.equal(x.bonus, undefined);
    }
    bonuses += r.bonusAt.length;
    assert.equal(r.bonus, r.bonusAt.length * DIO_STACK_SECONDS);
    // die Deadline läuft um die gewonnene Zeit länger
    assert.ok(r.ticks[r.ticks.length - 1].t <= WORK_TIME + r.bonus + 1e-6);
  }
  assert.ok(bonuses > 0, 'nie 7 Stacks erreicht');
  assert.ok(Math.abs(crits / hits - 0.4) < 0.03, `Krit-Quote ${crits / hits}`); // 10 % + 30 %
});

test('Lucky Dio: ohne die Fähigkeit wie jede andere Karte (keine Stacks, keine Verlängerung)', () => {
  const r = simulate(dio.stats, 'fia', 99999, seeded(5), []);
  assert.ok(!r.ticks.some((x) => x.stack));
  assert.equal(r.bonus, 0);
});

test('Lucky Dio als Booster: +30 % Krit-Chance für die geboostete Karte, aber keine Stacks', () => {
  const krisz = catalog.cardById['krisz-6-glitch'];
  assert.ok(canBoost(dio), 'Dio darf in den Boost-Slot');
  const effects = resolveAll(krisz, [dio]);
  assert.ok(effects.some((e) => e.key === 'high-stakes-boost'));
  assert.ok(!effects.some((e) => e.key === 'high-stakes'));
  let hits = 0;
  let crits = 0;
  for (let i = 0; i < 300; i++) {
    const r = simulate(krisz.stats, 'fia', 99999, seeded(i + 500), effects);
    assert.ok(!r.ticks.some((x) => x.stack), 'Stacks beim Boosten');
    assert.equal(r.bonus, 0);
    r.ticks.filter((x) => !x.ability).forEach((x) => { hits++; if (x.crit) crits++; });
  }
  assert.ok(Math.abs(crits / hits - 0.4) < 0.03, `Krit-Quote ${crits / hits}`);
});
