const express = require('express');
const User = require('../models/User');
const Position = require('../models/Position');
const catalog = require('../tcg/catalog');
const { str } = require('../lib/util');
const { requireLogin, requireStaff } = require('../middleware');
const config = require('../config');
const deviceLogic = require('../device/deviceLogic');
const rankService = require('../services/rankService');
const { inventory, favoriteList } = require('../tcg/tcgService');
const { collection } = require('../tcg/collection');
const tcgSettings = require('../tcg/settings');
const achievementService = require('../achievements/achievementService');
const giftService = require('../services/giftService');
const achievementLogic = require('../achievements/logic');
const markets = require('../coin/markets');
const trade = require('../coin/tradeService');
const { profileStats } = require('../stats/profileStats');
const avatars = require('../profile/avatars');

const router = express.Router();
const LEADERBOARD_LIMIT = 100; // so viele Zeilen zeigt die Rangliste höchstens

// Rangliste zeigt Mitgliedernamen und Kontostände – nur für angemeldete Nutzer.
// Das Team (Admin, Devs und Mods) hat darunter eine eigene Rangliste mit eigenen Plätzen.
router.get('/rangliste', requireLogin, async (req, res) => {
  const all = await rankService.ranking({ team: true });
  const players = all.filter((u) => !u.team);
  const team = all.filter((u) => u.team);
  // Platz innerhalb der eigenen Liste; die Suche filtert danach, damit der Platz stimmt
  for (const list of [players, team]) {
    list.forEach((u, i) => {
      u.rank = i + 1;
    });
  }
  const q = str(req.query.suche).trim().slice(0, 30);
  const needle = q.toLowerCase();
  const match = (list) => (needle ? list.filter((u) => u.username.toLowerCase().includes(needle)) : list);
  res.render('leaderboard', { title: 'Rangliste', leaders: match(players).slice(0, LEADERBOARD_LIMIT), teamLeaders: match(team), q, memberCount: players.length, freshDays: rankService.FRESH_DAYS });
});

// Öffentliches Profil eines Mitglieds (nur für angemeldete Nutzer): Sammlung, Wett-Trefferquote, Favoriten
router.get('/profil/:name', requireLogin, async (req, res) => {
  const profile = await User.findOne({ usernameLower: str(req.params.name).toLowerCase(), deletedAt: null }).select('username usernameLower role realName createdAt tcgFavorites top1Seconds bannedUntil banReason bannedAt bannedByName bannedBy banHistory bio pinnedAchievements profileAsset statsPublic avatar').lean();
  if (!profile) return res.status(404).render('error', { title: 'Profil', status: 404, message: 'Dieses Mitglied gibt es nicht.' });
  const assetEngine = profile.profileAsset ? markets.get(profile.profileAsset) : null; // nur Werte aus der festen Liste
  const isMe = profile._id.equals(req.user._id);
  const [owned, mine, statsAgg, earned, shares, playmates, assetHolding, myStats] = await Promise.all([
    inventory(profile._id),
    inventory(req.user._id), // eigene Karten: "du besitzt …" in der großen Ansicht
    Position.aggregate([
      { $match: { user: profile._id, payout: { $ne: null } } },
      { $group: { _id: null, won: { $sum: { $cond: [{ $gt: ['$payout', '$amount'] }, 1, 0] } }, lost: { $sum: { $cond: [{ $eq: ['$payout', 0] }, 1, 0] } } } },
    ]),
    achievementService.earnedOf(profile._id),
    achievementService.shares(),
    achievementService.playmates(profile._id),
    assetEngine ? trade.getHolding(profile._id, assetEngine.SYMBOL) : null,
    isMe || profile.statsPublic ? profileStats(profile._id) : null, // Statistik: für einen selbst, für andere nur, wenn veröffentlicht
  ]);
  // Erfolge: Liste (freigeschaltete zuerst), angeheftete oben rechts – ohne eigene Auswahl die zwei neuesten
  const achievements = achievementLogic.profileList(achievementService.ACHIEVEMENTS, earned, shares.counts, shares.members);
  const earnedRows = achievements.filter((a) => a.earned);
  const pinnedKeys = (profile.pinnedAchievements || []).filter((k) => earnedRows.some((a) => a.key === k));
  const pinned = pinnedKeys.length ? pinnedKeys.map((k) => earnedRows.find((a) => a.key === k)) : earnedRows.slice(0, achievementLogic.PIN_MAX);
  const has = new Set(owned.map((o) => o._id));
  res.render('profil', {
    title: profile.username,
    profile,
    isMe,
    myStats,
    // Ban-Vermerk unter dem Namen (bleibt dauerhaft, auch nach Ablauf oder Unban) und Moderations-Menü für den Admin
    ban: profile.bannedAt ? { active: deviceLogic.isBanned(profile) } : null,
    bans: deviceLogic.banTimeline(profile), // alle Bans, neueste zuerst (Abzeichen mit Details)
    canBan:
      req.user.isStaff &&
      !profile._id.equals(req.user._id) &&
      !config.adminUsernames.includes(profile.usernameLower) &&
      (req.user.isAdmin || profile.role !== 'dev'),
    canUnban: req.user.isAdmin || (profile.bannedBy && profile.bannedBy.equals(req.user._id)),
    maxBanHours: req.user.isAdmin ? deviceLogic.MAX_BAN_HOURS : deviceLogic.DEV_MAX_BAN_HOURS,
    // Zeit auf Platz 1 der Rangliste als Text; leer, wenn das Mitglied nie Erster war
    top1: rankService.top1Text(profile.top1Seconds),
    cardCount: owned.reduce((s, o) => s + o.n, 0),
    uniqueOwned: catalog.CARDS.filter((c) => has.has(c.id)).length,
    totalCards: catalog.CARDS.length,
    cardValue: owned.reduce((s, o) => s + (o.v || 0), 0), // mit Wertsteigerung folierter Karten
    stats: statsAgg[0] || { won: 0, lost: 0 },
    favorites: await favoriteList(profile, Object.fromEntries(owned.map((o) => [o._id, o.n - (o.foiled || 0)]))), // folierte zählen einzeln
    rarityByKey: catalog.rarityByKey,
    achievements,
    achievementCount: earnedRows.length,
    achievementTotal: achievements.filter((a) => !a.unique || a.earned).length,
    pinnedAchievements: pinned,
    pinnedChosen: pinnedKeys.length > 0,
    pinnedKeys,
    playmates,
    // Profilbild wählen: vorerst nur Admin und Devs im eigenen Profil
    avatarChoices: isMe && req.user.isStaff ? avatars.AVATARS : null,
    countTier: achievementLogic.countTier,
    shareText: achievementLogic.shareText,
    bioMax: achievementLogic.BIO_MAX,
    ownedCounts: Object.fromEntries(mine.map((o) => [o._id, o.n])),
    // Seitenleiste: gewählter Broker-Wert mit Bestand (2 Nachkommastellen) und aktuellem Wert
    pfAsset: assetEngine
      ? (() => {
          const snap = assetEngine.snapshot();
          return { symbol: snap.symbol, name: snap.name, kind: snap.kind, units: trade.unitsText(assetHolding.units), value: trade.valueCents(assetHolding.units, snap.price) };
        })()
      : null,
    pfAssetOptions: markets.LIST.map((e) => e.snapshot()).map((x) => ({ symbol: x.symbol, name: x.name })),
  });
});

// Eigener Profiltext (für alle Mitglieder sichtbar)
router.post('/profil/text', requireLogin, async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $set: { bio: achievementLogic.cleanBio(req.body.text) } });
  res.redirect(`/profil/${encodeURIComponent(req.user.username)}`);
});

// Profil-Statistik für alle Mitglieder veröffentlichen oder wieder nur für sich behalten
router.post('/profil/statistik', requireLogin, async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $set: { statsPublic: str(req.body.oeffentlich) === '1' } });
  res.redirect(`/profil/${encodeURIComponent(req.user.username)}#statistik`);
});

// Profilbild wählen (vorerst nur Admin und Devs); leer oder unbekannt = Platzhalter
router.post('/profil/bild', requireStaff, async (req, res) => {
  const id = str(req.body.bild);
  await User.updateOne({ _id: req.user._id }, { $set: { avatar: avatars.has(id) ? id : null } });
  res.redirect(`/profil/${encodeURIComponent(req.user.username)}`);
});

// Broker-Wert für die Profil-Seitenleiste wählen (leer = keinen zeigen)
router.post('/profil/depot', requireLogin, async (req, res) => {
  const engine = markets.get(str(req.body.symbol));
  await User.updateOne({ _id: req.user._id }, { $set: { profileAsset: engine ? engine.SYMBOL : null } });
  res.redirect(`/profil/${encodeURIComponent(req.user.username)}`);
});

// Erfolg oben rechts im Profil an- oder abheften (höchstens zwei)
router.post('/profil/anheften', requireLogin, async (req, res) => {
  const a = achievementService.find(str(req.body.erfolg));
  if (a) {
    const [me, earned] = await Promise.all([User.findById(req.user._id).select('pinnedAchievements').lean(), achievementService.earnedOf(req.user._id)]);
    const next = achievementLogic.togglePin(me ? me.pinnedAchievements : [], a.key, earned.map((e) => e.key));
    await User.updateOne({ _id: req.user._id }, { $set: { pinnedAchievements: next } });
  }
  res.redirect(`/profil/${encodeURIComponent(req.user.username)}#erfolge`);
});

// Rücksprung nach "Weiter" im Erfolg-/Geschenk-Fenster (nur ohne JavaScript): nur auf einen dieser Bereiche,
// nie auf eine frei übergebene Adresse (CodeQL #74–#76). Das Ziel kommt aus der Liste, nicht aus der Anfrage.
const BACK_PAGES = ['/', '/wetten', '/duell', '/rangliste', '/broker', '/lotterie', '/tcg', '/inventar', '/handel', '/ihk', '/dungeon', '/grading', '/forum', '/patchnotes', '/benachrichtigungen', '/konto', '/regeln', '/support', '/admin'];
/** Bereich der Seite, auf der das Fenster erschien (erster Pfadteil), sonst das Dashboard; Profile → eigenes Profil */
function popupBack(req) {
  const first = '/' + (str(req.session.popupBack).split(/[?#]/)[0].split('/')[1] || '');
  if (first === '/profil') return `/profil/${encodeURIComponent(req.user.username)}`;
  return BACK_PAGES.find((p) => p === first) || '/';
}

// Fenster "Erfolg freigeschaltet" mit OK bestätigt – zurück auf die Seite, auf der es erschien
router.post('/erfolge/gesehen', requireLogin, async (req, res) => {
  await achievementService.markSeen(req.user._id, str(req.body.id));
  // app.js schickt im Hintergrund und zeigt gleich den nächsten Erfolg; ohne JavaScript zurück auf die Seite
  if (req.accepts(['html', 'json']) === 'json') {
    return res.json({ next: achievementService.popupJson(await achievementService.nextUnseen(req.user._id), req.app.locals.assetVersion) });
  }
  res.redirect(popupBack(req)); // Bereich aus der Sitzung (src/app.js), Ziel aus BACK_PAGES
});

// Fenster "Geschenk vom Team" mit Weiter bestätigt
router.post('/geschenke/gesehen', requireLogin, async (req, res) => {
  await giftService.markSeen(req.user._id, str(req.body.id));
  if (req.accepts(['html', 'json']) === 'json') {
    return res.json({ next: giftService.popup(await giftService.nextUnseen(req.user._id)) });
  }
  res.redirect(popupBack(req)); // Bereich aus der Sitzung (src/app.js), Ziel aus BACK_PAGES
});

// Sammlung eines Mitglieds (nur ansehen); ein Klick vergrößert die Karte, bei fremden Sammlungen lässt sich dort ein Angebot machen
router.get('/profil/:name/sammlung', requireLogin, async (req, res) => {
  const profile = await User.findOne({ usernameLower: str(req.params.name).toLowerCase(), deletedAt: null }).select('username').lean();
  if (!profile) return res.status(404).render('error', { title: 'Sammlung', status: 404, message: 'Dieses Mitglied gibt es nicht.' });
  const isMe = profile._id.equals(req.user._id);
  const [coll, mine] = await Promise.all([collection(profile), isMe ? null : inventory(req.user._id)]);
  res.render('profil-sammlung', {
    title: `Sammlung von ${profile.username}`,
    profile,
    isMe,
    ...coll,
    // eigene Karten: "du besitzt …" in der großen Ansicht (eigene Sammlung: die gezeigten Zahlen)
    ownedCounts: mine ? Object.fromEntries(mine.map((o) => [o._id, o.n])) : coll.counts,
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
  });
});

router.get('/regeln', (req, res) => res.render('rules', { title: 'Regeln', tcgPackPrice: tcgSettings.getPackPrice(), freshDays: rankService.FRESH_DAYS }));
router.get('/so-gehts', (req, res) => res.redirect(301, '/regeln'));
router.get('/impressum', (req, res) => res.render('impressum', { title: 'Impressum' }));
router.get('/datenschutz', (req, res) => res.render('datenschutz', { title: 'Datenschutz' }));

module.exports = router;
