const express = require('express');
const User = require('../models/User');
const Position = require('../models/Position');
const catalog = require('../tcg/catalog');
const { str } = require('../lib/util');
const { requireLogin } = require('../middleware');
const config = require('../config');
const deviceLogic = require('../device/deviceLogic');
const rankService = require('../services/rankService');
const { inventory } = require('../tcg/tcgService');
const { collection } = require('../tcg/collection');
const tcgSettings = require('../tcg/settings');

const router = express.Router();
const LEADERBOARD_LIMIT = 100; // so viele Zeilen zeigt die Rangliste höchstens

// Rangliste zeigt Mitgliedernamen und Kontostände – nur für angemeldete Nutzer
router.get('/rangliste', requireLogin, async (req, res) => {
  const leaders = await rankService.ranking();
  // Platz über alle Mitglieder; die Suche filtert danach, damit der Platz stimmt
  leaders.forEach((u, i) => {
    u.rank = i + 1;
  });
  const q = str(req.query.suche).trim().slice(0, 30);
  const needle = q.toLowerCase();
  const found = needle ? leaders.filter((u) => u.username.toLowerCase().includes(needle)) : leaders;
  res.render('leaderboard', { title: 'Rangliste', leaders: found.slice(0, LEADERBOARD_LIMIT), q, memberCount: leaders.length });
});

// Öffentliches Profil eines Mitglieds (nur für angemeldete Nutzer): Sammlung, Wett-Trefferquote, Favoriten
router.get('/profil/:name', requireLogin, async (req, res) => {
  const profile = await User.findOne({ usernameLower: str(req.params.name).toLowerCase(), deletedAt: null }).select('username usernameLower role createdAt tcgFavorites top1Seconds bannedUntil banReason bannedAt bannedByName bannedBy').lean();
  if (!profile) return res.status(404).render('error', { title: 'Profil', status: 404, message: 'Dieses Mitglied gibt es nicht.' });
  const [owned, mine, statsAgg] = await Promise.all([
    inventory(profile._id),
    inventory(req.user._id), // eigene Karten: "du besitzt …" in der großen Ansicht
    Position.aggregate([
      { $match: { user: profile._id, payout: { $ne: null } } },
      { $group: { _id: null, won: { $sum: { $cond: [{ $gt: ['$payout', '$amount'] }, 1, 0] } }, lost: { $sum: { $cond: [{ $eq: ['$payout', 0] }, 1, 0] } } } },
    ]),
  ]);
  const has = new Set(owned.map((o) => o._id));
  res.render('profil', {
    title: profile.username,
    profile,
    isMe: profile._id.equals(req.user._id),
    // Ban-Vermerk unter dem Namen (bleibt dauerhaft, auch nach Ablauf oder Unban) und Moderations-Menü für den Admin
    ban: profile.bannedAt ? { active: deviceLogic.isBanned(profile), by: profile.bannedByName, reason: profile.banReason } : null,
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
    favorites: (profile.tcgFavorites || []).map((id) => catalog.cardById[id]).filter((c) => c && has.has(c.id)),
    rarityByKey: catalog.rarityByKey,
    ownedCounts: Object.fromEntries(mine.map((o) => [o._id, o.n])),
  });
});

// Sammlung eines Mitglieds (nur ansehen); bei fremden Sammlungen führt ein Klick auf eine Karte zum Tauschangebot
router.get('/profil/:name/sammlung', requireLogin, async (req, res) => {
  const profile = await User.findOne({ usernameLower: str(req.params.name).toLowerCase(), deletedAt: null }).select('username').lean();
  if (!profile) return res.status(404).render('error', { title: 'Sammlung', status: 404, message: 'Dieses Mitglied gibt es nicht.' });
  const isMe = profile._id.equals(req.user._id);
  res.render('profil-sammlung', {
    title: `Sammlung von ${profile.username}`,
    profile,
    isMe,
    ...(await collection(profile)),
    cards: catalog.CARDS,
    rarities: catalog.visibleRarities(),
    rarityByKey: catalog.rarityByKey,
  });
});

router.get('/regeln', (req, res) => res.render('rules', { title: 'Regeln', tcgPackPrice: tcgSettings.getPackPrice() }));
router.get('/so-gehts', (req, res) => res.redirect(301, '/regeln'));
router.get('/impressum', (req, res) => res.render('impressum', { title: 'Impressum' }));
router.get('/datenschutz', (req, res) => res.render('datenschutz', { title: 'Datenschutz' }));

module.exports = router;
