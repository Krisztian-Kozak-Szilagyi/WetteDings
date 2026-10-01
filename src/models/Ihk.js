const { Schema, model } = require('mongoose');

// Eine IHK-Quest. Das Ergebnis wird beim Start ausgewürfelt und erst nach Ablauf gezeigt.
const runSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    quest: { type: String, required: true },
    difficulty: { type: Number, required: true },
    required: { type: Number, required: true },
    card: { type: String, required: true }, // Karten-ID
    cardDoc: { type: Schema.Types.ObjectId, ref: 'TcgCard', required: true }, // gesperrtes Exemplar
    boost: { type: String, default: null }, // Karte im Boost-Slot
    boostDoc: { type: Schema.Types.ObjectId, ref: 'TcgCard', default: null },
    abilities: {
      type: [new Schema({ key: String, label: String, text: String, fx: String, target: String, enemyFx: String }, { _id: false })],
      default: [],
    },
    freeze: { type: Number, default: 0 }, // Sekunden Stillstand der Deadline (Bloodlust)
    stats: { speed: Number, fia: Number, fis: Number, bwl: Number },
    day: { type: String, required: true }, // "YYYY-MM-DD" deutsche Zeit (Tageslimit)
    endsAt: { type: Date, required: true },
    ticks: { type: [new Schema({ t: Number, p: Number, crit: Boolean, fake: Boolean, ability: Boolean, destroy: Boolean }, { _id: false })], default: [] },
    total: { type: Number, required: true },
    success: { type: Boolean, required: true },
    reward: { type: Number, required: true }, // Cent (0 bei Misserfolg)
    status: { type: String, enum: ['laeuft', 'fertig'], default: 'laeuft' },
    collectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Pro Nutzer höchstens eine laufende Quest
runSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { status: 'laeuft' } });
runSchema.index({ user: 1, day: 1 });

// Die drei angebotenen Quests pro Nutzer (zufällig, jede Schwierigkeit höchstens einmal)
const stateSchema = new Schema({
  _id: Schema.Types.ObjectId,
  offers: { type: [new Schema({ quest: String, difficulty: Number }, { _id: false })], default: [] },
  rerollDay: { type: String, default: null }, // "YYYY-MM-DD" des letzten Neu-Würfelns (1× pro Tag)
});

// Admin-Einstellungen (ein Dokument, _id "ihk")
const settingsSchema = new Schema(
  { _id: { type: String, default: 'ihk' }, open: Boolean, dailyLimit: Number, durationMin: Number, durations: [Number], rewards: [Number], required: [Number], hybrid: { durations: [Number], rewards: [Number], required: [Number] }, updatedByName: String },
  { timestamps: true }
);

module.exports = {
  IhkRun: model('IhkRun', runSchema),
  IhkState: model('IhkState', stateSchema),
  IhkSettings: model('IhkSettings', settingsSchema),
};
