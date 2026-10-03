const { Schema, model } = require('mongoose');

// Tipp eines Zuschauers in einem Duell: wer gewinnt? Ohne Einsatz – nur für die Stimmung.
// Die Summen je Seite stehen zusätzlich an der Wette (duel.tipsO1 / duel.tipsO2), damit Listen ohne Zählen auskommen.
const duelTipSchema = new Schema(
  {
    bet: { type: Schema.Types.ObjectId, ref: 'Bet', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    side: { type: String, enum: ['o1', 'o2'], required: true },
  },
  { timestamps: true }
);
duelTipSchema.index({ bet: 1, user: 1 }, { unique: true });
duelTipSchema.index({ user: 1 });

module.exports = model('DuelTip', duelTipSchema);
