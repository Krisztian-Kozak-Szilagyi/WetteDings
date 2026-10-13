// Inventar als Item-Shop: ungeöffnete Booster Packs und Gegenstände (TCG Sleeve, leerer Slab) – kaufen, verkaufen, handeln,
// benutzen. Karten in Sleeve oder Slab stehen im Album (routes/tcg.js).
const express = require('express');
const { requireLogin } = require('../middleware');
const User = require('../models/User');
const { GradingShop } = require('../models/Grading');
const catalog = require('../tcg/catalog');
const tcg = require('../tcg/tcgService');
const settings = require('../tcg/settings');
const { CATEGORIES } = require('../items/types');
const items = require('../items/itemService');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/inventar', requireLogin);

const page = (mode) => async (req, res) => {
  const [packs, itemList, foilable, shop] = await Promise.all([
    tcg.packInventory(req.user._id),
    items.itemInventory(req.user._id),
    items.foilableCards(req.user._id),
    GradingShop.findById(req.user._id).select('active').lean(),
    // Besuch merken: neue Packs (Quest, Geschenk) gelten ab jetzt als gesehen
    User.updateOne({ _id: req.user._id }, { $set: { packsSeenAt: new Date() } }),
  ]);
  res.locals.newPacks = 0;
  res.render('inventar', {
    mode,
    title: mode === 'shop' ? 'Shop' : 'Inventar',
    packs,
    itemList: itemList.map((it) => ({ ...it, buy: items.buyPrice(it) })), // Shop-Preis aktuell aus den Admin-Einstellungen
    foilable,
    hasShop: !!(shop && shop.active), // leere Slabs im Shop nur mit aktivem Grading-Shop
    itemCategories: CATEGORIES,
    packPrice: settings.getPackPrice(),
    cardsPerPack: catalog.CARDS_PER_PACK,
    packImage: catalog.PACK_IMAGE,
    packType: catalog.DEFAULT_PACK,
  });
};
router.get('/inventar', page('inventar'));
router.get('/inventar/shop', page('shop'));

async function act(req, res, fn) {
  try {
    const target = await fn();
    return res.redirect(target || '/inventar');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect('/inventar');
  }
}

router.post('/inventar/folieren', (req, res) =>
  act(req, res, async () => {
    // die Karte im neuen Sleeve öffnet sich im Album in 3D – eine Schutzhülle ohne Note (#204: nur ein Slab zeigt sie)
    const { copyId } = await items.foilCard({ user: req.user, cardId: str(req.body.card) });
    return `/tcg/album?neu=${copyId}`;
  })
);

// Gegenstände an die Bank verkaufen
router.post('/inventar/verkaufen', (req, res) =>
  act(req, res, async () => {
    const count = Number.parseInt(str(req.body.count), 10);
    const { type, count: n, proceeds } = await items.sellItems({ user: req.user, type: str(req.body.type), count: Number.isInteger(count) ? count : 1 });
    return '/inventar'; // Slot oben aktualisiert sich
    return '/inventar/shop'; // im Shop bleiben – bequem für weitere Käufe
  })
);

// Gegenstände vom Bank-Shop kaufen (TCG Sleeve) – leere Slabs auch hier (nur mit Grading-Shop), zusätzlich in der Werkstatt (routes/grading.js)
router.post('/inventar/kaufen', (req, res) =>
  act(req, res, async () => {
    const count = Number.parseInt(str(req.body.count), 10);
    const { type, count: n, cost } = await items.buyItems({ user: req.user, type: str(req.body.type), count: Number.isInteger(count) ? count : 1, via: 'bank' });
    req.flash('success', `${n}× ${type.label} gekauft für ${euro(cost)}.`);
    return '/inventar/shop'; // im Shop bleiben – bequem für weitere Käufe
  })
);

module.exports = router;
