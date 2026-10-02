const { Schema, model } = require('mongoose');

// Nachricht in der Verhandlung eines Tauschs. from = Rolle im Angebot ('seller' | 'to') oder 'system'
// (Bedingungen geändert). Namen werden beim Anzeigen aus sellerName/toName genommen – so bleiben sie
// nach einer Umbenennung aktuell.
const messageSchema = new Schema(
  {
    from: { type: String, enum: ['seller', 'to', 'system'], required: true },
    text: { type: String, required: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Handel: eine Karte gegen Spielgeld (privat an eine Person oder öffentlich auf dem Markt)
// oder ein Tausch Karte gegen Karte an eine Person, optional mit Aufpreis
const tradeSchema = new Schema(
  {
    kind: { type: String, enum: ['privat', 'markt', 'tausch'], required: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // Anbieter
    sellerName: { type: String, required: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // nur bei privat und tausch
    toName: { type: String, default: null },
    card: { type: String, required: true }, // Karten-ID
    cardDoc: { type: Schema.Types.ObjectId, ref: 'TcgCard', required: true }, // gesperrtes Exemplar
    wantCard: { type: String, default: null }, // nur bei tausch: gewünschte Karte des Empfängers
    wantCardDoc: { type: Schema.Types.ObjectId, ref: 'TcgCard', default: null }, // erst beim Annehmen gesetzt
    extraFrom: { type: String, enum: ['seller', 'to', null], default: null }, // nur bei tausch: wer den Aufpreis zahlt
    price: { type: Number, required: true }, // Cent (bei tausch: Aufpreis, 0 erlaubt)
    // Verhandlung (nur bei tausch): wer die aktuellen Bedingungen zuletzt gesetzt hat – annehmen darf nur die andere Seite
    lastChangeBy: { type: String, enum: ['seller', 'to'], default: 'seller' },
    termsVersion: { type: Number, default: 0 }, // steigt bei jeder Änderung; Annehmen veralteter Bedingungen wird abgelehnt
    messages: { type: [messageSchema], default: [] },
    activityAt: { type: Date, default: null }, // letzte Nachricht oder Änderung
    sellerSeenAt: { type: Date, default: null }, // zuletzt gelesen vom Anbieter
    toSeenAt: { type: Date, default: null }, // zuletzt gelesen vom Empfänger
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

/** Offene Angebote: Status "offen" und nicht abgelaufen (abgelaufene bleiben "offen", gelten aber nicht mehr) */
const openFilter = () => ({ status: 'offen', expiresAt: { $gt: new Date() } });

module.exports = {
  openFilter,
  Trade: model('Trade', tradeSchema),
  TradeSettings: model('TradeSettings', settingsSchema),
};
