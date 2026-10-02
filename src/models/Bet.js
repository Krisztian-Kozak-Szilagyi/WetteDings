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

// Stimme zum Ausgang einer Wette. Wettersteller und Schiedsrichter müssen übereinstimmen,
// sonst entscheidet ein Dev (siehe lib/verdict).
const VOTE_ROLES = ['creator', 'referee', 'dev', 'system'];

const voteSchema = new Schema(
  {
    role: { type: String, enum: VOTE_ROLES, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null beim System
    byName: { type: String, required: true },
    outcome: { type: String, required: true }, // key der Option oder 'annulliert'
    note: { type: String, default: '', maxlength: 500 },
    at: { type: Date, required: true },
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
    // Schiedsrichter: bestätigt das Ergebnis gemeinsam mit dem Ersteller (Pflicht bei neuen Wetten,
    // alte Wetten: null – dort entscheidet der Ersteller weiterhin allein)
    referee: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    refereeName: { type: String, default: null },
    // Abgegebene Stimmen zum Ausgang (je Rolle höchstens eine)
    votes: { type: [voteSchema], default: [] },
    // true, solange Ersteller und Schiedsrichter unterschiedliche Ergebnisse eingetragen haben
    disputed: { type: Boolean, default: false },
    // Wie das Ergebnis zustande kam
    resolvedVia: { type: String, enum: ['ersteller', 'einstimmig', 'dev', 'system', null], default: null },
    // Gesamtprovision in % vom Topf – beim Erstellen festgeschrieben (alte Wetten: 0).
    // Ersteller und Schiedsrichter teilen sie sich (siehe lib/payout → splitFee).
    creatorFeePercent: { type: Number, default: 0, min: 0, max: 100 },
    creatorFee: { type: Number, default: 0 }, // tatsächlich ausgezahlte Provision des Erstellers in Cent
    refereeFee: { type: Number, default: 0 }, // tatsächlich ausgezahlte Provision des Schiedsrichters in Cent
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
betSchema.index({ status: 1, disputed: 1 }); // Streitfälle im Dev-Panel
betSchema.index({ referee: 1, status: 1 });
betSchema.index({ status: 1, resolvedAt: -1 });
betSchema.index({ createdAt: -1 });
betSchema.index({ updatedAt: -1 }); // für die Live-Aktualisierung der Übersicht

module.exports = model('Bet', betSchema);
module.exports.TYPES = TYPES;
module.exports.MIN_OPTIONS = MIN_OPTIONS;
module.exports.MAX_OPTIONS = MAX_OPTIONS;
module.exports.VOTE_ROLES = VOTE_ROLES;
