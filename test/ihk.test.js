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
  assert.deepEqual(catalog.cardById['krisz-1-crumpled'].stats, { speed: catalog.SPEED, fia: 39, fis: 21, bwl: 12 }); // alle gleich schnell
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
  // Ömer: Mach das Unmögliche möglich nur als Hauptkarte – aus dem Boost-Slot wirkt er nicht mehr
  assert.deepEqual(keys('omer-3-gold'), ['omer']);
  assert.ok(!keys('luca-3-gold', 'omer-1-crumpled').includes('omer'));
  // Grafikkarten wirken nur auf 7
  assert.deepEqual(keys('krisz-3-gold', 'grafikkarte-nvidia-gold'), []);
  assert.ok(keys('seven-3-gold', 'grafikkarte-nvidia-gold').includes('nvidia'));
  assert.ok(keys('seven-3-gold', 'grafikkarte-amd-gold').includes('amd'));
  // Lili nur neben Krisz
  assert.ok(keys('krisz-1-crumpled', 'lili-6-glitch').includes('lili'));
  assert.ok(!keys('luca-1-crumpled', 'lili-6-glitch').includes('lili'));
  // Hundekarten (Hugo, Lilly): Treue Seele – an Matze greift der Hund mit an, sonst +5 für die geboostete Karte
  for (const dog of ['hugo-holo', 'lilly-holo']) {
    assert.deepEqual(keys('matze-3-gold', dog), ['treue-seele-matze']);
    assert.deepEqual(keys('luca-3-gold', dog).filter((k) => k !== 'potions'), ['treue-seele']);
    assert.ok(!c(dog).isCharacter, 'Hundekarten sind Spells');
  }
  assert.ok(!catalog.cardById['good-boy-holo'], 'Good Boy wurde entfernt');
  // Pascal als Haupt- oder Boost-Karte, Adrian/Marcel/St. Ivan wirken hier nicht
  assert.ok(keys('luca-3-gold', 'pascal-1-crumpled').includes('bloodlust'));
  assert.deepEqual(keys('adrian-3-gold', 'marcel-1-crumpled'), []);
  assert.deepEqual(keys('st-ivan-3-gold'), []);
});

test('Boost-Slot: Items immer, Charaktere nur mit Boost-Fähigkeit', () => {
  const { canBoost } = require('../src/ihk/abilities');
  const c = (id) => catalog.cardById[id];
  for (const id of ['bfw-energy-gold', 'casino-kaffee-3-gold', 'grafikkarte-nvidia-gold', 'pascal-1-crumpled', 'hugo-holo', 'lilly-holo', 'lili-6-glitch', 'mauch-1-holo', 'sigrist-4-icon']) assert.ok(canBoost(c(id)), id);
  // Hermann ist für einen kommenden Spielmodus gedacht und in den Quests gesperrt
  for (const id of ['hermann-1-holo', 'hermann-2-bockhaber', 'hermann-3-glitch', 'hermann-4-icon']) assert.ok(!canBoost(c(id)), id);
  // Oliver the Sigrist ist in der IHK nicht einsetzbar
  assert.ok(!canBoost(c('oliver-the-sigrist-sith')));
  for (const id of ['omer-3-gold', 'matze-2-bfwler', 'krisz-3-gold', 'luca-3-gold', 'aleks-1-crumpled', 'adrian-3-gold', 'marcel-3-gold', 'st-ivan-3-gold', 'seven-3-gold']) assert.ok(!canBoost(c(id)), id);
});

test('Fähigkeiten wirken erst ab der Halbzeit', () => {
  const { resolve } = require('../src/ihk/abilities');
  const avg = () => 0.5;
  const luca = catalog.cardById['luca-3-gold'];
  const plain = simulate(luca.stats, 'bwl', 1e9, avg);
  const boosted = simulate(luca.stats, 'bwl', 1e9, avg, resolve(luca, null)); // Tempo und BWL +50
  const firstHalf = (r) => r.ticks.filter((t) => !t.ability && t.t < WORK_TIME / 2).map((t) => t.p);
  assert.deepEqual(firstHalf(boosted), firstHalf(plain)); // vor der Halbzeit identisch
  assert.ok(boosted.total > plain.total * 1.15);
  assert.ok(boosted.ticks.some((t) => t.ability));
  // Bloodlust: Deadline steht kurz, ein Takt mehr (Adrian hat keine eigene Fähigkeit)
  const adrian = catalog.cardById['adrian-3-gold'];
  const pascal = simulate(adrian.stats, 'bwl', 1e9, avg, resolve(adrian, catalog.cardById['pascal-1-crumpled']));
  assert.ok(pascal.freeze > 0);
  assert.equal(pascal.ticks.filter((t) => !t.ability).length, simulate(adrian.stats, 'bwl', 1e9, avg).ticks.length + 1);
});

test('Spell-Karten: Mauch und Sigrist wirken aus dem Boost-Slot, Stärke je Seltenheit', () => {
  const { resolve } = require('../src/ihk/abilities');
  const avg = () => 0.5;
  const luca = catalog.cardById['adrian-3-gold']; // ohne eigene Fähigkeit – Luca würde die Spells verstärken
  const run = (boostId) => simulate(luca.stats, 'bwl', 1e9, avg, resolve(luca, catalog.cardById[boostId]));
  // Punkte nach dem Aktivieren der Fähigkeit (ein Takt kann genau auf die Halbzeit fallen)
  const points = (r) => r.ticks.slice(r.ticks.findIndex((t) => t.ability) + 1).map((t) => t.p);
  assert.deepEqual(resolve(luca, catalog.cardById['oliver-the-sigrist-sith']), []);

  // Hermann: zwei schwächere Runden (Aufgabe +30 % bzw. +45 %), dann ist die Aufgabe zerstört
  const { needsCoffee, isCoffee } = require('../src/ihk/abilities');
  assert.ok(needsCoffee(catalog.cardById['hermann-2-bockhaber']) && !needsCoffee(catalog.cardById['mauch-4-icon']));
  assert.ok(isCoffee(catalog.cardById['casino-kaffee-1-crumpled']) && !isCoffee(catalog.cardById['bfw-energy-gold']));
  const B = luca.stats.bwl; // Punkte je Takt ohne Fähigkeit (Faktor 1)
  const hermann = run('hermann-4-icon');
  assert.equal(hermann.success, true);
  assert.equal(hermann.total, 1e9);
  assert.deepEqual(points(hermann).slice(0, 2), [Math.round(B / 1.3), Math.round(B / 1.3)]);
  assert.equal(points(hermann).length, 3);
  assert.ok(hermann.ticks[hermann.ticks.length - 1].destroy);
  assert.equal(hermann.ticks.reduce((s, t) => s + t.p, 0), 1e9); // der Client summiert die Takte
  assert.equal(points(run('hermann-1-holo'))[0], Math.round(B / 1.45));
  // Ziel schon vor der Halbzeit erreicht: Hermann wird nicht mehr gebraucht
  assert.ok(!simulate(luca.stats, 'bwl', 100, avg, resolve(luca, catalog.cardById['hermann-4-icon'])).ticks.some((t) => t.destroy));

  // Mauch Icon: zwei Runden normale Punkte (nur langsamer), danach +25 %
  const mauch = points(run('mauch-4-icon'));
  assert.equal(mauch[0], B);
  assert.equal(mauch[1], B);
  assert.equal(mauch[2], Math.round(B * 1.25));
  assert.equal(points(run('mauch-1-holo'))[2], Math.round(B * 1.1));
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
  assert.deepEqual(card.stats, { speed: catalog.SPEED, fia: 39, fis: 21, bwl: 12 }); // Speed im Namen zählt nicht mehr
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
});

test('Quests: alle Kategorien und Hybride vorhanden, Pflichtfelder gesetzt', () => {
  const { statsOf } = require('../src/ihk/quests');
  const cats = new Set(QUESTS.map((q) => statsOf(q).join('/')));
  for (const c of ['fia', 'fis', 'bwl', 'fia/fis', 'fia/bwl', 'fis/bwl']) assert.ok(cats.has(c), c);
  assert.equal(new Set(QUESTS.map((q) => q.id)).size, QUESTS.length);
  for (const q of QUESTS) {
    for (const f of ['title', 'text', 'success', 'fail', 'image']) assert.ok(q[f], `${q.id}: ${f} fehlt`);
    assert.ok(statsOf(q).every((s) => ['fia', 'fis', 'bwl'].includes(s)), q.id);
  }
});

test('Hybrid-Quest: zwei Balken, je Fähigkeit einer – geschafft erst, wenn beide voll sind', () => {
  const avg = () => 0.5;
  const r = simulate({ speed: 60, fia: 80, fis: 20, bwl: 0 }, ['fia', 'fis'], 1e9, avg);
  assert.ok(r.ticks.every((t) => t.p === 80 && t.p2 === 20));
  assert.equal(r.success, false);
  // 16 Runden: FIA schafft 400 locker, FIS mit 20 pro Runde (320) nicht → gescheitert
  const lop = simulate({ speed: 60, fia: 80, fis: 20, bwl: 0 }, ['fia', 'fis'], 400, avg);
  assert.ok(lop.total >= 400 && lop.total2 < 400 && !lop.success);
  // Allrounder schafft beide Balken
  const all = simulate({ speed: 60, fia: 50, fis: 50, bwl: 0 }, ['fia', 'fis'], 300, avg);
  assert.ok(all.success && all.total >= 300 && all.total2 >= 300);
  // normale Quest: ein Balken, kein p2
  const one = simulate({ speed: 60, fia: 50, fis: 50, bwl: 0 }, 'fia', 300, avg);
  assert.ok(one.success && one.total2 === undefined && one.ticks.every((t) => t.p2 === undefined));
});

test('Zwei Boosts (Hybrid): Fähigkeiten zählen einmal, verschiedene Hunde beide', () => {
  const { resolveAll } = require('../src/ihk/abilities');
  const c = (id) => catalog.cardById[id];
  const keys = (m, bs) => resolveAll(c(m), bs.map(c)).map((a) => a.key + ':' + a.label);
  assert.deepEqual(keys('matze-3-gold', ['hugo-holo', 'lilly-holo']), ['treue-seele-matze:Hugo: Treue Seele', 'treue-seele-matze:Lilly: Treue Seele']);
  assert.equal(keys('luca-3-gold', ['pascal-1-crumpled', 'bfw-energy-gold']).filter((k) => k.startsWith('potions')).length, 1);
  // Pascal als Haupt- und Boost-Karte: Bloodlust wirkt genau einmal
  assert.equal(keys('pascal-1-crumpled', ['pascal-1-crumpled']).filter((k) => k.startsWith('bloodlust')).length, 1);
  assert.deepEqual(keys('krisz-3-gold', []), []);
});

test('Hybrid-Quests haben eigene Einstellungen (Ziel, Dauer, Lohn)', () => {
  const ihk = require('../src/ihk/ihkService');
  const { questById } = require('../src/ihk/quests');
  const saved = ihk.settings.hybrid;
  ihk.settings.hybrid = { required: [1, 2, 3, 4, 5, 6], durations: [7, 7, 7, 7, 7, 7], rewards: [9, 9, 9, 9, 9, 9] };
  try {
    assert.equal(ihk.requiredFor(3, questById['webshop']), 3);
    assert.equal(ihk.durationFor(3, questById['webshop']), 7);
    assert.equal(ihk.rewardFor(3, questById['webshop']), 9);
    assert.equal(ihk.requiredFor(3, questById['inventur']), ihk.settings.required[2]);
    assert.equal(ihk.rewardFor(3, questById['inventur']), ihk.settings.rewards[2]);
  } finally {
    ihk.settings.hybrid = saved;
  }
});

test('Booster Pack für eine geschaffte Quest: Chance je Schwierigkeit, Hybrid getrennt', () => {
  const ihk = require('../src/ihk/ihkService');
  const { questById } = require('../src/ihk/quests');
  assert.deepEqual(ihk.settings.packChances, [5, 5, 5, 5, 5, 5]);
  assert.equal(ihk.rollsPack(5, 0.049), true);
  assert.equal(ihk.rollsPack(5, 0.05), false);
  assert.equal(ihk.rollsPack(0, 0), false);
  assert.equal(ihk.rollsPack(100, 0.999999), true);
  const saved = [ihk.settings.packChances, ihk.settings.hybrid.packChances];
  ihk.settings.packChances = [1, 2, 3, 4, 5, 6];
  ihk.settings.hybrid.packChances = [10, 20, 30, 40, 50, 60];
  try {
    assert.equal(ihk.packChanceFor(4, questById['inventur']), 4);
    assert.equal(ihk.packChanceFor(4, questById['webshop']), 40);
  } finally {
    [ihk.settings.packChances, ihk.settings.hybrid.packChances] = saved;
  }
});

test('Forkbomb (St. Ivan, the Forsaken): Deadline läuft langsamer, jede Runde 2 % weniger', () => {
  const { simulate, WORK_TIME } = require('../src/ihk/ihkService');
  const { resolveAll } = require('../src/ihk/abilities');
  const catalog = require('../src/tcg/catalog');
  const boss = catalog.cardById['st-ivan-boss'];
  const effects = resolveAll(boss, []);
  assert.ok(effects.some((e) => e.key === 'forkbomb'));
  const stats = { speed: 50, fia: 10, fis: 10, bwl: 10 };
  const rand = () => 0.5;
  const plain = simulate(stats, 'fia', 1e9, rand, []);
  const fb = simulate(stats, 'fia', 1e9, rand, effects);
  assert.ok(fb.slow.length > 0);
  assert.strictEqual(fb.slow[0][2], 30);
  for (let i = 1; i < fb.slow.length; i++) assert.strictEqual(fb.slow[i][2], Math.max(0, fb.slow[i - 1][2] - 2));
  assert.ok(fb.extend > 0);
  // nie schlechter als ohne; der letzte Takt liegt vor dem Ende der verlängerten Deadline
  assert.ok(fb.total >= plain.total);
  // schnelle Karte (kurze Runden): die gewonnene Zeit reicht für eine zusätzliche Runde
  const fast = { speed: 99, fia: 10, fis: 10, bwl: 10 };
  assert.ok(simulate(fast, 'fia', 1e9, rand, effects).ticks.filter((x) => !x.ability).length > simulate(fast, 'fia', 1e9, rand, []).ticks.length);
  assert.ok(fb.ticks[fb.ticks.length - 1].t <= WORK_TIME + fb.freeze + fb.extend + 1e-6);
  // ohne Forkbomb ändert sich nichts
  assert.deepStrictEqual(plain.slow, []);
  assert.strictEqual(plain.extend, 0);
});

test('Treue Seele: +5 für die geboostete Karte – an Matze greift der Hund mit +25 bei jedem Schlag mit an', () => {
  const { resolveAll } = require('../src/ihk/abilities');
  const c = (id) => catalog.cardById[id];
  const avg = () => 0.5; // kein Krit, Faktor 1
  const half = (r, after) => r.ticks.filter((t) => !t.ability && (after ? t.t > WORK_TIME / 2 : t.t < WORK_TIME / 2));
  // andere Karte: ab der Halbzeit +5 auf den Wert der Quest, kein Mitangriff
  const luca = c('adrian-3-gold'); // ohne eigene Fähigkeit
  const plain = simulate(luca.stats, 'fia', 1e9, avg);
  const dogged = simulate(luca.stats, 'fia', 1e9, avg, resolveAll(luca, [c('hugo-holo')]));
  assert.equal(half(dogged, true)[0].p, half(plain, true)[0].p + 5);
  assert.ok(dogged.ticks.every((t) => !t.dg));
  // Matze: seine Werte bleiben, jeder Hund trifft ab der Halbzeit mit 25 mit (dg = Anteil der Hunde)
  const matze = c('matze-3-gold');
  const alone = simulate(matze.stats, 'fis', 1e9, avg);
  const one = simulate(matze.stats, 'fis', 1e9, avg, resolveAll(matze, [c('hugo-holo')]));
  const two = simulate(matze.stats, 'fis', 1e9, avg, resolveAll(matze, [c('hugo-holo'), c('lilly-holo')]));
  assert.deepEqual(half(one, false).map((t) => t.p), half(alone, false).map((t) => t.p), 'vor der Halbzeit nichts');
  assert.ok(half(one, true).every((t) => t.dg === 25 && t.p === matze.stats.fis + 25));
  assert.ok(half(two, true).every((t) => t.dg === 50 && t.p === matze.stats.fis + 50));
  assert.ok(!one.ticks.some((t) => t.st), 'Matzes eigene Werte ändern sich nicht');
  // Hybrid-Quest: der Hund trifft auf beiden Balken
  const hy = simulate(matze.stats, ['fia', 'bwl'], 1e9, avg, resolveAll(matze, [c('lilly-holo')]));
  assert.ok(half(hy, true).every((t) => t.p === matze.stats.fia + 25 && t.p2 === matze.stats.bwl + 25));
});

test('Yo Dawg: Hunde-Slot nur für Matze mit genau einem Hund im Boost – höchstens zwei Hunde, jeder nur einmal', () => {
  const { hasDogSlot, checkDogs } = require('../src/ihk/abilities');
  const c = (id) => catalog.cardById[id];
  const matze = c('matze-3-gold');
  const hugo = c('hugo-holo');
  const lilly = c('lilly-holo');
  const energy = c('bfw-energy-gold');
  assert.ok(hasDogSlot(matze, [hugo]));
  assert.ok(hasDogSlot(matze, [lilly, energy]), 'Hybrid: Hund + freier Boost → dritter Platz für den anderen Hund');
  assert.ok(!hasDogSlot(matze, [hugo, lilly]), 'beide Hunde schon im Boost: kein weiterer Platz');
  assert.ok(!hasDogSlot(matze, [energy]) && !hasDogSlot(matze, []));
  assert.ok(!hasDogSlot(c('luca-3-gold'), [hugo]), 'nur Matze');
  assert.equal(checkDogs(matze, [hugo], lilly), null);
  assert.equal(checkDogs(matze, [hugo, energy], lilly), null);
  assert.match(checkDogs(matze, [hugo], hugo), /nur einmal/);
  assert.match(checkDogs(matze, [energy], lilly), /nur für Matze/);
  assert.match(checkDogs(c('luca-3-gold'), [hugo], lilly), /nur für Matze/);
  assert.match(checkDogs(matze, [hugo], energy), /nur eine Hundekarte/);
  // im Team: ein Hund, den schon jemand mitbringt, darf nicht noch einmal mit
  assert.match(checkDogs(c('luca-3-gold'), [hugo], null, [hugo]), /nur einmal/);
  assert.equal(checkDogs(c('luca-3-gold'), [lilly], null, [hugo]), null);
});

test("Luca – You can't handle my Potions: Boosts im Team 10 % stärker (nur ihre Vorteile), danach Tempo und BWL +50", () => {
  const { resolveAll, LUCA_AMP, LUCA_PLUS } = require('../src/ihk/abilities');
  const c = (id) => catalog.cardById[id];
  const avg = () => 0.5;
  const luca = c('luca-3-gold');
  const shown = (r) => r.ticks.find((t) => t.ability).st; // Werte nach der Halbzeit [Speed, FIA, FIS, BWL]
  const st = luca.stats;
  // allein: Tempo und BWL +50
  assert.deepEqual(shown(simulate(st, 'bwl', 1e9, avg, resolveAll(luca, []))), [st.speed + LUCA_PLUS, st.fia, st.fis, st.bwl + LUCA_PLUS]);
  // BFW Energy (+10 % auf alle Werte) wirkt 11 % – die +50 kommen erst danach und werden nicht mitverstärkt
  const plus = (v) => Math.round(v + v * 0.1 * (1 + LUCA_AMP));
  assert.deepEqual(shown(simulate(st, 'bwl', 1e9, avg, resolveAll(luca, [c('bfw-energy-gold')]))), [st.speed + LUCA_PLUS, plus(st.fia), plus(st.fis), plus(st.bwl) + LUCA_PLUS]);
  // Hund (+5) wird +5,5
  const dog = simulate(st, 'fia', 1e9, avg, resolveAll(luca, [c('hugo-holo')]));
  assert.equal(shown(dog)[1], Math.round(st.fia + 5.5));
  // Nachteile bleiben: Mauch verlangsamt genauso stark, nur sein Bonus danach wird größer
  const ivan = c('adrian-3-gold');
  const mauch = c('mauch-1-holo');
  const slowFactor = (effects) => {
    const s = { mode: 'ihk', duration: 180, speed: 60, stats: { fia: 50, fis: 50, bwl: 50 }, extraTicks: 0, extraTime: 0, elapsed: 0, fakeNext: false, tempSpeed: null, doom: null, forkbomb: 0, dogs: [] };
    effects.forEach((e) => e.apply(s));
    return s.tempSpeed.factor;
  };
  assert.equal(slowFactor(resolveAll(luca, [mauch]).filter((e) => e.key === 'gruschteln')), slowFactor(resolveAll(ivan, [mauch])));
  // Hauptkarten-Fähigkeiten bleiben gleich (Mirjam verdoppelt weiter genau)
  assert.ok(!resolveAll(c('mirjam-3-gold'), []).some((e) => e.boost));
  assert.ok(resolveAll(ivan, [c('bfw-energy-gold')]).every((e) => e.boost));
});

test("Luca im Dungeon: die Verstärkung gilt für die ganze Gruppe, Tempo und BWL +50 nur für ihn", () => {
  const d = require('../src/dungeon/dungeonService');
  const c = (id) => catalog.cardById[id];
  const avg = () => 0.5;
  const team = [{ card: c('luca-3-gold'), boost: null }, { card: c('adrian-3-gold'), boost: c('bfw-energy-gold') }, { card: c('aleks-3-gold'), boost: null }];
  const adrian = c('adrian-3-gold').stats;
  const with_ = simulate(adrian, 'fia', 1e9, avg, d.teamEffects(team, 1), 'dungeon');
  const without = simulate(adrian, 'fia', 1e9, avg, d.teamEffects([team[1]], 0), 'dungeon');
  const st = (r) => r.ticks.find((t) => t.ability).st;
  assert.equal(st(with_)[1], Math.round(adrian.fia * 1.11), 'BFW Energy bei Adrian 11 % statt 10 %');
  assert.equal(st(without)[1], Math.round(adrian.fia * 1.1));
  assert.equal(st(with_)[0], adrian.speed, 'Adrian bekommt kein Tempo +50');
  assert.ok(d.teamEffects(team, 2).some((e) => e.key === 'potions' && e.from === 0), 'auch Aleks hat Lucas Verstärkung');
});

test('Aleks – Gruß aus dem Osten: ab der Halbzeit kostet jeder Angriff 50 €, Kopf gibt +10 auf alle Werte (stapelt sich)', () => {
  const { resolveAll, ALEKS } = require('../src/ihk/abilities');
  const ihk = require('../src/ihk/ihkService');
  const aleks = catalog.cardById['aleks-3-gold'];
  const effects = resolveAll(aleks, []);
  assert.deepEqual(effects.map((e) => e.key), ['gruss-aus-dem-osten']);
  const avg = () => 0.5; // Münze Zahl (0,5 ≥ 0,499), kein Krit, Faktor 1
  assert.ok(simulate(aleks.stats, 'fia', 1e9, avg, effects).ticks.every((t) => !t.coin), 'ohne Geld keine Würfe');
  // 300 €: genau 6 Würfe, alle nach der Halbzeit, das Geld ist dann verbraucht
  const r = simulate(aleks.stats, 'fia', 1e9, avg, effects, 'ihk', { coin: { left: 30000, bonus: 0, active: false } });
  const coins = r.ticks.filter((t) => t.coin);
  assert.equal(coins.length, 6);
  assert.ok(coins.every((t) => t.t >= WORK_TIME / 2 && t.coin === 'zahl'));
  assert.equal(ihk.coinTally(30000, r.ticks).spent, 30000);
  // Kopf: +10 auf alle Werte für den Rest, jedes Kopf zählt – feste Würfe: je Angriff erst die Münze, dann Krit und Faktor
  const flips = [0.1, 0.9, 0.1, 0.1, 0.9, 0.9]; // Kopf, Zahl, Kopf, Kopf, Zahl, Zahl
  let half = false;
  let calls = 0;
  let k = 0;
  const fixed = () => (half && calls++ % 3 === 0 && k < flips.length ? flips[k++] : 0.5);
  const marked = effects.map((e) => ({ ...e, apply: (s) => { e.apply(s); half = true; } }));
  const r2 = simulate(aleks.stats, 'fia', 1e9, fixed, marked, 'ihk', { coin: { left: 30000, bonus: 0, active: false } });
  const tally = ihk.coinTally(30000, r2.ticks);
  assert.deepEqual([tally.spent, tally.heads], [30000, 3]);
  const last = r2.ticks.filter((t) => t.st).pop().st;
  assert.equal(last[1], aleks.stats.fia + 3 * ALEKS.plus, '3× Kopf = +30 FIA');
  assert.equal(last[3], aleks.stats.bwl + 3 * ALEKS.plus);
});

test('Aleks – Geld: ganze Euro bis 1000, nur für Aleks, der Rest kommt zurück', () => {
  const ihk = require('../src/ihk/ihkService');
  const c = (id) => catalog.cardById[id];
  assert.equal(ihk.aleksBudget(c('aleks-1-crumpled'), 1000), 100000);
  assert.equal(ihk.aleksBudget(c('aleks-1-crumpled'), 0), 0);
  assert.equal(ihk.aleksBudget(c('luca-3-gold'), 500), 0, 'andere Karten nehmen kein Geld mit');
  assert.throws(() => ihk.aleksBudget(c('aleks-1-crumpled'), 1001), /1000/);
  assert.throws(() => ihk.aleksBudget(c('aleks-1-crumpled'), 12.5), /ganze Euro/);
  assert.deepEqual(ihk.coinTally(12000, [{ coin: 'kopf' }, { coin: 'zahl' }, {}]), { budget: 12000, spent: 10000, heads: 1 });
});

test('Aleks im Dungeon: wirft ab der Halbzeit von Kampf 1 durchgehend, Kopf-Bonus bleibt für alle weiteren Kämpfe', () => {
  const d = require('../src/dungeon/dungeonService');
  const { ALEKS } = require('../src/ihk/abilities');
  const avg = () => 0.3; // Münze: immer Kopf (0,3 < 0,499); Faktor 0,92, kein Krit
  const cards = d.teamCards([{ card: 'aleks-1-crumpled', coins: 100000 }, { card: 'luca-1-crumpled' }]);
  assert.deepEqual(cards[0].coin, { left: 100000, bonus: 0, active: false });
  assert.equal(cards[1].coin, null, 'nur Aleks nimmt Geld mit');
  const f1 = d.fight(cards, 'fia', 400, avg);
  const flips1 = f1.ticks.filter((t) => t.m === 0 && t.coin);
  assert.ok(flips1.length > 0 && flips1.every((t) => t.t >= WORK_TIME / 2));
  assert.equal(cards[0].coin.left, 100000 - flips1.length * ALEKS.cost);
  assert.equal(cards[0].coin.bonus, flips1.length * ALEKS.plus);
  assert.equal(cards[0].coin.active, true);
  // Kampf 2: wirft schon ab dem ersten Angriff, der Bonus gilt von Anfang an
  const f2 = d.fight(cards, 'fia', 400, avg);
  const mine = f2.ticks.filter((t) => t.m === 0 && !t.ability);
  assert.ok(mine[0].coin, 'erster Angriff mit Münzwurf');
  assert.equal(mine[0].st[1], catalog.cardById['aleks-1-crumpled'].stats.fia + flips1.length * ALEKS.plus + ALEKS.plus);
  // nur Würfe bis zum Ende des Kampfs zählen
  const all = f1.ticks.concat(f2.ticks).filter((t) => t.m === 0 && t.coin).length;
  assert.equal(cards[0].coin.left, Math.max(0, 100000 - all * ALEKS.cost));
  assert.deepEqual(d.coinFields({ coins: 100000 }, cards[0]), { coins: 100000, coinSpent: all * ALEKS.cost, coinHeads: all });
  // Geld alle: keine weiteren Würfe
  const poor = d.teamCards([{ card: 'aleks-1-crumpled', coins: ALEKS.cost }]);
  d.fight(poor, 'fia', 1e6, avg);
  assert.equal(poor[0].coin.left, 0);
});

test('Ömer – Mach das Unmögliche möglich: 2 Ömer zu Beginn, 3 ab der Halbzeit, gemeinsamer Angriff mit Schneeball, Deadline 15 % schneller je Ömer', () => {
  const { resolveAll, OMER } = require('../src/ihk/abilities');
  const omer = catalog.cardById['omer-3-gold'];
  const st = omer.stats;
  const avg = () => 0.5; // kein Krit, Faktor 1
  const r = simulate(st, 'fis', 1e9, avg, resolveAll(omer, []));
  const hits = r.ticks.filter((t) => !t.ability);
  // Angriff 1: zwei Ömer mit halben Werten, jeder + grow · (Grundwert je Ömer + 1) / 2 für den anderen – dann treffen beide
  const step2 = (OMER.grow * (st.fis / 2 + 1)) / 2;
  assert.equal(hits[0].om, 2);
  assert.equal(hits[0].p, 2 * Math.round(st.fis / 2 + step2));
  // Angriff 2: der Bonus bleibt, wächst aber gleichmäßig (aus dem Grundwert, nicht aus dem aktuellen Wert)
  assert.equal(hits[1].p, 2 * Math.round(st.fis / 2 + 2 * step2));
  // ab der Halbzeit: drei Ömer, die Stärke verteilt sich (2 · v / 3), je Angriff + 2 · grow · (Grundwert / 3 + 1) / 2
  const before = hits.filter((t) => t.t < WORK_TIME / 2);
  const after = hits.filter((t) => t.t >= WORK_TIME / 2);
  assert.ok(before.every((t) => t.om === 2) && after.every((t) => t.om === 3));
  const v = ((st.fis / 2 + before.length * step2) * 2) / 3 + (2 * OMER.grow * (st.fis / 3 + 1)) / 2;
  assert.equal(after[0].p, 3 * Math.round(v));
  // kein exponentielles Wachstum: der Zuwachs je Angriff bleibt nach der Halbzeit gleich
  const d1 = after[1].p - after[0].p;
  const d2 = after[2].p - after[1].p;
  assert.ok(Math.abs(d1 - d2) <= 3, d1 + ' / ' + d2);
  // Deadline: bis zur Halbzeit 30 %, danach 45 % schneller – sie endet früher als nach 180 s
  assert.deepEqual(r.rush, [2 * OMER.rush, 3 * OMER.rush]);
  const expected = WORK_TIME / 2 + (WORK_TIME - (WORK_TIME / 2) * (1 + r.rush[0])) / (1 + r.rush[1]);
  assert.ok(Math.abs(r.end - expected) < 0.1, r.end + ' ~ ' + expected);
  assert.ok(hits[hits.length - 1].t <= r.end);
  // ohne Ömer: keine Beschleunigung
  assert.equal(simulate(st, 'fis', 1e9, avg).rush, undefined);
});
