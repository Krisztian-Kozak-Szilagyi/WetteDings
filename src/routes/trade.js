const express = require('express');
const User = require('../models/User');
const { requireLogin } = require('../middleware');
const catalog = require('../tcg/catalog');
const { collection } = require('../tcg/collection');
const trade = require('../trade/tradeService');
const { str, parseEuro, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/handel', requireLogin);

const cardInfo = (id) => catalog.cardById[id] || { id, name: id, rarity: 'crumpled', image: '' };

router.get('/handel', async (req, res) => {
  const [data] = await Promise.all([
    trade.overview(req.user),
    // Besuch merken: der Markt gilt ab jetzt als gesehen
    User.updateOne({ _id: req.user._id }, { $set: { marketSeenAt: new Date() } }),
  ]);
  res.locals.tradeMarketNew = 0;

  res.render('handel', {
    title: 'Handel',
    ...data,
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    cardInfo,
    rarityByKey: catalog.rarityByKey,
    taxPercent: trade.settings.taxPercent,
    taxFor: trade.taxFor,
    privateHours: trade.PRIVATE_HOURS,
    marketDays: trade.MARKET_DAYS,
  });
});

/** Tauschangebot zusammenstellen: links die eigenen freien Karten, rechts die Sammlung des Mitspielers */
router.get('/handel/tausch', async (req, res) => {
  const name = str(req.query.an).trim();
  const partner = name && (await User.findOne({ usernameLower: name.toLowerCase(), deletedAt: null }).select('username').lean());
  if (!partner || partner._id.equals(req.user._id)) {
    req.flash('error', name ? 'Mit diesem Mitglied kannst du nicht tauschen.' : 'Bitte wähle aus, mit wem du tauschen möchtest.');
    return res.redirect('/handel');
  }
  const [mine, theirs] = await Promise.all([collection(req.user), collection(partner)]);
  res.render('handel-tausch', {
    title: 'Tausch',
    partner,
    mine,
    theirs,
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
    pickCard: str(req.query.karte),
    pickWant: str(req.query.will),
    pickPrice: str(req.query.preis),
    pickFrom: str(req.query.zahlt),
    taxPercent: trade.settings.taxPercent,
    privateHours: trade.PRIVATE_HOURS,
  });
});

/** Aktion ausführen, Meldung setzen; Erfolg führt zum Handel, ein Fehler nach back */
async function handle(req, res, fn, back = '/handel') {
  try {
    req.flash('success', await fn());
    return res.redirect('/handel');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect(back);
  }
}

router.post('/handel/angebot', (req, res) =>
  handle(req, res, async () => {
    const toName = str(req.body.to).trim() || null;
    const t = await trade.create({ user: req.user, kind: toName ? 'privat' : 'markt', cardId: str(req.body.card), price: parseEuro(str(req.body.price)), toName });
    const name = cardInfo(t.card).name;
    return t.kind === 'privat' ? `Angebot an ${t.toName} gesendet: ${name} für ${euro(t.price)}.` : `${name} steht jetzt für ${euro(t.price)} auf dem Markt.`;
  })
);

router.post('/handel/tausch', (req, res) => {
  const toName = str(req.body.to).trim();
  const cardId = str(req.body.card);
  const wantCardId = str(req.body.want);
  const rawPrice = str(req.body.price).trim();
  const extraFrom = str(req.body.extra) || null;
  // Bei einem Fehler zurück zur Auswahl, mit allem, was schon gewählt war
  const back = '/handel/tausch?' + new URLSearchParams({ an: toName, karte: cardId, will: wantCardId, preis: rawPrice, zahlt: extraFrom || '' });
  return handle(
    req,
    res,
    async () => {
      const t = await trade.create({ user: req.user, kind: 'tausch', cardId, wantCardId, price: rawPrice ? parseEuro(rawPrice) : 0, extraFrom, toName });
      return `Tauschangebot an ${t.toName} gesendet: ${cardInfo(t.card).name} gegen ${cardInfo(t.wantCard).name}.`;
    },
    back
  );
});

router.post('/handel/:id/kaufen', (req, res) =>
  handle(req, res, async () => {
    const r = await trade.buy({ user: req.user, tradeId: req.params.id });
    return `Gekauft: ${cardInfo(r.trade.card).name} für ${euro(r.trade.price)}. Die Karte ist jetzt in deiner Sammlung.`;
  })
);

router.post('/handel/:id/tauschen', (req, res) =>
  handle(req, res, async () => {
    const r = await trade.acceptSwap({ user: req.user, tradeId: req.params.id });
    return `Getauscht: Du hast jetzt ${cardInfo(r.trade.card).name}, ${r.trade.sellerName} bekommt ${cardInfo(r.trade.wantCard).name}.`;
  })
);

router.post('/handel/:id/zurueckziehen', (req, res) =>
  handle(req, res, async () => {
    await trade.close({ user: req.user, tradeId: req.params.id, action: 'zurueckziehen' });
    return 'Angebot zurückgezogen – die Karte ist wieder frei.';
  })
);

router.post('/handel/:id/ablehnen', (req, res) =>
  handle(req, res, async () => {
    await trade.close({ user: req.user, tradeId: req.params.id, action: 'ablehnen' });
    return 'Angebot abgelehnt.';
  })
);

module.exports = router;
