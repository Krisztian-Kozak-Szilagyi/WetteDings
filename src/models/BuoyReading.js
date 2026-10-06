const { Schema, model } = require('mongoose');

// Messwerte der NOAA-Boje 51101 (Pazifik) für den 51101 Coin – werden nach 45 Tagen automatisch gelöscht
const buoyReadingSchema = new Schema(
  {
    station: { type: String, required: true },
    t: { type: Date, required: true }, // Messzeitpunkt (UTC)
    w: { type: Number, required: true }, // Wind in m/s (10-Minuten-Mittel)
    g: { type: Number, required: true }, // stärkste Böe in m/s
    p: { type: Number, required: true }, // Luftdruck in hPa
  },
  { versionKey: false }
);
buoyReadingSchema.index({ station: 1, t: 1 }, { unique: true });
buoyReadingSchema.index({ t: 1 }, { expireAfterSeconds: 45 * 24 * 60 * 60 });

module.exports = model('BuoyReading', buoyReadingSchema);
