process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');
const catalog = require('../src/tcg/catalog');
const viewHelpers = require('../src/lib/viewHelpers');

const grid = path.join(__dirname, '..', 'views', 'partials', 'tcg-grid.ejs');
const [A, B] = catalog.CARDS;
const tradeLink = (id) => '/handel/tausch?' + new URLSearchParams({ an: 'Bob', will: id });

// Fremde Sammlung mit einer normalen Karte (A) und einem folierten Exemplar (B)
const render = (linkFor) =>
  ejs.renderFile(grid, {
    ...viewHelpers,
    mode: 'view',
    cards: [A, B],
    counts: { [A.id]: 2, [B.id]: 1 },
    foiledCopies: { [B.id]: [{ id: 'copy1', foiledAt: new Date('2026-01-01') }] },
    lockedByCard: {},
    rarityByKey: catalog.rarityByKey,
    ownedCounts: { [A.id]: 3 },
    linkFor,
  });

test('Fremde Sammlung: Klick vergrößert die Karte, der Tausch steht erst in der Großansicht', async () => {
  const html = await render(tradeLink);
  assert.match(html, /data-zoom-card/);
  assert.ok(html.includes(`data-trade-href="/handel/tausch?an=Bob&amp;will=${A.id}"`));
  assert.ok(!/<a [^>]*href="\/handel\/tausch/.test(html), 'keine Kachel darf direkt zum Tausch verlinken');
  assert.ok(html.includes('data-owned="3"'));
  // folierte Exemplare: eigene Großansicht, Tausch per "f:<Exemplar>"
  assert.ok(html.includes('data-trade-href="/handel/tausch?an=Bob&amp;will=f%3Acopy1"'));
});

test('Eigene Sammlung: nur ansehen, kein Tausch', async () => {
  const html = await render(null);
  assert.ok(!html.includes('data-trade-href'));
  assert.ok(!html.includes('data-zoom-card'));
});
