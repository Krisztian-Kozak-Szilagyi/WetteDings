const express = require('express');
const { requireLogin } = require('../middleware');
const { CoinTrade } = require('../models/Coin');
const engine = require('../coin/engine');
const trade = require('../coin/tradeService');
const { str, parseEuro, UserError } = require('../lib/util');
const { euro, coinPrice, coinAmount } = require('../lib/viewHelpers');

const router = express.Router();
const RANGES = ['1h', '24h', '7d', '30d', 'all'];

router.use('/coin-exchange', requireLogin);

router.get('/coin-exchange', async (req, res) => {
  const [holding, trades, events] = await Promise.all([
    trade.getHolding(req.user._id),
    CoinTrade.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(20).lean(),
    engine.recentEvents(8),
  ]);
  const snap = engine.snapshot();
  const value = trade.valueCents(holding.units, snap.price);
  res.render('coin-exchange', {
    title: 'Coin Exchange',
    snap,
    holding,
    value,
    trades,
    events,
    avgPrice: holding.units ? holding.costCents / 100 / (holding.units / trade.UNITS) : null,
    minTrade: trade.MIN_TRADE_CENTS,
    minBuy: trade.minBuyCents(snap.price),
    minBuyShare: trade.MIN_BUY_SHARE,
  });
});

// ---------- JSON für die Live-Ansicht ----------

router.get('/coin-exchange/api/kurs', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(engine.snapshot());
});

router.get('/coin-exchange/api/verlauf', async (req, res) => {
  const range = RANGES.includes(str(req.query.bereich)) ? str(req.query.bereich) : '24h';
  res.set('Cache-Control', 'no-store');
  res.json({ range, points: await engine.history(range) });
});

// ---------- Handel ----------

async function handle(req, res, fn) {
  try {
    req.flash('success', await fn());
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/coin-exchange');
}

router.post('/coin-exchange/kaufen', (req, res) =>
  handle(req, res, async () => {
    const cents = parseEuro(str(req.body.amount));
    if (cents === null) throw new UserError('Bitte gib einen gültigen Betrag ein.');
    const r = await trade.buy({ user: req.user, cents });
    return `Gekauft: ${coinAmount(r.units)} für ${euro(r.cents)} (Kurs ${coinPrice(r.price)}).`;
  })
);

router.post('/coin-exchange/verkaufen', (req, res) =>
  handle(req, res, async () => {
    const all = str(req.body.all) === '1';
    const cents = all ? null : parseEuro(str(req.body.amount));
    if (!all && cents === null) throw new UserError('Bitte gib einen gültigen Betrag ein.');
    const r = await trade.sell({ user: req.user, cents, all });
    const pl = r.profit >= 0 ? `Gewinn ${euro(r.profit)}` : `Verlust ${euro(-r.profit)}`;
    return `Verkauft: ${coinAmount(r.units)} für ${euro(r.cents)} (Kurs ${coinPrice(r.price)}, ${pl}).`;
  })
);

module.exports = router;
