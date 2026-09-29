const config = require('../config');
const catalog = require('./catalog');
const { TcgSettings } = require('../models/Tcg');

const SETTINGS_ID = 'tcg';
let packPrice = config.tcgPackPrice;

/** Aktueller Packpreis in Cent */
const getPackPrice = () => packPrice;

/** Gewichte gültig? Alle Seltenheiten vorhanden, ganzzahlig ≥ 0 und zusammen genau 100 %. */
function validWeights(weight) {
  if (!weight) return false;
  let sum = 0;
  for (const r of catalog.RARITIES) {
    const w = weight[r.key];
    if (!Number.isInteger(w) || w < 0) return false;
    sum += w;
  }
  return sum === catalog.TOTAL_WEIGHT;
}

function apply(doc) {
  if (!doc) return;
  if (Number.isInteger(doc.packPrice) && doc.packPrice > 0) packPrice = doc.packPrice;
  const weightsOk = validWeights(doc.weight);
  for (const r of catalog.RARITIES) {
    const v = doc.sell ? doc.sell[r.key] : undefined;
    if (Number.isInteger(v) && v >= 0) r.sell = v;
    if (weightsOk) r.weight = doc.weight[r.key];
  }
}

/** Beim Start: gespeicherte Werte aus der Datenbank übernehmen (sonst gelten die Standardwerte) */
async function load() {
  apply(await TcgSettings.findById(SETTINGS_ID).lean());
}

/**
 * Neue Werte speichern und sofort anwenden.
 * packCents: Packpreis in Cent, sell: { crumpled: Cent, … }, weight: { crumpled: 1/10.000, … }
 */
async function save({ packCents, sell, weight, admin }) {
  if (!validWeights(weight)) throw new Error('Ungültige Chancen.');
  const doc = { packPrice: packCents, sell, weight, updatedByName: admin.username };
  await TcgSettings.updateOne({ _id: SETTINGS_ID }, { $set: doc }, { upsert: true });
  apply(doc);
}

async function lastUpdate() {
  return TcgSettings.findById(SETTINGS_ID).select('updatedAt updatedByName').lean();
}

module.exports = { getPackPrice, validWeights, load, save, lastUpdate };
