process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const review = require('../src/stats/weeklyReview');
const { dueOf } = require('../src/stats/weeklyReviewService');
const { bestCard } = require('../src/forum/hallOfFame');
const forum = require('../src/forum/forumService');
const { CATEGORIES } = require('../src/forum/starters');
const { systemAuthor } = require('../src/forum/systemAuthors');

test('Wochenrückblick: fällig nur freitags ab 11:30 Uhr deutscher Zeit', () => {
  assert.equal(review.weekdayOf('2026-10-09'), 5);
  assert.equal(dueOf(new Date('2026-10-08T10:00:00Z')).due, null); // Donnerstag
  const fri = dueOf(new Date('2026-10-09T07:00:00Z'));
  assert.equal(fri.day, '2026-10-09');
  assert.equal(fri.due.toISOString(), '2026-10-09T09:30:00.000Z'); // 11:30 MESZ
  assert.equal(dueOf(new Date('2026-12-04T12:00:00Z')).due.toISOString(), '2026-12-04T10:30:00.000Z'); // 11:30 MEZ
  assert.equal(review.shiftDay('2026-10-09', -7), '2026-10-02');
  assert.equal(review.shiftDay('2026-03-31', 1), '2026-04-01');
});

test('Wochenrückblick: Gewinner und Aufsteiger nur unter Mitgliedern, die es vor einer Woche schon gab', () => {
  const now = [
    { user: 'a', username: 'anna', total: 50000 },
    { user: 'n', username: 'neu', total: 40000 }, // neu: zählt nicht
    { user: 'b', username: 'ben', total: 30000 },
    { user: 'c', username: 'cleo', total: 20000 },
    { user: 'd', username: 'dora', total: 10000 },
  ];
  const past = [
    { user: 'a', total: 45000 },
    { user: 'b', total: 10000 },
    { user: 'c', total: 60000 },
    { user: 'd', total: 9000 },
    { user: 'x', total: 99999 }, // inzwischen gelöscht
  ];
  const { gainers, climber } = review.standings(now, past);
  assert.deepEqual(gainers.map((g) => [g.name, g.gain]), [['ben', 20000], ['anna', 5000], ['dora', 1000]]);
  // vorher: cleo 1, anna 2, ben 3, dora 4 → jetzt: anna 1, ben 2, cleo 3, dora 4
  assert.equal(climber.name, 'ben'); // anna und ben je +1 Platz → der größere Zuwachs entscheidet
  assert.deepEqual(review.standings([], past), { gainers: [], climber: null });
  assert.equal(review.standings(now.slice(0, 1), past).climber, null);
});

test('Wochenrückblick: seltenste Ziehung ohne geheime Seltenheiten, bester Trade = höchster Preis', () => {
  const t0 = new Date('2026-10-05T10:00:00Z');
  const t1 = new Date('2026-10-06T10:00:00Z');
  const openings = [
    { user: 'u1', username: 'anna', createdAt: t1, cards: [{ card: 'x', rarity: 'holo' }] },
    { user: 'u2', username: 'ben', createdAt: t0, cards: [{ card: 'y', rarity: 'holo' }, { card: 'z', rarity: 'crumpled' }] },
    { user: 'u3', username: 'sith', createdAt: t0, cards: [{ card: 's', rarity: 'sith' }] },
  ];
  const pull = review.rarestPull(openings, bestCard);
  assert.equal(pull.name, 'ben'); // gleich selten, früher
  assert.equal(pull.rarity.key, 'holo');
  assert.equal(review.rarestPull([], bestCard), null);

  const trade = review.bestTrade([
    { sellerName: 'a', buyerName: 'b', price: 500, closedAt: t1 },
    { sellerName: 'c', buyerName: 'd', price: 900, closedAt: t1 },
    { sellerName: 'e', buyerName: null, price: 5000, closedAt: t0 },
  ]);
  assert.equal(trade.sellerName, 'c');
});

test('Wochenrückblick: Text mit allen vier Abschnitten, auch ohne Daten', () => {
  const full = review.reviewText({
    from: '2026-10-02',
    to: '2026-10-09',
    gainers: [{ name: 'anna', gain: 12345 }],
    climber: { name: 'ben', from: 7, to: 2 },
    pull: { name: 'cleo', card: 'luca', cardName: 'Luca', rarity: { label: 'Glitch' } },
    trade: { buyerName: 'dora', sellerName: 'emil', label: 'Aleks (Holo)', price: 25000 },
  });
  assert.equal(full.title, 'Wochenrückblick 02.10. – 09.10.2026');
  for (const s of ['## Top-Gewinner der Woche', '@anna', '## Seltenste Ziehung', '[karte:luca]', '## Bester Trade', '@dora', '@emil', '## Größter Aufsteiger in der Rangliste', '5 Plätze']) {
    assert.ok(full.body.includes(s), s);
  }
  const empty = review.reviewText({ from: '2026-10-02', to: '2026-10-09' });
  assert.ok(empty.body.includes('kein Pack geöffnet'));
  assert.ok(empty.body.includes('nichts verkauft'));
});

test('Forum: Wochenrückblick-Bereich und Verfasser; Löschschutz nur für Bereiche, die die Seite braucht', () => {
  const def = CATEGORIES.find((c) => c.key === 'wochenrueckblick');
  assert.equal(def.parent, 'allgemein');
  assert.ok(def.staffOnly);
  assert.ok(systemAuthor('Wochenrückblick'));
  for (const key of ['patchnotes', 'boersenbericht', 'wochenrueckblick', 'esports', 'esports-0123']) assert.ok(forum.isProtected({ key }), key);
  for (const key of ['plauderecke', 'wetten', 'halloffame', 'allgemein', null]) assert.ok(!forum.isProtected({ key }), String(key));
});
