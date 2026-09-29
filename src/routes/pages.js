const express = require('express');
const User = require('../models/User');

const router = express.Router();

router.get('/rangliste', async (req, res) => {
  // Gesamtvermögen = Kontostand + Geld, das gerade in offenen Wetten steckt
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
    { $addFields: { inPlay: { $ifNull: [{ $first: '$open.s' }, 0] } } },
    { $addFields: { total: { $add: ['$balance', '$inPlay'] } } },
    { $sort: { total: -1, createdAt: 1 } },
    { $limit: 100 },
    { $project: { username: 1, balance: 1, inPlay: 1, total: 1 } },
  ]);
  res.render('leaderboard', { title: 'Rangliste', leaders });
});

router.get('/so-gehts', (req, res) => res.render('rules', { title: "So geht's" }));
router.get('/impressum', (req, res) => res.render('impressum', { title: 'Impressum' }));
router.get('/datenschutz', (req, res) => res.render('datenschutz', { title: 'Datenschutz' }));

module.exports = router;
