const express = require('express');
const mongoose = require('mongoose');
const config = require('../config');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const { requireLogin } = require('../middleware');
const { str, escapeRegex, parseEuro, UserError } = require('../lib/util');
const { parseZonedLocal, toZonedLocalInput } = require('../lib/time');
const { euro } = require('../lib/viewHelpers');
const svc = require('../services/betService');

const router = express.Router();
const PER_PAGE = 24;
const TABS = {
  offen: 'Offen',
  wartend: 'Warten auf Ergebnis',
  abgeschlossen: 'Abgeschlossen',
  meine: 'Meine Wetten',
};

/** Führt eine Aktion aus; Nutzerfehler werden als Hinweis angezeigt statt als Fehlerseite. */
async function action(req, res, fn) {
  const back = `/wetten/${req.params.id}`;
  try {
    const message = await fn();
    if (message) req.flash('success', message);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect(back);
}

function validId(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) return next('route');
  next();
}

// ---------- Übersicht ----------

router.get('/', async (req, res) => {
  let tab = TABS[str(req.query.tab)] ? str(req.query.tab) : 'offen';
  if (tab === 'meine' && !req.user) tab = 'offen';
  const page = Math.min(500, Math.max(1, parseInt(str(req.query.seite), 10) || 1));
  const q = str(req.query.q).trim().slice(0, 100);
  const now = new Date();

  const filter = {};
  let sort;
  switch (tab) {
    case 'offen':
      Object.assign(filter, { status: 'offen', deadline: { $gt: now } });
      sort = { deadline: 1 };
      break;
    case 'wartend':
      Object.assign(filter, { status: 'offen', deadline: { $lte: now } });
      sort = { deadline: -1 };
      break;
    case 'abgeschlossen':
      filter.status = { $in: ['entschieden', 'annulliert'] };
      sort = { resolvedAt: -1 };
      break;
    case 'meine':
      filter._id = { $in: await Position.distinct('bet', { user: req.user._id }) };
      sort = { createdAt: -1 };
      break;
  }
  if (q) filter.title = { $regex: escapeRegex(q), $options: 'i' };

  const bets = await Bet.find(filter)
    .sort({ ...sort, _id: -1 })
    .skip((page - 1) * PER_PAGE)
    .limit(PER_PAGE + 1)
    .lean();
  const hasMore = bets.length > PER_PAGE;
  if (hasMore) bets.pop();

  res.render('index', { title: 'Wetten', bets, tab, tabs: TABS, page, hasMore, q });
});

// ---------- Neue Wette ----------

function newBetForm(res, { errors = [], values = {} } = {}, status = 200) {
  const defaults = {
    title: '',
    description: '',
    deadline: toZonedLocalInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), config.timezone),
    side: 'ja',
    amount: '10',
  };
  res.status(status).render('new-bet', {
    title: 'Neue Wette',
    errors,
    values: { ...defaults, ...values },
    minDeadline: toZonedLocalInput(new Date(Date.now() + 10 * 60 * 1000), config.timezone),
  });
}

router.get('/wetten/neu', requireLogin, (req, res) => newBetForm(res));

router.post('/wetten', requireLogin, async (req, res) => {
  const values = {
    title: str(req.body.title).trim().replace(/\s+/g, ' '),
    description: str(req.body.description).trim().replace(/\r\n/g, '\n'),
    deadline: str(req.body.deadline),
    side: str(req.body.side),
    amount: str(req.body.amount),
  };
  const deadline = parseZonedLocal(values.deadline, config.timezone);
  const amount = parseEuro(values.amount);
  const now = Date.now();

  const errors = [];
  if (values.title.length < 5 || values.title.length > 140) errors.push('Der Titel muss 5–140 Zeichen lang sein.');
  if (values.description.length > 2000) errors.push('Die Beschreibung darf höchstens 2000 Zeichen lang sein.');
  if (!deadline) errors.push('Bitte gib einen gültigen Einsatzschluss an.');
  else if (deadline.getTime() < now + 5 * 60 * 1000) errors.push('Der Einsatzschluss muss mindestens 5 Minuten in der Zukunft liegen.');
  else if (deadline.getTime() > now + 366 * 24 * 60 * 60 * 1000) errors.push('Der Einsatzschluss darf höchstens ein Jahr in der Zukunft liegen.');
  if (!['ja', 'nein'].includes(values.side)) errors.push('Bitte wähle deine Seite.');
  if (amount === null || amount < config.minStake) errors.push(`Der Einsatz muss mindestens ${euro(config.minStake)} betragen.`);
  else if (amount > req.user.balance) errors.push(`Dein Guthaben (${euro(req.user.balance)}) reicht dafür nicht aus.`);

  if (errors.length) return newBetForm(res, { errors, values }, 400);

  try {
    const bet = await svc.createBet({
      user: req.user,
      title: values.title,
      description: values.description,
      deadline,
      side: values.side,
      amount,
    });
    req.flash('success', 'Deine Wette ist online! Teile den Link, damit andere mitwetten können.');
    res.redirect(`/wetten/${bet._id}`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    newBetForm(res, { errors: [err.message], values }, 400);
  }
});

// ---------- Detailseite ----------

router.get('/wetten/:id', validId, async (req, res, next) => {
  const bet = await Bet.findById(req.params.id).lean();
  if (!bet) return next();
  const positions = await Position.find({ bet: bet._id }).sort({ amount: -1, createdAt: 1 }).lean();

  const now = new Date();
  const me = req.user;
  const myPosition = me ? positions.find((p) => String(p.user) === String(me._id)) || null : null;
  const isOwner = !!me && String(bet.creator) === String(me._id);
  const isAdmin = !!me && me.isAdmin;
  const isOpen = bet.status === 'offen';
  const accepting = isOpen && bet.deadline > now;

  res.render('bet', {
    title: bet.title,
    bet,
    positions,
    myPosition,
    isOwner,
    accepting,
    perms: {
      stake: !!me && accepting,
      resolve: isOpen && (isAdmin || (isOwner && !accepting)),
      void: isOpen && (isOwner || isAdmin),
      close: accepting && (isOwner || isAdmin),
    },
  });
});

router.post('/wetten/:id/setzen', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const side = str(req.body.side);
    const amount = parseEuro(str(req.body.amount));
    if (!['ja', 'nein'].includes(side)) throw new UserError('Bitte wähle eine Seite.');
    if (amount === null || amount < config.minStake) {
      throw new UserError(`Der Einsatz muss mindestens ${euro(config.minStake)} betragen.`);
    }
    await svc.placeStake({ user: req.user, betId: req.params.id, side, amount });
    return `Du hast ${euro(amount)} auf „${side === 'ja' ? 'Ja' : 'Nein'}“ gesetzt. Viel Glück!`;
  })
);

router.post('/wetten/:id/schliessen', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    await svc.closeBet({ actor: req.user, betId: req.params.id });
    return 'Einsatzschluss erreicht – jetzt kannst du das Ergebnis eintragen.';
  })
);

router.post('/wetten/:id/entscheiden', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const outcome = str(req.body.outcome);
    if (!['ja', 'nein'].includes(outcome)) throw new UserError('Ungültiges Ergebnis.');
    const r = await svc.resolveBet({ actor: req.user, betId: req.params.id, outcome });
    if (r.refunded) return 'Ergebnis gespeichert. Da es keine Gegenseite gab, wurden alle Einsätze erstattet.';
    return `Ergebnis „${outcome === 'ja' ? 'Ja' : 'Nein'}“ gespeichert. ${euro(r.paidTotal)} wurden an ${r.winnerCount} Gewinner ausgezahlt.`;
  })
);

router.post('/wetten/:id/annullieren', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const reason = str(req.body.reason).trim().slice(0, 300);
    await svc.resolveBet({ actor: req.user, betId: req.params.id, outcome: 'annulliert', reason });
    return 'Die Wette wurde annulliert. Alle Einsätze wurden erstattet.';
  })
);

module.exports = router;
