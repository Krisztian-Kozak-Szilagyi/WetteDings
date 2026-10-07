const { Schema, model } = require('mongoose');

// eSports-Team: Mitglieder spielen zusammen den Mage Tower; ab drei Mitgliedern wird sein ETF im Broker gehandelt.
// status: 'offen' (noch nie gehandelt) → 'aktiv' → 'eingefroren' (unter drei Mitgliedern, kein Kauf, kein Sprung)
// → 'aufgeloest' (Konkurs oder leer; Kürzel und Name bleiben vergeben, damit kein alter Kursverlauf weiterlebt).
const memberSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const teamSchema = new Schema(
  {
    name: { type: String, required: true },
    nameLower: { type: String, required: true, unique: true },
    ticker: { type: String, required: true, unique: true },
    captain: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: { type: [memberSchema], default: [] },
    invites: { type: [new Schema({ user: { type: Schema.Types.ObjectId, ref: 'User' }, name: String, at: { type: Date, default: Date.now } }, { _id: false })], default: [] },
    status: { type: String, enum: ['offen', 'aktiv', 'eingefroren', 'aufgeloest'], default: 'offen' },
    listedAt: { type: Date, default: null }, // erstmals gehandelt
    frozenAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    category: { type: Schema.Types.ObjectId, ref: 'ForumCategory', default: null }, // Unterbereich im Forum
    lastRank: { type: Number, default: null }, // Platz im letzten Wochenbericht
    lastOf: { type: Number, default: null },
    lastChange: { type: Number, default: null },
  },
  { timestamps: true }
);
// Ein Spieler ist in höchstens einem Team (auch über Dokumente hinweg)
teamSchema.index({ 'members.user': 1 }, { unique: true, partialFilterExpression: { 'members.user': { $exists: true } } });
teamSchema.index({ status: 1 });

// Wochenbericht der Liga (_id = Datum des Sonntags "YYYY-MM-DD"): läuft genau einmal
const weekSchema = new Schema(
  {
    _id: { type: String },
    status: { type: String, enum: ['laeuft', 'fertig'], default: 'laeuft' },
    from: { type: Date, default: null },
    to: { type: Date, default: null },
    rows: { type: [Schema.Types.Mixed], default: [] }, // { team, name, ticker, rank, of, score, change, priceBefore, priceAfter }
  },
  { timestamps: true }
);

module.exports = {
  EsportsTeam: model('EsportsTeam', teamSchema),
  EsportsWeek: model('EsportsWeek', weekSchema),
};
