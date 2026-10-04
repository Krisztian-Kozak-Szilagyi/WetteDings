// Inventar: ungeöffnete Booster Packs, Gegenstände (Folie) und folierte Karten
const express = require('express');
const mongoose = require('mongoose');
const { requireLogin } = require('../middleware');
const User = require('../models/User');
const catalog = require('../tcg/catalog');
const tcg = require('../tcg/tcgService');
const items = require('../items/itemService');
const foil = require('../items/foil');
const { str, UserError } = require('../lib/util');

const router = express.Router();
router.use('/inventar', requireLogin);

router.get('/inventar', async (req, res) => {
  const [packs, itemList, foiled, foilable] = await Promise.all([
    tcg.packInventory(req.user._id),
    items.itemInventory(req.user._id),
    items.foiledCards(req.user._id),
    items.foilableCards(req.user._id),
    // Besuch merken: neue Packs (Quest, Geschenk) gelten ab jetzt als gesehen
    User.updateOne({ _id: req.user._id }, { $set: { packsSeenAt: new Date() } }),
  ]);
  res.locals.newPacks = 0;
  const neu = str(req.query.neu);
  res.render('inventar', {
    title: 'Inventar',
    packs,
    itemList,
    foiled,
    foilable,
    foilSettings: foil.settings,
    // gerade foliertes Exemplar hervorheben (statt einer Erfolgsmeldung)
    highlight: foiled.some((f) => f.id === neu) ? neu : '',
    packImage: catalog.PACK_IMAGE,
    packType: catalog.DEFAULT_PACK,
  });
});

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
    const copyId = await items.foilCard({ user: req.user, cardId: str(req.body.card) });
    return `/inventar?neu=${copyId}#folierte`;
  })
);

// Gegenstände an die Bank verkaufen
router.post('/inventar/verkaufen', (req, res) =>
  act(req, res, async () => {
    const count = Number.parseInt(str(req.body.count), 10);
    await items.sellItems({ user: req.user, type: str(req.body.type), count: Number.isInteger(count) ? count : 1 });
    return '/inventar#gegenstaende';
  })
);

router.post('/inventar/folie-abziehen', (req, res) =>
  act(req, res, async () => {
    const copyId = str(req.body.copy);
    if (!mongoose.isValidObjectId(copyId)) throw new UserError('Diese folierte Karte gibt es nicht.');
    await items.unfoilCard({ user: req.user, copyId });
    return '/inventar#folierte';
  })
);

module.exports = router;
