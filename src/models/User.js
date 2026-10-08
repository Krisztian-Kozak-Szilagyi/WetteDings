const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    username: { type: String, required: true, trim: true },
    usernameLower: { type: String, required: true, unique: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: { type: String, required: true },
    // Passwort zurücksetzen (Admin-Panel → Team): Hash des Einmal-Codes und sein Ablauf (services/passwordReset.js).
    // mustChangePassword: nach der Anmeldung mit dem Code ist nur die Seite „Neues Passwort“ erreichbar.
    resetHash: { type: String, default: null },
    resetExpires: { type: Date, default: null },
    mustChangePassword: { type: Boolean, default: false },
    // Kontostand in Cent
    balance: { type: Number, required: true, min: 0 },
    debt: { type: Number, default: 0, min: 0 }, // offene Schulden in Cent (z. B. eSports-Konkurs), getilgt aus jeder Einnahme (debtService)
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
    // TCG: Karten-IDs, die man schon einmal besessen hat (auch nach Verkauf) – Album zeigt sie durchsichtig,
    // beim Packöffnen sind die übrigen "Neu". Fehlt das Feld (Altbestand), füllt es die Migration beim Start.
    tcgSeen: { type: [String], default: undefined },
    // TCG: Karten-IDs, die man selbst erbeutet hat – Pack, Dungeon-/Turm-Bosskarte, Black Market; nicht über Handel,
    // Duell oder Vergabe (#127). Zählt für den Erfolg „Der Archivar“. Fehlt das Feld, füllt es die Migration beim Start.
    tcgLooted: { type: [String], default: undefined },
    // Letzte Namensänderung (Wartezeit bis zur nächsten)
    usernameChangedAt: { type: Date, default: null },
    // Chat: Mitglieder, die einem nicht schreiben dürfen (und man ihnen nicht)
    chatBlocked: { type: [Schema.Types.ObjectId], default: [] },
    // Echter Name (freiwillig) – erscheint in Klammern neben dem Benutzernamen
    realName: { type: String, default: null },
    // Registrierung: benutzter Einladungscode und wer ihn erzeugt hat (für das Registrierungs-Protokoll).
    // Ältere Konten haben beides nicht – die Codes selbst löscht MongoDB nach Ablauf.
    registrationCode: { type: String, default: null },
    invitedByName: { type: String, default: null },
    // Über den Einladungslink eines Mitglieds registriert: wer eingeladen hat und welche Provision er dafür bekam
    // (packs = Booster Packs, withheld = Grund, falls keine, z. B. gleiches Gerät)
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    inviteReward: { type: new Schema({ packs: Number, withheld: String }, { _id: false }), default: undefined },
    // Rolle: 'dev' oder 'mod' (vom Admin ernannt) oder null. Der Admin selbst steht in ADMIN_USERNAMES.
    role: { type: String, enum: ['dev', 'mod', null], default: null },
    // Profil: selbst geschriebener Text (höchstens 300 Zeichen, siehe achievements/logic.cleanBio) und bis zu
    // zwei angeheftete Erfolge (Schlüssel aus src/achievements/list.js)
    bio: { type: String, default: '' },
    pinnedAchievements: { type: [String], default: [] },
    // Broker-Wert, den das Mitglied im Profil zeigt (Symbol aus src/coin/markets.js, z. B. "COW"), null = keiner
    profileAsset: { type: String, default: null },
    // Profilbild: ID aus src/profile/avatars.js (Logos nur Admin/Devs) oder ein gekaufter Avatar, null = Platzhalter
    avatar: { type: String, default: null },
    // Konfetti: Währung aus zerkleinerten Karten (ganze Einheiten, kein Geld), nur für Kosmetik
    konfetti: { type: Number, default: 0, min: 0 },
    // gekaufte Kosmetik, an das Konto gebunden: "avatar:anna" … (src/cosmetics/catalog.js)
    cosmetics: { type: [String], default: [] },
    // Profil-Statistik (Vermögen, Gewinn, Umsatz …): standardmäßig nur für einen selbst, auf Wunsch für alle Mitglieder
    statsPublic: { type: Boolean, default: false },
    // Letzter Besuch des Forums (für die Abzeichen am Menüpunkt)
    forumSeenAt: { type: Date, default: null },
    // Admin/Dev: bis wann Geschäfte zwischen Mehrfach-Konten gesehen wurden (Abzeichen am Menüpunkt)
    suspiciousSeenAt: { type: Date, default: null },
    // Admin: wann das Pack-Log zuletzt angesehen wurde (für das Abzeichen am Menüpunkt)
    packLogSeenAt: { type: Date, default: null },
    // Sperre durch den Admin: gesperrt, solange bannedUntil in der Zukunft liegt (dauerhaft = Jahr 9999).
    // Gilt auch für alle Geräte des Kontos (siehe src/device/deviceService.js). Grund, Zeitpunkt und Name des Admins
    // bleiben nach Ablauf oder Aufhebung stehen (Vermerk im Profil).
    bannedUntil: { type: Date, default: null },
    banReason: { type: String, default: '' },
    bannedAt: { type: Date, default: null },
    bannedByName: { type: String, default: null },
    bannedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // wer gebannt hat (Devs dürfen nur eigene Bans aufheben)
    // Alle Bans nacheinander (Profil zeigt jeden einzeln). liftedAt = vorzeitig aufgehoben oder durch einen neuen Ban ersetzt.
    // Fehlt bei Bans von vor 2026-10-04 – dann gilt nur der letzte Ban aus den Feldern oben (deviceLogic.banHistory).
    banHistory: {
      type: [new Schema({ at: Date, until: Date, byName: String, reason: String, liftedAt: { type: Date, default: null } }, { _id: false })],
      default: undefined,
    },
    // Sekunden auf Platz 1 der Rangliste (wird minütlich hochgezählt, siehe services/rankService)
    top1Seconds: { type: Number, default: 0 },
    // Gelöschtes Konto: nur noch eine leere Hülle mit neutralem Namen (siehe services/accountService)
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.index({ balance: -1 });
userSchema.index({ invitedBy: 1 }, { sparse: true });

module.exports = model('User', userSchema);
