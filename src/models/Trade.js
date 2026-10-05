const { Schema, model } = require('mongoose');

// Nachricht in der Verhandlung eines Angebots. from = Rolle im Angebot ('seller' | 'to') oder 'system'
// (Bedingungen geändert). Namen werden beim Anzeigen aus sellerName/toName genommen – so bleiben sie
// nach einer Umbenennung aktuell.
const messageSchema = new Schema(
  {
    from: { type: String, enum: ['seller', 'to', 'system'], required: true },
    text: { type: String, required: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Position eines Angebots (src/trade/lines.js): eine Karte oder ein Gegenstand ("item:<Art>")
const lineSchema = new Schema(
  {
    card: { type: String, required: true },
    copy: { type: Schema.Types.ObjectId, ref: 'TcgCard', default: null }, // ein bestimmtes foliertes Exemplar wird verlangt
    doc: { type: Schema.Types.ObjectId, default: null }, // gesperrtes Exemplar (TcgCard bzw. Item), sobald der Besitzer zugesagt hat
    foiledAt: { type: Date, default: null }, // Exemplar ist foliert (seit) – zur Anzeige
    grade: { type: Number, default: null }, // dessen Note auf der Folie (#73)
  },
  { _id: false }
);

// Handel (#76, #82): Der Anbieter (seller) gibt give, der Empfänger (to) gibt want, dazu fließt Geld (price)
// von extraFrom an die andere Seite. Ohne Empfänger ist es ein Markt-Angebot für alle (nur gegen Geld);
// ein Gegenangebot darauf ist ein eigenes Angebot mit listing = Markt-Angebot (seller = Verkäufer, to = Interessent).
const tradeSchema = new Schema(
  {
    kind: { type: String, enum: ['privat', 'markt', 'tausch'], required: true }, // Kategorie für Steuer und Statistik (lines.kindOf)
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // Anbieter
    sellerName: { type: String, required: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // Empfänger; null = Markt-Angebot
    toName: { type: String, default: null },
    listing: { type: Schema.Types.ObjectId, ref: 'Trade', default: null }, // Gegenangebot auf dieses Markt-Angebot
    give: { type: [lineSchema], default: [] },
    want: { type: [lineSchema], default: [] },
    extraFrom: { type: String, enum: ['seller', 'to', null], default: null }, // wer das Geld zahlt
    price: { type: Number, required: true }, // Cent, 0 erlaubt (Tausch ohne Aufpreis)
    // Exemplare, die dieses Angebot sperrt (lines.lockDocsOf); fehlt, wenn es keine sperrt
    lockDocs: { type: [Schema.Types.ObjectId], default: undefined },
    // Verhandlung: wer die aktuellen Bedingungen zuletzt gesetzt hat – annehmen darf nur die andere Seite
    lastChangeBy: { type: String, enum: ['seller', 'to'], default: 'seller' },
    termsVersion: { type: Number, default: 0 }, // steigt bei jeder Änderung; Annehmen veralteter Bedingungen wird abgelehnt
    messages: { type: [messageSchema], default: [] },
    activityAt: { type: Date, default: null }, // letzte Nachricht oder Änderung
    sellerSeenAt: { type: Date, default: null }, // zuletzt gelesen vom Anbieter
    toSeenAt: { type: Date, default: null }, // zuletzt gelesen vom Empfänger
    status: { type: String, enum: ['offen', 'verkauft', 'abgelehnt', 'zurueckgezogen'], default: 'offen' },
    expiresAt: { type: Date, required: true },
    buyer: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // Gegenseite beim Abschluss (Käufer bzw. Empfänger)
    buyerName: { type: String, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // wer gekauft bzw. angenommen hat – die andere Seite wird benachrichtigt
    closedVia: { type: Schema.Types.ObjectId, ref: 'Trade', default: null }, // Markt-Angebot: über dieses Gegenangebot abgeschlossen
    taxPercent: { type: Number, default: 0 },
    tax: { type: Number, default: 0 }, // Cent
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
tradeSchema.index({ status: 1, kind: 1, expiresAt: 1 });
tradeSchema.index({ to: 1, status: 1 });
tradeSchema.index({ seller: 1, status: 1 });
tradeSchema.index({ listing: 1, status: 1 });
tradeSchema.index({ buyer: 1, closedAt: -1 }); // Protokolle: Geschäfte eines Spielers
// Ein Exemplar kann nur in einem offenen Angebot gesperrt sein
tradeSchema.index({ lockDocs: 1 }, { unique: true, partialFilterExpression: { status: 'offen', lockDocs: { $exists: true } } });

// Admin-Einstellungen: _id "steuer" = Steuersätze je Bereich (services/taxService); "handel" = alte einheitliche Handelssteuer
const settingsSchema = new Schema({ _id: { type: String, default: 'handel' }, taxPercent: Number, rates: { markt: Number, privat: Number, tausch: Number, coin: Number, etf: Number }, updatedByName: String }, { timestamps: true });

/** Offene Angebote: Status "offen" und nicht abgelaufen (abgelaufene bleiben "offen", gelten aber nicht mehr) */
const openFilter = () => ({ status: 'offen', expiresAt: { $gt: new Date() } });

module.exports = {
  openFilter,
  Trade: model('Trade', tradeSchema),
  TradeSettings: model('TradeSettings', settingsSchema),
};
