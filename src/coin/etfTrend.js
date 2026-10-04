/**
 * Trend des BfW-TCG ETF aus der Aktivität der Seite.
 *
 * Jede echte Aktion eines Mitglieds (wetten, Coins/ETF handeln, Lose und Packs kaufen, Karten öffnen, Handel,
 * IHK, Grading, Dungeon, Forum …) wird stündlich gezählt (models/ActivityPulse). Reine Seitenaufrufe, Menü-Klicks,
 * Konto-Einstellungen und Admin-Aktionen zählen nicht. Damit ein Einzelner den Kurs nicht hochklicken kann,
 * zählt je Mitglied und Stunde höchstens USER_HOUR_CAP Aktionen.
 *
 * Alle 10 Minuten vergleicht die Engine die letzten 24 Stunden mit dem Durchschnitt der 7 Tage davor:
 * mehr aktive Mitglieder und mehr Aktionen → bullisch (Trend nach oben), weniger → bärisch.
 * Der Trend ist höchstens ±MAX_DRIFT pro Tag; der Kurs folgt ihm gleitend (über einige Stunden).
 */
const ActivityPulse = require('../models/ActivityPulse');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const USER_HOUR_CAP = 30;
const MAX_DRIFT = 0.09; // Log-Rendite pro Tag bei voller Stimmung (≈ ±9 %)
const STEEPNESS = 2.5; // wie schnell die Stimmung bei mehr/weniger Aktivität ausschlägt
const BASE_DAYS = 7;

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

/**
 * Stimmung (−1 … +1) und Trend aus aktueller und durchschnittlicher Aktivität (je 24 Stunden).
 * @param {{users: number, actions: number}} cur  letzte 24 Stunden
 * @param {{users: number, actions: number}|null} base  Durchschnitt der Vortage (null = noch keine Daten)
 */
function trendFrom(cur, base) {
  if (!base) return { sentiment: 0, mu: 0, score: 0 };
  const score = 0.5 * Math.log((cur.users + 1) / (base.users + 1)) + 0.5 * Math.log((cur.actions + 5) / (base.actions + 5));
  const sentiment = Math.tanh(STEEPNESS * score);
  return { sentiment, mu: sentiment * MAX_DRIFT, score };
}

/**
 * Fasst Stunden-Dokumente zu 24-Stunden-Fenstern zusammen: Fenster 0 = letzte 24 Stunden, 1 … BASE_DAYS = Tage davor.
 * Fenster, die vor der ersten erfassten Stunde beginnen, fehlen im Durchschnitt (die Zählung lief da noch nicht).
 */
function windowsFrom(docs, now, firstT) {
  const windows = [];
  for (let i = 0; i <= BASE_DAYS; i++) {
    const to = now - i * DAY;
    const from = to - DAY;
    const inWin = docs.filter((d) => d.t.getTime() >= from && d.t.getTime() < to);
    const users = new Set();
    let actions = 0;
    for (const d of inWin) {
      actions += d.n || 0;
      for (const u of d.users || []) users.add(String(u));
    }
    windows.push({ from, users: users.size, actions, complete: firstT !== null && from >= firstT - HOUR });
  }
  const cur = windows[0];
  const past = windows.slice(1).filter((w) => w.complete);
  const base = past.length
    ? { users: past.reduce((a, w) => a + w.users, 0) / past.length, actions: past.reduce((a, w) => a + w.actions, 0) / past.length }
    : null;
  return { cur, base };
}

/** Aktueller Trend für die Engine */
async function target(now = Date.now()) {
  const since = new Date(now - (BASE_DAYS + 1) * DAY);
  const [docs, first] = await Promise.all([
    ActivityPulse.find({ t: { $gte: since } }).lean(),
    ActivityPulse.findOne().sort({ t: 1 }).select('t').lean(),
  ]);
  const { cur, base } = windowsFrom(docs, now, first ? first.t.getTime() : null);
  return trendFrom(cur, base);
}

module.exports = { USER_HOUR_CAP, MAX_DRIFT, countsAsAction, record, trackPulse, trendFrom, windowsFrom, target };
