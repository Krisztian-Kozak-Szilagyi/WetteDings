const { Schema, model } = require('mongoose');

// Eine Lotterie-Runde. Je Lotterie-Art (täglich, wöchentlich, monatlich) gibt es immer höchstens eine offene Runde.
const roundSchema = new Schema(
  {
    // Art der Lotterie: fehlt = täglich (Altbestand), "woche" = Wochen-Lotterie, "monat" = Monats-Lotterie
    kind: { type: String, enum: ['woche', 'monat'], default: undefined },
    number: { type: Number, required: true }, // fortlaufend je Lotterie-Art
    startsAt: { type: Date, required: true }, // ab hier können Lose gekauft werden
    drawAt: { type: Date, required: true }, // Ziehung
    status: { type: String, enum: ['offen', 'gezogen'], default: 'offen' },
    pot: { type: Number, default: 0 }, // Cent – Summe der Einsätze
    // Zusätzlicher Gewinn aus der Bank (nur Wochen-/Monats-Lotterie, Stand der Admin-Einstellung)
    prizeCash: { type: Number, default: 0 }, // Cent
    prizePacks: { type: Number, default: 0 }, // Booster Packs
    prizeFoils: { type: Number, default: 0 }, // Folien
    tickets: { type: Number, default: 0 }, // verkaufte Lose (Losnummern 1 … tickets)
    participants: { type: Number, default: 0 },
    winningTicket: { type: Number, default: null },
    winner: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    winnerName: { type: String, default: null },
    drawnAt: { type: Date, default: null },
  },
  { timestamps: true }
);
roundSchema.index({ kind: 1, number: 1 }, { unique: true });
// Sicherstellen, dass es je Art nie zwei offene Runden gleichzeitig gibt
roundSchema.index({ kind: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'offen' } });
roundSchema.index({ drawnAt: -1 });

// Lose eines Nutzers in einer Runde (mit ihren Losnummern-Bereichen)
const entrySchema = new Schema(
  {
    round: { type: Schema.Types.ObjectId, ref: 'LotteryRound', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    tickets: { type: Number, default: 0 },
    ranges: {
      type: [new Schema({ from: Number, to: Number }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true }
);
entrySchema.index({ round: 1, user: 1 }, { unique: true });
entrySchema.index({ round: 1, 'ranges.from': 1 });

// Im Admin-Panel geänderte Werte der Wochen-/Monats-Lotterie (je ein Dokument, _id "woche" bzw. "monat")
const settingsSchema = new Schema(
  {
    _id: { type: String, enum: ['woche', 'monat'] },
    ticketPrice: Number, // Cent
    prizeCash: Number, // Cent aus der Bank
    prizePacks: Number,
    prizeFoils: Number,
    updatedByName: String,
  },
  { timestamps: true }
);

module.exports = {
  LotteryRound: model('LotteryRound', roundSchema),
  LotteryEntry: model('LotteryEntry', entrySchema),
  LotterySettings: model('LotterySettings', settingsSchema),
};
