const crypto = require('crypto');
const config = require('../config');
const User = require('../models/User');

/** Einmalige Hinweise über eine Weiterleitung hinweg */
function flash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  req.flash = (type, message) => {
    req.session.flash = { type, message };
  };
  next();
}

/** Lädt den angemeldeten Nutzer (bei jeder Anfrage frisch, damit der Kontostand stimmt) */
async function loadUser(req, res, next) {
  req.user = null;
  res.locals.currentUser = null;
  res.locals.currentPath = req.path;
  if (req.session.userId) {
    const user = await User.findById(req.session.userId).select('-passwordHash').lean();
    if (user) {
      user.isAdmin = config.adminUsernames.includes(user.usernameLower);
      req.user = user;
      res.locals.currentUser = user;
    } else {
      delete req.session.userId;
    }
  }
  next();
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

module.exports = { flash, loadUser, requireLogin, csrf };
