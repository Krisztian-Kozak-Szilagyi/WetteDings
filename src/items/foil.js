// Folie: Wertberechnung folierter Karten und die Einstellungen dazu (ohne Abhängigkeit vom TCG-Service,
// damit Rangliste und Sammlung sie ohne Kreisbezug nutzen können).
// #204: Die Folie ist eine Schutzhülle (Sleeve) – sie steigert den Wert nicht mehr. Die Steigerung behalten nur Slabs
// (die früher folierten Karten wurden zu BfW-Slabs, siehe migrate.foilToSlab); gerechnet ab foiledAt.
const { ItemSettings } = require('../models/Item');
const { logSettingsChange } = require('../stats/settingsLog');
const { itemTypeByKey } = require('./types');

const DAY_MS = 864e5;

// gradingChance in 1/10.000 (100 = 1 %) pro versiegelter Karte; bonusPercent sofort beim Folieren,
// dailyPercent pro vollem Tag seit dem Folieren – beides bezogen auf den Verkaufswert der Karte (linear).
// sleevePrice / slabPrice = Bank-Shop (Inventar › Kaufen) in Cent, slabDropPercent = Anteil der Dungeon-/Turm-Funde, die ein
// leerer Slab statt eines Sleeves sind (in %).
const DEFAULTS = { gradingChance: 100, bonusPercent: 10, dailyPercent: 0.9, sleevePrice: itemTypeByKey.folie.buy, slabPrice: itemTypeByKey.slab.buy, slabDropPercent: 30 };
/** Welches Feld der Einstellungen den Shop-Preis einer Gegenstands-Art hält */
const PRICE_FIELD = { folie: 'sleevePrice', slab: 'slabPrice' };
const settings = { ...DEFAULTS };

const validChance = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
const validPercent = (v) => Number.isFinite(v) && v >= 0 && v <= 1000;
/** Shop-Preis in Cent: ganze Cent, nie unter dem Ankaufspreis der Bank (sonst ließe sich Geld drucken), höchstens 1.000 € */
const validPrice = (key, v) => Number.isInteger(v) && v >= itemTypeByKey[key].sell && v <= 100000;

function apply(doc) {
  if (!doc) return;
  if (validChance(doc.gradingChance)) settings.gradingChance = doc.gradingChance;
  if (validPercent(doc.bonusPercent)) settings.bonusPercent = doc.bonusPercent;
  if (validPercent(doc.dailyPercent)) settings.dailyPercent = doc.dailyPercent;
  for (const [key, field] of Object.entries(PRICE_FIELD)) if (validPrice(key, doc[field])) settings[field] = doc[field];
  if (doc.slabDropPercent != null && validPercent(doc.slabDropPercent) && doc.slabDropPercent <= 100) settings.slabDropPercent = doc.slabDropPercent;
}

async function loadSettings() {
  apply(await ItemSettings.findById('folie').lean());
}

const current = () => ({ ...settings });

// Die neuen Felder sind optional: wer nur die Folien-Werte ändert, lässt Preise und Drop-Anteil unberührt
async function saveSettings({ admin, gradingChance, bonusPercent, dailyPercent, sleevePrice = settings.sleevePrice, slabPrice = settings.slabPrice, slabDropPercent = settings.slabDropPercent }) {
  if (!validChance(gradingChance) || !validPercent(bonusPercent) || !validPercent(dailyPercent)) throw new Error('Ungültige Folien-Werte.');
  if (!validPrice('folie', sleevePrice) || !validPrice('slab', slabPrice)) throw new Error('Ungültige Shop-Preise (mindestens der Ankaufspreis der Bank).');
  if (!validPercent(slabDropPercent) || slabDropPercent > 100) throw new Error('Ungültiger Slab-Anteil.');
  const values = { gradingChance, bonusPercent, dailyPercent, sleevePrice, slabPrice, slabDropPercent };
  await ItemSettings.updateOne({ _id: 'folie' }, { $set: { ...values, updatedByName: admin.username } }, { upsert: true });
  const before = current();
  apply(values);
  await logSettingsChange({ area: 'folie', before, after: current(), by: admin });
}

// Kürzel der alten Folien mit Etikett (migrate.foilToSlab). Shops können es nicht wählen (BFW ist reserviert, Kürzel
// sind immer groß geschrieben) – so steigen nur diese Slabs im Wert; Slabs aus Spieler-Shops bewertet der Markt (#204)
const LEGACY_SLAB = 'BfW';
/** Ab wann ein Exemplar ({ foiledAt, slab }) im Wert steigt: nur ein alter BfW-Slab, sonst null */
const growthFrom = (copy) => (copy && copy.slab && copy.slab.code === LEGACY_SLAB && copy.foiledAt ? copy.foiledAt : null);

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
 * MongoDB-Ausdruck: Faktor auf den Verkaufswert (1 ohne Slab, sonst 1 + Steigerung) – gleiche Rechnung wie
 * cardValue(…, growthFrom(…)), für die Ranglisten-Aggregation. Fehlt das Feld (alte Karten), gilt die Karte als nicht foliert.
 */
function factorExpr(field = '$foiledAt', slabCodeField = '$slab.code') {
  const days = { $max: [0, { $floor: { $divide: [{ $subtract: ['$$NOW', field] }, DAY_MS] } }] };
  return {
    $cond: [
      { $and: [{ $eq: [{ $type: field }, 'date'] }, { $eq: [slabCodeField, LEGACY_SLAB] }] },
      { $divide: [{ $add: [100, settings.bonusPercent, { $multiply: [settings.dailyPercent, days] }] }, 100] },
      1,
    ],
  };
}

module.exports = { DEFAULTS, PRICE_FIELD, validPrice, settings, loadSettings, saveSettings, current, LEGACY_SLAB, growthFrom, foilDays, foilPercent, cardValue, factorExpr };
