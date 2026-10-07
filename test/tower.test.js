process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');
const d = require('../src/dungeon/dungeonService');
const { TOWER, floorByKey } = require('../src/dungeon/tower');
const { DUNGEONS, defOf, dungeonForSlot } = require('../src/dungeon/dungeons');

const card = (id) => catalog.cardById[id];
const team = () => [{ card: card('krisz-3-gold') }, { card: card('adrian-3-gold') }, { card: card('aleks-3-gold') }];
const opts = (extra = {}) => ({ ...d.DEFAULTS.tower, ...extra });

test('Mage Tower: Begegnungen für jede Fachrichtung, vollständig und eindeutig', () => {
  for (const stat of ['fia', 'fis', 'bwl']) assert.ok(TOWER.floors.filter((f) => f.stat === stat).length >= 2, `mindestens zwei ${stat}-Begegnungen`);
  assert.equal(new Set(TOWER.floors.map((f) => f.key)).size, TOWER.floors.length);
  assert.ok(TOWER.floors.every((f) => f.title && f.text && f.success && f.fail));
  assert.ok(catalog.cardById[TOWER.bossCard]);
  // nicht in der Dungeon-Rotation, aber über seinen Schlüssel auffindbar
  assert.ok(!DUNGEONS.includes(TOWER));
  for (let h = 0; h < 48; h += 2) assert.notEqual(dungeonForSlot(new Date(Date.UTC(2026, 0, 1, h)), 2).key, TOWER.key);
  assert.equal(defOf(TOWER.key), TOWER);
  assert.equal(defOf('st-ivan').key, 'st-ivan');
  assert.equal(defOf('weg'), null);
});

test('Mage Tower: Ziel und Lohn steigen mit jeder Runde, Chancen haben eine Obergrenze', () => {
  const o = opts({ baseRequired: 1000, growth: 10, rewardBase: 1000, rewardStep: 500, foilPerRound: 2, foilMax: 15, cardPerRound: 1, cardMax: 5 });
  assert.equal(d.towerRequired(1, o), 1000);
  assert.equal(d.towerRequired(2, o), 1100);
  assert.equal(d.towerRequired(3, o), 1210);
  for (let n = 1; n < 30; n++) assert.ok(d.towerRequired(n + 1, o) > d.towerRequired(n, o));
  assert.deepEqual([1, 2, 5].map((n) => d.towerReward(n, o)), [1000, 1500, 3000]);
  assert.deepEqual(d.towerChances(0, o), { foil: 0, card: 0 });
  assert.deepEqual(d.towerChances(3, o), { foil: 6, card: 3 });
  assert.deepEqual(d.towerChances(100, o), { foil: 15, card: 5 });
});

test('Mage Tower: Runden bis zur ersten Niederlage, zufällige Fachrichtung, nie zweimal dieselbe Begegnung', () => {
  const stats = new Set();
  for (let i = 0; i < 50; i++) {
    const fights = d.playTower(team(), Math.random, opts());
    const last = fights[fights.length - 1];
    assert.equal(last.success, false);
    assert.ok(fights.slice(0, -1).every((f) => f.success));
    fights.forEach((f, k) => {
      assert.ok(floorByKey[f.key]);
      stats.add(floorByKey[f.key].stat);
      assert.equal(f.required, d.towerRequired(k + 1, opts()));
      assert.equal(f.reward, d.towerReward(k + 1, opts()));
      if (k) assert.notEqual(f.key, fights[k - 1].key);
      // kurze Wiedergabe je Runde
      assert.ok(f.seconds <= opts().fightSeconds);
    });
  }
  assert.deepEqual([...stats].sort(), ['bwl', 'fia', 'fis']);
});

test('Mage Tower: Sicherheitsgrenze bei unendlich leichten Runden', () => {
  const fights = d.playTower(team(), Math.random, opts({ baseRequired: 1, growth: 1 }), 12);
  assert.equal(fights.length, 12);
  assert.ok(fights.every((f) => f.success));
  assert.ok(d.MAX_ROUNDS >= 50);
});

test('Mage Tower: Lohn aller geschafften Runden, Beute nach Runden gewürfelt, Bots bekommen nichts', () => {
  const won = (reward) => ({ success: true, reward });
  const fights = [won(1000), won(1500), won(2000), { success: false, reward: 2500 }];
  const sure = opts({ foilPerRound: 50, foilMax: 100, cardPerRound: 50, cardMax: 100 });
  assert.deepEqual(d.towerRewardsFor(fights, false, () => 0.99, sure), { reward: 4500, foil: true, bossCard: true });
  assert.deepEqual(d.towerRewardsFor(fights, true, () => 0, sure), { reward: 0, foil: false, bossCard: false });
  // Chance 3 × 10 % = 30 %: Wurf 0,25 trifft, 0,35 nicht
  const ten = opts({ foilPerRound: 10, foilMax: 100, cardPerRound: 10, cardMax: 100 });
  assert.equal(d.towerRewardsFor(fights, false, () => 0.25, ten).foil, true);
  assert.equal(d.towerRewardsFor(fights, false, () => 0.35, ten).foil, false);
  // gleich in Runde 1 gescheitert: nichts, auch kein Glückswurf
  assert.deepEqual(d.towerRewardsFor([{ success: false, reward: 1000 }], false, () => 0, sure), { reward: 0, foil: false, bossCard: false });
});

test('Mage Tower: kein Termin, also keine Sperrfrist; Tag in deutscher Zeit', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0);
  assert.equal(d.partyLocked({ mode: 'tower', slot: new Date(now - 3600000) }, now), false);
  assert.equal(d.partyLocked({ mode: 'dungeon', slot: new Date(now + 5000) }, now), true);
  assert.equal(d.partyLocked({ slot: new Date(now + 3600000) }, now), false);
  // 23:30 UTC im Winter ist in Berlin schon der nächste Tag
  assert.equal(d.towerDay(Date.UTC(2026, 0, 15, 22, 59)), '2026-01-15');
  assert.equal(d.towerDay(Date.UTC(2026, 0, 15, 23, 30)), '2026-01-16');
  assert.equal(d.towerResultText(0), 'gleich in der ersten Runde gescheitert');
  assert.equal(d.towerResultText(1), '1 Runde geschafft');
  assert.equal(d.towerResultText(7), '7 Runden geschafft');
});

test('Mage Tower: Bots füllen auf drei Plätze auf', () => {
  const members = d.fillBots([{ user: 'u1', name: 'A', card: 'krisz-3-gold' }]);
  assert.equal(members.length, d.TEAM_SIZE);
  assert.deepEqual(members.map((m) => m.bot), [false, true, true]);
  assert.ok(d.teamCards(members).every((m) => m.card && m.card.isCharacter));
});

test('Wiedergabe: Turm-Runden laufen kürzer, Pause je Modus', () => {
  const lost = d.fight(team(), 'fia', 100000, Math.random, 20);
  assert.ok(lost.seconds <= 20);
  assert.equal(d.runSeconds([lost, lost], 4), d.INTRO_SECONDS + 2 * lost.seconds + 4 + 2);
});

test('Seltene Beute aus dem Turm heißt „Mage Tower“', () => {
  const at = new Date('2026-10-07T12:00:00Z');
  const list = d.lootEntries([{ dungeon: TOWER.key, endsAt: at, members: [{ user: 'u1', name: 'a', foil: true, bossCard: true }] }]);
  assert.equal(list[0].dungeon, 'Mage Tower');
  assert.equal(list[0].card.name, card(TOWER.bossCard).name);
});
