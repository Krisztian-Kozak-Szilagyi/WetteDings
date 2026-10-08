const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Position = require('../models/Position');
const Ledger = require('../models/Ledger');
const { requireLogin } = require('../middleware');
const { str } = require('../lib/util');
const { coinValueCents, valueCents } = require('../coin/tradeService');
const markets = require('../coin/markets');
const { CoinTrade, CoinHolding } = require('../models/Coin');
const { cardValueCents, inventory } = require('../tcg/tcgService');
const catalog = require('../tcg/catalog');
const grading = require('../grading/gradingService');
const { GradingShop } = require('../models/Grading');
const account = require('../services/accountService');
const { UserError } = require('../lib/util');
const roles = require('../services/roles');
const groups = require('../services/groupService');
const invites = require('../services/inviteService');
const { formatCode, remainingText } = require('../services/codeService');

const router = express.Router();

const BETS_PER_PAGE = 15; // Meine Wetten
const LEDGER_PER_PAGE = 20; // Kontoauszug

// Die Bereiche des Kontos – erreichbar über das Menü am Profil oben rechts
const SECTIONS = {
  statistiken: { path: '/konto', label: 'Statistiken' },
  wetten: { path: '/konto/wetten', label: 'Meine Wetten' },
  auszug: { path: '/konto/auszug', label: 'Kontoauszug' },
  gruppen: { path: '/konto/gruppen', label: 'Wett-Gruppen' },
  einladungen: { path: '/konto/einladungen', label: 'Einladungen' },
  einstellungen: { path: '/konto/einstellungen', label: 'Konto-Einstellungen' },
};

/** Seitenzahl aus der Adresse (?seite=3), begrenzt auf 1 … pages */
const pageOf = (req, total, perPage) => {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return { pages, total, page: Math.min(pages, Math.max(1, Number.parseInt(req.query.seite, 10) || 1)) };
};

const show = (res, section, data = {}) => res.render('account', { title: SECTIONS[section].label, section, sections: SECTIONS, ...data });

// Statistiken: Spielgeld, Wetten und Karten auf einen Blick
router.get('/konto', requireLogin, async (req, res) => {
  const userId = req.user._id;
  const [openAgg, statsAgg, coinValue, cardValue, owned, shop] = await Promise.all([
    Position.aggregate([{ $match: { user: userId, payout: null } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    Position.aggregate([
      { $match: { user: userId, payout: { $ne: null } } },
      { $group: { _id: null, won: { $sum: { $cond: [{ $gt: ['$payout', '$amount'] }, 1, 0] } }, lost: { $sum: { $cond: [{ $eq: ['$payout', 0] }, 1, 0] } } } },
    ]),
    coinValueCents(userId),
    cardValueCents(userId),
    inventory(userId),
    GradingShop.findById(userId).select('level').lean(),
  ]);
  const shopValue = grading.shopValue(shop ? shop.level : 1);
  const inPlay = openAgg[0] ? openAgg[0].s : 0;
  const has = new Set(owned.map((o) => o._id));
  show(res, 'statistiken', {
    inPlay,
    coinValue,
    cardValue,
    shopValue,
    total: req.user.balance + inPlay + coinValue + cardValue + shopValue,
    stats: statsAgg[0] || { won: 0, lost: 0 },
    cardCount: owned.reduce((n, o) => n + o.n, 0),
    uniqueOwned: catalog.CARDS.filter((c) => has.has(c.id)).length,
    totalCards: catalog.CARDS.length,
  });
});

router.get('/konto/wetten', requireLogin, async (req, res) => {
  const userId = req.user._id;
  const bets = pageOf(req, await Position.countDocuments({ user: userId }), BETS_PER_PAGE);
  const positions = await Position.find({ user: userId })
    .sort({ createdAt: -1, _id: -1 })
    .skip((bets.page - 1) * BETS_PER_PAGE)
    .limit(BETS_PER_PAGE)
    .populate('bet', 'title status outcome deadline options refunded')
    .lean();
  show(res, 'wetten', { positions: positions.filter((p) => p.bet), bets });
});

// Kontoauszug: Reiter „Alle Buchungen“ und je gehandeltem Broker-Wert ein Reiter (#129, ?coin=SAM) mit Bilanz und
// allen Orders (Stückzahl, Kurs, Betrag, Steuer)
router.get('/konto/auszug', requireLogin, async (req, res) => {
  const userId = req.user._id;
  const traded = new Set(await CoinTrade.distinct('coin', { user: userId }));
  const coinTabs = markets.LIST.filter((e) => traded.has(e.SYMBOL)).map((e) => ({ symbol: e.SYMBOL, name: e.NAME }));
  const engine = coinTabs.some((t) => t.symbol === str(req.query.coin)) ? markets.get(str(req.query.coin)) : null;
  if (!engine) {
    const led = pageOf(req, await Ledger.countDocuments({ user: userId }), LEDGER_PER_PAGE);
    const ledger = await Ledger.find({ user: userId }).sort({ createdAt: -1, _id: -1 }).skip((led.page - 1) * LEDGER_PER_PAGE).limit(LEDGER_PER_PAGE).lean();
    return show(res, 'auszug', { ledger, led, coinTabs, coin: null });
  }
  const symbol = engine.SYMBOL;
  const filter = { user: userId, coin: symbol };
  const [count, sums, holding] = await Promise.all([
    CoinTrade.countDocuments(filter),
    CoinTrade.aggregate([{ $match: filter }, { $group: { _id: '$side', cents: { $sum: '$cents' }, tax: { $sum: '$tax' } } }]),
    CoinHolding.findOne(filter).select('units').lean(),
  ]);
  const led = pageOf(req, count, LEDGER_PER_PAGE);
  const trades = await CoinTrade.find(filter).sort({ createdAt: -1, _id: -1 }).skip((led.page - 1) * LEDGER_PER_PAGE).limit(LEDGER_PER_PAGE).lean();
  const side = (s) => sums.find((x) => x._id === s) || { cents: 0, tax: 0 };
  const units = holding ? holding.units : 0;
  const price = engine.getPrice();
  const value = valueCents(units, price);
  // Gewinn/Verlust = Verkaufserlöse (nach Steuer) + heutiger Wert des Bestands − alle Käufe
  const balance = { units, price, value, invested: side('kauf').cents, proceeds: side('verkauf').cents, tax: side('verkauf').tax };
  balance.result = balance.proceeds + value - balance.invested;
  show(res, 'auszug', { coinTabs, coin: { symbol, name: engine.NAME, kind: engine.kind }, balance, trades, led });
});

router.get('/konto/gruppen', requireLogin, async (req, res) => {
  show(res, 'gruppen', {
    groups: await groups.overview(req.user._id),
    groupNameMax: groups.NAME_MAX,
    memberChoices: await User.find({ deletedAt: null, _id: { $ne: req.user._id } }).select('username').sort({ usernameLower: 1 }).lean(),
  });
});

// Einladungen: Links, die das Team für dieses Mitglied erstellt hat, und geworbene Mitglieder mit Provision
router.get('/konto/einladungen', requireLogin, async (req, res) => {
  const [links, invited] = await Promise.all([invites.linksFor(req.user._id), invites.invitedMembers(req.user._id)]);
  const now = Date.now();
  const origin = `${req.protocol}://${req.get('host')}`;
  show(res, 'einladungen', {
    // Benutzte Links stehen bei den geworbenen Mitgliedern; hier nur die noch offenen
    openLinks: links
      .filter((l) => !l.usedAt && new Date(l.expiresAt).getTime() > now)
      .map((l) => ({ ...l, url: invites.linkUrl(origin, l.code), shown: formatCode(l.code), left: remainingText(l.expiresAt, now), reward: invites.packsText(l.rewardPacks) })),
    invited,
    rewardTotal: invited.reduce((s, u) => s + ((u.inviteReward && u.inviteReward.packs) || 0), 0),
  });
});

router.get('/konto/einstellungen', requireLogin, (req, res) => {
  show(res, 'einstellungen', { renameDays: account.RENAME_COOLDOWN_DAYS, nextRenameAt: account.nextRenameAt(req.user), realNameMax: roles.REAL_NAME_MAX });
});

// Echter Name (freiwillig): erscheint überall in Klammern neben dem Benutzernamen; leer = entfernen
router.post('/konto/echter-name', requireLogin, async (req, res) => {
  const saved = await roles.setRealName(req.user._id, str(req.body.realName));
  if (saved === false) req.flash('error', `Der Name darf 2–${roles.REAL_NAME_MAX} Zeichen lang sein und nur Buchstaben, Leerzeichen, Bindestrich, Apostroph und Punkt enthalten.`);
  else req.flash('success', saved ? `Dein echter Name „${saved}“ wird jetzt neben deinem Benutzernamen angezeigt.` : 'Dein echter Name wird nicht mehr angezeigt.');
  res.redirect('/konto/einstellungen#name');
});

router.post('/konto/name', requireLogin, async (req, res) => {
  try {
    const name = await account.rename({ user: req.user, username: str(req.body.username) });
    req.flash('success', `Dein Benutzername ist jetzt „${name}“.`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/konto/einstellungen#name');
});

// Einwilligung für den Support-Chat widerrufen (Art. 7 Abs. 3 DSGVO); der Chat fragt danach erneut
router.post('/konto/support-einwilligung/widerrufen', requireLogin, async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $set: { supportConsentAt: null } });
  req.session.supportChat = [];
  req.flash('success', 'Deine Einwilligung für den Support-Chat wurde widerrufen und der Gesprächsverlauf gelöscht.');
  res.redirect('/konto/einstellungen#datenschutz');
});

router.post('/konto/loeschen', requireLogin, async (req, res) => {
  try {
    if (req.body.confirm !== 'on') throw new UserError('Bitte bestätige, dass du dein Konto endgültig löschen möchtest.');
    await account.deleteAccount({ user: req.user, password: str(req.body.password) });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect('/konto/einstellungen#datenschutz');
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
    user.resetHash = null; // ein offener Einmal-Code vom Admin ist damit erledigt
    user.resetExpires = null;
    await user.save();
    req.flash('success', 'Dein Passwort wurde geändert.');
  }
  res.redirect('/konto/einstellungen#passwort');
});

// ---------- Wett-Gruppen (Verwaltung unter "Mein Konto") ----------
async function groupAction(req, res, fn) {
  try {
    req.flash('success', await fn());
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/konto/gruppen');
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
    const { group, voided } = await groups.removeMember({ user: req.user, groupId: req.params.id, memberId: req.params.uid });
    return `Mitglied aus der Gruppe „${group.name}“ entfernt.${voided ? ` ${voided} offene Wette(n), an denen es als Wettersteller oder Schiedsrichter beteiligt war, wurden annulliert – die Einsätze sind zurück.` : ''}`;
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
    const { group, voided } = await groups.dissolve({ user: req.user, groupId: req.params.id });
    return `Gruppe „${group.name}“ aufgelöst.${voided ? ` ${voided} offene Wette(n) wurden annulliert – die Einsätze sind zurück.` : ''}`;
  })
);

module.exports = router;
