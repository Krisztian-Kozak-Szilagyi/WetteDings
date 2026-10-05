const { Schema, model } = require('mongoose');

/**
 * Einmaliger Registrierungscode. Gilt die beim Erzeugen gewählte Zeit (30 Minuten bis 7 Tage) und für genau eine Registrierung.
 * Über den TTL-Index löscht MongoDB abgelaufene Codes automatisch (innerhalb ~1 Minute);
 * zusätzlich wird beim Einlösen immer auf expiresAt geprüft.
 */
const registrationCodeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true }, // normalisiert: 8 Zeichen, Großbuchstaben/Ziffern
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    usedByName: { type: String, default: null },
  },
  { timestamps: true }
);

registrationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('RegistrationCode', registrationCodeSchema);
