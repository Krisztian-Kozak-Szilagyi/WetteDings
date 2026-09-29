const express = require('express');
const User = require('../models/User');
const { requireLogin } = require('../middleware');
const coinEngine = require('../coin/engine');
const { sellValueExpr } = require('../tcg/tcgService');
const tcgSettings = require('../tcg/settings');

const router = express.Router();

// Rangliste zeigt Mitgliedernamen und Kontostände – nur für angemeldete Nutzer
router.get('/rangliste', requireLogin, async (req, res) => {
  // Gesamtvermögen = Kontostand + offene Einsätze + Wert der Samantha Coins zum aktuellen Kurs + Verkaufswert der TCG-Karten
  const centsPerUnit = coinEngine.isRunning() ? (coinEngine.getPrice() * 100) / 1e8 : 0;
  const leaders = await User.aggregate([
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
    {
      $addFields: {
        inPlay: { $ifNull: [{ $first: '$open.s' }, 0] },
        coinValue: { $floor: { $multiply: [{ $ifNull: [{ $sum: '$coins.units' }, 0] }, centsPerUnit] } },
        cardValue: { $ifNull: [{ $first: '$cards.s' }, 0] },
      },
    },
    { $addFields: { total: { $add: ['$balance', '$inPlay', '$coinValue', '$cardValue'] } } },
    { $sort: { total: -1, createdAt: 1 } },
    { $limit: 100 },
    { $project: { username: 1, balance: 1, inPlay: 1, coinValue: 1, cardValue: 1, total: 1 } },
  ]);
  res.render('leaderboard', { title: 'Rangliste', leaders });
});

router.get('/regeln', (req, res) => res.render('rules', { title: 'Regeln', tcgPackPrice: tcgSettings.getPackPrice() }));
router.get('/so-gehts', (req, res) => res.redirect(301, '/regeln'));
router.get('/impressum', (req, res) => res.render('impressum', { title: 'Impressum' }));
router.get('/datenschutz', (req, res) => res.render('datenschutz', { title: 'Datenschutz' }));

module.exports = router;
