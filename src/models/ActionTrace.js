const { Schema, model } = require('mongoose');

// Herkunft einer Spiel-Aktion (Manipulationserkennung "gleichzeitig von zwei Geräten"): Geräte-Kennung und Netz,
// beides nur gekürzt bzw. als Hash. Wird nach zwei Tagen automatisch gelöscht.
const actionTraceSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dev: { type: String, default: null }, // Anfang der Geräte-Kennung (Cookie)
    net: { type: String, default: null }, // Hash des Netzes (IPv4-Adresse bzw. IPv6-/64)
    at: { type: Date, required: true },
  },
  { versionKey: false }
);
actionTraceSchema.index({ at: 1 }, { expireAfterSeconds: 2 * 24 * 60 * 60 });
actionTraceSchema.index({ user: 1, at: 1 });

module.exports = model('ActionTrace', actionTraceSchema);
