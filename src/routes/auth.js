const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { registerUser } = require('../services/betService');
const { str, safeRedirect, UserError } = require('../lib/util');
const { normalizeCode } = require('../services/codeService');
const { NAME_PATTERN, NAME_HINT, RESERVED_HINT, isReserved } = require('../services/usernameRules');
const config = require('../config');
const deviceLogic = require('../device/deviceLogic');
const deviceService = require('../device/deviceService');
const { date } = require('../lib/viewHelpers');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    req.flash('error', 'Zu viele Versuche. Bitte warte ein paar Minuten.');
    res.redirect(req.originalUrl);
  },
});

// Vergleichs-Hash, damit ein unbekannter Benutzername nicht schneller antwortet
const DUMMY_HASH = bcrypt.hashSync('dummy-passwort', 12);

function startSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = String(userId);
      resolve();
    });
  });
}

// Hinweis nach dem Löschen des Kontos (die Sitzung gibt es dann nicht mehr, deshalb per Parameter)
router.use('/anmelden', (req, res, next) => {
  if (req.method === 'GET' && req.query.geloescht === '1' && !res.locals.flash) res.locals.flash = { type: 'success', message: 'Dein Konto wurde gelöscht.' };
  next();
});

router.get('/registrieren', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Registrieren', errors: [], values: {} });
});

router.post('/registrieren', authLimiter, async (req, res) => {
  const username = str(req.body.username).trim();
  const email = str(req.body.email).trim().toLowerCase();
  const password = str(req.body.password);
  const password2 = str(req.body.password2);
  const code = str(req.body.code).trim().slice(0, 20);

  const errors = [];
  if (normalizeCode(code).length !== 8) errors.push('Bitte gib einen gültigen Registrierungscode ein (Format: XXXX-XXXX).');
  if (!NAME_PATTERN.test(username)) errors.push(NAME_HINT);
  // Reservierte Namen (Admin-Namen tragen Rechte, "geloescht-…" täuscht ein gelöschtes Konto vor)
  else if (isReserved(username)) errors.push(RESERVED_HINT);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('Bitte gib eine gültige E-Mail-Adresse ein.');
  }
  if (password.length < 8 || password.length > 200) errors.push('Das Passwort muss mindestens 8 Zeichen lang sein.');
  if (password !== password2) errors.push('Die Passwörter stimmen nicht überein.');
  if (req.body.agree !== 'on') errors.push('Bitte bestätige, dass du die Regeln gelesen hast.');
  // Von einem gesperrten Gerät aus lässt sich kein neues Konto anlegen
  const deviceBan = req.deviceBan();
  if (deviceBan) errors.push(deviceService.banMessage(deviceBan, date));

  if (!errors.length) {
    try {
      const user = await registerUser({ username, email, password, code });
      await startSession(req, user._id);
      req.flash('success', `Willkommen, ${user.username}! Dein Startguthaben ist gutgeschrieben. Viel Spaß!`);
      return res.redirect('/');
    } catch (err) {
      if (err instanceof UserError) {
        errors.push(err.message);
      } else if (err && err.code === 11000) {
        errors.push(
          err.keyPattern && err.keyPattern.email
            ? 'Diese E-Mail-Adresse ist bereits registriert.'
            : 'Dieser Benutzername ist bereits vergeben.'
        );
      } else {
        throw err;
      }
    }
  }

  res.status(400).render('register', { title: 'Registrieren', errors, values: { username, email, code } });
});

router.get('/anmelden', (req, res) => {
  if (req.user) return res.redirect('/');
  // Das Ziel nach der Anmeldung merkt sich der Server in der Sitzung – es wird nicht aus dem Formular übernommen
  req.session.loginTarget = safeRedirect(req.query.weiter, '');
  res.render('login', { title: 'Anmelden', error: null, values: {}, weiter: req.session.loginTarget });
});

router.post('/anmelden', authLimiter, async (req, res) => {
  const login = str(req.body.login).trim().toLowerCase();
  const password = str(req.body.password);
  const weiter = safeRedirect(req.body.weiter, '/');

  const user = login ? await User.findOne(login.includes('@') ? { email: login } : { usernameLower: login }) : null;
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);

  if (!user || !ok) {
    return res.status(401).render('login', {
      title: 'Anmelden',
      error: 'Benutzername/E-Mail oder Passwort ist falsch.',
      values: { login: str(req.body.login) },
      weiter,
    });
  }

  // Gesperrtes Konto oder gesperrtes Gerät (der Admin kommt immer hinein)
  const ban = config.adminUsernames.includes(user.usernameLower) ? null : deviceService.userBan(user) || req.deviceBan();
  if (ban) {
    return res.status(403).render('login', { title: 'Anmelden', error: deviceService.banMessage(ban, date), values: { login: str(req.body.login) }, weiter });
  }

  const target = safeRedirect(req.session.loginTarget, '/'); // vor dem Sitzungswechsel lesen
  await startSession(req, user._id);
  req.flash('success', `Schön, dass du da bist, ${user.username}!`);
  res.redirect(target);
});

// Der Browser meldet einmal pro Sitzung seinen Fingerabdruck (public/js/device.js). "alt" ist die Geräte-Kennung
// aus dem lokalen Speicher: fehlt das Cookie (gelöscht), bekommt das Gerät damit seine alte Kennung zurück.
router.post('/geraet', async (req, res) => {
  const fp = deviceLogic.cleanFp(req.body.fp);
  if (fp) req.session.fp = fp;
  const alt = str(req.body.alt);
  const altId = deviceLogic.readToken(config.sessionSecret, alt);
  const restored = !!altId && altId !== req.deviceId;
  if (restored) req.setDeviceCookie(alt);
  if (req.user && req.deviceId) {
    req.session.deviceSeen = req.deviceId;
    try {
      await deviceService.record({ userId: req.user._id, deviceId: req.deviceId, fp: req.session.fp, ip: req.ipHash, ua: req.headers['user-agent'], login: restored });
    } catch (err) {
      console.error('Geräte-Erkennung fehlgeschlagen:', err);
    }
  }
  res.status(204).end();
});

router.post('/abmelden', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('wettstube.sid');
    res.redirect('/');
  });
});

module.exports = router;
