const { Schema, model } = require('mongoose');

// Stündliche Abrufe der Video-Aufrufzahlen für den MK Coin (coin/tagViews.js) – werden nach 45 Tagen automatisch gelöscht
const tagReadingSchema = new Schema(
  {
    t: { type: Date, required: true }, // Zeitpunkt des Abrufs
    views: { type: Schema.Types.Mixed, default: {} }, // Video-ID → Aufrufe zu diesem Zeitpunkt
  },
  { versionKey: false }
);
tagReadingSchema.index({ t: 1 }, { unique: true, expireAfterSeconds: 45 * 24 * 60 * 60 });

module.exports = model('TagReading', tagReadingSchema);
