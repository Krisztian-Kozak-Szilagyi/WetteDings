const config = require('../config');
const User = require('../models/User');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { toZonedLocalInput } = require('../lib/time');
const { inTransaction } = require('./betService');
const { coinValueCents } = require('../coin/tradeService');

/**
 * Aktueller "Bonustag" als "YYYY-MM-DD". Ein Bonustag beginnt um config.bonusTime (deutsche Zeit),
 * z. B. 07:45 – vor dieser Uhrzeit zählt noch der Vortag.
 */
function today(now = new Date()) {
  const local = toZonedLocalInput(now, config.timezone); // "YYYY-MM-DDTHH:mm"
  const [datePart, timePart] = local.split('T');
  if (timePart >= config.bonusTime) return datePart;
  const [y, m, d] = datePart.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Bonus in Cent für ein Gesamtvermögen in Cent (0, wenn keine Stufe passt) */
function bonusFor(total) {
  const tier = config.bonusTiers.find((t) => total < t.below);
  return tier ? tier.amount : 0;
}

/** Summe der Einsätze in noch offenen (nicht abgerechneten) Wetten */
async function openStakes(userId) {
  const agg = await Position.aggregate([{ $match: { user: userId, payout: null } }, { $group: { _id: null, s: { $sum: '$amount' } } }]);
  return agg[0] ? agg[0].s : 0;
}

/**
 * Prüft einmal pro Tag (beim ersten Seitenaufruf), ob der Nutzer einen Tagesbonus bekommt,
 * und schreibt ihn gut. Gibt { amount, balance } zurück, wenn etwas gutgeschrieben wurde.
 * Der Tag wird atomar markiert – auch bei parallelen Anfragen gibt es den Bonus nur einmal.
 */
async function maybeGrantDailyBonus(user) {
  const day = today();
  if (user.lastBonusDay === day) return null;

  // Gesamtvermögen: verfügbar + offene Einsätze + Wert der Samantha Coins
  const [stakes, coins] = await Promise.all([openStakes(user._id), coinValueCents(user._id)]);
  const total = user.balance + stakes + coins;
  const amount = bonusFor(total);

  if (!amount) {
    await User.updateOne({ _id: user._id, lastBonusDay: { $ne: day } }, { $set: { lastBonusDay: day } });
    return null;
  }

  return inTransaction(async (session) => {
    const updated = await User.findOneAndUpdate(
      { _id: user._id, lastBonusDay: { $ne: day } },
      { $set: { lastBonusDay: day }, $inc: { balance: amount } },
      { new: true, session }
    );
    if (!updated) return null; // parallel schon vergeben
    await Ledger.create([{ user: user._id, type: 'bonus', amount }], { session });
    return { amount, balance: updated.balance };
  });
}

module.exports = { maybeGrantDailyBonus, bonusFor, today, openStakes };
