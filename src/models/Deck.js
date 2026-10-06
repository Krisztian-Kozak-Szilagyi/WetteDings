const { Schema, model } = require('mongoose');

// Kartendeck eines Spielers für den kommenden Kampfmodus (Regeln: src/game/deck.js).
// Mehrere Decks pro Spieler sind im Modell schon möglich; die Obergrenze steht in deck.js (MAX_DECKS).
const deckSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, maxlength: 30 },
    cards: [{ _id: false, card: { type: String, required: true }, n: { type: Number, required: true, min: 1 } }],
  },
  { timestamps: true }
);
deckSchema.index({ user: 1, createdAt: 1 });

module.exports = model('Deck', deckSchema);
