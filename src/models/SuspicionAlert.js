const { Schema, model } = require('mongoose');

// Hinweis der Manipulationserkennung fürs Dev-Panel (siehe src/moderation/suspicionService.js): ein Mitglied (oder ein
// Konten-Paar bei Wertverschiebung) fällt durch ein Muster auf, das nach Skript oder Geldverschiebung aussieht.
// Nur ein Verdacht – gesperrt wird dadurch niemand.
const suspicionAlertSchema = new Schema(
  {
    // pro Muster und Konto genau ein Hinweis, z. B. "takt:oeffnen:<userId>" oder "wert:<a>:<b>"
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['tempo', 'takt', 'ihk', 'scalping', 'wert', 'dungeon', 'grading', 'dauer', 'browser', 'ertrag'], required: true },
    action: { type: String, default: null }, // bei tempo/takt: kaufen | oeffnen | verkaufen | broker | wetten
    users: { type: [Schema.Types.ObjectId], required: true },
    level: { type: Number, required: true }, // 2 = wahrscheinlich, 1 = möglich (wie bei den Mehrfach-Konten)
    summary: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} }, // Kennzahlen und Beispiele zur Anzeige
    from: { type: Date, default: null }, // Zeitraum der auffälligen Aktionen
    evidenceAt: { type: Date, required: true }, // letzte auffällige Aktion
    // als erledigt markiert; neue Belege danach oder eine höhere Stufe öffnen den Hinweis wieder
    doneAt: { type: Date, default: null },
    doneByName: { type: String, default: null },
  },
  { timestamps: true }
);
suspicionAlertSchema.index({ doneAt: 1, level: -1, evidenceAt: -1 });
suspicionAlertSchema.index({ users: 1 });

module.exports = model('SuspicionAlert', suspicionAlertSchema);
