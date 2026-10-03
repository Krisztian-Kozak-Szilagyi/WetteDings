const { Schema, model } = require('mongoose');

// Kontoauszug: jede Buchung auf dem Spielgeldkonto
const ledgerSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['startguthaben', 'einsatz', 'auszahlung', 'erstattung', 'provision', 'provision_schiri', 'bonus', 'coin_kauf', 'coin_verkauf', 'lotto_los', 'lotto_gewinn', 'tcg_pack', 'tcg_verkauf', 'ihk_lohn', 'handel_kauf', 'handel_verkauf', 'handel_tausch_zahlung', 'handel_tausch_erhalt', 'black_market', 'konto_geloescht', 'grading_lohn', 'grading_ausbau', 'item_verkauf'], required: true },
    amount: { type: Number, required: true }, // Cent, negativ = Abbuchung
    bet: { type: Schema.Types.ObjectId, ref: 'Bet', default: null },
    betTitle: { type: String, default: null },
    // Details für die Statistik, z. B. verkaufte Karten { cards: [{ card, rarity, count }] } oder gekaufte Packs
    meta: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

ledgerSchema.index({ user: 1, createdAt: -1 });

module.exports = model('Ledger', ledgerSchema);
