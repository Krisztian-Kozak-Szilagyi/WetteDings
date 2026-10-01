process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const { simulate, generateOffers, WORK_TIME } = require('../src/ihk/ihkService');

test('Angebot: drei verschiedene Quests, jede Schwierigkeit höchstens einmal', () => {
  for (let i = 0; i < 500; i++) {
    const offers = generateOffers();
    assert.equal(offers.length, 3);
    assert.equal(new Set(offers.map((o) => o.quest)).size, 3);
    assert.equal(new Set(offers.map((o) => o.difficulty)).size, 3);
    assert.ok(offers.every((o) => o.difficulty >= 1 && o.difficulty <= 6));
  }
});
const { QUESTS, DIFFICULTIES } = require('../src/ihk/quests');

test('Alle Karten haben Werte; Items sind keine Charaktere', () => {
  for (const c of catalog.CARDS) assert.ok(c.stats, `${c.id} ohne Werte`);
  assert.deepEqual(catalog.cardById['krisz-1-crumpled'].stats, { speed: 36, fia: 39, fis: 21, bwl: 12 });
  assert.equal(catalog.cardById['krisz-1-crumpled'].isCharacter, true);
  for (const id of ['bfw-energy-gold', 'casino-kaffee-3-gold', 'grafikkarte-amd-gold']) assert.equal(catalog.cardById[id].isCharacter, false);
});

test('Fähigkeiten: nur unter den Bedingungen aus dem Kartentext', () => {
  const { resolve } = require('../src/ihk/abilities');
  const c = (id) => catalog.cardById[id];
  const keys = (m, b) => resolve(c(m), b ? c(b) : null).map((a) => a.key);
  // Krisz nur mit Energydrink (BFW Energy), nicht mit Kaffee oder allein
  assert.deepEqual(keys('krisz-3-gold'), []);
  assert.ok(!keys('krisz-3-gold', 'casino-kaffee-3-gold').includes('nachtschicht'));
  assert.ok(keys('krisz-3-gold', 'bfw-energy-gold').includes('nachtschicht'));
  // Ömer wirkt nur als Boost auf die Hauptkarte
  assert.ok(!keys('omer-3-gold').includes('osmanen'));
  assert.ok(keys('luca-3-gold', 'omer-1-crumpled').includes('osmanen'));
  // Grafikkarten wirken nur auf 7
  assert.deepEqual(keys('krisz-3-gold', 'grafikkarte-nvidia-gold'), []);
  assert.ok(keys('seven-3-gold', 'grafikkarte-nvidia-gold').includes('nvidia'));
  assert.ok(keys('seven-3-gold', 'grafikkarte-amd-gold').includes('amd'));
  // Lili nur neben Krisz
  assert.ok(keys('krisz-1-crumpled', 'lili-6-glitch').includes('lili'));
  assert.ok(!keys('luca-1-crumpled', 'lili-6-glitch').includes('lili'));
  // Hundekarte: nur Matze als Hauptkarte mit Good Boy; Good Boy gibt zusätzlich +3
  assert.ok(keys('matze-3-gold', 'good-boy-holo').includes('hundekarte'));
  assert.ok(keys('matze-3-gold', 'good-boy-holo').includes('good-boy'));
  assert.ok(!keys('good-boy-holo', 'matze-2-bfwler').includes('hundekarte'));
  assert.ok(keys('luca-3-gold', 'good-boy-holo').includes('good-boy'));
  // Pascal als Haupt- oder Boost-Karte, Adrian/Marcel/St. Ivan wirken hier nicht
  assert.ok(keys('luca-3-gold', 'pascal-1-crumpled').includes('bloodlust'));
  assert.deepEqual(keys('adrian-3-gold', 'marcel-1-crumpled'), []);
  assert.deepEqual(keys('st-ivan-3-gold'), []);
});

test('Boost-Slot: Items immer, Charaktere nur mit Boost-Fähigkeit', () => {
  const { canBoost } = require('../src/ihk/abilities');
  const c = (id) => catalog.cardById[id];
  for (const id of ['bfw-energy-gold', 'casino-kaffee-3-gold', 'grafikkarte-nvidia-gold', 'pascal-1-crumpled', 'omer-3-gold', 'good-boy-holo', 'lili-6-glitch', 'mauch-1-holo', 'sigrist-4-icon']) assert.ok(canBoost(c(id)), id);
  // Hermann ist für einen kommenden Spielmodus gedacht und in den Quests gesperrt
  for (const id of ['hermann-1-holo', 'hermann-2-bockhaber', 'hermann-3-glitch', 'hermann-4-icon']) assert.ok(!canBoost(c(id)), id);
  // Oliver the Sigrist ist in der IHK nicht einsetzbar
  assert.ok(!canBoost(c('oliver-the-sigrist-sith')));
  for (const id of ['matze-2-bfwler', 'krisz-3-gold', 'luca-3-gold', 'aleks-1-crumpled', 'adrian-3-gold', 'marcel-3-gold', 'st-ivan-3-gold', 'seven-3-gold']) assert.ok(!canBoost(c(id)), id);
});

test('Fähigkeiten wirken erst ab der Halbzeit', () => {
  const { resolve } = require('../src/ihk/abilities');
  const avg = () => 0.5;
  const luca = catalog.cardById['luca-3-gold'];
  const plain = simulate(luca.stats, 'bwl', 1e9, avg);
  const boosted = simulate(luca.stats, 'bwl', 1e9, avg, resolve(luca, null)); // BWL +50 %
  const firstHalf = (r) => r.ticks.filter((t) => !t.ability && t.t <= WORK_TIME / 2).map((t) => t.p);
  assert.deepEqual(firstHalf(boosted), firstHalf(plain)); // vor der Halbzeit identisch
  assert.ok(boosted.total > plain.total * 1.15);
  assert.ok(boosted.ticks.some((t) => t.ability));
  // Bloodlust: Deadline steht kurz, ein Takt mehr
  const pascal = simulate(luca.stats, 'bwl', 1e9, avg, resolve(luca, catalog.cardById['pascal-1-crumpled']));
  assert.ok(pascal.freeze > 0);
  assert.equal(pascal.ticks.filter((t) => !t.ability).length, plain.ticks.length + 1);
});

test('Spell-Karten: Mauch und Sigrist wirken aus dem Boost-Slot, Stärke je Seltenheit', () => {
  const { resolve } = require('../src/ihk/abilities');
  const avg = () => 0.5;
  const luca = catalog.cardById['luca-3-gold'];
  const run = (boostId) => simulate(luca.stats, 'bwl', 1e9, avg, resolve(luca, catalog.cardById[boostId]));
  const points = (r) => r.ticks.filter((t) => !t.ability && t.t > WORK_TIME / 2).map((t) => t.p);
  assert.ok(!resolve(luca, catalog.cardById['oliver-the-sigrist-sith']).some((a) => a.key !== 'simulation'));

  // Hermann: zwei schwächere Runden (Aufgabe +30 % bzw. +45 %), dann ist die Aufgabe zerstört
  const { needsCoffee, isCoffee } = require('../src/ihk/abilities');
  assert.ok(needsCoffee(catalog.cardById['hermann-2-bockhaber']) && !needsCoffee(catalog.cardById['mauch-4-icon']));
  assert.ok(isCoffee(catalog.cardById['casino-kaffee-1-crumpled']) && !isCoffee(catalog.cardById['bfw-energy-gold']));
  const hermann = run('hermann-4-icon');
  assert.equal(hermann.success, true);
  assert.equal(hermann.total, 1e9);
  assert.deepEqual(points(hermann).slice(0, 2), [Math.round(75 / 1.3), Math.round(75 / 1.3)]);
  assert.equal(points(hermann).length, 3);
  assert.ok(hermann.ticks[hermann.ticks.length - 1].destroy);
  assert.equal(hermann.ticks.reduce((s, t) => s + t.p, 0), 1e9); // der Client summiert die Takte
  assert.equal(points(run('hermann-1-holo'))[0], Math.round(75 / 1.45));
  // Ziel schon vor der Halbzeit erreicht: Hermann wird nicht mehr gebraucht
  assert.ok(!simulate(luca.stats, 'bwl', 100, avg, resolve(luca, catalog.cardById['hermann-4-icon'])).ticks.some((t) => t.destroy));

  // Mauch Icon: zwei Runden normale Punkte (nur langsamer), danach +25 % – zusätzlich zu Lucas eigenen +50 %
  const mauch = points(run('mauch-4-icon'));
  assert.equal(mauch[0], 75);
  assert.equal(mauch[1], 75);
  assert.equal(mauch[2], Math.round(75 * 1.25));
  assert.equal(points(run('mauch-1-holo'))[2], Math.round(75 * 1.1));
  assert.match(resolve(luca, catalog.cardById['mauch-2-bockhaber']).find((a) => a.key === 'gruschteln').text, /25 % langsamer.*\+15 %/);

  // Sigrist: Deadline wird um 5–20 % der abgelaufenen Zeit zurückgeworfen
  assert.equal(run('sigrist-1-holo').freeze, 4.5);
  assert.equal(run('sigrist-2-bockhaber').freeze, 9);
  assert.equal(run('sigrist-3-glitch').freeze, 13.5);
  const icon = run('sigrist-4-icon');
  assert.equal(icon.freeze, 18);
  assert.ok(icon.ticks.length > run('sigrist-1-holo').ticks.length);
  assert.ok(icon.ticks.every((t) => t.t <= WORK_TIME + 18));
});

test('Werte im Dateinamen', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-'));
  fs.writeFileSync(path.join(dir, 'anna-3-gold_36-39-21-12.png'), '');
  const [card] = catalog.loadCards(dir);
  assert.equal(card.id, 'anna-3-gold');
  assert.deepEqual(card.stats, { speed: 36, fia: 39, fis: 21, bwl: 12 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Simulation: Takte nach Speed, Stop bei Erfolg, Zeitlimit', () => {
  const avg = () => 0.5; // kein Krit, Faktor 1,0
  const r = simulate({ speed: 60, fia: 50 }, 'fia', 100000, avg);
  assert.equal(r.ticks.length, 16); // 10 + 60/10
  assert.equal(r.total, 16 * 50);
  // Speed hilft nur begrenzt: 99 statt 35 bringt keine 1,5-fachen Takte
  const fast = simulate({ speed: 99, fia: 50 }, 'fia', 1e9, avg).ticks.length;
  const slow = simulate({ speed: 35, fia: 50 }, 'fia', 1e9, avg).ticks.length;
  assert.ok(fast / slow < 1.5, `${fast} vs ${slow}`);
  assert.equal(r.success, false);
  const ok = simulate({ speed: 60, fia: 50 }, 'fia', 120, avg);
  assert.equal(ok.success, true);
  assert.equal(ok.ticks.length, 3); // 50+50+50 >= 120, danach Schluss
  assert.ok(r.ticks.every((t) => t.t <= WORK_TIME));
});

test('Balancing: passende Karte der Seltenheit schafft die Stufe meistens, die falsche kaum', () => {
  const rate = (stats, stat, required) => {
    let n = 0;
    for (let i = 0; i < 2000; i++) if (simulate(stats, stat, required, Math.random).success) n++;
    return n / 2000;
  };
  // Luca Gold (BWL 50, Speed 25) gegen Stufe 3; Luca Bockhaber gegen Stufe 5
  assert.ok(rate(catalog.cardById['luca-3-gold'].stats, 'bwl', DIFFICULTIES[2].required) > 0.5);
  assert.ok(rate(catalog.cardById['luca-5-bockhaber'].stats, 'bwl', DIFFICULTIES[4].required) > 0.5);
  // schnell, aber falsche Fähigkeit: Krisz Gold (Speed 60, BWL 21) schafft BWL-Gold kaum
  assert.ok(rate(catalog.cardById['krisz-3-gold'].stats, 'bwl', DIFFICULTIES[2].required) < 0.1);
  // falsche Fähigkeit: Krisz Crumpled (BWL 12) bei Datenschutz (BWL, Stufe 5) chancenlos
  assert.equal(rate(catalog.cardById['krisz-1-crumpled'].stats, 'bwl', DIFFICULTIES[4].required), 0);
  assert.equal(QUESTS.length, 3);
});
