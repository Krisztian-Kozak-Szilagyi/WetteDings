const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { requireLogin } = require('../middleware');
const { str } = require('../lib/util');

const router = express.Router();

router.get('/konto', requireLogin, async (req, res) => {
  const userId = req.user._id;
  const [positions, ledger, openAgg, statsAgg] = await Promise.all([
    Position.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('bet', 'title status outcome deadline totalJa totalNein refunded')
      .lean(),
    Ledger.find({ user: userId }).sort({ createdAt: -1, _id: -1 }).limit(50).lean(),
    Position.aggregate([{ $match: { user: userId, payout: null } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    Position.aggregate([
      { $match: { user: userId, payout: { $ne: null } } },
      {
        $group: {
          _id: null,
          won: { $sum: { $cond: [{ $gt: ['$payout', '$amount'] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ['$payout', 0] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const inPlay = openAgg[0] ? openAgg[0].s : 0;
  const stats = statsAgg[0] || { won: 0, lost: 0 };
  const total = req.user.balance + inPlay;

  res.render('account', {
    title: 'Mein Konto',
    positions: positions.filter((p) => p.bet),
    ledger,
    inPlay,
    total,
    net: total - config.startBalance,
    stats,
    pwErrors: [],
  });
});

router.post('/konto/passwort', requireLogin, async (req, res) => {
  const current = str(req.body.current);
  const password = str(req.body.password);
  const password2 = str(req.body.password2);
  const user = await User.findById(req.user._id);

  let error = null;
  if (!(await bcrypt.compare(current, user.passwordHash))) error = 'Das aktuelle Passwort ist falsch.';
  else if (password.length < 8 || password.length > 200) error = 'Das neue Passwort muss mindestens 8 Zeichen lang sein.';
  else if (password !== password2) error = 'Die neuen Passwörter stimmen nicht überein.';

  if (error) {
    req.flash('error', error);
  } else {
    user.passwordHash = await bcrypt.hash(password, 12);
    await user.save();
    req.flash('success', 'Dein Passwort wurde geändert.');
  }
  res.redirect('/konto#passwort');
});

module.exports = router;
