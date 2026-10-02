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
const groupService = require('./services/groupService');
const roles = require('./services/roles');
const betService = require('./services/betService');
const deviceService = require('./device/deviceService');
const { flash, loadUser, device, dailyBonus, csrf } = require('./middleware');

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
    betNewPublic: 0,
    betNewGroup: 0,
    newPacks: 0,
    patchNew: 0,
    packLogNew: 0,
    forumMine: 0,
    forumOther: 0,
    betVotePending: 0, // Wetten, in denen meine Stimme zum Ergebnis fehlt
    betDisputes: 0, // strittige Wetten (nur für Devs/Admins)
    deviceAlerts: 0, // Konten mit gemeinsamem Gerät (nur Admin)
    deviceProbe: false,
    roleBadge: roles.roleBadge,
    userLink: roles.userLink, // Name als Profil-Link samt Zusätzen // Abzeichen neben Namen (Admin rot, Dev grün)
    currentPath: '',
    flash: null,
    csrfToken: '',
  });

  app.use(flash);
  app.use(loadUser);
  app.use(device);
  app.use(dailyBonus);
  app.use(csrf);
  // Abzeichen im Menü. Alle Zähler laufen gleichzeitig – so kostet das pro Seitenaufruf nur die Dauer der
  // langsamsten Abfrage statt der Summe aller (die Datenbank liegt nicht auf diesem Server).
  app.use(async (req, res, next) => {
    if (req.user && req.method === 'GET') {
      const u = req.user;
      const [incoming, deals, marketNew, newPacks, patchNew, votePending, betNew, forumNew, disputes, packLogNew, deviceAlerts] = await Promise.all([
        tradeService.incomingCount(u._id), // Angebote an mich
        tradeService.newDealsCount(u), // abgeschlossene Geschäfte, von denen ich noch nichts weiß
        tradeService.marketNewCount(u), // neue Markt-Angebote seit dem letzten Besuch
        tcgService.newPackCount(u), // geschenkte Packs seit dem letzten Besuch der TCG-Seite
        forumService.patchNewCount(u), // Patchnotes seit dem letzten Lesen
        betService.pendingVoteCount(u._id), // Wetten, in denen meine Stimme zum Ergebnis fehlt
        // neue öffentliche Wetten und neue Wetten in den eigenen Gruppen seit dem letzten Besuch der Übersicht
        groupService.groupIdsOf(u._id).then((ids) => groupService.newBetCounts(u, ids)),
        forumService.navCounts(u), // Neues in eigenen Themen (rot) und im übrigen Forum
        u.isStaff ? betService.disputedCount() : 0, // nur Devs/Admins: strittige Wetten
        u.isAdmin ? require('./routes/admin').packLogNewCount(u) : 0, // nur Admin: Pack-Vergaben der Devs
        u.isAdmin ? deviceService.alertCount() : 0, // nur Admin: Konten, die sich ein Gerät teilen
      ]);
      Object.assign(res.locals, {
        tradeIncoming: incoming + deals,
        tradeMarketNew: marketNew,
        newPacks,
        patchNew,
        betVotePending: votePending,
        betNewPublic: betNew.pub,
        betNewGroup: betNew.group,
        forumMine: forumNew.mine,
        forumOther: forumNew.other,
        betDisputes: disputes,
        packLogNew,
        deviceAlerts,
      });
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
