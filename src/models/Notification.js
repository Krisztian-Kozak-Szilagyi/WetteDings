const { Schema, model } = require('mongoose');

// Benachrichtigung in der Glocke: bleibt ungelesen, bis das Mitglied sie öffnet oder als gelesen markiert.
// Gelesene verschwinden nach READ_DAYS Tagen von selbst (TTL-Index auf readAt; ungelesene haben readAt = null
// und laufen deshalb nie ab).
const READ_DAYS = 30;

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    area: { type: String, required: true }, // Überschrift in der Glocke, z. B. "Handel"
    text: { type: String, required: true, maxlength: 300 },
    href: { type: String, required: true }, // Ziel beim Anklicken (immer ein Pfad dieser Seite)
    // Gleichartige ungelesene Meldungen (z. B. mehrere Antworten im selben Thema) werden zu einer zusammengefasst
    key: { type: String, default: null },
    count: { type: Number, default: 1 },
    at: { type: Date, default: Date.now }, // zuletzt aktualisiert – danach wird sortiert
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, readAt: 1, at: -1 });
notificationSchema.index({ user: 1, key: 1 });
notificationSchema.index({ readAt: 1 }, { expireAfterSeconds: READ_DAYS * 24 * 60 * 60 });

module.exports = model('Notification', notificationSchema);
module.exports.READ_DAYS = READ_DAYS;
