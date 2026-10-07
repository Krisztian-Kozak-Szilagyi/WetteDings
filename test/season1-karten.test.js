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
    assert.ok(!catalog.cardById[id], id);
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
