const { Schema, model } = require('mongoose');

// Protokoll der Manipulationserkennung: jedes Urteil des Teams zu einem Hinweis (bestätigt, Fehlalarm, zurückgenommen)
// und jedes Wiederaufleben eines beurteilten Hinweises durch neue Belege – jeweils mit einer Kopie des Hinweises,
// wie er in diesem Moment aussah. Grundlage für die Trefferquote je Muster und Stufe und für die Auswertung der
// Schwellen (Export im Protokoll "Erkennungs-Urteile"). Bleibt dauerhaft erhalten, auch wenn der Hinweis selbst
// längst gelöscht ist; bei einer Kontolöschung werden die Einträge anonymisiert (suspicionService.forgetUser).
const suspicionVerdictSchema = new Schema(
  {
    alert: { type: Schema.Types.ObjectId, default: null }, // SuspicionAlert (kann inzwischen gelöscht sein)
    key: { type: String, required: true }, // Schlüssel des Hinweises, z. B. "dungeon:<userId>"
    // bestaetigt / fehlalarm / zurueckgenommen: vom Team; neue_belege: ein beurteilter Hinweis ist wieder aufgegangen
    event: { type: String, enum: ['bestaetigt', 'fehlalarm', 'zurueckgenommen', 'neue_belege'], required: true },
    byName: { type: String, default: null }, // wer geurteilt hat (null = Scan)
    // Kopie des Hinweises zum Zeitpunkt des Ereignisses
    kind: { type: String, required: true },
    action: { type: String, default: null },
    level: { type: Number, required: true }, // 2 = wahrscheinlich, 1 = möglich
    summary: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: {} }, // Kennzahlen – die Merkmale für die Auswertung
    from: { type: Date, default: null },
    evidenceAt: { type: Date, default: null },
    alertCreatedAt: { type: Date, default: null }, // seit wann der Hinweis bestand
    // Gesamtbewertung der Spieler-Gruppe in diesem Moment (suspicionLogic.overallRating)
    stage: { type: Number, default: null },
    stageLabel: { type: String, default: null },
    users: { type: [Schema.Types.ObjectId], default: [] },
    names: { type: [String], default: [] },
    anonymized: { type: Boolean, default: false }, // Konto gelöscht: Namen und IDs entfernt
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
suspicionVerdictSchema.index({ createdAt: -1 });
suspicionVerdictSchema.index({ key: 1, createdAt: -1 });
suspicionVerdictSchema.index({ users: 1 });

module.exports = model('SuspicionVerdict', suspicionVerdictSchema);
