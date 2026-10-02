const express = require('express');
const { requireLogin } = require('../middleware');
const User = require('../models/User');
const { TcgOpening } = require('../models/Tcg');
const { collection } = require('../tcg/collection');
const catalog = require('../tcg/catalog');
const tcg = require('../tcg/tcgService');
const settings = require('../tcg/settings');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/tcg', requireLogin);

const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');

/** Karte für den Client (Pack-Animation) */
function cardView(card) {
  const r = catalog.rarityByKey[card.rarity];
  return { id: card.id, name: card.name, rarity: card.rarity, rarityLabel: r.label, rank: r.rank, image: card.image, sell: euro(r.sell) };
}

router.get('/tcg', async (req, res) => {
  const [coll, stats, rarePulls, packs] = await Promise.all([
    collection(req.user),
    TcgOpening.aggregate([{ $match: { user: req.user._id } }, { $group: { _id: null, packs: { $sum: 1 }, spent: { $sum: '$cost' }, best: { $max: '$best' } } }]),
    TcgOpening.find({ best: { $gte: catalog.rarityByKey.holo.rank } }).sort({ createdAt: -1 }).limit(10).lean(),
    tcg.packInventory(req.user._id),
    // Besuch merken: neue Packs (Quest, Geschenk) gelten ab jetzt als gesehen
    User.updateOne({ _id: req.user._id }, { $set: { packsSeenAt: new Date() } }),
  ]);
  res.locals.newPacks = 0;

  res.render('tcg', {
    title: 'TCG',
    ...coll,
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
    totalWeight: catalog.TOTAL_WEIGHT,
    cardById: catalog.cardById,
    // Favoriten: nur Karten, die es gibt und die man (noch) besitzt
    favorites: (req.user.tcgFavorites || []).map((id) => catalog.cardById[id]).filter((c) => c && coll.counts[c.id]),
    maxFavorites: tcg.MAX_FAVORITES,
    stats: stats[0] || { packs: 0, spent: 0, best: null },
    rarePulls,
    packPrice: settings.getPackPrice(),
    packImage: catalog.PACK_IMAGE,
    packs,
    packType: catalog.DEFAULT_PACK,
    cardsPerPack: catalog.CARDS_PER_PACK,
  });
});

router.get('/tcg/album', async (req, res) => {
  const coll = await collection(req.user);
  res.render('tcg-album', {
    title: 'Album',
    ...coll,
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
    favoriteIds: new Set(req.user.tcgFavorites || []),
    maxFavorites: tcg.MAX_FAVORITES,
  });
});

router.post('/tcg/kaufen', async (req, res) => {
  try {
    const r = await tcg.buyPack({ user: req.user, type: str(req.body.type) });
    req.flash('success', `${r.type.label} für ${euro(r.cost)} gekauft – es liegt bei deinen Packs.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/tcg#packs');
});

router.post('/tcg/oeffnen', async (req, res) => {
  try {
    const r = await tcg.openPack({ user: req.user, type: str(req.body.type) });
    if (wantsJson(req)) return res.json({ cards: r.cards.map(cardView), packsLeft: r.packsLeft });
    req.flash('success', `Booster Pack geöffnet: ${r.cards.map((c) => `${c.name} (${catalog.rarityByKey[c.rarity].label})`).join(', ')}.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
  }
  res.redirect('/tcg');
});

/** Aktion ausführen, Meldung setzen, zurück ins Album */
async function albumAction(req, res, fn) {
  try {
    req.flash('success', await fn());
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/tcg/album');
}

const cardName = (id) => {
  const card = catalog.cardById[id];
  return card ? `${card.name} (${catalog.rarityByKey[card.rarity].label})` : 'Karte';
};

router.post('/tcg/verkaufen', (req, res) =>
  albumAction(req, res, async () => {
    const cardId = str(req.body.card);
    const keepOne = str(req.body.mode) === 'duplikate';
    const r = await tcg.sellCards({ user: req.user, cardId, count: 1, keepOne });
    return `${r.count}× ${cardName(cardId)} für ${euro(r.proceeds)} verkauft.`;
  })
);

router.post('/tcg/duplikate-verkaufen', (req, res) =>
  albumAction(req, res, async () => {
    const r = await tcg.sellAllDuplicates({ user: req.user });
    return `${r.count} doppelte ${r.count === 1 ? 'Karte' : 'Karten'} für ${euro(r.proceeds)} verkauft. Geschützte Karten wurden nicht angefasst.`;
  })
);

// Karte vor dem Duplikat-Verkauf schützen bzw. Schutz aufheben
router.post('/tcg/schuetzen', (req, res) =>
  albumAction(req, res, async () => {
    const cardId = str(req.body.card);
    const on = await tcg.toggleProtected({ user: req.user, cardId });
    return on ? `${cardName(cardId)} ist jetzt geschützt – ihre Duplikate werden nicht mitverkauft.` : `Schutz für ${cardName(cardId)} aufgehoben.`;
  })
);

// Karte als Favorit auf der TCG-Seite zeigen bzw. wieder entfernen
router.post('/tcg/favorit', (req, res) =>
  albumAction(req, res, async () => {
    const cardId = str(req.body.card);
    const on = await tcg.toggleFavorite({ user: req.user, cardId });
    return on ? `${cardName(cardId)} ist jetzt ein Favorit.` : `${cardName(cardId)} ist kein Favorit mehr.`;
  })
);

module.exports = router;
