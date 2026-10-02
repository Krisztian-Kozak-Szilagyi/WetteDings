const express = require('express');
const User = require('../models/User');
const Position = require('../models/Position');
const catalog = require('../tcg/catalog');
const { str } = require('../lib/util');
const { requireLogin } = require('../middleware');
const config = require('../config');
const deviceLogic = require('../device/deviceLogic');
const coinEngine = require('../coin/engine');
const { sellValueExpr, inventory } = require('../tcg/tcgService');
const { collection } = require('../tcg/collection');
const tcgSettings = require('../tcg/settings');

const router = express.Router();
const LEADERBOARD_LIMIT = 100; // so viele Zeilen zeigt die Rangliste höchstens

// Rangliste zeigt Mitgliedernamen und Kontostände – nur für angemeldete Nutzer
router.get('/rangliste', requireLogin, async (req, res) => {
  // Gesamtvermögen = Kontostand + offene Einsätze + Wert der Samantha Coins zum aktuellen Kurs + Verkaufswert der TCG-Karten (inkl. ungeöffneter Packs zum Packpreis)
  const centsPerUnit = coinEngine.isRunning() ? (coinEngine.getPrice() * 100) / 1e8 : 0;
  const leaders = await User.aggregate([
    { $match: { deletedAt: null } }, // gelöschte Konten erscheinen nicht
    {
      $lookup: {
        from: 'positions',
        let: { uid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$user', '$$uid'] }, payout: null } },
          { $group: { _id: null, s: { $sum: '$amount' } } },
        ],
        as: 'open',
      },
    },
    {
      $lookup: {
        from: 'coinholdings',
        localField: '_id',
        foreignField: 'user',
        as: 'coins',
      },
    },
    {
      $lookup: {
        from: 'tcgcards',
        let: { uid: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$user', '$$uid'] } } },
          { $group: { _id: null, s: { $sum: sellValueExpr() } } },
        ],
        as: 'cards',
      },
    },
    // ungeöffnete Booster Packs zählen zum aktuellen Packpreis bei den Karten mit
    { $lookup: { from: 'tcgpacks', localField: '_id', foreignField: 'user', as: 'packs' } },
    {
      $addFields: {
        inPlay: { $ifNull: [{ $first: '$open.s' }, 0] },
        coinValue: { $floor: { $multiply: [{ $ifNull: [{ $sum: '$coins.units' }, 0] }, centsPerUnit] } },
        cardValue: { $add: [{ $ifNull: [{ $first: '$cards.s' }, 0] }, { $multiply: [{ $size: '$packs' }, tcgSettings.getPackPrice()] }] },
      },
    },
    { $addFields: { total: { $add: ['$balance', '$inPlay', '$coinValue', '$cardValue'] } } },
    { $sort: { total: -1, createdAt: 1 } },
    { $project: { username: 1, balance: 1, inPlay: 1, coinValue: 1, cardValue: 1, total: 1 } },
  ]);
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
  const profile = await User.findOne({ usernameLower: str(req.params.name).toLowerCase(), deletedAt: null }).select('username usernameLower createdAt tcgFavorites bannedUntil banReason bannedAt bannedByName').lean();
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
    // Sperr-Vermerk unter dem Namen (bleibt auch nach Ablauf stehen) und Sperr-Formular für den Admin
    ban: profile.bannedAt ? { active: deviceLogic.isBanned(profile), forever: deviceLogic.isForever(profile.bannedUntil), until: profile.bannedUntil, at: profile.bannedAt, by: profile.bannedByName, reason: profile.banReason } : null,
    canBan: req.user.isAdmin && !config.adminUsernames.includes(profile.usernameLower),
    maxBanHours: deviceLogic.MAX_BAN_HOURS,
    cardCount: owned.reduce((s, o) => s + o.n, 0),
    uniqueOwned: catalog.CARDS.filter((c) => has.has(c.id)).length,
    totalCards: catalog.CARDS.length,
    cardValue: owned.reduce((s, o) => s + (catalog.rarityByKey[o.rarity] ? catalog.rarityByKey[o.rarity].sell * o.n : 0), 0),
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
