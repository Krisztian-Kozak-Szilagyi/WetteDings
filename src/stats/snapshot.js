// Täglicher Stand der Wirtschaft (siehe models/StatDaily)
const User = require('../models/User');
const Bet = require('../models/Bet');
const StatDaily = require('../models/StatDaily');
const { TcgCard, TcgPack } = require('../models/Tcg');
const { CoinHolding } = require('../models/Coin');
const { Trade, openFilter } = require('../models/Trade');
const markets = require('../coin/markets');
const tcgSettings = require('../tcg/settings');
const { ranking } = require('../services/rankService');
const bonusService = require('../services/bonusService');
const { GradingShop } = require('../models/Grading');
const { disputedFilter } = require('../services/betService');
const { dayAndHour } = require('./activity');

/** Wert an der Stelle q (0–1) einer aufsteigend sortierten Liste */
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/**
 * Verteilung von Vermögen (Cent): Summe, Mittel, Median, Perzentile, Anteil der reichsten 10 %
 * und Gini-Koeffizient (0 = alle gleich, 1 = einer besitzt alles).
 */
function distribution(values) {
  const v = values.map((x) => Math.max(0, x)).sort((a, b) => a - b);
  const n = v.length;
  const sum = v.reduce((s, x) => s + x, 0);
  if (!n || !sum) return { count: n, sum, mean: 0, median: 0, p10: 0, p90: 0, p99: 0, max: v[n - 1] || 0, top10Share: 0, gini: 0 };
  const top = Math.max(1, Math.ceil(n * 0.1));
  const topSum = v.slice(n - top).reduce((s, x) => s + x, 0);
  // Gini über die sortierten Werte: Σ (2i − n − 1) · x_i / (n · Σx), i = 1 … n
  const gini = v.reduce((s, x, i) => s + (2 * (i + 1) - n - 1) * x, 0) / (n * sum);
  const round = (x) => Math.round(x * 10000) / 10000;
  return {
    count: n,
    sum,
    mean: Math.round(sum / n),
    median: quantile(v, 0.5),
    p10: quantile(v, 0.1),
    p90: quantile(v, 0.9),
    p99: quantile(v, 0.99),
    max: v[n - 1],
    top10Share: round(topSum / sum),
    gini: round(gini),
  };
}

const sumOf = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
const countBy = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.n]));

/** Aktuellen Stand erfassen (ohne zu speichern) */
async function collect(now = new Date()) {
  const [players, users, banned, cardsByRarity, packsUnopened, coins, offers, openBets, disputed, grading] = await Promise.all([
    ranking(),
    User.countDocuments({ deletedAt: null }),
    User.countDocuments({ deletedAt: null, bannedUntil: { $gt: now } }),
    TcgCard.aggregate([{ $group: { _id: '$rarity', n: { $sum: 1 } } }]),
    TcgPack.countDocuments(),
    CoinHolding.aggregate([{ $match: { units: { $gt: 0 } } }, { $group: { _id: '$coin', units: { $sum: '$units' }, holders: { $sum: 1 } } }]),
    Trade.aggregate([{ $match: openFilter() }, { $group: { _id: '$kind', n: { $sum: 1 } } }]),
    Bet.countDocuments({ status: 'offen' }),
    Bet.countDocuments(disputedFilter()),
    GradingShop.countDocuments({ active: true }),
  ]);
  const byRarity = countBy(cardsByRarity);
  return {
    at: now,
    users: { total: users, banned },
    wealth: {
      balance: sumOf(players, 'balance'),
      inPlay: sumOf(players, 'inPlay'),
      coinValue: sumOf(players, 'coinValue'),
      cardValue: sumOf(players, 'cardValue'),
      // Tagesbonus ist für alle gleich; wer im Grading-Shop arbeitet, bekommt keinen
      bonusAmount: bonusService.settings.amount,
      gradingActive: grading,
      total: distribution(players.map((p) => p.total)),
    },
    // coin = Samantha Coin (wie bisher), coins = alle Broker-Werte je Symbol
    coin: (() => {
      const sam = coins.find((c) => c._id === 'SAM');
      return { price: markets.get('SAM').isRunning() ? markets.get('SAM').getPrice() : null, units: sam ? sam.units : 0, holders: sam ? sam.holders : 0 };
    })(),
    coins: Object.fromEntries(
      markets.LIST.map((e) => {
        const c = coins.find((x) => x._id === e.SYMBOL);
        return [e.SYMBOL, { price: e.isRunning() ? e.getPrice() : null, units: c ? c.units : 0, holders: c ? c.holders : 0 }];
      })
    ),
    cards: { total: Object.values(byRarity).reduce((s, n) => s + n, 0), byRarity, packsUnopened, packPrice: tcgSettings.getPackPrice() },
    market: countBy(offers),
    bets: { open: openBets, disputed },
    players: players.map((p) => ({ user: p._id, balance: p.balance, inPlay: p.inPlay, coinValue: p.coinValue, cardValue: p.cardValue, total: p.total })),
  };
}

/** Einmal pro Tag (deutsche Zeit) den Stand speichern; ist der Tag schon erfasst, passiert nichts */
async function takeDailySnapshot(now = new Date()) {
  const { day } = dayAndHour(now);
  if (await StatDaily.exists({ _id: day })) return null;
  const doc = await collect(now);
  try {
    return await StatDaily.create({ _id: day, ...doc });
  } catch (err) {
    if (err && err.code === 11000) return null; // parallel schon gespeichert
    throw err;
  }
}

module.exports = { quantile, distribution, collect, takeDailySnapshot };
