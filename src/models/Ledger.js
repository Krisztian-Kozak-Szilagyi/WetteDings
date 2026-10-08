const { Schema, model } = require('mongoose');

// Kontoauszug: jede Buchung auf dem Spielgeldkonto
const ledgerSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['startguthaben', 'einsatz', 'auszahlung', 'erstattung', 'provision', 'provision_schiri', 'bonus', 'coin_kauf', 'coin_verkauf', 'lotto_los', 'lotto_gewinn', 'tcg_pack', 'tcg_verkauf', 'tcg_zerkleinert', 'kosmetik_kauf', 'ihk_lohn', 'handel_kauf', 'handel_verkauf', 'handel_tausch_zahlung', 'handel_tausch_erhalt', 'black_market', 'konto_geloescht', 'grading_lohn', 'grading_ausbau', 'item_verkauf', 'dungeon_lohn', 'erfolg', 'team_gutschrift', 'team_abzug', 'esports_gruendung', 'esports_austritt', 'esports_anteil', 'esports_konkurs', 'esports_auszahlung', 'esports_preis', 'schuld_tilgung'], required: true },
    amount: { type: Number, required: true }, // Cent, negativ = Abbuchung
    bet: { type: Schema.Types.ObjectId, ref: 'Bet', default: null },
    betTitle: { type: String, default: null },
    // Details für die Statistik, z. B. verkaufte Karten { cards: [{ card, rarity, count }] } oder gekaufte Packs
    meta: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

ledgerSchema.index({ user: 1, createdAt: -1 });
ledgerSchema.index({ type: 1, createdAt: -1 }); // Protokolle: alle Buchungen einer Art
ledgerSchema.index({ createdAt: -1 }); // Protokolle: alle Buchungen

module.exports = model('Ledger', ledgerSchema);
