const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const config = require('./config');
const viewHelpers = require('./lib/viewHelpers');
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
    // Standardwerte, falls ein Fehler vor den Middlewares auftritt
    currentUser: null,
    currentPath: '',
    flash: null,
    csrfToken: '',
  });

  app.use(flash);
  app.use(loadUser);
  app.use(dailyBonus);
  app.use(csrf);

  app.use(require('./routes/pages'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/bets'));
  app.use(require('./routes/account'));
  app.use(require('./routes/admin'));
  app.use(require('./routes/coin'));
  app.use(require('./routes/lottery'));
  app.use(require('./routes/tcg'));
  app.use(require('./routes/support'));

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
