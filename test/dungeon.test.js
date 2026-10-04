process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const { toZonedLocalInput } = require('../src/lib/time');
const d = require('../src/dungeon/dungeonService');
const { DUNGEONS, dungeonForSlot } = require('../src/dungeon/dungeons');

const berlinHour = (date) => Number(toZonedLocalInput(date, 'Europe/Berlin').slice(11, 13));
const card = (id) => catalog.cardById[id];

test('Termine: volle Stunde deutscher Zeit, durch den Abstand teilbar, immer in der Zukunft', () => {
  for (const now of [Date.UTC(2026, 0, 15, 9, 59, 30), Date.UTC(2026, 6, 15, 9, 59, 30), Date.UTC(2026, 9, 25, 0, 30)]) {
    for (const hours of [1, 2, 3, 4, 6, 12, 24]) {
      const s = d.slotAfter(now, hours);
      assert.ok(s.getTime() > now);
      assert.ok(s.getTime() - now <= hours * 3600000 + 3600000);
      assert.equal(s.getUTCMinutes(), 0);
      assert.equal(berlinHour(s) % hours, 0);
    }
  }
  // Winterzeit: 10:59 UTC = 11:59 Berlin → nächster 2-Stunden-Termin 12:00 Berlin = 11:00 UTC
  assert.equal(d.slotAfter(Date.UTC(2026, 0, 15, 10, 59), 2).toISOString(), '2026-01-15T11:00:00.000Z');
});

test('Anmeldung kurz vor dem Start gilt schon für den übernächsten Termin', () => {
  const slot = d.slotAfter(Date.UTC(2026, 0, 15, 10, 0), 2).getTime();
  assert.equal(d.registrationSlot(slot - 60000, 2).getTime(), slot);
  assert.equal(d.registrationSlot(slot - (d.LOCK_SECONDS - 1) * 1000, 2).getTime(), slot + 2 * 3600000);
  assert.equal(d.isLockedIn(new Date(slot), slot - 60000), false);
  assert.equal(d.isLockedIn(new Date(slot), slot - 5000), true);
});

test('Der Dungeon wechselt mit jedem Termin', () => {
  const a = d.slotAfter(Date.UTC(2026, 0, 15, 10, 0), 2);
  const b = d.slotAfter(a.getTime(), 2);
  assert.notEqual(dungeonForSlot(a, 2).key, dungeonForSlot(b, 2).key);
  for (const dg of DUNGEONS) {
    assert.equal(dg.fights.length, 3);
    assert.equal(dg.fights.filter((f) => f.boss).length, 1);
    assert.ok(dg.fights[2].boss);
    assert.ok(dg.fights.every((f) => ['fia', 'fis', 'bwl'].includes(f.stat) && f.title && f.text && f.success && f.fail));
  }
});

test('Bot-Karten: nur Charaktere und nur Seltenheiten mit Gewicht', () => {
  const weights = { crumpled: 0, bfwler: 0, gold: 1, holo: 0, bockhaber: 0, glitch: 0, icon: 0, sith: 0 };
  for (let i = 0; i < 200; i++) {
    const c = d.botCard(Math.random, weights);
    assert.ok(c.isCharacter);
    assert.equal(c.rarity, 'gold');
  }
  for (let i = 0; i < 200; i++) assert.ok(d.botCard().isCharacter);
});

test('Kampf: gemeinsamer Balken, Ticks nach Zeit, Schluss beim Erreichen des Ziels', () => {
  const team = [{ card: card('krisz-3-gold') }, { card: card('adrian-3-gold') }, { card: card('aleks-3-gold') }];
  for (let i = 0; i < 100; i++) {
    const r = d.fight(team, 'fia', 600);
    assert.ok(r.ticks.every((x, k) => k === 0 || r.ticks[k - 1].t <= x.t));
    const sum = r.ticks.reduce((s, x) => s + (x.p || 0), 0);
    if (r.success) {
      assert.ok(sum >= 600);
      assert.equal(r.doneAt, r.ticks[r.ticks.length - 1].t);
      assert.ok(sum - r.ticks[r.ticks.length - 1].p < 600);
    } else assert.ok(sum < 600);
    assert.ok(r.ticks.every((x) => x.m >= 0 && x.m < 3));
  }
  // unerreichbares Ziel → verloren
  assert.equal(d.fight(team, 'fia', 100000).success, false);
});

test('Dungeon: nach einer Niederlage ist Schluss; Lohn nur für gewonnene Kämpfe, Bots bekommen nichts', () => {
  const team = [{ card: card('krisz-1-crumpled') }, { card: card('adrian-1-crumpled') }, { card: card('aleks-1-crumpled') }];
  const opts = { required: [1, 100000, 1], rewards: [1000, 1500, 4000], foilChance: 100, cardChance: 100 };
  const fights = d.playDungeon(DUNGEONS[0], team, Math.random, opts);
  assert.equal(fights.length, 2);
  assert.deepEqual(fights.map((f) => f.success), [true, false]);
  assert.deepEqual(d.rewardsFor(fights, false, Math.random, opts), { reward: 1000, foil: false, bossCard: false });

  const easy = { ...opts, required: [1, 1, 1] };
  const all = d.playDungeon(DUNGEONS[0], team, Math.random, easy);
  assert.equal(all.length, 3);
  assert.deepEqual(d.rewardsFor(all, false, Math.random, easy), { reward: 6500, foil: true, bossCard: true });
  assert.deepEqual(d.rewardsFor(all, true, Math.random, easy), { reward: 0, foil: false, bossCard: false });
  assert.deepEqual(d.rewardsFor(all, false, Math.random, { ...easy, foilChance: 0, cardChance: 0 }), { reward: 6500, foil: false, bossCard: false });
});

test('Einzelspieler werden in Dreiergruppen gelost', () => {
  const teams = d.makeTeams([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(teams.map((t) => t.length), [3, 3, 1]);
  assert.deepEqual(teams.flat().sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(d.makeTeams([]), []);
});

test('Wiedergabe: gewonnene Kämpfe enden früher, verlorene dauern die volle Zeit', () => {
  const team = [{ card: card('krisz-3-gold') }, { card: card('adrian-3-gold') }, { card: card('aleks-3-gold') }];
  const lost = d.fight(team, 'fia', 100000);
  assert.equal(lost.seconds, d.FIGHT_SECONDS);
  const won = d.fight(team, 'fia', 200);
  assert.ok(won.success && won.seconds >= 5 && won.seconds < d.FIGHT_SECONDS);
  assert.equal(d.runSeconds([won, lost]), d.INTRO_SECONDS + won.seconds + lost.seconds + 2 * d.PAUSE_SECONDS);
});

test('Bots bringen eine Boost-Karte mit', () => {
  const { canBoost, needsCoffee } = require('../src/ihk/abilities');
  for (let i = 0; i < 200; i++) {
    const b = d.botBoost();
    assert.ok(b && canBoost(b) && !needsCoffee(b));
  }
});

test('Gruppen-Boosts (Ömer, Hunde, Mauch) wirken auf alle, persönliche nur auf den eigenen Spieler', () => {
  const team = [{ card: card('krisz-3-gold'), boost: card('bfw-energy-gold') }, { card: card('adrian-3-gold'), boost: card('hugo-holo') }, { card: card('aleks-3-gold') }];
  const keys = (m) => d.teamEffects(team, m).map((e) => e.key);
  // Hugo (Hund) hilft allen dreien, BFW Energy nur Krisz selbst (Nachtschicht + Energy)
  assert.ok([0, 1, 2].every((m) => keys(m).includes('hund')));
  assert.ok(keys(0).includes('bfw-energy') && keys(0).includes('nachtschicht'));
  assert.ok(!keys(1).includes('bfw-energy') && !keys(2).includes('nachtschicht'));
  const omer = catalog.CARDS.find((c) => c.id.startsWith('omer-'));
  if (omer) {
    const t2 = [{ card: card('krisz-3-gold'), boost: omer }, { card: card('adrian-3-gold') }, { card: card('aleks-3-gold') }];
    assert.ok([0, 1, 2].every((m) => d.teamEffects(t2, m).some((e) => e.key === 'osmanen' && e.from === 0)));
  }
  // derselbe Gruppen-Boost zweimal zählt nur einmal
  const t3 = [{ card: card('krisz-3-gold'), boost: card('hugo-holo') }, { card: card('adrian-3-gold'), boost: card('hugo-holo') }, { card: card('aleks-3-gold') }];
  assert.equal(d.teamEffects(t3, 2).filter((e) => e.key === 'hund').length, 1);
});
