process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const bm = require('../src/tcg/blackMarket');
const catalog = require('../src/tcg/catalog');
const BlackMarket = require('../src/models/BlackMarket');
const { itemTypeByKey } = require('../src/items/types');

/** Würfel mit festgelegten Ergebnissen: fn(n) liefert den Wurf für randomInt(n) (muss 0 … n−1 sein) */
const dice = (fn) => (n) => {
  const v = fn(n);
  assert.ok(Number.isInteger(v) && v >= 0 && v < n, `Wurf ${v} passt nicht zu randomInt(${n})`);
  return v;
};
/** Würfel, der die Werte der Reihe nach liefert; danach immer fallback(n) */
const sequence = (values, fallback = (n) => n - 1) => {
  const rest = [...values];
  return dice((n) => (rest.length ? rest.shift() : fallback(n)));
};

test('Black Market: Chancen 79/16/5 – mindestens Holo, nie Gold', () => {
  assert.equal(bm.ODDS.reduce((s, o) => s + o.percent, 0), 100);
  const count = {};
  for (let roll = 0; roll < 100; roll++) count[bm.rarityForRoll(roll)] = (count[bm.rarityForRoll(roll)] || 0) + 1;
  assert.deepEqual(count, { holo: 79, bockhaber: 16, glitch: 5 });
  assert.ok(!bm.ODDS.some((o) => o.rarity === 'gold'));
});

test('Black Market: je Angebot 5 % Folie, 1 % Bosskarte, 94 % Karte', () => {
  const count = {};
  for (let roll = 0; roll < 100; roll++) count[bm.drawKindForRoll(roll)] = (count[bm.drawKindForRoll(roll)] || 0) + 1;
  assert.deepEqual(count, { folie: 5, boss: 1, karte: 94 });
  assert.equal(bm.FOIL_PERCENT, 5);
  assert.equal(bm.BOSS_PERCENT, 1);

  // alle 100 × 100 Kombinationen aus Art- und Seltenheitswurf für das erste Angebot durchspielen
  const boss = { id: 'test-boss', rarity: 'boss' };
  const first = {};
  for (let kindRoll = 0; kindRoll < 100; kindRoll++) {
    for (let rarityRoll = 0; rarityRoll < 100; rarityRoll++) {
      const o = bm.drawOffers(sequence([kindRoll], (n) => (n === 100 ? rarityRoll : 0)), { bosses: [boss] })[0];
      const key = o.kind === 'gegenstand' ? 'folie' : o.rarity;
      first[key] = (first[key] || 0) + 1;
    }
  }
  assert.deepEqual(first, { folie: 5 * 100, boss: 1 * 100, holo: 79 * 94, bockhaber: 16 * 94, glitch: 5 * 94 });
});

test('Black Market: vier verschiedene Angebote von Holo bis Glitch (nie Gold), Preis 170 % des Verkaufspreises', () => {
  const allowed = new Set(['holo', 'bockhaber', 'glitch', 'boss', 'item']);
  for (let n = 0; n < 500; n++) {
    const offers = bm.drawOffers();
    assert.equal(offers.length, 4);
    assert.equal(new Set(offers.map((o) => o.card)).size, 4, 'kein Angebot doppelt');
    assert.ok(offers.filter((o) => o.kind === 'gegenstand').length <= 1, 'höchstens eine Folie');
    for (const o of offers) {
      assert.ok(allowed.has(o.rarity), o.rarity);
      if (o.kind === 'gegenstand') {
        assert.deepEqual(o, { kind: 'gegenstand', card: 'item:folie', rarity: 'item', price: bm.itemPriceFor(itemTypeByKey.folie) });
        continue;
      }
      assert.equal(o.kind, 'karte');
      assert.equal(catalog.cardById[o.card].rarity, o.rarity);
      assert.equal(o.price, Math.round(catalog.rarityByKey[o.rarity].sell * 1.7));
    }
  }
  assert.equal(bm.priceFor('holo'), Math.round(catalog.rarityByKey.holo.sell * 1.7));
});

test('Black Market: Folie bei Wurf 0–4, Preis mindestens 1.000 €, höchstens eine pro Tag', () => {
  const folie = itemTypeByKey.folie;
  assert.equal(bm.MIN_ITEM_PRICE, 100000);
  assert.equal(bm.itemPriceFor(folie), Math.max(100000, Math.round(folie.sell * 1.7)));
  assert.ok(bm.itemPriceFor(folie) >= 100000);
  assert.equal(bm.itemPriceFor({ sell: 100000 }), 170000, 'teurer Gegenstand: 170 % des Bankwerts');
  assert.equal(bm.itemPriceFor({ sell: 0 }), 100000);

  for (let roll = 0; roll < bm.FOIL_PERCENT; roll++) {
    const [o] = bm.drawOffers(sequence([roll]));
    assert.equal(o.kind, 'gegenstand');
    assert.equal(o.card, 'item:folie');
    assert.ok(o.price >= 100000);
  }
  assert.equal(bm.drawOffers(sequence([bm.FOIL_PERCENT + bm.BOSS_PERCENT, 0, 0]))[0].kind, 'karte', 'Wurf 6 ist eine normale Karte');

  // jeder Wurf will eine Folie: nur die erste wird eine, die übrigen werden normale (verschiedene) Karten
  const offers = bm.drawOffers(dice(() => 0));
  assert.equal(offers.length, 4);
  assert.equal(offers.filter((o) => o.kind === 'gegenstand').length, 1);
  assert.equal(offers[0].card, 'item:folie');
  assert.equal(new Set(offers.map((o) => o.card)).size, 4);
  assert.ok(offers.slice(1).every((o) => o.kind === 'karte' && o.rarity === 'holo'));
});

test('Black Market: Bosskarte bei Wurf 5 (1 %), höchstens einmal, Preis 170 % ihrer Seltenheit', () => {
  const boss = catalog.cardById['st-ivan-boss'] || { id: 'st-ivan-boss', rarity: 'boss' };
  // jeder Wurf will eine Bosskarte: nur die erste wird eine, die übrigen fallen auf normale Karten zurück
  const offers = bm.drawOffers(dice((n) => (n === 100 ? 5 : 0)), { bosses: [boss] });
  assert.equal(offers.length, 4);
  assert.deepEqual(offers[0], { kind: 'karte', card: boss.id, rarity: 'boss', price: Math.round(catalog.rarityByKey.boss.sell * 1.7) });
  assert.equal(offers.filter((o) => o.card === boss.id).length, 1);
  assert.equal(new Set(offers.map((o) => o.card)).size, 4);
  assert.ok(offers.slice(1).every((o) => o.kind === 'karte' && o.rarity === 'holo'));

  // mehrere Bosskarten: der Index-Wurf wählt eine davon
  const other = { id: 'zweiter-boss', rarity: 'boss' };
  assert.equal(bm.drawOffers(sequence([5, 1]), { bosses: [boss, other] })[0].card, 'zweiter-boss');
});

test('Black Market: Bosskarten nur aus dem Katalog – fehlt sie, entfällt die Chance ohne Fehler', () => {
  assert.deepEqual(bm.bossCards([{ key: 'a', bossCard: 'gibt-es-nicht' }, { key: 'b' }]), []);
  const fake = { 'boss-a': { id: 'boss-a' } };
  assert.deepEqual(bm.bossCards([{ bossCard: 'boss-a' }, { bossCard: 'boss-a' }, { bossCard: 'fehlt' }], fake), [fake['boss-a']], 'jede Bosskarte nur einmal');
  const real = bm.bossCards();
  assert.ok(real.every((c) => catalog.cardById[c.id] === c));
  if (catalog.cardById['st-ivan-boss']) assert.ok(real.some((c) => c.id === 'st-ivan-boss'));

  // jeder Wurf will eine Bosskarte, es gibt aber keine: vier normale Karten, kein Fehler
  const offers = bm.drawOffers(dice((n) => (n === 100 ? 5 : 0)), { bosses: [] });
  assert.equal(offers.length, 4);
  assert.ok(offers.every((o) => o.kind === 'karte' && o.rarity === 'holo'));
  assert.equal(new Set(offers.map((o) => o.card)).size, 4);
  // ohne Folien-Art (z. B. entfernt) ebenso
  const noFoil = bm.drawOffers(dice(() => 0), { foil: null });
  assert.ok(noFoil.length === 4 && noFoil.every((o) => o.kind === 'karte'));
});

test('Black Market: alte Tagesdokumente ohne Angebotsart gelten als Karten', () => {
  const holo = catalog.cardsByRarity.holo[0];
  const old = { card: holo.id, rarity: 'holo', price: 8500, buyer: null };
  assert.equal(bm.offerKind(old), 'karte');
  assert.equal(bm.offerItem(old), null);
  assert.equal(bm.offerKind({ ...old, rarity: 'gold' }), 'karte', 'alte Gold-Angebote bleiben Karten');
  assert.equal(bm.offerKind({ kind: 'gegenstand', card: 'item:folie' }), 'gegenstand');
  assert.equal(bm.offerItem({ kind: 'gegenstand', card: 'item:folie' }), itemTypeByKey.folie);
  assert.equal(bm.offerItem({ kind: 'gegenstand', card: 'item:gibt-es-nicht' }), null);
  assert.equal(bm.offerItem({ kind: 'karte', card: 'item:folie' }), null, 'nur Angebote der Art Gegenstand');

  // Modell: ohne kind gilt 'karte', andere Werte sind ungültig
  const doc = new BlackMarket({ _id: '2026-10-03', offers: [old, { kind: 'gegenstand', card: 'item:folie', rarity: 'item', price: 100000 }] });
  assert.equal(doc.validateSync(), undefined);
  assert.equal(doc.offers[0].kind, 'karte');
  assert.equal(doc.offers[1].kind, 'gegenstand');
  assert.ok(new BlackMarket({ _id: '2026-10-03', offers: [{ ...old, kind: 'quatsch' }] }).validateSync());
});

test('Black Market: geöffnet täglich 16:30 bis 19:00 deutscher Zeit (auch bei Sommerzeit)', () => {
  const berlin = (iso) => new Date(iso).getTime();
  // Oktober = Sommerzeit (UTC+2): 16:30 Berlin = 14:30 UTC
  assert.equal(bm.windowAt(berlin('2026-10-03T14:29:59Z')).open, false);
  assert.equal(bm.windowAt(berlin('2026-10-03T14:30:00Z')).open, true);
  assert.equal(bm.windowAt(berlin('2026-10-03T16:59:59Z')).open, true);
  const after = bm.windowAt(berlin('2026-10-03T17:00:00Z'));
  assert.equal(after.open, false);
  assert.equal(after.opensAt.toISOString(), '2026-10-04T14:30:00.000Z', 'nach Schluss: nächste Öffnung am Folgetag');
  const before = bm.windowAt(berlin('2026-10-03T08:00:00Z'));
  assert.equal(before.opensAt.toISOString(), '2026-10-03T14:30:00.000Z', 'vormittags: Öffnung am selben Tag');
  // Dezember = Winterzeit (UTC+1): 16:30 Berlin = 15:30 UTC
  assert.equal(bm.windowAt(berlin('2026-12-01T15:29:00Z')).open, false);
  const w = bm.windowAt(berlin('2026-12-01T15:30:00Z'));
  assert.equal(w.open, true);
  assert.equal(w.day, '2026-12-01');
  assert.equal(w.closesAt.toISOString(), '2026-12-01T18:00:00.000Z');
});
