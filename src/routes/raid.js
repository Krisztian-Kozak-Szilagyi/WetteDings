// Raid „The Gambit of Shadows“ gegen Lucky Dio (/raid): Übersicht, Kampf beginnen, Kampf im Vollbild (/raid/kampf) mit Zügen über /raid/aktion.
// Entschieden wird auf dem Server (src/raid/raidService.js) – der Browser zeichnet nur.
const express = require('express');
const { requireLogin } = require('../middleware');
const raid = require('../raid/raidService');
const logic = require('../raid/logic');
const catalog = require('../tcg/catalog');
const { str, UserError } = require('../lib/util');

const router = express.Router();

// Zugang: für alle, wenn im Admin-Panel freigegeben – sonst nur Admins
function requireRaid(req, res, next) {
  if (raid.mayPlay(req.user)) return next();
  if (req.method !== 'GET') {
    if ((req.get('Accept') || '').includes('application/json')) return res.status(403).json({ error: 'Der Raid ist derzeit nicht verfügbar.' });
    req.flash('error', 'Der Raid ist derzeit nicht verfügbar.');
    return res.redirect('/');
  }
  res.status(404).render('error', { title: 'Raid', status: 'Raid', message: 'Der Raid ist derzeit nicht verfügbar. Schau später wieder vorbei!' });
}
router.use('/raid', requireLogin, requireRaid);

const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');

router.get('/raid', async (req, res) => {
  const [tries, deck, cur, history, winners] = await Promise.all([raid.tries(req.user._id), raid.deckFor(req.user._id), raid.current(req.user._id), raid.history(req.user._id), raid.dioWinners()]);
  const s = raid.settings;
  // Rollen im Deck (Angreifer, Verteidiger, Heiler) – hilft beim Planen
  const roles = deck.cards.reduce((m, c) => ({ ...m, [c.kampf.rolle || 'Spezial']: (m[c.kampf.rolle || 'Spezial'] || 0) + 1 }), {});
  res.render('raid', {
    title: 'The Gambit of Shadows',
    tries,
    deck,
    roles,
    running: cur ? { runde: cur.s.runde, bossHp: cur.s.boss.hp, bossMax: cur.s.boss.max, spielerHp: cur.s.spieler.hp } : null,
    history,
    winners,
    dio: catalog.cardById[raid.DIO] || null,
    boss: { ...s.boss },
    angriffe: s.angriffe.filter((a) => a.gewicht > 0),
    belohnung: s.belohnung,
    spieler: s.spieler,
    karten: s.karten,
    permanentImDeck: deck.cards.filter((c) => c.kampf.dauer === 'permanent').length,
    maxRounds: s.maxRounds,
    minCards: raid.MIN_CARDS,
  });
});

router.post('/raid/start', async (req, res) => {
  try {
    await raid.start({ user: req.user });
    return res.redirect('/raid/kampf');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/raid');
});

// Kampf im Vollbild (wie der Bosskampf, aber mit Lucky Dio und Zügen über den Server)
router.get('/raid/kampf', async (req, res) => {
  const cur = await raid.current(req.user._id);
  if (!cur) return res.redirect('/raid');
  res.render('raid-kampf', { title: 'The Gambit of Shadows', bossHp: cur.s.boss.max, spielerHp: cur.s.spieler.max });
});

// Zustand des laufenden Kampfs; beim allerersten Laden zusätzlich die Startereignisse (Karten ziehen, erste Ankündigung)
router.get('/raid/zustand', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cur = await raid.current(req.user._id);
  if (!cur) return res.status(404).json({ error: 'Du kämpfst gerade nicht gegen Lucky Dio.' });
  const fresh = !cur.run.actions.length;
  res.json({ state: logic.publicState(cur.s), ev: fresh ? logic.replay(cur.run.seed, cur.run.snap, []).ev : null });
});

router.post('/raid/aktion', async (req, res) => {
  try {
    const action = { a: str(req.body.a) };
    if (req.body.uid !== undefined) action.uid = Number.parseInt(str(req.body.uid), 10);
    if (req.body.ziel !== undefined && str(req.body.ziel) !== '') action.ziel = Number.parseInt(str(req.body.ziel), 10);
    res.json(await raid.act({ user: req.user, action }));
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

router.post('/raid/aufgeben', async (req, res) => {
  try {
    await raid.abandon({ user: req.user });
    req.flash('info', 'Du hast den Kampf aufgegeben – Lucky Dio lacht und verschwindet im Rauch.');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect('/raid');
});

module.exports = router;
