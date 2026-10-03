const { Schema, model } = require('mongoose');

// Verlauf der Balancing-Einstellungen: jede Änderung im Admin-Panel (TCG, IHK, Handel) und geänderte
// Werte aus der .env beim Serverstart. Dient der Statistik als Markierung "ab hier galten andere Werte".
const settingsChangeSchema = new Schema(
  {
    area: { type: String, enum: ['tcg', 'ihk', 'handel', 'bonus', 'grading', 'config'], required: true },
    // geänderte Werte als Pfad, z. B. "weight.gold" oder "hybrid.rewards.2"
    changes: {
      type: [new Schema({ path: String, from: Schema.Types.Mixed, to: Schema.Types.Mixed }, { _id: false })],
      default: [],
    },
    after: { type: Schema.Types.Mixed, required: true }, // vollständiger Stand nach der Änderung
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null = Serverstart (.env)
    byName: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

settingsChangeSchema.index({ area: 1, createdAt: -1 });
settingsChangeSchema.index({ createdAt: -1 });

module.exports = model('SettingsChange', settingsChangeSchema);
