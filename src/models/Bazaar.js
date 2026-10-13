const { Schema, model } = require('mongoose');

// Lil Dré's Bazaar: ein Dokument pro eSports-Team und Tag, _id = "<teamId>:<Tag>" (Tag in deutscher Zeit, "2026-10-10").
// Vier Plätze (Kaffee / BfW Energy), jeder nur einmal – kauft ein Mitglied, ist er fürs ganze Team weg.
// Siehe src/esports/bazaar.js (Logik) und bazaarService.js.
const offerSchema = new Schema(
  {
    card: { type: String, required: true },
    rarity: { type: String, required: true },
    price: { type: Number, required: true }, // Cent (150 % des Verkaufspreises beim Würfeln)
    buyer: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    buyerName: { type: String, default: null },
    soldAt: { type: Date, default: null },
  },
  { _id: false }
);

const bazaarSchema = new Schema(
  {
    _id: { type: String },
    team: { type: Schema.Types.ObjectId, ref: 'EsportsTeam', required: true },
    day: { type: String, required: true },
    offers: { type: [offerSchema], default: [] },
    // alte Tage räumt MongoDB nach 30 Tagen selbst weg
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
  },
  { versionKey: false }
);

module.exports = model('Bazaar', bazaarSchema);
