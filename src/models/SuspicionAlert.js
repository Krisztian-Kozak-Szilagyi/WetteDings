const { Schema, model } = require('mongoose');

// Hinweis der Manipulationserkennung fürs Dev-Panel (siehe src/moderation/suspicionService.js): ein Mitglied (oder ein
// Konten-Paar bei Wertverschiebung) fällt durch ein Muster auf, das nach Skript oder Geldverschiebung aussieht.
// Nur ein Verdacht – gesperrt wird dadurch niemand.
const suspicionAlertSchema = new Schema(
  {
    // pro Muster und Konto genau ein Hinweis, z. B. "takt:oeffnen:<userId>" oder "wert:<a>:<b>"
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['tempo', 'takt', 'ihk', 'scalping', 'wert', 'dungeon', 'grading', 'dauer', 'browser', 'ertrag', 'reaktion', 'eingabe', 'falle', 'rechenzentrum', 'parallel', 'kreislauf', 'rang', 'netz', 'markt'], required: true },
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
    // Urteil beim Erledigen: bestätigt (war Manipulation) oder Fehlalarm – Grundlage für die Trefferquote je Muster.
    // Hinweise mit Urteil bleiben länger erhalten (suspicionService.KEEP_VERDICT_DAYS).
    verdict: { type: String, enum: ['bestaetigt', 'fehlalarm', null], default: null },
    verdictByName: { type: String, default: null },
    verdictAt: { type: Date, default: null },
    // was beurteilt wurde: Stufe und Zusammenfassung beim Urteil (neue Belege überschreiben summary später).
    // Die vollständige Kopie samt Kennzahlen steht im Urteils-Protokoll (models/SuspicionVerdict).
    verdictLevel: { type: Number, default: null },
    verdictSummary: { type: String, default: null },
    // Beurteilter Hinweis (ohne höhere Stufe) mit neuen Belegen: er öffnet sich nicht wieder, sondern zählt hier mit.
    // Offen für die Anzeige, solange repeatLastAt nach repeatSeenAt (Knopf "Gesehen") und nach dem Urteil liegt.
    repeatLastAt: { type: Date, default: null },
    repeatSeenAt: { type: Date, default: null },
    repeatCount: { type: Number, default: 0 }, // Auswertungen mit neuen Belegen seit dem Urteil
  },
  { timestamps: true }
);
suspicionAlertSchema.index({ doneAt: 1, level: -1, evidenceAt: -1 });
suspicionAlertSchema.index({ users: 1 });
suspicionAlertSchema.index({ verdictAt: -1 });

module.exports = model('SuspicionAlert', suspicionAlertSchema);
