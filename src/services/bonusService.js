const config = require('../config');
const User = require('../models/User');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const BonusSettings = require('../models/BonusSettings');
const { GradingShop } = require('../models/Grading');
const { toZonedLocalInput } = require('../lib/time');
const { inTransaction } = require('./betService');
const { logSettingsChange } = require('../stats/settingsLog');

// Tagesbonus in Cent – für alle gleich, unabhängig vom Vermögen. Im Admin-Panel änderbar.
const settings = { amount: config.dailyBonus };

async function loadSettings() {
  const doc = await BonusSettings.findById('bonus').lean();
  if (doc && Number.isInteger(doc.amount) && doc.amount >= 0) settings.amount = doc.amount;
}

async function saveSettings({ amount, admin }) {
  await BonusSettings.updateOne({ _id: 'bonus' }, { $set: { amount, updatedByName: admin.username } }, { upsert: true });
  const before = { ...settings };
  settings.amount = amount;
  await logSettingsChange({ area: 'bonus', before, after: settings, by: admin });
}

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

/** Summe der Einsätze in noch offenen (nicht abgerechneten) Wetten */
async function openStakes(userId) {
  const agg = await Position.aggregate([{ $match: { user: userId, payout: null } }, { $group: { _id: null, s: { $sum: '$amount' } } }]);
  return agg[0] ? agg[0].s : 0;
}

/**
 * Prüft einmal pro Tag (beim ersten Seitenaufruf), ob der Nutzer einen Tagesbonus bekommt,
 * und schreibt ihn gut. Gibt { amount, balance } zurück, wenn etwas gutgeschrieben wurde.
 * Wer im Grading-Shop arbeitet, bekommt keinen Bonus. Der Tag wird atomar markiert – auch bei
 * parallelen Anfragen gibt es den Bonus nur einmal.
 */
async function maybeGrantDailyBonus(user) {
  const day = today();
  if (user.lastBonusDay === day) return null;

  const amount = settings.amount;
  if (!amount || (await GradingShop.exists({ _id: user._id, active: true }))) {
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

module.exports = { settings, loadSettings, saveSettings, maybeGrantDailyBonus, today, openStakes };
