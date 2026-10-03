// Verlauf der Balancing-Einstellungen (siehe models/SettingsChange). Das Protokollieren darf das Speichern
// nie verhindern: Fehler werden nur ausgegeben.
const config = require('../config');
const SettingsChange = require('../models/SettingsChange');

/** Tiefe Kopie einfacher Werte (Zahlen, Texte, Listen, Objekte) */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * Unterschiede zwischen zwei Ständen als flache Liste [{ path, from, to }].
 * Objekte und Listen werden bis zu den einzelnen Werten aufgelöst ("rewards.2").
 */
function diffSettings(before, after, prefix = '') {
  const isNested = (v) => v !== null && typeof v === 'object';
  if (!isNested(before) || !isNested(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: prefix, from: clone(before) ?? null, to: clone(after) ?? null }];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.flatMap((k) => diffSettings(before[k], after[k], prefix ? `${prefix}.${k}` : k));
}

/** Änderung festhalten, sofern sich etwas geändert hat. by: handelnder Admin/Dev oder null (Serverstart) */
async function logSettingsChange({ area, before, after, by = null }) {
  try {
    const changes = diffSettings(before || {}, after);
    if (!changes.length) return null;
    return await SettingsChange.create({ area, changes, after: clone(after), by: by ? by._id : null, byName: by ? by.username : null });
  } catch (err) {
    console.error('Einstellungs-Verlauf konnte nicht gespeichert werden:', err.message);
    return null;
  }
}

/** Balancing-Werte aus der .env (bzw. Standardwerte), die sich nur mit einem Neustart ändern */
function configValues() {
  return {
    startBalance: config.startBalance,
    minStake: config.minStake,
    creatorFeePercent: config.creatorFeePercent,
    duelFeePercent: require('../services/duelService').DUEL_FEE_PERCENT, // erst hier laden: vermeidet Require-Zyklen
    autoVoidDays: config.autoVoidDays,
    bonusTiers: config.bonusTiers,
    bonusTime: config.bonusTime,
    lotteryTicketPrice: config.lotteryTicketPrice,
    lotteryTime: config.lotteryTime,
  };
}

/** Beim Start: weichen die .env-Werte vom zuletzt festgehaltenen Stand ab, wird das als Änderung vermerkt */
async function logConfigOnStart() {
  try {
    const last = await SettingsChange.findOne({ area: 'config' }).sort({ createdAt: -1 }).select('after').lean();
    await logSettingsChange({ area: 'config', before: last ? last.after : null, after: configValues() });
  } catch (err) {
    console.error('Einstellungs-Verlauf (Start) fehlgeschlagen:', err.message);
  }
}

module.exports = { diffSettings, logSettingsChange, logConfigOnStart, configValues };
