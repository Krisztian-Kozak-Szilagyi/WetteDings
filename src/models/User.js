const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    username: { type: String, required: true, trim: true },
    usernameLower: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: { type: String, required: true },
    // Kontostand in Cent
    balance: { type: Number, required: true, min: 0 },
    // Tag (deutsche Zeit, "YYYY-MM-DD"), an dem zuletzt der Tagesbonus geprüft/gutgeschrieben wurde
    lastBonusDay: { type: String, default: null },
    // Zeitpunkt des letzten Besuchs der Handelsseite (für das Markt-Abzeichen im Menü)
    marketSeenAt: { type: Date, default: null },
    // Letzter Besuch der Wett-Übersicht (für die Abzeichen "neue Wetten")
    betsSeenAt: { type: Date, default: null },
    // bis wann abgeschlossene Geschäfte (Karte verkauft, Tausch angenommen) schon gesehen wurden
    dealsSeenAt: { type: Date, default: null },
    // Letzter Besuch der TCG-Seite bzw. der Patchnotes (für die Abzeichen "neue Packs" / "neue Patchnotes")
    packsSeenAt: { type: Date, default: null },
    patchSeenAt: { type: Date, default: null },
    // TCG: Karten-IDs, deren Duplikate nicht mitverkauft werden, und bis zu 4 Favoriten für die TCG-Seite
    tcgProtected: { type: [String], default: [] },
    tcgFavorites: { type: [String], default: [] },
    // Letzte Namensänderung (Wartezeit bis zur nächsten)
    usernameChangedAt: { type: Date, default: null },
    // Einwilligung in die Übermittlung der Chat-Nachrichten an den KI-Dienst (Support-Chat)
    supportConsentAt: { type: Date, default: null },
    // Echter Name (freiwillig) – erscheint in Klammern neben dem Benutzernamen
    realName: { type: String, default: null },
    // Rolle: 'dev' oder 'mod' (vom Admin ernannt) oder null. Der Admin selbst steht in ADMIN_USERNAMES.
    role: { type: String, enum: ['dev', 'mod', null], default: null },
    // Letzter Besuch des Forums (für die Abzeichen am Menüpunkt)
    forumSeenAt: { type: Date, default: null },
    // Admin: wann das Pack-Log zuletzt angesehen wurde (für das Abzeichen am Menüpunkt)
    packLogSeenAt: { type: Date, default: null },
    // Sperre durch den Admin: gesperrt, solange bannedUntil in der Zukunft liegt (dauerhaft = Jahr 9999).
    // Gilt auch für alle Geräte des Kontos (siehe src/device/deviceService.js). Grund, Zeitpunkt und Name des Admins
    // bleiben nach Ablauf oder Aufhebung stehen (Vermerk im Profil).
    bannedUntil: { type: Date, default: null },
    banReason: { type: String, default: '' },
    bannedAt: { type: Date, default: null },
    bannedByName: { type: String, default: null },
    // Sekunden auf Platz 1 der Rangliste (wird minütlich hochgezählt, siehe services/rankService)
    top1Seconds: { type: Number, default: 0 },
    // Gelöschtes Konto: nur noch eine leere Hülle mit neutralem Namen (siehe services/accountService)
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.index({ balance: -1 });

module.exports = model('User', userSchema);
