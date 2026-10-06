const { Schema, model } = require('mongoose');

// Ein Gerät (genauer: ein Browser), mit dem ein Konto benutzt wurde. Dient nur dazu, Mehrfach-Konten
// zu erkennen und Sperren durchzusetzen (siehe src/device/deviceService.js).
const deviceSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // Zufällige Kennung aus dem Geräte-Cookie
  deviceId: { type: String, required: true },
  // Hash aus Browser-Merkmalen (erkennt das Gerät auch ohne Cookie wieder); null, solange nicht gemeldet
  fp: { type: String, default: null },
  // Die letzten IP-Adressen – nur als Hash, nie im Klartext
  ips: { type: [String], default: [] },
  // Kurzbeschreibung für die Anzeige, z. B. "Chrome · Windows"
  ua: { type: String, default: '' },
  firstAt: { type: Date, default: Date.now },
  lastAt: { type: Date, default: Date.now },
  // Zeitpunkte der letzten Anmeldungen mit diesem Gerät (höchstens MAX_LOGINS)
  logins: { type: [Date], default: [] },
});
deviceSchema.index({ user: 1, deviceId: 1 }, { unique: true });
deviceSchema.index({ deviceId: 1 });
deviceSchema.index({ fp: 1 });
deviceSchema.index({ ips: 1 }); // geteilte Netze erkennen (viele Konten an einer IP)

// Hinweis für den Admin: zwei Konten wurden vom selben Gerät benutzt
const deviceAlertSchema = new Schema(
  {
    // beide Nutzer-IDs sortiert, "a:b" – pro Paar gibt es genau einen Hinweis
    key: { type: String, required: true, unique: true },
    users: { type: [Schema.Types.ObjectId], required: true },
    // 3 = sicher (gleiches Geräte-Cookie), 2 = wahrscheinlich (gleicher Fingerabdruck und gleiche IP, nacheinander
    // benutzt), 1 = möglich (nur gleicher Fingerabdruck, oder parallel bzw. von vielen Konten im selben Netz, #89)
    level: { type: Number, required: true },
    // vom Admin als erledigt markiert; ein stärkerer Treffer öffnet den Hinweis wieder
    doneAt: { type: Date, default: null },
  },
  { timestamps: true }
);
deviceAlertSchema.index({ doneAt: 1, level: 1 });

module.exports = { Device: model('Device', deviceSchema), DeviceAlert: model('DeviceAlert', deviceAlertSchema) };
