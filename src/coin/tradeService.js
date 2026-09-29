const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { CoinHolding, CoinTrade } = require('../models/Coin');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const engine = require('./engine');

const UNITS = 1e8; // 1 Coin = 100.000.000 Einheiten
const MIN_TRADE_CENTS = 100; // Mindestbetrag 1 €

/** Wert eines Bestands in Cent zum Kurs price */
const valueCents = (units, price) => Math.floor((units / UNITS) * price * 100);

/** Kaufen für einen Euro-Betrag (Cent) zum aktuellen Kurs */
async function buy({ user, cents }) {
  if (!Number.isInteger(cents) || cents < MIN_TRADE_CENTS) throw new UserError('Der Mindestbetrag ist 1,00 €.');
  return inTransaction(async (session) => {
    const price = engine.getPrice();
    const units = Math.floor((cents / 100 / price) * UNITS);
    if (units <= 0) throw new UserError('Der Betrag ist zu klein.');

    const updatedUser = await User.findOneAndUpdate(
      { _id: user._id, balance: { $gte: cents } },
      { $inc: { balance: -cents } },
      { new: true, session }
    );
    if (!updatedUser) throw new UserError('Dein Guthaben reicht dafür nicht aus.');

    await CoinHolding.updateOne(
      { user: user._id, coin: engine.SYMBOL },
      { $inc: { units, costCents: cents } },
      { upsert: true, session }
    );
    await CoinTrade.create([{ user: user._id, coin: engine.SYMBOL, side: 'kauf', units, price, cents }], { session });
    await Ledger.create([{ user: user._id, type: 'coin_kauf', amount: -cents }], { session });
    return { units, price, cents };
  });
}

/**
 * Verkaufen: entweder einen Euro-Betrag (cents) oder den gesamten Bestand (all = true).
 * Der Einstandswert wird anteilig reduziert.
 */
async function sell({ user, cents, all = false }) {
  if (!all && (!Number.isInteger(cents) || cents < MIN_TRADE_CENTS)) throw new UserError('Der Mindestbetrag ist 1,00 €.');
  return inTransaction(async (session) => {
    const price = engine.getPrice();
    const holding = await CoinHolding.findOne({ user: user._id, coin: engine.SYMBOL }).session(session);
    if (!holding || holding.units <= 0) throw new UserError('Du besitzt keine Samantha Coins.');

    let units = all ? holding.units : Math.ceil((cents / 100 / price) * UNITS);
    if (units > holding.units) {
      throw new UserError(`Du besitzt nur Coins im Wert von ${(valueCents(holding.units, price) / 100).toFixed(2).replace('.', ',')} €.`);
    }
    const proceeds = valueCents(units, price);
    if (proceeds <= 0) throw new UserError('Der Wert ist zu klein, um ihn zu verkaufen.');

    const costReduce = units === holding.units ? holding.costCents : Math.round((holding.costCents * units) / holding.units);
    const res = await CoinHolding.updateOne(
      { _id: holding._id, units: { $gte: units } },
      { $inc: { units: -units, costCents: -costReduce } },
      { session }
    );
    if (res.modifiedCount !== 1) throw new UserError('Dein Bestand hat sich geändert. Bitte versuche es erneut.');

    await User.updateOne({ _id: user._id }, { $inc: { balance: proceeds } }, { session });
    await CoinTrade.create([{ user: user._id, coin: engine.SYMBOL, side: 'verkauf', units, price, cents: proceeds }], { session });
    await Ledger.create([{ user: user._id, type: 'coin_verkauf', amount: proceeds }], { session });
    return { units, price, cents: proceeds, profit: proceeds - costReduce };
  });
}

async function getHolding(userId) {
  const h = await CoinHolding.findOne({ user: userId, coin: engine.SYMBOL }).lean();
  return h || { units: 0, costCents: 0 };
}

/** Aktueller Coin-Wert eines Nutzers in Cent (0, wenn die Engine nicht läuft) */
async function coinValueCents(userId) {
  if (!engine.isRunning()) return 0;
  const h = await getHolding(userId);
  return valueCents(h.units, engine.getPrice());
}

module.exports = { UNITS, MIN_TRADE_CENTS, valueCents, buy, sell, getHolding, coinValueCents };
