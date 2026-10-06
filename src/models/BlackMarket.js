const { Schema, model } = require('mongoose');

// Black Market: täglich 16:30–19:00 vier Angebote (Karten von Holo bis Glitch, selten eine Bosskarte oder eine Folie),
// jedes nur einmal zu haben – wer zuerst kauft. Keine Karte und kein Gegenstand zweimal am selben Tag.
// Ein Dokument pro Tag, _id = Tag in deutscher Zeit ("2026-10-03"). Siehe src/tcg/blackMarket.js.
const offerSchema = new Schema(
  {
    // 'karte' oder 'gegenstand' – alte Tagesdokumente ohne Feld sind Karten (blackMarket.offerKind)
    kind: { type: String, enum: ['karte', 'gegenstand'], default: 'karte' },
    card: { type: String, required: true }, // Karten-ID, bei Gegenständen "item:<Art>" (wie im Handel, z. B. "item:folie")
    rarity: { type: String, required: true }, // bei Gegenständen "item"
    price: { type: Number, required: true }, // Cent (170 % des Verkaufspreises beim Öffnen, Gegenstände mindestens 1.000 €)
    buyer: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    buyerName: { type: String, default: null },
    soldAt: { type: Date, default: null },
  },
  { _id: false }
);

const blackMarketSchema = new Schema({ _id: { type: String }, offers: { type: [offerSchema], default: [] } }, { timestamps: true });

module.exports = model('BlackMarket', blackMarketSchema);
