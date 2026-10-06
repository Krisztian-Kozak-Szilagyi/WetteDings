const { Schema, model } = require('mongoose');

// Täglicher Börsenbericht (coin/reportService.js): ein Dokument pro Tag, _id = "YYYY-MM-DD" (deutsche Zeit).
// Hält Kennzahlen, Stimmung und den Sprung des BfW-TCG ETF fest (Anzeige nur im Admin-Panel).
const marketReportSchema = new Schema(
  {
    _id: { type: String }, // Tag
    status: { type: String, enum: ['laeuft', 'fertig'], default: 'laeuft' }, // 'laeuft' = gerade in Arbeit (Sperre gegen Doppellauf)
    at: { type: Date, required: true }, // Zeitpunkt der Auswertung
    rows: { type: Schema.Types.Mixed, default: [] }, // Kennzahlen: { key, label, value, avg, change, score, record }
    sentiment: { type: Number, default: 0 }, // gewichtete Stimmung −1 … +1
    records: { type: Number, default: 0 },
    log: { type: Number, default: 0 }, // Sprung als Log-Rendite
    change: { type: Number, default: 0 }, // Sprung relativ (z. B. 0.18 = +18 %)
    mood: { type: String, default: null },
    priceBefore: { type: Number, default: null },
    priceAfter: { type: Number, default: null },
    thread: { type: Schema.Types.ObjectId, ref: 'ForumThread', default: null },
  },
  { versionKey: false }
);

module.exports = model('MarketReport', marketReportSchema);
