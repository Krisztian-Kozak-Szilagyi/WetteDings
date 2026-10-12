process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const { simulate, WORK_TIME } = require('../src/ihk/ihkService');
const { resolveAll, canBoost, DIO_STEP, DIO_FORTUNA, DIO_MAX, DIO_JACKPOT, DIO_REROLL, DIO_COIN } = require('../src/ihk/abilities');
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
// Zufall mit festen Würfeln vorweg: die ersten Werte sind Augenzahlen (1–6), danach geht es mit seeded weiter
function withDice(faces, seed) {
  const rest = seeded(seed);
  const queue = faces.map((f) => (f - 0.5) / 6);
  return () => (queue.length ? queue.shift() : rest());
}

const dio = catalog.cardById['lucky-dio-boss'];
const kaffee = catalog.cardById['casino-kaffee-6-glitch'];
const sumOf = (d) => d[0] + d[1];

// Prüft die Krit-Kette: Multiplikator ×2, ×3 … bis DIO_MAX (+curse), der DIO_JACKPOT-te Krit ist ein Jackpot
function checkChain(r, curse = 0) {
  let streak = 0;
  let crits = 0;
  for (const x of r.ticks) {
    if (x.ability) continue;
    if (!x.crit) {
      assert.equal(x.chain, undefined);
      assert.equal(x.mult, undefined);
      streak = 0;
      continue;
    }
    streak += 1;
    crits += 1;
    assert.equal(x.chain, streak, 'Krit-Kette zählt mit');
    let mult = Math.min(DIO_MAX, 1 + streak) + curse;
    if (crits === DIO_JACKPOT) mult = Math.max(mult, DIO_JACKPOT);
    assert.equal(x.mult, mult > 2 ? mult : undefined, `Multiplikator bei Kette ${streak}`);
    assert.equal(!!x.jackpot, crits === DIO_JACKPOT, 'Jackpot genau beim 7. Krit');
  }
  return crits;
}

test('Lucky Dio: Season-1-Boss-Karte mit violettem Rahmen, Beute aus Chaos & Demise', () => {
  assert.ok(dio, 'Karte fehlt im Katalog');
  assert.equal(dio.name, 'Lucky Dio');
  assert.equal(dio.rarity, 'boss');
  assert.equal(dio.season, 'season-1');
  assert.equal(dio.frame, 'violet');
  assert.deepEqual(dio.stats, { speed: 99, fia: 99, fis: 90, bwl: 95 });
  assert.ok(dio.isCharacter);
  assert.equal(dio.abilityName, 'All In');
  assert.equal(CHAOS.bossCard, 'lucky-dio-boss');
  assert.ok(catalog.CARDS.includes(dio), 'erhältlich (nicht unveröffentlicht)');
  assert.deepEqual([DIO_STEP, DIO_FORTUNA, DIO_MAX, DIO_JACKPOT, DIO_REROLL, DIO_COIN], [4, 3, 5, 7, 9, 15]);
  assert.match(dio.ability, /2W6/);
  assert.match(dio.ability, /Jackpot/);
});

test('Lucky Dio: All In würfelt zu Beginn, wirkt nur einmal und lässt die Deadline unverändert', () => {
  const effects = resolveAll(dio, []);
  const allIn = effects.find((e) => e.key === 'all-in');
  assert.ok(allIn && allIn.passive);
  const r = simulate(dio.stats, 'fia', 99999, withDice([4, 3], 1), effects);
  assert.deepEqual(r.ticks[0], { t: 0, p: 0, ability: true, dice: [[4, 3]] });
  assert.ok(!r.ticks.some((x) => x.ability && x.t > 0), 'keine zweite Aktivierung zur Halbzeit');
  assert.ok(r.ticks[r.ticks.length - 1].t <= WORK_TIME + 1e-6);
});

test('Lucky Dio: je Auge mehr Krit-Chance, Krit-Kette bis ×5 und der 7. Krit ist ein Jackpot', () => {
  const effects = resolveAll(dio, []);
  const rate = (faces) => {
    let hits = 0;
    let crits = 0;
    let jackpots = 0;
    for (let i = 0; i < 400; i++) {
      const r = simulate(dio.stats, 'fia', 99999, withDice(faces, i + 10), effects);
      checkChain(r);
      if (r.ticks.some((x) => x.jackpot)) jackpots++;
      r.ticks.filter((x) => !x.ability).forEach((x) => { hits++; if (x.crit) crits++; });
    }
    return { crit: crits / hits, jackpots };
  };
  const low = rate([2, 1]);
  const mid = rate([4, 3]);
  const high = rate([6, 5]);
  assert.ok(Math.abs(low.crit - (0.1 + (3 * DIO_STEP) / 100)) < 0.03, `Summe 3: ${low.crit}`);
  assert.ok(Math.abs(mid.crit - (0.1 + (7 * DIO_STEP) / 100)) < 0.03, `Summe 7: ${mid.crit}`);
  assert.ok(Math.abs(high.crit - (0.1 + (11 * DIO_STEP) / 100)) < 0.03, `Summe 11: ${high.crit}`);
  assert.ok(low.jackpots < mid.jackpots && mid.jackpots < high.jackpots, 'mehr Augen = öfter Jackpot');
});

test('Lucky Dio: Doppelsechs (Fortunas Liebling) gibt 3 sichere Krits zum Start', () => {
  const effects = resolveAll(dio, []);
  for (let i = 0; i < 100; i++) {
    const r = simulate(dio.stats, 'fia', 99999, withDice([6, 6], i), effects);
    const hits = r.ticks.filter((x) => !x.ability);
    assert.ok(hits.slice(0, DIO_FORTUNA).every((x) => x.crit), 'die ersten Runden sind Krits');
    checkChain(r);
  }
});

test('Lucky Dio: Schlangenaugen (Verfluchtes Glück) – jeder Krit trifft eine Stufe höher', () => {
  const effects = resolveAll(dio, []);
  let crits = 0;
  for (let i = 0; i < 300; i++) crits += checkChain(simulate(dio.stats, 'fia', 99999, withDice([1, 1], i), effects), 1);
  assert.ok(crits > 0);
});

test('Lucky Dio + Casino-Kaffee (Hausvorteil): unter 9 wird einmal neu gewürfelt, der bessere Wurf zählt', () => {
  const effects = resolveAll(dio, [kaffee]);
  assert.ok(effects.some((e) => e.key === 'hausvorteil' && e.passive));
  assert.deepEqual(simulate(dio.stats, 'fia', 99999, withDice([2, 3, 6, 4], 1), effects).ticks[0].dice, [[2, 3], [6, 4]]);
  assert.deepEqual(simulate(dio.stats, 'fia', 99999, withDice([4, 4, 1, 2], 1), effects).ticks[0].dice, [[4, 4], [4, 4]], 'schlechterer Neuwurf zählt nicht');
  assert.deepEqual(simulate(dio.stats, 'fia', 99999, withDice([5, 4], 1), effects).ticks[0].dice, [[5, 4]], 'ab 9 kein Neuwurf');
  // ohne Kaffee nie ein Neuwurf
  assert.deepEqual(simulate(dio.stats, 'fia', 99999, withDice([1, 2], 1), resolveAll(dio, [])).ticks[0].dice, [[1, 2]]);
});

test('Lucky Dio: stark, aber fair – stärkste Einzelkarte, mit bestem Boost unter Glitch-Krisz mit Lili', () => {
  const avg = (main, boosts, seed) => {
    const effects = resolveAll(main, boosts);
    let sum = 0;
    for (let i = 0; i < 1500; i++) sum += simulate(main.stats, ['fia', 'fis', 'bwl'][i % 3], 1e9, seeded(seed + i), effects).total;
    return sum / 1500;
  };
  const ivan = catalog.cardById['st-ivan-boss'];
  const krisz = catalog.cardById['krisz-6-glitch'];
  const lili = catalog.cardById['lili-6-glitch'];
  const mauch = catalog.cardById['mauch-4-icon'];
  const d = avg(dio, [], 1000);
  const kl = avg(krisz, [lili], 3000);
  assert.ok(d > avg(ivan, [], 2000) * 1.25, `Dio ${d} zu schwach`);
  assert.ok(avg(dio, [kaffee], 4000) < kl, 'Dio + Casino-Kaffee zu stark');
  assert.ok(avg(dio, [mauch], 5000) < kl, 'Dio + Mauch zu stark');
});

test('Lucky Dio ohne die Fähigkeit: keine Würfel, keine Kette', () => {
  const r = simulate(dio.stats, 'fia', 99999, seeded(5), []);
  assert.ok(!r.ticks.some((x) => x.dice || x.chain || x.jackpot));
});

test('Lucky Dio als Booster: Glücksmünze zur Halbzeit – Kopf +15 % Krit-Chance, Zahl nichts', () => {
  const marcel = catalog.cardById['marcel-6-glitch'];
  assert.ok(canBoost(dio), 'Dio darf in den Boost-Slot');
  const effects = resolveAll(marcel, [dio]);
  assert.ok(effects.some((e) => e.key === 'gluecksmuenze' && !e.passive));
  assert.ok(!effects.some((e) => e.key === 'all-in'));
  const after = { kopf: [0, 0], zahl: [0, 0] };
  for (let i = 0; i < 600; i++) {
    const r = simulate(marcel.stats, 'fia', 99999, seeded(i + 500), effects);
    const coin = r.ticks.find((x) => x.ability).coin;
    assert.ok(coin === 'kopf' || coin === 'zahl');
    assert.ok(!r.ticks.some((x) => x.dice || x.chain), 'keine Würfel und keine Kette beim Boosten');
    r.ticks.filter((x) => !x.ability && x.t > WORK_TIME / 2).forEach((x) => { after[coin][0]++; if (x.crit) after[coin][1]++; });
  }
  assert.ok(Math.abs(after.kopf[1] / after.kopf[0] - (0.1 + DIO_COIN / 100)) < 0.04, 'Kopf: mehr Krits');
  assert.ok(Math.abs(after.zahl[1] / after.zahl[0] - 0.1) < 0.04, 'Zahl: normale Krits');
});
