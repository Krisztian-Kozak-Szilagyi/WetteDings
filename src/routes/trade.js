const express = require('express');
const User = require('../models/User');
const { TcgCard } = require('../models/Tcg');
const { Trade } = require('../models/Trade');
const { requireLogin } = require('../middleware');
const catalog = require('../tcg/catalog');
const { lockedDocs, isLocked } = require('../tcg/locks');
const trade = require('../trade/tradeService');
const { str, parseEuro, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();
router.use('/handel', requireLogin);

const cardInfo = (id) => catalog.cardById[id] || { id, name: id, rarity: 'crumpled', image: '' };

router.get('/handel', async (req, res) => {
  const me = req.user._id;
  const open = trade.openFilter();
  const now = new Date();
  const [incoming, market, mine, history, docs, locked, users] = await Promise.all([
    Trade.find({ ...open, kind: 'privat', to: me }).sort({ createdAt: -1 }).lean(),
    Trade.find({ ...open, kind: 'markt' }).sort({ createdAt: -1 }).limit(200).lean(),
    Trade.find({ ...open, seller: me }).sort({ createdAt: -1 }).lean(),
    Trade.find({ status: 'verkauft', $or: [{ seller: me }, { buyer: me }] }).sort({ closedAt: -1 }).limit(10).lean(),
    TcgCard.find({ user: me }).select('card').lean(),
    lockedDocs(me),
    User.find({ _id: { $ne: me } }).select('username').sort({ usernameLower: 1 }).lean(),
    // Besuch merken: der Markt gilt ab jetzt als gesehen
    User.updateOne({ _id: me }, { $set: { marketSeenAt: now } }),
  ]);
  res.locals.tradeMarketNew = 0;
  // Karten, von denen mindestens ein Exemplar frei ist (nicht Quest/Handel)
  const free = {};
  docs.forEach((d) => { if (!isLocked(locked, d)) free[d.card] = (free[d.card] || 0) + 1; });
  const rank = (c) => catalog.rarityByKey[c.rarity].rank;
  const sellable = Object.keys(free).map((id) => ({ ...cardInfo(id), free: free[id] })).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'de'));

  res.render('handel', {
    title: 'Handel',
    incoming,
    market,
    mine,
    history,
    sellable,
    users,
    cardInfo,
    rarityByKey: catalog.rarityByKey,
    taxPercent: trade.settings.taxPercent,
    taxFor: trade.taxFor,
    privateHours: trade.PRIVATE_HOURS,
    marketDays: trade.MARKET_DAYS,
  });
});

async function handle(req, res, fn) {
  try {
    req.flash('success', await fn());
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/handel');
}

router.post('/handel/angebot', (req, res) =>
  handle(req, res, async () => {
    const price = parseEuro(str(req.body.price));
    const t = await trade.create({ user: req.user, cardId: str(req.body.card), price, toName: str(req.body.to).trim() || null });
    const name = cardInfo(t.card).name;
    return t.kind === 'privat' ? `Angebot an ${t.toName} gesendet: ${name} für ${euro(t.price)}.` : `${name} steht jetzt für ${euro(t.price)} auf dem Markt.`;
  })
);

router.post('/handel/:id/kaufen', (req, res) =>
  handle(req, res, async () => {
    const r = await trade.buy({ user: req.user, tradeId: req.params.id });
    return `Gekauft: ${cardInfo(r.trade.card).name} für ${euro(r.trade.price)}. Die Karte ist jetzt in deiner Sammlung.`;
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
