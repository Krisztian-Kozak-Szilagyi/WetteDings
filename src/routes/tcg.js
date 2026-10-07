const express = require('express');
const { requireLogin } = require('../middleware');
const { TcgOpening } = require('../models/Tcg');
const { collection } = require('../tcg/collection');
const catalog = require('../tcg/catalog');
const tcg = require('../tcg/tcgService');
const settings = require('../tcg/settings');
const { itemInventory } = require('../items/itemService');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/tcg', requireLogin);

const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');

/** Karte für den Client (Pack-Animation) */
function cardView(card) {
  const r = catalog.rarityByKey[card.rarity];
  return { id: card.id, name: card.name, rarity: card.rarity, rarityLabel: r.label, rank: r.rank, image: card.image, season: card.season, sell: euro(r.sell) };
}

router.get('/tcg', async (req, res) => {
  const [coll, stats, rarePulls, packs, invItems] = await Promise.all([
    collection(req.user),
    TcgOpening.aggregate([{ $match: { user: req.user._id } }, { $group: { _id: null, packs: { $sum: 1 }, spent: { $sum: '$cost' }, best: { $max: '$best' } } }]),
    TcgOpening.find({ best: { $gte: catalog.rarityByKey.holo.rank } }).sort({ createdAt: -1 }).limit(10).lean(),
    tcg.packInventory(req.user._id), // ungeöffnete Packs liegen im Inventar – hier nur die Kachel dorthin
    itemInventory(req.user._id),
  ]);

  res.render('tcg', {
    title: 'TCG',
    ...coll,
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
    totalWeight: catalog.TOTAL_WEIGHT,
    cardById: catalog.cardById,
    // Favoriten: nur Karten, die es gibt und die man (noch) besitzt
    favorites: await tcg.favoriteList(req.user, Object.fromEntries(Object.entries(coll.counts).map(([k, n]) => [k, n - (coll.foiledByCard[k] || 0)]))), // normale Favoriten nur mit unfoliertem Exemplar
    maxFavorites: tcg.MAX_FAVORITES,
    stats: stats[0] || { packs: 0, spent: 0, best: null },
    rarePulls,
    packPrice: settings.getPackPrice(),
    maxPacksPerPurchase: tcg.MAX_PACKS_PER_PURCHASE,
    packImage: catalog.PACK_IMAGE,
    packs,
    itemTotal: invItems.reduce((s, i) => s + i.count, 0),
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
    seasons: catalog.SEASONS,
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
    favoriteIds: new Set(req.user.tcgFavorites || []),
    // schon einmal besessene Karten: durchsichtig statt "?"
    seenIds: new Set(req.user.tcgSeen || []),
    maxFavorites: tcg.MAX_FAVORITES,
  });
});

router.post('/tcg/kaufen', async (req, res) => {
  try {
    // Ohne Mengenangabe (altes Formular) ein Pack; ungültige Eingaben lehnt buyPack ab
    const raw = str(req.body.count).trim();
    const count = raw === '' ? 1 : /^\d+$/.test(raw) ? Number(raw) : NaN;
    const r = await tcg.buyPack({ user: req.user, type: str(req.body.type), count });
    req.flash('success', r.count === 1
      ? `${r.type.label} für ${euro(r.cost)} gekauft – es liegt bei deinen Packs.`
      : `${r.count}× ${r.type.label} für ${euro(r.cost)} gekauft – sie liegen bei deinen Packs.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/tcg'); // oben bleiben – so lassen sich bequem weitere Packs kaufen (der Inventar-Hinweis zählt mit)
});

router.post('/tcg/oeffnen', async (req, res) => {
  try {
    const r = await tcg.openPack({ user: req.user, type: str(req.body.type) });
    if (wantsJson(req)) return res.json({ cards: r.cards.map((c, i) => ({ ...cardView(c), isNew: !!r.isNew[i] })), packsLeft: r.packsLeft });
    req.flash('success', `Booster Pack geöffnet: ${r.cards.map((c) => `${c.name} (${catalog.rarityByKey[c.rarity].label})`).join(', ')}.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
  }
  res.redirect('/inventar#packs');
});

/** Aktion ausführen, Meldung setzen, zurück ins Album (to: anderes Ziel, erst nach der Aktion bestimmt) */
async function albumAction(req, res, fn, to = () => '/tcg/album') {
  try {
    req.flash('success', await fn());
    await tcg.pruneCardLists(req.user); // verkaufte Karten sind keine Favoriten/geschützten Karten mehr
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect('/tcg/album');
  }
  res.redirect(to());
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

// Karte als Favorit auf der TCG-Seite zeigen bzw. wieder entfernen.
// Per fetch (Dashboard, #130): Antwort als JSON { ok, on } statt Weiterleitung ins Album.
router.post('/tcg/favorit', async (req, res) => {
  const cardId = str(req.body.card);
  if (wantsJson(req)) {
    try {
      res.json({ ok: true, on: await tcg.toggleFavorite({ user: req.user, cardId }) });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      res.status(400).json({ ok: false, error: err.message });
    }
    return;
  }
  // Neuer Favorit: direkt zu den Favoriten auf der TCG-Seite, dort leuchtet er an seinem Platz auf (public/js/tcg.js).
  // Entfernen (oder ein Fehler): zurück ins Album wie bei den anderen Album-Aktionen.
  let on = false;
  return albumAction(
    req,
    res,
    async () => {
      on = await tcg.toggleFavorite({ user: req.user, cardId });
      return on ? `${cardName(cardId)} ist jetzt ein Favorit.` : `${cardName(cardId)} ist kein Favorit mehr.`;
    },
    () => (on ? `/tcg#favorit-${encodeURIComponent(cardId)}` : '/tcg/album')
  );
});

module.exports = router;
