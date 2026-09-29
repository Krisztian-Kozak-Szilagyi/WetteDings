const { Schema, model } = require('mongoose');

const TYPES = ['janein', 'optionen'];
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

// Eine Antwortmöglichkeit. Nach dem Erstellen der Wette unveränderlich (nur "total" wächst).
const optionSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 10 }, // 'ja' | 'nein' | 'o1' … 'o10'
    label: { type: String, required: true, trim: true, maxlength: 60 },
    total: { type: Number, default: 0 }, // Summe der Einsätze in Cent
  },
  { _id: false }
);

const betSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    type: { type: String, enum: TYPES, default: 'janein' },
    options: {
      type: [optionSchema],
      validate: (v) => v.length >= MIN_OPTIONS && v.length <= MAX_OPTIONS,
    },
    creator: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    creatorName: { type: String, required: true },
    // Nur bei alten Wetten gesetzt: damals durfte der Ersteller noch mitwetten
    creatorSide: { type: String, default: null },
    // Provision des Erstellers in % vom Topf – beim Erstellen festgeschrieben (alte Wetten: 0)
    creatorFeePercent: { type: Number, default: 0, min: 0, max: 100 },
    creatorFee: { type: Number, default: 0 }, // tatsächlich ausgezahlte Provision in Cent
    // Einsatzschluss: danach sind keine Einsätze mehr möglich
    deadline: { type: Date, required: true },
    // Geplanter Termin der Auswertung (Ergebnisbekanntgabe) – nicht vor dem Einsatzschluss. Alte Wetten: null
    resultAt: { type: Date, default: null },
    status: { type: String, enum: ['offen', 'entschieden', 'annulliert'], default: 'offen' },
    outcome: { type: String, default: null }, // key der Gewinner-Option
    participants: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedByName: { type: String, default: null },
    voidReason: { type: String, default: null, maxlength: 300 },
    // Pflicht-Begründung beim Abschließen, damit das Ergebnis nachvollziehbar bleibt
    resolutionNote: { type: String, default: null, maxlength: 500 },
    // Änderungsverlauf von Titel/Beschreibung
    edits: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            byName: { type: String, required: true },
            field: { type: String, enum: ['title', 'description'], required: true },
            oldValue: { type: String, default: '' },
            newValue: { type: String, default: '' },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    // true, wenn trotz Entscheidung alle Einsätze erstattet wurden (z. B. keine Gegenseite)
    refunded: { type: Boolean, default: false },
  },
  { timestamps: true }
);

betSchema.index({ status: 1, deadline: 1 });
betSchema.index({ status: 1, resolvedAt: -1 });
betSchema.index({ createdAt: -1 });
betSchema.index({ updatedAt: -1 }); // für die Live-Aktualisierung der Übersicht

module.exports = model('Bet', betSchema);
module.exports.TYPES = TYPES;
module.exports.MIN_OPTIONS = MIN_OPTIONS;
module.exports.MAX_OPTIONS = MAX_OPTIONS;
