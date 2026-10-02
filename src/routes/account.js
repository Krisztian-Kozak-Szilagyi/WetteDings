const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const User = require('../models/User');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { requireLogin } = require('../middleware');
const { str } = require('../lib/util');
const { coinValueCents } = require('../coin/tradeService');
const { cardValueCents } = require('../tcg/tcgService');
const account = require('../services/accountService');
const { UserError } = require('../lib/util');
const roles = require('../services/roles');
const groups = require('../services/groupService');

const router = express.Router();

const BETS_PER_PAGE = 15; // Meine Wetten
const LEDGER_PER_PAGE = 20; // Kontoauszug

/** Seitenzahl aus der Adresse (?name=3), begrenzt auf 1 … pages */
const pageOf = (req, name, total, perPage) => {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { pages, page: Math.min(pages, Math.max(1, Number.parseInt(req.query[name], 10) || 1)) };
};

router.get('/konto', requireLogin, async (req, res) => {
  const userId = req.user._id;
  const [betTotal, ledgerTotal] = await Promise.all([Position.countDocuments({ user: userId }), Ledger.countDocuments({ user: userId })]);
  const bets = pageOf(req, 'wetten', betTotal, BETS_PER_PAGE);
  const led = pageOf(req, 'auszug', ledgerTotal, LEDGER_PER_PAGE);
  const [positions, ledger, openAgg, statsAgg] = await Promise.all([
    Position.find({ user: userId })
      .sort({ createdAt: -1, _id: -1 })
      .skip((bets.page - 1) * BETS_PER_PAGE)
      .limit(BETS_PER_PAGE)
      .populate('bet', 'title status outcome deadline options refunded')
      .lean(),
    Ledger.find({ user: userId }).sort({ createdAt: -1, _id: -1 }).skip((led.page - 1) * LEDGER_PER_PAGE).limit(LEDGER_PER_PAGE).lean(),
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

  res.render('account', {
    title: 'Mein Konto',
    positions: positions.filter((p) => p.bet),
    ledger,
    // Blättern; ein Abschnitt ist aufgeklappt, wenn gerade in ihm geblättert wird
    bets: { ...bets, total: betTotal, open: 'wetten' in req.query },
    led: { ...led, total: ledgerTotal, open: 'auszug' in req.query },
    inPlay,
    coinValue,
    cardValue,
    total,
    net: total - config.startBalance,
    stats,
    pwErrors: [],
    renameDays: account.RENAME_COOLDOWN_DAYS,
    nextRenameAt: account.nextRenameAt(req.user),
    realNameMax: roles.REAL_NAME_MAX,
    groups: await groups.overview(req.user._id),
    groupNameMax: groups.NAME_MAX,
    memberChoices: await User.find({ deletedAt: null, _id: { $ne: req.user._id } }).select('username').sort({ usernameLower: 1 }).lean(),
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

// ---------- Wett-Gruppen (Verwaltung unter "Mein Konto") ----------
async function groupAction(req, res, fn) {
  try {
    req.flash('success', await fn());
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/konto#gruppen');
}

router.post('/gruppen', requireLogin, (req, res) =>
  groupAction(req, res, async () => {
    const g = await groups.create({ user: req.user, name: str(req.body.name) });
    return `Gruppe „${g.name}“ angelegt. Lade jetzt Mitglieder ein.`;
  })
);

router.post('/gruppen/:id/mitglied', requireLogin, (req, res) =>
  groupAction(req, res, async () => {
    const { group, member } = await groups.addMember({ user: req.user, groupId: req.params.id, username: str(req.body.username) });
    return `${member.username} ist jetzt in der Gruppe „${group.name}“.`;
  })
);

router.post('/gruppen/:id/mitglied/:uid/entfernen', requireLogin, (req, res) =>
  groupAction(req, res, async () => {
    const group = await groups.removeMember({ user: req.user, groupId: req.params.id, memberId: req.params.uid });
    return `Mitglied aus der Gruppe „${group.name}“ entfernt.`;
  })
);

router.post('/gruppen/:id/verlassen', requireLogin, (req, res) =>
  groupAction(req, res, async () => {
    const group = await groups.leave({ user: req.user, groupId: req.params.id });
    return `Du hast die Gruppe „${group.name}“ verlassen.`;
  })
);

router.post('/gruppen/:id/aufloesen', requireLogin, (req, res) =>
  groupAction(req, res, async () => {
    const group = await groups.dissolve({ user: req.user, groupId: req.params.id });
    return `Gruppe „${group.name}“ aufgelöst.`;
  })
);

module.exports = router;
