const { Schema, model } = require('mongoose');

// Kontoauszug: jede Buchung auf dem Spielgeldkonto
const ledgerSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['startguthaben', 'einsatz', 'auszahlung', 'erstattung', 'provision', 'bonus', 'coin_kauf', 'coin_verkauf', 'lotto_los', 'lotto_gewinn', 'tcg_pack', 'tcg_verkauf', 'ihk_lohn', 'handel_kauf', 'handel_verkauf'], required: true },
    amount: { type: Number, required: true }, // Cent, negativ = Abbuchung
    bet: { type: Schema.Types.ObjectId, ref: 'Bet', default: null },
    betTitle: { type: String, default: null },
  },
  { timestamps: true }
);

ledgerSchema.index({ user: 1, createdAt: -1 });

module.exports = model('Ledger', ledgerSchema);
