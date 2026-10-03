// Folie: Wertberechnung folierter Karten und die Einstellungen dazu (ohne Abhängigkeit vom TCG-Service,
// damit Rangliste und Sammlung sie ohne Kreisbezug nutzen können).
const { ItemSettings } = require('../models/Item');
const { logSettingsChange } = require('../stats/settingsLog');

const DAY_MS = 864e5;

// gradingChance in 1/10.000 (100 = 1 %) pro versiegelter Karte; bonusPercent sofort beim Folieren,
// dailyPercent pro vollem Tag seit dem Folieren – beides bezogen auf den Verkaufswert der Karte (linear).
const DEFAULTS = { gradingChance: 100, bonusPercent: 10, dailyPercent: 0.9 };
const settings = { ...DEFAULTS };

const validChance = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
const validPercent = (v) => Number.isFinite(v) && v >= 0 && v <= 1000;

function apply(doc) {
  if (!doc) return;
  if (validChance(doc.gradingChance)) settings.gradingChance = doc.gradingChance;
  if (validPercent(doc.bonusPercent)) settings.bonusPercent = doc.bonusPercent;
  if (validPercent(doc.dailyPercent)) settings.dailyPercent = doc.dailyPercent;
}

async function loadSettings() {
  apply(await ItemSettings.findById('folie').lean());
}

const current = () => ({ ...settings });

async function saveSettings({ admin, gradingChance, bonusPercent, dailyPercent }) {
  if (!validChance(gradingChance) || !validPercent(bonusPercent) || !validPercent(dailyPercent)) throw new Error('Ungültige Folien-Werte.');
  const values = { gradingChance, bonusPercent, dailyPercent };
  await ItemSettings.updateOne({ _id: 'folie' }, { $set: { ...values, updatedByName: admin.username } }, { upsert: true });
  const before = current();
  apply(values);
  await logSettingsChange({ area: 'folie', before, after: current(), by: admin });
}

/** Volle Tage seit dem Folieren (0 am ersten Tag) */
function foilDays(foiledAt, now = Date.now()) {
  if (!foiledAt) return 0;
  return Math.max(0, Math.floor((now - new Date(foiledAt).getTime()) / DAY_MS));
}

/** Wertsteigerung in % (z. B. 10 + 0,9 × Tage) – 0 ohne Folie */
function foilPercent(foiledAt, now = Date.now(), s = settings) {
  if (!foiledAt) return 0;
  return Math.round((s.bonusPercent + s.dailyPercent * foilDays(foiledAt, now)) * 1e6) / 1e6; // ohne Rundungsreste
}

/** Wert einer Karte in Cent: Verkaufswert, bei Folie plus Wertsteigerung (abgerundet) */
function cardValue(sell, foiledAt, now = Date.now(), s = settings) {
  return Math.floor((sell * (100 + foilPercent(foiledAt, now, s))) / 100 + 1e-9);
}

/**
 * MongoDB-Ausdruck: Faktor auf den Verkaufswert (1 ohne Folie, sonst 1 + Steigerung) – gleiche Rechnung wie
 * cardValue, für die Ranglisten-Aggregation. Fehlt das Feld (alte Karten), gilt die Karte als nicht foliert.
 */
function factorExpr(field = '$foiledAt') {
  const days = { $max: [0, { $floor: { $divide: [{ $subtract: ['$$NOW', field] }, DAY_MS] } }] };
  return {
    $cond: [
      { $eq: [{ $type: field }, 'date'] },
      { $divide: [{ $add: [100, settings.bonusPercent, { $multiply: [settings.dailyPercent, days] }] }, 100] },
      1,
    ],
  };
}

module.exports = { DEFAULTS, settings, loadSettings, saveSettings, current, foilDays, foilPercent, cardValue, factorExpr };
