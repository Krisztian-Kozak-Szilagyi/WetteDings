const { Schema, model } = require('mongoose');

// Grading-Shop eines Mitglieds (Mini-Game). _id = User-ID.
// Solange active = true, gibt es keinen Tagesbonus; kündigen geht erst ab lockedUntil.
const shopSchema = new Schema(
  {
    _id: Schema.Types.ObjectId,
    active: { type: Boolean, default: false },
    level: { type: Number, default: 1 }, // Ausbaustufe (bleibt nach einer Kündigung erhalten)
    hiredAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null }, // Vertragsbindung (10 Tage ab Annahme)
    jobsDone: { type: Number, default: 0 }, // Aufträge insgesamt
    earned: { type: Number, default: 0 }, // Lohn insgesamt in Cent
  },
  { timestamps: true }
);
shopSchema.index({ active: 1 });

// Ein Auftrag: Karte eines (erfundenen) Kunden reinigen, bewerten und versiegeln.
// Flecken und Mängel werden beim Annehmen ausgewürfelt; die echte Note kennt nur der Server.
const jobSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }, // "YYYY-MM-DD" (Bonustag, für das Tageslimit)
    level: { type: Number, required: true }, // Shop-Stufe beim Annehmen (bestimmt die Arbeitsschritte)
    card: { type: String, required: true }, // Karten-ID aus dem Katalog
    customer: { type: String, required: true },
    spots: { type: [new Schema({ side: String, x: Number, y: Number, r: Number, kind: String }, { _id: false })], default: [] },
    defects: {
      scratches: { type: [new Schema({ x: Number, y: Number, len: Number, angle: Number }, { _id: false })], default: [] },
      corners: { type: [Number], default: [] }, // 0 = oben links, 1 = oben rechts, 2 = unten rechts, 3 = unten links
      edges: { type: [new Schema({ side: Number, pos: Number }, { _id: false })], default: [] }, // side wie corners: 0 oben, 1 rechts, 2 unten, 3 links
      crease: { type: Boolean, default: false },
    },
    grade: { type: Number, required: true }, // echte Note 1–10
    status: { type: String, enum: ['offen', 'fertig'], default: 'offen' },
    guess: { type: Number, default: null }, // Note des Spielers
    clean: { type: Number, default: null }, // Sauberkeit beim Zurückschicken 0–100 %
    seal: { type: Number, default: null }, // Qualität der Versiegelung 0–100
    pay: { type: Number, default: 0 }, // Lohn in Cent
    doneAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Pro Mitglied höchstens ein offener Auftrag
jobSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'offen' } });
jobSchema.index({ user: 1, day: 1 });

// Admin-Einstellungen (ein Dokument, _id "grading")
const settingsSchema = new Schema(
  { _id: { type: String, default: 'grading' }, open: Boolean, jobs: Number, pay: { clean: Number, grade: Number, slab: Number }, costs: [Number], premium: Number, updatedByName: String },
  { timestamps: true }
);

module.exports = {
  GradingShop: model('GradingShop', shopSchema),
  GradingJob: model('GradingJob', jobSchema),
  GradingSettings: model('GradingSettings', settingsSchema),
};
