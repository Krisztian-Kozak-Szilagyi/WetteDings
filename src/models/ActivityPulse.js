const { Schema, model } = require('mongoose');

// Aktivität der ganzen Seite je Stunde – Grundlage für den Trend des BfW-TCG ETF (siehe coin/etfTrend.js).
// Gezählt werden nur echte Aktionen (wetten, kaufen, verkaufen, Karten öffnen, posten …), keine Seitenaufrufe.
const activityPulseSchema = new Schema(
  {
    t: { type: Date, required: true }, // Beginn der Stunde
    n: { type: Number, default: 0 }, // Aktionen (je Mitglied und Stunde höchstens etfTrend.USER_HOUR_CAP)
    users: { type: [Schema.Types.ObjectId], default: [] }, // aktive Mitglieder in dieser Stunde
  },
  { versionKey: false }
);

// eindeutig je Stunde; ältere Stunden als 30 Tage braucht niemand
activityPulseSchema.index({ t: 1 }, { unique: true, expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = model('ActivityPulse', activityPulseSchema);
