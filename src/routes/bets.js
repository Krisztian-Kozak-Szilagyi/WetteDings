const express = require('express');
const mongoose = require('mongoose');
const config = require('../config');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Comment = require('../models/Comment');
const rateLimit = require('express-rate-limit');
const { requireLogin } = require('../middleware');
const { str, escapeRegex, parseEuro, UserError } = require('../lib/util');
const { parseZonedLocal, toZonedLocalInput } = require('../lib/time');
const { euro } = require('../lib/viewHelpers');
const svc = require('../services/betService');

const router = express.Router();
const PER_PAGE = 24;
const COMMENT_MAX = 1000;
const TABS = {
  offen: 'Offen',
  wartend: 'Warten auf Ergebnis',
  abgeschlossen: 'Abgeschlossen',
  meine: 'Meine Wetten',
};
const JA_NEIN = [
  { key: 'ja', label: 'Ja' },
  { key: 'nein', label: 'Nein' },
];

/** Führt eine Aktion aus; Nutzerfehler werden als Hinweis angezeigt statt als Fehlerseite. */
async function action(req, res, fn, anchor = '') {
  const back = `/wetten/${req.params.id}${anchor}`;
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
  // Gäste sehen keine Wetten – nur die Startseite mit Anmeldung/Registrierung
  if (!req.user) return res.render('landing', { title: 'Willkommen' });

  const tab = TABS[str(req.query.tab)] ? str(req.query.tab) : 'offen';
  const page = Math.min(500, Math.max(1, parseInt(str(req.query.seite), 10) || 1));
  const q = str(req.query.q).trim().slice(0, 100);
  const now = new Date();
  // Versionsstand VOR dem Laden der Daten – so wird jede spätere Änderung sicher erkannt
  const liveVersion = await listVersion();

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
      // gesetzt ODER selbst erstellt (Ersteller setzen seit v3 nicht mehr mit)
      filter.$or = [{ _id: { $in: await Position.distinct('bet', { user: req.user._id }) } }, { creator: req.user._id }];
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

  res.render('index', { title: 'Wetten', bets, tab, tabs: TABS, page, hasMore, q, liveVersion });
});

// ---------- Live-Stand (für die automatische Aktualisierung alle 5 Sekunden) ----------
// Liefert nur eine kleine Versionskennung. Ändert sie sich, lädt der Browser die Seite im Hintergrund nach.
// Die Minute ist enthalten, damit sich Zeitangaben ("in 5 Minuten") und Einsatzschlüsse mindestens minütlich aktualisieren.

const minuteNow = () => Math.floor(Date.now() / 60000);

async function listVersion() {
  const [latest, count] = await Promise.all([
    Bet.findOne().sort({ updatedAt: -1 }).select('updatedAt').lean(),
    Bet.estimatedDocumentCount(),
  ]);
  return `${latest ? latest.updatedAt.getTime() : 0}:${count}:${minuteNow()}`;
}

async function betVersion(betId) {
  const [bet, lastComment] = await Promise.all([
    Bet.findById(betId).select('updatedAt commentCount status').lean(),
    Comment.findOne({ bet: betId }).sort({ updatedAt: -1 }).select('updatedAt').lean(),
  ]);
  if (!bet) return null;
  return [bet.updatedAt.getTime(), bet.commentCount, lastComment ? lastComment.updatedAt.getTime() : 0, bet.status, minuteNow()].join(':');
}

router.get('/wetten-stand', requireLogin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ v: await listVersion() });
});

router.get('/wetten/:id/stand', validId, requireLogin, async (req, res, next) => {
  const v = await betVersion(req.params.id);
  if (!v) return next();
  res.set('Cache-Control', 'no-store');
  res.json({ v });
});

// ---------- Neue Wette ----------

function newBetForm(res, { errors = [], values = {} } = {}, status = 200) {
  const defaults = {
    title: '',
    description: '',
    type: 'janein',
    options: ['', '', ''],
    deadline: '', // bewusst leer – muss vom Wettersteller angegeben werden
    resultAt: '',
  };
  const merged = { ...defaults, ...values };
  while (merged.options.length < 2) merged.options.push('');
  res.status(status).render('new-bet', {
    title: 'Neue Wette',
    errors,
    values: merged,
    minOptions: Bet.MIN_OPTIONS,
    maxOptions: Bet.MAX_OPTIONS,
    feePercent: config.creatorFeePercent,
    minDeadline: toZonedLocalInput(new Date(Date.now() + 10 * 60 * 1000), config.timezone),
  });
}

router.get('/wetten/neu', requireLogin, (req, res) => newBetForm(res));

router.post('/wetten', requireLogin, async (req, res) => {
  const rawOptions = [].concat(req.body.options || []).slice(0, 20).map((o) => str(o).trim().replace(/\s+/g, ' '));
  const values = {
    title: str(req.body.title).trim().replace(/\s+/g, ' '),
    description: str(req.body.description).trim().replace(/\r\n/g, '\n'),
    type: str(req.body.type) === 'optionen' ? 'optionen' : 'janein',
    options: rawOptions,
    deadline: str(req.body.deadline),
    resultAt: str(req.body.resultAt),
  };
  const deadline = parseZonedLocal(values.deadline, config.timezone);
  const resultAt = parseZonedLocal(values.resultAt, config.timezone);
  const now = Date.now();
  const YEAR = 366 * 24 * 60 * 60 * 1000;

  const errors = [];
  if (values.title.length < 5 || values.title.length > 140) errors.push('Der Titel muss 5–140 Zeichen lang sein.');
  if (values.description.length > 2000) errors.push('Die Beschreibung darf höchstens 2000 Zeichen lang sein.');
  if (!values.deadline) errors.push('Bitte gib den Einsatzschluss an (Datum und Uhrzeit).');
  else if (!deadline) errors.push('Bitte gib einen gültigen Einsatzschluss an.');
  else if (deadline.getTime() < now + 5 * 60 * 1000) errors.push('Der Einsatzschluss muss mindestens 5 Minuten in der Zukunft liegen.');
  else if (deadline.getTime() > now + YEAR) errors.push('Der Einsatzschluss darf höchstens ein Jahr in der Zukunft liegen.');
  if (!values.resultAt) errors.push('Bitte gib den Termin der Auswertung an (Datum und Uhrzeit).');
  else if (!resultAt) errors.push('Bitte gib einen gültigen Termin für die Auswertung an.');
  else if (deadline && resultAt < deadline) errors.push('Die Auswertung kann nicht vor dem Einsatzschluss liegen.');
  else if (deadline && resultAt.getTime() > deadline.getTime() + YEAR) errors.push('Die Auswertung darf höchstens ein Jahr nach dem Einsatzschluss liegen.');

  let options;
  if (values.type === 'janein') {
    options = JA_NEIN;
  } else {
    const filled = rawOptions.filter(Boolean);
    const lower = filled.map((o) => o.toLowerCase());
    if (filled.length < Bet.MIN_OPTIONS) errors.push(`Bitte gib mindestens ${Bet.MIN_OPTIONS} Optionen an.`);
    if (filled.length > Bet.MAX_OPTIONS) errors.push(`Es sind höchstens ${Bet.MAX_OPTIONS} Optionen möglich.`);
    if (filled.some((o) => o.length > 60)) errors.push('Eine Option darf höchstens 60 Zeichen lang sein.');
    if (new Set(lower).size !== lower.length) errors.push('Jede Option darf nur einmal vorkommen.');
    options = filled.map((label, i) => ({ key: `o${i + 1}`, label }));
  }

  if (errors.length) return newBetForm(res, { errors, values }, 400);

  const bet = await svc.createBet({
    user: req.user,
    title: values.title,
    description: values.description,
    type: values.type,
    options,
    deadline,
    resultAt,
  });
  req.flash('success', 'Deine Wette ist online! Teile den Link, damit andere mitwetten können.');
  res.redirect(`/wetten/${bet._id}`);
});

// ---------- Bearbeiten (Beschreibung: Ersteller/Admin, Titel: nur Admin) ----------

function editForm(res, bet, { errors = [], values = {} } = {}, status = 200) {
  res.status(status).render('edit-bet', {
    title: 'Wette bearbeiten',
    bet,
    errors,
    values: { title: bet.title, description: bet.description, ...values },
  });
}

async function loadEditable(req, res, next) {
  const bet = await Bet.findById(req.params.id);
  if (!bet) return next('route');
  const isOwner = String(bet.creator) === String(req.user._id);
  if (!isOwner && !req.user.isAdmin) {
    req.flash('error', 'Nur der Ersteller oder ein Admin darf diese Wette bearbeiten.');
    return res.redirect(`/wetten/${bet._id}`);
  }
  if (bet.status !== 'offen' && !req.user.isAdmin) {
    req.flash('error', 'Abgeschlossene Wetten können nur noch von Admins bearbeitet werden.');
    return res.redirect(`/wetten/${bet._id}`);
  }
  req.bet = bet;
  next();
}

router.get('/wetten/:id/bearbeiten', validId, requireLogin, loadEditable, (req, res) => editForm(res, req.bet));

router.post('/wetten/:id/bearbeiten', validId, requireLogin, loadEditable, async (req, res) => {
  const description = str(req.body.description).trim().replace(/\r\n/g, '\n');
  const title = req.user.isAdmin ? str(req.body.title).trim().replace(/\s+/g, ' ') : undefined;

  const errors = [];
  if (description.length > 2000) errors.push('Die Beschreibung darf höchstens 2000 Zeichen lang sein.');
  if (title !== undefined && (title.length < 5 || title.length > 140)) errors.push('Der Titel muss 5–140 Zeichen lang sein.');
  if (errors.length) return editForm(res, req.bet, { errors, values: { description, title } }, 400);

  try {
    const r = await svc.editBet({ actor: req.user, betId: req.bet._id, title, description });
    req.flash(r.changed ? 'success' : 'info', r.changed ? 'Änderungen gespeichert.' : 'Es wurde nichts geändert.');
    res.redirect(`/wetten/${req.bet._id}`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    editForm(res, req.bet, { errors: [err.message], values: { description, title } }, 400);
  }
});

// ---------- Detailseite ----------

// Nur für angemeldete Nutzer – geteilte Links führen zur Anmeldung und danach zurück zur Wette
router.get('/wetten/:id', validId, requireLogin, async (req, res, next) => {
  const liveVersion = await betVersion(req.params.id); // vor dem Laden der Daten
  if (!liveVersion) return next();
  const bet = await Bet.findById(req.params.id).lean();
  if (!bet) return next();
  const [positions, comments] = await Promise.all([
    Position.find({ bet: bet._id }).sort({ amount: -1, createdAt: 1 }).lean(),
    Comment.find({ bet: bet._id }).sort({ createdAt: 1 }).limit(500).lean(),
  ]);
  const sideByUser = {};
  positions.forEach((p) => { sideByUser[String(p.user)] = p.side; });

  const now = new Date();
  const me = req.user;
  const myPosition = me ? positions.find((p) => String(p.user) === String(me._id)) || null : null;
  const isOwner = !!me && String(bet.creator) === String(me._id);
  const isAdmin = !!me && me.isAdmin;
  const isOpen = bet.status === 'offen';
  const accepting = isOpen && bet.deadline > now;

  res.render('bet', {
    title: bet.title,
    liveVersion,
    bet,
    positions,
    comments,
    sideByUser,
    commentMax: COMMENT_MAX,
    myPosition,
    isOwner,
    accepting,
    noteMin: svc.NOTE_MIN,
    noteMax: svc.NOTE_MAX,
    perms: {
      // Wettersteller dürfen an ihrer eigenen Wette nicht teilnehmen
      stake: !!me && accepting && !isOwner,
      // Ersteller und Admins dürfen jederzeit das Ergebnis eintragen
      resolve: isOpen && (isOwner || isAdmin),
      void: isOpen && (isOwner || isAdmin),
      close: accepting && (isOwner || isAdmin),
      edit: (isOwner && isOpen) || isAdmin,
    },
  });
});

router.post('/wetten/:id/setzen', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const side = str(req.body.side);
    const amount = parseEuro(str(req.body.amount));
    if (!side) throw new UserError('Bitte wähle eine Option.');
    if (amount === null || amount < config.minStake) {
      throw new UserError(`Der Einsatz muss mindestens ${euro(config.minStake)} betragen.`);
    }
    const bet = await svc.placeStake({ user: req.user, betId: req.params.id, side, amount });
    const label = bet.options.find((o) => o.key === side).label;
    return `Du hast ${euro(amount)} auf „${label}“ gesetzt. Viel Glück!`;
  })
);

router.post('/wetten/:id/schliessen', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    await svc.closeBet({ actor: req.user, betId: req.params.id });
    return 'Einsatzschluss erreicht – es kann nicht mehr gesetzt werden.';
  })
);

router.post('/wetten/:id/entscheiden', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const outcome = str(req.body.outcome);
    if (!outcome || outcome === 'annulliert') throw new UserError('Bitte wähle aus, welche Option eingetreten ist.');
    const r = await svc.resolveBet({ actor: req.user, betId: req.params.id, outcome, note: str(req.body.note) });
    if (r.refunded) return `Ergebnis „${r.label}“ gespeichert. Da es keine Gegenseite gab, wurden alle Einsätze erstattet.`;
    const feeText = r.fee ? ` Provision für den Wettersteller: ${euro(r.fee)}.` : '';
    return `Ergebnis „${r.label}“ gespeichert. ${euro(r.paidTotal)} wurden an ${r.winnerCount} Gewinner ausgezahlt.${feeText}`;
  })
);

router.post('/wetten/:id/annullieren', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    await svc.resolveBet({ actor: req.user, betId: req.params.id, outcome: 'annulliert', note: str(req.body.note) });
    return 'Die Wette wurde annulliert. Alle Einsätze wurden erstattet.';
  })
);

// ---------- Kommentare ----------

const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user._id}` : 'anon'),
  handler: (req, res) => {
    req.flash('error', 'Du schreibst gerade sehr schnell – bitte warte einen Moment.');
    res.redirect(`/wetten/${req.params.id}#kommentare`);
  },
});

router.post('/wetten/:id/kommentare', validId, requireLogin, commentLimiter, (req, res) =>
  action(
    req,
    res,
    async () => {
      const text = str(req.body.text).trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      if (!text) throw new UserError('Der Kommentar ist leer.');
      if (text.length > COMMENT_MAX) throw new UserError(`Ein Kommentar darf höchstens ${COMMENT_MAX} Zeichen lang sein.`);
      const bet = await Bet.findByIdAndUpdate(req.params.id, { $inc: { commentCount: 1 } });
      if (!bet) throw new UserError('Wette nicht gefunden.');
      await Comment.create({ bet: bet._id, user: req.user._id, username: req.user.username, text });
      return null;
    },
    '#kommentare'
  )
);

router.post('/wetten/:id/kommentare/:cid/loeschen', validId, requireLogin, (req, res) =>
  action(
    req,
    res,
    async () => {
      if (!mongoose.isValidObjectId(req.params.cid)) throw new UserError('Kommentar nicht gefunden.');
      const comment = await Comment.findOne({ _id: req.params.cid, bet: req.params.id });
      if (!comment || comment.deleted) throw new UserError('Kommentar nicht gefunden.');
      const isAuthor = String(comment.user) === String(req.user._id);
      if (!isAuthor && !req.user.isAdmin) throw new UserError('Du kannst nur deine eigenen Kommentare löschen.');
      const res1 = await Comment.updateOne(
        { _id: comment._id, deleted: false },
        { $set: { deleted: true, text: '', deletedByName: isAuthor ? null : req.user.username } }
      );
      if (res1.modifiedCount) await Bet.updateOne({ _id: req.params.id }, { $inc: { commentCount: -1 } });
      return 'Kommentar gelöscht.';
    },
    '#kommentare'
  )
);

module.exports = router;
