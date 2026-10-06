/**
 * Aktivität der Seite für den täglichen Börsenbericht (coin/reportService.js, Sprung des BfW-TCG ETF um 18:45 Uhr).
 *
 * Jede echte Aktion eines Mitglieds (wetten, Coins/ETF handeln, Lose und Packs kaufen, Karten öffnen, Handel,
 * IHK, Grading, Dungeon, Forum …) wird stündlich gezählt (models/ActivityPulse). Reine Seitenaufrufe, Menü-Klicks,
 * Konto-Einstellungen und Admin-Aktionen zählen nicht. Damit ein Einzelner nichts hochklicken kann,
 * zählt je Mitglied und Stunde höchstens USER_HOUR_CAP Aktionen.
 */
const ActivityPulse = require('../models/ActivityPulse');

const HOUR = 60 * 60 * 1000;
const USER_HOUR_CAP = 30;

// Nicht als Aktivität gezählt (erster Pfadteil bzw. ganze Pfade)
const IGNORED_AREAS = new Set(['admin', 'konto', 'support', 'geraet', 'benachrichtigungen', 'abmelden', 'anmelden', 'registrieren']);
const IGNORED_PATHS = new Set(['/dungeon/beute-gesehen']);

/** Zählt diese Anfrage als Aktivität? (POST eines angemeldeten Mitglieds, kein ausgenommener Bereich) */
function countsAsAction(method, path) {
  if (method !== 'POST') return false;
  const clean = String(path || '').split('?')[0].replace(/\/+$/, '');
  if (IGNORED_PATHS.has(clean)) return false;
  return !IGNORED_AREAS.has(clean.split('/')[1] || '');
}

// Zähler je Stunde und Mitglied im Speicher (für die Obergrenze); alte Stunden werden verworfen
let capHour = null;
let capCounts = new Map();

/** Eine Aktion festhalten (Fehler werden nur ausgegeben) */
function record(userId, now = new Date()) {
  const t = Math.floor(now.getTime() / HOUR) * HOUR;
  if (capHour !== t) {
    capHour = t;
    capCounts = new Map();
  }
  const key = String(userId);
  const n = capCounts.get(key) || 0;
  if (n >= USER_HOUR_CAP) return Promise.resolve();
  capCounts.set(key, n + 1);
  return ActivityPulse.updateOne({ t: new Date(t) }, { $inc: { n: 1 }, $addToSet: { users: userId } }, { upsert: true }).catch((err) =>
    console.error('ETF-Aktivität konnte nicht gespeichert werden:', err.message)
  );
}

/** Middleware: erfolgreiche Aktionen angemeldeter Mitglieder für den ETF mitzählen */
function trackPulse(req, res, next) {
  if (req.user && countsAsAction(req.method, req.path)) {
    const userId = req.user._id;
    res.on('finish', () => {
      const failed = res.statusCode >= 400 || (req.session && req.session.flash && req.session.flash.type === 'error');
      if (!failed) record(userId);
    });
  }
  next();
}

module.exports = { USER_HOUR_CAP, countsAsAction, record, trackPulse };
