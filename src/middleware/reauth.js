// Zusätzliche Passwortabfrage für Moderations- und Spielwerte-Aktionen im Panel (Bannen, Packs und Karten
// vergeben, Preise ändern …). Das Formular schickt das Passwort im Feld "reauth_password" mit (der Dialog dazu
// steht in views/partials/reauth.ejs, die Logik im Browser in public/js/app.js). Nach zu vielen Fehlversuchen
// ist die Abfrage eine Weile gesperrt, damit niemand mit einer übernommenen Sitzung Passwörter durchprobiert.
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { str, isLocalUrl } = require('../lib/util');

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** Fehlversuche je Mitglied zählen und nach max Fehlversuchen für lockMs sperren (im Speicher des Servers) */
function createLimiter({ max = MAX_FAILS, lockMs = LOCK_MS } = {}) {
  const fails = new Map(); // userId -> { n, until }
  return {
    /** Restliche Sperrzeit in ms (0 = nicht gesperrt) */
    lockedFor(id, now = Date.now()) {
      const f = fails.get(id);
      return f && f.until > now ? f.until - now : 0;
    },
    /** Fehlversuch zählen; gibt die Zahl der noch erlaubten Versuche zurück (0 = jetzt gesperrt) */
    fail(id, now = Date.now()) {
      const prev = fails.get(id);
      const n = (prev && !(prev.until && prev.until <= now) ? prev.n : 0) + 1; // nach Ablauf einer Sperre neu zählen
      fails.set(id, { n, until: n >= max ? now + lockMs : 0 });
      return Math.max(0, max - n);
    },
    reset(id) {
      fails.delete(id);
    },
  };
}

const limiter = createLimiter();

/** Zurück zur Seite, von der das Formular kam (nur eigene Adressen), sonst fallback */
function backTo(req, fallback) {
  const ref = req.get('referer');
  if (!ref) return fallback;
  try {
    const url = new URL(ref);
    const path = url.pathname + url.search + url.hash;
    return url.host === req.get('host') && isLocalUrl(path) ? path : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Middleware: Aktion nur mit dem richtigen Passwort des angemeldeten Mitglieds ausführen.
 * fallback: Ziel der Weiterleitung, wenn die Abfrage scheitert und keine Herkunftsseite bekannt ist.
 */
function requireReauth(fallback = '/admin') {
  return async (req, res, next) => {
    const id = String(req.user._id);
    const password = str(req.body.reauth_password);
    delete req.body.reauth_password; // nicht weiterreichen
    const locked = limiter.lockedFor(id);
    if (locked) {
      req.flash('error', `Zu viele falsche Passwörter. Bitte warte ${Math.ceil(locked / 60000)} Minuten – die Aktion wurde nicht ausgeführt.`);
      return res.redirect(backTo(req, fallback));
    }
    const doc = password ? await User.findById(id).select('passwordHash').lean() : null;
    const ok = !!doc && (await bcrypt.compare(password, doc.passwordHash));
    if (!ok) {
      const left = password ? limiter.fail(id) : MAX_FAILS; // ohne Eingabe kein Fehlversuch
      req.flash(
        'error',
        password
          ? `Das Passwort ist falsch – die Aktion wurde nicht ausgeführt.${left ? ` Noch ${left} ${left === 1 ? 'Versuch' : 'Versuche'}.` : ' Die Abfrage ist jetzt 15 Minuten gesperrt.'}`
          : 'Bitte bestätige die Aktion mit deinem Passwort.'
      );
      return res.redirect(backTo(req, fallback));
    }
    limiter.reset(id);
    next();
  };
}

module.exports = { requireReauth, createLimiter, MAX_FAILS, LOCK_MS };
