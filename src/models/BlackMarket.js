const { Schema, model } = require('mongoose');

// Black Market: täglich 16:30–19:00 vier Karten (Gold bis Glitch), jede nur einmal zu haben – wer zuerst kauft.
// Ein Dokument pro Tag, _id = Tag in deutscher Zeit ("2026-10-03"). Siehe src/tcg/blackMarket.js.
const offerSchema = new Schema(
  {
    card: { type: String, required: true }, // Karten-ID
    rarity: { type: String, required: true },
    price: { type: Number, required: true }, // Cent (170 % des Verkaufspreises beim Öffnen)
    buyer: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    buyerName: { type: String, default: null },
    soldAt: { type: Date, default: null },
  },
  { _id: false }
);

const blackMarketSchema = new Schema({ _id: { type: String }, offers: { type: [offerSchema], default: [] } }, { timestamps: true });

module.exports = model('BlackMarket', blackMarketSchema);
