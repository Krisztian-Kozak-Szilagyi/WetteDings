const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const config = require('./config');
const viewHelpers = require('./lib/viewHelpers');
const { settings: ihkSettings } = require('./ihk/ihkService');
const tradeService = require('./trade/tradeService');
const tcgService = require('./tcg/tcgService');
const itemService = require('./items/itemService');
const forumRoutes = require('./routes/forum');
const forumService = require('./forum/forumService');
const groupService = require('./services/groupService');
const roles = require('./services/roles');
const betService = require('./services/betService');
const deviceService = require('./device/deviceService');
const suspicionService = require('./moderation/suspicionService');
const notifyService = require('./services/notifyService');
const achievementService = require('./achievements/achievementService');
const giftService = require('./services/giftService');
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
  // Cursor-Bilder immer lange zwischenspeichern: sonst zeigt der Browser nach jedem Seitenwechsel kurz den System-Cursor,
  // bis das Bild neu geprüft ist
  app.use('/img/cursors', express.static(path.join(__dirname, '..', 'public', 'img', 'cursors'), { maxAge: '30d' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use(require('./routes/cardImage')); // Rahmen-Karten als SVG, ebenfalls ohne Session
  app.use(require('./routes/achievementImage')); // Symbole der Erfolge als SVG
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
    dailyBonus: () => require('./services/bonusService').settings.amount, // Tagesbonus (Admin-Panel)
    gradingOpen: () => require('./grading/gradingService').settings.open, // Grading-Shop für alle freigegeben?
    bonusTime: config.bonusTime,
    lotteryTicketPrice: () => require('./services/lotteryService').ticketPrice('taeglich'), // Admin-Panel
    lotteryTime: config.lotteryTime,
    supportEnabled: Boolean(config.groqApiKey),
    ihkOpen: () => ihkSettings.open, // IHK für alle freigegeben? (Admin-Panel)
    dungeonOpen: () => require('./dungeon/dungeonService').settings.open, // Dungeon für alle freigegeben?
    esportsOpen: (user) => !!user && require('./dungeon/dungeonService').towerOpen(user), // eSports hängt am Mage Tower
    blackMarketOpen: () => require('./tcg/blackMarket').windowAt().open, // lila Punkt neben „Handel“
    // Standardwerte, falls ein Fehler vor den Middlewares auftritt
    currentUser: null,
    tradeIncoming: 0,
    tradeMarketNew: 0,
    betNewPublic: 0,
    betNewGroup: 0,
    newPacks: 0,
    newItems: 0,
    patchNew: 0,
    packLogNew: 0,
    forumMine: 0,
    forumOther: 0,
    betVotePending: 0, // Wetten, in denen meine Stimme zum Ergebnis fehlt
    betDisputes: 0, // strittige Wetten (nur für Devs/Admins)
    deviceAlerts: 0, // Konten mit gemeinsamem Gerät (nur Admin)
    tradeAlerts: 0, // Geschäfte zwischen Mehrfach-Konten (Admin und Devs)
    suspicionAlerts: 0, // Spieler mit Gesamtbewertung ab "Verdacht" (Manipulationserkennung, Admin und Devs)
    suspicionRepeats: 0, // beurteilte Fälle, die erneut aufgetreten sind und noch nicht auf "Gesehen" stehen (dezentes Abzeichen)
    bellNotes: [], // Glocke: Benachrichtigungen (ungelesene und die neuesten gelesenen)
    bellUnread: 0,
    deviceProbe: false,
    roleBadge: roles.roleBadge,
    userLink: roles.userLink, // Name als Profil-Link samt Zusätzen // Abzeichen neben Namen (Admin rot, Dev grün)
    currentPath: '',
    flash: null,
    csrfToken: '',
  });

  // Allgemeine Bremse gegen Überlastung: höchstens 600 Anfragen pro Minute – je angemeldetem Mitglied, sonst je
  // IP-Adresse (im Schulnetz teilen sich viele eine IP, deshalb zählt bei Angemeldeten das Konto). Bilder, CSS
  // und Skripte sind davon nicht betroffen (sie werden weiter oben ausgeliefert).
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => (req.session && req.session.userId ? `u:${req.session.userId}` : rateLimit.ipKeyGenerator ? rateLimit.ipKeyGenerator(req.ip) : req.ip),
      message: 'Zu viele Anfragen. Bitte warte einen Moment.',
    })
  );

  app.use(flash);
  app.use(loadUser);
  app.use(device);
  app.use(dailyBonus);
  app.use(require('./services/debtService').collectMiddleware); // offene Schulden zuerst tilgen – vor jeder Aktion
  app.use(csrf);
  // Neuer Erfolg? app.js fragt alle paar Sekunden – deshalb vor Statistik und Menü-Abzeichen (nur eine kleine Abfrage)
  app.get('/erfolge/neu', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ popup: null });
    res.json({ popup: achievementService.popupJson(await achievementService.nextUnseen(req.user._id), app.locals.assetVersion) });
  });
  // Geschenk vom Team? Gleiches Prinzip wie bei den Erfolgen (app.js fragt nach)
  app.get('/geschenke/neu', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ popup: null });
    res.json({ popup: giftService.popup(await giftService.nextUnseen(req.user._id)) });
  });
  app.use(require('./moderation/requestSignals').trackSignals); // Manipulationserkennung: Herkunft und Merkmale jeder Spiel-Aktion
  app.use(require('./moderation/requestSignals').trap); // Manipulationserkennung: unsichtbarer Link als Falle
  app.use(require('./stats/activity').trackActivity); // aktive Spieler und Bereichsnutzung für die Statistik
  app.use(require('./coin/etfTrend').trackPulse); // Aktionen der Mitglieder bewegen den BfW-TCG ETF
  // Nach jeder erfolgreichen Aktion (POST) kurz darauf prüfen, ob jemand einen neuen Erfolg erreicht hat
  app.use((req, res, next) => {
    if (req.user && req.method === 'POST') res.on('finish', () => res.statusCode < 400 && achievementService.soon());
    next();
  });
  // Abzeichen im Menü. Alle Zähler laufen gleichzeitig – so kostet das pro Seitenaufruf nur die Dauer der
  // langsamsten Abfrage statt der Summe aller (die Datenbank liegt nicht auf diesem Server).
  // Nur bei echten Seitenaufrufen: Hintergrund-Abfragen (Kurse, Live-Stand, Dungeon alle paar Sekunden) brauchen kein Menü.
  app.use(async (req, res, next) => {
    if (req.user && req.method === 'GET' && require('./stats/activity').isPageRequest(req)) {
      const u = req.user;
      const [incoming, deals, marketNew, newPacks, newItems, patchNew, votePending, betNew, forumNew, disputes, packLogNew, deviceAlerts, tradeAlerts, suspicionAlerts, suspicionRepeats, bell, achPopup, giftPopup] = await Promise.all([
        tradeService.incomingCount(u._id), // Angebote an mich
        tradeService.newDealsCount(u), // abgeschlossene Geschäfte, von denen ich noch nichts weiß
        tradeService.marketNewCount(u), // neue Markt-Angebote seit dem letzten Besuch
        tcgService.newPackCount(u), // geschenkte Packs seit dem letzten Besuch des Inventars
        itemService.newItemCount(u), // neue Gegenstände (z. B. Folie) seit dem letzten Besuch des Inventars – leuchtender Punkt an TCG
        forumService.patchNewCount(u), // Patchnotes seit dem letzten Lesen
        betService.pendingVoteCount(u._id), // Wetten, in denen meine Stimme zum Ergebnis fehlt
        // neue öffentliche Wetten und neue Wetten in den eigenen Gruppen seit dem letzten Besuch der Übersicht
        groupService.groupIdsOf(u._id).then((ids) => groupService.newBetCounts(u, ids)),
        forumService.navCounts(u), // Neues in eigenen Themen (rot) und im übrigen Forum
        u.isStaff ? betService.disputedCount() : 0, // nur Devs/Admins: strittige Wetten
        u.isAdmin ? require('./routes/admin').packLogNewCount(u) : 0, // nur Admin: Pack-Vergaben der Devs
        u.isStaff ? deviceService.alertCount() : 0, // Admin und Devs: Konten, die sich ein Gerät teilen
        u.isStaff ? deviceService.suspiciousTradeCount(u) : 0, // Admin und Devs: Handel zwischen Mehrfach-Konten
        u.isStaff ? suspicionService.openCount() : 0, // Admin und Devs: Spieler mit Verdacht auf Skript oder Wertverschiebung
        u.isStaff ? suspicionService.repeatCount() : 0, // … und beurteilte Fälle, die erneut aufgetreten sind
        notifyService.forBell(u._id), // Glocke
        achievementService.nextUnseen(u._id), // neuer Erfolg: Fenster, bis es mit OK bestätigt ist
        giftService.nextUnseen(u._id).then(giftService.popup), // Geschenk vom Team: Fenster mit Inhalt und Grund
      ]);
      Object.assign(res.locals, {
        tradeIncoming: incoming + deals,
        tradeMarketNew: marketNew,
        newPacks,
        newItems,
        patchNew,
        betVotePending: votePending,
        betNewPublic: betNew.pub,
        betNewGroup: betNew.group,
        forumMine: forumNew.mine,
        forumOther: forumNew.other,
        betDisputes: disputes,
        packLogNew,
        deviceAlerts,
        tradeAlerts,
        suspicionAlerts,
        suspicionRepeats,
        bellNotes: bell.list,
        bellUnread: bell.unread,
        achPopup,
        giftPopup,
      });
      // Ohne JavaScript führt "Weiter" im Erfolgs-/Geschenk-Fenster auf diese Seite zurück. Das Ziel steht in der
      // Sitzung statt in einem Formularfeld, damit niemand eine fremde Adresse unterschieben kann (CodeQL #74).
      if ((achPopup || giftPopup) && req.method === 'GET') req.session.popupBack = req.originalUrl;
    }
    next();
  });

  app.use(require('./routes/pages'));
  app.use(forumRoutes);
  app.use(require('./routes/auth'));
  app.use(require('./routes/dashboard'));
  app.use(require('./routes/bets'));
  app.use(require('./routes/account'));
  app.use(require('./routes/notify'));
  app.use(require('./routes/admin'));
  app.use(require('./routes/stats'));
  app.use(require('./routes/coin'));
  app.use(require('./routes/lottery'));
  app.use(require('./routes/tcg'));
  app.use(require('./routes/inventar'));
  app.use(require('./routes/support'));
  app.use(require('./routes/ihk'));
  app.use(require('./routes/dungeon'));
  app.use(require('./routes/esports'));
  app.use(require('./routes/trade'));
  app.use(require('./routes/grading'));
  app.use(require('./routes/deck'));
  app.use(require('./routes/bossfight'));
  app.use(require('./routes/shopDemo'));

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
