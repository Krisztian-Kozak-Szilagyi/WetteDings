process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const rep = require('../src/grading/reputation');
const orders = require('../src/grading/orderService');
const grading = require('../src/grading/gradingService');
const { LOCK_LABELS } = require('../src/tcg/locks');

test('#204 B: Arbeitsqualität – Ø aus Sauberkeit, Versiegelung und Glätte', () => {
  assert.equal(rep.qualityOf({ clean: 100, seal: 80 }), 90);
  assert.equal(rep.qualityOf({ clean: 100, seal: 80, iron: { smooth: 30 } }), 70);
  assert.equal(rep.qualityOf({ clean: 150, seal: -5 }), 50); // geklemmt
  assert.equal(rep.qualityOf({}), 0);
});

test('Vitrine: Wert-Gewicht × Noten-Faktor × Echtheit × Seltenheit, gedeckelt bei +50 %', () => {
  assert.equal(rep.showcaseBoost([]), 0);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' ≠ ' + b);
  near(rep.showcaseBoost([{ rarity: 'holo', grade: 10 }]), 0.05);
  near(rep.showcaseBoost([{ rarity: 'glitch', grade: 10 }]), 0.14);
  near(rep.showcaseBoost([{ rarity: 'glitch', grade: 9 }]), 0.14 * 0.7); // Noten-Kurve
  near(rep.showcaseBoost([{ rarity: 'glitch', grade: 8 }]), 0.14 * 0.4);
  near(rep.showcaseBoost([{ rarity: 'glitch', grade: 7 }]), 0.14 * 0.2);
  assert.equal(rep.showcaseBoost([{ rarity: 'sith', grade: 6 }]), 0); // Note 6 bringt nichts
  near(rep.showcaseBoost([{ rarity: 'holo', grade: 10, confirmed: true }]), 0.05 * 1.2); // Zweitprüfung bestätigt
  near(rep.showcaseBoost([{ rarity: 'holo', grade: 10, scarcity: 1.5 }]), 0.075);
  near(rep.showcaseBoost([{ rarity: 'unbekannt', rank: 3, grade: 10 }]), 0.04); // Fallback nach Rang
  assert.equal(rep.showcaseBoost(Array(10).fill({ rarity: 'sith', grade: 10 })), 0.5); // gedeckelt bei +50 %
  // Sechs Holo 10 bringen nur 30 %, den vollen Deckel braucht Kapital (vier Glitch 10)
  near(rep.showcaseBoost(Array(6).fill({ rarity: 'holo', grade: 10 })), 0.3);
  assert.equal(rep.showcaseBoost(Array(4).fill({ rarity: 'glitch', grade: 10 })), 0.5);
});

test('Seltenheits-Faktor: Besitzer als Anteil der Aktiven, erst ab 30 Slabs', () => {
  const f = (owners, active = 30, totalSlabs = 100) => rep.scarcityFactor({ owners, active, totalSlabs });
  assert.equal(f(1), 1.5);
  assert.equal(f(2), 1.25);
  assert.equal(f(3), 1.25);
  assert.equal(f(4), 1);
  assert.equal(f(10), 1);
  assert.equal(f(11), 0.85);
  assert.equal(f(1, 30, 29), 1); // zu wenig Daten
  assert.equal(f(30, 300), 1.25); // 10 % von 300 Aktiven = 30
  assert.equal(f(9, 300), 1.5); // 3 % von 300 = 9
  assert.equal(f(99, 300), 1); // 33 % von 300 = 99
  assert.equal(f(100, 300), 0.85);
});

test('#204 B: Reputation je Auftrag, Sterne und Stufen', () => {
  assert.equal(rep.reputationGain({ quality: 50 }), 10);
  assert.equal(rep.reputationGain({ quality: 50, player: true }), 20);
  assert.equal(rep.reputationGain({ quality: 100, player: true, boost: 1 }), 45); // Boost gedeckelt bei +50 %
  assert.equal(rep.reputationGain({ quality: 0 }), 5);
  assert.deepEqual([1, 3, 5].map(rep.starGain), [-10, 0, 10]);
  assert.equal(rep.tierOf(0).label, 'Neuling');
  assert.equal(rep.tierOf(100).label, 'Bekannt');
  assert.equal(rep.tierOf(999).next, 1000);
  assert.equal(rep.tierOf(1000).label, 'Renommiert');
  assert.equal(rep.tierOf(5000).label, 'Elite');
  assert.equal(rep.tierOf(15000).label, 'Legende');
  assert.equal(rep.tierOf(15000).next, null);
  assert.equal(rep.tierOf(-30).label, 'Neuling'); // negativer Ruf zählt wie ein Neuling
  const r = rep.ratingOf({ stars: { sum: 9, n: 2 }, quality: { sum: 150, n: 2 }, hits: { exact: 1, n: 4 }, reputation: 120 });
  assert.deepEqual([r.stars, r.quality, r.hitRate, r.tier.label], [4.5, 75, 25, 'Bekannt']);
  assert.equal(rep.ratingOf({}).stars, null);
});

test('#204: Festpreise je Baustein im Rahmen, Summe der gebuchten Bausteine', () => {
  const r = (min, max, def) => ({ min, max, def });
  const s = { servicePrice: { base: r(1000, 5000, 2000), iron: r(1000, 9000, 3000), slab: r(2000, 50000, 6000), express: r(0, 9000, 3000), review: r(1000, 9000, 2500) } };
  assert.deepEqual(orders.shopPrices(null, s), { base: 2000, iron: 3000, slab: 6000, express: 3000, review: 2500 });
  assert.deepEqual(orders.shopPrices({ prices: { base: 100, iron: null, slab: 99999999, express: 0 } }, s), { base: 1000, iron: 3000, slab: 50000, express: 0, review: 2500 });
  const shop = { prices: { base: 2500, iron: 4000, slab: 7000, express: 1500, review: 3000 } };
  assert.deepEqual(orders.priceOf(shop, { slab: true }, s), { parts: { base: 2500, slab: 7000 }, total: 9500 });
  assert.deepEqual(orders.priceOf(shop, { iron: true, slab: true, express: true }, s).total, 15000);
  assert.deepEqual(orders.priceOf(shop, { iron: true }, s), { parts: { base: 2500, iron: 4000 }, total: 6500 });
  // Zweitprüfung steht allein: keine Reinigung, Bügeln und Slab fallen weg, Express geht
  assert.deepEqual(orders.priceOf(shop, { review: true, slab: true, express: true }, s), { parts: { review: 3000, express: 1500 }, total: 4500 });
  assert.equal(orders.validPrices({ base: 1000, iron: 9000, slab: 2000, express: 0, review: 1000 }, s), true);
  assert.equal(orders.validPrices({ base: 999, iron: 3000, slab: 6000, express: 0, review: 2500 }, s), false);
  assert.equal(orders.validPrices({ base: 2000, iron: 3000, slab: 6000.5, express: 0, review: 2500 }, s), false);
  assert.equal(orders.validPrices({ base: 2000, iron: 3000, slab: 6000, express: 0 }, s), false); // Zweitprüfung fehlt
});

test('#204: Bausteine – ältere Aufträge sind Bügeln + Slab, Express verkürzt die Frist', () => {
  assert.deepEqual(orders.servicesOf({}), { iron: true, slab: true, express: false, review: false });
  assert.deepEqual(orders.servicesOf({ services: { slab: true } }), { iron: false, slab: true, express: false, review: false });
  assert.deepEqual(orders.servicesOf({ services: { review: true, iron: true, express: true } }), { iron: false, slab: false, express: true, review: true });
  const s = { orderDays: 3, expressDays: 1 };
  assert.equal(orders.deadline(0, s).getTime(), 3 * 864e5);
  assert.equal(orders.deadline(0, s, { express: true }).getTime(), 864e5);
  assert.deepEqual(orders.QUEUE_SORT, { 'services.express': -1, createdAt: 1 });
});

test('#204: Schritte nach gebuchten Bausteinen', () => {
  const crease = { crease: true };
  const steps = (services, defects = crease, level = 3) => grading.stepsFor({ level, defects, services });
  assert.deepEqual(steps(null), ['clean', 'iron', 'grade', 'slab']); // NPC: nach Stufe
  assert.deepEqual(steps({ iron: true, slab: true }), ['clean', 'iron', 'grade', 'slab']);
  assert.deepEqual(steps({ iron: false, slab: true }), ['clean', 'grade', 'slab']); // Knick bleibt, nicht gebucht
  assert.deepEqual(steps({ iron: true, slab: false }), ['clean', 'iron']); // nur bügeln, ohne Slab zurück
  assert.deepEqual(steps({ iron: true, slab: true }, { crease: true, ironed: true }), ['clean', 'grade', 'slab']);
  assert.deepEqual(steps({ review: true }), ['grade']); // Zweitprüfung: nur benoten, die Karte bleibt im Slab
  assert.ok(grading.validRange({ min: 0, max: 10, def: 5 }) && !grading.validRange({ min: 6, max: 10, def: 5 }));
});

test('#204 B: Annahme ab Stufe 4', () => {
  assert.equal(orders.acceptsOrders({ active: true, level: 4, code: 'AB' }), true);
  assert.equal(orders.acceptsOrders({ active: true, level: 3, code: 'AB' }), false);
  assert.equal(orders.acceptsOrders({ active: false, level: 4, code: 'AB' }), false);
  assert.equal(orders.acceptsOrders({ active: true, level: 4, code: null }), false);
});

test('#204: mehrere angenommene Aufträge zählen alle fürs Tageslimit, bis zu 5 gleichzeitig', () => {
  const day = '2026-10-10';
  const running = [
    { day, level: 3, source: 'spieler' },
    { day, level: 3, source: 'spieler' },
    { day, level: 3 },
    { day: '2026-10-09', level: 3 }, // von gestern: zählt nicht zu heute
    { day, level: 2 }, // andere Stufe
  ];
  assert.equal(grading.usedToday({ done: [], open: running, level: 3, day, source: 'spieler' }), 2);
  assert.equal(grading.usedToday({ done: [], open: running, level: 3, day }), 1);
  assert.equal(grading.usedToday({ done: [{ level: 3 }], open: running, level: 3, day }), 2); // fertige und angenommene zusammen
  assert.equal(grading.usedToday({ done: [], open: null, level: 3, day }), 0);
  assert.equal(grading.MAX_ACCEPTED, 5);
});

test('#204: abgebrochene NPC-Aufträge zählen fürs Tageslimit, laufende für beide Kontingente', () => {
  const day = '2026-10-10';
  const q = grading.dayQuota({
    done: [{ level: 3 }, { level: 3, source: 'spieler' }],
    dropped: [{ level: 3 }, { level: 3 }],
    running: [{ day, level: 3, source: 'spieler' }, { day, level: 3 }],
    level: 3,
    day,
  });
  assert.deepEqual(q, { used: 4, playerUsed: 2 }); // NPC: 1 fertig + 2 abgebrochen + 1 laufend; Mitglieder: 1 fertig + 1 laufend
});

test('#204: Arbeitszeit zählt nur, solange ein Auftrag aktiv ist – Warten unter „Angenommen“ nicht', () => {
  const t0 = Date.UTC(2026, 9, 10, 12);
  const min = 60 * 1000;
  // aktiv seit 3 Minuten, davor schon 2 Minuten gearbeitet
  assert.equal(grading.workedMs({ status: 'offen', activeAt: new Date(t0), workMs: 2 * min, createdAt: new Date(t0 - 60 * min) }, t0 + 3 * min), 5 * min);
  // im Hintergrund: nur die gesammelte Zeit, egal wie lange er schon wartet
  assert.equal(grading.workedMs({ status: 'angenommen', activeAt: null, workMs: 2 * min, createdAt: new Date(t0 - 600 * min) }, t0), 2 * min);
  assert.equal(grading.workedMs({ status: 'angenommen', createdAt: new Date(t0 - 600 * min) }, t0), 0);
  // ältere Aufträge ohne activeAt: ab createdAt
  assert.equal(grading.workedMs({ status: 'offen', createdAt: new Date(t0) }, t0 + 4 * min), 4 * min);
  // parken und wieder aktivieren: die Zeit dazwischen fällt weg
  const job = { status: 'offen', activeAt: new Date(t0), workMs: 0, createdAt: new Date(t0) };
  Object.assign(job, grading.park(job, new Date(t0 + 3 * min))); // 3 Min gearbeitet
  assert.deepEqual({ status: job.status, activeAt: job.activeAt, workMs: job.workMs }, { status: 'angenommen', activeAt: null, workMs: 3 * min });
  Object.assign(job, grading.activate(new Date(t0 + 120 * min))); // 2 Std später wieder aktiv
  assert.equal(grading.workedMs(job, t0 + 121 * min), 4 * min);
});

test('#204: Frist beginnt nur beim ersten Annehmen neu – Abbrechen und neu Annehmen verlängert sie nicht', () => {
  const s = { orderDays: 3, expressDays: 1 };
  const t1 = new Date(Date.UTC(2026, 9, 10, 12));
  const first = orders.startSet({ services: { express: false } }, t1, s);
  assert.equal(first.status, 'in_arbeit');
  assert.equal(first.firstStartedAt, t1);
  assert.equal(first.expiresAt.getTime(), t1.getTime() + 3 * 864e5);
  assert.equal(first.warnedAt, null);
  assert.equal(orders.startSet({ services: { express: true } }, t1, s).expiresAt.getTime(), t1.getTime() + 864e5); // Express: kürzer
  // nach einem Abbruch wieder angenommen: Frist und Warnung bleiben, nur startedAt ist neu
  const t2 = new Date(t1.getTime() + 2 * 864e5);
  const again = orders.startSet({ services: { express: false }, firstStartedAt: t1 }, t2, s);
  assert.deepEqual(again, { status: 'in_arbeit', startedAt: t2 });
  assert.ok(orders.WARN_HOURS < 24, 'Warnung kürzer als die kürzeste Frist (Express)');
});

test('#204: Seltenheit eines Slabs in seiner Note fürs Messingschild', () => {
  const population = require('../src/tcg/population');
  const data = { active: 10, spread: new Map(), pop: new Map([['k', { copies: 40, slabs: { 10: 1, 9: 2, 7: 6 } }], ['h', { copies: 20, slabs: { 6: 5 } }]]) };
  const top = population.gradeRarity('k', data, 10);
  assert.equal(top.at, 1);
  assert.equal(top.higher, 0);
  assert.equal(top.total, 9);
  assert.equal(top.copies, 40);
  assert.equal(top.dist.length, 10);
  assert.equal(top.dist[9], 1);
  assert.equal(top.tier.key, 'einzig');
  assert.equal(population.gradeRarity('k', data, 9).tier.key, 'rar'); // 2 Stück
  assert.equal(population.gradeRarity('k', data, 9).higher, 1);
  assert.equal(population.gradeRarity('k', data, 7).tier.key, 'normal'); // 6 von 40 = 15 %
  assert.equal(population.gradeRarity('h', data, 6).tier.key, 'normal'); // 5 von 20
  assert.equal(population.gradeRarity('x', data, 8), null);
  assert.equal(population.gradeRarity('k', null, 8), null);
});

test('#204: Seltenheit eines Slabs aus Note, Ruf des Shops und Einzelstück – negativer Ruf zählt als Neuling', () => {
  const population = require('../src/tcg/population');
  const data = { active: 10, spread: new Map([['k', { owners: 3, share: 0.3 }]]), grades: { 10: 1, 9: 9, 7: 90 }, reps: new Map([['LEG', 2500], ['BAD', -30]]),
    pop: new Map([['k', { copies: 40, slabs: { 10: 1, 9: 2 } }]]) };
  assert.equal(population.slabRarity('k', data, { grade: 10, code: 'LEG' }).key, 'legend'); // 1 % × 0,35 × 0,5
  const bad = population.slabRarity('k', data, { grade: 9, code: 'BAD' });
  assert.equal(bad.shop, 'Neuling');
  assert.equal(bad.key, 'selten'); // 10 % mit Note ≥ 9, zwei Stück
  assert.equal(population.slabRarity('k', data, { grade: 7, code: 'NEU' }).key, 'normal');
  assert.equal(population.slabRarity('k', { ...data, grades: {} }, { grade: 9 }), null);
  assert.deepEqual(population.spreadOf('k', data), { pct: 30, owners: 3, active: 10 });
  assert.equal(population.spreadOf('k', { ...data, active: 0 }), null);
});

test('#204 B: Tageslimits getrennt nach NPC und Spieler, Bügeln nur ungebügelt', () => {
  const day = '2026-10-10';
  const done = [{ level: 3, source: 'spieler' }, { level: 3 }, { level: 3, source: 'npc' }, { level: 2 }];
  assert.equal(grading.usedToday({ done, open: null, level: 3, day }), 2);
  assert.equal(grading.usedToday({ done, open: { day, level: 3, source: 'spieler' }, level: 3, day, source: 'spieler' }), 2);
  assert.equal(grading.stepsFor({ level: 3, defects: { crease: true } }).includes('iron'), true);
  assert.equal(grading.stepsFor({ level: 3, defects: { crease: true, ironed: true } }).includes('iron'), false);
  assert.equal(orders.canRate({ status: 'fertig', stars: null, doneAt: new Date() }), true);
  assert.equal(orders.canRate({ status: 'fertig', stars: 4, doneAt: new Date() }), false);
  assert.equal(orders.canRate({ status: 'fertig', stars: null, doneAt: new Date(Date.now() - 8 * 864e5) }), false);
  assert.equal(LOCK_LABELS.grading && LOCK_LABELS.vitrine ? 'ok' : 'fehlt', 'ok');
});

test('#204: Lohn nach Posten ergibt dieselbe Summe wie payFor', () => {
  const cases = [
    { level: 1, clean: 80, rarity: 'holo' },
    { level: 2, clean: 100, grade: 7, guess: 6, iron: 55, rarity: 'glitch' },
    { level: 3, clean: 93, grade: 9, guess: 9, seal: 71, rarity: 'sith' },
    { level: 4, clean: 100, grade: 5, guess: 8, seal: 100, iron: 100, rarity: 'boss' },
  ];
  for (const c of cases) {
    const p = grading.payParts(c);
    assert.equal(p.total, grading.payFor(c));
    assert.equal(Object.values(p.parts).reduce((a, b) => a + b, 0) + p.extra, p.total);
  }
  assert.deepEqual(Object.keys(grading.payParts({ level: 3, clean: 100, grade: 5, guess: 5, seal: 50 }).parts), ['clean', 'grade', 'slab', 'bonus']);
});

test('#204: Werkzeuge – ab ihrer Stufe kaufbar, gekaufte markiert', () => {
  const list = grading.toolsFor({ level: 1, tools: ['tuch'] });
  assert.deepEqual(list.map((t) => [t.key, t.owned, t.available]), [['tuch', true, true], ['eisen', false, false], ['schablone', false, false], ['uv', false, false]]);
  assert.ok(grading.toolsFor({ level: 3 }).every((t) => t.available && !t.owned && t.cost > 0));
});

test('#204: Schnell-Tags zur Bewertung – aus dem Katalog, höchstens drei, leer erlaubt', () => {
  assert.deepEqual(orders.validTags([]), []);
  assert.deepEqual(orders.validTags(undefined), []);
  assert.deepEqual(orders.validTags('sauber'), ['sauber']);
  assert.deepEqual(orders.validTags(['sauber', 'fair', 'sauber']), ['sauber', 'fair']); // doppelt zählt einmal
  assert.throws(() => orders.validTags(['sauber', 'fair', 'schnell', 'preis']), /höchstens 3/);
  assert.throws(() => orders.validTags(['<script>']), /gibt es nicht/);
  assert.ok(orders.REVIEW_TAGS.some((t) => t.good) && orders.REVIEW_TAGS.some((t) => !t.good));
});

test('#204: Versand ohne Sleeve – kleines Risiko für Kratzer, selten Knick (wie nach einer knapp verlorenen Quest)', () => {
  const damage = require('../src/grading/damage');
  const s = damage.SHIPPING_SEVERITY;
  const kratzer = damage.chanceFor('kratzer', s);
  const knick = damage.chanceFor('knick', s);
  assert.ok(s > 0 && s < 0.2, 'nur ein Hauch über „knapp verloren“');
  assert.ok(kratzer > 0.08 && kratzer < 0.1, `Kratzer ca. 9 % (${kratzer})`);
  assert.ok(knick > 0.005 && knick < 0.01, `Knick unter 1 % (${knick})`);
  assert.ok(kratzer + knick < 0.1, 'insgesamt unter 10 %');
  assert.equal(damage.rollDamage(s, 0), 'knick'); // erst der seltene Knick
  assert.equal(damage.rollDamage(s, knick + 0.001), 'kratzer');
  assert.equal(damage.rollDamage(s, knick + kratzer + 0.001), null); // der Normalfall
  assert.equal(damage.rollDamage(s, 0.5), null);
});

test('Ruf nach der Note: exakt = Zuwachs, ±1 = unverändert, weiter daneben = Abzug, ohne Note halber Zuwachs', () => {
  const base = { quality: 100, player: true };
  const gain = rep.reputationGain(base);
  assert.equal(rep.gradeRepChange({ ...base, guess: 7, grade: 7 }), gain);
  assert.equal(rep.gradeRepChange({ ...base, guess: 7, grade: 8 }), 0);
  assert.equal(rep.gradeRepChange({ ...base, guess: 7, grade: 6 }), 0);
  assert.equal(rep.gradeRepChange({ ...base, guess: 7, grade: 9 }), -15);
  assert.equal(rep.gradeRepChange({ ...base, guess: 7, grade: 10 }), -30);
  assert.equal(rep.gradeRepChange({ ...base, guess: 2, grade: 9 }), -90); // 7 daneben
  assert.equal(rep.gradeRepChange({ quality: 100 }), Math.round(rep.reputationGain({ quality: 100 }) * 0.5)); // keine Note
  assert.ok(rep.gradeRepChange({ ...base, guess: 7, grade: 7, boost: 1 }) > gain);
});

test('Rufstufen schalten Plätze frei: Mitglieder-Aufträge am Tag, Vitrine, Kundschaft', () => {
  const admin = { playerJobs: 10, showcaseMax: 6 };
  assert.deepEqual([0, 100, 1000, 5000, 15000].map((r) => rep.perksOf(r, admin).playerJobs), [3, 5, 8, 10, 12]);
  assert.deepEqual([0, 100, 1000, 5000, 15000].map((r) => rep.perksOf(r, admin).showcase), [3, 4, 5, 6, 6]);
  assert.equal(rep.perksOf(15000, admin).richness, 2);
  assert.equal(rep.perksOf(0, { playerJobs: 10, showcaseMax: 2 }).showcase, 2); // Admin-Obergrenze gilt
  assert.equal(rep.perksOf(5000, { playerJobs: 0, showcaseMax: 6 }).playerJobs, 0); // ausgeschaltet bleibt aus
  assert.equal(rep.perksOf(-50, admin).tier, 'Neuling');
});

test('Ruf-Verfall: Karenz 7 Tage, dann 1 % je Tag, nie unter 100', () => {
  assert.equal(rep.idleDecayDays({ idleDays: 7.9 }), 0);
  assert.equal(rep.idleDecayDays({ idleDays: 10.2 }), 3);
  assert.equal(rep.idleDecayDays({ idleDays: 10, appliedDays: 3 }), 0); // schon abgezogen
  assert.equal(rep.decayedReputation(1000, 1), 990);
  assert.equal(rep.decayedReputation(1000, 2), 980); // 980,1 gerundet
  assert.equal(rep.decayedReputation(1000, 0), 1000);
  assert.equal(rep.decayedReputation(105, 30), 100); // Untergrenze
  assert.equal(rep.decayedReputation(60, 5), 60); // darunter bleibt es
});
