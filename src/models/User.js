const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    username: { type: String, required: true, trim: true },
    usernameLower: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: { type: String, required: true },
    // Kontostand in Cent
    balance: { type: Number, required: true, min: 0 },
    // Tag (deutsche Zeit, "YYYY-MM-DD"), an dem zuletzt der Tagesbonus geprüft/gutgeschrieben wurde
    lastBonusDay: { type: String, default: null },
    // Zeitpunkt des letzten Besuchs der Handelsseite (für das Markt-Abzeichen im Menü)
    marketSeenAt: { type: Date, default: null },
    // Letzter Besuch der TCG-Seite bzw. der Patchnotes (für die Abzeichen "neue Packs" / "neue Patchnotes")
    packsSeenAt: { type: Date, default: null },
    patchSeenAt: { type: Date, default: null },
    // TCG: Karten-IDs, deren Duplikate nicht mitverkauft werden, und bis zu 4 Favoriten für die TCG-Seite
    tcgProtected: { type: [String], default: [] },
    tcgFavorites: { type: [String], default: [] },
  },
  { timestamps: true }
);

userSchema.index({ balance: -1 });

module.exports = model('User', userSchema);
