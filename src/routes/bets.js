const express = require('express');
const mongoose = require('mongoose');
const config = require('../config');
const Bet = require('../models/Bet');
const Position = require('../models/Position');
const Comment = require('../models/Comment');
const User = require('../models/User');
const rateLimit = require('express-rate-limit');
const { requireLogin } = require('../middleware');
const { verdictRole, devMayDecide } = require('../lib/verdict');
const { str, escapeRegex, parseEuro, UserError } = require('../lib/util');
const { parseZonedLocal, toZonedLocalInput } = require('../lib/time');
const { euro } = require('../lib/viewHelpers');
const svc = require('../services/betService');
const groups = require('../services/groupService');
const duels = require('../services/duelService');
const catalog = require('../tcg/catalog');
const { quote: rawQuote } = require('../lib/payout');

const router = express.Router();
const PER_PAGE = 24;
const GROUP_BETS_MAX = 48; // so viele Gruppen-Wetten zeigt der eigene Abschnitt höchstens
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

// Gruppen-Wetten sind nur für Mitglieder der Gruppe erreichbar (und für Admin/Devs, die Streitfälle
// entscheiden). Gilt für alle Routen unter /wetten/:id – ansehen, setzen, kommentieren, Live-Stand.
router.use('/wetten/:id', async (req, res, next) => {
  if (!req.user || !mongoose.isValidObjectId(req.params.id)) return next();
  const bet = await Bet.findById(req.params.id).select('group creator referee duel').lean();
  if (bet && bet.group && !groups.canSee(bet, req.user, await groups.groupIdsOf(req.user._id))) return next('router'); // wie "nicht gefunden"
  // Duell-Anfrage: nur die drei Beteiligten (und Admin/Devs)
  if (bet && bet.duel && bet.duel.state === 'angefragt' && !duels.duelRole(bet, req.user) && !req.user.isStaff) return next('router');
  next();
});

// ---------- Übersicht ----------

// (Die Startseite "/" ist das Dashboard – routes/dashboard.js)
router.get('/wetten', requireLogin, async (req, res) => {
  const tab = TABS[str(req.query.tab)] ? str(req.query.tab) : 'offen';
  const page = Math.min(500, Math.max(1, parseInt(str(req.query.seite), 10) || 1));
  const q = str(req.query.q).trim().slice(0, 100);
  const now = new Date();
  // Versionsstand VOR dem Laden der Daten – so wird jede spätere Änderung sicher erkannt
  const liveVersion = await listVersion();

  // Filter und Sortierung je Reiter (die Suche gilt für alle Reiter, auch für die Zähler)
  const myBetIds = await Position.distinct('bet', { user: req.user._id });
  const search = q ? { title: { $regex: escapeRegex(q), $options: 'i' } } : {};
  const TAB_QUERIES = {
    offen: { filter: { status: 'offen', deadline: { $gt: now } }, sort: { deadline: 1 } },
    wartend: { filter: { status: 'offen', deadline: { $lte: now } }, sort: { deadline: -1 } },
    abgeschlossen: { filter: { status: { $in: ['entschieden', 'annulliert'] } }, sort: { resolvedAt: -1 } },
    // gesetzt ODER selbst erstellt ODER Schiedsrichter (Ersteller und Schiedsrichter setzen nicht mit) ODER herausgefordert
    meine: {
      filter: { $or: [{ _id: { $in: myBetIds } }, { creator: req.user._id }, { referee: req.user._id }, { 'duel.opponent': req.user._id }] },
      sort: { createdAt: -1 },
    },
  };
  // Duell-Anfragen sehen nur die Beteiligten
  const hidden = svc.hiddenDuelFilter(req.user._id);
  for (const k of Object.keys(TAB_QUERIES)) TAB_QUERIES[k].filter = { $and: [TAB_QUERIES[k].filter, hidden] };
  const { filter, sort } = TAB_QUERIES[tab];

  // Sichtbar: öffentliche Wetten und die der eigenen Gruppen
  const groupIds = await groups.groupIdsOf(req.user._id);
  const vis = groups.visibleFilter(groupIds);

  const [bets, countList] = await Promise.all([
    Bet.find({ $and: [filter, search, { group: null }] })
      .sort({ ...sort, _id: -1 })
      .skip((page - 1) * PER_PAGE)
      .limit(PER_PAGE + 1)
      .lean(),
    Promise.all(Object.keys(TAB_QUERIES).map((key) => Bet.countDocuments({ $and: [TAB_QUERIES[key].filter, search, vis] }))),
  ]);
  const hasMore = bets.length > PER_PAGE;
  if (hasMore) bets.pop();
  // Wetten aus den eigenen Gruppen: eigener Abschnitt unter den öffentlichen (auf der ersten Seite)
  const groupBets =
    page === 1 && groupIds.length
      ? await Bet.find({ $and: [filter, search, { group: { $in: groupIds } }] }).sort({ ...sort, _id: -1 }).limit(GROUP_BETS_MAX).lean()
      : [];
  const counts = Object.fromEntries(Object.keys(TAB_QUERIES).map((key, i) => [key, countList[i]]));

  // Eigene Tipps auf den angezeigten Wetten: { betId: { side, amount } }
  const myPositions = await Position.find({ user: req.user._id, bet: { $in: [...bets, ...groupBets].map((b) => b._id) } })
    .select('bet side amount')
    .lean();
  const myPicks = Object.fromEntries(myPositions.map((p) => [String(p.bet), { side: p.side, amount: p.amount }]));

  // Besuch merken: die Abzeichen für neue Wetten am Menüpunkt verschwinden
  await User.updateOne({ _id: req.user._id }, { $set: { betsSeenAt: new Date() } });
  res.locals.betNewPublic = 0;
  res.locals.betNewGroup = 0;

  // Duell-Anfragen, auf die ich antworten muss (Kasten oben)
  const duelInvites = await duels.invitesFor(req.user._id);

  res.render('index', { title: 'Wetten', bets, groupBets, tab, tabs: TABS, counts, myPicks, page, hasMore, q, liveVersion, duelInvites });
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

/** Mitglieder, die als Schiedsrichter in Frage kommen: alle außer dem Ersteller selbst */
function refereeCandidates(userId) {
  return User.find({ deletedAt: null, _id: { $ne: userId } })
    .select('username')
    .sort({ usernameLower: 1 })
    .lean();
}

async function newBetForm(req, res, { errors = [], errorStep = 0, values = {} } = {}, status = 200) {
  const defaults = {
    title: '',
    description: '',
    type: 'janein',
    options: ['', '', ''],
    referee: '',
    group: '', // leer = öffentlich
    deadline: '', // bewusst leer – muss vom Wettersteller angegeben werden
    resultAt: '',
  };
  const merged = { ...defaults, ...values };
  while (merged.options.length < 2) merged.options.push('');
  res.status(status).render('new-bet', {
    title: 'Neue Wette',
    errors,
    errorStep, // Schritt des Assistenten mit dem ersten Fehler
    values: merged,
    candidates: await refereeCandidates(req.user._id),
    groups: await groups.groupsOf(req.user._id),
    minOptions: Bet.MIN_OPTIONS,
    maxOptions: Bet.MAX_OPTIONS,
    feePercent: config.creatorFeePercent,
    minDeadline: toZonedLocalInput(new Date(Date.now() + 10 * 60 * 1000), config.timezone),
  });
}

router.get('/wetten/neu', requireLogin, (req, res) => newBetForm(req, res));

router.post('/wetten', requireLogin, async (req, res) => {
  const rawOptions = [].concat(req.body.options || []).slice(0, 20).map((o) => str(o).trim().replace(/\s+/g, ' '));
  const values = {
    title: str(req.body.title).trim().replace(/\s+/g, ' '),
    description: str(req.body.description).trim().replace(/\r\n/g, '\n'),
    type: str(req.body.type) === 'optionen' ? 'optionen' : 'janein',
    options: rawOptions,
    referee: str(req.body.referee),
    group: str(req.body.group),
    deadline: str(req.body.deadline),
    resultAt: str(req.body.resultAt),
  };
  const deadline = parseZonedLocal(values.deadline, config.timezone);
  const resultAt = parseZonedLocal(values.resultAt, config.timezone);
  const now = Date.now();
  const YEAR = 366 * 24 * 60 * 60 * 1000;

  // Fehler mit dem Schritt des Assistenten (views/new-bet.ejs): 0 Frage, 1 Antworten, 2 Details, 3 Schiedsrichter, 4 Zeitplan
  const errors = [];
  let errorStep = null;
  const fail = (step, msg) => {
    errors.push(msg);
    if (errorStep === null || step < errorStep) errorStep = step;
  };
  if (values.title.length < 5 || values.title.length > 140) fail(0, 'Der Titel muss 5–140 Zeichen lang sein.');
  if (values.description.length > 2000) fail(2, 'Die Beschreibung darf höchstens 2000 Zeichen lang sein.');
  if (!values.deadline) fail(4, 'Bitte gib den Einsatzschluss an (Datum und Uhrzeit).');
  else if (!deadline) fail(4, 'Bitte gib einen gültigen Einsatzschluss an.');
  else if (deadline.getTime() < now + 5 * 60 * 1000) fail(4, 'Der Einsatzschluss muss mindestens 5 Minuten in der Zukunft liegen.');
  else if (deadline.getTime() > now + YEAR) fail(4, 'Der Einsatzschluss darf höchstens ein Jahr in der Zukunft liegen.');
  if (!values.resultAt) fail(4, 'Bitte gib den Termin der Auswertung an (Datum und Uhrzeit).');
  else if (!resultAt) fail(4, 'Bitte gib einen gültigen Termin für die Auswertung an.');
  else if (deadline && resultAt < deadline) fail(4, 'Die Auswertung kann nicht vor dem Einsatzschluss liegen.');
  else if (deadline && resultAt.getTime() > deadline.getTime() + YEAR) fail(4, 'Die Auswertung darf höchstens ein Jahr nach dem Einsatzschluss liegen.');

  // Schiedsrichter: Pflicht, muss ein anderes, existierendes Mitglied sein
  let referee = null;
  if (!values.referee) {
    fail(3, 'Bitte wähle einen Schiedsrichter aus, der das Ergebnis mit dir bestätigt.');
  } else if (!mongoose.isValidObjectId(values.referee) || values.referee === String(req.user._id)) {
    fail(3, 'Bitte wähle ein anderes Mitglied als Schiedsrichter aus.');
  } else {
    referee = await User.findOne({ _id: values.referee, deletedAt: null }).select('username').lean();
    if (!referee) fail(3, 'Dieses Mitglied gibt es nicht mehr. Bitte wähle einen anderen Schiedsrichter.');
  }

  // Gruppe (optional): nur eine eigene, aktive Gruppe; der Schiedsrichter muss die Wette sehen können
  let group = null;
  if (values.group) {
    group = (await groups.groupsOf(req.user._id)).find((g) => String(g._id) === values.group) || null;
    if (!group) fail(3, 'Diese Gruppe gibt es nicht (mehr) oder du bist kein Mitglied.');
    else if (referee && !group.members.some((id) => id.equals(referee._id))) fail(3, `Der Schiedsrichter muss Mitglied der Gruppe „${group.name}“ sein.`);
  }

  let options;
  if (values.type === 'janein') {
    options = JA_NEIN;
  } else {
    const filled = rawOptions.filter(Boolean);
    const lower = filled.map((o) => o.toLowerCase());
    if (filled.length < Bet.MIN_OPTIONS) fail(1, `Bitte gib mindestens ${Bet.MIN_OPTIONS} Optionen an.`);
    if (filled.length > Bet.MAX_OPTIONS) fail(1, `Es sind höchstens ${Bet.MAX_OPTIONS} Optionen möglich.`);
    if (filled.some((o) => o.length > 60)) fail(1, 'Eine Option darf höchstens 60 Zeichen lang sein.');
    if (new Set(lower).size !== lower.length) fail(1, 'Jede Option darf nur einmal vorkommen.');
    options = filled.map((label, i) => ({ key: `o${i + 1}`, label }));
  }

  if (errors.length) return newBetForm(req, res, { errors, errorStep, values }, 400);

  const bet = await svc.createBet({
    user: req.user,
    title: values.title,
    description: values.description,
    type: values.type,
    options,
    referee,
    group,
    deadline,
    resultAt,
  });
  req.flash(
    'success',
    group
      ? `Deine Wette ist online – nur die Mitglieder der Gruppe „${group.name}“ sehen sie. ${referee.username} bestätigt am Ende das Ergebnis mit dir.`
      : `Deine Wette ist online! ${referee.username} bestätigt am Ende das Ergebnis mit dir. Teile den Link, damit andere mitwetten können.`
  );
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
  const isReferee = !!me && !!bet.referee && String(bet.referee) === String(me._id);
  const isAdmin = !!me && me.isAdmin;
  const isStaff = !!me && me.isStaff; // Admin oder Dev: entscheiden, annullieren, schließen
  const isOpen = bet.status === 'offen';
  const accepting = isOpen && bet.deadline > now;
  // Rolle bei der Ergebnisfindung – die eigene Beteiligung wiegt schwerer als die Dev-Rolle
  const role = me ? verdictRole(bet, me) : null;
  // Ohne Schiedsrichter (alte Wetten) entscheidet der Ersteller allein; ein unbeteiligter Dev immer
  // Duell: allein der Schiedsrichter entscheidet; die beiden Beteiligten nie (auch nicht als Dev)
  const duelRole = bet.duel ? duels.duelRole(bet, me) : null;
  const duelActive = !!bet.duel && bet.duel.state === 'aktiv';
  const canDecide = bet.duel ? (duelRole === 'referee' && duelActive) || (!duelRole && role === 'dev' && duelActive) : !!role;
  const decidesAlone = role === 'dev' || (role === 'creator' && !bet.referee) || (!!bet.duel && canDecide);
  // Duell (#67): Zuschauer haben einen eigenen Topf – Summen und Quoten nur aus ihren Einsätzen
  let duelView = null;
  if (bet.duel) {
    const party = [String(bet.creator), String(bet.duel.opponent)];
    const spect = { o1: 0, o2: 0 };
    positions.filter((p) => !party.includes(String(p.user))).forEach((p) => { spect[p.side] = (spect[p.side] || 0) + p.amount; });
    const spectTotal = spect.o1 + spect.o2;
    const fee = bet.creatorFeePercent || 0;
    const q = (k) => {
      const v = rawQuote(spect[k], spectTotal - spect[k], fee);
      return v === null ? '–' : `${v.toFixed(2).replace('.', ',')}×`;
    };
    duelView = {
      spect,
      spectTotal,
      spectCount: positions.filter((p) => !party.includes(String(p.user))).length,
      quote: { o1: q('o1'), o2: q('o2') },
      cards: (bet.duel.cards || []).map((c) => ({ ...c, info: catalog.cardById[c.card] || null, rarityInfo: catalog.rarityByKey[c.rarity] || null })),
      cardRarity: bet.duel.cardRarity ? catalog.rarityByKey[bet.duel.cardRarity] : null,
      // Herausgeforderter vor dem Annehmen: passende eigene Karten
      myCards: duelRole === 'opponent' && bet.duel.state === 'angefragt' && !bet.duel.opponentAcceptedAt && bet.duel.cardRarity ? await duels.eligibleCards(me._id, bet.duel.cardRarity) : null,
    };
  }
  const myVote = (bet.votes || []).find((v) => v.role === role) || null;

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
    isReferee,
    role,
    decidesAlone,
    myVote,
    accepting,
    noteMin: svc.NOTE_MIN,
    noteMax: svc.NOTE_MAX,
    duelRole,
    duelView,
    duelFeePercent: duels.DUEL_FEE_PERCENT,
    perms: {
      // Wettersteller und Schiedsrichter dürfen an dieser Wette nicht teilnehmen; im Duell setzen Zuschauer,
      // sobald es läuft – die beiden Beteiligten nicht
      stake: !!me && accepting && !isOwner && !isReferee && (!bet.duel || (duelActive && !duelRole)),
      // Ersteller und Schiedsrichter dürfen jederzeit eine Stimme abgeben (Duell: siehe canDecide);
      // ein unbeteiligter Dev legt ein Ergebnis nur im Streitfall oder nach dem Auswertungstermin fest
      resolve: isOpen && canDecide && (role !== 'dev' || devMayDecide(bet, null, now)),
      void: isOpen && canDecide,
      close: accepting && !bet.duel && (isOwner || isReferee || isStaff),
      edit: (isOwner && isOpen) || isAdmin,
      remove: isStaff, // vollständig löschen: Admin und Devs
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

/** Provisionsteil der Rückmeldung: Wettersteller und Schiedsrichter teilen sich die Provision. */
function feeText(r) {
  if (!r.fee) return '';
  if (!r.refereeFee) return ` Provision für den Wettersteller: ${euro(r.creatorFee)}.`;
  if (!r.creatorFee) return ` Provision für den Schiedsrichter: ${euro(r.refereeFee)}.`; // Duell
  return ` Provision: ${euro(r.creatorFee)} für den Wettersteller und ${euro(r.refereeFee)} für den Schiedsrichter.`;
}

/** Rückmeldung nach einer Stimme: ausgezahlt, auf die Gegenseite wartend oder strittig. */
function voteMessage(r, what) {
  if (r.kind === 'offen') {
    return `Deine Stimme für ${what} ist gespeichert. Jetzt muss ${r.other} dasselbe eintragen – erst dann wird ausgezahlt. Weitere Einsätze sind ab sofort nicht mehr möglich.`;
  }
  if (r.kind === 'streitig') {
    return `Deine Stimme für ${what} weicht von der Stimme von ${r.other} ab. Die Wette ist damit strittig – ein Dev entscheidet. Du kannst deine Stimme bis dahin noch ändern.`;
  }
  if (r.outcome === 'annulliert') return 'Die Wette wurde annulliert. Alle Einsätze wurden erstattet.';
  if (r.refunded) return `Ergebnis „${r.label}“ gespeichert. Da es keine Gegenseite gab, wurden alle Einsätze erstattet.`;
  return `Ergebnis „${r.label}“ gespeichert. ${euro(r.paidTotal)} wurden an ${r.winnerCount} Gewinner ausgezahlt.${feeText(r)}`;
}

router.post('/wetten/:id/entscheiden', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const outcome = str(req.body.outcome);
    if (!outcome || outcome === 'annulliert') throw new UserError('Bitte wähle aus, welche Option eingetreten ist.');
    const r = await svc.resolveBet({ actor: req.user, betId: req.params.id, outcome, note: str(req.body.note) });
    return voteMessage(r, `„${r.label}“`);
  })
);

router.post('/wetten/:id/annullieren', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const r = await svc.resolveBet({ actor: req.user, betId: req.params.id, outcome: 'annulliert', note: str(req.body.note) });
    return voteMessage(r, 'eine Annullierung');
  })
);

// ---------- Duelle (Head-to-Head) ----------

/**
 * Formular "Herausfordern" (Assistent wie bei "Neue Wette", #93): Gegner wählbar – vorausgewählt, wenn man vom
 * Profil kommt (?gegen=Name). Schiedsrichter: jedes andere Mitglied außer den beiden Beteiligten (prüft der Server).
 * Einsatz: Geld und/oder eine eigene Karte ab Gold (#67).
 */
async function duelForm(req, res, { errors = [], errorStep = 0, values = {} } = {}, status = 200) {
  const preset = values.opponent !== undefined ? values.opponent : str(req.query.gegen).trim();
  const [members, cards] = await Promise.all([refereeCandidates(req.user._id), duels.eligibleCards(req.user._id)]);
  const opponent = preset ? members.find((u) => u.username.toLowerCase() === preset.toLowerCase()) || null : null;
  res.status(status).render('duell-neu', {
    title: opponent ? `${opponent.username} herausfordern` : 'Neues Duell',
    opponent,
    members,
    candidates: members,
    cards,
    minCardRarity: catalog.rarityByKey[duels.MIN_CARD_RARITY],
    errors,
    errorStep,
    values: { title: '', description: '', stake: '', card: '', referee: '', resultAt: '', ...values, opponent: opponent ? opponent.username : values.opponent || '' },
    feePercent: duels.DUEL_FEE_PERCENT,
    inviteHours: duels.INVITE_HOURS,
    minDeadline: toZonedLocalInput(new Date(Date.now() + 10 * 60 * 1000), config.timezone),
  });
}

router.get('/duell/neu', requireLogin, (req, res) => duelForm(req, res));

router.post('/duell', requireLogin, async (req, res) => {
  const values = {
    opponent: str(req.body.opponent).trim(),
    title: str(req.body.title).trim().replace(/\s+/g, ' '),
    description: str(req.body.description).trim().replace(/\r\n/g, '\n'),
    stake: str(req.body.stake).trim(),
    card: str(req.body.card).trim(),
    referee: str(req.body.referee),
    resultAt: str(req.body.resultAt),
  };
  // Fehler mit dem Schritt des Assistenten, auf dem das Feld steht
  const errors = [];
  let errorStep = null;
  const fail = (step, msg) => { errors.push(msg); if (errorStep === null) errorStep = step; };
  const opponent = values.opponent ? await User.findOne({ usernameLower: values.opponent.toLowerCase(), deletedAt: null }).select('username').lean() : null;
  if (!opponent) fail(0, 'Bitte wähle aus, wen du herausfordern möchtest.');
  else if (opponent._id.equals(req.user._id)) fail(0, 'Du kannst dich nicht selbst herausfordern.');
  if (values.title.length < 5 || values.title.length > 140) fail(1, 'Die Behauptung muss 5–140 Zeichen lang sein.');
  if (values.description.length > 2000) fail(1, 'Die Beschreibung darf höchstens 2000 Zeichen lang sein.');
  const stake = values.stake === '' ? 0 : parseEuro(values.stake);
  const cardId = values.card || null;
  if (stake === null) fail(2, 'Bitte gib einen gültigen Betrag an.');
  else if (stake === 0 && !cardId) fail(2, 'Setze Geld, eine Karte oder beides.');
  else if (stake > 0 && stake < config.minStake) fail(2, `Der Geldeinsatz muss mindestens ${euro(config.minStake)} betragen (oder 0 € mit einer Karte).`);
  else if (stake > req.user.balance) fail(2, 'Dein Guthaben reicht für diesen Einsatz nicht aus.');
  const referee = mongoose.isValidObjectId(values.referee) ? await User.findOne({ _id: values.referee, deletedAt: null }).select('username').lean() : null;
  if (!referee) fail(3, 'Bitte wähle einen Schiedsrichter aus.');
  const resultAt = parseZonedLocal(values.resultAt, config.timezone);
  if (!resultAt) fail(4, 'Bitte gib den Termin der Auswertung an (Datum und Uhrzeit).');
  if (!errors.length) {
    try {
      const bet = await duels.create({ user: req.user, opponent, referee, title: values.title, description: values.description, stake, cardId, resultAt });
      const what = duels.stakeText(stake, bet.duel.cards[0]);
      req.flash('success', `Herausforderung verschickt! Sobald ${opponent.username} und Schiedsrichter ${referee.username} angenommen haben, gilt das Duell. Bis dahin ist dein Einsatz (${what}) reserviert.`);
      return res.redirect(`/wetten/${bet._id}`);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      fail(2, err.message);
    }
  }
  duelForm(req, res, { errors, errorStep: errorStep || 0, values }, 400);
});

router.post('/wetten/:id/duell/annehmen', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const r = await duels.accept({ user: req.user, betId: req.params.id, cardId: str(req.body.card) || null });
    if (r.started) return 'Das Duell läuft! Zuschauer können jetzt mitwetten; der Schiedsrichter entscheidet zum Termin der Auswertung.';
    const mine = r.bet.duel.cards.find((c) => c.side === 'o2');
    return r.role === 'opponent'
      ? `Herausforderung angenommen – dein Einsatz (${duels.stakeText(r.bet.duel.stake, mine)}) ist gesetzt. Jetzt fehlt noch die Zusage des Schiedsrichters.`
      : 'Du hast als Schiedsrichter zugesagt. Jetzt fehlt noch die Zusage des Herausgeforderten.';
  })
);

router.post('/wetten/:id/duell/absagen', validId, requireLogin, (req, res) =>
  action(req, res, async () => {
    const r = await duels.decline({ user: req.user, betId: req.params.id });
    return r.role === 'challenger' ? 'Herausforderung zurückgezogen – dein Einsatz wurde erstattet.' : 'Abgelehnt. Der Herausforderer bekommt seinen Einsatz zurück.';
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

// Wette vollständig löschen (Admin/Dev): offene Einsätze gehen zurück, nichts bleibt im Archiv
router.post('/wetten/:id/loeschen', validId, requireLogin, async (req, res) => {
  try {
    const r = await svc.deleteBet({ actor: req.user, betId: req.params.id });
    req.flash('success', `Wette „${r.title}“ gelöscht.${r.refunded ? ' Alle Einsätze wurden erstattet.' : ''}`);
    return res.redirect('/wetten');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    return res.redirect(`/wetten/${req.params.id}`);
  }
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
      if (!isAuthor && !req.user.canModerate) throw new UserError('Du kannst nur deine eigenen Kommentare löschen.');
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
