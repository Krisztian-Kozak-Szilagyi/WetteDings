const { Schema, model } = require('mongoose');

// Eine Karte im Besitz eines Nutzers (jede gezogene Karte ist ein eigenes Dokument)
const cardSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    card: { type: String, required: true }, // Karten-ID aus dem Katalog, z. B. "krisz-6-glitch"
    rarity: { type: String, required: true },
    opening: { type: Schema.Types.ObjectId, ref: 'TcgOpening', default: null },
    lastClaimedAt: { type: Date }, // zuletzt für Quest/Handel beansprucht – nur Schreibzugriff gegen gleichzeitige Verkäufe, nicht die Sperre selbst (siehe tcg/locks)
  },
  { timestamps: true }
);
cardSchema.index({ user: 1, card: 1, createdAt: 1 });

// Ein geöffnetes Booster Pack (für Statistik und den Feed seltener Ziehungen)
const openingSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    cost: { type: Number, required: true }, // Cent
    cards: {
      type: [new Schema({ card: String, rarity: String }, { _id: false })],
      default: [],
    },
    best: { type: Number, required: true }, // Rang der seltensten Karte (0 = Crumpled … 5 = Glitch)
  },
  { timestamps: true }
);
openingSchema.index({ user: 1, createdAt: -1 });
openingSchema.index({ best: -1, createdAt: -1 });

// Im Admin-Panel geänderte Preise (ein einziges Dokument mit _id "tcg")
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'tcg' },
    packPrice: { type: Number, required: true }, // Cent
    sell: { type: Schema.Types.Mixed, default: {} }, // { crumpled: Cent, … }
    weight: { type: Schema.Types.Mixed, default: null }, // { crumpled: Chance in 1/10.000, … }
    updatedByName: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = {
  TcgCard: model('TcgCard', cardSchema),
  TcgOpening: model('TcgOpening', openingSchema),
  TcgSettings: model('TcgSettings', settingsSchema),
};
