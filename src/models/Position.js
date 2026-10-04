const { Schema, model } = require('mongoose');

// Eine Position = alle Einsätze eines Nutzers in einer Wette (immer nur auf eine Option).
const positionSchema = new Schema(
  {
    bet: { type: Schema.Types.ObjectId, ref: 'Bet', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    side: { type: String, required: true, maxlength: 10 }, // key der gewählten Option
    amount: { type: Number, required: true, min: 1 }, // Cent
    payout: { type: Number, default: null }, // Cent, null = noch nicht abgerechnet
    settledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

positionSchema.index({ bet: 1, user: 1 }, { unique: true });
positionSchema.index({ user: 1, createdAt: -1 });
positionSchema.index({ user: 1, payout: 1 });
positionSchema.index({ createdAt: -1 }); // Protokolle: alle Einsätze

module.exports = model('Position', positionSchema);
