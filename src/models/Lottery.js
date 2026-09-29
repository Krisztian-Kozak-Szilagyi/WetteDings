const { Schema, model } = require('mongoose');

// Eine Lotterie-Runde (täglich). Es gibt immer höchstens eine offene Runde.
const roundSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    startsAt: { type: Date, required: true }, // ab hier können Lose gekauft werden
    drawAt: { type: Date, required: true }, // Ziehung (1 Minute vor Start der nächsten Runde)
    status: { type: String, enum: ['offen', 'gezogen'], default: 'offen' },
    pot: { type: Number, default: 0 }, // Cent
    tickets: { type: Number, default: 0 }, // verkaufte Lose (Losnummern 1 … tickets)
    participants: { type: Number, default: 0 },
    winningTicket: { type: Number, default: null },
    winner: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    winnerName: { type: String, default: null },
    drawnAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Sicherstellen, dass es nie zwei offene Runden gleichzeitig gibt
roundSchema.index({ status: 1 }, { unique: true, partialFilterExpression: { status: 'offen' } });
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

module.exports = {
  LotteryRound: model('LotteryRound', roundSchema),
  LotteryEntry: model('LotteryEntry', entrySchema),
};
