const { Schema, model } = require('mongoose');

// Handel: eine Karte gegen Spielgeld – entweder privat an eine Person oder öffentlich auf dem Markt
const tradeSchema = new Schema(
  {
    kind: { type: String, enum: ['privat', 'markt'], required: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sellerName: { type: String, required: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // nur bei privat
    toName: { type: String, default: null },
    card: { type: String, required: true }, // Karten-ID
    cardDoc: { type: Schema.Types.ObjectId, ref: 'TcgCard', required: true }, // gesperrtes Exemplar
    price: { type: Number, required: true }, // Cent
    status: { type: String, enum: ['offen', 'verkauft', 'abgelehnt', 'zurueckgezogen'], default: 'offen' },
    expiresAt: { type: Date, required: true },
    buyer: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    buyerName: { type: String, default: null },
    taxPercent: { type: Number, default: 0 },
    tax: { type: Number, default: 0 }, // Cent
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
tradeSchema.index({ status: 1, kind: 1, expiresAt: 1 });
tradeSchema.index({ to: 1, status: 1 });
tradeSchema.index({ seller: 1, status: 1 });
// Ein Exemplar kann nur in einem offenen Angebot stecken
tradeSchema.index({ cardDoc: 1 }, { unique: true, partialFilterExpression: { status: 'offen' } });

// Admin-Einstellungen (ein Dokument, _id "handel")
const settingsSchema = new Schema({ _id: { type: String, default: 'handel' }, taxPercent: Number, updatedByName: String }, { timestamps: true });

module.exports = {
  Trade: model('Trade', tradeSchema),
  TradeSettings: model('TradeSettings', settingsSchema),
};
