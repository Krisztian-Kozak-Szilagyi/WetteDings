const { Schema, model } = require('mongoose');

// Kartensperre (Admin/Dev, Moderation → Kartensperren): eine zu starke Karte ist bis zum nächsten Balance-Patch in
// bestimmten Spielmodi nicht spielbar – weder als Charakter noch als Boost. _id = Karten-ID aus dem Katalog.
// Die gültigen Modi stehen in src/tcg/cardBans.js (MODES). Ohne Modus wird der Eintrag gelöscht.
const cardBanSchema = new Schema(
  {
    _id: { type: String },
    modes: { type: [String], default: [] },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = model('CardBan', cardBanSchema);
