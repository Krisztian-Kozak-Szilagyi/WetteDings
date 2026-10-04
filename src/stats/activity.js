// Aktivität mitzählen (siehe models/UserActivity). Läuft neben der eigentlichen Anfrage her:
// Fehler werden nur ausgegeben und verzögern keine Seite.
const config = require('../config');
const UserActivity = require('../models/UserActivity');
const { toZonedLocalInput } = require('../lib/time');

// Bereich einer Seite nach dem ersten Pfadteil
const AREAS = {
  '': 'start',
  wetten: 'wetten',
  'wetten-stand': 'wetten',
  duell: 'wetten',
  gruppen: 'wetten',
  tcg: 'tcg',
  inventar: 'tcg',
  handel: 'handel',
  ihk: 'ihk',
  dungeon: 'ihk',
  grading: 'grading',
  'coin-exchange': 'coin',
  lotterie: 'lotterie',
  forum: 'forum',
  patchnotes: 'forum',
  profil: 'profil',
  rangliste: 'profil',
  konto: 'konto',
  support: 'support',
  admin: 'admin',
  regeln: 'info',
  'so-gehts': 'info',
};

/** Bereich zu einem Pfad, z. B. "/handel/tausch" → "handel" */
function areaOf(path) {
  const first = String(path || '/').split('/')[1] || '';
  return AREAS[first] || 'sonstiges';
}

/** Tag ("YYYY-MM-DD") und Stunde (0–23) in deutscher Zeit */
function dayAndHour(date = new Date()) {
  const local = toZonedLocalInput(date, config.timezone); // "YYYY-MM-DDTHH:mm"
  return { day: local.slice(0, 10), hour: Number(local.slice(11, 13)) };
}

/**
 * Zählt die Anfrage? Nur echte Seitenaufrufe und Formulare des Browsers – keine Hintergrund-Abfragen
 * (Live-Stand, Chat, Geräte-Meldung), die per fetch laufen.
 */
function isPageRequest(req) {
  if (req.method !== 'GET' && req.method !== 'POST') return false;
  const dest = req.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  return !req.xhr && req.accepts(['html', 'json']) === 'html'; // ältere Browser ohne Fetch-Metadaten
}

/** Aktivität festhalten. kind: 'view' | 'action' | 'login' */
function record(userId, kind, area = null, now = new Date()) {
  const { day, hour } = dayAndHour(now);
  const inc = { [kind === 'view' ? 'views' : kind === 'action' ? 'actions' : 'logins']: 1 };
  if (area) inc[`areas.${area}`] = 1;
  return UserActivity.updateOne(
    { user: userId, day },
    { $inc: inc, $addToSet: { hours: hour }, $set: { lastAt: now }, $setOnInsert: { firstAt: now } },
    { upsert: true }
  ).catch((err) => console.error('Aktivität konnte nicht gespeichert werden:', err.message));
}

/** Middleware: Seitenaufrufe und Formulare angemeldeter Mitglieder mitzählen */
function trackActivity(req, res, next) {
  if (req.user && isPageRequest(req)) record(req.user._id, req.method === 'GET' ? 'view' : 'action', areaOf(req.path));
  next();
}

module.exports = { AREAS, areaOf, dayAndHour, isPageRequest, record, trackActivity };
