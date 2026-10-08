process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/dungeon/dungeonService');
const { DUNGEONS, CHAOS, defOf, dungeonByKey } = require('../src/dungeon/dungeons');
const bm = require('../src/tcg/blackMarket');

test('Chaos Dungeon: geheim – nicht in der Rotation, keine Geschichte, aber über defOf auffindbar', () => {
  assert.ok(!DUNGEONS.includes(CHAOS));
  assert.ok(!dungeonByKey[CHAOS.key]);
  assert.equal(CHAOS.story, undefined);
  assert.equal(defOf(CHAOS.key), CHAOS);
  assert.ok(dungeonByKey[CHAOS.replaces], 'der verdrängte Dungeon muss existieren');
  assert.ok(CHAOS.arrival);
});

test('Chaos Dungeon: drei Kämpfe wie ein normaler Dungeon, der letzte ist der Boss', () => {
  assert.equal(CHAOS.fights.length, 3);
  assert.ok(CHAOS.fights.every((f) => ['fia', 'fis', 'bwl'].includes(f.stat) && f.title && f.text && f.success && f.fail));
  assert.deepEqual(CHAOS.fights.map((f) => !!f.boss), [false, false, true]);
  assert.equal(new Set(CHAOS.fights.map((f) => f.key)).size, 3);
});

test('Chaos-Boss-Karte: einziger Weg ist der Chaos Dungeon – nicht im Black Market, nicht beim Turm', () => {
  assert.ok(CHAOS.bossCard);
  assert.ok(!DUNGEONS.some((x) => x.bossCard === CHAOS.bossCard));
  assert.notEqual(defOf('mage-tower') && defOf('mage-tower').bossCard, CHAOS.bossCard);
  assert.ok(!bm.bossCards().some((c) => c.id === CHAOS.bossCard));
});

test('Event würfeln: nur bei St. Ivan, mit der Chance aus den Einstellungen', () => {
  const ivan = dungeonByKey[CHAOS.replaces];
  const opts = { ...d.settings, chaos: { ...d.DEFAULTS.chaos, chance: 10 } };
  const hit = d.rollChaos(ivan, () => 0.05, opts);
  assert.equal(hit.dungeon, CHAOS);
  assert.equal(hit.event, ivan.key);
  assert.equal(hit.opts, opts.chaos);
  const miss = d.rollChaos(ivan, () => 0.15, opts);
  assert.equal(miss.dungeon, ivan);
  assert.equal(miss.event, null);
  assert.equal(miss.opts, opts);
  // Chance 0: nie, 100: immer
  assert.equal(d.rollChaos(ivan, () => 0, { ...opts, chaos: { ...opts.chaos, chance: 0 } }).event, null);
  assert.equal(d.rollChaos(ivan, () => 0.999999, { ...opts, chaos: { ...opts.chaos, chance: 100 } }).event, ivan.key);
  // anderer Dungeon: nie
  assert.equal(d.rollChaos({ key: 'anderer' }, () => 0, { ...opts, chaos: { ...opts.chaos, chance: 100 } }).event, null);
});

test('Chaos-Beute: Lohn und Chancen aus den Chaos-Einstellungen', () => {
  const chaos = { chance: 100, required: [1, 1, 1], rewards: [100, 200, 900], foilChance: 100, cardChance: 100 };
  const fights = [{ success: true, reward: 100 }, { success: true, reward: 200 }, { boss: true, success: true, reward: 900 }];
  assert.deepEqual(d.rewardsFor(fights, false, () => 0.5, chaos), { reward: 1200, foil: true, bossCard: true });
  assert.deepEqual(d.rewardsFor(fights, false, () => 0.5, { ...chaos, foilChance: 0, cardChance: 0 }), { reward: 1200, foil: false, bossCard: false });
  assert.deepEqual(d.rewardsFor(fights, true, () => 0, chaos), { reward: 0, foil: false, bossCard: false });
});

test('Wiedergabe: das Event verlängert die Einleitung, Meldung vor dem Wechsel', () => {
  const fights = [{ seconds: 10 }];
  assert.equal(d.runSeconds(fights, d.PAUSE_SECONDS, d.EVENT_INTRO_SECONDS) - d.runSeconds(fights), d.EVENT_INTRO_SECONDS - d.INTRO_SECONDS);
  assert.ok(d.EVENT_ALERT_SECONDS < d.EVENT_REVEAL_SECONDS && d.EVENT_REVEAL_SECONDS < d.EVENT_INTRO_SECONDS);
});

test('Seltene Beute: noch nicht gezeichnete Chaos-Boss-Karte erscheint als „Geheime Boss-Karte“', () => {
  const at = new Date('2026-10-08T12:00:00Z');
  const list = d.lootEntries([{ dungeon: CHAOS.key, endsAt: at, members: [{ user: 'u1', name: 'a', foil: false, bossCard: true }] }]);
  assert.equal(list.length, 1);
  assert.equal(list[0].dungeon, CHAOS.title);
  assert.ok(list[0].card && list[0].card.name);
});
