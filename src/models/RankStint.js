const { Schema, model } = require('mongoose');

// Ein Abschnitt auf Platz 1 der Rangliste (rankService.trackTop1, minütlich): wer von wann bis wann vorne lag und mit
// welchem kleinsten Vorsprung auf Platz 2. Grundlage für die Manipulationserkennung "Platz 1 mit geliehenem Wert".
// Wird nach 90 Tagen automatisch gelöscht.
const rankStintSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    minLead: { type: Number, required: true }, // Cent (Ranglisten-Wert, siehe rankService.ranking)
  },
  { versionKey: false }
);
rankStintSchema.index({ to: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
rankStintSchema.index({ user: 1, to: -1 });

module.exports = model('RankStint', rankStintSchema);
