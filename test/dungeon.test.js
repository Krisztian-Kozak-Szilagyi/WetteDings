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

test('Dungeons: jeder Termin hat einen Dungeon, alle gleich aufgebaut', () => {
  const a = d.slotAfter(Date.UTC(2026, 0, 15, 10, 0), 2);
  const b = d.slotAfter(a.getTime(), 2);
  assert.ok(dungeonForSlot(a, 2) && dungeonForSlot(b, 2));
  if (DUNGEONS.length > 1) assert.notEqual(dungeonForSlot(a, 2).key, dungeonForSlot(b, 2).key);
  for (const dg of DUNGEONS) {
    // gleiche Reihenfolge der Fachrichtungen in allen Dungeons – die Ziel-Punkte gelten für alle (Balancing)
    assert.deepEqual(dg.fights.map((f) => f.stat), ['bwl', 'fia', 'fis']);
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

test('Start (#111): nur wer in der Lobby einen Charakter gewählt hat, ist dabei', () => {
  const at = new Date();
  const party = { members: [
    { user: 'a', name: 'A', card: 'x', cardDoc: 'd1', boost: null, boostDoc: null, joinedAt: at },
    { user: 'b', name: 'B', card: null, cardDoc: null, boost: 'y', boostDoc: 'd2', joinedAt: at }, // nur Boost gewählt
  ] };
  const { players, dropped } = d.splitPlayers([party, { members: [{ user: 'c', name: 'C', card: null, joinedAt: at }] }]);
  assert.deepEqual(players.map((m) => m.user), ['a']);
  assert.equal(players[0].joinedAt, at); // Anmeldezeit bleibt im Durchlauf (Manipulationserkennung)
  assert.deepEqual(dropped, ['b', 'c']);
  assert.deepEqual(d.splitPlayers([]), { players: [], dropped: [], banned: [] });
});

test('Wiedergabe: gewonnene Kämpfe enden früher, verlorene dauern die volle Zeit', () => {
  const team = [{ card: card('krisz-3-gold') }, { card: card('adrian-3-gold') }, { card: card('aleks-3-gold') }];
  const lost = d.fight(team, 'fia', 100000);
  assert.ok(lost.seconds <= d.FIGHT_SECONDS && Math.abs(lost.seconds - (d.FIGHT_SECONDS * (lost.limit - lost.start)) / lost.limit) <= 0.1);
  const won = d.fight(team, 'fia', 200);
  assert.ok(won.success && won.seconds > 0 && won.seconds < d.FIGHT_SECONDS);
  // gleichmäßiges Tempo: Sieg-Zeitpunkt (Spielzeit) im selben Verhältnis wie bei der vollen Zeit
  assert.ok(Math.abs(won.seconds - (d.FIGHT_SECONDS * (won.doneAt - won.start)) / won.limit) <= 1);
  // die Wiedergabe beginnt höchstens eine Sekunde vor dem ersten Treffer
  assert.ok(won.start <= won.ticks[0].t && (won.ticks[0].t - won.start) * d.FIGHT_SECONDS / won.limit <= 1.05);
  assert.equal(d.runSeconds([won, lost]), d.INTRO_SECONDS + won.seconds + lost.seconds + d.PAUSE_SECONDS + 2);
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

test('Seltene Beute: nur echte Spieler mit Folie oder Boss-Karte, aktuelle Namen (#78)', () => {
  const at = new Date('2026-10-05T12:00:00Z');
  const runs = [{ dungeon: 'st-ivan', endsAt: at, members: [
    { user: 'u1', name: 'alt', foil: true, bossCard: false },
    { user: 'u2', name: 'bob', foil: false, bossCard: true },
    { user: 'u3', name: 'leer', foil: false, bossCard: false },
    { user: null, name: 'Bot', foil: true, bossCard: true },
  ] }];
  const list = d.lootEntries(runs, { u1: 'neu' });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { name: 'neu', dungeon: DUNGEONS.find((x) => x.key === 'st-ivan').title, foil: true, card: null, at });
  assert.equal(list[1].name, 'bob');
  assert.equal(list[1].card.name, card('st-ivan-boss').name);
  assert.equal(list[1].card.rarity, card('st-ivan-boss').rarity);
  // unbekannter Dungeon ohne Boss-Karte: nur die Folie zählt
  assert.deepEqual(d.lootEntries([{ dungeon: 'weg', endsAt: at, members: [{ user: 'u9', name: 'x', foil: false, bossCard: true }] }]), []);
});

test('Kartensperren: gesperrte Karte fällt beim Start heraus, Bots nehmen sie nicht', () => {
  const banned = new Set(['x']);
  const party = { members: [
    { user: 'a', name: 'A', card: 'x', boost: null },
    { user: 'b', name: 'B', card: 'z', boost: 'x' }, // nur als Boost gewählt
    { user: 'c', name: 'C', card: 'z', boost: null },
  ] };
  const r = d.splitPlayers([party], banned);
  assert.deepEqual(r.players.map((m) => m.user), ['c']);
  assert.deepEqual(r.banned, ['a', 'b']);
  assert.deepEqual(r.dropped, []);
  const chars = catalog.CARDS.filter((c) => c.isCharacter).map((c) => c.id);
  const one = new Set([chars[0]]);
  for (let i = 0; i < 100; i++) assert.notEqual(d.botCard(Math.random, undefined, one).id, chars[0]);
  // alles gesperrt: Bots finden trotzdem eine Karte
  for (let i = 0; i < 20; i++) assert.ok(d.botCard(Math.random, undefined, new Set(chars)).isCharacter);
  assert.equal(d.botBoost(Math.random, undefined, new Set(catalog.CARDS.map((c) => c.id))), null);
});

test('Kartensperren: nur bekannte Modi, Text', () => {
  const cardBans = require('../src/tcg/cardBans');
  assert.deepEqual(cardBans.pickModes(['tower', 'ihk', 'dungeon', 'constructor']), ['dungeon', 'tower']);
  assert.deepEqual(cardBans.pickModes('tower'), ['tower']);
  assert.deepEqual(cardBans.pickModes(undefined), []);
  assert.equal(cardBans.modesText(['dungeon', 'tower']), 'Dungeon und Mage Tower');
  assert.equal(cardBans.isBanned('krisz-3-gold', 'dungeon'), false);
  assert.equal(d.modeOf({ mode: 'tower' }), 'tower');
  assert.equal(d.modeOf({}), 'dungeon');
});
