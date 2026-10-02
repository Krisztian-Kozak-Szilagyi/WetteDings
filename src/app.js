const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const config = require('./config');
const viewHelpers = require('./lib/viewHelpers');
const { settings: ihkSettings } = require('./ihk/ihkService');
const tradeService = require('./trade/tradeService');
const tcgService = require('./tcg/tcgService');
const forumRoutes = require('./routes/forum');
const forumService = require('./forum/forumService');
const roles = require('./services/roles');
const { flash, loadUser, dailyBonus, csrf } = require('./middleware');

function createApp() {
  const app = express();

  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.disable('x-powered-by');
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Ohne HTTPS würde der Browser sonst CSS/JS auf https:// umbiegen
          'upgrade-insecure-requests': config.secureCookies ? [] : null,
        },
      },
      strictTransportSecurity: config.secureCookies,
    })
  );
  app.use(compression());
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));

  app.use(
    session({
      name: 'wettstube.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: MongoStore.create({
        client: mongoose.connection.getClient(),
        collectionName: 'sessions',
        ttl: 14 * 24 * 60 * 60,
        touchAfter: 24 * 60 * 60,
      }),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
        maxAge: 14 * 24 * 60 * 60 * 1000,
      },
    })
  );

  Object.assign(app.locals, viewHelpers, {
    appName: config.appName,
    assetVersion: Date.now().toString(36),
    minStake: config.minStake,
    startBalance: config.startBalance,
    autoVoidDays: config.autoVoidDays,
    creatorFeePercent: config.creatorFeePercent,
    bonusTiers: config.bonusTiers,
    bonusTime: config.bonusTime,
    lotteryTicketPrice: config.lotteryTicketPrice,
    lotteryTime: config.lotteryTime,
    supportEnabled: Boolean(config.groqApiKey),
    ihkOpen: () => ihkSettings.open, // IHK für alle freigegeben? (Admin-Panel)
    // Standardwerte, falls ein Fehler vor den Middlewares auftritt
    currentUser: null,
    tradeIncoming: 0,
    tradeMarketNew: 0,
    newPacks: 0,
    patchNew: 0,
    packLogNew: 0,
    forumMine: 0,
    forumOther: 0,
    roleBadge: roles.roleBadge,
    userLink: roles.userLink, // Name als Profil-Link samt Zusätzen // Abzeichen neben Namen (Admin rot, Dev grün)
    currentPath: '',
    flash: null,
    csrfToken: '',
  });

  app.use(flash);
  app.use(loadUser);
  app.use(dailyBonus);
  app.use(csrf);
  // Abzeichen im Menü: offene Angebote an mich und neue Markt-Angebote seit dem letzten Besuch
  app.use(async (req, res, next) => {
    if (req.user && req.method === 'GET') {
      [res.locals.tradeIncoming, res.locals.tradeMarketNew, res.locals.newPacks, res.locals.patchNew] = await Promise.all([
        // rot: Angebote an mich + abgeschlossene Geschäfte, von denen ich noch nichts weiß
        Promise.all([tradeService.incomingCount(req.user._id), tradeService.newDealsCount(req.user)]).then(([a, b]) => a + b),
        tradeService.marketNewCount(req.user),
        tcgService.newPackCount(req.user), // geschenkte Packs seit dem letzten Besuch der TCG-Seite
        forumService.patchNewCount(req.user), // Patchnotes seit dem letzten Lesen
      ]);
      // Forum: Neues in eigenen Themen (rot) und Neues im übrigen Forum
      const forumNew = await forumService.navCounts(req.user);
      res.locals.forumMine = forumNew.mine;
      res.locals.forumOther = forumNew.other;
      // nur für den Admin: Pack-Vergaben der Devs seit dem letzten Blick ins Log
      if (req.user.isAdmin) res.locals.packLogNew = await require('./routes/admin').packLogNewCount(req.user);
    }
    next();
  });

  app.use(require('./routes/pages'));
  app.use(forumRoutes);
  app.use(require('./routes/auth'));
  app.use(require('./routes/bets'));
  app.use(require('./routes/account'));
  app.use(require('./routes/admin'));
  app.use(require('./routes/coin'));
  app.use(require('./routes/lottery'));
  app.use(require('./routes/tcg'));
  app.use(require('./routes/support'));
  app.use(require('./routes/ihk'));
  app.use(require('./routes/trade'));

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Nicht gefunden',
      status: 404,
      message: 'Diese Seite gibt es leider nicht.',
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return;
    res.status(status).render('error', {
      title: 'Fehler',
      status,
      message: status >= 500 ? 'Da ist etwas schiefgelaufen. Bitte versuche es später erneut.' : err.message,
    });
  });

  return app;
}

module.exports = { createApp };
