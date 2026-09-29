const express = require('express');
const { requireLogin } = require('../middleware');
const { TcgOpening } = require('../models/Tcg');
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
  const [owned, stats, rarePulls] = await Promise.all([
    tcg.inventory(req.user._id),
    TcgOpening.aggregate([{ $match: { user: req.user._id } }, { $group: { _id: null, packs: { $sum: 1 }, spent: { $sum: '$cost' }, best: { $max: '$best' } } }]),
    TcgOpening.find({ best: { $gte: catalog.rarityByKey.holo.rank } }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  const counts = Object.fromEntries(owned.map((o) => [o._id, o.n]));
  const collectionValue = owned.reduce((s, o) => s + (catalog.rarityByKey[o.rarity] ? catalog.rarityByKey[o.rarity].sell * o.n : 0), 0);
  const cardCount = owned.reduce((s, o) => s + o.n, 0);
  const dupCount = owned.reduce((s, o) => s + o.n - 1, 0);
  const dupValue = owned.reduce((s, o) => s + (catalog.rarityByKey[o.rarity] ? catalog.rarityByKey[o.rarity].sell * (o.n - 1) : 0), 0);

  res.render('tcg', {
    title: 'TCG',
    cards: catalog.CARDS,
    rarities: catalog.RARITIES,
    rarityByKey: catalog.rarityByKey,
    totalWeight: catalog.TOTAL_WEIGHT,
    cardById: catalog.cardById,
    counts,
    uniqueOwned: catalog.CARDS.filter((c) => counts[c.id]).length,
    cardCount,
    dupCount,
    dupValue,
    collectionValue,
    stats: stats[0] || { packs: 0, spent: 0, best: null },
    rarePulls,
    packPrice: settings.getPackPrice(),
    packImage: catalog.PACK_IMAGE,
    cardsPerPack: catalog.CARDS_PER_PACK,
  });
});

router.post('/tcg/oeffnen', async (req, res) => {
  try {
    const r = await tcg.openPack({ user: req.user });
    if (wantsJson(req)) {
      return res.json({ cards: r.cards.map(cardView), balance: euro(r.balance), canAfford: r.balance >= settings.getPackPrice() });
    }
    req.flash('success', `Booster Pack geöffnet: ${r.cards.map((c) => `${c.name} (${catalog.rarityByKey[c.rarity].label})`).join(', ')}.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
  }
  res.redirect('/tcg');
});

router.post('/tcg/verkaufen', async (req, res) => {
  try {
    const cardId = str(req.body.card);
    const keepOne = str(req.body.mode) === 'duplikate';
    const r = await tcg.sellCards({ user: req.user, cardId, count: 1, keepOne });
    const card = catalog.cardById[cardId];
    const name = card ? `${card.name} (${catalog.rarityByKey[card.rarity].label})` : 'Karte';
    req.flash('success', `${r.count}× ${name} für ${euro(r.proceeds)} verkauft.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/tcg#sammlung');
});

router.post('/tcg/duplikate-verkaufen', async (req, res) => {
  try {
    const r = await tcg.sellAllDuplicates({ user: req.user });
    req.flash('success', `${r.count} doppelte ${r.count === 1 ? 'Karte' : 'Karten'} für ${euro(r.proceeds)} verkauft. Von jeder Karte hast du jetzt noch eine.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/tcg#sammlung');
});

module.exports = router;
