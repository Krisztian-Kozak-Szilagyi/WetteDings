const express = require('express');
const { requireLogin } = require('../middleware');
const { CoinTrade } = require('../models/Coin');
const markets = require('../coin/markets');
const trade = require('../coin/tradeService');
const { str, parseEuro, UserError } = require('../lib/util');
const { euro, coinPrice, coinAmount } = require('../lib/viewHelpers');

const router = express.Router();
const RANGES = ['1h', '24h', '7d', '30d', 'all'];

/** Engine zum Symbol aus URL oder Formular (nur aus der festen Liste), sonst null */
const marketOf = (value) => markets.get(String(value || '').toUpperCase());
const pathOf = (engine) => (engine.SYMBOL === 'SAM' ? '/broker' : `/broker/${engine.SYMBOL.toLowerCase()}`);

// Früher hieß der Broker "Coin Exchange": alte Links und Lesezeichen weiterleiten
router.get(/^\/coin-exchange(\/.*)?$/, (req, res) => res.redirect(301, '/broker'));

router.use('/broker', requireLogin);

async function page(req, res, engine) {
  const symbol = engine.SYMBOL;
  const [holdings, trades, events] = await Promise.all([
    trade.getHoldings(req.user._id),
    CoinTrade.find({ user: req.user._id, coin: symbol }).sort({ createdAt: -1 }).limit(10).lean(),
    engine.recentEvents(8),
  ]);
  const holding = holdings[symbol];
  const snap = engine.snapshot();
  const value = trade.valueCents(holding.units, snap.price);
  // Übersicht aller Werte (Reiter oben) mit Kurs, 24-h-Änderung und eigenem Bestandswert
  const assets = markets.LIST.map((e) => {
    const s = e.snapshot();
    return { ...s, path: pathOf(e), active: e === engine, value: trade.valueCents(holdings[e.SYMBOL].units, s.price) };
  });
  res.render('broker', {
    title: `Broker · ${snap.name}`,
    snap,
    assets,
    basePath: pathOf(engine),
    holding,
    value,
    trades,
    events,
    avgPrice: holding.units ? holding.costCents / 100 / (holding.units / trade.UNITS) : null,
    minTrade: trade.MIN_TRADE_CENTS,
    minBuy: trade.minBuyCents(snap.price),
    minBuyShare: trade.MIN_BUY_SHARE,
  });
}

router.get('/broker', (req, res) => page(req, res, markets.get('SAM')));

// ---------- JSON für die Live-Ansicht ----------

router.get('/broker/api/kurs', (req, res) => {
  const engine = marketOf(req.query.wert) || markets.get('SAM');
  res.set('Cache-Control', 'no-store');
  res.json(engine.snapshot());
});

router.get('/broker/api/verlauf', async (req, res) => {
  const engine = marketOf(req.query.wert) || markets.get('SAM');
  const range = RANGES.includes(str(req.query.bereich)) ? str(req.query.bereich) : '24h';
  res.set('Cache-Control', 'no-store');
  res.json({ range, points: await engine.history(range) });
});

router.get('/broker/:wert', (req, res, next) => {
  const engine = marketOf(req.params.wert);
  if (!engine) return next();
  if (engine.SYMBOL === 'SAM') return res.redirect('/broker');
  return page(req, res, engine);
});

// ---------- Handel ----------

async function handle(req, res, fn) {
  const engine = marketOf(req.body.wert) || markets.get('SAM');
  try {
    req.flash('success', await fn(engine));
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(pathOf(engine));
}

router.post('/broker/kaufen', (req, res) =>
  handle(req, res, async (engine) => {
    const cents = parseEuro(str(req.body.amount));
    if (cents === null) throw new UserError('Bitte gib einen gültigen Betrag ein.');
    const r = await trade.buy({ user: req.user, symbol: engine.SYMBOL, cents });
    return `Gekauft: ${coinAmount(r.units, engine.SYMBOL)} für ${euro(r.cents)} (Kurs ${coinPrice(r.price)}).`;
  })
);

router.post('/broker/verkaufen', (req, res) =>
  handle(req, res, async (engine) => {
    const all = str(req.body.all) === '1';
    const cents = all ? null : parseEuro(str(req.body.amount));
    if (!all && cents === null) throw new UserError('Bitte gib einen gültigen Betrag ein.');
    const r = await trade.sell({ user: req.user, symbol: engine.SYMBOL, cents, all });
    const pl = r.profit >= 0 ? `Gewinn ${euro(r.profit)}` : `Verlust ${euro(-r.profit)}`;
    return `Verkauft: ${coinAmount(r.units, engine.SYMBOL)} für ${euro(r.cents)} (Kurs ${coinPrice(r.price)}, ${pl}).`;
  })
);

module.exports = router;
