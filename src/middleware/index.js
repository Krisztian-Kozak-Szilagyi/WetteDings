const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');
const { maybeGrantDailyBonus } = require('../services/bonusService');
const { date } = require('../lib/viewHelpers');
const deviceLogic = require('../device/deviceLogic');
const deviceService = require('../device/deviceService');
const passwordReset = require('../services/passwordReset');

const DEVICE_COOKIE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

// Erfolgsmeldungen (grün) gibt es nur noch bei Admin-/Moderationsaktionen. Bei allem anderen soll die Seite
// selbst zeigen, dass es geklappt hat (Krisztians Wunsch) – Fehler und Hinweise kommen weiter.
const STAFF_SUCCESS = /^\/(admin(\/|$)|forum\/bereiche(\/|$)|forum\/t\/[^/]+\/verschieben$)/;
const keepsFlash = (type, path) => type !== 'success' || STAFF_SUCCESS.test(path);

/** Einmalige Hinweise über eine Weiterleitung hinweg */
function flash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  req.flash = (type, message) => {
    if (keepsFlash(type, String(req.originalUrl || '').split('?')[0])) req.session.flash = { type, message };
  };
  next();
}

/** Lädt den angemeldeten Nutzer (bei jeder Anfrage frisch, damit der Kontostand stimmt) */
async function loadUser(req, res, next) {
  req.user = null;
  res.locals.currentUser = null;
  res.locals.currentPath = req.path;
  if (req.session.userId) {
    const user = await User.findById(req.session.userId).select('-passwordHash -resetHash').lean();
    if (user && !user.deletedAt) {
      user.isAdmin = config.adminUsernames.includes(user.usernameLower);
      user.isDev = user.role === 'dev';
      user.isMod = user.role === 'mod';
      user.isStaff = user.isAdmin || user.isDev; // Admin oder Dev
      user.canModerate = user.isStaff || user.isMod; // Forum und Kommentare moderieren
      req.user = user;
      res.locals.currentUser = user;
    } else {
      delete req.session.userId;
    }
  }
  next();
}

/**
 * Geräte-Erkennung und Sperren: liest bzw. setzt das Geräte-Cookie, wirft gesperrte Konten und Geräte hinaus
 * und hält pro Sitzung einmal fest, mit welchem Gerät das Konto benutzt wird.
 */
async function device(req, res, next) {
  const wanted = !!req.user || req.path === '/anmelden' || req.path === '/registrieren';
  req.deviceId = deviceLogic.readToken(config.sessionSecret, deviceLogic.cookieValue(req.headers.cookie, deviceLogic.COOKIE));
  req.setDeviceCookie = (token) => {
    res.cookie(deviceLogic.COOKIE, token, { maxAge: DEVICE_COOKIE_MS, sameSite: 'lax', secure: config.secureCookies, path: '/' });
    req.deviceId = deviceLogic.readToken(config.sessionSecret, token);
  };
  if (!req.deviceId && wanted) req.setDeviceCookie(deviceLogic.newToken(config.sessionSecret));
  req.ipHash = deviceLogic.ipHash(config.sessionSecret, req.ip);
  // Der Browser meldet seinen Fingerabdruck einmal pro Sitzung (public/js/device.js)
  res.locals.deviceProbe = wanted && !req.session.fp;
  try {
    await deviceService.ensureFresh();
    /** Sperre für dieses Gerät – für Anmeldung und Registrierung */
    req.deviceBan = () => deviceService.blockedDevice({ deviceId: req.deviceId, fp: req.session.fp, ip: req.ipHash });
    if (req.user && !req.user.isAdmin) {
      const ban = deviceService.userBan(req.user) || req.deviceBan();
      if (ban) {
        delete req.session.userId;
        req.user = null;
        res.locals.currentUser = null;
        req.flash('error', deviceService.banMessage(ban, date));
        return res.redirect('/anmelden');
      }
    }
    if (req.user && req.deviceId && req.session.deviceSeen !== req.deviceId) {
      req.session.deviceSeen = req.deviceId;
      await deviceService.record({ userId: req.user._id, deviceId: req.deviceId, fp: req.session.fp, ip: req.ipHash, ua: req.headers['user-agent'] });
    }
  } catch (err) {
    // Die Geräte-Erkennung darf die Seite nicht blockieren
    console.error('Geräte-Erkennung fehlgeschlagen:', err);
    if (!req.deviceBan) req.deviceBan = () => null;
  }
  next();
}

/** Tagesbonus beim ersten Seitenaufruf des Tages gutschreiben */
async function dailyBonus(req, res, next) {
  if (!req.user || req.method !== 'GET') return next();
  try {
    const granted = await maybeGrantDailyBonus(req.user);
    if (granted) {
      // Kontostand oben sofort aktuell; keine Meldung (Krisztian: keine grünen Bestätigungen) – die Buchung steht im Kontoauszug
      req.user.balance = granted.balance;
      req.user.lastBonusDay = require('../services/bonusService').today(); // Dashboard: „Tagesbonus gutgeschrieben“
    }
  } catch (err) {
    // Ein Fehler beim Bonus darf die Seite nicht blockieren
    console.error('Tagesbonus fehlgeschlagen:', err);
  }
  next();
}

/** Nach der Anmeldung mit einem Einmal-Code: bis zum neuen Passwort nur die Seite „Neues Passwort“ */
function forcePasswordChange(req, res, next) {
  if (!req.user || !req.user.mustChangePassword || passwordReset.allowedWhileForced(req.path)) return next();
  if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.redirect(passwordReset.CHANGE_PATH);
  res.status(403).json({ error: 'Bitte wähle zuerst ein neues Passwort.' });
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') {
    return res.redirect(`/anmelden?weiter=${encodeURIComponent(req.originalUrl)}`);
  }
  req.flash('info', 'Bitte melde dich zuerst an.');
  return res.redirect('/anmelden');
}

/** CSRF-Schutz: Token pro Sitzung, muss in jedem POST-Formular als _csrf mitgeschickt werden */
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;

  if (req.method === 'POST') {
    const sent = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
    const a = Buffer.from(sent);
    const b = Buffer.from(req.session.csrfToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      const err = new Error('Das Formular ist abgelaufen. Bitte lade die Seite neu und versuche es noch einmal.');
      err.status = 403;
      return next(err);
    }
  }
  next();
}

/** Nur für Admins (ADMIN_USERNAMES). Andere bekommen eine 404, damit das Panel nicht auffällt. */
function requireAdmin(req, res, next) {
  if (!req.user) return requireLogin(req, res, next);
  if (!req.user.isAdmin) return next('route');
  next();
}

/** Für Admin und Devs (Dev-Panel, Packs vergeben, Patchnotes). Andere bekommen eine 404. */
function requireStaff(req, res, next) {
  if (!req.user) return requireLogin(req, res, next);
  if (!req.user.isStaff) return next('route');
  next();
}

module.exports = { flash, keepsFlash, loadUser, device, dailyBonus, forcePasswordChange, requireLogin, requireAdmin, requireStaff, csrf };
