process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const { simulate, WORK_TIME } = require('../src/ihk/ihkService');
const { resolveAll, canBoost, DIO_HEADS, DIO_TOKEN, DIO_CHAIN, DIO_COIN } = require('../src/ihk/abilities');
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
const attacks = (r) => r.ticks.filter((x) => !x.ability && !x.coin); // normale Angriffe
const coins = (r) => r.ticks.filter((x) => !x.ability && x.coin); // Zusatztreffer aus dem Münzwurf

test('Lucky Dio: Season-1-Boss-Karte mit violettem Rahmen, Beute aus Chaos & Demise', () => {
  assert.ok(dio, 'Karte fehlt im Katalog');
  assert.equal(dio.name, 'Lucky Dio');
  assert.equal(dio.rarity, 'boss');
  assert.equal(dio.season, 'season-1');
  assert.equal(dio.frame, 'violet');
  assert.deepEqual(dio.stats, { speed: 99, fia: 99, fis: 90, bwl: 95 });
  assert.ok(dio.isCharacter);
  assert.equal(dio.abilityName, 'Krit-Lotterie');
  assert.equal(CHAOS.bossCard, 'lucky-dio-boss');
  assert.ok(catalog.CARDS.includes(dio), 'erhältlich (nicht unveröffentlicht)');
  assert.deepEqual([DIO_HEADS, DIO_TOKEN, DIO_CHAIN, DIO_COIN], [50, 1, 1, 15]);
  assert.match(dio.ability, /Münze/);
  assert.match(dio.ability, /Armbrust/);
  assert.match(dio.ability, /Glücks-Token/);
});

test('Lucky Dio: nach jedem Angriff ein Zusatztreffer aus dem Münzwurf, ab dem ersten Angriff', () => {
  const effects = resolveAll(dio, []);
  assert.ok(effects.some((e) => e.key === 'krit-lotterie' && e.passive));
  const r = simulate(dio.stats, 'fia', 99999, seeded(1), effects);
  assert.deepEqual(r.ticks[0], { t: 0, p: 0, ability: true });
  assert.ok(!r.ticks.some((x) => x.ability && x.t > 0), 'keine zweite Aktivierung zur Halbzeit');
  // auf jeden Angriff folgt sofort genau ein Münz-Treffer
  r.ticks.forEach((x, i) => {
    if (x.ability || x.coin) return;
    const next = r.ticks[i + 1];
    if (!next) return; // Deadline genau nach dem letzten Angriff
    assert.ok(next.coin, 'Angriff ohne Münzwurf');
    assert.ok(next.t - x.t <= 0.35, 'Zusatztreffer kommt nicht sofort');
  });
  assert.ok(Math.abs(attacks(r).length - coins(r).length) <= 1);
});

test('Lucky Dio: Kopf = kritischer Armbrust-Treffer, Zahl = Dolchtreffer und ein Glücks-Token', () => {
  const effects = resolveAll(dio, []);
  let heads = 0;
  let flips = 0;
  for (let i = 0; i < 300; i++) {
    const r = simulate(dio.stats, 'fia', 99999, seeded(i + 10), effects);
    let tokens = 0;
    for (const x of coins(r)) {
      flips++;
      if (x.coin === 'kopf') {
        heads++;
        assert.ok(x.crit, 'Kopf ist ein Krit');
        assert.equal(x.tokens, undefined, 'Kopf gibt keinen Token');
        assert.ok(x.p >= Math.round(dio.stats.fia * 0.8 * 2) - 1, 'Armbrust-Krit trifft doppelt');
      } else {
        tokens += 1;
        assert.ok(!x.crit, 'Zahl ist kein Krit');
        assert.equal(x.tokens, tokens, 'Tokens zählen je Zahl hoch');
        assert.ok(x.p <= Math.round(dio.stats.fia * 1.2) + 1, 'Dolch trifft normal');
      }
    }
  }
  assert.ok(Math.abs(heads / flips - DIO_HEADS / 100) < 0.03, `Kopf-Quote ${heads / flips}`);
});

test('Lucky Dio: jeder Glücks-Token gibt +1 % Krit-Chance auf die normalen Angriffe', () => {
  const effects = resolveAll(dio, []);
  // Krit-Quote der normalen Angriffe je Token-Stand
  const byTokens = {};
  for (let i = 0; i < 2000; i++) {
    const r = simulate(dio.stats, 'fia', 99999, seeded(i + 900), effects);
    let tokens = 0;
    for (const x of r.ticks) {
      if (x.ability) continue;
      if (x.coin) {
        if (x.tokens) tokens = x.tokens;
        continue;
      }
      const k = tokens < 4 ? 'wenig' : 'viele';
      byTokens[k] = byTokens[k] || { n: 0, crit: 0, tok: 0 };
      byTokens[k].n++;
      byTokens[k].tok += tokens;
      if (x.crit) byTokens[k].crit++;
    }
  }
  for (const g of Object.values(byTokens)) {
    const expect = 0.1 + (g.tok / g.n) * (DIO_TOKEN / 100);
    assert.ok(Math.abs(g.crit / g.n - expect) < 0.02, `Krit-Quote ${g.crit / g.n} statt ${expect}`);
  }
  assert.ok(byTokens.viele.crit / byTokens.viele.n > byTokens.wenig.crit / byTokens.wenig.n, 'mehr Tokens, mehr Krits');
});

test('Lucky Dio: stärkste Einzelkarte – rund doppelt so stark wie St. Ivan', () => {
  const avg = (main, seed) => {
    const effects = resolveAll(main, []);
    let sum = 0;
    for (let i = 0; i < 1500; i++) sum += simulate(main.stats, ['fia', 'fis', 'bwl'][i % 3], 1e9, seeded(seed + i), effects).total;
    return sum / 1500;
  };
  const d = avg(dio, 1000);
  const ivan = avg(catalog.cardById['st-ivan-boss'], 2000);
  assert.ok(d > ivan * 1.8 && d < ivan * 2.6, `Dio ${Math.round(d)} gegenüber St. Ivan ${Math.round(ivan)}`);
});

test('Lucky Dio ohne die Fähigkeit: keine Münze, keine Tokens', () => {
  const r = simulate(dio.stats, 'fia', 99999, seeded(5), []);
  assert.ok(!r.ticks.some((x) => x.coin || x.tokens));
});

test('Lucky Dio als Booster: Glücksmünze zur Halbzeit – Kopf +15 % Krit-Chance, Zahl nichts', () => {
  const marcel = catalog.cardById['marcel-6-glitch'];
  assert.ok(canBoost(dio), 'Dio darf in den Boost-Slot');
  const effects = resolveAll(marcel, [dio]);
  assert.ok(effects.some((e) => e.key === 'gluecksmuenze' && !e.passive));
  assert.ok(!effects.some((e) => e.key === 'krit-lotterie'));
  const after = { kopf: [0, 0], zahl: [0, 0] };
  for (let i = 0; i < 600; i++) {
    const r = simulate(marcel.stats, 'fia', 99999, seeded(i + 500), effects);
    const coin = r.ticks.find((x) => x.ability).coin;
    assert.ok(coin === 'kopf' || coin === 'zahl');
    assert.equal(coins(r).length, 0, 'keine Zusatztreffer beim Boosten');
    r.ticks.filter((x) => !x.ability && x.t > WORK_TIME / 2).forEach((x) => { after[coin][0]++; if (x.crit) after[coin][1]++; });
  }
  assert.ok(Math.abs(after.kopf[1] / after.kopf[0] - (0.1 + DIO_COIN / 100)) < 0.04, 'Kopf: mehr Krits');
  assert.ok(Math.abs(after.zahl[1] / after.zahl[0] - 0.1) < 0.04, 'Zahl: normale Krits');
});
