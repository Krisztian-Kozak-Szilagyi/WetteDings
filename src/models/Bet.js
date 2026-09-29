const { Schema, model } = require('mongoose');

const SIDES = ['ja', 'nein'];

const betSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    creator: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    creatorName: { type: String, required: true },
    creatorSide: { type: String, enum: SIDES, required: true },
    // Einsatzschluss: danach sind keine Einsätze mehr möglich
    deadline: { type: Date, required: true },
    status: { type: String, enum: ['offen', 'entschieden', 'annulliert'], default: 'offen' },
    outcome: { type: String, enum: [...SIDES, null], default: null },
    // Summen der Einsätze pro Seite in Cent
    totalJa: { type: Number, default: 0 },
    totalNein: { type: Number, default: 0 },
    participants: { type: Number, default: 0 },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedByName: { type: String, default: null },
    voidReason: { type: String, default: null, maxlength: 300 },
    // true, wenn trotz Entscheidung alle Einsätze erstattet wurden (z. B. keine Gegenseite)
    refunded: { type: Boolean, default: false },
  },
  { timestamps: true }
);

betSchema.index({ status: 1, deadline: 1 });
betSchema.index({ status: 1, resolvedAt: -1 });
betSchema.index({ createdAt: -1 });

module.exports = model('Bet', betSchema);
module.exports.SIDES = SIDES;
