const express = require('express');
const mongoose = require('mongoose');
const { requireLogin } = require('../middleware');
const catalog = require('../tcg/catalog');
const dungeon = require('../dungeon/dungeonService');
const { dungeonByKey, dungeonForSlot } = require('../dungeon/dungeons');
const { str, UserError } = require('../lib/util');
const config = require('../config');
const { toZonedLocalInput } = require('../lib/time');

const router = express.Router();

// Zugang: für alle, wenn im Admin-Panel freigegeben – sonst nur Admins
function requireDungeon(req, res, next) {
  if (dungeon.settings.open || req.user.isAdmin) return next();
  if (req.method !== 'GET') {
    req.flash('error', 'Der Dungeon ist derzeit nicht verfügbar.');
    return res.redirect('/dungeon');
  }
  res.render('error', { title: 'Dungeon', status: 'Dungeon', message: 'Der Dungeon ist derzeit nicht verfügbar. Schau später wieder vorbei!' });
}
router.use('/dungeon', requireLogin, requireDungeon);

const same = (a, b) => a && b && String(a) === String(b);

/** Platz für die Anzeige: Karte, Boost, Name, Leiter, ich */
const slotView = (m, me, leaderId) => {
  const card = catalog.cardById[m.card];
  return {
    name: m.name,
    bot: !m.user,
    me: same(m.user, me),
    leader: m.leader === true || same(m.user, leaderId),
    card,
    boost: m.boost ? catalog.cardById[m.boost] : null,
    reward: m.reward,
    foil: m.foil,
    bossCard: m.bossCard,
  };
};

/** Daten für die Wiedergabe im Browser (public/js/dungeon.js) */
const playback = (run, d, now) => ({
  now,
  startedAt: new Date(run.startedAt).getTime(),
  endsAt: new Date(run.endsAt).getTime(),
  intro: dungeon.INTRO_SECONDS,
  fightSeconds: dungeon.FIGHT_SECONDS, // volle Zeit eines Kampfes in echten Sekunden (Zeit-Balken)
  names: run.members.map((m) => m.name),
  pause: dungeon.PAUSE_SECONDS,
  fights: run.fights.map((f, i) => {
    const def = d.fights[i] || {};
    return { title: def.title, text: def.text, successText: def.success, failText: def.fail, boss: f.boss, required: f.required, limit: f.limit, seconds: f.seconds, success: f.success, doneAt: f.doneAt, ticks: f.ticks, abilities: f.abilities };
  }),
});

router.get('/dungeon', async (req, res) => {
  const me = req.user._id;
  const now = Date.now();
  const { party, invitations, run, rev } = await dungeon.pageState(me);
  const running = run && run.status === 'laeuft' ? run : null;
  const slot = party ? party.slot : dungeon.registrationSlot(now);
  const next = dungeonForSlot(slot, dungeon.settings.intervalHours);
  const runDungeon = run ? dungeonByKey[run.dungeon] : null;

  let phase = 'frei';
  if (running) phase = 'laeuft';
  else if (party) phase = party.solo ? 'solo' : 'gruppe';

  let slots = [];
  if (running) slots = running.members.map((m) => slotView(m, me));
  else if (party) {
    slots = party.members.map((m) => slotView(m, me, party.leader));
    party.invites.forEach((i) => slots.push({ invited: true, name: i.name, userId: String(i.user) }));
  }
  while (slots.length < dungeon.TEAM_SIZE) slots.push({ empty: true, solo: phase === 'solo' });

  const needCards = phase === 'frei';
  const cards = needCards ? await dungeon.availableCards(me) : null;

  res.render('dungeon', {
    title: 'Dungeon',
    phase,
    party,
    isLeader: party && same(party.leader, me),
    invitations: invitations.map((p) => ({ id: String(p._id), leader: (p.members.find((m) => same(m.user, p.leader)) || p.members[0] || {}).name, members: p.members.map((m) => m.name), slot: p.slot })),
    slots,
    slot,
    slotTime: toZonedLocalInput(new Date(slot), config.timezone).slice(11, 16),
    lockSeconds: dungeon.LOCK_SECONDS,
    lockedIn: party ? dungeon.isLockedIn(party.slot, now) : false,
    dg: running ? runDungeon : next,
    nextDungeon: next,
    run,
    runDungeon,
    resultSlots: run && run.status === 'fertig' ? run.members.map((m) => slotView(m, me)) : null,
    playback: running && runDungeon ? playback(running, runDungeon, now) : null,
    hasChat: Boolean(running || (party && !party.solo)),
    cards,
    rarityByKey: catalog.rarityByKey,
    settings: dungeon.settings,
    chatMax: dungeon.CHAT_TEXT_MAX,
    rev,
    closedForOthers: !dungeon.settings.open,
  });
});

// Für die Seite: Fingerabdruck (bei Änderung neu laden) und Chat
router.get('/dungeon/status', async (req, res) => {
  const [{ rev }, chat] = await Promise.all([dungeon.pageState(req.user._id), dungeon.chatFor(req.user._id)]);
  res.set('Cache-Control', 'no-store');
  res.json({
    rev,
    chat: chat ? chat.map((c) => ({ name: c.name, text: c.text, at: c.at, me: same(c.user, req.user._id) })) : null,
  });
});

async function handle(req, res, fn) {
  try {
    const msg = await fn();
    if (msg) req.flash('success', msg);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/dungeon');
}

const partyId = (req) => {
  const id = str(req.body.party);
  if (!mongoose.isValidObjectId(id)) throw new UserError('Diese Einladung gibt es nicht mehr.');
  return id;
};

router.post('/dungeon/anmelden', (req, res) =>
  handle(req, res, () => dungeon.register({ user: req.user, cardId: str(req.body.card), boostId: str(req.body.boost) || null, solo: str(req.body.mode) !== 'gruppe' }).then(() => null))
);

router.post('/dungeon/einladen', (req, res) => handle(req, res, () => dungeon.invite({ user: req.user, name: str(req.body.name) }).then(() => null)));

router.post('/dungeon/einladung-zurueck', (req, res) =>
  handle(req, res, async () => {
    const id = str(req.body.user);
    if (mongoose.isValidObjectId(id)) await dungeon.cancelInvite({ user: req.user, inviteeId: new mongoose.Types.ObjectId(id) });
    return null;
  })
);

router.post('/dungeon/beitreten', (req, res) =>
  handle(req, res, () => dungeon.accept({ user: req.user, partyId: partyId(req), cardId: str(req.body.card), boostId: str(req.body.boost) || null }).then(() => null))
);

router.post('/dungeon/ablehnen', (req, res) => handle(req, res, () => dungeon.decline({ user: req.user, partyId: partyId(req) }).then(() => null)));

router.post('/dungeon/verlassen', (req, res) => handle(req, res, () => dungeon.leave({ user: req.user }).then(() => null)));

// Chat-Nachricht (per fetch aus public/js/dungeon.js)
router.post('/dungeon/chat', async (req, res) => {
  try {
    await dungeon.chat({ user: req.user, text: str(req.body.text) });
    res.json({ ok: true });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Nur Admins: alle Anmeldungen sofort starten (zum Ausprobieren, ohne auf den Termin zu warten)
router.post('/dungeon/sofort-starten', (req, res) =>
  handle(req, res, async () => {
    if (!req.user.isAdmin) throw new UserError('Nur für Admins.');
    const n = await dungeon.startDue({ force: true });
    if (!n) throw new UserError('Keine Anmeldungen zum Starten.');
    return null;
  })
);

module.exports = router;
