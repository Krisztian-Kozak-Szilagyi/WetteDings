// Urteils-Protokoll für die Mehrfach-Konten-Erkennung: schreibt dieselben Einträge (models/SuspicionVerdict) wie die
// Manipulationserkennung, mit kind "mehrfachkonto" und dem Schlüssel "geraet:<Paar>". So erscheinen Urteile zu
// Konten-Paaren im Protokoll "Erkennungs-Urteile" und in der Trefferquote. Eigene Datei, damit deviceService
// (Hinweise neu bewerten) und suspicionService (Urteile) sich nicht gegenseitig einbinden müssen.
const User = require('../models/User');
const SuspicionVerdict = require('../models/SuspicionVerdict');
const logic = require('./deviceLogic');

const KIND = 'mehrfachkonto';
const keyOf = (alert) => 'geraet:' + alert.key;

/**
 * Ereignis (bestaetigt, fehlalarm, zurueckgenommen, neue_belege) mit einer Kopie des Hinweises ins Protokoll schreiben.
 * alert: DeviceAlert (lean oder Dokument). Ein Fehler hier darf das Urteil selbst nicht verhindern.
 */
async function logEvent(alert, event, byName = null) {
  try {
    const users = await User.find({ _id: { $in: alert.users } }).select('username createdAt bannedUntil').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const names = alert.users.map((id) => (byId.get(String(id)) || {}).username || 'unbekannt');
    const label = logic.LEVEL_LABEL[alert.level] || String(alert.level);
    await SuspicionVerdict.create({
      alert: alert._id,
      key: keyOf(alert),
      event,
      byName,
      kind: KIND,
      level: alert.level,
      summary: `Konten ${names.join(' ↔ ')} nutzen dasselbe Gerät (${label})`,
      details: {
        levelLabel: label,
        accountAgeDays: alert.users.map((id) => {
          const u = byId.get(String(id));
          return u && u.createdAt ? Math.floor((Date.now() - new Date(u.createdAt).getTime()) / 86400000) : null;
        }),
        banned: alert.users.map((id) => logic.isBanned(byId.get(String(id)) || {})),
      },
      evidenceAt: alert.updatedAt || null,
      alertCreatedAt: alert.createdAt || null,
      users: alert.users,
      names,
    });
  } catch (err) {
    console.error('Urteils-Protokoll (Mehrfach-Konten) fehlgeschlagen:', err.message);
  }
}

module.exports = { KIND, keyOf, logEvent };
