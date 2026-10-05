const { Schema, model } = require('mongoose');
const { SOURCES } = require('../items/types');

// Gegenstände im Inventar. Welche Art wie gespeichert wird, steht in src/items/types.js (storage):
//   'stueck' → Item: jedes Stück ein eigenes Dokument (wird beim Benutzen gelöscht), z. B. die Folie (Handel pro Stück)
//   'stapel' → ItemStack: ein Dokument pro Nutzer und Art mit Anzahl – für Verbrauchsmaterial in großen Mengen
// Booster Packs liegen weiter in TcgPack – das Inventar zeigt beides zusammen.
// Zugriff nur über src/items/itemService.js (addItems / takeItems), damit jede Bewegung im ItemLog landet.
const itemSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true }, // Gegenstands-Art aus src/items/types.js, z. B. "folie"
    source: { type: String, enum: SOURCES, required: true },
    lastClaimedAt: { type: Date }, // zuletzt für Handel/Folieren beansprucht – nur für gleichzeitige Zugriffe (siehe itemService)
  },
  { timestamps: true }
);
itemSchema.index({ user: 1, type: 1, createdAt: 1 });

const stackSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    count: { type: Number, required: true, min: 0 },
    lastAddedAt: { type: Date }, // zuletzt etwas dazugekommen – für den „neu“-Punkt am Inventar
  },
  { timestamps: true }
);
stackSchema.index({ user: 1, type: 1 }, { unique: true });

// Protokoll jeder Bewegung (wie der Kontoauszug beim Geld): +n bekommen, −n verbraucht/verkauft/abgegeben.
// Bleibt bei der Kontolöschung unter der neutralen Kennung erhalten (wie Ledger).
const logSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    delta: { type: Number, required: true },
    source: { type: String, enum: SOURCES, required: true },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
logSchema.index({ user: 1, createdAt: -1 });

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
  ItemStack: model('ItemStack', stackSchema),
  ItemLog: model('ItemLog', logSchema),
  ItemSettings: model('ItemSettings', settingsSchema),
};
