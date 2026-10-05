const { Schema, model } = require('mongoose');

// Geschenk vom Team (Vergabe im Admin-Panel): erscheint beim Mitglied als Fenster, bis es mit „Weiter“ bestätigt ist.
// Bei einer Vergabe an alle bekommt jedes Mitglied einen eigenen Eintrag.
const giftSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['pack', 'karte', 'item', 'geld'], required: true },
    key: { type: String, default: null }, // Pack-Art, Karten-ID oder Gegenstand (für das Bild)
    label: { type: String, required: true }, // z. B. "BfW Holdings Booster Pack", "Krisz (Glitch)"
    count: { type: Number, default: 1 }, // Stück; bei Geld der Betrag in Cent
    reason: { type: String, required: true }, // Grund, den das Team angegeben hat
    byName: { type: String, required: true },
    seenAt: { type: Date, default: null },
  },
  { timestamps: true }
);
giftSchema.index({ user: 1, seenAt: 1, createdAt: 1 });

module.exports = model('Gift', giftSchema);
