// Shop-Demo: Laden einrichten (2:1-isometrisch, Platzhalter-Möbel aus src/shop/items.json). Vorerst nur für Admins.
// EJS ist nur der Rahmen, gezeichnet wird mit Phaser in public/js/shop-demo.js; Regeln in src/shop/layout.js
// (dieselbe Datei läuft im Browser als /js/shop-layout.js). Kanacoin = Demo-Geld, getrennt vom Kontostand.
const path = require('path');
const express = require('express');
const { requireAdmin } = require('../middleware');
const ShopDemo = require('../models/ShopDemo');
const layout = require('../shop/layout');
const { CATALOG, GROUPS, UNIT_PRICE } = require('../shop/catalog');

const router = express.Router();
const catalog = Object.fromEntries(CATALOG.map((d) => [d.id, d]));
const ACTIONS = ['place', 'move', 'remove', 'buyUnit', 'setCoins', 'reset'];

function plain(doc) {
  if (!doc) return layout.fresh();
  return {
    coins: doc.coins,
    units: doc.units,
    nextUid: doc.nextUid,
    items: (doc.items || []).map(({ uid, id, x, y, rot, wall }) => (wall ? { uid, id, x, y, rot, wall } : { uid, id, x, y, rot })),
  };
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
    res.json({ state: plain(doc), catalog: CATALOG, groups: GROUPS, unitPrice: UNIT_PRICE });
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
      x: Number(a.x),
      y: Number(a.y),
      rot: a.rot ? 1 : 0,
      wall: a.wall === 'n' || a.wall === 'w' ? a.wall : undefined,
      amount: Number(a.amount),
      price: UNIT_PRICE,
    };
    const doc = await ShopDemo.findById(req.user._id).lean();
    const r = layout.apply(plain(doc), catalog, action);
    if (r.error) return res.status(400).json({ error: r.error, state: plain(doc) });
    await ShopDemo.replaceOne({ _id: req.user._id }, r.state, { upsert: true });
    res.json({ state: r.state });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
