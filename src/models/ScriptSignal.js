const { Schema, model } = require('mongoose');

// Hinweise darauf, dass Spiel-Aktionen nicht aus einem normalen Browser kommen (siehe moderation/requestSignals.js).
// Ein Dokument pro Mitglied und Tag (deutsche Zeit); die Manipulationserkennung wertet die letzten Tage aus.
const scriptSignalSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }, // "YYYY-MM-DD"
    actions: { type: Number, default: 0 }, // Spiel-Aktionen (POST) insgesamt
    noProbe: { type: Number, default: 0 }, // … aus einer Sitzung, in der die Seite nie ihren Fingerabdruck gemeldet hat
    noFetchMeta: { type: Number, default: 0 }, // … ohne die Sec-Fetch-Kopfzeilen, die jeder aktuelle Browser mitschickt
    bare: { type: Number, default: 0 }, // … beides zugleich (kein Fingerabdruck, keine Sec-Fetch-Kopfzeilen): typisch für Skripte
    webdriver: { type: Number, default: 0 }, // … aus einem ferngesteuerten Browser (navigator.webdriver)
    botUa: { type: Number, default: 0 }, // … mit einem User-Agent von Skript-Werkzeugen oder Headless-Browsern
    uas: { type: [String], default: [] }, // auffällige User-Agents (gekürzt, höchstens 3)
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
  },
  { versionKey: false }
);
scriptSignalSchema.index({ user: 1, day: 1 }, { unique: true });
scriptSignalSchema.index({ day: 1 });

module.exports = model('ScriptSignal', scriptSignalSchema);
