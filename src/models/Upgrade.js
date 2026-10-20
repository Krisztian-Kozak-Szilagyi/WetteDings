const { Schema, model } = require('mongoose');

// Kartenaufwertung (src/tcg/upgrade.js): 10 Karten einer Seltenheit werden verschmolzen – mit der berechneten Chance
// kommt eine zufällige Karte der nächsten Seltenheit heraus, sonst eine zufällige Karte derselben Seltenheit.
// Jede Aufwertung bleibt als Eintrag erhalten (Verlauf, Kartenhistorie, Statistik).
const upgradeSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    rarity: { type: String, required: true }, // Seltenheit der eingesetzten Karten
    target: { type: String, required: true }, // nächste Seltenheit (bei Erfolg)
    chance: { type: Number, required: true }, // Erfolgschance 0 … 1 zum Zeitpunkt der Aufwertung
    success: { type: Boolean, required: true },
    inputs: { type: [new Schema({ doc: Schema.Types.ObjectId, card: String }, { _id: false })], default: [] },
    result: { type: new Schema({ doc: Schema.Types.ObjectId, card: String, rarity: String, missing: Boolean }, { _id: false }), required: true }, // missing: fehlte im Album
  },
  { timestamps: true }
);
upgradeSchema.index({ user: 1, createdAt: -1 });

// Einstellungen (ein Dokument, _id "aufwertung") – Werte und Grenzen in src/tcg/upgrade.js
const settingsSchema = new Schema({ _id: { type: String, default: 'aufwertung' }, values: Schema.Types.Mixed, updatedByName: String }, { timestamps: true });

module.exports = { TcgUpgrade: model('TcgUpgrade', upgradeSchema), UpgradeSettings: model('UpgradeSettings', settingsSchema) };
