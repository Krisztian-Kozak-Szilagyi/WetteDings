const express = require('express');
const { requireLogin } = require('../middleware');
const { TcgCard } = require('../models/Tcg');
const catalog = require('../tcg/catalog');
const ihk = require('../ihk/ihkService');
const { questById, difficulty, isHybrid } = require('../ihk/quests');
const { canBoost } = require('../ihk/abilities');
const { usedCards, pickShortcuts } = require('../lib/pickShortcuts');
const { str, UserError } = require('../lib/util');
const { euro } = require('../lib/viewHelpers');

const router = express.Router();

// Zugang: für alle, wenn im Admin-Panel freigegeben – sonst nur Admins
function requireIhk(req, res, next) {
  if (ihk.settings.open || req.user.isAdmin) return next();
  if (req.method !== 'GET') {
    req.flash('error', 'Die IHK ist derzeit nicht verfügbar.');
    return res.redirect('/ihk');
  }
  res.render('error', { title: 'IHK', status: 'IHK', message: 'Die IHK ist derzeit nicht verfügbar. Schau später wieder vorbei!' });
}
router.use('/ihk', requireLogin, requireIhk);

/** Quest + Schwierigkeit für die Anzeige */
const questView = (questId, level) => {
  const q = questById[questId];
  const d = difficulty(level);
  return { ...q, hybrid: isHybrid(q), difficulty: level, level: d.label, required: ihk.requiredFor(level, q), reward: ihk.rewardFor(level, q), duration: ihk.durationFor(level, q) };
};

router.get('/ihk', async (req, res) => {
  const { running, used, limit } = await ihk.getState(req.user._id);
  let phase = 'offer';
  if (running) phase = new Date(running.endsAt).getTime() <= Date.now() ? 'result' : 'running';

  const offers = running ? [] : (await ihk.getOffers(req.user._id)).map((o) => questView(o.quest, o.difficulty));
  const canReroll = !running && used < limit && (await ihk.canReroll(req.user._id));
  // folierte Exemplare können nicht auf Quests
  const owned = await TcgCard.distinct('card', { user: req.user._id, foiledAt: null });
  const rank = (c) => catalog.rarityByKey[c.rarity].rank;
  const all = owned.map((id) => catalog.cardById[id]).filter(Boolean);
  const cards = all.filter((c) => c.isCharacter).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'de'));
  const items = all.filter((c) => !c.isCharacter && canBoost(c)).sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, 'de'));

  // Favoriten oben; ohne Favoriten ein Knopf mit den am häufigsten gespielten Karten
  const usage = phase === 'offer' ? await usedCards(req.user._id, 'ihk') : { card: [], boost: [] };
  const shortcuts = { card: pickShortcuts(cards, req.user.tcgFavorites, usage.card), boost: pickShortcuts(items, req.user.tcgFavorites, usage.boost) };

  res.render('ihk', {
    title: 'IHK',
    shortcuts,
    phase,
    run: running,
    quest: running ? questView(running.quest, running.difficulty) : null,
    offers,
    canReroll,
    runCard: running ? catalog.cardById[running.card] : null,
    // Kartenbilder mit geänderten Werten (Boost/Debuff) für die Wiedergabe – nur Rahmen-Karten
    runImages: running ? catalog.statImages(catalog.cardById[running.card], running.ticks) : {},
    runBoost: running && running.boost ? catalog.cardById[running.boost] : null,
    runBoost2: running && running.boost2 ? catalog.cardById[running.boost2] : null,
    cards,
    items,
    rarityByKey: catalog.rarityByKey,
    canBoost,
    used,
    limit,
    closedForOthers: !ihk.settings.open,
    workTime: ihk.WORK_TIME,
  });
});

router.get('/ihk/anleitung', (req, res) => res.render('ihk-anleitung', { title: 'IHK – So funktioniert\'s' }));

async function handle(req, res, fn) {
  try {
    const msg = await fn();
    if (msg) req.flash('success', msg);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.message);
  }
  res.redirect('/ihk');
}

router.post('/ihk/start', (req, res) =>
  handle(req, res, async () => {
    await ihk.start({
      user: req.user,
      cardId: str(req.body.card),
      boostId: str(req.body.boost) || null,
      boost2Id: str(req.body.boost2) || null,
      offerIndex: Number.parseInt(str(req.body.offer), 10),
    });
    return null;
  })
);

router.post('/ihk/neu-wuerfeln', (req, res) =>
  handle(req, res, async () => {
    await ihk.reroll({ user: req.user });
    return 'Neue Quests ausgewürfelt.';
  })
);

router.post('/ihk/abholen', (req, res) =>
  handle(req, res, async () => {
    const run = await ihk.collect({ user: req.user });
    if (!run.success) return null;
    const pack = run.pack ? ' Außerdem hast du ein Booster Pack gefunden – es liegt bei deinen Packs im TCG!' : '';
    return `Quest geschafft – ${euro(run.reward)} wurden dir gutgeschrieben.${pack}`;
  })
);

module.exports = router;
