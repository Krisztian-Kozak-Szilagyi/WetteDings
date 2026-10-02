const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { requireLogin } = require('../middleware');
const { str } = require('../lib/util');
const { bonusFor } = require('../services/bonusService');
const { coinValueCents } = require('../coin/tradeService');
const { cardValueCents } = require('../tcg/tcgService');
const account = require('../services/accountService');
const { UserError } = require('../lib/util');
const roles = require('../services/roles');

const router = express.Router();

router.get('/konto', requireLogin, async (req, res) => {
  const userId = req.user._id;
  const [positions, ledger, openAgg, statsAgg] = await Promise.all([
    Position.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('bet', 'title status outcome deadline options refunded')
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
  const [coinValue, cardValue] = await Promise.all([coinValueCents(userId), cardValueCents(userId)]);
  const total = req.user.balance + inPlay + coinValue + cardValue;
  const lastBonus = await Ledger.findOne({ user: userId, type: 'bonus' }).sort({ createdAt: -1 }).lean();

  res.render('account', {
    title: 'Mein Konto',
    positions: positions.filter((p) => p.bet),
    ledger,
    inPlay,
    coinValue,
    cardValue,
    total,
    net: total - config.startBalance,
    stats,
    lastBonus,
    bonusNow: bonusFor(total),
    pwErrors: [],
    renameDays: account.RENAME_COOLDOWN_DAYS,
    nextRenameAt: account.nextRenameAt(req.user),
    realNameMax: roles.REAL_NAME_MAX,
  });
});

// Echter Name (freiwillig): erscheint überall in Klammern neben dem Benutzernamen; leer = entfernen
router.post('/konto/echter-name', requireLogin, async (req, res) => {
  const saved = await roles.setRealName(req.user._id, str(req.body.realName));
  if (saved === false) req.flash('error', `Der Name darf 2–${roles.REAL_NAME_MAX} Zeichen lang sein und nur Buchstaben, Leerzeichen, Bindestrich, Apostroph und Punkt enthalten.`);
  else req.flash('success', saved ? `Dein echter Name „${saved}“ wird jetzt neben deinem Benutzernamen angezeigt.` : 'Dein echter Name wird nicht mehr angezeigt.');
  res.redirect('/konto#name');
});

router.post('/konto/name', requireLogin, async (req, res) => {
  try {
    const name = await account.rename({ user: req.user, username: str(req.body.username) });
    req.flash('success', `Dein Benutzername ist jetzt „${name}“.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/konto#name');
});

// Einwilligung für den Support-Chat widerrufen (Art. 7 Abs. 3 DSGVO); der Chat fragt danach erneut
router.post('/konto/support-einwilligung/widerrufen', requireLogin, async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $set: { supportConsentAt: null } });
  req.session.supportChat = [];
  req.flash('success', 'Deine Einwilligung für den Support-Chat wurde widerrufen und der Gesprächsverlauf gelöscht.');
  res.redirect('/konto#datenschutz');
});

router.post('/konto/loeschen', requireLogin, async (req, res) => {
  try {
    if (req.body.confirm !== 'on') throw new UserError('Bitte bestätige, dass du dein Konto endgültig löschen möchtest.');
    await account.deleteAccount({ user: req.user, password: str(req.body.password) });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect('/konto#datenschutz');
  }
  req.session.destroy(() => res.redirect('/anmelden?geloescht=1'));
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
