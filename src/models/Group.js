const { Schema, model } = require('mongoose');

// Wett-Gruppe: Wetten in einer Gruppe sehen nur ihre Mitglieder. Der Ersteller lädt ein und entfernt;
// jedes Mitglied kann selbst austreten (Mein Konto).
const groupSchema = new Schema(
  {
    name: { type: String, required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ownerName: { type: String, required: true },
    members: { type: [Schema.Types.ObjectId], default: [] }, // inklusive Ersteller
    // Aufgelöste Gruppe: verschwindet aus Auswahl und Verwaltung, bleibt aber bestehen, damit die
    // bisherigen Mitglieder die alten Wetten der Gruppe weiterhin ansehen können.
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);
groupSchema.index({ members: 1 });
groupSchema.index({ owner: 1 });

module.exports = model('Group', groupSchema);
