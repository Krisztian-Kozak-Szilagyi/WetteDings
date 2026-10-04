const User = require('../models/User');
const Ledger = require('../models/Ledger');
const { CoinHolding, CoinTrade } = require('../models/Coin');
const { inTransaction } = require('../services/betService');
const { UserError } = require('../lib/util');
const markets = require('./markets');
const taxService = require('../services/taxService');

/** Engine zum Symbol; unbekannte Symbole sind ein Nutzerfehler */
function engineOf(symbol) {
  const engine = markets.get(symbol);
  if (!engine) throw new UserError('Diesen Wert gibt es im Broker nicht.');
  return engine;
}

const UNITS = 1e8; // 1 Coin = 100.000.000 Einheiten
const MIN_TRADE_CENTS = 100; // Mindestbetrag 1 €
const MIN_BUY_SHARE = 0.1; // beim Kauf mindestens 10 % des aktuellen Kurses

/** Mindestbetrag für einen Kauf in Cent: 10 % des Kurses, mindestens 1 € */
const minBuyCents = (price) => Math.max(MIN_TRADE_CENTS, Math.ceil(Number((price * 100 * MIN_BUY_SHARE).toFixed(6))));
const euroText = (cents) => (cents / 100).toFixed(2).replace('.', ',');

/** Wert eines Bestands in Cent zum Kurs price */
const valueCents = (units, price) => Math.floor((units / UNITS) * price * 100);
// Bestand als Text mit genau zwei Nachkommastellen, abgerundet (z. B. "12,34") – fürs Profil
const unitsText = (units) => (Math.floor(((units || 0) / UNITS) * 100 + 1e-9) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Kaufen für einen Euro-Betrag (Cent) zum aktuellen Kurs */
async function buy({ user, symbol = 'SAM', cents }) {
  const engine = engineOf(symbol);
  if (!Number.isInteger(cents) || cents < MIN_TRADE_CENTS) throw new UserError('Der Mindestbetrag ist 1,00 €.');
  return inTransaction(async (session) => {
    const price = engine.getPrice();
    const min = minBuyCents(price);
    if (cents < min) throw new UserError(`Du musst mindestens 10 % des aktuellen Kurses investieren – derzeit ${euroText(min)} €.`);
    const units = Math.floor((cents / 100 / price) * UNITS);
    if (units <= 0) throw new UserError('Der Betrag ist zu klein.');

    const updatedUser = await User.findOneAndUpdate(
      { _id: user._id, balance: { $gte: cents } },
      { $inc: { balance: -cents } },
      { new: true, session }
    );
    if (!updatedUser) throw new UserError('Dein Guthaben reicht dafür nicht aus.');

    await CoinHolding.updateOne(
      { user: user._id, coin: symbol },
      { $inc: { units, costCents: cents } },
      { upsert: true, session }
    );
    await CoinTrade.create([{ user: user._id, coin: symbol, side: 'kauf', units, price, cents }], { session });
    await Ledger.create([{ user: user._id, type: 'coin_kauf', amount: -cents, betTitle: engine.NAME }], { session });
    return { units, price, cents };
  });
}

/**
 * Verkaufen: entweder einen Euro-Betrag (cents) oder den gesamten Bestand (all = true).
 * Der Einstandswert wird anteilig reduziert.
 */
async function sell({ user, symbol = 'SAM', cents, all = false }) {
  const engine = engineOf(symbol);
  if (!all && (!Number.isInteger(cents) || cents < MIN_TRADE_CENTS)) throw new UserError('Der Mindestbetrag ist 1,00 €.');
  return inTransaction(async (session) => {
    const price = engine.getPrice();
    const holding = await CoinHolding.findOne({ user: user._id, coin: symbol }).session(session);
    if (!holding || holding.units <= 0) throw new UserError(`Du besitzt keine Anteile von ${engine.NAME}.`);

    let units = all ? holding.units : Math.ceil((cents / 100 / price) * UNITS);
    if (units > holding.units) {
      throw new UserError(`Du besitzt nur Anteile im Wert von ${(valueCents(holding.units, price) / 100).toFixed(2).replace('.', ',')} €.`);
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

    // Steuer nur auf den Gewinn (Erlös − anteiliger Einstand), Satz je Kategorie (Coins, ETFs)
    const tax = taxService.gainTax(proceeds, costReduce, taxService.rate(engine.kind));
    const net = proceeds - tax;
    await User.updateOne({ _id: user._id }, { $inc: { balance: net } }, { session });
    await CoinTrade.create([{ user: user._id, coin: symbol, side: 'verkauf', units, price, cents: net, tax }], { session });
    await Ledger.create([{ user: user._id, type: 'coin_verkauf', amount: net, betTitle: engine.NAME }], { session });
    return { units, price, cents: net, tax, profit: net - costReduce };
  });
}

async function getHolding(userId, symbol = 'SAM') {
  const h = await CoinHolding.findOne({ user: userId, coin: symbol }).lean();
  return h || { units: 0, costCents: 0 };
}

/** Bestände eines Nutzers je Symbol: { SAM: {units, costCents}, … } */
async function getHoldings(userId) {
  const list = await CoinHolding.find({ user: userId }).lean();
  const out = {};
  for (const s of markets.SYMBOLS) out[s] = list.find((h) => h.coin === s) || { units: 0, costCents: 0 };
  return out;
}

/** Aktueller Wert aller Broker-Bestände eines Nutzers in Cent (Werte ohne laufende Engine zählen 0) */
async function coinValueCents(userId) {
  const prices = markets.prices();
  const list = await CoinHolding.find({ user: userId, units: { $gt: 0 } }).lean();
  return list.reduce((sum, h) => sum + (prices[h.coin] ? valueCents(h.units, prices[h.coin]) : 0), 0);
}

module.exports = { UNITS, MIN_TRADE_CENTS, MIN_BUY_SHARE, minBuyCents, valueCents, unitsText, buy, sell, getHolding, getHoldings, coinValueCents };
