const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../src/tcg/catalog');

const MARK = ['mark-suntouched-1-footman', 'mark-suntouched-2-gold', 'mark-suntouched-3-holo', 'mark-suntouched-4-arcane'];

test('Mark Suntouched: vier Seltenheiten in Season 1, ohne Werte', () => {
  const ids = catalog.UNRELEASED_CARDS.map((c) => c.id);
  for (const id of MARK) assert.ok(ids.includes(id), id);
  const cards = catalog.UNRELEASED_CARDS.filter((c) => MARK.includes(c.id));
  assert.deepStrictEqual(cards.map((c) => c.rarity).sort(), ['arcane', 'footman', 'gold', 'holo']);
  for (const c of cards) {
    assert.strictEqual(c.name, 'Mark Suntouched');
    assert.strictEqual(c.season, 'season-1');
    assert.strictEqual(c.stats, null);
    assert.ok(!c.frame);
  }
});

test('unveröffentlichte Karten sind nirgends erhältlich', () => {
  for (const id of MARK) {
    assert.ok(!catalog.CARDS.some((c) => c.id === id), id);
    assert.ok(catalog.cardById[id], id); // bekannt (vergebene Exemplare), aber in keiner Liste
  }
  for (const list of Object.values(catalog.cardsByRarity)) assert.ok(!list.some((c) => c.unreleased));
  for (const list of Object.values(catalog.cardsBySeason)) assert.ok(!list.some((c) => c.unreleased));
});

test('Footman und Arcane: geheim, ohne Pack-Chance, bestehende Ränge unverändert', () => {
  for (const key of ['footman', 'arcane']) {
    const r = catalog.rarityByKey[key];
    assert.ok(r.hidden && r.noBank);
    assert.ok(!catalog.RARITIES.includes(r));
    assert.ok(!catalog.visibleRarities().includes(r));
  }
  // PackOpening.best speichert den rank – die alten Seltenheiten dürfen nicht verrutschen
  assert.strictEqual(catalog.rarityByKey.holo.rank, 3);
  assert.strictEqual(catalog.rarityByKey.boss.rank, 8);
  assert.strictEqual(catalog.TOTAL_WEIGHT, 10000);
});

test('Album: unveröffentlichte Karte erscheint als „?“ mit verdeckter Seltenheit', () => {
  const ejs = require('ejs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'views', 'partials', 'tcg-grid.ejs');
  const card = catalog.UNRELEASED_CARDS.find((c) => c.id === 'mark-suntouched-2-gold');
  const html = ejs.render(require('fs').readFileSync(file, 'utf8'), { mode: 'album', cards: [card], counts: {}, rarityByKey: catalog.rarityByKey, protectedIds: new Set() }, { filename: file });
  assert.match(html, /Noch nicht erhältlich/);
  assert.match(html, /\?\?\?/);
  assert.doesNotMatch(html, /Mark Suntouched|<img/);
});

test('Album: alle unveröffentlichten Karten in einer Farbe, ohne Seltenheits-Klasse', () => {
  const ejs = require('ejs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'views', 'partials', 'tcg-grid.ejs');
  const cards = catalog.UNRELEASED_CARDS.filter((c) => MARK.includes(c.id));
  const html = ejs.render(require('fs').readFileSync(file, 'utf8'), { mode: 'album', cards, counts: {}, rarityByKey: catalog.rarityByKey, protectedIds: new Set() }, { filename: file });
  assert.strictEqual((html.match(/tcg-soon/g) || []).length, 4);
  assert.doesNotMatch(html, /r-(gold|holo|footman|arcane)|data-rarity="(gold|holo|footman|arcane)"/);
});
