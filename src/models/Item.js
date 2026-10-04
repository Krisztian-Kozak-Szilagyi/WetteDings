const { Schema, model } = require('mongoose');

// Ein Gegenstand im Inventar (jedes Stück ist ein eigenes Dokument, wird beim Benutzen gelöscht).
// Booster Packs liegen weiter in TcgPack – das Inventar zeigt beides zusammen.
const itemSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true }, // Gegenstands-Art aus ITEM_TYPES (src/items/itemService.js), z. B. "folie"
    source: { type: String, enum: ['grading', 'admin', 'dungeon', 'handel', 'lotto'], required: true },
    lastClaimedAt: { type: Date }, // zuletzt für Handel/Folieren beansprucht – nur für gleichzeitige Zugriffe (siehe itemService)
  },
  { timestamps: true }
);
itemSchema.index({ user: 1, type: 1, createdAt: 1 });

// Im Admin-Panel geänderte Werte der Folie (ein Dokument, _id "folie")
const settingsSchema = new Schema(
  {
    _id: { type: String, default: 'folie' },
    gradingChance: Number, // Chance in 1/10.000 pro versiegelter Karte im Grading-Shop
    bonusPercent: Number, // Wertsteigerung beim Folieren in %
    dailyPercent: Number, // Wertsteigerung pro vollem Tag in %
    updatedByName: String,
  },
  { timestamps: true }
);

module.exports = {
  Item: model('Item', itemSchema),
  ItemSettings: model('ItemSettings', settingsSchema),
};
