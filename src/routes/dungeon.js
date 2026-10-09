const express = require('express');
const mongoose = require('mongoose');
const { requireLogin } = require('../middleware');
const catalog = require('../tcg/catalog');
const dungeon = require('../dungeon/dungeonService');
const { DUNGEONS, defOf, dungeonForSlot, TOWER } = require('../dungeon/dungeons');
const { floorByKey } = require('../dungeon/tower');
const LIVE = require('../dungeon/liveTower');
const liveTower = require('../dungeon/liveTowerService');
const { EsportsTeam } = require('../models/Esports');
const { str, UserError } = require('../lib/util');
const config = require('../config');
const { toZonedLocalInput } = require('../lib/time');
const cardBans = require('../tcg/cardBans');
const { usedCards, pickShortcuts } = require('../lib/pickShortcuts');

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

/** Platz für die Anzeige: Karte, Boost, Name, Leiter, ich. In der Lobby darf die Karte noch fehlen (choosing). */
/** banMode: Modus einer noch nicht gestarteten Anmeldung – dann zeigt der Platz, ob eine gewählte Karte gesperrt ist */
const slotView = (m, me, leaderId, banMode = null) => {
  const card = m.card ? catalog.cardById[m.card] : null;
  return {
    banned: !!banMode && (cardBans.isBanned(m.card, banMode) || cardBans.isBanned(m.boost, banMode)),
    choosing: !card,
    name: m.name,
    bot: !m.user,
    me: same(m.user, me),
    leader: m.leader === true || same(m.user, leaderId),
    card,
    boost: m.boost ? catalog.cardById[m.boost] : null,
    reward: m.reward,
    foil: m.foil,
    bossCard: m.bossCard,
    // Live-Turm (eSports): Vorrat und Bereit
    coffee: m.coffee && m.coffeeDoc ? catalog.cardById[m.coffee] : null,
    energy: !!m.energyDoc,
    ready: !!m.ready,
  };
};

/** Daten für die Wiedergabe im Browser (public/js/dungeon.js). Turm: Runden ohne Gesamtzahl, Texte je Begegnung. */
const playback = (run, d, now) => ({
  now,
  tower: run.mode === 'tower',
  startedAt: new Date(run.startedAt).getTime(),
  endsAt: new Date(run.endsAt).getTime(),
  intro: dungeon.INTRO_SECONDS,
  fightSeconds: run.fightSeconds || dungeon.FIGHT_SECONDS, // volle Zeit eines Kampfes in echten Sekunden (Zeit-Balken)
  names: run.members.map((m) => m.name),
  // je Platz: Kartenbilder mit geänderten Werten (Boost/Debuff) – nur Rahmen-Karten; base = Grundbild
  cards: run.members.map((m, i) => {
    const card = catalog.cardById[m.card];
    const ticks = run.fights.flatMap((f) => f.ticks.filter((x) => x.m === i));
    return card && card.stats ? { base: card.image, stats: [card.stats.speed, card.stats.fia, card.stats.fis, card.stats.bwl], imgs: catalog.statImages(card, ticks) } : null;
  }),
  pause: run.pause ?? dungeon.PAUSE_SECONDS,
  fights: run.fights.map((f, i) => {
    const def = (run.mode === 'tower' ? floorByKey[f.key] : d.fights[i]) || {};
    return { round: i + 1, title: def.title, text: def.text, successText: def.success, failText: def.fail, boss: f.boss, required: f.required, limit: f.limit || 180, seconds: f.seconds || dungeon.FIGHT_SECONDS, start: f.start || 0, success: f.success, doneAt: f.doneAt, ticks: f.ticks, abilities: f.abilities };
  }),
});

router.get('/dungeon', async (req, res) => {
  const me = req.user._id;
  const now = Date.now();
  await dungeon.finishOwnDue(me);
  const [{ party, invitations, run, unseen, rev }, rareLoot, towerLeft] = await Promise.all([dungeon.pageState(me), dungeon.rareLoot(), dungeon.towerRunsLeft(me)]);
  const running = run && run.status === 'laeuft' ? run : null;
  if (running && running.live) return res.redirect('/dungeon/live'); // eSports-Live-Turm hat eine eigene Seite
  // Mage Tower: eigene Anmeldung ohne Termin (der Leiter startet) – oder ein laufender Turm-Durchlauf
  const tower = running ? running.mode === 'tower' : !!party && party.mode === 'tower';
  const slot = party && !tower ? party.slot : dungeon.registrationSlot(now);
  const next = dungeonForSlot(slot, dungeon.settings.intervalHours);
  const runDungeon = run ? defOf(run.dungeon) || DUNGEONS[0] : null; // alte Läufe: Dungeon gibt es nicht mehr

  let phase = 'frei';
  if (running) phase = 'laeuft';
  else if (party) phase = party.solo ? 'solo' : 'gruppe';

  let slots = [];
  if (running) slots = running.members.map((m) => slotView(m, me));
  else if (party) {
    slots = party.members.map((m) => slotView(m, me, party.solo ? null : party.leader, dungeon.modeOf(party))); // Solo Queue: kein Gruppenleiter
    party.invites.forEach((i) => slots.push({ invited: true, name: i.name, userId: String(i.user) }));
  }
  while (slots.length < dungeon.TEAM_SIZE) slots.push({ empty: true, solo: phase === 'solo' });

  // Kartenauswahl in der Lobby (eigene Dungeon-Karten zählen als frei); vor dem Beitritt nur für die Start-Kacheln
  const mine = party ? party.members.find((m) => same(m.user, me)) : null;
  const cards = phase === 'laeuft' ? null : await dungeon.availableCards(me, { ownDungeon: !!party, mode: dungeon.modeOf(party) });
  // Favoriten oben; ohne Favoriten ein Knopf mit den am häufigsten gespielten Karten (je Modus)
  let shortcuts = null;
  if (cards && party) {
    const usage = await usedCards(me, dungeon.modeOf(party));
    shortcuts = { card: pickShortcuts(cards.characters, req.user.tcgFavorites, usage.card), boost: pickShortcuts(cards.boosts, req.user.tcgFavorites, usage.boost) };
  }
  // Start-Kacheln (wie "Zum Album"): eigene Charaktere als Fächer, fehlende als graue Beispielkarten
  const samples = catalog.CARDS.filter((c) => c.isCharacter && !(catalog.rarityByKey[c.rarity] || {}).hidden);
  const fanOf = (n) => {
    const own = (cards ? cards.characters.filter((c) => cards.counts[c.id] > 0) : []).slice(0, n).map((card) => ({ card, sample: false }));
    for (let i = 0; own.length < n && i < samples.length; i++) if (!own.some((f) => f.card.id === samples[i].id)) own.push({ card: samples[i], sample: true });
    return own;
  };
  const startFans = phase === 'frei' ? { solo: fanOf(1), gruppe: fanOf(3) } : null;
  // eSports-Team in der Turm-Lobby: Live-Lauf mit Vorrat (Kaffee, Energy) und Bereit
  const esTeamId = tower && party && !party.solo && phase === 'gruppe' ? await dungeon.esportsLobby(party, now) : null;
  const esLobby = !!esTeamId;
  const esTeam = esTeamId ? await EsportsTeam.findById(esTeamId).select('name ticker').lean() : null;
  // frei = eigene Exemplare ohne die als Haupt- oder Boost-Karte gewählten (die eigenen Vorrats-Exemplare zählen als frei)
  const inUse = (id) => (mine ? [mine.card, mine.boost].filter((x) => x === id).length : 0);
  const freeOf = (id) => (cards ? Math.max(0, (cards.counts[id] || 0) - inUse(id)) : 0);
  const coffeeChoices = esLobby ? Object.entries(LIVE.COFFEE).map(([id, pct]) => ({ id, pct, card: catalog.cardById[id], free: freeOf(id), asBoost: !!mine && mine.boost === id })).filter((c) => c.card) : [];

  // Beute-Fenster: einmal nach dem Ende des Durchlaufs
  // (bleibt, bis es mit „Weiter“ geschlossen wird – auch nach Neuladen oder einem Besuch anderer Seiten)
  const lootTower = !!unseen && unseen.mode === 'tower';
  const loot = unseen
    ? {
        id: String(unseen._id),
        success: unseen.success,
        tower: lootTower,
        rounds: unseen.rounds || 0,
        result: lootTower ? dungeon.towerResultText(unseen.rounds || 0) : null,
        bossCard: dungeon.bossCardOf(unseen.dungeon),
        players: unseen.members.map((m) => ({ name: m.name, bot: !m.user, me: same(m.user, me), reward: m.reward, foil: m.foil, bossCard: m.bossCard })),
      }
    : null;

  res.render('dungeon', {
    title: 'Dungeon',
    phase,
    party,
    isLeader: party && same(party.leader, me),
    invitations: invitations.map((p) => ({ id: String(p._id), tower: p.mode === 'tower', leader: (p.members.find((m) => same(m.user, p.leader)) || p.members[0] || {}).name, members: p.members.map((m) => m.name), slot: p.slot })),
    slots,
    slot,
    slotTime: toZonedLocalInput(new Date(slot), config.timezone).slice(11, 16),
    lockSeconds: dungeon.LOCK_SECONDS,
    lockedIn: party ? dungeon.partyLocked(party, now) : false,
    dg: running ? runDungeon : tower ? TOWER : next,
    tower,
    // Turm-Kacheln vor dem Beitritt: verfügbar? heute schon gespielt? Startet der Leiter erst, wenn alle gewählt haben
    towerShown: dungeon.towerOpen(req.user),
    towerTitle: TOWER.title,
    towerPlayed: towerLeft <= 0,
    towerLeft,
    towerRuns: dungeon.settings.tower.dailyRuns,
    esLobby,
    esTeam,
    coffeePct: LIVE.COFFEE,
    coffeeChoices,
    energyFree: esLobby ? freeOf(LIVE.ENERGY_CARD) : 0,
    energyAsBoost: esLobby && !!mine && mine.boost === LIVE.ENERGY_CARD,
    allReady: !!party && party.members.every((m) => m.ready),
    towerReady: tower && !!party && party.members.every((m) => m.card && !cardBans.isBanned(m.card, 'tower') && !cardBans.isBanned(m.boost, 'tower') && !dungeon.towerDuplicate(party.members, m.user, m.card, m.boost)),
    // Mage Tower: Karten, die Mitspieler schon gewählt haben (jede Karte nur einmal im Team)
    teamTaken: tower && party ? dungeon.teamTaken(party.members, me) : new Set(),
    towerSettings: dungeon.settings.tower,
    nextDungeon: next,
    run,
    runDungeon,
    resultSlots: run && run.status === 'fertig' ? run.members.map((m) => slotView(m, me)) : null,
    playback: running && runDungeon ? playback(running, runDungeon, now) : null,
    hasChat: Boolean(running || (party && !party.solo)),
    cards,
    shortcuts,
    startFans,
    current: mine ? { card: mine.card, boost: mine.boost } : null,
    loot,
    rareLoot,
    rarityByKey: catalog.rarityByKey,
    settings: dungeon.settings,
    chatMax: dungeon.CHAT_TEXT_MAX,
    rev,
    closedForOthers: !dungeon.settings.open,
    towerClosedForOthers: !dungeon.settings.open || !dungeon.settings.tower.open,
  });
});

// Für die Seite: Fingerabdruck (bei Änderung neu laden) und Chat
router.get('/dungeon/status', async (req, res) => {
  await dungeon.finishOwnDue(req.user._id); // Ende sofort auswerten, sobald die Zeit um ist
  const [{ rev }, chat] = await Promise.all([dungeon.pageState(req.user._id), dungeon.chatFor(req.user._id)]);
  res.set('Cache-Control', 'no-store');
  res.json({
    rev,
    chat: chat ? chat.map((c) => ({ name: c.name, text: c.text, at: c.at, me: same(c.user, req.user._id) })) : null,
  });
});

// Nach einer Aktion zurück zu den Plätzen (#111: kein Suchen nach der Lobby unter dem Bild);
// bei einem Fehler oben bleiben, dort steht die Meldung
async function handle(req, res, fn) {
  try {
    const msg = await fn();
    if (msg) req.flash('success', msg);
    res.redirect(msg ? '/dungeon' : '/dungeon#dg-tisch');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
    res.redirect('/dungeon');
  }
}

const partyId = (req) => {
  const id = str(req.body.party);
  if (!mongoose.isValidObjectId(id)) throw new UserError('Diese Einladung gibt es nicht mehr.');
  return id;
};

router.post('/dungeon/anmelden', (req, res) =>
  handle(req, res, () => dungeon.register({ user: req.user, solo: str(req.body.mode) !== 'gruppe' }).then(() => null))
);

// Mage Tower: anmelden (allein oder als Gruppe) und – als Leiter – betreten
router.post('/dungeon/turm/anmelden', (req, res) =>
  handle(req, res, () => dungeon.registerTower({ user: req.user, solo: str(req.body.mode) !== 'gruppe' }).then(() => null))
);

router.post('/dungeon/turm/starten', (req, res) => handle(req, res, () => dungeon.startTower({ user: req.user }).then(() => null)));

router.get('/dungeon/anleitung', (req, res) =>
  res.render('dungeon-anleitung', { title: 'Dungeon – So funktioniert\'s', settings: dungeon.settings, lockSeconds: dungeon.LOCK_SECONDS, towerShown: dungeon.towerOpen(req.user) })
);

// Ganze Geschichte eines Dungeons – der Titel im Banner verlinkt hierher
router.get('/dungeon/geschichte/:key', (req, res, next) => {
  const dg = DUNGEONS.find((d) => d.key === req.params.key && d.story);
  if (!dg) return next();
  res.render('dungeon-geschichte', { title: `Dungeon – ${dg.title}`, dg });
});

// Karten in der Lobby wählen: aus dem Auswahl-Fenster per fetch (JSON, Fehler erscheinen im Fenster), sonst wie gewohnt
const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');
router.post('/dungeon/karten', async (req, res) => {
  const pick = () => dungeon.changeCards({ user: req.user, cardId: str(req.body.card) || null, boostId: str(req.body.boost) || null });
  if (!wantsJson(req)) return handle(req, res, () => pick().then(() => null));
  try {
    await pick();
    res.json({ ok: true });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Beute-Fenster geschlossen (per fetch)
router.post('/dungeon/beute-gesehen', async (req, res) => {
  const id = str(req.body.run);
  if (mongoose.isValidObjectId(id)) await dungeon.markLootSeen(id, req.user._id);
  res.json({ ok: true });
});

// Vorschläge fürs Einladen-Feld (per fetch beim Hineinklicken, public/js/dungeon.js) – nur wer gerade beitreten kann
router.get('/dungeon/einladbar', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ players: await dungeon.invitablePlayers(req.user) });
});

router.post('/dungeon/einladen',(req, res) => handle(req, res, () => dungeon.invite({ user: req.user, name: str(req.body.name) }).then(() => null)));

router.post('/dungeon/einladung-zurueck', (req, res) =>
  handle(req, res, async () => {
    const id = str(req.body.user);
    if (mongoose.isValidObjectId(id)) await dungeon.cancelInvite({ user: req.user, inviteeId: new mongoose.Types.ObjectId(id) });
    return null;
  })
);

router.post('/dungeon/beitreten', (req, res) =>
  handle(req, res, () => dungeon.accept({ user: req.user, partyId: partyId(req) }).then(() => null))
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

// ---------- Live-Turm (eSports) ----------
router.post('/dungeon/turm/vorrat', (req, res) =>
  handle(req, res, () => dungeon.setSupplies({ user: req.user, coffee: str(req.body.coffee) || null, energy: req.body.energy === '1' }).then(() => null))
);
router.post('/dungeon/turm/bereit', (req, res) => handle(req, res, () => dungeon.toggleReady({ user: req.user }).then(() => null)));

// Seite des Live-Turms: läuft gerade einer – oder das Ergebnis des letzten (einen Tag lang)
router.get('/dungeon/live', async (req, res) => {
  const now = Date.now();
  const run = (await liveTower.loadFor(req.user._id, now)) || (await liveTower.lastFinished(req.user._id, now));
  if (!run) return res.redirect('/dungeon');
  const week = run.esportsTeam ? await require('../esports/esportsService').teamWeekRuns(run.esportsTeam, now) : [];
  res.render('dungeon-live', { title: 'Mage Tower – live', state: liveTower.view(run, req.user._id, now), week, traits: LIVE.TRAITS });
});

// Zustand für die Seite (public/js/live-tower.js fragt jede Sekunde)
router.get('/dungeon/live/stand', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const run = (await liveTower.loadFor(req.user._id, now)) || (await liveTower.lastFinished(req.user._id, now));
  if (!run) return res.json({ gone: true });
  res.json(liveTower.view(run, req.user._id, now));
});

// Freie eigene Charakterkarten für den Kartenwechsel
router.get('/dungeon/live/karten', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ cards: await liveTower.switchChoices(req.user._id) });
});

// Aktionen in der Pause (per fetch): Fähigkeit, Weiter, Kaffee, Energy, Kartenwechsel
const LIVE_ACTIONS = {
  waehlen: (req) => liveTower.choose({ user: req.user, key: str(req.body.key), target: req.body.target === undefined || req.body.target === '' ? null : Number.parseInt(str(req.body.target), 10) }),
  weiter: (req) => liveTower.weiter({ user: req.user }),
  kaffee: (req) => liveTower.coffee({ user: req.user }),
  energy: (req) => liveTower.drink({ user: req.user, mode: str(req.body.mode), target: req.body.target === undefined || req.body.target === '' ? null : Number.parseInt(str(req.body.target), 10) }),
  wechsel: (req) => liveTower.switchCard({ user: req.user, cardId: str(req.body.card) }),
};
router.post('/dungeon/live/:aktion', async (req, res) => {
  const entry = Object.entries(LIVE_ACTIONS).find(([k]) => k === req.params.aktion);
  if (!entry) return res.status(404).json({ ok: false, error: 'Unbekannte Aktion.' });
  try {
    const run = await entry[1](req);
    res.json({ ok: true, state: liveTower.view(run, req.user._id) });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
