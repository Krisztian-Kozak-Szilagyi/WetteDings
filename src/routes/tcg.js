const express = require('express');
const mongoose = require('mongoose');
const { requireLogin } = require('../middleware');
const { TcgOpening } = require('../models/Tcg');
const { collection } = require('../tcg/collection');
const catalog = require('../tcg/catalog');
const tcg = require('../tcg/tcgService');
const settings = require('../tcg/settings');
const items = require('../items/itemService');
const { ITEM_TYPES } = require('../items/types');
const { itemInventory } = items;
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');
const cosmetics = require('../cosmetics/cosmeticService');

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
    invMinis: [{ image: catalog.PACK_IMAGE, label: 'Booster Pack' }, ...ITEM_TYPES.map((t) => ({ image: t.image, label: t.label }))], // Miniaturen auf der Inventar-Kachel
    packType: catalog.DEFAULT_PACK,
    cardsPerPack: catalog.CARDS_PER_PACK,
    // Kachel zur Kartenaufwertung (für alle freigegeben oder Admin)
    upgradeOpen: require('../tcg/upgrade').mayUse(req.user),
    upgradeCount: require('../tcg/upgrade').settings.count,
  });
});

router.get('/tcg/album', async (req, res) => {
  const coll = await collection(req.user);
  // Eigene Slabs stehen ganz oben als einzelne Karten (beste Note zuerst, dann seltenste Karte); Karten im Sleeve bleiben
  // unten im Raster neben ihren ungesleevten Varianten (partials/tcg-grid)
  const slabCopies = Object.entries(coll.foiledCopies)
    .flatMap(([cardId, list]) => list.filter((f) => f.slab).map((f) => ({ ...f, card: catalog.cardById[cardId] })))
    .filter((s) => s.card)
    .sort((a, b) => b.slab.grade - a.slab.grade || (catalog.rarityByKey[b.card.rarity].rank || 0) - (catalog.rarityByKey[a.card.rarity].rank || 0) || a.card.name.localeCompare(b.card.name, 'de'));
  // Kartennummer je Season (#01 …) – wie im Raster des Albums gezählt; steht im Panel der Großansicht
  const cardNo = {};
  for (const s of catalog.SEASONS) catalog.CARDS.filter((c) => c.season === s.key && c.rarity !== 'test-item').forEach((c, i) => { cardNo[c.id] = String(i + 1).padStart(2, '0'); });
  const neu = str(req.query.neu); // gerade in den Sleeve gesteckt: öffnet sich in 3D (public/js/foil-view.js)
  res.render('tcg-album', {
    title: 'Album',
    ...coll,
    slabCopies,
    cardNo,
    highlight: Object.values(coll.foiledCopies).some((l) => l.some((f) => f.id === neu)) ? neu : '',
    cards: catalog.CARDS,
    seasons: catalog.SEASONS,
    // noch nicht erhältliche Karten: nur Admins sehen sie als "?" in ihrer Season (zählen nicht mit)
    unreleased: req.user.isAdmin ? catalog.UNRELEASED_CARDS : [],
    // Test-Karten (Kampfmodus): eigener Abschnitt ganz unten, nur für Admins
    testCards: req.user.isAdmin ? catalog.TEST_CARDS : [],
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
    favoriteIds: new Set(req.user.tcgFavorites || []),
    // schon einmal besessene Karten: durchsichtig statt "?"
    seenIds: new Set(req.user.tcgSeen || []),
    maxFavorites: tcg.MAX_FAVORITES,
    konfetti: req.user.konfetti || 0,
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

// Alle Packs auf einmal öffnen (Inventar): die Karten kommen als Liste zurück – die Übersicht sortiert der Browser
// nach Seltenheit (public/js/packs-alle.js)
router.post('/tcg/alle-oeffnen', async (req, res) => {
  try {
    const r = await tcg.openAllPacks({ user: req.user });
    const cards = r.cards.map((c, i) => ({ ...cardView(c), isNew: !!r.isNew[i], value: catalog.rarityByKey[c.rarity].sell }));
    if (wantsJson(req)) return res.json({ cards, packs: r.packs, packsLeft: r.packsLeft, total: cards.reduce((s, c) => s + c.value, 0) });
    req.flash('success', `${r.packs} Booster Packs geöffnet: ${cards.length} Karten.${r.packsLeft ? ` ${r.packsLeft} Packs sind noch übrig.` : ''}`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    if (wantsJson(req)) return res.status(400).json({ error: err.message });
    req.flash('error', err.message);
  }
  res.redirect('/tcg/album');
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

// Sleeve abziehen bzw. Slab aufbrechen (aus der Großansicht im Album): der Sleeve kommt zurück ins Inventar
router.post('/tcg/huelle-abziehen', (req, res) =>
  albumAction(req, res, async () => {
    const copyId = str(req.body.copy);
    if (!mongoose.isValidObjectId(copyId)) throw new UserError('Diese Karte gibt es nicht.');
    const { card, sleeve } = await items.unfoilCard({ user: req.user, copyId });
    return sleeve ? `${card ? card.name : 'Die Karte'} ist wieder ohne Hülle – der TCG Sleeve liegt in deinem Inventar.` : `Der Slab von ${card ? card.name : 'der Karte'} ist aufgebrochen – die Karte kann neu eingereicht werden.`;
  })
);

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

// Zerkleinern: Karten gegen Konfetti (Kosmetik-Shop) statt Geld
const konfettiText = (n) => `${n.toLocaleString('de-DE')} ${cosmetics.currencyName()}`;

router.post('/tcg/zerkleinern', (req, res) =>
  albumAction(req, res, async () => {
    const cardId = str(req.body.card);
    const r = await tcg.shredCards({ user: req.user, cardId, keepOne: str(req.body.mode) === 'duplikate' });
    return `${r.count}× ${cardName(cardId)} zerkleinert: +${konfettiText(r.konfetti)}.`;
  })
);

router.post('/tcg/duplikate-zerkleinern', (req, res) =>
  albumAction(req, res, async () => {
    const r = await tcg.shredAllDuplicates({ user: req.user });
    return `${r.count} doppelte ${r.count === 1 ? 'Karte' : 'Karten'} zerkleinert: +${konfettiText(r.konfetti)}. Geschützte Karten wurden nicht angefasst.`;
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

// ---------- Kartenaufwertung: 10 Karten verschmelzen, Seltenheiten gemischt (src/tcg/upgrade.js) ----------
const upgrade = require('../tcg/upgrade');

/** Prozent für die Anzeige: 100 %, 88,9 %, 0,09 % */
const pctText = (p) => `${(p >= 0.01 ? Math.round(p * 1000) / 10 : Math.round(p * 100000) / 1000).toLocaleString('de-DE')} %`;

router.get('/tcg/aufwertung', async (req, res) => {
  if (!upgrade.mayUse(req.user)) return res.status(404).render('error', { title: 'Kartenaufwertung', status: 'Kartenaufwertung', message: 'Die Kartenaufwertung ist derzeit nicht verfügbar. Schau später wieder vorbei!' });
  const [choices, owned, history] = await Promise.all([upgrade.choices(req.user._id), upgrade.ownedIds(req.user._id), upgrade.history(req.user._id)]);
  const s = upgrade.settings;
  // Stufen mit Preis und Pack-Gewicht (für die Rechnung im Browser, public/js/aufwertung-regeln.js), eigene freie Karten
  // und welche Karten je Seltenheit herauskommen können (fehlende markiert)
  const ladder = upgrade.ladderDefs();
  const pools = Object.fromEntries(ladder.map((r) => [r.key, upgrade.oddsOf(upgrade.poolOf(r.key), owned, s.fehlend).map((o) => ({ ...cardView(o.card), missing: o.missing, p: pctText(o.p) }))]));
  const tiers = ladder
    .filter((r) => upgrade.nextRarity(r.key))
    .map((r) => {
      const cards = (choices[r.key] || []).map((e) => ({ ...cardView(catalog.cardById[e.card]), docs: e.docs, dupes: e.dupes })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
      return { key: r.key, label: r.label, next: upgrade.nextRarity(r.key), nextLabel: catalog.rarityByKey[upgrade.nextRarity(r.key)].label, cards, free: cards.reduce((n, c) => n + c.docs.length, 0) };
    });
  res.render('tcg-aufwertung', {
    title: 'Kartenaufwertung',
    tiers,
    ladder,
    pools,
    rules: { count: s.count, rueckgabe: s.rueckgabe, maxChance: s.maxChance, bonus: s.bonus, jackpot: s.jackpot, fehlend: s.fehlend },
    count: s.count,
    fehlend: s.fehlend,
    bonusText: pctText(s.bonus / 10000),
    jackpotText: pctText(s.jackpot / 10000),
    history: history.map((h) => ({ ...h, card: catalog.cardById[h.result.card] || null, fromLabel: (catalog.rarityByKey[h.rarity] || {}).label || h.rarity, mixed: new Set(h.inputs.map((i) => i.rarity).filter(Boolean)).size > 1 })),
    closedForOthers: !s.open,
  });
});

router.post('/tcg/aufwertung', async (req, res) => {
  try {
    const docs = [].concat(req.body.doc || []).map(str);
    const r = await upgrade.upgrade({ user: req.user, docIds: docs });
    // Walze wie beim Kistenöffnen: zufällige Karten der möglichen Ausgänge (Ziel und Seltenheiten des Einsatzes),
    // das Ergebnis an fester Stelle
    const v = r.contract;
    const failKeys = [...new Set(r.inputs)];
    const reel = Array.from({ length: 48 }, () => {
      const key = Math.random() < v.chance ? v.target : failKeys[Math.floor(Math.random() * failKeys.length)];
      const pool = upgrade.poolOf(key);
      return cardView(pool[Math.floor(Math.random() * pool.length)]);
    });
    res.json({ ok: true, success: r.success, kind: r.kind, chance: pctText(v.chance), card: { ...cardView(r.card), missing: r.missing }, reel, stop: 40 });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
