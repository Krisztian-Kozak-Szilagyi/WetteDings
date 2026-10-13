// Shop-Demo: eigener Laden (2:1-isometrisch, Platzhalter aus src/shop/items.json) mit Figur, PC (Bestellen, Preise),
// Kartons und Regalen. Vorerst nur für Admins.
// EJS ist nur der Rahmen, gezeichnet wird mit Phaser in public/js/shop-demo.js; Regeln in src/shop/layout.js
// (dieselbe Datei läuft im Browser als /js/shop-layout.js). Kanacoin = Demo-Geld, getrennt vom Kontostand.
const path = require('path');
const express = require('express');
const { requireAdmin } = require('../middleware');
const ShopDemo = require('../models/ShopDemo');
const layout = require('../shop/layout');
const { CATALOG, GROUPS, GOODS, UNIT_PRICE } = require('../shop/catalog');

const router = express.Router();
const catalog = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const goods = Object.fromEntries(GOODS.map((g) => [g.id, g]));
const ACTIONS = ['orderWare', 'orderMoebel', 'pick', 'drop', 'stock', 'unstock', 'build', 'move', 'remove', 'setPrice', 'buyUnit', 'setCoins', 'reset'];

function plain(doc) {
  if (!doc) return layout.ensureCounter(layout.fresh(), catalog);
  const { coins, units, nextUid, nextBid, carry, prices } = doc;
  const items = (doc.items || []).map(({ uid, id, x, y, rot, wall, stock }) => {
    const it = { uid, id, x, y, rot };
    if (wall) it.wall = wall;
    if (stock && Object.keys(stock).length) it.stock = stock;
    return it;
  });
  const boxes = (doc.boxes || []).map(({ bid, kind, id, qty, x, y }) => ({ bid, kind, id, qty, x, y }));
  return layout.ensureCounter(layout.normalize({ coins, units, nextUid, nextBid, carry, prices, items, boxes }), catalog);
}

router.get('/shop-demo', requireAdmin, (req, res) => {
  res.render('shop-demo', { title: 'Shop-Demo' });
});

router.get('/js/shop-layout.js', requireAdmin, (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, '..', 'shop', 'layout.js'));
});

router.get('/vendor/phaser.min.js', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'private, max-age=604800');
  res.type('application/javascript').sendFile(require.resolve('phaser/dist/phaser.min.js'));
});

router.get('/api/shop-demo', requireAdmin, async (req, res, next) => {
  try {
    const doc = await ShopDemo.findById(req.user._id).lean();
    res.json({ state: plain(doc), catalog: CATALOG, goods: GOODS, groups: GROUPS, unitPrice: UNIT_PRICE });
  } catch (err) {
    next(err);
  }
});

// Eine Aktion: { type, ... } als JSON im Feld "aktion" (dazu _csrf)
router.post('/api/shop-demo', requireAdmin, async (req, res, next) => {
  try {
    let a;
    try {
      a = JSON.parse(typeof req.body.aktion === 'string' ? req.body.aktion : '');
    } catch {
      a = null;
    }
    const type = a && ACTIONS.find((t) => t === a.type);
    if (!type) return res.status(400).json({ error: 'Unbekannte Aktion.' });
    const action = {
      type,
      id: typeof a.id === 'string' ? a.id : '',
      uid: Number(a.uid),
      bid: Number(a.bid),
      n: Number(a.n),
      ware: typeof a.ware === 'string' ? a.ware : '',
      price: Number(a.price),
      x: Number(a.x),
      y: Number(a.y),
      rot: a.rot ? 1 : 0,
      wall: a.wall === 'n' || a.wall === 'w' ? a.wall : undefined,
      amount: Number(a.amount),
      ...(type === 'buyUnit' ? { price: UNIT_PRICE } : {}),
    };
    const doc = await ShopDemo.findById(req.user._id).lean();
    const r = layout.apply(plain(doc), catalog, goods, action);
    if (r.error) return res.status(400).json({ error: r.error, state: plain(doc) });
    await ShopDemo.replaceOne({ _id: req.user._id }, r.state, { upsert: true });
    res.json({ state: r.state });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
