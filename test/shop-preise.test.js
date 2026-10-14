const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shop/layout');
const C = require('../src/shop/customers');
const { GOODS } = require('../src/shop/catalog');

const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

test('Runden und +5 % vom Marktpreis', () => {
  assert.strictEqual(L.roundPrice(103), 105);
  assert.strictEqual(L.roundPrice(106), 105);
  assert.strictEqual(L.roundPrice(102), 100);
  assert.strictEqual(L.roundPrice(11.73), 11.5, 'unter 20 auf 0,50');
  assert.strictEqual(L.priceStepUp(100, 100), 105);
  assert.strictEqual(L.priceStepUp(105, 100), 110);
  assert.strictEqual(L.priceStepUp(107, 100), 110, 'krummer Preis: auf die nächste Stufe');
  assert.strictEqual(L.priceStepUp(10, 10), 10.5);
});

test('Marktpreise: 50 % Chance, 2 hoch, 2 runter, Grenzen 70–150 %, Einkauf bleibt', () => {
  const s0 = L.fresh();
  const none = L.moveMarket(s0, goods, seq(0.9));
  assert.deepStrictEqual(none.marketMoves, [], 'keine Änderung');
  const moved = L.moveMarket(s0, goods, seq(0.1, 0.5, 0.3, 0.7, 0.2, 0.9, 0.4, 0.6, 0.8, 0.99));
  assert.strictEqual(moved.marketMoves.length, 4);
  assert.strictEqual(moved.marketMoves.filter((m) => m.to > m.from).length, 2);
  assert.strictEqual(moved.marketMoves.filter((m) => m.to < m.from).length, 2);
  moved.marketMoves.forEach((m) => assert.ok(!goods[m.id].kind || goods[m.id].kind === 'ware', 'kein Material'));
  // viele Tage: nie unter 70 % / über 150 %, nie unter dem Einkaufspreis
  let s = s0;
  const rnd = (() => { let a = 7; return () => ((a = (a * 16807) % 2147483647) / 2147483647); })();
  for (let d = 0; d < 300; d++) s = L.moveMarket(s, goods, rnd);
  Object.keys(s.market).forEach((id) => {
    const p = L.marketPrice(s, goods, id);
    assert.ok(p >= goods[id].market * 0.7 - 0.01 && p <= goods[id].market * 1.5 + 0.01, id + ' in den Grenzen');
    assert.ok(p > goods[id].buy, id + ' nie unter dem Einkauf');
  });
  // ohne eigenen Preis folgt der Verkaufspreis dem Markt
  const id = moved.marketMoves[0].id;
  assert.strictEqual(L.price(moved, goods, id), moved.marketMoves[0].to);
});

test('Kunden messen am aktuellen Marktpreis', () => {
  const offer = { uid: 1, ware: 'booster_pack', qty: 5, price: 14 };
  assert.deepStrictEqual(C.shop({ tol: 0, wish: 'booster_pack' }, [offer], goods, () => 0.99).basket, [], '14 bei Markt 10 (+40 %) = zu teuer');
  const buys = C.shop({ tol: 0, wish: 'booster_pack' }, [Object.assign({ market: 12 }, offer)], goods, () => 0.99).basket;
  assert.strictEqual(buys.length, 1, 'bei Markt 12 geht 14 durch');
});
