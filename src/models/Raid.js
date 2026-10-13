const { Schema, model } = require('mongoose');

// Raid gegen Lucky Dio (src/raid). Ein Kampf wird nicht als Zustand gespeichert, sondern als geheimer Startwert und die
// Liste der Züge – der Server spielt ihn bei jedem Zug nach (src/raid/logic.replay). snap hält beim Start fest, mit
// welchen Werten gekämpft wird, damit Änderungen im Admin-Panel laufende Kämpfe nicht verändern.
const runSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    status: { type: String, enum: ['laeuft', 'sieg', 'niederlage', 'aufgegeben'], default: 'laeuft' },
    day: { type: String, required: true }, // "YYYY-MM-DD" deutsche Zeit (Versuche pro Tag)
    seed: { type: Number, required: true, select: false }, // nie an den Browser
    snap: { type: Schema.Types.Mixed, required: true, select: false }, // { spieler, boss, karten }
    actions: { type: [Schema.Types.Mixed], default: [], select: false },
    deckSize: Number, // spielbare Karten im Deck
    runde: { type: Number, default: 1 },
    bossHp: Number,
    bossMax: Number,
    reward: { geld: { type: Number, default: 0 }, dio: { type: Boolean, default: false } },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
runSchema.index({ user: 1, day: 1 });
runSchema.index({ user: 1, createdAt: -1 });
// Höchstens ein laufender Kampf je Mitglied (auch bei zwei gleichzeitigen Klicks auf „Kampf beginnen“)
runSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'laeuft' }, name: 'ein_laufender_raid' });

// Einstellungen (ein Dokument, _id "raid") – Werte und Regeln siehe src/raid/logic.js
const settingsSchema = new Schema({ _id: { type: String, default: 'raid' }, values: Schema.Types.Mixed, updatedByName: String }, { timestamps: true });

module.exports = { RaidRun: model('RaidRun', runSchema), RaidSettings: model('RaidSettings', settingsSchema) };
